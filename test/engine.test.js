'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');

// 可注入的确定性 rng（LCG），保证测试可复现。
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeState() {
  return e.createWorld(
    {
      id: 'w1',
      seed: '一句世界观',
      name: '旅人',
      appearance: '青衣',
      bible: {
        title: '测试世界',
        tone: '苍凉',
        rules: [],
        places: [],
        factions: [],
        npcs: [
          { name: '长老', role: '导师', desc: '' },
          { name: '铁匠', role: '', desc: '' },
        ],
        start: { place: '村口', situation: '' },
        eventThemes: ['魔族入侵', '宫廷政变', '天灾', '秘境开启', '商路断绝', '古神低语'],
      },
      apex: { title: '隐秘王冠', hint: '北方的钟声', condition: { attrs: { 声望: 30 } } },
    },
    { rng: () => 0.5, now: 1000 },
  );
}

function proposal(overrides) {
  return Object.assign(
    {
      narration: '你在晨雾中醒来，远处传来钟声，于是决定沿着古道继续前行。',
      state_diff: {},
      items_add: [],
      items_remove: [],
      npc_attitude: {},
      persona_tags: [],
      suggestions: ['继续前行', '询问长老', '查看行囊'],
    },
    overrides || {},
  );
}

function run(state, input, rng, now) {
  return e.resolveTurn(state, input, { rng: rng || (() => 0.5), now: now == null ? 1 : now });
}

function eventState(attrs) {
  const s = makeState();
  s.turn = 8;
  s.nextEventTurn = 99;
  s.activeEvent = { theme: '魔族入侵', title: '边境告急', desc: '描述', startedTurn: 8 };
  s.character.attrs = Object.assign({}, s.character.attrs, attrs || {});
  return s;
}

function settle(attrs, quality, rngValue, extra) {
  const s = eventState(attrs);
  const rng = () => rngValue;
  return run(
    s,
    Object.assign(
      {
        action: '迎战',
        proposal: proposal(),
        event_check: { attr: '体魄', response_quality: quality },
      },
      extra || {},
    ),
    rng,
  );
}

// ---------- 建世界 / 属性分配 ----------

test('createWorld: 初始属性各 6（5 + 平均 1）、persona 全 50、nextEventTurn 7~12', () => {
  const s = makeState();
  for (const a of e.ATTRS) assert.equal(s.character.attrs[a], 6, a);
  for (const d of e.PERSONA_DIMS) assert.equal(s.persona[d], 50, d);
  assert.equal(s.life, 1);
  assert.equal(s.turn, 0);
  assert.equal(s.character.alive, true);
  assert.equal(s.character.bornTurn, 0);
  assert.deepEqual(s.character.items, []); // makeState 的 bible.start 没给 items
  assert.deepEqual(s.npcAttitude, { 长老: 0, 铁匠: 0 }); // 按 bible.npcs 每人初始化 0
  assert.equal(s.activeEvent, null);
  assert.equal(s.highlightUntilTurn, 0);
  assert.deepEqual(s.chronicle, []);
  assert.deepEqual(s.recent, []);
  assert.equal(s.apex.achievedAt, null);
  assert.equal(s.apex.generation, 1);
  assert.equal(s.nextEventTurn, 10); // rng=0.5

  const lo = e.createWorld({ id: 'a', bible: {} }, { rng: () => 0 });
  const hi = e.createWorld({ id: 'b', bible: {} }, { rng: () => 0.999999 });
  assert.equal(lo.nextEventTurn, 7);
  assert.equal(hi.nextEventTurn, 12);
});

test('createWorld: bible.start.items 写入起始物品、非法项被过滤', () => {
  const s = e.createWorld(
    {
      id: 'w',
      bible: {
        npcs: [{ name: '守夜人' }, { name: '铸剑师' }],
        start: { place: '灰烬港', situation: '醒来', items: ['一封无字信', '旧铜灯', '半张海图', '多余的第四件', '1'.repeat(13), '一封无字信'] },
      },
    },
    { rng: () => 0 },
  );
  assert.deepEqual(s.character.items, ['一封无字信', '旧铜灯', '半张海图']);
  assert.deepEqual(s.npcAttitude, { 守夜人: 0, 铸剑师: 0 });
});

