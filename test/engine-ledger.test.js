'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const { seeded, makeState, proposal, run, eventState, settle, killByBody } = require('./helpers/engine-helpers.js');

// ---------- 坊间传闻（rumor / rumors） ----------

test('坊间传闻：normalizeRumor 截 40 字、忽略非字符串/空串', () => {
  assert.equal(e.normalizeRumor('  巷口有人说书  '), '巷口有人说书');
  assert.equal(e.normalizeRumor('长'.repeat(55)).length, 40);
  assert.equal(e.normalizeRumor(''), '');
  assert.equal(e.normalizeRumor('   '), '');
  assert.equal(e.normalizeRumor(null), '');
  assert.equal(e.normalizeRumor(123), '');
});

test('坊间传闻：resolveTurn 校验后写入 rumors（含 turn），只留最近 10 条', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  for (let i = 1; i <= 12; i++) {
    s = run(s, {
      action: 'a',
      proposal: proposal({ rumor: '第' + i + '条传闻，' + '长'.repeat(50) }),
    }, () => 0.5, i).state;
  }
  assert.equal(s.rumors.length, 10);
  assert.equal(s.rumors[0].turn, 3);   // 最早留下的第 3 回合
  assert.equal(s.rumors[9].turn, 12);  // 最新在第 12 回合
  assert.equal(s.rumors[9].text.length, 40); // 超长截断
  assert.ok(s.rumors.every((r) => typeof r.turn === 'number' && typeof r.text === 'string'));
});

test('坊间传闻：无 rumor 回合不写 rumors；老存档补默认', () => {
  const out = run(makeState(), { action: 'a', proposal: proposal() });
  assert.deepEqual(out.state.rumors, []);
  assert.deepEqual(e.normalizeState({ turn: 2 }).rumors, []);
});

// ---------- 地点与时间（location / clock / move_to / time_passes） ----------

test('地点与时间：createWorld 初始 location = bible.start.place、clock = 第1日清晨', () => {
  const s = makeState(); // bible.start.place = '村口'
  assert.equal(s.location, '村口');
  assert.deepEqual(s.clock, { day: 1, period: '清晨' });
});

test('地点与时间：advanceClock 按 清晨→午后→黄昏→深夜→次日清晨 滚动', () => {
  let c = { day: 1, period: '清晨' };
  c = e.advanceClock(c, 1); assert.deepEqual(c, { day: 1, period: '午后' });
  c = e.advanceClock(c, 1); assert.deepEqual(c, { day: 1, period: '黄昏' });
  c = e.advanceClock(c, 1); assert.deepEqual(c, { day: 1, period: '深夜' });
  c = e.advanceClock(c, 1); assert.deepEqual(c, { day: 2, period: '清晨' }); // 深夜后 day+1
  assert.deepEqual(e.advanceClock({ day: 3, period: '黄昏' }, 2), { day: 4, period: '清晨' });
  assert.deepEqual(e.advanceClock({ day: 1, period: '午后' }, 0), { day: 1, period: '午后' });
  assert.deepEqual(e.advanceClock(null, 1), { day: 1, period: '午后' }); // 非法 clock 兜底
});

test('地点与时间：normalizeTimePasses 夹 0~2、缺省默认 1', () => {
  assert.equal(e.normalizeTimePasses(undefined), 1);
  assert.equal(e.normalizeTimePasses(null), 1);
  assert.equal(e.normalizeTimePasses('abc'), 1);
  assert.equal(e.normalizeTimePasses(0), 0);
  assert.equal(e.normalizeTimePasses(2), 2);
  assert.equal(e.normalizeTimePasses(9), 2);
  assert.equal(e.normalizeTimePasses(-3), 0);
  assert.equal(e.normalizeTimePasses(1.6), 2);
});

