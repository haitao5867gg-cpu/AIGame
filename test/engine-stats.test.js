'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const stats = require('../src/engine/stats.js');
const { makeState, proposal, run } = require('./helpers/engine-helpers.js');

// 测试用原始设计（未消毒）：一个 gauge、一个 rank。
function gaugeSpec(over) {
  return Object.assign({
    name: '饱腹', kind: 'gauge', icon: '🍖', desc: '肚子饱不饱',
    max: 100, start: 70, drift: -3,
    warn: [
      { below: 30, label: '饥肠辘辘', effect: '手脚发软、注意力涣散' },
      { below: 10, label: '饿到发昏', effect: '每回合体魄 -1', drain: '体魄' },
    ],
  }, over || {});
}

function rankSpec(over) {
  return Object.assign({
    name: '境界', kind: 'rank', icon: '☯', desc: '修行层次',
    ranks: ['凡人', '炼气', '筑基', '金丹', '元婴'], start: 1,
  }, over || {});
}

const CLEAN_GAUGE = {
  name: '饱腹', kind: 'gauge', icon: '🍖', desc: '肚子饱不饱',
  max: 100, start: 70, value: 70, drift: -3,
  warn: [
    { below: 30, label: '饥肠辘辘', effect: '手脚发软、注意力涣散' },
    { below: 10, label: '饿到发昏', effect: '每回合体魄 -1', drain: '体魄' },
  ],
};
const CLEAN_RANK = {
  name: '境界', kind: 'rank', icon: '☯', desc: '修行层次',
  ranks: ['凡人', '炼气', '筑基', '金丹', '元婴'], start: 1, value: 1,
};

function worldWith(specs) {
  const s = e.createWorld(
    { id: 'stats-w', bible: { stats: specs } },
    { rng: () => 0 },
  );
  s.nextEventTurn = 999; // 关掉事件，隔离专属状态的数值结算
  return s;
}

// ---------- stats.js 导出面 ----------

test('stats.js 全部导出、engine.js 暴露新常量与新函数', () => {
  for (const fn of ['normalizeStatsSpec', 'fallbackStats', 'warnActive', 'activeWarnings',
    'validateStatsDiff', 'applyStatsTurn', 'resetStats', 'publicStats']) {
    assert.equal(typeof stats[fn], 'function', `stats.js 应导出 ${fn}`);
    assert.equal(typeof e[fn], 'function', `engine.js 应导出 ${fn}`);
  }
  assert.equal(e.STATS_MAX, 4);
  assert.equal(e.STATS_GAUGE_DIFF, 30);
  assert.equal(e.STATS_RANK_DIFF, 1);
  assert.equal(e.STATS_SKIP_GAUGE_DIFF, 100);
  assert.equal(e.STATS_SKIP_RANK_DIFF, 2);
});

// ---------- normalizeStatsSpec ----------

test('normalizeStatsSpec: 合法 gauge / rank 原样保留（value=start）', () => {
  assert.deepEqual(e.normalizeStatsSpec([gaugeSpec(), rankSpec()], 'xuanhuan'), [CLEAN_GAUGE, CLEAN_RANK]);
});

test('normalizeStatsSpec: 缺省字段补默认值、kind 非 rank 一律当 gauge', () => {
  assert.deepEqual(e.normalizeStatsSpec([{ name: '灵力', kind: '什么鬼' }], 'general'), [{
    name: '灵力', kind: 'gauge', icon: '◆', desc: '',
    max: 100, start: 70, value: 70, drift: 0, warn: [],
  }]);
  // icon 过长 → 默认；desc 截 30 字；drift / max / start 取整夹范围
  const out = e.normalizeStatsSpec([{
    name: '水', icon: '一二三四五', desc: '很'.repeat(40),
    max: 9, start: 9999, drift: 99,
  }], 'general');
  assert.equal(out[0].icon, '◆');
  assert.equal(out[0].desc.length, 30);
  assert.equal(out[0].max, 10);
  assert.equal(out[0].start, 10);
  assert.equal(out[0].value, 10);
  assert.equal(out[0].drift, 10);
  // rank 用 '★' 兜底
  assert.equal(e.normalizeStatsSpec([rankSpec({ icon: '' })], 'general')[0].icon, '★');
});