test('createWorld: 显式 npcAttitude 可覆盖初始化值', () => {
  const s = e.createWorld(
    { id: 'w', bible: { npcs: [{ name: '甲' }, { name: '乙' }] }, npcAttitude: { 甲: 3, 丙: 1 } },
    { rng: () => 0 },
  );
  assert.deepEqual(s.npcAttitude, { 甲: 3, 乙: 0, 丙: 1 });
});

test('allocateAttrs: 自定义分配合计 6、每项 ≤3；非法分配抛错', () => {
  const a = e.createWorld(
    { id: 'w', bible: {}, alloc: { 体魄: 3, 心智: 3 } },
    { rng: () => 0 },
  ).character.attrs;
  assert.equal(a['体魄'], 8);
  assert.equal(a['心智'], 8);
  assert.equal(a['魅力'], 5);
  assert.throws(() => e.allocateAttrs({ 体魄: 3 }), /合计 6 点/);
  assert.throws(() => e.allocateAttrs({ 未知: 6 }), /未知属性/);
  assert.throws(() => e.allocateAttrs({ 体魄: 4 }), /0~3 的整数/);
  assert.throws(() => e.allocateAttrs({ 体魄: 1.5 }), /0~3 的整数/);
  assert.throws(() => e.allocateAttrs('bad'), /格式错误/);
});

// ---------- validateProposal 各边界 ----------

test('validateProposal: 只接受白名单属性，非整数四舍五入', () => {
  const s = makeState();
  const v = e.validateProposal(s, proposal({ state_diff: { 体魄: 1.6, 魅力: 1.4, 气运: -1.6, 武力: 5 } }));
  assert.deepEqual(v.applied.state_diff, { 体魄: 2, 魅力: 1, 气运: -2 });
  assert.ok(v.rejected.some((r) => r.includes('武力')));
  assert.equal(v.error, null);
});

test('validateProposal: 单项夹 [-2,+2]', () => {
  const v = e.validateProposal(makeState(), proposal({ state_diff: { 体魄: 9, 心智: -9 } }));
  assert.equal(v.applied.state_diff['体魄'], 2);
  assert.equal(v.applied.state_diff['心智'], -2);
  assert.ok(v.rejected.some((r) => r.includes('超过 +2')));
  assert.ok(v.rejected.some((r) => r.includes('超过 -2')));
});

test('validateProposal: 正向变化总和 ≤ 3，超出按顺序截断', () => {
  const v = e.validateProposal(
    makeState(),
    proposal({ state_diff: { 体魄: 2, 心智: 2, 魅力: 2 } }),
  );
  assert.deepEqual(v.applied.state_diff, { 体魄: 2, 心智: 1 });
  assert.ok(v.rejected.some((r) => r.includes('正向变化总和超过 3')));
  assert.ok(v.rejected.some((r) => r.includes('正向变化总和已达 3')));
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
  assert.equal(e.planTurn(noThemes, { rng: () => 0 }).opening, false);

  const c = makeState();
  c.turn = 19;
  c.nextEventTurn = 999;
  assert.equal(e.planTurn(c, { rng: () => 0 }).needChapter, true);
  c.turn = 18;
  assert.equal(e.planTurn(c, { rng: () => 0 }).needChapter, false);
});

// ---------- 四档结算 ----------

test('事件结算：蜕变 >=24（该属性 +3、声望 +2）', () => {
  const out = settle({ 体魄: 20 }, 3, 0.9);
  assert.equal(out.result.settlement.tier, '蜕变');
  assert.equal(out.result.settlement.score, 38);
  assert.deepEqual(out.result.settlement.effects, { 体魄: 3, 声望: 2 });
  assert.equal(out.state.character.attrs['体魄'], 23);
  assert.equal(out.state.character.attrs['声望'], 8);
  assert.equal(out.state.activeEvent, null);
});

test('事件结算：险胜 >=16（+1）、代价 >=9（体魄 -2、资源 -2）', () => {
  const win = settle({ 体魄: 12 }, 1, 0);
  assert.equal(win.result.settlement.tier, '险胜');
  assert.equal(win.result.settlement.score, 16);
  assert.equal(win.state.character.attrs['体魄'], 13);

  const cost = settle({ 体魄: 9 }, 0, 0);
  assert.equal(cost.result.settlement.tier, '代价');
  assert.equal(cost.result.settlement.score, 9);
  assert.equal(cost.state.character.attrs['体魄'], 7);
  assert.equal(cost.state.character.attrs['资源'], 4);
});