test('地点与时间：normalizeMoveTo 只接受设定地点或叙事新地点、≤12 字', () => {
  const s = makeState();
  s.bible.places = [{ name: '北岭' }, { name: '旧渡口' }];
  assert.equal(e.normalizeMoveTo(s, '北岭', '任意叙事'), '北岭'); // 设定地点
  assert.equal(e.normalizeMoveTo(s, '旧渡口', '任意叙事'), '旧渡口');
  assert.equal(e.normalizeMoveTo(s, '雾中石桥', '你走上雾中石桥，脚下吱呀作响'), '雾中石桥'); // 叙事新地点
  assert.equal(e.normalizeMoveTo(s, '雾中石桥', '你留在原地'), ''); // 未在设定/叙事出现
  assert.equal(e.normalizeMoveTo(s, '超'.repeat(13), '叙事'), ''); // >12 字
  assert.equal(e.normalizeMoveTo(s, 123, '叙事'), ''); // 非字符串
});

test('地点与时间：resolveTurn 校验后写入 location / clock', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.bible.places = [{ name: '码头' }];
  s.location = '村口';
  s.clock = { day: 1, period: '黄昏' };

  const o1 = run(s, {
    action: '出发',
    proposal: proposal({ move_to: '码头', time_passes: 2 }),
  });
  assert.equal(o1.state.location, '码头');
  assert.deepEqual(o1.state.clock, { day: 2, period: '清晨' }); // 黄昏→深夜→次日清晨

  const o2 = run(o1.state, {
    action: '张望',
    proposal: proposal({ move_to: '天宫禁地', time_passes: undefined }),
  });
  assert.equal(o2.state.location, '码头'); // 非法移动被忽略，原地不动
  assert.deepEqual(o2.state.clock, { day: 2, period: '午后' }); // 缺省推进 1
});

test('地点与时间：老存档补 location / clock 默认值', () => {
  const norm = e.normalizeState({ turn: 4, bible: { start: { place: '古城' } } });
  assert.equal(norm.location, '古城');
  assert.deepEqual(norm.clock, { day: 1, period: '清晨' });
  const norm2 = e.normalizeState({ turn: 4, location: '某地', clock: { day: 9, period: '深夜' } });
  assert.deepEqual(norm2.clock, { day: 9, period: '深夜' }); // 合法值保留
});

// ---------- 事实账本（new_facts / facts） ----------

test('事实账本：createWorld 初始化 facts=[]，老存档补默认', () => {
  assert.deepEqual(makeState().facts, []);
  assert.deepEqual(e.normalizeState({ turn: 2 }).facts, []);
  const old = {
    turn: 3, bible: { title: '旧世界' }, character: { alive: true, attrs: {} },
  };
  assert.deepEqual(e.normalizeState(old).facts, []);
});

test('事实账本：normalizeFact 截 30 字、忽略非字符串/空串', () => {
  assert.equal(e.normalizeFact('  城门每日戌时落锁  '), '城门每日戌时落锁');
  assert.equal(e.normalizeFact('长'.repeat(45)).length, 30);
  assert.equal(e.normalizeFact(''), '');
  assert.equal(e.normalizeFact('   '), '');
  assert.equal(e.normalizeFact(null), '');
  assert.equal(e.normalizeFact(123), '');
});

test('事实账本：resolveTurn 校验后写入（每回合 0~2 条、≤30 字、含 turn）', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  const out = run(s, {
    action: 'a',
    proposal: proposal({
      new_facts: ['城门每日戌时落锁', '顾秋白是76号的人', '多余的第三条', '长'.repeat(50), '', 123],
    }),
  }, () => 0.5, 1);
  assert.equal(out.state.facts.length, 2);
  assert.deepEqual(out.state.facts[0], { turn: 1, text: '城门每日戌时落锁' });
  assert.deepEqual(out.state.facts[1], { turn: 1, text: '顾秋白是76号的人' });
  assert.ok(out.state.facts.every((f) => f.text.length <= e.FACT_TEXT_MAX));
});

