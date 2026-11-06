'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const { seeded, makeState, proposal, run, eventState, settle, killByBody } = require('./helpers/engine-helpers.js');


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

// ---------- eventThemes 兜底 ----------

test('createWorld: eventThemes 少于 4 个用通用主题补齐', () => {
  const empty = e.createWorld({ id: 'w1', bible: { eventThemes: [] } }, { rng: () => 0 });
  assert.deepEqual(empty.bible.eventThemes, e.GENERIC_EVENT_THEMES.slice());

  const few = e.createWorld(
    { id: 'w2', bible: { eventThemes: ['灯灭', '问斩'] } },
    { rng: () => 0 },
  );
  assert.ok(few.bible.eventThemes.length >= 4);
  assert.equal(few.bible.eventThemes[0], '灯灭');
  assert.equal(few.bible.eventThemes[1], '问斩');
  for (const g of e.GENERIC_EVENT_THEMES) {
    assert.ok(few.bible.eventThemes.includes(g), `应补齐通用主题「${g}」`);
  }

  // 缺失 / 非数组也兜底
  assert.deepEqual(
    e.createWorld({ id: 'w3', bible: {} }, { rng: () => 0 }).bible.eventThemes,
    e.GENERIC_EVENT_THEMES.slice(),
  );
  // 已有 ≥4 个时原样保留
  const full = makeState();
  assert.equal(full.bible.eventThemes.length, 6);
  assert.equal(full.bible.eventThemes[0], '魔族入侵');
});

test('planTurn: 主题为空时用通用主题兜底，事件仍按节奏开启', () => {
  const s = makeState();
  s.bible.eventThemes = [];
  s.turn = 6;
  s.nextEventTurn = 7;
  const plan = e.planTurn(s, { rng: () => 0 });
  assert.equal(plan.opening, true);
  assert.equal(plan.needEvent, true);
  assert.ok(e.GENERIC_EVENT_THEMES.includes(plan.theme));
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

// ---------- 开局事实（bible.start.facts） ----------

test('开局事实：createWorld 把 bible.start.facts 写入 state.facts（turn=0、≤30 字、去重、≤3 条）', () => {
  const s = e.createWorld(
    {
      id: 'w',
      bible: {
        start: {
          place: '灰烬港',
          facts: ['满月在三日后', '城门每日戌时落锁', '满月在三日后', '长'.repeat(45), '第四条被丢弃'],
        },
      },
    },
    { rng: () => 0 },
  );
  assert.deepEqual(s.facts, [
    { turn: 0, text: '满月在三日后' },
    { turn: 0, text: '城门每日戌时落锁' },
    { turn: 0, text: '长'.repeat(30) },
  ]);
  assert.ok(s.facts.every((f) => f.turn === 0 && f.text.length <= e.FACT_TEXT_MAX));
});

test('开局事实：startingFacts 忽略非字符串/空串/重复，最多 3 条', () => {
  assert.deepEqual(e.startingFacts({ start: { facts: [] } }), []);
  assert.deepEqual(e.startingFacts({}), []);
  assert.deepEqual(e.startingFacts({ start: { facts: ['甲', '', null, 5, '甲', '乙'] } }), [
    { turn: 0, text: '甲' }, { turn: 0, text: '乙' },
  ]);
});

