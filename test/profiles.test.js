'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');
const prompts = require('../src/prompts.js');
const profiles = require('../src/profiles.js');
const { PERSONA_DIMS } = require('../src/engine/constants.js');
const { withServer, req, asGuest, loginGuest, guestMe } = require('./helpers/api-helpers.js');

function withTmp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-profiles-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

// 独立临时 DATA_DIR + LLM_MOCK=1。可注入一个 purpose=profile 的假 client，
// 其余 purpose（建世界 / 回合等）仍走真实 mock，绝不发起真实模型调用。
function makeGame(t, profileComplete) {
  const tmp = withTmp(t);
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = 'sk-PROFILES-TEST';
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  let g;
  if (profileComplete) {
    const orig = llm.createClient;
    llm.createClient = function (...args) {
      const c = orig.apply(this, args);
      const real = c.complete;
      c.complete = async (o) => {
        if (o && o.purpose === 'profile') return profileComplete(o);
        return real.call(c, o);
      };
      return c;
    };
    g = game.createGame(cfg, dataDir);
    llm.createClient = orig;
  } else {
    g = game.createGame(cfg, dataDir);
  }
  return { g, dataDir, tmp };
}

async function waitUntil(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let ok = false;
    try { ok = fn(); } catch (_) { ok = false; }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

function seedTurns(dataDir, playerId, n, tags, actionPrefix) {
  for (let i = 0; i < n; i++) {
    profiles.recordTurn(dataDir, playerId, {
      tags: tags || [],
      action: `${actionPrefix || '探查'}${i}`,
      genre: 'xuanhuan',
      title: '雾港',
      adult: false,
      now: 1000 + i,
    });
  }
}

function suggestState() {
  return {
    bible: { title: '测试世界', tone: '苍凉', start: { place: '灰烬港', situation: '开局' } },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: [] },
    npcAttitude: {}, persona: {},
    location: '灰烬港', clock: { day: 1, period: '黄昏' },
    recent: [], turn: 1,
  };
}

function readyProfile() {
  return {
    turns: 20,
    ema: { 冒险: 0.9, 审慎: 0.2, 共情: 0, 权谋: 0, 坚韧: 0, 秩序: 0 },
    summary: '你偏爱先观察再动手',
    traits: ['先观察后动手', '爱结交人'],
    wants: '留有余地的剧情',
    recentActions: [],
    summaryTurn: 20,
  };
}

// ---- getProfile ----
test('getProfile：默认完整合法、坏数据不抛错并按默认补齐、返回副本', (t) => {
  const dataDir = withTmp(t);
  let p = profiles.getProfile(dataDir, 'host');
  assert.equal(p.version, 1);
  assert.equal(p.turns, 0);
  assert.deepEqual(p.ema, { 冒险: 0, 审慎: 0, 共情: 0, 权谋: 0, 坚韧: 0, 秩序: 0 });
  assert.deepEqual(p.recentActions, []);
  assert.equal(p.summary, '');
  assert.deepEqual(p.traits, []);
  assert.equal(p.wants, '');
  assert.equal(p.summaryTurn, 0);
  assert.equal(p.updatedAt, 0);
  p.turns = 99;
  assert.equal(profiles.getProfile(dataDir, 'host').turns, 0, '返回的是副本');

  fs.writeFileSync(profiles.profilePath(dataDir), '{not json');
  assert.equal(profiles.getProfile(dataDir, 'host').turns, 0, '坏 JSON 不抛错');

  fs.writeFileSync(profiles.profilePath(dataDir), '[1,2,3]');
  assert.equal(profiles.getProfile(dataDir, 'u').turns, 0, '顶层非对象 → 默认');

  fs.writeFileSync(profiles.profilePath(dataDir), JSON.stringify({
    host: { turns: 5, ema: { 冒险: 'x', 审慎: 2 }, summary: 12, traits: 'nope', recentActions: [null, 3] },
    u: 42,
  }));
  p = profiles.getProfile(dataDir, 'host');
  assert.equal(p.turns, 5);
  assert.equal(p.ema.冒险, 0);
  assert.equal(p.ema.审慎, 1, 'ema 夹到 0..1');
  assert.equal(p.summary, '');
  assert.deepEqual(p.traits, []);
  assert.deepEqual(p.recentActions, []);
  assert.equal(profiles.getProfile(dataDir, 'u').turns, 0, '单条非对象 → 默认');
});

// ---- recordTurn ----
test('recordTurn：连续 3 回合带「冒险」后 ema 正确，其余维度为 0，无命中时回落', (t) => {
  const dataDir = withTmp(t);
  let p;
  for (let i = 0; i < 3; i++) {
    p = profiles.recordTurn(dataDir, 'host', { tags: ['冒险'], action: `行动${i}`, now: i });
  }
  assert.equal(p.turns, 3);
  assert.equal(p.ema.冒险, 0.1694);
  for (const d of ['审慎', '共情', '权谋', '坚韧', '秩序']) assert.equal(p.ema[d], 0);
  p = profiles.recordTurn(dataDir, 'host', { tags: [], action: 'x', now: 3 });
  assert.equal(p.ema.冒险, 0.1592, '不带标签应向 0 回落');
});

