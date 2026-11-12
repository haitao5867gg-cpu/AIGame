'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const prompts = require('../src/prompts.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');
const { req, withServer, asGuest, loginGuest } = require('./helpers/api-helpers.js');

const SECRET = 'sk-STATS-MOCK-SECRET';

function makeState() {
  return {
    bible: {
      title: '灰烬港残卷', tone: '苍茫诡谲', rules: [], places: [], factions: [],
      npcs: [{ name: '守夜人', role: '更夫', desc: '提灯巡夜', want: '独吞钟楼更漏谱' }],
      start: { place: '灰烬港', situation: '你在搁浅船骸间醒来。' },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 2,
    location: '灰烬港', clock: { day: 2, period: '黄昏' },
    genre: 'xuanhuan',
  };
}

function gauge(over) {
  return Object.assign({
    name: '饱腹', kind: 'gauge', icon: '🍖', desc: '肚子饱不饱',
    max: 100, start: 42, value: 42, drift: -3,
    warn: [
      { below: 30, label: '饥肠辘辘', effect: '手脚发软、注意力涣散' },
      { below: 10, label: '饿到发昏', effect: '每回合体魄 -1', drain: '体魄' },
    ],
  }, over || {});
}

function rank(over) {
  return Object.assign({
    name: '境界', kind: 'rank', icon: '☯', desc: '修行层次',
    ranks: ['凡人', '炼气', '筑基', '金丹', '元婴'], start: 1, value: 1,
  }, over || {});
}

// 注入假 client：purpose==='stats' 抛错，其余沿用真实 mock client，便于测兜底与计数。
function makeGameWithStatsFailure(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-stats-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = SECRET;
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  const orig = llm.createClient;
  const real = orig(cfg, dataDir);
  let calls = 0;
  const fake = Object.assign({}, real, {
    complete(opts) {
      if (opts && opts.purpose === 'stats') {
        calls += 1;
        throw new Error('模拟专属状态模型故障');
      }
      return real.complete(opts);
    },
  });
  llm.createClient = () => fake;
  t.after(() => { llm.createClient = orig; });
  return { g: game.createGame(cfg, dataDir), dataDir, statsCalls: () => calls };
}

// ---------- 1. 建世界：WORLD_OUTPUT_FORMAT ----------

test('WORLD_OUTPUT_FORMAT：bible 示例含 stats，说明含 gauge/rank/drift/warn/drain 设计规则', () => {
  const [system] = prompts.buildWorldMessages('一句世界观', { name: '旅人', appearance: '灰袍' });
  const text = system.content;
  for (const kw of ['stats', 'gauge', 'rank', 'drift', 'warn', 'drain']) {
    assert.ok(text.includes(kw), `建世界提示词应含关键字「${kw}」`);
  }
  assert.match(text, /"stats":\[/, 'JSON 示例的 bible 里应有 stats 数组');
  assert.match(text, /bible\.stats 是这个世界主角专属的 2~4 个状态值/);
  assert.match(text, /name ≤4 字/);
  assert.match(text, /每过一个时段/);
  assert.match(text, /末日求生给「饱腹」「水分」/);
});

// ---------- 2. statsSectionText ----------

test('statsSectionText：数值槽 / 警戒线 / 等级阶梯逐行文本；空 stats 返回空串', () => {
  assert.equal(prompts.statsSectionText({}), '');
  assert.equal(prompts.statsSectionText({ stats: [] }), '');
  assert.equal(prompts.statsSectionText({ stats: undefined }), '');

  const st = makeState();
  st.stats = [gauge({ value: 42 }), rank()];
  const text = prompts.statsSectionText(st);
  assert.ok(text.includes('饱腹 🍖：42/100（每个时段自然 -3）'), '数值槽当前值与自然变化');
  assert.ok(text.includes('；警戒线：低于 30 饥肠辘辘'), '未生效时只列警戒线');
  assert.ok(text.includes('境界 ☯：炼气'), '等级阶梯当前阶名');
  assert.ok(text.includes('凡人 → 炼气 → 筑基'), '阶梯由低到高列出');
});

test('statsSectionText：生效警戒接「当前：label——effect」，多条时优先最严重的一条', () => {
  const one = makeState();
  one.stats = [gauge({ value: 20 })]; // 20<=30 命中「饥肠辘辘」，未到 below 10
  const text1 = prompts.statsSectionText(one);
  assert.ok(text1.includes('；当前：饥肠辘辘——手脚发软、注意力涣散'));
  assert.equal(text1.includes('警戒线：'), false, '有生效警戒时不再列警戒线');

  const two = makeState();
  two.stats = [gauge({ value: 5 })]; // 两条都生效，优先显示带 drain 的「饿到发昏」
  assert.ok(prompts.statsSectionText(two).includes('；当前：饿到发昏——每回合体魄 -1'));
});

// ---------- 3. 每回合：buildTurnMessages / TURN_OUTPUT_FORMAT / 时光推进 ----------

test('buildTurnMessages：有 stats 含「专属状态」段与 stats_diff 说明；老存档无 stats 整段省略', () => {
  const withStats = makeState();
  withStats.stats = [gauge(), rank()];
  const [system] = prompts.buildTurnMessages(withStats, { nextTurn: 3 }, '吃半个面包');
  assert.match(system.content, /【专属状态（随剧情和时间变化）】/);
  assert.ok(system.content.includes('饱腹 🍖：42/100'));
  assert.match(system.content, /用 stats_diff 写/);
  assert.match(system.content, /随时间自然流逝的变化由系统自动结算/);
  assert.match(system.content, /当前生效的状态/);
  assert.match(system.content, /等级阶梯只在叙事里确实发生突破或跌落时才 ±1/);
  // 输出格式里的 stats_diff 字段与说明对所有回合都在
  assert.match(system.content, /"stats_diff":\{"饱腹":15\}/);
  assert.match(system.content, /stats_diff 的键必须是【专属状态】里已有的名字/);

  const old = makeState();
  delete old.stats;
  const [oldSystem] = prompts.buildTurnMessages(old, { nextTurn: 3 }, '继续探查');
  assert.equal(oldSystem.content.includes('【专属状态（随剧情和时间变化）】'), false,
    '老存档不应出现专属状态段（输出格式说明里的「【专属状态】」指字段，不算该段）');
  assert.equal(oldSystem.content.includes('随剧情和时间变化'), false);
  assert.equal(oldSystem.content.includes('每个时段自然'), false);
  assert.equal(oldSystem.content.includes('饱腹 🍖'), false);
});

test('buildTurnMessages：时光推进段要求用 stats_diff 写清落地增减、不自动结算自然变化', () => {
  const st = makeState();
  st.stats = [gauge()];
  const skip = { span: 'month', days: 30, label: '一个月', plan: '闭关打坐' };
  const [system] = prompts.buildTurnMessages(st, { nextTurn: 3, timeSkip: skip }, '闭关');
  assert.match(system.content, /【时光推进（本回合特殊）】/);
  assert.match(system.content, /专属状态：.*stats_diff 写清楚/);
  assert.match(system.content, /不会自动结算这段时间的自然变化/);
});

// ---------- 4. 老世界补设计：buildStatsMessages ----------

test('buildStatsMessages：共用设计规则、只输出 stats、带最近 2 回合叙事（截最后 900 字）、不含 npcs.want', () => {
  const st = makeState();
  st.recent = [
    { turn: 1, action: '喝了口凉水', narration: '故事开头ZQ1。' + '甲'.repeat(1200) + '结尾ZQ2。' },
    { turn: 2, action: '啃了半块饼', narration: '第二回合叙事ZQ3，守夜人提灯走过。' },
  ];
  const [system, user] = prompts.buildStatsMessages(st);
  const all = system.content + '\n' + user.content;
  for (const kw of ['gauge', 'rank', 'drift', 'warn', 'drain', 'stats', 'name ≤4 字', 'start 填']) {
    assert.ok(all.includes(kw), `补设计提示词应含「${kw}」`);
  }
  assert.match(system.content, /\{"stats":\[\.\.\.\]\}/, '只输出 stats 一个字段');
  assert.match(all, /标题：灰烬港残卷/);
  assert.match(all, /基调：苍茫诡谲/);
  assert.match(all, /题材：xuanhuan/);
  assert.match(all, /【主角】/);
  assert.match(all, /【此刻】/);
  assert.ok(user.content.includes('第二回合叙事ZQ3'), '应带最近叙事');
  assert.ok(user.content.includes('结尾ZQ2'), '长叙事取最后 900 字尾部');
  assert.equal(user.content.includes('故事开头ZQ1'), false, '长叙事开头应被截掉');
  assert.ok(user.content.includes('啃了半块饼'), '应带最近行动');
  assert.equal(all.includes('独吞钟楼更漏谱'), false, '不得夹带 bible.npcs 的隐藏 want');

  const fresh = makeState();
  fresh.recent = [];
  const [, freshUser] = prompts.buildStatsMessages(fresh);
  assert.ok(freshUser.content.includes('你在搁浅船骸间醒来'), '无近期记录时回退 start.situation');
});

// ---------- 5. LLM_MOCK：建世界 / 回合 ----------

test('LLM_MOCK 建世界：公开状态带出 state.stats（来自 mock 设计，2~4 项，非题材兜底）', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/worlds',
      { seed: '雾港与旧钟声', name: '甲', appearance: '布衣' });
    assert.equal(r.status, 201, r.text);
    const list = r.json.stats;
    assert.ok(Array.isArray(list), '公开状态应带 stats 数组');
    assert.ok(list.length >= 2 && list.length <= 4, `应有 2~4 项，实际 ${list.length}`);
    const names = list.map((s) => s.name);
    assert.ok(names.includes('神识'), '应来自 mockWorld 的设计（题材兜底里没有「神识」）');
    assert.ok(names.includes('灵力') && names.includes('境界'), '2 个数值槽 + 1 个阶梯');
    assert.equal(list.filter((s) => s.kind === 'rank').length, 1);
  });
});