test('事实账本：同一事实不重复入库、无 new_facts 不写、不修改入参（纯函数）', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  const before = JSON.stringify(s);
  let cur = run(s, { action: 'a', proposal: proposal({ new_facts: ['城门每日戌时落锁'] }) }).state;
  cur = run(cur, {
    action: 'b', proposal: proposal({ new_facts: ['城门每日戌时落锁', '顾秋白是76号的人'] }),
  }).state;
  assert.equal(cur.facts.length, 2);
  const empty = run(makeState(), { action: 'a', proposal: proposal() });
  assert.deepEqual(empty.state.facts, []);
  assert.equal(JSON.stringify(s), before);
});

test('事实账本：最多 40 条，超出丢最旧', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  for (let i = 1; i <= 45; i++) {
    s = run(s, {
      action: 'a', proposal: proposal({ new_facts: ['事实' + i] }),
    }, () => 0.5, i).state;
  }
  assert.equal(s.facts.length, e.FACTS_MAX);
  assert.equal(s.facts[0].text, '事实6');    // 45 条丢掉最旧的 5 条
  assert.equal(s.facts[39].text, '事实45');
  assert.ok(s.facts.every((f) => typeof f.turn === 'number' && typeof f.text === 'string'));
});

// ---------- 印记（marks_add / marks_remove / character.marks） ----------

test('印记：createWorld 初始化 character.marks=[]，老存档补默认', () => {
  assert.deepEqual(makeState().character.marks, []);
  const old = { turn: 2, character: { alive: true, attrs: {} } };
  assert.deepEqual(e.normalizeState(old).character.marks, []);
});

test('印记：normalizeMark 截 16 字、忽略非字符串/空串', () => {
  assert.equal(e.normalizeMark('  被76号盯上  '), '被76号盯上');
  assert.equal(e.normalizeMark('长'.repeat(25)).length, 16);
  assert.equal(e.normalizeMark(''), '');
  assert.equal(e.normalizeMark(null), '');
  assert.equal(e.normalizeMark(7), '');
});

test('印记：marks_add 校验后写入（≤16 字、去重、忽略非法）', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  const before = JSON.stringify(s);
  const out = run(s, {
    action: 'a',
    proposal: proposal({
      marks_add: ['被76号盯上', '欠白玫一个人情', '长'.repeat(25), '', 123, '被76号盯上'],
    }),
  });
  assert.deepEqual(out.state.character.marks, ['被76号盯上', '欠白玫一个人情', '长'.repeat(16)]);
  assert.ok(out.state.character.marks.every((m) => m.length <= e.MARK_TEXT_MAX));
  assert.equal(JSON.stringify(s), before); // 纯函数，不改入参
});

test('印记：marks_remove 文本必须与已有完全一致，否则不生效', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  s = run(s, { action: 'a', proposal: proposal({ marks_add: ['被76号盯上', '左臂刀伤'] }) }).state;
  s = run(s, {
    action: 'b',
    proposal: proposal({ marks_remove: ['被76号盯上', '不存在的印记', '被76号'] }),
  }).state;
  assert.deepEqual(s.character.marks, ['左臂刀伤']);
});

test('印记：最多 8 条，超出丢最旧', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  for (let i = 1; i <= 12; i++) {
    s = run(s, {
      action: 'a', proposal: proposal({ marks_add: ['印记' + i] }),
    }, () => 0.5, i).state;
  }
  assert.equal(s.character.marks.length, e.MARKS_MAX);
  assert.equal(s.character.marks[0], '印记5');   // 12 条丢最旧的 4 条
  assert.equal(s.character.marks[7], '印记12');
});

