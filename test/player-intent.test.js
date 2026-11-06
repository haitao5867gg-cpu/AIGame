'use strict';

// 玩家意图优先 / 安静模式 / 成人内容（18+）：只用引擎纯函数、mock 与提示词断言，绝不调用真实模型。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const e = require('../src/engine.js');
const util = require('../src/engine/util.js');
const prompts = require('../src/prompts.js');
const images = require('../src/images.js');
const prefs = require('../src/prefs.js');
const { makeState, proposal, run } = require('./helpers/engine-helpers.js');
const { withServer, req, asGuest, loginGuest, guestMe } = require('./helpers/api-helpers.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 供 buildTurnMessages 用的最小状态（纯数据，不触网）。
function makePromptState() {
  return {
    bible: {
      title: '测试世界', tone: '苍凉', rules: [], places: [], factions: [],
      npcs: [{ name: '守夜人', role: '', desc: '' }],
      start: { place: '灰烬港', situation: '醒来', items: ['旧铜灯'] },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 1,
  };
}

function sysContent(plan, action, opts) {
  return prompts.buildTurnMessages(makePromptState(), plan || { nextTurn: 2 }, action || 'x', opts)[0].content;
}

// ---------- 回合模型字段校验 ----------

test('normalizeFocus：坏数据一律当 action / false，合法值原样保留', () => {
  assert.deepEqual(util.normalizeFocus({ focus: 'BOGUS', continuing: 'yes' }), { focus: 'action', continuing: false });
  assert.deepEqual(util.normalizeFocus({ focus: 'private', continuing: 1 }), { focus: 'private', continuing: false });
  assert.deepEqual(util.normalizeFocus({ focus: 'intimate', continuing: true }), { focus: 'intimate', continuing: true });
  assert.deepEqual(util.normalizeFocus(null), { focus: 'action', continuing: false });
  assert.deepEqual(util.normalizeFocus('bad'), { focus: 'action', continuing: false });
  assert.deepEqual(util.normalizeFocus(undefined), { focus: 'action', continuing: false });
  for (const f of util.FOCUS_VALUES) {
    assert.equal(util.normalizeFocus({ focus: f }).focus, f, f);
  }
  assert.equal(util.normalizeAdult(true), true);
  assert.equal(util.normalizeAdult('true'), false);
  assert.equal(util.normalizeAdult(1), false);
  assert.equal(util.normalizeAdult(undefined), false);
});

test('normalizeState：老存档补 focus / continuing / adult 默认', () => {
  const s = util.normalizeState({});
  assert.equal(s.focus, 'action');
  assert.equal(s.continuing, false);
  assert.equal(s.adult, false);
});

// ---------- planTurn 安静模式 ----------

test('planTurn：上一回合 focus∈{intimate,private,social,rest} 或 continuing=true → quiet/opening=false/twist=null', () => {
  for (const f of ['intimate', 'private', 'social', 'rest']) {
    const s = makeState();
    s.focus = f;
    s.continuing = false;
    s.turn = 8;
    s.nextEventTurn = 9;      // 事件到点
    s.nextTwistTurn = 1;      // 时间型转折到点
    s.sceneStreak = 9;        // 绕圈累计到点
    const p = e.planTurn(s, { rng: () => 0 });
    assert.equal(p.quiet, true, f);
    assert.equal(p.opening, false, f);
    assert.equal(p.twist, null, f);
  }
  const c = makeState();
  c.focus = 'action';
  c.continuing = true;
  c.turn = 8;
  c.nextEventTurn = 9;
  c.nextTwistTurn = 1;
  const pc = e.planTurn(c, { rng: () => 0 });
  assert.equal(pc.quiet, true);
  assert.equal(pc.opening, false);
  assert.equal(pc.twist, null);

  // 对照：非安静且到点，转折与事件都照常。
  const n = makeState();
  n.turn = 8;
  n.nextEventTurn = 999;
  n.sceneStreak = 9;
  n.nextTwistTurn = 1;
  const pn = e.planTurn(n, { rng: () => 0 });
  assert.equal(pn.quiet, false);
  assert.ok(pn.twist, '非安静且到点应触发转折');
  const o = makeState();
  o.turn = 8;
  o.nextEventTurn = 9;
  assert.equal(e.planTurn(o, { rng: () => 0 }).opening, true);
});

test('planTurn：到点但安静时不开事件、nextEventTurn 不变；安静结束后第一回合照常开启', () => {
  const s = makeState();
  s.turn = 8;
  s.nextEventTurn = 9;
  s.focus = 'private';
  s.continuing = true;
  const q = e.planTurn(s, { rng: () => 0 });
  assert.equal(q.quiet, true);
  assert.equal(q.opening, false);
  const out = run(s, {
    action: '继续独处',
    proposal: proposal({ focus: 'private', continuing: true }),
    plan: q,
  });
  assert.equal(out.state.nextEventTurn, 9, '安静回合 nextEventTurn 不变');
  assert.equal(out.state.activeEvent, null, '安静回合不开启事件');
  assert.equal(out.state.focus, 'private');
  assert.equal(out.state.continuing, true);
  // 仍安静时下一回合继续不开。
  assert.equal(e.planTurn(out.state, { rng: () => 0 }).opening, false);
  // 安静结束（不再继续同一件事）后，第一回合按原排程开启。
  const s2 = out.state;
  s2.focus = 'action';
  s2.continuing = false;
  const p2 = e.planTurn(s2, { rng: () => 0 });
  assert.equal(p2.quiet, false);
  assert.equal(p2.opening, true);
  assert.ok(p2.theme, '照常选定事件主题');
});

test('planTurn：安静时结算最多顺延 3 回合，超过后照常结算并清空事件', () => {
  const s = makeState();
  s.turn = 8;
  s.activeEvent = { theme: '天灾', title: '地动', desc: '地在动', startedTurn: 1 };
  s.focus = 'private';
  s.continuing = true;
  let state = s;
  for (let i = 1; i <= 3; i++) {
    const p = e.planTurn(state, { rng: () => 0 });
    assert.equal(p.quiet, true);
    assert.equal(p.settlePostponed, true, `第 ${i} 次顺延`);
    assert.equal(p.settling, false, `第 ${i} 次不结算`);
    const out = run(state, {
      action: '继续独处',
      proposal: proposal({ focus: 'private', continuing: true }),
      plan: p,
    });
    state = out.state;
    assert.equal(state.activeEvent.postpones, i, `累计第 ${i} 次顺延`);
  }
  const p4 = e.planTurn(state, { rng: () => 0 });
  assert.equal(p4.quiet, true);
  assert.equal(p4.settlePostponed, false, '超过 3 次不再顺延');
  assert.equal(p4.settling, true, '照常结算');
  assert.equal(p4.needSettlement, true);
  const out4 = run(state, {
    action: '继续独处',
    proposal: proposal({ focus: 'private', continuing: true }),
    plan: p4,
    event_check: { attr: '体魄', response_quality: 2 },
  });
  assert.equal(out4.state.activeEvent, null, '强制结算后事件清空');
});

// ---------- resolveTurn ----------

test('resolveTurn：安静模式下 sceneStreak 保持不变（不累加也不清零）', () => {
  const quietPlan = (s) => ({ nextTurn: s.turn + 1, quiet: true, opening: false, settling: false, twist: null, needChapter: false });
  const s = makeState();
  s.sceneStreak = 3;
  const out = run(s, { action: '继续独处', proposal: proposal(), plan: quietPlan(s) });
  assert.equal(out.state.sceneStreak, 3);
  const s2 = makeState();
  s2.sceneStreak = 3;
  const out2 = run(s2, { action: '原地', proposal: proposal(), plan: Object.assign(quietPlan(s2), { quiet: false }) });
  assert.equal(out2.state.sceneStreak, 4, '非安静原地打转照常 +1');
});

test('resolveTurn：focus=intimate 或 adult=true 强制 scene.draw=false', () => {
  const scene = { draw: true, place: '雾中钟楼', cast: ['你'], items: [], action: '并肩而坐' };
  for (const extra of [{ focus: 'intimate' }, { adult: true }]) {
    const out = run(makeState(), {
      action: 'x',
      proposal: proposal(Object.assign({ scene }, extra)),
    });
    assert.equal(out.result.scene.draw, false, JSON.stringify(extra));
  }
  const plain = run(makeState(), { action: 'x', proposal: proposal({ scene }) });
  assert.equal(plain.result.scene.draw, true, '普通回合 draw=true 保留');
});

test('resolveTurn：focus / continuing / adult 消毒后写入公开状态与公开回合结果', () => {
  const out = run(makeState(), {
    action: 'x',
    proposal: proposal({ focus: 'private', continuing: true, adult: true }),
  });
  assert.equal(out.state.focus, 'private');
  assert.equal(out.state.continuing, true);
  assert.equal(out.state.adult, true);
  assert.equal(out.result.adult, true);
  const pub = e.toPublicTurnResult(out.result, out.state);
  assert.equal(pub.adult, true);
  assert.equal(pub.state.focus, 'private');
  assert.equal(pub.state.continuing, true);

  const bad = run(makeState(), {
    action: 'x',
    proposal: proposal({ focus: 'BOGUS', continuing: 'yes', adult: 'yes' }),
  });
  assert.equal(bad.state.focus, 'action');
  assert.equal(bad.state.continuing, false);
  assert.equal(bad.state.adult, false);
});

// ---------- 提示词 ----------

test('提示词：玩家意图优先 / 不算拖沓 / 亲密关系 / 暗场 / 成年人，且不再含强制推进措辞', () => {
  const c = sysContent({ nextTurn: 2 }, '和 NPC 独处');
  assert.match(c, /玩家意图优先/);
  assert.match(c, /不算拖沓/);
  assert.match(c, /玩家主动停留在同一场景、继续同一件事是正当选择/);
  assert.match(c, /亲密关系/);
  assert.match(c, /暗场/);
  assert.match(c, /成年人/);
  assert.equal(/最多持续 3 回合/.test(c), false);
  assert.equal(/每回合都要有至少一处/.test(c), false);
  assert.equal(/每 5 回合/.test(c), false, '不再要求每 5 回合推进谜题');
  assert.match(c, /主线等玩家/);
  assert.match(c, /不适用于玩家主动选择的私密、社交、休息、亲密场景/);
});

test('提示词：plan.quiet 为真时含「当前是玩家的私人时间」', () => {
  const c = sysContent({ nextTurn: 2, quiet: true }, '独处');
  assert.match(c, /当前是玩家的私人时间/);
  assert.match(c, /不要插入任何外部事件、来电、来人或公告/);
  assert.equal(/当前是玩家的私人时间/.test(sysContent({ nextTurn: 2 }, 'x')), false, '非安静不出现该段');
});

test('提示词：安静模式下被强制结算时要求写成背景里发生、不打断玩家', () => {
  const s = makePromptState();
  s.activeEvent = { theme: '天灾', title: '地动', desc: '地在动' };
  const c = prompts.buildTurnMessages(s, { nextTurn: 2, quiet: true, settling: true }, '独处')[0].content;
  assert.match(c, /写成背景里发生的事/);
  assert.match(c, /不打断玩家当前正在做的事/);
});

// ---------- 出图提示词 ----------

test('出图提示词：中文含「裸露，色情」，英文场景含 fully clothed characters（只写正面词）', () => {
  const style = { zh: '水墨', en: 'ink wash', artZh: '水墨', eraZh: '古代', eraEn: 'ancient', avoidZh: '现代物品' };
  const zh = images.gatewayPrompt({ kind: 'item', name: '旧铜灯', desc: '灯', style, bibleTitle: '雾港' });
  assert.ok(zh.includes('不要出现裸露，色情'), '中文道具提示词');
  const zhScene = images.scenePromptZh({ desc: '两人对坐', cast: [], style });
  assert.ok(zhScene.includes('不要出现裸露，色情'), '中文场景提示词');
  const en = images.scenePromptEn('two people talking', style);
  assert.ok(en.includes('fully clothed characters'), '英文场景提示词');
  assert.equal(/nude|nsfw/i.test(en), false, '英文只写正面词');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'images.js'), 'utf8');
  assert.ok(src.includes('fully clothed characters'), '英文场景提示词源码固定带正面描述');
});