test('LLM_MOCK 回合：stats_diff 生效，state.stats 的 value 变化 = diff + 自然变化', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/worlds',
      { seed: '雾港钟声', name: '甲', appearance: '布衣' });
    const id = r.json.id;
    const before = r.json.stats.find((s) => s.name === '灵力');
    assert.ok(before, '应有「灵力」数值槽');

    const t = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '继续探查钟声' });
    assert.equal(t.status, 200, t.text);
    const diff = (t.json.applied && t.json.applied.stats_diff) || {};
    assert.ok(Object.keys(diff).length >= 1, '回合结果 applied 应带 stats_diff');
    const drift = t.json.stats_drift || {};
    const after = t.json.state.stats.find((s) => s.name === '灵力');
    assert.ok(after, '回合结果公开状态应带 stats');
    assert.equal(after.value, before.value + (diff['灵力'] || 0) + (drift['灵力'] || 0),
      'value 变化 = 本回合 diff + 自然变化');
    assert.notEqual(after.value, before.value, 'value 应确实变化');
    assert.ok(Array.isArray(t.json.badges) && t.json.badges.some((b) => b.type === 'stat'),
      '回合结果也应带出 stat 徽章');
  });
});

// ---------- 6. ensureStats ----------

test('ensureStats：删掉 stats 的老世界首次补设计并写回，第二次直接返回不再调模型', async () => {
  await withServer(async ({ base, dataDir }) => {
    const r = await req(base, 'POST', '/api/worlds',
      { seed: '旧港', name: '甲', appearance: '布衣' });
    const id = r.json.id;
    const stateFile = store.statePath(dataDir, id);
    const usageFile = store.usagePath(dataDir);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete state.stats;
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const rows = () => fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const statsCalls = () => rows().filter((x) => x.purpose === 'stats').length;

    const before = statsCalls();
    const s1 = await req(base, 'GET', `/api/worlds/${id}/stats`);
    assert.equal(s1.status, 200, s1.text);
    assert.ok(Array.isArray(s1.json.stats) && s1.json.stats.length >= 2, '应补出 2~4 项');
    assert.equal(statsCalls(), before + 1, '首次应恰好调用一次 stats 模型');

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(Array.isArray(saved.stats) && saved.stats.length >= 2, '应写回 state.json');
    const names = saved.stats.map((x) => x.name);
    assert.ok(names.includes('灵力') && names.includes('神识'), '应来自 mockStats 的题材设计');

    const s2 = await req(base, 'GET', `/api/worlds/${id}/stats`);
    assert.equal(s2.status, 200, s2.text);
    assert.deepEqual(s2.json.stats, s1.json.stats, '第二次应返回同一份');
    assert.equal(statsCalls(), before + 1, '已有 stats 时不应再调模型');
  });
});

