'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const { seeded, makeState, proposal, run, eventState, settle, killByBody } = require('./helpers/engine-helpers.js');

// ---------- validateProposal 各边界 ----------

test('validateProposal: 白名单、非整数四舍五入、单项正向最多 +1', () => {
  const s = makeState();
  const v = e.validateProposal(s, proposal({ state_diff: { 体魄: 1.6, 魅力: 1.4, 气运: -1.6, 武力: 5 } }));
  // 体魄 1.6→2 再被单项 +1 截断为 1；魅力 1.4→1；气运 -1.6→-2；武力非白名单丢弃
  assert.deepEqual(v.applied.state_diff, { 体魄: 1, 魅力: 1, 气运: -2 });
  assert.ok(v.rejected.some((r) => r.includes('武力')));
  assert.equal(v.error, null);
});

test('validateProposal: 单项正向最多 +1、负向最多 -2', () => {
  const v = e.validateProposal(makeState(), proposal({ state_diff: { 体魄: 9, 心智: -9 } }));
  assert.equal(v.applied.state_diff['体魄'], 1);
  assert.equal(v.applied.state_diff['心智'], -2);
  assert.ok(v.rejected.some((r) => r.includes('超过 +1')));
  assert.ok(v.rejected.some((r) => r.includes('超过 -2')));
});

test('validateProposal: 普通回合正向总预算 2、单项 +1，超出按顺序截断', () => {
  const v = e.validateProposal(
    makeState(),
    proposal({ state_diff: { 体魄: 2, 心智: 2, 魅力: 2 } }),
  );
  // 每项先夹到 +1；预算 2 只允许两项，第三项被忽略
  assert.deepEqual(v.applied.state_diff, { 体魄: 1, 心智: 1 });
  assert.ok(v.rejected.some((r) => r.includes('单项变化超过 +1')));
  assert.ok(v.rejected.some((r) => r.includes('正向变化总和已达 2')));
});

test('validateProposal: 负向不限总和，但单项仍 ≤ 2', () => {
  const v = e.validateProposal(
    makeState(),
    proposal({ state_diff: { 体魄: -2, 心智: -2, 魅力: -2, 气运: -2 } }),
  );
  assert.deepEqual(v.applied.state_diff, { 体魄: -2, 心智: -2, 魅力: -2, 气运: -2 });
});

test('validateProposal: 属性下限 0、上限 40、到顶增长丢弃', () => {
  const s = makeState();
  s.character.attrs['体魄'] = 0;
  s.character.attrs['声望'] = 39;
  let v = e.validateProposal(s, proposal({ state_diff: { 体魄: -2, 声望: 2 } }));
  assert.equal(Object.prototype.hasOwnProperty.call(v.applied.state_diff, '体魄'), false);
  assert.equal(v.applied.state_diff['声望'], 1); // 39 -> 40 只 +1

  s.character.attrs['声望'] = 40;
  v = e.validateProposal(s, proposal({ state_diff: { 声望: 2 } }));
  assert.equal(Object.prototype.hasOwnProperty.call(v.applied.state_diff, '声望'), false);
  assert.ok(v.rejected.some((r) => r.includes('已达上限 40')));

  v = e.validateProposal(s, proposal({ state_diff: { 声望: -2 } }));
  assert.equal(v.applied.state_diff['声望'], -2); // 负向不受上限影响
});

test('validateProposal: items_add 每回合 ≤2、每个 ≤12 字、不重复已有', () => {
  const s = makeState();
  s.character.items = ['旧剑'];
  const v = e.validateProposal(
    s,
    proposal({
      items_add: ['新盾', '药草', '多余的第三件', '1'.repeat(13), '1'.repeat(12), '旧剑', null],
    }),
  );
  assert.deepEqual(v.applied.items_add, ['新盾', '药草']);
  assert.ok(v.rejected.some((r) => r.includes('最多新增 2 件')));
  const v2 = e.validateProposal(s, proposal({ items_add: ['1'.repeat(13), '1'.repeat(12)] }));
  assert.deepEqual(v2.applied.items_add, ['1'.repeat(12)]);
  assert.ok(v2.rejected.some((r) => r.includes('超过 12 字')));
});

