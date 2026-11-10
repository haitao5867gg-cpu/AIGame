'use strict';

// 时光推进：复用 takeTurn → planTurn → buildTurnMessages → resolveTurn 的现有流程。
// 覆盖常量 / 归一化 / 排程 / 校验 / 结算 / 公开输出 / 提示词 / mock / 端到端。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const e = require('../src/engine.js');
const constants = require('../src/engine/constants.js');
const prompts = require('../src/prompts.js');
const llm = require('../src/llm.js');
const env = require('../src/env.js');
const store = require('../src/store.js');
const game = require('../src/game.js');
const { makeState, proposal } = require('./helpers/engine-helpers.js');

// ---------------------------------------------------------------------------
// 1. normalizeTimeSkip
// ---------------------------------------------------------------------------

test('normalizeTimeSkip：四种 span 返回对应 days / label / plan', () => {
  assert.deepEqual(e.normalizeTimeSkip({ span: 'month', plan: '经营铺子' }),
    { span: 'month', days: 30, label: '一个月', plan: '经营铺子' });
  assert.deepEqual(e.normalizeTimeSkip({ span: 'season', plan: '养伤' }),
    { span: 'season', days: 90, label: '三个月', plan: '养伤' });
  assert.deepEqual(e.normalizeTimeSkip({ span: 'half', plan: '游历' }),
    { span: 'half', days: 180, label: '半年', plan: '游历' });
  assert.deepEqual(e.normalizeTimeSkip({ span: 'year', plan: '闭关修炼' }),
    { span: 'year', days: 365, label: '一年', plan: '闭关修炼' });
  // 冻结对象，避免被外部改写
  assert.equal(Object.isFrozen(constants.TIME_SKIP_SPANS), true);
  assert.equal(Object.isFrozen(constants.TIME_SKIP_SPANS.year), true);
});

test('normalizeTimeSkip：非对象 / 未知 span → null', () => {
  for (const raw of [null, undefined, 'year', 5, [], {}, { span: 'decade' },
    { span: 1 }, { span: 'toString' }, { span: '__proto__' }]) {
    assert.equal(e.normalizeTimeSkip(raw), null, JSON.stringify(raw));
  }
});

test('normalizeTimeSkip：plan 去控制字符 / trim / 截到 200 字，非字符串为空', () => {
  const trimmed = e.normalizeTimeSkip({ span: 'year', plan: '  闭关\u0001修炼  ' });
  assert.equal(trimmed.plan, '闭关修炼');
  const long = e.normalizeTimeSkip({ span: 'year', plan: '修'.repeat(300) });
  assert.equal(long.plan.length, constants.TIME_SKIP_PLAN_MAX);
  assert.equal(e.normalizeTimeSkip({ span: 'year', plan: 42 }).plan, '');
  assert.equal(e.normalizeTimeSkip({ span: 'year' }).plan, '');
  // 返回新对象，不改入参
  const raw = { span: 'year', plan: '原始' };
  const out = e.normalizeTimeSkip(raw);
  assert.notEqual(out, raw);
  assert.equal(raw.plan, '原始');
});

// ---------------------------------------------------------------------------
// 2. planTurn
// ---------------------------------------------------------------------------

test('planTurn：timeSkip 时不开事件 / 不预兆 / 无转折 / 非安静，plan 原样带 timeSkip', () => {
  const s = makeState();
  s.turn = 0;
  s.nextEventTurn = 1; // 本该开事件
  s.activeEvent = null;
  const ts = e.normalizeTimeSkip({ span: 'year', plan: '闭关修炼' });
  const plan = e.planTurn(s, { rng: () => 0, timeSkip: ts });
  assert.equal(plan.quiet, false);
  assert.equal(plan.opening, false);
  assert.equal(plan.omen, false);
  assert.equal(plan.twist, null);
  assert.equal(plan.settlePostponed, false);
  assert.equal(plan.needEvent, false);
  assert.equal(plan.settling, false);
  assert.equal(plan.timeSkip, ts, 'timeSkip 原样挂在 plan 上');
});

test('planTurn：timeSkip 且有进行中事件 → settling=true（不论 startedTurn / 安静状态）', () => {
  const s = makeState();
  s.turn = 8;
  s.activeEvent = { theme: '天灾', title: '洪涝', desc: '', startedTurn: 9 };
  s.focus = 'private';   // 安静状态
  s.continuing = true;
  const ts = e.normalizeTimeSkip({ span: 'season' });
  const plan = e.planTurn(s, { rng: () => 0, timeSkip: ts });
  assert.equal(plan.nextTurn, 9);
  assert.equal(plan.settling, true, 'startedTurn 等于下一回合也照常结算');
  assert.equal(plan.needSettlement, true);
  assert.equal(plan.settlePostponed, false, '不顺延');
  assert.equal(plan.quiet, false, '安静状态被覆盖');
});