test('recordTurn：recentActions 只留最后 30 条，text/title 被截断', (t) => {
  const dataDir = withTmp(t);
  let p;
  for (let i = 0; i < 35; i++) {
    p = profiles.recordTurn(dataDir, 'host', {
      tags: [], action: `第${i}步`, genre: 'g', title: 'T'.repeat(30), now: i,
    });
  }
  assert.equal(p.recentActions.length, 30);
  assert.equal(p.recentActions[0].text, '第5步');
  assert.equal(p.recentActions[29].text, '第34步');
  assert.equal(p.recentActions[29].title.length, 20);
});

test('recordTurn：adult 回合与时光推进不进 recentActions，但 turns / ema 照常', (t) => {
  const dataDir = withTmp(t);
  let p = profiles.recordTurn(dataDir, 'host', { tags: ['共情'], action: '正常行动', now: 1 });
  assert.equal(p.recentActions.length, 1);
  p = profiles.recordTurn(dataDir, 'host', { tags: ['共情'], action: '成人行动', adult: true, now: 2 });
  assert.equal(p.recentActions.length, 1);
  p = profiles.recordTurn(dataDir, 'host', {
    tags: ['共情'], action: '【时光推进·一年】闭关', adult: false, now: 3,
  });
  assert.equal(p.recentActions.length, 1);
  assert.equal(p.turns, 3);
  assert.ok(p.ema.共情 > 0);
  p = profiles.recordTurn(dataDir, 'host', {
    tags: [], action: '  ' + '甲'.repeat(80) + '  ', now: 4,
  });
  assert.equal(p.recentActions.length, 2);
  assert.equal(p.recentActions[1].text.length, 60);
});

test('recordTurn：不同玩家互不影响，缺省 id 按 host', (t) => {
  const dataDir = withTmp(t);
  profiles.recordTurn(dataDir, 'pA', { tags: ['冒险'], action: 'A1', now: 1 });
  profiles.recordTurn(dataDir, 'pA', { tags: ['冒险'], action: 'A2', now: 2 });
  profiles.recordTurn(dataDir, 'pB', { tags: ['共情'], action: 'B1', now: 3 });
  const a = profiles.getProfile(dataDir, 'pA');
  const b = profiles.getProfile(dataDir, 'pB');
  assert.equal(a.turns, 2);
  assert.equal(b.turns, 1);
  assert.ok(a.ema.冒险 > 0);
  assert.equal(a.ema.共情, 0);
  assert.ok(b.ema.共情 > 0);
  assert.equal(b.ema.冒险, 0);
  assert.equal(a.recentActions[0].text, 'A1');
  profiles.recordTurn(dataDir, null, { tags: [], action: 'H1', now: 4 });
  assert.equal(profiles.getProfile(dataDir, 'host').turns, 1);
});

// ---- applySummary / resetProfile ----
test('applySummary：summary / traits / wants 消毒，summaryTurn 记为当前 turns', (t) => {
  const dataDir = withTmp(t);
  seedTurns(dataDir, 'host', 4);
  const p = profiles.applySummary(dataDir, 'host', {
    summary: 'S'.repeat(200),
    traits: ['  先观察后动手  ', '爱结交人', '爱结交人', 'X'.repeat(20), 42, null,
      '感情线', '权谋', '秩序', '坚韧', '审慎', '多余'],
    wants: 'W'.repeat(100),
  }, 999);
  assert.equal(p.summary.length, 120);
  assert.equal(p.wants.length, 60);
  assert.equal(p.traits.length, 6);
  assert.equal(p.traits[0], '先观察后动手');
  assert.equal(p.traits[1], '爱结交人');
  assert.equal(p.traits[2], 'X'.repeat(8));
  assert.equal(p.summaryTurn, 4);
  assert.equal(p.updatedAt, 999);
  const r = profiles.getProfile(dataDir, 'host');
  assert.equal(r.summary.length, 120);
  assert.equal(r.traits.length, 6);
});

test('resetProfile：删掉该玩家画像，之后 getProfile 返回默认', (t) => {
  const dataDir = withTmp(t);
  profiles.recordTurn(dataDir, 'host', { tags: ['冒险'], action: 'a', now: 1 });
  profiles.applySummary(dataDir, 'host', { summary: 'x', traits: ['t'], wants: 'w' }, 2);
  assert.equal(profiles.getProfile(dataDir, 'host').turns, 1);
  const def = profiles.resetProfile(dataDir, 'host');
  assert.equal(def.turns, 0);
  const r = profiles.getProfile(dataDir, 'host');
  assert.equal(r.turns, 0);
  assert.equal(r.summary, '');
  assert.deepEqual(r.traits, []);
});