test('事件结算：殒命 <9，触发死亡', () => {
  const out = settle({ 体魄: 5 }, 0, 0);
  assert.equal(out.result.settlement.tier, '殒命');
  assert.equal(out.result.settlement.score, 5);
  assert.ok(out.result.death);
  assert.equal(out.result.death.reason, '事件殒命');
  assert.equal(out.state.life, 2);
  assert.equal(out.state.awaitingRebirth, true);
});

test('事件结算：四档边界 24 / 23 / 16 / 9 / 8', () => {
  assert.equal(settle({ 体魄: 15 }, 2, 0.2).result.settlement.tier, '蜕变'); // 15+8+1=24
  assert.equal(settle({ 体魄: 15 }, 2, 0).result.settlement.tier, '险胜'); // 23
  assert.equal(settle({ 体魄: 12 }, 1, 0).result.settlement.tier, '险胜'); // 16
  assert.equal(settle({ 体魄: 9 }, 0, 0).result.settlement.tier, '代价'); // 9
  assert.equal(settle({ 体魄: 8 }, 0, 0).result.settlement.tier, '殒命'); // 8
});

test('事件结算：response_quality 夹 0~3、attr 非法回退、事件效果夹 [0,40]', () => {
  const q = settle({ 体魄: 5 }, 9, 0);
  assert.equal(q.result.settlement.response_quality, 3);
  assert.equal(q.result.settlement.tier, '险胜'); // 5+12+0=17

  const bad = settle({ 体魄: 5 }, 0, 0, {
    event_check: { attr: '武力', response_quality: 0 },
  });
  assert.equal(bad.result.settlement.attr, '体魄');
  assert.ok(bad.result.rejected.some((r) => r.includes('非白名单属性')));

  const capped = settle({ 体魄: 39 }, 3, 0.9);
  assert.equal(capped.state.character.attrs['体魄'], 40); // 39+3 夹到 40
});

test('事件回合不可回避：空行动仍按公式结算', () => {
  const out = settle({ 体魄: 16 }, 0, 0, { action: '' });
  assert.ok(out.result.settlement);
  assert.equal(out.result.settlement.score, 16); // 16 + 0*4 + 0
  assert.equal(out.result.settlement.tier, '险胜');
  assert.equal(out.result.settlement.response_quality, 0);
  assert.ok(out.result.rejected.some((r) => r.includes('不可回避')));
});

test('结算后 nextEventTurn = turn + 7~12', () => {
  const lo = settle({ 体魄: 12 }, 1, 0);
  assert.equal(lo.state.nextEventTurn - lo.state.turn, 7);
  const hi = settle({ 体魄: 12 }, 1, 0.999999);
  assert.equal(hi.state.nextEventTurn - hi.state.turn, 12);
});

// ---------- 死亡与重生 ----------

function killByBody() {
  const s = makeState();
  s.turn = 4;
  s.nextEventTurn = 999;
  s.character.attrs['体魄'] = 2;
  s.character.attrs['声望'] = 27;
  s.character.items = ['长剑', '药囊'];
  s.npcAttitude['长老'] = 7;
  return run(s, { action: '硬闯', proposal: proposal({ state_diff: { 体魄: -2 } }) });
}

test('死亡：体魄归零 → life+1、声望继承 20%、其他属性 5、物品清空、NPC 态度保留、编年史', () => {
  const out = killByBody();
  const ns = out.state;
  assert.ok(out.result.death);
  assert.equal(out.result.death.reason, '体魄归零');
  assert.equal(ns.life, 2);
  assert.equal(ns.character.attrs['声望'], 5); // floor(27 * 0.2)
  for (const a of e.ATTRS) {
    if (a !== '声望') assert.equal(ns.character.attrs[a], 5, a);
  }
  assert.deepEqual(ns.character.items, []);
  assert.equal(ns.npcAttitude['长老'], 7); // NPC 记得你
  assert.equal(ns.character.alive, false);
  assert.equal(ns.awaitingRebirth, true);
  assert.equal(ns.character.name, '');
  assert.equal(e.canTakeTurn(ns), false);
  assert.ok(ns.chronicle.some((c) => c.summary === '第 1 世终'));
});

