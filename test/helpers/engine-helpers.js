'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../../src/engine.js');

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

module.exports = { seeded, makeState, proposal, run, eventState, settle, killByBody };
