'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const { seeded, makeState, proposal, run, eventState, settle, killByBody } = require('./helpers/engine-helpers.js');


test('老存档：normalizeState 补齐新字段默认值，不报错也不改入参', () => {
  const old = {
    id: 'w', turn: 3, nextEventTurn: 9, activeEvent: null,
    bible: { title: '旧世界' }, character: { alive: true, attrs: {} },
  };
  const before = JSON.stringify(old);
  const norm = e.normalizeState(old);
  assert.equal(norm.pendingEventTheme, null);
  assert.deepEqual(norm.rumors, []);
  assert.deepEqual(norm.facts, []);
  assert.deepEqual(norm.threads, []);
  assert.deepEqual(norm.fadedThreads, []);
  assert.deepEqual(norm.character.marks, []);
  assert.equal(JSON.stringify(old), before); // 不改入参
  assert.equal(typeof e.toPublicState(norm).omen, 'boolean');
});

// ---------- 导演机制（sceneStreak / twist / lastTwistTurn） ----------

test('导演机制：createWorld 初始化 sceneStreak/lastTwistTurn/nextTwistTurn/oversteps', () => {
  const s = makeState();
  assert.equal(s.sceneStreak, 0);
  assert.equal(s.lastTwistTurn, 0);
  assert.equal(s.oversteps, 0);
  assert.ok(s.nextTwistTurn >= e.TWIST_GAP_MIN
    && s.nextTwistTurn <= e.TWIST_GAP_MIN + e.TWIST_GAP_SPAN - 1); // 9~14
  assert.deepEqual(s.facts, []); // makeState 没给 start.facts
  assert.equal(e.TWISTS.length, 7);
  for (const t of ['闯入者', '意外发现', '背叛', '环境突变', '旧识出现', '时机错过', '交易反转']) {
    assert.ok(e.TWISTS.includes(t), `转折列表应含「${t}」`);
  }
});

test('导演机制：planTurn 在 sceneStreak>=4 时用 rng 选一个转折', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.nextTwistTurn = 999; // 关闭时间型触发，只测绕圈触发
  s.sceneStreak = e.TWIST_STREAK_THRESHOLD;
  const plan = e.planTurn(s, { rng: () => 0 });
  assert.equal(plan.twist, e.TWISTS[0]);
  assert.ok(e.TWISTS.includes(plan.twist));
  assert.equal(plan.nextTwistTurn, plan.nextTurn + e.TWIST_GAP_MIN); // rng=0 → 9
});

test('导演机制：距上次转折 9~14 回合（随机）触发，且只在非事件回合', () => {
  const s = makeState();
  s.turn = 8;
  s.nextEventTurn = 999;
  s.sceneStreak = 0;
  s.nextTwistTurn = 9; // nextTurn=9 到点
  const plan = e.planTurn(s, { rng: () => 0 });
  assert.ok(plan.twist, '到点且非事件回合应触发转折');
  assert.ok(e.TWISTS.includes(plan.twist));
  const gap = plan.nextTwistTurn - plan.nextTurn;
  assert.ok(gap >= 9 && gap <= 14, `重排间隔应在 9~14，实际 ${gap}`);

  // 若该回合恰为事件开启回合，则不叠加转折
  const ev = makeState();
  ev.turn = 8;
  ev.nextEventTurn = 9; // nextTurn=9 → opening
  ev.sceneStreak = 0;
  ev.nextTwistTurn = 9;
  const evPlan = e.planTurn(ev, { rng: () => 0 });
  assert.equal(evPlan.opening, true);
  assert.equal(evPlan.twist, null, '事件回合不注入转折');
});

test('导演机制：随机间隔的上下界 9 / 14', () => {
  const mk = () => {
    const s = makeState();
    s.turn = 8; s.nextEventTurn = 999; s.sceneStreak = 0; s.nextTwistTurn = 9;
    return s;
  };
  const lo = e.planTurn(mk(), { rng: () => 0 });
  assert.equal(lo.nextTwistTurn - lo.nextTurn, 9);
  const hi = e.planTurn(mk(), { rng: () => 0.999999 });
  assert.equal(hi.nextTwistTurn - hi.nextTurn, 14);
});

test('导演机制：sceneStreak 按「地点没变且无 new_facts/threads 变化」累计，否则清零', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  s.nextTwistTurn = 999; // 关闭时间型触发，隔离绕圈累计
  s.bible.places = [{ name: '北岭' }];
  // 连续两个原地打转回合 → 1、2
  s = run(s, { action: 'a', proposal: proposal() }).state;
  assert.equal(s.sceneStreak, 1);
  s = run(s, { action: 'b', proposal: proposal() }).state;
  assert.equal(s.sceneStreak, 2);
  // 新事实 → 清零
  s = run(s, { action: 'c', proposal: proposal({ new_facts: ['城门戌时落锁'] }) }).state;
  assert.equal(s.sceneStreak, 0);
  s = run(s, { action: 'd', proposal: proposal() }).state;
  assert.equal(s.sceneStreak, 1);
  // threads 变化 → 清零
  s = run(s, { action: 'e', proposal: proposal({ threads_add: ['缺角的铜片'] }) }).state;
  assert.equal(s.sceneStreak, 0);
  s = run(s, { action: 'f', proposal: proposal() }).state;
  assert.equal(s.sceneStreak, 1);
  // 地点变化 → 清零
  s = run(s, { action: 'g', proposal: proposal({ move_to: '北岭' }) }).state;
  assert.equal(s.sceneStreak, 0);
  assert.equal(s.location, '北岭');
});