test('重生：提交新名字/形象后恢复可行动，声望继承保留', () => {
  const dead = killByBody().state;
  const rb = e.rebirth(dead, { name: '新旅人', appearance: '红衣' });
  assert.equal(rb.error, null);
  assert.equal(rb.state.character.alive, true);
  assert.equal(rb.state.character.name, '新旅人');
  assert.equal(rb.state.character.appearance, '红衣');
  assert.equal(rb.state.character.bornTurn, dead.turn);
  assert.equal(rb.state.awaitingRebirth, false);
  assert.equal(rb.state.character.attrs['声望'], 5);
  assert.equal(rb.state.npcAttitude['长老'], 7);
  assert.equal(e.canTakeTurn(rb.state), true);

  const bad = e.rebirth(dead, { name: '', appearance: '红衣' });
  assert.match(bad.error, /重生需要提交新的名字与形象/);
  assert.equal(bad.state, dead);
});

test('重生：给 1 个符合世界观的基础物品', () => {
  const s = e.createWorld(
    { id: 'w', bible: { start: { items: ['旧铜灯', '半张海图'] } } },
    { rng: () => 0 },
  );
  s.awaitingRebirth = true;
  s.character.alive = false;
  const rb = e.rebirth(s, { name: '二世', appearance: '布衣' });
  assert.equal(rb.error, null);
  assert.deepEqual(rb.state.character.items, ['旧铜灯']);

  // 世界没给起始物品时兜底为 1 个基础物品
  const s2 = e.createWorld({ id: 'w2', bible: {} }, { rng: () => 0 });
  s2.awaitingRebirth = true;
  const rb2 = e.rebirth(s2, { name: '甲', appearance: '乙' });
  assert.deepEqual(rb2.state.character.items, ['旧行囊']);
});

test('体魄 > 0 不会误判死亡', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.character.attrs['体魄'] = 3;
  const out = run(s, { action: 'a', proposal: proposal({ state_diff: { 体魄: -2 } }) });
  assert.equal(out.result.death, null);
  assert.equal(out.state.character.attrs['体魄'], 1);
  assert.equal(out.state.life, 1);
});

// ---------- 隐晦顶点与不泄露 ----------

test('顶点检测：条件满足记 achievedAt 并高光 3 回合', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.character.attrs['声望'] = 30;
  const out = run(s, { action: 'a', proposal: proposal() }, () => 0.5, 777);
  assert.equal(out.result.apex.achieved, true);
  assert.equal(out.state.apex.achievedAt, 777);
  assert.equal(out.state.highlightUntilTurn, 4); // turn 1 + 3
  assert.equal(out.result.apex.needHighlight, true);
});

test('顶点检测：条件不满足不触发；支持 npc 条件', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  const out = run(s, { action: 'a', proposal: proposal() });
  assert.equal(out.result.apex.achieved, false);
  assert.equal(out.state.apex.achievedAt, null);
  assert.equal(out.state.highlightUntilTurn, 0);

  const s2 = makeState();
  s2.nextEventTurn = 999;
  s2.apex.condition = { attrs: {}, npc: { name: '长老', minAttitude: 5 } };
  s2.npcAttitude['长老'] = 5;
  assert.equal(e.apexConditionMet(s2), true);
  s2.npcAttitude['长老'] = 4;
  assert.equal(e.apexConditionMet(s2), false);
});

test('顶点：3 回合后换新 apex（generation+1），不通知玩家', () => {
  const s = makeState();
  s.turn = 4;
  s.nextEventTurn = 999;
  s.apex.achievedAt = 100;
  s.highlightUntilTurn = 4; // 第 1 回合达成

  const pending = run(s, { action: 'a', proposal: proposal() }, () => 0.5, 999);
  assert.equal(pending.result.needNewApex, true);
  assert.equal(pending.result.apex.needHighlight, false);
  assert.equal(pending.state.apex.generation, 1);

  const done = run(
    s,
    {
      action: 'a',
      proposal: proposal(),
      newApex: { title: '新顶点', hint: '新提示', condition: { attrs: { 声望: 40 } } },
    },
    () => 0.5,
    999,
  );
  assert.equal(done.result.apex.regenerated, true);
  assert.equal(done.result.needNewApex, false);
  assert.equal(done.state.apex.generation, 2);
  assert.equal(done.state.apex.title, '新顶点');
  assert.equal(done.state.apex.achievedAt, null);
  assert.equal(done.state.highlightUntilTurn, 0);
});