// ---- publicProfile / seedPersona ----
test('publicProfile：dims 归一、全 0 时都给 50、ready 阈值、不暴露 recentActions', () => {
  const def = profiles.publicProfile(profiles.defaultProfile());
  assert.equal(def.ready, false);
  for (const d of PERSONA_DIMS) assert.equal(def.dims[d], 50);
  assert.equal('recentActions' in def, false);
  assert.deepEqual(Object.keys(def).sort(), ['dims', 'ready', 'summary', 'traits', 'turns', 'wants']);

  const p = profiles.defaultProfile();
  p.turns = 10;
  p.ema.冒险 = 0.5;
  p.ema.审慎 = 0.25;
  const v = profiles.publicProfile(p);
  assert.equal(v.dims.冒险, 100);
  assert.equal(v.dims.审慎, 50);
  assert.equal(v.dims.共情, 0);
  assert.equal(v.ready, true);
  const p9 = profiles.defaultProfile();
  p9.turns = 9;
  assert.equal(profiles.publicProfile(p9).ready, false);
});

test('seedPersona：turns<10 返回 null，之后每维落在 35~65', () => {
  const p = profiles.defaultProfile();
  assert.equal(profiles.seedPersona(p), null);
  p.turns = 9;
  assert.equal(profiles.seedPersona(p), null);
  p.turns = 10;
  p.ema.冒险 = 0.8;
  p.ema.审慎 = 0.2;
  const s = profiles.seedPersona(p);
  assert.ok(s);
  assert.deepEqual(Object.keys(s), PERSONA_DIMS.slice());
  const dims = profiles.publicProfile(p).dims;
  for (const d of PERSONA_DIMS) {
    assert.ok(Number.isInteger(s[d]));
    assert.ok(s[d] >= 35 && s[d] <= 65, `${d}=${s[d]}`);
    assert.equal(s[d], 35 + Math.round((30 * dims[d]) / 100));
  }
  assert.equal(s.冒险, 65);
});

// ---- buildProfileMessages ----
test('buildProfileMessages：含最近行动、之前总结、标签与六维倾向', () => {
  const profile = readyProfile();
  profile.recentActions = [
    { text: '潜入钟楼探查', genre: 'xuanhuan', title: '雾港', ts: 1 },
    { text: '向守夜人打听', genre: 'urban', title: '旧城', ts: 2 },
  ];
  const [system, user] = prompts.buildProfileMessages(profile);
  assert.match(system.content, /玩家画像/);
  assert.match(system.content, /"summary"/);
  assert.match(system.content, /"traits"/);
  assert.match(system.content, /"wants"/);
  assert.ok(user.content.includes('你偏爱先观察再动手'), '含之前总结');
  assert.ok(user.content.includes('先观察后动手'), '含之前标签');
  assert.ok(user.content.includes('[xuanhuan·雾港] 潜入钟楼探查'));
  assert.ok(user.content.includes('[urban·旧城] 向守夜人打听'));
  assert.ok(user.content.includes('冒险'), '含六维倾向');
});

test('buildProfileMessages：无之前总结 / 标签 / 行动时写「无」', () => {
  const [, user] = prompts.buildProfileMessages(profiles.defaultProfile());
  assert.ok(user.content.includes('总结：无'));
  assert.ok(user.content.includes('标签：无'));
  assert.ok(user.content.includes('无'));
});

// ---- buildSuggestMessages 带画像 ----
test('buildSuggestMessages：带 ready 画像时含「这位玩家的习惯」与「第一条建议写这位玩家最可能想做的事」', () => {
  const state = suggestState();
  const view = profiles.publicProfile(readyProfile());
  assert.equal(view.ready, true);
  const [system, user] = prompts.buildSuggestMessages(state, { avoid: [], profile: view });
  assert.match(system.content, /第一条建议写这位玩家最可能想做的事/);
  assert.ok(user.content.includes('这位玩家的习惯'));
  assert.ok(user.content.includes('你偏爱先观察再动手'));
});

test('buildSuggestMessages：不带画像 / 画像不 ready 时与不传逐字一致', () => {
  const state = suggestState();
  const base = prompts.buildSuggestMessages(state, { avoid: ['旧建议'] });
  assert.deepEqual(
    prompts.buildSuggestMessages(state, { avoid: ['旧建议'], profile: undefined }),
    base,
  );
  const notReady = profiles.publicProfile(profiles.defaultProfile());
  assert.equal(notReady.ready, false);
  const withNotReady = prompts.buildSuggestMessages(state, { avoid: ['旧建议'], profile: notReady });
  assert.deepEqual(withNotReady, base);
  const all = withNotReady[0].content + '\n' + withNotReady[1].content;
  assert.ok(!all.includes('这位玩家的习惯'));
  assert.ok(!all.includes('第一条建议写这位玩家最可能想做的事'));
});