test('印记：死亡与重生时清空', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  s.character.marks = ['被76号盯上', '欠白玫一个人情'];
  s.character.attrs['体魄'] = 2;
  const dead = run(s, { action: '硬闯', proposal: proposal({ state_diff: { 体魄: -2 } }) });
  assert.ok(dead.result.death);
  assert.deepEqual(dead.state.character.marks, []); // applyDeath 已清空
  const rb = e.rebirth(dead.state, { name: '二世', appearance: '红衣' });
  assert.deepEqual(rb.state.character.marks, []); // 重生再确保清空
  assert.equal(rb.state.character.alive, true);
});

// ---------- 未解之谜（threads_add / threads_resolve / fadedThreads） ----------

test('未解之谜：createWorld 初始化 threads/fadedThreads=[]，老存档补默认', () => {
  assert.deepEqual(makeState().threads, []);
  assert.deepEqual(makeState().fadedThreads, []);
  const old = { turn: 2, character: { attrs: {} } };
  assert.deepEqual(e.normalizeState(old).threads, []);
  assert.deepEqual(e.normalizeState(old).fadedThreads, []);
});

test('未解之谜：normalizeThread 截 20 字、忽略非字符串/空串', () => {
  assert.equal(e.normalizeThread('  灰呢帽的报纸数字  '), '灰呢帽的报纸数字');
  assert.equal(e.normalizeThread('长'.repeat(30)).length, 20);
  assert.equal(e.normalizeThread(''), '');
  assert.equal(e.normalizeThread(null), '');
  assert.equal(e.normalizeThread(5), '');
});

test('未解之谜：threads_add 校验后写入（≤20 字、去重、不改入参）', () => {
  const s = makeState();
  s.nextEventTurn = 999;
  const before = JSON.stringify(s);
  const out = run(s, {
    action: 'a',
    proposal: proposal({
      threads_add: ['灰呢帽的报纸数字', '第三版招租广告的空括号', '长'.repeat(30), '', 8, '灰呢帽的报纸数字'],
    }),
  });
  assert.deepEqual(out.state.threads, ['灰呢帽的报纸数字', '第三版招租广告的空括号', '长'.repeat(20)]);
  assert.ok(out.state.threads.every((t) => t.length <= e.THREAD_TEXT_MAX));
  assert.equal(JSON.stringify(s), before);
});

test('未解之谜：threads_resolve 必须与已有文本完全一致，解开后归档到 fadedThreads', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  s = run(s, {
    action: 'a', proposal: proposal({ threads_add: ['灰呢帽的报纸数字', '白玫不问去处'] }),
  }).state;
  s = run(s, {
    action: 'b',
    proposal: proposal({ threads_resolve: ['灰呢帽的报纸数字', '近似但不完全', '不存在的线索'] }),
  }).state;
  assert.deepEqual(s.threads, ['白玫不问去处']);
  assert.deepEqual(s.fadedThreads, ['灰呢帽的报纸数字']);
});

test('未解之谜：活跃最多 6 条，超出最旧移入 fadedThreads', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  for (let i = 1; i <= 8; i++) {
    s = run(s, {
      action: 'a', proposal: proposal({ threads_add: ['线索' + i] }),
    }, () => 0.5, i).state;
  }
  assert.equal(s.threads.length, e.THREADS_MAX);
  assert.deepEqual(s.threads, ['线索3', '线索4', '线索5', '线索6', '线索7', '线索8']);
  assert.deepEqual(s.fadedThreads, ['线索1', '线索2']);
});

test('未解之谜：fadedThreads 不无限增长', () => {
  let s = makeState();
  s.nextEventTurn = 999;
  for (let i = 1; i <= 30; i++) {
    s = run(s, {
      action: 'a', proposal: proposal({ threads_add: ['线索' + i] }),
    }, () => 0.5, i).state;
  }
  assert.equal(s.threads.length, e.THREADS_MAX);
  assert.equal(s.fadedThreads.length, e.FADED_THREADS_MAX);
  assert.equal(s.fadedThreads[s.fadedThreads.length - 1], '线索' + (30 - e.THREADS_MAX));
});

