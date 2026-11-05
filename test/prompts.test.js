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

test('建世界 prompt：要求 npcs 带 want 与 voice 字段（欲望/立场 + 语言指纹）', () => {
  const [system] = prompts.buildWorldMessages('一句世界观', { name: '旅人', appearance: '灰袍' });
  assert.match(system.content, /"npcs":\[\{name,role,desc,want,voice\}\]/);
  assert.match(system.content, /want/);
  assert.match(system.content, /想要什么/);
  assert.match(system.content, /voice/);
  assert.match(system.content, /说话方式/);
  assert.match(system.content, /≤20 字/);
  assert.match(system.content, /短句铁令，从不解释/);
  assert.match(system.content, /语言指纹|明显不同/);
});

test('回合 prompt：带每个 NPC 的 voice，要求台词严格符合各自口吻且彼此不同', () => {
  const state = makeState();
  state.bible.npcs = [
    { name: '玛拉', role: '卫队长', desc: '', want: '守住名册', voice: '短句铁令，从不解释' },
    { name: '勒恩', role: '说客', desc: '', want: '拉拢人心', voice: '哄劝式隐喻，句句带笑' },
    { name: '为首者', role: '账房', desc: '', want: '记清每一笔', voice: '记账式冷语，只报数目' },
  ];
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '探查');
  assert.match(system.content, /【NPC 语言指纹（台词必须严格符合）】/);
  assert.ok(system.content.includes('玛拉：短句铁令，从不解释'));
  assert.ok(system.content.includes('勒恩：哄劝式隐喻，句句带笑'));
  assert.ok(system.content.includes('为首者：记账式冷语，只报数目'));
  assert.ok(system.content.includes('口吻：短句铁令，从不解释'), 'worldBibleText 也应带口吻');
  assert.match(system.content, /严格符合/);
  assert.match(system.content, /彼此之间必须明显不同/);
});

test('回合 prompt：老世界 NPC 无 voice 时仍要求现场确立彼此不同的说话方式', () => {
  const state = makeState(); // npcs 只有守夜人，无 voice
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '探查');
  assert.match(system.content, /【NPC 语言指纹（台词必须严格符合）】/);
  assert.match(system.content, /未标注，须当场确立一种与他人明显不同的说话方式/);
  assert.match(system.content, /同一套腔调/);
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

test('安全选项有代价：回合 prompt 要求退让/观望/回避也要付出代价或错失，不能零成本', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '退到一旁');
  assert.match(system.content, /【安全选项的代价（不得零成本）】/);
  assert.match(system.content, /退让、观望、回避/);
  assert.match(system.content, /NPC 的信任下降/);
  assert.match(system.content, /机会被旁人抢先|机会溜走/);
  assert.match(system.content, /线索被别人取走/);
  assert.match(system.content, /marks_add/);
  assert.match(system.content, /不能零成本|不得零成本/);
  assert.match(system.content, /不要连续复用/);
  assert.match(system.content, /npc_attitude 给负值/);
  assert.match(system.content, /叙事与状态规则/); // TURN_RULES 仍在
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

// ---------- 导演机制：转折 / 越界升级 / 物品同步 / 开局事实 ----------

test('回合 prompt：转折时要求「本回合必须出现明显转折：<twist>，要符合世界设定和当前局面」', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2, twist: '闯入者' }, '探查');
  assert.match(system.content, /本回合必须出现明显转折：闯入者，要符合世界设定和当前局面/);
  assert.match(system.content, /明显转折/);
  assert.match(system.content, /不要点破这是被安排的转折/);
});

test('回合 prompt：无转折时不出现「本回合要求：明显转折」段', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.equal(/本回合要求：明显转折/.test(system.content), false);
});

test('越界升级：prompt 带累计次数与强化阶梯（1 必留印记 / 2 声望-1+实质后果 / 3+ 严重后果）', () => {
  for (const n of [0, 1, 2, 3]) {
    const state = makeState();
    state.oversteps = n;
    const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '探查');
    const all = system.content;
    assert.ok(all.includes(`玩家迄今已越界 ${n} 次`), `应带累计次数 ${n}`);
    assert.match(all, /升级阶梯/);
    assert.match(all, /第 1 次必须留下印记/);
    assert.match(all, /第 2 次声望 -1 且有实质后果/);
    assert.match(all, /第 3 次起必须是严重后果/);
    assert.match(all, /每次后果形式都不得与前几次重复|每次形式不同/);
    assert.match(all, /被驱逐|被拘押|关键 NPC 断交|受伤/);
    assert.match(all, /"overstep"/);
    assert.match(all, /越界升级/);
    assert.match(all, /同一种越界请求.*不得得到相同处理/);
    assert.match(all, /点明「这已是第几次」/);
    assert.match(all, /第 1 次就必须留下印记/);
  }
});