test('normalizeStatsSpec: name 超长 / 与基础属性同名 / 重名 被丢', () => {
  const out = e.normalizeStatsSpec([
    gaugeSpec({ name: '饱腹状态名字超长' }), // 8 字 > 6
    gaugeSpec({ name: '体魄' }),             // 与基础属性同名
    gaugeSpec({ name: '  ' }),               // trim 后为空
    gaugeSpec({ name: '饱腹' }),             // 合法
    gaugeSpec({ name: '饱腹' }),             // 与前面重名
    rankSpec(),                             // 合法
  ], 'general');
  assert.deepEqual(out.map((s) => s.name), ['饱腹', '境界']);
});

test('normalizeStatsSpec: warn 多于 3 条只留前 3 条合法项', () => {
  const over = gaugeSpec({ warn: [
    { below: 90, label: 'a' }, { below: 80, label: 'b' },
    { below: 70, label: 'c' }, { below: 60, label: 'd' }, { below: 50, label: 'e' },
  ] });
  const out = e.normalizeStatsSpec([over], 'general');
  assert.deepEqual(out[0].warn.map((w) => w.label), ['a', 'b', 'c']);
  // 非法项跳过，继续收后面的合法项
  const mixed = gaugeSpec({ warn: [
    { below: 90, label: 'a' }, { label: '坏' }, { below: 70, label: 'c' },
  ] });
  assert.deepEqual(e.normalizeStatsSpec([mixed], 'general')[0].warn.map((w) => w.label), ['a', 'c']);
});

test('normalizeStatsSpec: below / above 都没有或都有的 warn 被丢；label/effect 截断', () => {
  const out = e.normalizeStatsSpec([gaugeSpec({ warn: [
    { label: '无线' },
    { below: 20, above: 30, label: '都有' },
    { above: 80, label: '标签'.repeat(9), effect: '说'.repeat(50) },
  ] })], 'general');
  assert.equal(out[0].warn.length, 1);
  assert.equal(out[0].warn[0].above, 80);
  assert.equal(Object.prototype.hasOwnProperty.call(out[0].warn[0], 'below'), false);
  assert.equal(out[0].warn[0].label.length, 8);
  assert.equal(out[0].warn[0].effect.length, 40);
  // below 夹到 [1,max-1]
  const cl = e.normalizeStatsSpec([gaugeSpec({ warn: [{ below: 999, label: 'x' }] })], 'general');
  assert.equal(cl[0].warn[0].below, 99);
});

test('normalizeStatsSpec: drain 非 ATTRS 被去掉', () => {
  const out = e.normalizeStatsSpec([gaugeSpec({ warn: [
    { below: 10, label: 'x', drain: '武力' },
    { below: 5, label: 'y', drain: '心智' },
  ] })], 'general');
  assert.equal(Object.prototype.hasOwnProperty.call(out[0].warn[0], 'drain'), false);
  assert.equal(out[0].warn[1].drain, '心智');
});

test('normalizeStatsSpec: ranks 不足 2 个（含非数组 / 去重后不足）的 rank 被丢', () => {
  const out = e.normalizeStatsSpec([
    rankSpec({ ranks: ['凡人'] }),
    rankSpec({ ranks: [] }),
    rankSpec({ ranks: 'abc' }),
    rankSpec({ ranks: ['甲', '甲', '  '] }), // 去重后仅 1 个
    rankSpec(),                              // 合法
  ], 'general');
  assert.deepEqual(out.map((s) => s.name), ['境界']);
});

test('normalizeStatsSpec: ranks trim/截 8/去重/最多 12；多于 4 项只留前 4', () => {
  const r = e.normalizeStatsSpec([rankSpec({
    ranks: [' 甲 ', '甲', '乙'.repeat(12), '丙', ...Array.from({ length: 15 }, (_, i) => `阶${i}`)],
  })], 'general')[0];
  assert.equal(r.ranks[0], '甲');
  assert.equal(r.ranks[1].length, 8);
  assert.equal(r.ranks.length, 12);
  assert.equal(new Set(r.ranks).size, r.ranks.length);

  const five = ['甲', '乙', '丙', '丁', '戊'].map((n) => gaugeSpec({ name: n }));
  assert.deepEqual(e.normalizeStatsSpec(five, 'general').map((s) => s.name), ['甲', '乙', '丙', '丁']);
});