test('validateProposal: items_remove 只能移除已拥有的', () => {
  const s = makeState();
  s.character.items = ['旧剑', '药囊'];
  const v = e.validateProposal(s, proposal({ items_remove: ['旧剑', '不存在的', '旧剑'] }));
  assert.deepEqual(v.applied.items_remove, ['旧剑']);
  assert.ok(v.rejected.some((r) => r.includes('并未拥有')));
});

test('validateProposal: npc_attitude 白名单、±2、夹 [-10,10]、叙事新人名', () => {
  const s = makeState();
  let v = e.validateProposal(s, proposal({ npc_attitude: { 长老: 2, 陌生人: 2 } }));
  assert.equal(v.applied.npc_attitude['长老'], 2);
  assert.equal(Object.prototype.hasOwnProperty.call(v.applied.npc_attitude, '陌生人'), false);
  assert.ok(v.rejected.some((r) => r.includes('陌生人')));

  v = e.validateProposal(s, proposal({ npc_attitude: { 长老: 9, 铁匠: -9 } }));
  assert.equal(v.applied.npc_attitude['长老'], 2);
  assert.equal(v.applied.npc_attitude['铁匠'], -2);

  s.npcAttitude['长老'] = 9;
  v = e.validateProposal(s, proposal({ npc_attitude: { 长老: 2 } }));
  assert.equal(v.applied.npc_attitude['长老'], 1); // 9 -> 10
  s.npcAttitude['长老'] = -9;
  v = e.validateProposal(s, proposal({ npc_attitude: { 长老: -2 } }));
  assert.equal(v.applied.npc_attitude['长老'], -1); // -9 -> -10

  v = e.validateProposal(
    makeState(),
    proposal({
      narration: '你遇见了旅伴阿岚，他递来一封旧信，字迹斑驳难辨。',
      npc_attitude: { 旅伴阿岚: 2 },
    }),
  );
  assert.equal(v.applied.npc_attitude['旅伴阿岚'], 2);
});

test('validateProposal: persona 命中 +1、非命中回归 0.2、夹 [0,100]、忽略未知维度', () => {
  const s = makeState();
  let v = e.validateProposal(s, proposal({ persona_tags: ['冒险', '审慎', '不存在'] }));
  assert.equal(v.applied.persona['冒险'], 51);
  assert.equal(v.applied.persona['审慎'], 51);
  assert.equal(v.applied.persona['共情'], 50);
  assert.deepEqual(v.applied.persona_tags, ['冒险', '审慎']);
  assert.ok(v.rejected.some((r) => r.includes('不存在')));

  s.persona['冒险'] = 51;
  v = e.validateProposal(s, proposal({ persona_tags: [] }));
  assert.equal(v.applied.persona['冒险'], 50.8);

  s.persona['冒险'] = 100;
  v = e.validateProposal(s, proposal({ persona_tags: ['冒险'] }));
  assert.equal(v.applied.persona['冒险'], 100);
  for (const d of e.PERSONA_DIMS) {
    assert.ok(v.applied.persona[d] >= 0 && v.applied.persona[d] <= 100);
  }
});

test('validateProposal: 叙事 10~1200 字，超出截断，过短无效', () => {
  const s = makeState();
  let v = e.validateProposal(s, proposal({ narration: '叙'.repeat(1201) }));
  assert.equal(v.applied.narration.length, 1200);
  assert.equal(v.error, null);
  assert.ok(v.rejected.some((r) => r.includes('已截断')));

  v = e.validateProposal(s, proposal({ narration: '短'.repeat(9) }));
  assert.match(v.error, /叙事过短/);
  assert.deepEqual(v.applied.state_diff, {});

  v = e.validateProposal(s, proposal({ narration: '十'.repeat(10) }));
  assert.equal(v.error, null);
  assert.equal(v.applied.narration.length, 10);

  v = e.validateProposal(s, proposal({ narration: null }));
  assert.match(v.error, /叙事过短/);
});

test('resolveTurn: 叙事过短不推进 turn、状态原样退回', () => {
  const s = makeState();
  const before = JSON.stringify(s);
  const out = run(s, { action: 'x', proposal: proposal({ narration: '太短' }) });
  assert.equal(out.invalid, true);
  assert.match(out.error, /叙事过短/);
  assert.equal(out.result, null);
  assert.equal(out.state, s);
  assert.equal(JSON.stringify(s), before);
});