test('ensureStats：LLM 抛错时用题材兜底且不抛；世界不存在返回 null', async (t) => {
  const { g, dataDir, statsCalls } = makeGameWithStatsFailure(t);
  const world = await g.buildWorld({ seed: '旧世界', name: '甲', appearance: '乙' });
  const id = world.id;
  const state = store.loadWorld(dataDir, id);
  delete state.stats;
  store.saveWorld(dataDir, state);

  const got = await g.ensureStats(id);
  assert.ok(Array.isArray(got) && got.length >= 1, '不抛错且返回兜底设计');
  assert.ok(got.some((s) => s.kind === 'rank'), 'xuanhuan 题材兜底含等级阶梯「境界」');
  assert.equal(statsCalls(), 1, '只尝试了一次 stats 调用');
  const saved = store.loadWorld(dataDir, id);
  assert.ok(Array.isArray(saved.stats) && saved.stats.length >= 1, '兜底也写回存档');

  const again = await g.ensureStats(id);
  assert.deepEqual(again, got, '已有 stats 时直接返回');
  assert.equal(statsCalls(), 1, '第二次不再调 stats 模型');
  assert.equal(await g.ensureStats('never-existed'), null, '世界不存在返回 null');
});

// ---------- 7. HTTP /stats ----------

test('HTTP /stats：GET 200 带 stats 数组；别人的世界 404；POST 405', async () => {
  await withServer(async ({ base, dataDir }) => {
    const r = await req(base, 'POST', '/api/worlds',
      { seed: '雾港', name: '甲', appearance: '布衣' });
    const id = r.json.id;
    const ok = await req(base, 'GET', `/api/worlds/${id}/stats`);
    assert.equal(ok.status, 200, ok.text);
    assert.ok(Array.isArray(ok.json.stats) && ok.json.stats.length >= 2);

    const post = await req(base, 'POST', `/api/worlds/${id}/stats`, {});
    assert.equal(post.status, 405);

    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const wa = await req(base, 'POST', '/api/worlds',
      { seed: '甲的世界', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(wa.status, 201, wa.text);
    const x = await req(base, 'GET', `/api/worlds/${wa.json.id}/stats`, undefined, asGuest(cookieB));
    assert.equal(x.status, 404);
    assert.deepEqual(x.json, { error: '世界不存在' });
  });
});

// ---------- 8. 事件记录与徽章 ----------

test('回合事件记录存 stats_drift / stats_drains，/log 徽章据此带出 stat', async () => {
  await withServer(async ({ base, dataDir }) => {
    const r = await req(base, 'POST', '/api/worlds',
      { seed: '雾港钟声', name: '甲', appearance: '布衣' });
    const id = r.json.id;
    await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '继续探查' });

    const events = store.readEvents(dataDir, id);
    assert.ok(Array.isArray(events[0].stats_drains), '事件记录应存 stats_drains');
    assert.ok(events[0].stats_drift && typeof events[0].stats_drift === 'object',
      '事件记录应存 stats_drift');

    const log = await req(base, 'GET', `/api/worlds/${id}/log`);
    assert.equal(log.status, 200, log.text);
    const rec = log.json[log.json.length - 1];
    assert.ok(rec.badges.some((b) => b.type === 'stat'), '/log 徽章应带出 stat 变化');
  });
});