test('导演机制：转折回合清零 sceneStreak、记录 lastTwistTurn、重排 nextTwistTurn；twist 不进公开视图', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  s.sceneStreak = e.TWIST_STREAK_THRESHOLD;
  const plan = e.planTurn(s, { rng: () => 0 });
  const out = run(s, { action: 'a', proposal: proposal(), plan }, () => 0.5, 777);
  assert.equal(out.state.sceneStreak, 0);
  assert.equal(out.state.lastTwistTurn, plan.nextTurn);
  assert.equal(out.state.nextTwistTurn, plan.nextTwistTurn);
  assert.equal(out.result.twist, plan.twist);
  assert.ok(e.TWISTS.includes(out.result.twist));
  // 转折词/字段绝不进公开状态与公开回合结果，apex 仍不泄露
  const pubState = e.toPublicState(out.state);
  const pubResult = e.toPublicTurnResult(out.result, out.state);
  assert.equal('twist' in pubState, false);
  assert.equal('twist' in pubResult, false);
  assert.equal(JSON.stringify({ pubState, pubResult }).includes(plan.twist), false);
  assert.equal(JSON.stringify(pubResult).includes('隐秘王冠'), false);
  assert.equal(JSON.stringify(pubResult).includes('北方的钟声'), false);

  // 即便有人误把 twist 写进 state，公开状态也应抹掉
  const leaky = makeState();
  leaky.twist = '闯入者';
  assert.equal('twist' in e.toPublicState(leaky), false);
});

// ---------- 越界升级（overstep / oversteps） ----------

test('越界升级：overstep:true 累计 oversteps，false / 缺省不变', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  s.nextTwistTurn = 999;
  s = run(s, { action: 'a', proposal: proposal({ overstep: true }) }).state;
  assert.equal(s.oversteps, 1);
  s = run(s, { action: 'b', proposal: proposal({ overstep: false }) }).state;
  assert.equal(s.oversteps, 1);
  s = run(s, { action: 'c', proposal: proposal() }).state;
  assert.equal(s.oversteps, 1);
  s = run(s, { action: 'd', proposal: proposal({ overstep: true }) }).state;
  assert.equal(s.oversteps, 2);
  // 老存档 / 缺字段时按 0 起算
  assert.equal(e.normalizeState({ turn: 2 }).oversteps, 0);
});

// ---------- 老存档：voice 语言指纹补默认 ----------

test('老存档：normalizeState 给缺 voice 的 NPC 补彼此不同且 ≤20 字的默认口吻（幂等、不改入参）', () => {
  const old = {
    turn: 4,
    bible: { npcs: [
      { name: '甲', role: '', desc: '' },
      { name: '乙', role: '', desc: '' },
      { name: '丙', role: '', desc: '', voice: '只报数目，不多说' },
    ] },
    character: { alive: true, attrs: { 体魄: 6 } },
  };
  const before = JSON.stringify(old);
  const norm = e.normalizeState(old);
  const voices = norm.bible.npcs.map((n) => n.voice);
  assert.ok(voices.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 20));
  assert.equal(new Set(voices).size, voices.length, '补出的 voice 必须彼此不同');
  assert.equal(norm.bible.npcs[2].voice, '只报数目，不多说', '已有 voice 原样保留');
  assert.equal(JSON.stringify(old), before, '纯函数，不改入参');
  assert.deepEqual(e.normalizeState(norm).bible.npcs.map((n) => n.voice), voices, '幂等');

  // NPC 多于默认口吻数量时仍彼此不同，且都 ≤20 字
  const many = {
    turn: 1,
    bible: { npcs: Array.from({ length: 9 }, (_, i) => ({ name: 'N' + i })) },
    character: { alive: true, attrs: {} },
  };
  const manyVoices = e.normalizeState(many).bible.npcs.map((n) => n.voice);
  assert.equal(new Set(manyVoices).size, manyVoices.length);
  assert.ok(manyVoices.every((v) => v.length <= 20));
  assert.ok(e.DEFAULT_VOICES.every((v) => v.length <= 20));
});

// ---------- 老存档：导演 / 越界字段补默认 ----------

test('老存档：normalizeState 补 sceneStreak/lastTwistTurn/nextTwistTurn/oversteps 默认值', () => {
  const old = { turn: 5, bible: {}, character: { alive: true, attrs: {} } };
  const before = JSON.stringify(old);
  const norm = e.normalizeState(old);
  assert.equal(norm.sceneStreak, 0);
  assert.equal(norm.lastTwistTurn, 0);
  assert.equal(norm.oversteps, 0);
  assert.ok(Number.isInteger(norm.nextTwistTurn)
    && norm.nextTwistTurn >= 5 + e.TWIST_GAP_MIN); // 给一个合理间隔，不立刻触发
  assert.equal(JSON.stringify(old), before); // 不改入参
  // 合法值保留
  const kept = e.normalizeState({
    turn: 2, sceneStreak: 3, lastTwistTurn: 7, nextTwistTurn: 20, oversteps: 4,
  });
  assert.equal(kept.sceneStreak, 3);
  assert.equal(kept.lastTwistTurn, 7);
  assert.equal(kept.nextTwistTurn, 20);
  assert.equal(kept.oversteps, 4);
});
