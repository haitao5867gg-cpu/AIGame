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

test('回合 prompt：风声预兆时要求不祥征兆，并禁止写出主题词', () => {
  const [system, user] = prompts.buildTurnMessages(
    makeState(), { nextTurn: 2, omen: true, omenTheme: '天灾' }, '探查',
  );
  const all = system.content + '\n' + user.content;
  assert.match(all, /风声预兆/);
  assert.match(all, /不祥征兆/);
  assert.match(all, /天灾/);            // 主题交给模型，让征兆与真正到来的事件相关
  assert.match(all, /不要写出主题词/);
});

test('回合 prompt：无预兆时不出现风声预兆段落', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2, omen: false }, '探查');
  assert.equal(/风声预兆/.test(system.content), false);
});

test('回合 prompt：输出格式列出 rumor 可选字段及约每三回合说明', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.match(system.content, /"rumor"/);
  assert.match(system.content, /约每三回合/);
  assert.match(system.content, /≤40 字/);
});

test('回合 prompt：带上当前地点与时间并要求叙事一致；格式含 move_to/time_passes', () => {
  const state = makeState();
  state.location = '灰烬港';
  state.clock = { day: 3, period: '黄昏' };
  const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 4 }, '探查');
  const all = system.content + '\n' + user.content;
  assert.match(all, /时与地/);
  assert.match(all, /灰烬港/);
  assert.match(all, /第3日 黄昏/);
  assert.match(all, /"move_to"/);
  assert.match(all, /"time_passes"/);
  assert.match(all, /0、1、2/);
  assert.match(all, /一致/);
});

test('回合 prompt：把全部 facts 列为「已确立的事实，叙事必须遵守，不得改写」', () => {
  const state = makeState();
  state.facts = [
    { turn: 1, text: '城门每日戌时落锁' },
    { turn: 3, text: '顾秋白是76号的人' },
  ];
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 4 }, '探查');
  assert.match(system.content, /【已确立的事实（叙事必须遵守，不得改写）】/);
  assert.ok(system.content.includes('城门每日戌时落锁'));
  assert.ok(system.content.includes('顾秋白是76号的人'));
  assert.match(system.content, /不得矛盾/);
  assert.match(system.content, /不得改写/);
});

test('回合 prompt：无 facts 时不出现「已确立的事实」段落', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.equal(/【已确立的事实（叙事必须遵守/.test(system.content), false);
});

test('回合 prompt：输出格式含 new_facts 及 ≤30 字 / 不得改写说明', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.match(system.content, /"new_facts"/);
  assert.match(system.content, /≤30 字/);
  assert.match(system.content, /不得改写/);
});

test('回合 prompt：把 marks 列为「身上的印记」并要求持续后果、越界留印记', () => {
  const state = makeState();
  state.character.marks = ['被76号盯上', '左臂刀伤'];
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 4 }, '探查');
  assert.match(system.content, /【身上的印记/);
  assert.match(system.content, /这些是已经落在角色身上的持久处境/);
  assert.ok(system.content.includes('被76号盯上'));
  assert.ok(system.content.includes('左臂刀伤'));
  assert.match(system.content, /持续/);
  assert.match(system.content, /越界/);
  assert.match(system.content, /marks_add/);
});

test('回合 prompt：输出格式含 marks_add / marks_remove 及 ≤16 字说明', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.match(system.content, /"marks_add"/);
  assert.match(system.content, /"marks_remove"/);
  assert.match(system.content, /≤16 字/);
});

test('回合 prompt：把 threads 列为「未解之谜」，要求约每 5 回合推进/解开一条', () => {
  const state = makeState();
  state.threads = ['灰呢帽的报纸数字', '白玫不问去处'];
  state.fadedThreads = ['已淡去的旧线索'];
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 6 }, '探查');
  assert.match(system.content, /【未解之谜】/);
  assert.match(system.content, /仍悬而未决、需要后续收束的线索/);
  assert.ok(system.content.includes('灰呢帽的报纸数字'));
  assert.ok(system.content.includes('已淡去的旧线索'));
  assert.match(system.content, /每 5 回合/);
  assert.match(system.content, /不能只埋不收/);
  assert.match(system.content, /threads_resolve/);
});

test('回合 prompt：无 threads 时不出现动态「未解之谜」列表', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.equal(system.content.includes('仍悬而未决、需要后续收束的线索'), false);
});

test('回合 prompt：输出格式含 threads_add / threads_resolve 及 ≤20 字说明', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.match(system.content, /"threads_add"/);
  assert.match(system.content, /"threads_resolve"/);
  assert.match(system.content, /≤20 字/);
});

test('回合 prompt：反重复意象/NPC 小动作、叙事结尾停在玩家决断、suggestions 三条不同方向', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.match(system.content, /不要重复最近回合已用过的意象/);
  assert.match(system.content, /NPC 小动作/);
  assert.match(system.content, /擦杯|停手|推牌/);
  assert.match(system.content, /需要玩家决断的具体局面/);
  assert.match(system.content, /不要替玩家作决定/);
  assert.match(system.content, /大胆冒险/);
  assert.match(system.content, /谨慎稳妥/);
  assert.ok(system.content.includes('借人/用计'));
  assert.match(system.content, /三条方向明显不同|方向明显不同/);
});

test('前世墓志铭：buildEpitaphMessages 用本世经历、要求 ≤80 字、不夹带 apex', () => {
  const state = makeState();
  state.character.name = '初代';
  const [system, user] = prompts.buildEpitaphMessages(
    state, { life: 1, name: '初代', turns: 8, cause: '体魄归零' },
  );
  const all = system.content + '\n' + user.content;
  assert.match(all, /"epitaph"/);
  assert.match(all, /不超过 80 字|≤80 字/);
  assert.match(all, /初代/);
  assert.match(all, /体魄归零/);
  assert.match(all, /不要点破任何隐藏目标/);
  assert.equal(/隐秘王冠|\bapex\b/.test(all), false, '墓志铭 prompt 不应夹带 apex');
});