test('badgesFromApplied：stats_diff 生成 stat 徽章，stats_drains 生成 drain 徽章', () => {
  const applied = {
    state_diff: { 心智: 1 },
    stats_diff: { 饱腹: 15, 境界: 1 },
    items_add: ['旧铜灯'], items_remove: [], npc_attitude: {},
  };
  const drains = [
    { stat: '理智', label: '濒临崩溃', attr: '心智' },
    { stat: '饱腹', label: '饿到发昏', attr: '体魄' },
  ];
  const badges = game.badgesFromApplied(applied, drains);
  assert.ok(badges.some((b) => b.type === 'attr' && b.name === '心智' && b.delta === 1));
  assert.ok(badges.some((b) => b.type === 'stat' && b.name === '饱腹' && b.delta === 15));
  assert.ok(badges.some((b) => b.type === 'stat' && b.name === '境界' && b.delta === 1));
  assert.deepEqual(badges.filter((b) => b.type === 'drain'), [
    { type: 'drain', name: '心智', delta: -1, label: '濒临崩溃' },
    { type: 'drain', name: '体魄', delta: -1, label: '饿到发昏' },
  ]);

  // 不传第二参数时无 drain 徽章，原有行为不变
  const plain = game.badgesFromApplied(applied);
  assert.equal(plain.some((b) => b.type === 'drain'), false);
  assert.ok(plain.some((b) => b.type === 'stat' && b.name === '饱腹'));
});