test('normalizeStatsSpec: 只有 1 项时原样返回 1 项；全部不合法 → 题材兜底', () => {
  assert.equal(e.normalizeStatsSpec([gaugeSpec()], 'general').length, 1);
  const bad = [null, 5, 'x', [], gaugeSpec({ name: '体魄' }), rankSpec({ ranks: ['凡人'] })];
  assert.deepEqual(e.normalizeStatsSpec(bad, 'xuanhuan'), e.fallbackStats('xuanhuan'));
  assert.deepEqual(e.normalizeStatsSpec('不是数组', 'horror'), e.fallbackStats('horror'));
});

test('fallbackStats: 六个题材 + 未知题材都合法（重跑 normalizeStatsSpec 不变）、value=start、每次返回新对象', () => {
  for (const g of ['xuanhuan', 'urban', 'game', 'horror', 'cozy', 'general', 'unknown']) {
    const fb = e.fallbackStats(g);
    assert.ok(Array.isArray(fb) && fb.length >= 1, `${g} 兜底应为非空数组`);
    assert.ok(fb.length <= e.STATS_MAX);
    assert.ok(fb.every((s) => s.value === s.start), `${g} 兜底 value 应等于 start`);
    assert.deepEqual(e.normalizeStatsSpec(fb, g), fb, `${g} 兜底应已是合法形状（幂等）`);

    const fb2 = e.fallbackStats(g);
    assert.notStrictEqual(fb, fb2, `${g} 每次返回新数组`);
    assert.notStrictEqual(fb[0], fb2[0], `${g} 每次返回新对象`);
    const nestedA = fb[0].warn || fb[0].ranks;
    const nestedB = fb2[0].warn || fb2[0].ranks;
    assert.notStrictEqual(nestedA, nestedB, `${g} 嵌套数组不共享引用`);
    fb[0].value = 999;
    assert.notEqual(fb2[0].value, 999, `${g} 两份结果互不影响`);
  }
  // 具体题材内容抽查
  assert.equal(e.fallbackStats('xuanhuan')[0].kind, 'rank');
  assert.equal(e.fallbackStats('xuanhuan')[0].ranks.length, 6);
  assert.equal(e.fallbackStats('game')[0].ranks.length, 10);
  assert.equal(e.fallbackStats('game')[0].ranks[9], 'Lv.10');
  assert.deepEqual(e.fallbackStats('unknown'), e.fallbackStats('general'));
});

// ---------- warnActive / activeWarnings ----------

test('warnActive: gauge 且 below/above 判定、rank / 缺字段返回 false', () => {
  const g = { kind: 'gauge', value: 20 };
  assert.equal(e.warnActive(g, { below: 30 }), true);
  assert.equal(e.warnActive(g, { below: 20 }), true);  // <=
  assert.equal(e.warnActive(g, { below: 10 }), false);
  assert.equal(e.warnActive(g, { above: 10 }), true);
  assert.equal(e.warnActive(g, { above: 20 }), true);  // >=
  assert.equal(e.warnActive(g, { above: 30 }), false);
  assert.equal(e.warnActive(g, {}), false);
  assert.equal(e.warnActive({ kind: 'rank', value: 1 }, { below: 30 }), false);
  assert.equal(e.warnActive(null, { below: 30 }), false);
});

test('activeWarnings: 只收生效警戒、按 stats 顺序、缺失/非数组当 []', () => {
  const st = e.normalizeStatsSpec([
    gaugeSpec({ name: '饱腹', start: 20, drift: 0, warn: [
      { below: 30, label: '饿', effect: 'x' },
      { above: 10, label: '撑', effect: 'y', drain: '体魄' },
      { below: 5, label: '不生效', effect: 'z' },
    ] }),
    rankSpec(),
  ], 'general');
  assert.deepEqual(e.activeWarnings(st), [
    { stat: '饱腹', label: '饿', effect: 'x' },
    { stat: '饱腹', label: '撑', effect: 'y', drain: '体魄' },
  ]);
  assert.deepEqual(e.activeWarnings(undefined), []);
  assert.deepEqual(e.activeWarnings('bad'), []);
  assert.deepEqual(e.activeWarnings([null, 5]), []);
});

