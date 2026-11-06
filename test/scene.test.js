'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const game = require('../src/game.js');

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

function run(state, input) {
  return e.resolveTurn(state, input, { rng: () => 0.5, now: 1 });
}

// ---------- normalizeScene ----------

test('normalizeScene：缺失 / 非对象返回 {draw:false}', () => {
  assert.deepEqual(e.normalizeScene(undefined), { draw: false });
  assert.deepEqual(e.normalizeScene(null), { draw: false });
  assert.deepEqual(e.normalizeScene('x'), { draw: false });
  assert.deepEqual(e.normalizeScene(42), { draw: false });
  assert.deepEqual(e.normalizeScene([]), { draw: false });
});

test('normalizeScene：draw 非 true（false / 字符串 / 1 / 缺省）不出图', () => {
  assert.deepEqual(e.normalizeScene({ draw: false, desc: '有画面的场景' }), { draw: false });
  assert.deepEqual(e.normalizeScene({ draw: 'true', desc: '有画面的场景' }), { draw: false });
  assert.deepEqual(e.normalizeScene({ draw: 1, desc: '有画面的场景' }), { draw: false });
  assert.deepEqual(e.normalizeScene({ desc: '有画面的场景' }), { draw: false });
});

test('normalizeScene：desc 空 / 空白 / 非字符串返回 {draw:false}', () => {
  assert.deepEqual(e.normalizeScene({ draw: true, desc: '' }), { draw: false });
  assert.deepEqual(e.normalizeScene({ draw: true, desc: '   ' }), { draw: false });
  assert.deepEqual(e.normalizeScene({ draw: true, desc: 123 }), { draw: false });
  assert.deepEqual(e.normalizeScene({ draw: true }), { draw: false });
});

test('normalizeScene：合法 scene 出图并去掉首尾空白', () => {
  assert.deepEqual(
    e.normalizeScene({ draw: true, desc: '  雾中钟楼，提灯守夜人  ' }),
    { draw: true, desc: '雾中钟楼，提灯守夜人' },
  );
});

test('normalizeScene：desc 超长截到 60', () => {
  const long = '景'.repeat(80);
  const out = e.normalizeScene({ draw: true, desc: long });
  assert.equal(out.draw, true);
  assert.equal(out.desc.length, 60);
  assert.equal(out.desc, '景'.repeat(60));
});

test('normalizeScene：forced 有 desc 强制 true、无 desc 仍 false', () => {
  assert.deepEqual(
    e.normalizeScene({ draw: false, desc: '关键一幕' }, true),
    { draw: true, desc: '关键一幕' },
  );
  assert.deepEqual(e.normalizeScene({ draw: false }, true), { draw: false });
  assert.deepEqual(e.normalizeScene({ draw: false, desc: '' }, true), { draw: false });
  assert.deepEqual(e.normalizeScene({ draw: false, desc: '平淡一幕' }, false), { draw: false });
});

// ---------- resolveTurn / toPublicTurnResult ----------

test('resolveTurn：proposal.scene.draw=true 时公开结果带 scene.draw=true 与 desc', () => {
  const r = run(makeState(), {
    action: '前行',
    proposal: proposal({ scene: { draw: true, desc: '雾中钟楼下，提灯的守夜人拦住去路' } }),
  });
  assert.equal(r.invalid, false);
  const pub = e.toPublicTurnResult(r.result, r.state);
  assert.equal(pub.scene.draw, true);
  assert.equal(pub.scene.desc, '雾中钟楼下，提灯的守夜人拦住去路');
});

test('resolveTurn：scene 为坏数据时回合照常成功、scene.draw=false', () => {
  const r = run(makeState(), {
    action: '前行',
    proposal: proposal({ scene: { draw: 'yes', desc: '' } }),
  });
  assert.equal(r.invalid, false);
  const pub = e.toPublicTurnResult(r.result, r.state);
  assert.deepEqual(pub.scene, { draw: false });
});

// ---------- toPublicLogRecord ----------

test('toPublicLogRecord：scene.draw=true 的记录输出 scene', () => {
  const pub = game.toPublicLogRecord({
    turn: 3, life: 1, action: '前行', narration: '你向前走去。',
    scene: { draw: true, desc: '雾中钟楼下，提灯的守夜人拦住去路' },
  });
  assert.deepEqual(pub.scene, { draw: true, desc: '雾中钟楼下，提灯的守夜人拦住去路' });
});

test('toPublicLogRecord：scene.draw=false 的记录不输出 scene 字段', () => {
  const pub = game.toPublicLogRecord({
    turn: 4, life: 1, action: '打听', narration: '你四处打听。',
    scene: { draw: false },
  });
  assert.equal('scene' in pub, false);
});