test('planTurn：无 timeSkip 时与原行为一致（不新增 timeSkip 键）', () => {
  const s = makeState();
  s.turn = 0;
  s.nextEventTurn = 1;
  s.activeEvent = null;
  const plan = e.planTurn(s, { rng: () => 0 });
  assert.equal(plan.opening, true, '到点照常开事件');
  assert.equal(Object.prototype.hasOwnProperty.call(plan, 'timeSkip'), false);

  const s2 = makeState();
  s2.focus = 'private';
  s2.continuing = true;
  assert.equal(e.planTurn(s2, { rng: () => 0 }).quiet, true, '安静模式照常');
});

// ---------------------------------------------------------------------------
// 3. validateProposal
// ---------------------------------------------------------------------------

test('validateProposal：year 单项最多 +3、正向合计最多 5、负向最多 -3', () => {
  const s = makeState();
  const opts = { timeSkip: e.normalizeTimeSkip({ span: 'year' }) };
  const v = e.validateProposal(s,
    proposal({ state_diff: { 体魄: 9, 心智: 9, 魅力: 9, 气运: 9 } }), opts);
  assert.deepEqual(v.applied.state_diff, { 体魄: 3, 心智: 2 });
  const neg = e.validateProposal(s, proposal({ state_diff: { 体魄: -9 } }), opts);
  assert.equal(neg.applied.state_diff['体魄'], -3);
});

test('validateProposal：month 仍是单项 +1 / 正向合计 2', () => {
  const s = makeState();
  const opts = { timeSkip: e.normalizeTimeSkip({ span: 'month' }) };
  const v = e.validateProposal(s,
    proposal({ state_diff: { 体魄: 9, 心智: 9, 魅力: 9 } }), opts);
  assert.deepEqual(v.applied.state_diff, { 体魄: 1, 心智: 1 });
});

test('validateProposal：普通回合（无 opts）上限不变', () => {
  const s = makeState();
  const v = e.validateProposal(s, proposal({ state_diff: { 体魄: 9, 心智: 9, 魅力: 9 } }));
  assert.deepEqual(v.applied.state_diff, { 体魄: 1, 心智: 1 });
});

// ---------------------------------------------------------------------------
// 4. resolveTurn
// ---------------------------------------------------------------------------

function skipState() {
  const s = makeState();
  s.turn = 0;
  s.clock = { day: 10, period: '清晨' };
  s.activeEvent = null;
  s.focus = 'action';
  s.continuing = false;
  s.sceneStreak = 5;
  s.pendingEventTheme = '旧主题';
  return s;
}

// 构造一次时光推进回合：plan 由 planTurn(timeSkip) 产生并放进 data.plan。
function runSkip(state, overrides, rng) {
  const r = rng || (() => 0);
  const ts = e.normalizeTimeSkip({ span: 'year', plan: '闭关修炼' });
  const plan = e.planTurn(state, { rng: r, timeSkip: ts });
  const input = Object.assign({
    action: '【时光推进·一年】闭关修炼',
    proposal: proposal({
      landing_period: '午后',
      time_passes: 2,
      focus: 'private',
      continuing: true,
      scene: { draw: false, desc: '一年后的山门，落叶满阶' },
      narration: '这一年里长老在闭关处守着山门，见你出关只低声说了一句回来了，风把旧年的落叶卷到阶前。',
      npc_updates: [{ name: '长老', kind: 'mention', evidence: '长老在闭关' }],
    }),
    plan,
  }, overrides || {});
  return e.resolveTurn(state, input, { rng: r, now: 1 });
}

test('resolveTurn：day +365、landing_period 生效、time_passes 被忽略、result.timeSkip 存在', () => {
  const s = skipState();
  const out = runSkip(s);
  assert.equal(out.invalid, false);
  assert.equal(out.state.clock.day, 10 + 365);
  assert.equal(out.state.clock.period, '午后', 'landing_period 生效且 time_passes=2 被忽略');
  assert.deepEqual(out.result.timeSkip,
    { span: 'year', days: 365, label: '一年', plan: '闭关修炼' });
});

test('resolveTurn：非法 landing_period → 清晨', () => {
  const s = skipState();
  const out = runSkip(s, {
    proposal: proposal({ landing_period: '正午' }),
  });
  assert.equal(out.state.clock.period, '清晨');
  assert.equal(out.state.clock.day, 10 + 365);
});

