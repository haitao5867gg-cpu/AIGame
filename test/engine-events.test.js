'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const { seeded, makeState, proposal, run, eventState, settle, killByBody } = require('./helpers/engine-helpers.js');

// ---------- 事件排程 ----------

test('planTurn: 到点开新事件、事件中不重开、下一回合结算、needChapter', () => {
  const s = makeState();
  s.nextEventTurn = 8;
  s.turn = 6;
  let plan = e.planTurn(s, { rng: () => 0 });
  assert.equal(plan.opening, false);
  assert.equal(plan.settling, false);

  s.turn = 7;
  plan = e.planTurn(s, { rng: () => 0 });
  assert.equal(plan.opening, true);
  assert.equal(plan.needEvent, true);
  assert.equal(plan.theme, '魔族入侵');
  assert.equal(plan.nextTurn, 8);

  const out = run(s, {
    action: 'a',
    proposal: proposal(),
    plan,
    event: { title: '边境烽火', desc: '北境告急' },
  });
  assert.equal(out.state.activeEvent.theme, '魔族入侵');
  assert.equal(out.state.activeEvent.title, '边境烽火');
  assert.equal(out.state.activeEvent.desc, '北境告急');
  assert.equal(out.state.activeEvent.startedTurn, 8);
  assert.equal(out.result.event.theme, '魔族入侵');

  const p2 = e.planTurn(out.state, { rng: () => 0 });
  assert.equal(p2.opening, false);
  assert.equal(p2.settling, true);
  assert.equal(p2.needSettlement, true);

  const noThemes = makeState();
  noThemes.bible.eventThemes = [];
  noThemes.turn = 100;
  noThemes.nextEventTurn = 1;
  // 主题为空时引擎用通用主题兜底，事件仍能开启（旧世界兼容）。
  const legacy = e.planTurn(noThemes, { rng: () => 0 });
  assert.equal(legacy.opening, true);
  assert.ok(e.GENERIC_EVENT_THEMES.includes(legacy.theme));

  const c = makeState();
  c.turn = 19;
  c.nextEventTurn = 999;
  assert.equal(e.planTurn(c, { rng: () => 0 }).needChapter, true);
  c.turn = 18;
  assert.equal(e.planTurn(c, { rng: () => 0 }).needChapter, false);
});

// ---------- 四档结算 ----------

// 新公式：score = min(属性,20)*0.5 + response_quality*4 + rng(0~8)；阈值不变。
// settle() 注入常量 rng，rand=floor(unit(rng)*9)。
test('事件结算：蜕变 >=24（该属性 +3、声望 +2）', () => {
  const out = settle({ 体魄: 20 }, 3, 0.9); // 10 + 12 + 8 = 30
  assert.equal(out.result.settlement.tier, '蜕变');
  assert.equal(out.result.settlement.score, 30);
  assert.deepEqual(out.result.settlement.effects, { 体魄: 3, 声望: 2 });
  assert.equal(out.state.character.attrs['体魄'], 23);
  assert.equal(out.state.character.attrs['声望'], 8);
  assert.equal(out.state.activeEvent, null);
});

test('事件结算：险胜 >=16（+1）、代价 >=9（体魄 -2、资源 -2）', () => {
  const win = settle({ 体魄: 20 }, 1, 0.25); // 10 + 4 + 2 = 16
  assert.equal(win.result.settlement.tier, '险胜');
  assert.equal(win.result.settlement.score, 16);
  assert.equal(win.state.character.attrs['体魄'], 21);

  const cost = settle({ 体魄: 10 }, 1, 0); // 5 + 4 + 0 = 9
  assert.equal(cost.result.settlement.tier, '代价');
  assert.equal(cost.result.settlement.score, 9);
  assert.equal(cost.state.character.attrs['体魄'], 8);
  assert.equal(cost.state.character.attrs['资源'], 4);
});

test('事件结算：殒命 <9，触发死亡', () => {
  const out = settle({ 体魄: 8 }, 1, 0); // 4 + 4 + 0 = 8
  assert.equal(out.result.settlement.tier, '殒命');
  assert.equal(out.result.settlement.score, 8);
  assert.ok(out.result.death);
  assert.equal(out.result.death.reason, '事件殒命');
  assert.equal(out.state.life, 2);
  assert.equal(out.state.awaitingRebirth, true);
});

test('事件结算：四档边界 24 / 23 / 16 / 9 / 8', () => {
  assert.equal(settle({ 体魄: 20 }, 3, 0.25).result.settlement.tier, '蜕变'); // 10+12+2=24
  assert.equal(settle({ 体魄: 20 }, 3, 0.15).result.settlement.tier, '险胜'); // 10+12+1=23
  assert.equal(settle({ 体魄: 20 }, 1, 0.25).result.settlement.tier, '险胜'); // 10+4+2=16
  assert.equal(settle({ 体魄: 10 }, 1, 0).result.settlement.tier, '代价');   // 5+4+0=9
  assert.equal(settle({ 体魄: 8 }, 1, 0).result.settlement.tier, '殒命');    // 4+4+0=8
});