test('顶点不泄露：公开状态 / 回合响应里没有 apex 与 Key', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.LLM_API_KEY = 'sk-leak-test';
  const out = run(s, { action: 'a', proposal: proposal() });
  const pubState = e.toPublicState(out.state);
  const pubResult = e.toPublicTurnResult(out.result, out.state);

  assert.equal(Object.prototype.hasOwnProperty.call(pubState, 'apex'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pubState, 'LLM_API_KEY'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pubResult, 'apex'), false);
  const json = JSON.stringify({ pubState, pubResult });
  assert.equal(json.includes('隐秘王冠'), false);
  assert.equal(json.includes('北方的钟声'), false);
  assert.equal(json.includes('sk-leak-test'), false);
  assert.equal(json.includes('achievedAt'), false);
  // 内部状态仍保留 apex（供引擎写状态 / events.jsonl），只是接口不返回。
  assert.equal(JSON.stringify(out.state).includes('隐秘王冠'), true);
});

// ---------- 编年史 / recent ----------

test('编年史：turn % 20 == 0 压一章，≤300 字', () => {
  const s = makeState();
  s.turn = 19;
  s.nextEventTurn = 999;
  const plan = e.planTurn(s, { rng: () => 0.5 });
  assert.equal(plan.needChapter, true);

  const out = run(s, { action: 'a', proposal: proposal(), plan, chapterSummary: '章'.repeat(400) }, () => 0.5);
  assert.equal(out.state.chronicle.length, 1);
  assert.equal(out.state.chronicle[0].summary.length, 300);
  assert.equal(out.state.chronicle[0].fromTurn, 1);
  assert.equal(out.state.chronicle[0].toTurn, 20);
  assert.equal(out.result.needChapter, false);

  const without = run(s, { action: 'a', proposal: proposal(), plan }, () => 0.5);
  assert.equal(without.result.needChapter, true);
  assert.equal(without.state.chronicle.length, 0);
});

test('recent：只保留最近 6 条，narration 截 300 字', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  let cur = s;
  for (let i = 0; i < 8; i++) {
    cur = run(cur, { action: `a${i}`, proposal: proposal({ narration: '长'.repeat(400) }) }, () => 0.5, i).state;
  }
  assert.equal(cur.turn, 8);
  assert.equal(cur.recent.length, 6);
  assert.equal(cur.recent[0].turn, 3);
  assert.equal(cur.recent[5].turn, 8);
  assert.equal(cur.recent[5].narration.length, 300);
});

// ---------- 30 回合循环（不联网，含至少 2 次事件） ----------

test('纯函数循环跑 30 回合（含至少 2 次事件），状态可完整序列化', () => {
  let state = makeState();
  const rng = seeded(2026);
  let openings = 0;
  let settlements = 0;
  let chapters = 0;

  for (let i = 0; i < 30; i++) {
    const plan = e.planTurn(state, { rng });
    const input = {
      action: `第${i + 1}回合行动`,
      proposal: proposal({
        narration: `第${i + 1}回合，你在世界中继续前行，观察四周变化并做出选择。`,
      }),
      plan,
    };
    if (plan.needEvent) input.event = { title: `${plan.theme}·标题`, desc: '事件描述' };
    if (plan.needSettlement) input.event_check = { attr: '体魄', response_quality: 2 };
    if (plan.needChapter) input.chapterSummary = '这二十回合的编年史摘要';

    const out = e.resolveTurn(state, input, { rng, now: 1000 + i });
    assert.equal(out.invalid, false, `第 ${i + 1} 回合不应无效`);
    assert.equal(out.state.turn, i + 1);
    assert.equal(typeof JSON.stringify(out.result), 'string'); // 可写 events.jsonl
    assert.equal(typeof JSON.stringify(out.state), 'string'); // 可写 state.json
    if (out.result.event) openings++;
    if (out.result.settlement) settlements++;
    if (out.result.settlement || out.result.event) {
      // 事件相关字段不为空时结构完整
      assert.ok(out.result.rejected.length >= 0);
    }
    if (out.state.chronicle.length > chapters) chapters = out.state.chronicle.length;

    state = out.state;
    if (state.awaitingRebirth) {
      state = e.rebirth(state, { name: `第${state.life}世`, appearance: '布衣' }).state;
    }
  }

  assert.equal(state.turn, 30);
  assert.ok(openings >= 2, `事件开启次数应 ≥2，实际 ${openings}`);
  assert.ok(settlements >= 2, `事件结算次数应 ≥2，实际 ${settlements}`);
  assert.equal(state.recent.length, 6);
  assert.ok(chapters >= 1); // 第 20 回合压了一章
  assert.equal(e.canTakeTurn(state), true);
});