test('resolveTurn：安静/导演状态复位、事件/转折可预测、强制出图、npc 档案用跳跃后时钟', () => {
  const s = skipState();
  const out = runSkip(s);
  assert.equal(out.invalid, false);
  const st = out.state;
  assert.equal(st.focus, 'action');
  assert.equal(st.continuing, false);
  assert.equal(st.sceneStreak, 0);
  assert.equal(st.pendingEventTheme, null);
  // 注入 rng=()=>0：nextTwistTurn = 1+9+0，nextEventTurn = 1+3+0
  assert.equal(st.nextTwistTurn, 1 + constants.TWIST_GAP_MIN);
  assert.equal(st.nextEventTurn, 1 + 3);
  assert.equal(out.result.scene.draw, true, '时光推进强制出图');
  assert.ok(Array.isArray(out.result.npc_memory) && out.result.npc_memory.length >= 1,
    '应产生人物档案记录');
  assert.equal(out.result.npc_memory[0].at.clock.day, 10 + 365,
    '人物档案时间戳取跳跃后的 day');
});

test('resolveTurn：普通回合 result 没有 timeSkip 值', () => {
  const s = skipState();
  const out = e.resolveTurn(s, {
    action: '继续前行',
    proposal: proposal(),
  }, { rng: () => 0, now: 1 });
  assert.equal(out.invalid, false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.result, 'timeSkip'), false);
  assert.equal(out.result.timeSkip, undefined);
});

// ---------------------------------------------------------------------------
// 5. 提示词
// ---------------------------------------------------------------------------

function makePromptState() {
  return {
    bible: {
      title: '测试世界', tone: '苍凉', rules: [],
      places: [], factions: [],
      npcs: [{ name: '守夜人', role: '', desc: '' }],
      start: { place: '灰烬港', situation: '醒来', items: ['旧铜灯'] },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯', '无字信'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 1,
  };
}

test('prompts：timeSkip → 含新段 / landing_period / label / plan，不含原「缓慢推进」句', () => {
  const ts = e.normalizeTimeSkip({ span: 'year', plan: '闭关修炼' });
  // 走真实路径：plan.timeSkip（game.js 同时也会在 opts 里再给一份）
  const [system] = prompts.buildTurnMessages(makePromptState(),
    { nextTurn: 2, timeSkip: ts }, '行动');
  assert.ok(system.content.includes('时光推进（本回合特殊）'));
  assert.ok(system.content.includes('landing_period'));
  assert.ok(system.content.includes('一年'));
  assert.ok(system.content.includes('闭关修炼'));
  assert.ok(system.content.includes('单项最多 +3，正向合计最多 +5'));
  assert.equal(system.content.includes('时间只随回合缓慢推进'), false);
  // opts.timeSkip 也能触发
  const [system2] = prompts.buildTurnMessages(makePromptState(),
    { nextTurn: 2 }, '行动', { timeSkip: ts });
  assert.ok(system2.content.includes('时光推进（本回合特殊）'));
});

test('prompts：无 timeSkip → 含原「时与地」段，不含新段', () => {
  const [system] = prompts.buildTurnMessages(makePromptState(), { nextTurn: 2 }, '行动');
  assert.ok(system.content.includes('时间只随回合缓慢推进'));
  assert.equal(system.content.includes('时光推进（本回合特殊）'), false);
  assert.equal(system.content.includes('landing_period'), false);
});

test('prompts：month 的数值上限文案为 +1 / 2', () => {
  const ts = e.normalizeTimeSkip({ span: 'month' });
  const [system] = prompts.buildTurnMessages(makePromptState(),
    { nextTurn: 2, timeSkip: ts }, '行动');
  assert.ok(system.content.includes('单项最多 +1，正向合计最多 +2'));
  assert.ok(system.content.includes('玩家没有说明，按主角眼下的处境和性格过日子'));
});

// ---------------------------------------------------------------------------
// 6. mock
// ---------------------------------------------------------------------------

test('llm mock：turnCtx.timeSkip 让叙事首句点明时间过去，并输出 landing_period', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-skip-llm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = {
    LLM_MOCK: true, LLM_BASE: 'https://example.test/v1', LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'test-model', LLM_TIMEOUT_MS: 5000,
    LLM_DAILY_TOKEN_LIMIT: 0, LLM_EXTRA_BODY: '',
  };
  const c = llm.createClient(cfg, dir);
  const ts = e.normalizeTimeSkip({ span: 'year', plan: '闭关修炼' });
  const skip = JSON.parse((await c.complete({ mock: { turn: 1, timeSkip: ts } })).content);
  assert.ok(skip.narration.startsWith('一年过去了。'));
  assert.equal(skip.landing_period, '黄昏');
  assert.ok(skip.narration.includes('守夜人提灯拦住去路'), '其余 mock 正文照旧');
  const normal = JSON.parse((await c.complete({ mock: { turn: 1 } })).content);
  assert.equal(normal.landing_period, undefined);
  assert.equal(normal.narration.startsWith('一年过去了。'), false);
});

