'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const { seeded, makeState, proposal, run, eventState, settle, killByBody } = require('./helpers/engine-helpers.js');

// ---------- 死亡与重生 ----------


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

test('新字段不泄露 apex：公开状态/回合结果带 facts/marks/threads 时仍无 apex 与 Key', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.LLM_API_KEY = 'sk-leak-test';
  s.facts = [{ turn: 1, text: '城门每日戌时落锁' }];
  s.threads = ['灰呢帽的报纸数字'];
  s.fadedThreads = ['已淡去的旧线索'];
  s.character.marks = ['被76号盯上'];
  const out = run(s, { action: 'a', proposal: proposal() });
  const pubState = e.toPublicState(out.state);
  const pubResult = e.toPublicTurnResult(out.result, out.state);
  // 新字段仍对玩家可见
  assert.equal(pubState.facts[0].text, '城门每日戌时落锁');
  assert.deepEqual(pubState.character.marks, ['被76号盯上']);
  assert.deepEqual(pubState.threads, ['灰呢帽的报纸数字']);
  assert.deepEqual(pubState.fadedThreads, ['已淡去的旧线索']);
  // apex / Key 绝不因新增字段而泄露
  const json = JSON.stringify({ pubState, pubResult });
  assert.equal(json.includes('隐秘王冠'), false);
  assert.equal(json.includes('北方的钟声'), false);
  assert.equal(json.includes('sk-leak-test'), false);
  assert.equal(json.includes('achievedAt'), false);
  assert.equal(/"apex"\s*:/.test(json), false);
  assert.equal(JSON.stringify(out.state).includes('隐秘王冠'), true); // 内部仍保留
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

// ---------- 前世墓志铭（pastLives / epitaph） ----------

test('前世墓志铭：createWorld 初始化 pastLives = []，老存档补默认', () => {
  assert.deepEqual(makeState().pastLives, []);
  assert.deepEqual(e.normalizeState({ turn: 2 }).pastLives, []);
});

test('前世墓志铭：applyEpitaph 追加记录、强制 ≤80 字与字段形状、不改入参', () => {
  const s = makeState();
  const before = JSON.stringify(s);
  const ns = e.applyEpitaph(s, {
    life: 1, name: '初代', epitaph: '长'.repeat(120), turns: 8, cause: '体魄归零',
  });
  assert.equal(ns.pastLives.length, 1);
  assert.equal(ns.pastLives[0].epitaph.length, 80);
  assert.equal(ns.pastLives[0].life, 1);
  assert.equal(ns.pastLives[0].name, '初代');
  assert.equal(ns.pastLives[0].turns, 8);
  assert.equal(ns.pastLives[0].cause, '体魄归零');
  assert.deepEqual(Object.keys(ns.pastLives[0]).sort(),
    ['cause', 'epitaph', 'life', 'name', 'turns']);
  assert.equal(JSON.stringify(s), before); // 纯函数，不改入参

  const ns2 = e.applyEpitaph(ns, { life: 2, name: '二世', epitaph: '短', turns: 3, cause: '事件殒命' });
  assert.equal(ns2.pastLives.length, 2); // 多世累积
});

// ---------- 濒死可感知（danger） ----------

test('濒死可感知：computeDanger 在体魄 ≤ 2 为真，>2 / 缺字段 / 已死亡为假', () => {
  assert.equal(e.DANGER_THRESHOLD, 2);
  const s = makeState();
  s.character.attrs['体魄'] = 3;
  assert.equal(e.computeDanger(s), false);
  s.character.attrs['体魄'] = 2;
  assert.equal(e.computeDanger(s), true);
  s.character.attrs['体魄'] = 1;
  assert.equal(e.computeDanger(s), true);
  s.character.attrs['体魄'] = 0;
  assert.equal(e.computeDanger(s), true);
  s.character.alive = false;
  assert.equal(e.computeDanger(s), false);
  assert.equal(e.computeDanger({}), false);
  assert.equal(e.computeDanger({ character: { alive: true, attrs: {} } }), false);
});

test('濒死可感知：toPublicState / toPublicTurnResult 带 danger 布尔，且不泄露 apex', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.character.attrs['体魄'] = 2;
  const pub = e.toPublicState(s);
  assert.equal(pub.danger, true);
  assert.equal('apex' in pub, false);
  assert.equal('twist' in pub, false);
  assert.equal(e.toPublicState(makeState()).danger, false);
  assert.equal(e.toPublicState(e.normalizeState({ turn: 2 })).danger, false); // 老存档缺字段安全

  const hurt = makeState();
  hurt.nextEventTurn = 999;
  hurt.character.attrs['体魄'] = 4;
  const out = e.resolveTurn(
    hurt,
    { action: '硬闯', proposal: proposal({ state_diff: { 体魄: -2 } }) },
    { rng: () => 0, now: 1 },
  );
  assert.equal(out.state.character.attrs['体魄'], 2);
  const pubResult = e.toPublicTurnResult(out.result, out.state);
  assert.equal(pubResult.state.danger, true);
  assert.equal(pubResult.state.character.attrs['体魄'], 2);
  assert.equal(/"apex"\s*:/.test(JSON.stringify(pubResult)), false);
});

// ---------- 新一世开场（rebirthOpening / recent） ----------

test('新一世开场：createWorld / normalizeState 初始化与补默认 rebirthOpening', () => {
  assert.equal(makeState().rebirthOpening, '');
  assert.equal(e.normalizeState({ turn: 2 }).rebirthOpening, '');
  const kept = e.normalizeState({ turn: 2, rebirthOpening: '旧开场' });
  assert.equal(kept.rebirthOpening, '旧开场'); // 合法值保留
});

test('新一世开场：applyRebirthOpening 写入该世第一条叙事，recent 截 300 字、最多 6 条、纯函数', () => {
  const s = makeState();
  s.turn = 7;
  s.life = 2;
  s.recent = [{ turn: 6, action: '旧', narration: '上一世末尾' }];
  const before = JSON.stringify(s);
  const text = '距上一世已过三年，世界因你改了规矩，有人隐约记得你。'.repeat(20);
  const ns = e.applyRebirthOpening(s, text);
  assert.equal(ns.rebirthOpening, text);
  assert.equal(ns.recent.length, 2);
  assert.equal(ns.recent[1].turn, 7);
  assert.equal(ns.recent[1].action, '');
  assert.equal(ns.recent[1].rebirthOpening, true);
  assert.ok(ns.recent[1].narration.length <= 300, 'recent 里截 300 字');
  assert.equal(JSON.stringify(s), before, '纯函数，不改入参');

  // 空开场不动状态
  assert.deepEqual(e.applyRebirthOpening(s, ''), s);

  // recent 已有 6 条时，开场成为最新一条，仍只保留 6 条
  const full = makeState();
  full.recent = Array.from({ length: 6 }, (_, i) => ({ turn: i + 1, action: 'a', narration: 'n' }));
  const capped = e.applyRebirthOpening(full, '开场内容');
  assert.equal(capped.recent.length, 6);
  assert.equal(capped.recent[5].rebirthOpening, true);
});

