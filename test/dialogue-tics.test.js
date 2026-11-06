'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine.js');
const prompts = require('../src/prompts.js');

const clean = engine.cleanDialogueTics;

test('cleanDialogueTics：句末「，问？」删除并确保问号结尾', () => {
  assert.equal(
    clean('「第一次，『六号楼还剩十九个人』，然后是一串数字，像门牌号，我没记全，问？」'),
    '「第一次，『六号楼还剩十九个人』，然后是一串数字，像门牌号，我没记全？」'
  );
  assert.equal(
    clean('「我当时吓得把电池拔了，问？」'),
    '「我当时吓得把电池拔了？」'
  );
  assert.equal(
    clean('「每七下停一停，你听，问？」'),
    '「每七下停一停，你听？」'
  );
});

test('cleanDialogueTics：半角问号 / 顿号后的「问？」同样处理', () => {
  assert.equal(clean('「你听，问?」'), '「你听？」');
  assert.equal(clean('「这样、问？」'), '「这样？」');
});

test('cleanDialogueTics：句末已有问号不出现双问号', () => {
  const out = clean('「是不是这样？，问？」');
  assert.equal(out, '「是不是这样？」');
  assert.ok(!out.includes('？？'));
});

test('cleanDialogueTics：不误伤正常文字与引号外旁白', () => {
  for (const s of ['「你去问问他。」', '「他问：你是谁？」', '「我问？他不答。」']) {
    assert.equal(clean(s), s, s);
  }
  assert.equal(
    clean('他低声说「你听，问？」然后沉默。'),
    '他低声说「你听？」然后沉默。'
  );
  // 引号外没有任何「…」时完全不动
  assert.equal(clean('我没记全，问？'), '我没记全，问？');
});

test('cleanDialogueTics：句末「，说：」「，答：」「，道：」直接删掉', () => {
  assert.equal(clean('「你听，说：」'), '「你听」');
  assert.equal(clean('「你听，答：」'), '「你听」');
  assert.equal(clean('「你听，道：」'), '「你听」');
});

function makeState() {
  return {
    bible: {
      title: '测试世界', tone: '苍凉', rules: [],
      places: [], factions: [],
      npcs: [{ name: '小林', role: '', desc: '', voice: '絮絮低语，总在句尾提问' }],
      start: { place: '灰烬港', situation: '醒来', items: ['旧铜灯'] },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯', '无字信'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 1,
  };
}

test('回合提示词：voice 是风格，不是逐字照搬的标签', () => {
  const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  const all = system.content + '\n' + user.content;
  assert.ok(all.includes('不是要逐字照搬的标签'));
});

test('建世界提示词：voice 不要写成机械规则', () => {
  const [system] = prompts.buildWorldMessages('一句世界观', { name: '旅人', appearance: '灰袍' });
  assert.ok(system.content.includes('不要写成『句尾加某个字』'));
});