// ---------------------------------------------------------------------------
// 7. 公开输出
// ---------------------------------------------------------------------------

function baseResult() {
  return {
    narration: '一年过去，山门落叶满阶。', applied: { state_diff: {} }, rejected: [],
    suggestions: [], event: null, settlement: null, death: null,
    scene: { draw: false }, voice_hints: [], adult: false,
  };
}

test('toPublicTurnResult：有 timeSkip 输出四字段，无则不含该键', () => {
  const withTs = Object.assign(baseResult(), {
    timeSkip: { span: 'year', days: 365, label: '一年', plan: '闭关修炼' },
  });
  const pub = e.toPublicTurnResult(withTs, makeState());
  assert.deepEqual(pub.timeSkip, { span: 'year', days: 365, label: '一年', plan: '闭关修炼' });
  const pub2 = e.toPublicTurnResult(baseResult(), makeState());
  assert.equal(Object.prototype.hasOwnProperty.call(pub2, 'timeSkip'), false);
});

test('toPublicLogRecord：有 timeSkip 输出四字段，类型不对 / 无效则不输出', () => {
  const base = { turn: 1, life: 1, action: '继续', narration: '一年过去，山门落叶满阶。', applied: {}, ts: 1 };
  const good = game.toPublicLogRecord(Object.assign({}, base, {
    timeSkip: { span: 'year', days: 365, label: '一年', plan: '闭关修炼' },
  }));
  assert.deepEqual(good.timeSkip, { span: 'year', days: 365, label: '一年', plan: '闭关修炼' });
  assert.equal(Object.prototype.hasOwnProperty.call(game.toPublicLogRecord(base), 'timeSkip'), false);
  // 字段逐个取、类型不对就不输出；全错 → 整体不输出
  const bad = game.toPublicLogRecord(Object.assign({}, base, {
    timeSkip: { span: 5, days: '365', label: null, plan: {} },
  }));
  assert.equal(Object.prototype.hasOwnProperty.call(bad, 'timeSkip'), false);
  const partial = game.toPublicLogRecord(Object.assign({}, base, {
    timeSkip: { span: 'year', days: '365', label: '一年' },
  }));
  assert.deepEqual(partial.timeSkip, { span: 'year', label: '一年' });
});

// ---------------------------------------------------------------------------
// 8. 端到端（LLM_MOCK=1）
// ---------------------------------------------------------------------------

function makeGame(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-skip-game-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = 'sk-GAME-MOCK-SECRET';
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  return { g: game.createGame(cfg, dataDir), dataDir };
}

test('game：时光推进 → 公开结果 / 日志 / 时钟 / 人物档案时间戳 / 撤回 / 非法参数 400', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雪原上的钟摆之城', name: '甲', appearance: '白衣' });
  const id = world.id;
  const before = await g.getWorld(id);
  const day0 = before.clock.day;

  const res = await g.takeTurn(id, { timeSkip: { span: 'year', plan: '闭关修炼' } });
  assert.deepEqual(res.timeSkip, { span: 'year', days: 365, label: '一年', plan: '闭关修炼' });
  assert.equal(res.state.clock.day, day0 + 365);
  assert.equal(res.state.clock.period, '黄昏', 'mock 的 landing_period 生效');
  assert.equal(res.scene.draw, true, '时光推进强制出图');
  assert.ok(res.narration.startsWith('一年过去了。'));

  const log = await g.getWorldLog(id, 50);
  const rec = log.find((x) => x.timeSkip);
  assert.ok(rec, '公开 log 应含 timeSkip 记录');
  assert.deepEqual(rec.timeSkip, { span: 'year', days: 365, label: '一年', plan: '闭关修炼' });
  assert.equal(rec.action, '【时光推进·一年】闭关修炼');

  // 内部 events.jsonl：人物档案时间戳用跳跃后的 day
  const skipEv = store.readEvents(dataDir, id).filter((x) => x.timeSkip)[0];
  assert.ok(skipEv, 'events.jsonl 应含 timeSkip 字段');
  const mem = (skipEv.npc_memory || []).filter((m) => m && m.at);
  assert.ok(mem.length >= 1, '应有人物档案记录');
  assert.equal(mem[0].at.clock.day, day0 + 365);

  // 撤回：clock 恢复
  const undone = await g.undoTurn(id);
  assert.equal(undone.undoneTurn, res.state.turn);
  const restored = await g.getWorld(id);
  assert.equal(restored.clock.day, day0);

  // 非法 span → 400
  await assert.rejects(
    () => g.takeTurn(id, { timeSkip: { span: 'decade' } }),
    (err) => err && err.status === 400,
    '非法时光推进参数应报 400',
  );
});