// ---------- 成人模式（18+）后端门控 ----------

test('成人模式：总开关默认关，adultModeOn 需「总开关开 + 该玩家 adult 为 true」', (t) => {
  const dir = tmpDir(t);
  assert.equal(prefs.getAdultAllowed(dir), false);
  assert.equal(prefs.getPrefs(dir, 'host').adult, false);
  assert.equal(prefs.getPrefs(dir, 'host').adultAllowed, false);
  // 个人开启但总开关关 → 无效
  prefs.setPrefs(dir, 'p1', { adult: true, confirm18: true });
  assert.equal(prefs.adultModeOn(dir, 'p1'), false);
  prefs.setGlobalAdultAllowed(dir, true);
  assert.equal(prefs.adultModeOn(dir, 'p1'), true);
  assert.equal(prefs.adultModeOn(dir, 'p2'), false, '只影响开启了该开关的玩家');
  // 缺 confirm18 的非法开启被忽略
  prefs.setPrefs(dir, 'p3', { adult: true });
  assert.equal(prefs.getPrefs(dir, 'p3').adult, false);
});

test('成人模式：关档提示词含「暗场」，不含「具体写出来」', () => {
  const off = sysContent({ nextTurn: 2 }, 'x', { adult: false });
  assert.match(off, /暗场/);
  assert.equal(/具体写出来/.test(off), false);
  assert.match(sysContent({ nextTurn: 2 }, 'x'), /暗场/, '默认（不传 opts）也是关档');
});