// ---------- validateStatsDiff ----------

test('validateStatsDiff: 未知名字被忽略并写 rejected', () => {
  const st = e.normalizeStatsSpec([gaugeSpec(), rankSpec()], 'xuanhuan');
  const v = e.validateStatsDiff(st, { 不存在: 5 }, {});
  assert.deepEqual(v.diff, {});
  assert.ok(v.rejected.some((r) => r.includes('忽略未知专属状态「不存在」')));
});

test('validateStatsDiff: 非数字 / NaN / 0 都不记 diff', () => {
  const st = e.normalizeStatsSpec([gaugeSpec(), rankSpec()], 'xuanhuan');
  const v = e.validateStatsDiff(st, { 饱腹: 'abc', 境界: NaN, 体魄: 3 }, {});
  assert.deepEqual(v.diff, {});
  assert.ok(v.rejected.some((r) => r.includes('无效')));
  assert.ok(v.rejected.some((r) => r.includes('忽略未知专属状态「体魄」')));
  assert.deepEqual(e.validateStatsDiff(st, { 饱腹: 0 }, {}).diff, {});
});

test('validateStatsDiff: 单回合超限截断（gauge ±30 / rank ±1）并写 rejected', () => {
  const st = e.normalizeStatsSpec([gaugeSpec(), rankSpec()], 'xuanhuan');
  const v = e.validateStatsDiff(st, { 饱腹: 50, 境界: 9 }, {});
  assert.equal(v.diff['饱腹'], 30);  // 70 → 100
  assert.equal(v.diff['境界'], 1);   // 1 → 2
  assert.ok(v.rejected.some((r) => r.includes('已截断')));
  const neg = e.validateStatsDiff(st, { 饱腹: -999, 境界: -9 }, {});
  assert.deepEqual(neg.diff, { 饱腹: -30, 境界: -1 });
});

test('validateStatsDiff: 时光推进放宽（gauge 100 / rank 2）', () => {
  const big = e.normalizeStatsSpec([
    gaugeSpec({ name: '灵力', max: 1000, start: 500 }),
    rankSpec({ name: '位阶', ranks: Array.from({ length: 12 }, (_, i) => `阶${i}`), start: 0 }),
  ], 'general');
  const n = e.validateStatsDiff(big, { 灵力: 90, 位阶: 3 }, {});
  const s = e.validateStatsDiff(big, { 灵力: 90, 位阶: 3 }, { timeSkip: true });
  assert.deepEqual(n.diff, { 灵力: 30, 位阶: 1 });
  assert.deepEqual(s.diff, { 灵力: 90, 位阶: 2 });
  assert.ok(n.rejected.length > 0);
});

test('validateStatsDiff: 夹到合法范围后记实际变化量、实际为 0 不记', () => {
  const cases = [
    [70, 30, 30],   // 70 → 100
    [95, 30, 5],    // 95 → 100
    [2, -30, -2],   // 2 → 0
  ];
  for (const [start, delta, expect] of cases) {
    const st = e.normalizeStatsSpec([gaugeSpec({ start })], 'general');
    assert.equal(e.validateStatsDiff(st, { 饱腹: delta }, {}).diff['饱腹'], expect);
  }
  const top = e.normalizeStatsSpec([gaugeSpec({ start: 100 })], 'general');
  assert.deepEqual(e.validateStatsDiff(top, { 饱腹: 30 }, {}).diff, {});
  const rankTop = e.normalizeStatsSpec([rankSpec({ start: 4 })], 'general');
  assert.deepEqual(e.validateStatsDiff(rankTop, { 境界: 1 }, {}).diff, {});
  // opts 缺省等价于非时光推进
  const st = e.normalizeStatsSpec([gaugeSpec({ max: 1000, start: 100 })], 'general');
  assert.equal(e.validateStatsDiff(st, { 饱腹: 90 }).diff['饱腹'], 30);
});

// ---------- applyStatsTurn ----------