test('事件结算：min(属性,20) 封顶，属性 40 也只贡献 10，不再必然蜕变', () => {
  const capped = settle({ 体魄: 40 }, 0, 0); // 10 + 0 + 0 = 10 → 代价
  assert.equal(capped.result.settlement.score, 10);
  assert.equal(capped.result.settlement.tier, '代价');
  const still = settle({ 体魄: 40 }, 3, 0.25); // 10 + 12 + 2 = 24 → 蜕变仍需质量+运气
  assert.equal(still.result.settlement.score, 24);
  assert.equal(still.result.settlement.tier, '蜕变');
});

test('事件结算：response_quality 夹 0~3、attr 非法回退、事件效果夹 [0,40]', () => {
  const q = settle({ 体魄: 20 }, 9, 0); // q 夹到 3：10 + 12 + 0 = 22 → 险胜
  assert.equal(q.result.settlement.response_quality, 3);
  assert.equal(q.result.settlement.tier, '险胜');
  assert.equal(q.result.settlement.score, 22);

  const bad = settle({ 体魄: 20 }, 0, 0, {
    event_check: { attr: '武力', response_quality: 0 },
  });
  assert.equal(bad.result.settlement.attr, '体魄');
  assert.ok(bad.result.rejected.some((r) => r.includes('非白名单属性')));

  const capped = settle({ 体魄: 39 }, 3, 0.9); // 10 + 12 + 8 = 30 → 蜕变，+3 夹到 40
  assert.equal(capped.state.character.attrs['体魄'], 40);
});

test('事件回合不可回避：空行动仍按公式结算', () => {
  const out = settle({ 体魄: 40 }, 2, 0, { action: '' }); // 10 + 8 + 0 = 18
  assert.ok(out.result.settlement);
  assert.equal(out.result.settlement.score, 18);
  assert.equal(out.result.settlement.tier, '险胜');
  assert.equal(out.result.settlement.response_quality, 2);
  assert.ok(out.result.rejected.some((r) => r.includes('不可回避')));
});

test('结算后 nextEventTurn = turn + 7~12', () => {
  const lo = settle({ 体魄: 12 }, 1, 0);
  assert.equal(lo.state.nextEventTurn - lo.state.turn, 7);
  const hi = settle({ 体魄: 12 }, 1, 0.999999);
  assert.equal(hi.state.nextEventTurn - hi.state.turn, 12);
});

// ---------- 风声预兆（omen / pendingEventTheme） ----------

test('风声预兆：computeOmen 只在无进行中事件且 nextEventTurn - turn 为 1~2 时为真', () => {
  const s = makeState();
  s.activeEvent = null;
  s.turn = 5;
  s.nextEventTurn = 8;
  assert.equal(e.computeOmen(s), false); // gap 3
  s.nextEventTurn = 7;
  assert.equal(e.computeOmen(s), true);  // gap 2
  s.nextEventTurn = 6;
  assert.equal(e.computeOmen(s), true);  // gap 1
  s.nextEventTurn = 5;
  assert.equal(e.computeOmen(s), false); // gap 0
  s.activeEvent = { theme: '天灾' };
  assert.equal(e.computeOmen(s), false); // 有进行中事件
});

test('风声预兆：planTurn 在预兆窗口提前选主题，开事件时沿用同一主题', () => {
  const s = makeState();
  s.turn = 5;
  s.nextEventTurn = 8; // gap 3 → 无预兆
  let plan = e.planTurn(s, { rng: () => 0 });
  assert.equal(plan.omen, false);
  assert.equal(plan.omenTheme, null);

  s.turn = 6; // gap 2 → 预兆，提前选主题
  plan = e.planTurn(s, { rng: () => 0 });
  assert.equal(plan.omen, true);
  assert.equal(plan.omenTheme, '魔族入侵');
  assert.equal(plan.pendingEventTheme, '魔族入侵');
  assert.equal(plan.opening, false);

  // resolveTurn 把主题写入 state.pendingEventTheme
  const out = run(s, { action: '探听', proposal: proposal(), plan });
  assert.equal(out.state.pendingEventTheme, '魔族入侵');

  // 下一回合 gap=1：预兆 + 开事件，主题沿用已存的（即便 rng 变化也不重选）
  const s2 = out.state;
  const plan2 = e.planTurn(s2, { rng: () => 0.999999 });
  assert.equal(plan2.omen, true);
  assert.equal(plan2.opening, true);
  assert.equal(plan2.theme, '魔族入侵');
  assert.equal(plan2.omenTheme, '魔族入侵');

  const out2 = run(s2, {
    action: '迎上去', proposal: proposal(), plan: plan2,
    event: { title: '北境烽火', desc: '告急' },
  });
  assert.equal(out2.state.activeEvent.theme, '魔族入侵');
  assert.equal(out2.state.pendingEventTheme, null); // 开事件后消费掉
});

test('风声预兆：公开状态只有 omen 布尔，绝不暴露 pendingEventTheme 主题名', () => {
  const s = makeState();
  s.turn = 6;
  s.nextEventTurn = 8; // gap 2
  s.pendingEventTheme = '绝密预选主题'; // 哨兵值，确保该内部值不会出现在公开状态
  const pub = e.toPublicState(s);
  assert.equal(pub.omen, true);
  assert.equal('pendingEventTheme' in pub, false);
  assert.equal(JSON.stringify(pub).includes('绝密预选主题'), false);
  assert.equal('apex' in pub, false);

  assert.equal(e.toPublicState(makeState()).omen, false); // 距事件尚远
});