test('成人模式：总开关关时主人/来客勾选无效（提示词仍用关档）', (t) => {
  const dir = tmpDir(t);
  prefs.setGlobalAdultAllowed(dir, false);
  prefs.setPrefs(dir, 'host', { adult: true, confirm18: true });
  prefs.setPrefs(dir, 'guest1', { adult: true, confirm18: true });
  assert.equal(prefs.adultModeOn(dir, 'host'), false);
  assert.equal(prefs.adultModeOn(dir, 'guest1'), false);
  const c = sysContent({ nextTurn: 2 }, 'x', { adult: prefs.adultModeOn(dir, 'guest1') });
  assert.match(c, /暗场/);
  assert.equal(/具体写出来/.test(c), false);
});

test('成人模式：两项都开 → 提示词含「具体写出来」且仍带全部硬规则', (t) => {
  const dir = tmpDir(t);
  prefs.setGlobalAdultAllowed(dir, true);
  prefs.setPrefs(dir, 'host', { adult: true, confirm18: true });
  assert.equal(prefs.adultModeOn(dir, 'host'), true);
  const c = sysContent({ nextTurn: 2 }, 'x', { adult: prefs.adultModeOn(dir, 'host') });
  assert.match(c, /具体写出来/);
  for (const w of ['亲密关系', '成年人', '你情我愿', '真实存在的人物', '未成年', '非自愿']) {
    assert.ok(c.includes(w), '硬规则仍应出现：' + w);
  }
});