test('resolveTurn: 不修改入参（纯函数）', () => {
  const s = makeState();
  const before = JSON.stringify(s);
  run(s, { action: 'a', proposal: proposal({ state_diff: { 体魄: 1 }, items_add: ['剑'] }) });
  assert.equal(JSON.stringify(s), before);
});

test('items / npc / persona 实际写入状态', () => {
  const s = makeState();
  s.character.items = ['旧剑'];
  const out = run(s, {
    action: 'a',
    proposal: proposal({
      narration: '你遇见了旅伴阿岚，他递来一封旧信，字迹斑驳难辨。',
      items_add: ['新盾', '药草'],
      items_remove: ['旧剑'],
      npc_attitude: { 旅伴阿岚: 2 },
      persona_tags: ['冒险'],
    }),
  });
  assert.deepEqual(out.state.character.items, ['新盾', '药草']);
  assert.equal(out.state.npcAttitude['旅伴阿岚'], 2); // 新 NPC 自动加入
  assert.equal(out.state.persona['冒险'], 51);
  assert.equal(out.state.turn, 1);
});

// ---------- 收益递减 ----------

test('收益递减：低值属性 +1 生效，高值属性 +1 被静默丢弃', () => {
  const s = makeState(); // 初始 6 → p=(30-6)/25=0.96
  const low = e.resolveTurn(
    s,
    { action: 'a', proposal: proposal({ state_diff: { 心智: 1 } }) },
    { rng: () => 0, now: 1 },
  );
  assert.equal(low.result.applied.state_diff['心智'], 1);
  assert.equal(low.state.character.attrs['心智'], 7);

  const s2 = makeState();
  s2.character.attrs['心智'] = 35; // p=clamp((30-35)/25,0.1,1)=0.1
  const high = e.resolveTurn(
    s2,
    { action: 'a', proposal: proposal({ state_diff: { 心智: 1 } }) },
    { rng: () => 0.999999, now: 1 },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(high.result.applied.state_diff, '心智'), false);
  assert.equal(high.state.character.attrs['心智'], 35); // 静默丢弃
});

test('收益递减：p=clamp((30-v)/25, 0.1, 1) 的上下界', () => {
  const s = makeState();
  s.character.attrs['心智'] = 5; // p=1：rng 接近 1 仍生效
  const upper = e.resolveTurn(
    s, { action: 'a', proposal: proposal({ state_diff: { 心智: 1 } }) },
    { rng: () => 0.999999, now: 1 },
  );
  assert.equal(upper.result.applied.state_diff['心智'], 1);

  s.character.attrs['心智'] = 30; // p=0.1（下界）
  const dropped = e.resolveTurn(
    s, { action: 'a', proposal: proposal({ state_diff: { 心智: 1 } }) },
    { rng: () => 0.5, now: 1 },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(dropped.result.applied.state_diff, '心智'), false);
  const lucky = e.resolveTurn(
    s, { action: 'a', proposal: proposal({ state_diff: { 心智: 1 } }) },
    { rng: () => 0.05, now: 1 },
  );
  assert.equal(lucky.result.applied.state_diff['心智'], 1);
});

test('收益递减：丢弃记入 rejected 作内部原因，公开回合结果里被过滤（不给玩家看）', () => {
  const s = makeState();
  s.character.attrs['心智'] = 35;
  const out = e.resolveTurn(
    s, { action: 'a', proposal: proposal({ state_diff: { 心智: 1 } }) },
    { rng: () => 0.999999, now: 1 },
  );
  const reason = out.result.rejected.find((r) => r.includes('收益递减'));
  assert.ok(reason, '内部 rejected 应记录收益递减');
  assert.equal(e.isInternalReject(reason), true);
  const pub = e.toPublicTurnResult(out.result, out.state);
  assert.equal(pub.rejected.some((r) => r.includes('收益递减')), false);
});

test('事件结算绕过普通回合限制：蜕变 +3 / 声望 +2 不受预算与收益递减影响', () => {
  // settle 的结算 rng=0.9；事件效果直接套用，体魄 20→23、声望 6→8。
  const out = settle({ 体魄: 20 }, 3, 0.9);
  assert.equal(out.state.character.attrs['体魄'], 23);
  assert.equal(out.state.character.attrs['声望'], 8);
});

