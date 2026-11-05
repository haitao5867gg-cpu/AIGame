'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/prompts.js');

function makeState() {
  return {
    bible: {
      title: '测试世界', tone: '苍凉', rules: [],
      places: [], factions: [],
      npcs: [{ name: '守夜人', role: '', desc: '' }],
      start: { place: '灰烬港', situation: '醒来', items: ['旧铜灯'] },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯', '无字信'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 1,
  };
}

test('回合 prompt：明确列出 persona_tags 只能取 6 个词', () => {
  const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  const all = system.content + '\n' + user.content;
  for (const word of ['冒险', '审慎', '共情', '权谋', '坚韧', '秩序']) {
    assert.ok(all.includes(word), `应包含维度「${word}」`);
  }
  assert.match(all, /只能从这 6 个词|只能取/);
  // 明确禁止自造词（真模型曾输出「谨慎」「水路」）
  assert.match(all, /谨慎/);
  assert.match(all, /水路/);
  assert.match(all, /自造/);
});

test('回合 prompt：列出当前物品，并要求使用没有的物品要写失败', () => {
  const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '用旧铜灯照路');
  const all = system.content + '\n' + user.content;
  assert.ok(all.includes('旧铜灯'), '应列出角色当前物品');
  assert.ok(all.includes('无字信'), '应列出角色当前物品');
  assert.match(all, /摸遍全身也没有/);
  assert.match(all, /不得凭空|不可凭空/);
});

test('建世界 prompt：要求 start.items 给 2~3 个起始物品', () => {
  const [system] = prompts.buildWorldMessages('一句世界观', { name: '旅人', appearance: '灰袍' });
  assert.match(system.content, /"items":\[str x2~3\]/);
  assert.match(system.content, /start\.items/);
  assert.match(system.content, /起始物品/);
});

test('建世界 prompt：要求 npcs 带 want 字段（欲望/立场）', () => {
  const [system] = prompts.buildWorldMessages('一句世界观', { name: '旅人', appearance: '灰袍' });
  assert.match(system.content, /"npcs":\[\{name,role,desc,want\}\]/);
  assert.match(system.content, /want/);
  assert.match(system.content, /想要什么/);
});

test('回合 prompt：带上每个 NPC 的 want（欲望/立场）', () => {
  const state = makeState();
  state.bible.npcs = [
    { name: '守夜人', role: '更夫', desc: '提灯巡夜', want: '守住钟声不乱' },
    { name: '账房', role: '', desc: '', want: '攒够钱赎身' },
  ];
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '探查');
  assert.match(system.content, /想要：守住钟声不乱/);
  assert.match(system.content, /想要：攒够钱赎身/);
});

test('回合 prompt：补充属性克制 / 越界具体后果 / 节奏推进 / NPC 差异规则', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.match(system.content, /大多数回合不要改属性/);
  assert.match(system.content, /越界/);
  assert.match(system.content, /声望 -1/);
  assert.match(system.content, /被驱逐|被盯上|记档/);
  assert.match(system.content, /最多持续 3 回合/);
  assert.match(system.content, /每回合都要有至少一处/);
  assert.match(system.content, /欲望与立场/);
  assert.match(system.content, /信息出口/);
});

test('parseJson 仍可解析带 ```json 包裹的输出', () => {
  assert.deepEqual(prompts.parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(prompts.parseJson('不是 json'), null);
});