// ---------- API ----------

test('成人模式：/api/me 的 prefs 带 adult 与全局 adultAllowed', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'GET', '/api/me');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.prefs.adult, false);
    assert.equal(r.json.prefs.adultAllowed, false);
  });
});

test('成人模式：总开关只有主人能改（来客 POST adultAllowed → 403）', async () => {
  await withServer(async ({ base, dataDir }) => {
    let r = await req(base, 'POST', '/api/prefs', { adultAllowed: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.prefs.adultAllowed, true);
    const cookie = await loginGuest(base, dataDir, '客甲');
    r = await req(base, 'POST', '/api/prefs', { adultAllowed: false }, asGuest(cookie));
    assert.equal(r.status, 403, r.text);
    // 总开关未被来客改动
    r = await req(base, 'GET', '/api/me');
    assert.equal(r.json.prefs.adultAllowed, true);
  });
});

test('成人模式：开启个人开关缺 confirm18 返回 400；带 confirm18 才生效', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookie = await loginGuest(base, dataDir, '客乙');
    let r = await req(base, 'POST', '/api/prefs', { adult: true }, asGuest(cookie));
    assert.equal(r.status, 400, r.text);
    assert.equal((await guestMe(base, cookie)).prefs.adult, false);
    r = await req(base, 'POST', '/api/prefs', { adult: true, confirm18: true }, asGuest(cookie));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.prefs.adult, true);
    assert.equal((await guestMe(base, cookie)).prefs.adult, true);
  });
});

test('成人模式：POST /api/tts 带 adult:true 返回 400', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/tts', {
      text: '一句普通文本', voice: 'zh-CN-YunxiNeural', adult: true,
    });
    assert.equal(r.status, 400, r.text);
  });
});

// ---------- 前端静态检查 ----------

test('成人模式：前端有 18 岁确认文案、用量面板两项开关，且不用 innerHTML', () => {
  const panelsJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'panels.js'), 'utf8');
  const ttsJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'tts.js'), 'utf8');
  assert.ok(panelsJs.includes('我已年满 18 岁，同意查看成人内容'), '有 18 岁确认框');
  assert.ok(panelsJs.includes('允许成人内容（总开关）'), '主人总开关');
  assert.ok(panelsJs.includes('我自己开启'), '个人开关');
  assert.ok(panelsJs.includes('主人未开放'), '来客禁用说明');
  assert.equal(/\.innerHTML/.test(panelsJs), false, '用量面板不用 innerHTML');
  assert.equal(/innerHTML/.test(ttsJs), false, 'tts.js 不出现 innerHTML');
  assert.ok(/adultTurnActive\(\)/.test(ttsJs), 'tts.js 有成人回合判定');
  // speak 里：成人判定分支在 fetch('/api/tts') 之前，且分支内只走 browserSpeak。
  const guardIdx = ttsJs.indexOf('adult === undefined ? adultTurnActive() : adult === true');
  const fetchIdx = ttsJs.indexOf("fetch('/api/tts'");
  assert.ok(guardIdx > 0, '有成人回合判定分支');
  assert.ok(fetchIdx > guardIdx, '判定分支在服务端朗读请求之前');
  const slice = ttsJs.slice(guardIdx, fetchIdx);
  assert.ok(/browserSpeak/.test(slice), '判定分支内走浏览器 speechSynthesis');
  assert.equal(/fetch\('\/api\/tts'/.test(slice), false, '判定分支内绝不请求 /api/tts');
  assert.ok(ttsJs.includes('speechSynthesis'));
});