test('applyStatsTurn: 先 diff 后 drift、按新值算 drains、不改入参', () => {
  const st = e.normalizeStatsSpec([gaugeSpec({ start: 20 })], 'general');
  const before = JSON.stringify(st);
  const out = e.applyStatsTurn(st, { 饱腹: -15 }, 1);
  assert.equal(out.stats[0].value, 2);       // 20-15=5，再 5-3=2
  assert.deepEqual(out.drift, { 饱腹: -3 }); // 只记漂移段的实际变化
  assert.deepEqual(out.drains, [{ stat: '饱腹', label: '饿到发昏', attr: '体魄' }]);
  assert.equal(JSON.stringify(st), before, '不改入参');
  assert.notStrictEqual(out.stats[0], st[0]);
});

test('applyStatsTurn: passes=0 不漂移、passes=2 漂移两次、夹 [0,max]', () => {
  const st = e.normalizeStatsSpec([gaugeSpec({ start: 50 })], 'general');
  const zero = e.applyStatsTurn(st, {}, 0);
  assert.equal(zero.stats[0].value, 50);
  assert.deepEqual(zero.drift, {});
  const two = e.applyStatsTurn(st, {}, 2);
  assert.equal(two.stats[0].value, 44);
  assert.deepEqual(two.drift, { 饱腹: -6 });

  const low = e.normalizeStatsSpec([gaugeSpec({ start: 2 })], 'general');
  const a = e.applyStatsTurn(low, {}, 2);
  assert.equal(a.stats[0].value, 0);
  assert.deepEqual(a.drift, { 饱腹: -2 });
  const high = e.normalizeStatsSpec([gaugeSpec({ start: 98, drift: 3 })], 'general');
  const b = e.applyStatsTurn(high, {}, 2);
  assert.equal(b.stats[0].value, 100);
  assert.deepEqual(b.drift, { 饱腹: 2 });
});

test('applyStatsTurn: drain 按 attr 去重（同一属性本回合只扣 1）', () => {
  const st = e.normalizeStatsSpec([
    gaugeSpec({ name: '饱腹', start: 5, drift: 0, warn: [
      { below: 10, label: '饿', drain: '体魄' },
      { below: 8, label: '昏', drain: '体魄' },
      { below: 6, label: '危', drain: '心智' },
    ] }),
    gaugeSpec({ name: '水分', start: 2, drift: 0, warn: [{ below: 5, label: '渴', drain: '体魄' }] }),
  ], 'general');
  const out = e.applyStatsTurn(st, {}, 0);
  assert.deepEqual(out.drains, [
    { stat: '饱腹', label: '饿', attr: '体魄' },
    { stat: '饱腹', label: '危', attr: '心智' },
  ]);
});

test('applyStatsTurn: rank 应用 diff 但不漂移、缺失/非数组/坏 diff 安全', () => {
  const st = e.normalizeStatsSpec([rankSpec()], 'general');
  const out = e.applyStatsTurn(st, { 境界: 1 }, 2);
  assert.equal(out.stats[0].value, 2);
  assert.deepEqual(out.drift, {});
  assert.deepEqual(out.drains, []);
  assert.deepEqual(e.applyStatsTurn(undefined, null, 1), { stats: [], drift: {}, drains: [] });
  assert.deepEqual(e.applyStatsTurn('bad', { x: 1 }, 1), { stats: [], drift: {}, drains: [] });
});

// ---------- resetStats / publicStats ----------

test('resetStats: value 回 start、不改入参、老存档安全', () => {
  const st = e.normalizeStatsSpec([gaugeSpec(), rankSpec()], 'general');
  st[0].value = 3;
  st[1].value = 4;
  const before = JSON.stringify(st);
  const r = e.resetStats(st);
  assert.deepEqual(r.map((s) => s.value), [70, 1]);
  assert.equal(JSON.stringify(st), before);
  assert.deepEqual(e.resetStats(undefined), []);
});