test('越界升级：overstepDirective 第1次必留印记、第2次声望-1、第3次起轮换严重后果且禁重复', () => {
  const d1 = prompts.overstepDirective(0);
  assert.match(d1, /第 1 次/);
  assert.match(d1, /必须留下印记（marks_add/);
  assert.match(d1, /被登进疯人名册|被当成疯子/);
  assert.match(d1, /绝不只是冷遇|绝不零成本/);
  assert.equal(/冷遇或警告/.test(d1), false, '第 1 次不再允许只冷遇/警告');

  const d2 = prompts.overstepDirective(1);
  assert.match(d2, /第 2 次/);
  assert.match(d2, /声望 -1（state_diff）/);
  assert.match(d2, /实质后果/);
  assert.match(d2, /援引第 1 次/);

  const d3 = prompts.overstepDirective(2);
  const d4 = prompts.overstepDirective(3);
  const d5 = prompts.overstepDirective(4);
  const d6 = prompts.overstepDirective(5);
  assert.match(d3, /被驱逐/);
  assert.match(d4, /被拘押/);
  assert.match(d5, /关键 NPC 断交/);
  assert.match(d6, /受伤/);
  assert.match(prompts.overstepDirective(6), /被驱逐/); // 轮换，保证不重复
  // 已用形式随累计次数增长，且明确禁止重复
  assert.match(d4, /此前已用过的严重后果形式：被驱逐/);
  assert.match(d5, /被驱逐、被拘押/);
  assert.match(d5, /不得重复其中任何一种/);
  for (const form of prompts.OVERSTEP_FORMS) {
    assert.match(d3 + d4 + d5 + d6, new RegExp(form));
  }
  // 同一种越界请求不得得到相同处理
  assert.match(d1, /同一种越界请求/);
  assert.match(d1, /更高一档/);
  assert.equal(prompts.overstepDirective(undefined).includes('第 1 次'), true);
});

test('回合 prompt：物品同步规则 + 当前物品列表放在输出格式说明旁边', () => {
  const state = makeState();
  state.character.items = ['旧铜灯', '无字信'];
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '探查');
  const all = system.content;
  assert.match(all, /交出、丢失、用掉、被收走的物品，必须同时写进 items_remove/);
  assert.match(all, /只有真正得到新物品才写 items_add/);
  assert.match(all, /物品栏必须与叙事一致|物品栏必须与叙事同步/);
  assert.match(all, /【当前随身物品（物品栏必须与叙事同步）】/);
  assert.ok(all.includes('角色当前拥有的物品：旧铜灯、无字信'));
  // 当前物品段落紧邻【输出格式】之前
  const idxItems = all.indexOf('【当前随身物品');
  const idxFormat = all.indexOf('【输出格式】');
  assert.ok(idxItems >= 0 && idxFormat > idxItems, '物品列表应放在输出格式说明旁边');
});

test('濒死可感知：体魄 ≤ 2 时回合 prompt 要求叙事明确写出伤势严重', () => {
  const state = makeState();
  state.character.attrs = { 体魄: 2 };
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '撑住');
  assert.match(system.content, /【伤势沉重（叙事必须明确写出）】/);
  assert.match(system.content, /体魄仅剩 2/);
  assert.match(system.content, /伤势的严重程度/);
  assert.match(system.content, /视线发黑|抬手困难/);
  assert.match(system.content, /略感疲惫/);
  // 与引擎的公开状态阈值一致
  const engine = require('../src/engine.js');
  assert.equal(engine.DANGER_THRESHOLD, 2);
});

test('濒死可感知：体魄 > 2 时不出现伤势沉重段落', () => {
  const state = makeState();
  state.character.attrs = { 体魄: 3 };
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '探查');
  assert.equal(/【伤势沉重/.test(system.content), false);
});

test('新一世开场：buildRebirthOpeningMessages 结合世界设定/墓志铭/facts/npcAttitude，要求四要素、不夹带 apex', () => {
  const state = makeState();
  state.bible.title = '灰烬港残卷';
  state.facts = [{ turn: 1, text: '城门每日戌时落锁' }];
  state.npcAttitude = { 守夜人: 3, 账房: -2 };
  state.life = 3;
  state.character.name = '三世旅人';
  state.character.appearance = '红衣';
  const [system, user] = prompts.buildRebirthOpeningMessages(state, {
    prevLife: 2, prevName: '二世', epitaph: '二世行过雾港，终没能等来钟声落款。', cause: '体魄归零',
  });
  const all = system.content + '\n' + user.content;
  assert.match(all, /"opening"/);
  assert.match(all, /150~300 字/);
  assert.match(all, /新一世开场/);
  assert.ok(all.includes('灰烬港残卷'), '应带世界设定');
  assert.ok(all.includes('城门每日戌时落锁'), '应带 facts');
  assert.ok(all.includes('守夜人:3') && all.includes('账房:-2'), '应带 npcAttitude');
  assert.ok(all.includes('二世行过雾港，终没能等来钟声落款。'), '应带上一世墓志铭');
  assert.ok(all.includes('三世旅人') && all.includes('红衣'), '应带新身份');
  assert.match(all, /过去了多久/);                 // 距上一世多久由模型决定
  assert.match(all, /世界因上一世发生了什么可见变化/);
  assert.match(all, /隐约记得你/);
  assert.match(all, /不得与/);
  assert.match(all, /已确立的事实/);
  assert.match(all, /不点破/);
  assert.equal(/隐秘王冠|北方的钟声|\bapex\b/.test(all), false, '开场 prompt 不应夹带 apex');
});

test('建世界 prompt：要求 start.facts 给 2~3 条关键时间/规则事实（如满月）', () => {
  const [system] = prompts.buildWorldMessages('一句世界观', { name: '旅人', appearance: '灰袍' });
  assert.match(system.content, /"facts":\[str x2~3\]/);
  assert.match(system.content, /start\.facts/);
  assert.match(system.content, /关键时间\/规则事实/);
  assert.match(system.content, /满月在三日后/);
  assert.match(system.content, /锁定开局时间线/);
  assert.match(system.content, /≤30 字/);
  assert.match(system.content, /不得改写/);
});