// ---- LLM_MOCK 后台总结 ----
test('LLM_MOCK：画像满 15 回合后玩 1 回合，后台总结把 summary 写入', async (t) => {
  const { g, dataDir } = makeGame(t);
  seedTurns(dataDir, 'host', 15, ['冒险'], '探查');
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人', appearance: '灰袍' });
  const res = await g.takeTurn(w.id, { action: '继续探查' });
  assert.ok(res.narration && res.narration.length >= 10);
  const done = await waitUntil(() => profiles.getProfile(dataDir, 'host').summaryTurn > 0, 2000);
  assert.equal(done, true, '后台总结应在 2 秒内完成');
  const p = profiles.getProfile(dataDir, 'host');
  assert.equal(p.turns, 16);
  assert.ok(p.summary.length > 0);
  assert.ok(p.traits.length > 0);
  assert.ok(p.wants.length > 0);
  assert.equal(p.summaryTurn, 16);
});

test('总结失败（假 client 抛错）不影响回合', async (t) => {
  let calls = 0;
  const { g, dataDir } = makeGame(t, () => { calls++; throw new Error('profile down'); });
  seedTurns(dataDir, 'host', 15, [], '探查');
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人', appearance: '灰袍' });
  const res = await g.takeTurn(w.id, { action: '继续探查' });
  assert.ok(res.narration && res.narration.length >= 10, '回合本身应正常成功');
  assert.ok(res.state);
  const attempted = await waitUntil(() => calls > 0, 2000);
  assert.equal(attempted, true, '后台应发起过 profile 调用');
  const p = profiles.getProfile(dataDir, 'host');
  assert.equal(p.turns, 16);
  assert.equal(p.summary, '');
  assert.equal(p.summaryTurn, 0);
});

// ---- buildWorld 继承 ----
test('buildWorld：画像未成熟 persona 为默认 50，成熟后 persona 来自 seedPersona', async (t) => {
  const { g, dataDir } = makeGame(t);
  const w1 = await g.buildWorld({ seed: '甲', name: '旅人', appearance: '灰袍' });
  const p1 = store.loadWorld(dataDir, w1.id).persona;
  for (const d of PERSONA_DIMS) assert.equal(p1[d], 50);

  seedTurns(dataDir, 'host', 10, ['冒险'], 'a');
  const expected = profiles.seedPersona(profiles.getProfile(dataDir, 'host'));
  assert.ok(expected);
  const w2 = await g.buildWorld({ seed: '乙', name: '旅人', appearance: '灰袍' });
  const p2 = store.loadWorld(dataDir, w2.id).persona;
  assert.deepEqual(p2, expected);
  assert.notDeepEqual(p2, p1);
});

// ---- HTTP ----
test('HTTP：GET /api/profile 需登录、来客只见自己、DELETE 归零且不动别人', async (t) => {
  await withServer(async ({ base, dataDir }) => {
    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const idA = (await guestMe(base, cookieA)).id;
    const idB = (await guestMe(base, cookieB)).id;

    seedTurns(dataDir, idA, 3, ['冒险'], 'A');
    seedTurns(dataDir, idB, 1, ['共情'], 'B');
    seedTurns(dataDir, 'host', 2, ['权谋'], 'H');

    let r = await req(base, 'GET', '/api/profile', undefined, asGuest());
    assert.equal(r.status, 401, '需要登录');
    assert.equal(r.json.login, true);

    r = await req(base, 'GET', '/api/profile');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.profile.turns, 2);
    assert.ok('dims' in r.json.profile);
    assert.ok('ready' in r.json.profile);
    assert.equal('recentActions' in r.json.profile, false);

    r = await req(base, 'GET', '/api/profile', undefined, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.profile.turns, 3);
    r = await req(base, 'GET', '/api/profile', undefined, asGuest(cookieB));
    assert.equal(r.json.profile.turns, 1);

    r = await req(base, 'DELETE', '/api/profile', undefined, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.profile.turns, 0);
    assert.equal(r.json.profile.ready, false);
    for (const d of PERSONA_DIMS) assert.equal(r.json.profile.dims[d], 50);

    r = await req(base, 'GET', '/api/profile', undefined, asGuest(cookieA));
    assert.equal(r.json.profile.turns, 0);
    r = await req(base, 'GET', '/api/profile', undefined, asGuest(cookieB));
    assert.equal(r.json.profile.turns, 1, 'B 不受 A 的 DELETE 影响');
    r = await req(base, 'GET', '/api/profile');
    assert.equal(r.json.profile.turns, 2, '主人不受 A 的 DELETE 影响');
  });
});