test('publicStats: alerts（含 severe）、rankName、不改入参、老存档输出 []', () => {
  const st = e.normalizeStatsSpec([
    gaugeSpec({ name: '饱腹', start: 5, drift: 0, warn: [
      { below: 30, label: '饥肠辘辘', effect: '手脚发软' },
      { below: 10, label: '饿到发昏', effect: '每回合体魄 -1', drain: '体魄' },
      { below: 1, label: '不生效', effect: '' },
    ] }),
    rankSpec(),
  ], 'general');
  const pub = e.publicStats(st);
  assert.deepEqual(pub[0].alerts, [
    { label: '饥肠辘辘', effect: '手脚发软', severe: false },
    { label: '饿到发昏', effect: '每回合体魄 -1', severe: true },
  ]);
  assert.equal(pub[1].rankName, '炼气');
  assert.equal(Object.prototype.hasOwnProperty.call(st[0], 'alerts'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(st[1], 'rankName'), false);
  assert.deepEqual(e.publicStats(undefined), []);
});

// ---------- 接入 ----------

test('createWorld: 带 bible.stats 时 state.stats 正确、bible.stats 原样保留；不带时用兜底', () => {
  const s = e.createWorld(
    { id: 'w', genre: 'xuanhuan', bible: { stats: [gaugeSpec(), rankSpec()] } },
    { rng: () => 0 },
  );
  assert.deepEqual(s.stats, [CLEAN_GAUGE, CLEAN_RANK]);
  assert.deepEqual(s.bible.stats, [gaugeSpec(), rankSpec()]);

  assert.deepEqual(
    e.createWorld({ id: 'w', genre: 'horror', bible: {} }, { rng: () => 0 }).stats,
    e.fallbackStats('horror'),
  );
  assert.deepEqual(
    e.createWorld({ id: 'w', bible: {} }, { rng: () => 0 }).stats,
    e.fallbackStats('general'),
  );
});

test('resolveTurn: 一回合后 drift 生效、stats_diff 生效、result 带 stats_drift', () => {
  const s = worldWith([gaugeSpec({ name: '饱腹', start: 50, drift: -3 })]);
  const out = run(s, { action: 'a', proposal: proposal({ stats_diff: { 饱腹: 10 } }) });
  assert.equal(out.invalid, false);
  assert.deepEqual(out.result.applied.stats_diff, { 饱腹: 10 });
  assert.equal(out.state.stats[0].value, 57); // 50 +10 -3
  assert.deepEqual(out.result.stats_drift, { 饱腹: -3 });
  assert.deepEqual(out.result.stats_drains, []);
  assert.equal(s.stats[0].value, 50, '不改入参状态');
});

test('resolveTurn: 饱腹跌到 drain 线时体魄 -1', () => {
  const s = worldWith([gaugeSpec({
    name: '饱腹', start: 12, drift: -3,
    warn: [{ below: 10, label: '饿到发昏', effect: '每回合体魄 -1', drain: '体魄' }],
  })]);
  const out = run(s, { action: 'a', proposal: proposal() });
  assert.equal(out.state.stats[0].value, 9);
  assert.deepEqual(out.result.stats_drains, [{ stat: '饱腹', label: '饿到发昏', attr: '体魄' }]);
  assert.equal(out.state.character.attrs['体魄'], 5); // 6 - 1
});

test('resolveTurn: 体魄因此归零 → 触发「体魄归零」死亡', () => {
  const s = worldWith([gaugeSpec({
    name: '饱腹', start: 12, drift: -3,
    warn: [{ below: 10, label: '饿到发昏', effect: '每回合体魄 -1', drain: '体魄' }],
  })]);
  s.character.attrs['体魄'] = 1;
  const out = run(s, { action: 'a', proposal: proposal() });
  assert.ok(out.result.death);
  assert.equal(out.result.death.reason, '体魄归零');
  assert.equal(out.state.life, 2);
  assert.equal(out.state.awaitingRebirth, true);
});

test('resolveTurn: 时光推进 passes=0 不漂移且数值上限放宽', () => {
  const make = () => worldWith([gaugeSpec({ name: '饱腹', max: 1000, start: 100, drift: -3 })]);
  const normal = run(make(), { action: 'a', proposal: proposal({ stats_diff: { 饱腹: 90 } }) });
  assert.equal(normal.result.applied.stats_diff['饱腹'], 30);
  assert.equal(normal.state.stats[0].value, 127); // 100 +30 -3

  const s2 = make();
  const ts = e.normalizeTimeSkip({ span: 'year' });
  const plan = e.planTurn(s2, { rng: () => 0, timeSkip: ts });
  const skip = e.resolveTurn(s2, {
    action: '闭关',
    proposal: proposal({ stats_diff: { 饱腹: 90 }, landing_period: '午后' }),
    plan,
  }, { rng: () => 0, now: 1 });
  assert.equal(skip.invalid, false);
  assert.equal(skip.result.applied.stats_diff['饱腹'], 90);
  assert.equal(skip.state.stats[0].value, 190); // 100 +90，无漂移
  assert.deepEqual(skip.result.stats_drift, {});
  assert.deepEqual(skip.result.stats_drains, []);
});

test('resolveTurn: 老存档（无 stats 字段）结果与此前一致、无 drains、属性不受影响', () => {
  const base = makeState();
  delete base.stats;
  base.nextEventTurn = 999;
  const ref = run(base, { action: 'a', proposal: proposal() });

  const s = makeState();
  delete s.stats;
  s.nextEventTurn = 999;
  const before = JSON.stringify(s);
  const out = run(s, { action: 'a', proposal: proposal({ stats_diff: { 饱腹: 10 } }) });
  assert.equal(JSON.stringify(s), before, '不改入参');
  assert.ok(out.state.stats === undefined || (Array.isArray(out.state.stats) && out.state.stats.length === 0));
  assert.deepEqual(out.result.stats_drift, {});
  assert.deepEqual(out.result.stats_drains, []);
  assert.deepEqual(out.result.applied.stats_diff, {});
  assert.ok(out.result.rejected.some((r) => r.includes('忽略未知专属状态「饱腹」')));
  assert.deepEqual(out.state.character.attrs, ref.state.character.attrs);
});

test('rebirth: 新一世 stats value 回到 start', () => {
  const s = worldWith([gaugeSpec({ name: '饱腹', start: 70 }), rankSpec()]);
  s.stats[0].value = 12;
  s.stats[1].value = 4;
  const rb = e.rebirth(s, { name: '二世', appearance: '布衣' });
  assert.equal(rb.error, null);
  assert.deepEqual(rb.state.stats.map((x) => x.value), [70, 1]);
  assert.equal(s.stats[0].value, 12, '不改入参');
});

test('toPublicState: 有 stats / alerts / rankName；老存档缺字段输出 []', () => {
  const s = worldWith([
    gaugeSpec({ name: '饱腹', start: 5, drift: 0, warn: [
      { below: 30, label: '饥肠辘辘', effect: '手脚发软' },
      { below: 10, label: '饿到发昏', effect: '每回合体魄 -1', drain: '体魄' },
    ] }),
    rankSpec(),
  ]);
  const pub = e.toPublicState(s);
  assert.equal(pub.stats.length, 2);
  assert.deepEqual(pub.stats[0].alerts, [
    { label: '饥肠辘辘', effect: '手脚发软', severe: false },
    { label: '饿到发昏', effect: '每回合体魄 -1', severe: true },
  ]);
  assert.equal(pub.stats[1].rankName, '炼气');

  const old = makeState();
  delete old.stats;
  assert.deepEqual(e.toPublicState(old).stats, []);
});

test('toPublicTurnResult: 带 stats_drift / stats_drains；缺失时 {} / []', () => {
  const s = worldWith([gaugeSpec({ name: '饱腹', start: 50, drift: -3 })]);
  const out = run(s, { action: 'a', proposal: proposal({ stats_diff: { 饱腹: 10 } }) });
  const pub = e.toPublicTurnResult(out.result, out.state);
  assert.deepEqual(pub.stats_drift, { 饱腹: -3 });
  assert.deepEqual(pub.stats_drains, []);
  assert.equal(pub.state.stats[0].alerts.length, 0);

  const empty = e.toPublicTurnResult(
    { narration: 'n', applied: {}, rejected: [] },
    makeState(),
  );
  assert.deepEqual(empty.stats_drift, {});
  assert.deepEqual(empty.stats_drains, []);
});

test('公开 applied 白名单包含 stats_diff', () => {
  const s = worldWith([gaugeSpec({ name: '饱腹' })]);
  const out = run(s, { action: 'a', proposal: proposal({ stats_diff: { 饱腹: 5 } }) });
  const pub = e.toPublicTurnResult(out.result, out.state);
  assert.equal(Object.prototype.hasOwnProperty.call(pub.applied, 'stats_diff'), true);
  assert.deepEqual(pub.applied.stats_diff, { 饱腹: 5 });
});
