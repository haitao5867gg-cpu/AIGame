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
  assert.match(system.content, /"npcs":\[\{name,role,desc,look,want,voice(,rank)?\}\]/);
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

test('回合 prompt：补充属性克制 / 越界具体后果 / 玩家意图优先 / NPC 差异规则', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.match(system.content, /大多数回合不要改属性/);
  assert.match(system.content, /越界/);
  assert.match(system.content, /声望 -1/);
  assert.match(system.content, /被驱逐|被盯上|记档/);
  // 新规则：玩家意图优先，不再用「最多 3 回合必须推进 / 每回合都要有变化」强行打断。
  assert.match(system.content, /玩家意图优先/);
  assert.match(system.content, /不算拖沓/);
  assert.equal(/最多持续 3 回合/.test(system.content), false);
  assert.equal(/每回合都要有至少一处/.test(system.content), false);
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

test('回合 prompt：把 threads 列为「未解之谜」，玩家主动接触时再推进、主线等玩家', () => {
  const state = makeState();
  state.threads = ['灰呢帽的报纸数字', '白玫不问去处'];
  state.fadedThreads = ['已淡去的旧线索'];
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 6 }, '探查');
  assert.match(system.content, /【未解之谜】/);
  assert.match(system.content, /仍悬而未决、需要后续收束的线索/);
  assert.ok(system.content.includes('灰呢帽的报纸数字'));
  assert.ok(system.content.includes('已淡去的旧线索'));
  // 新规则：不再「大约每 5 回合要推进」，改为玩家主动接触时才推进、主线等玩家。
  assert.match(system.content, /玩家主动接触相关人物或地点时再推进/);
  assert.match(system.content, /主线等玩家/);
  assert.equal(/每 5 回合/.test(system.content), false);
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
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style: 'v1' });
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

test('回合 prompt：要求叙事分成 2~4 个短段落、对话单独成段、段落间用 \\n\\n 分隔', () => {
  const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style: 'v1' });
  const all = system.content + '\n' + user.content;
  assert.match(all, /2~4 个短段落/, '应要求 2~4 段');
  assert.match(all, /1~3 句/, '每段 1~3 句');
  assert.match(all, /90 字/, '每段 ≤90 字');
  assert.match(all, /对白|对话/, '应提到对白/对话');
  assert.match(all, /单独成段/, '对话单独成段');
  assert.ok(all.includes('\\n\\n'), '应写明段落用 \\n\\n 分隔（JSON 里的字面量）');
  assert.match(all, /不要写成一整段长文字|不要输出成没有分段/, '应禁止一整段长文字');
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

// ---------- 首次出场 / 续回合：通用叙事规则（覆盖所有回合，不只第一幕）----------

test('首次出场与续回合：完整规则为单一来源，短提醒临近当前行动 / 落笔处，非首回合仍生效', () => {
  const state = makeState();
  state.turn = 3;
  state.location = '灰烬港';
  state.clock = { day: 2, period: '黄昏' };
  // 上一回合停在一句没说完的话上（未完收尾），本回合玩家留在原地把话等完。
  state.recent = [
    { turn: 3, action: '等对方开口', narration: '那人停在两步外，像是在等你说下去，话还没问出口。' },
  ];
  const action = '先不急着动，等他把话说完';
  const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 4 }, action, { style: 'v2' });
  const c = system.content;
  const u = user.content;
  const all = c + '\n' + u;

  // 完整规则是【叙事与状态规则】里的单一来源：两个锚点各只出现一次，非首回合没有第一幕段。
  assert.equal((c.match(/不等于玩家已经被告知/g) || []).length, 1, '完整规则只注入一次');
  assert.equal((c.match(/续回合默认承接/g) || []).length, 1, '续写条款只注入一次');
  assert.doesNotMatch(c, /这是第一幕/);

  // 临近落笔的短提醒在 user 消息里，且夹在「玩家本回合的行动」与落笔指令之间。
  assert.ok(u.includes('落笔前'));
  const iAction = u.indexOf('玩家本回合的行动');
  const iReminder = u.indexOf('落笔前');
  const iOutput = u.indexOf('请据此写出本回合叙事');
  assert.ok(iAction < iReminder && iReminder < iOutput,
    '短提醒应位于当前行动之后、落笔指令之前');
  // 短提醒明确复述核心约束（用少量稳健关键词，不堆逐字断言）。
  assert.match(u, /不等于读者看过的正文/);   // 后台设定 ≠ 读者看过的正文
  assert.match(u, /落位/);                    // 先从玩家视角在场景里落位
  assert.match(u, /空间关系/);                // 基本空间关系不能缺
  assert.match(u, /复合短语/);                // 把地标塞进「X 旁」复合短语不算交代
  assert.match(u, /以玩家为准/);              // 续写以玩家新行动为准
  // 短提醒是「引用」而非复制整段完整规则：不复述单一来源的整句锚点。
  assert.doesNotMatch(u, /不等于玩家已经被告知/);

  // 既有护栏仍在：玩家意图优先、时与地。
  assert.match(c, /玩家意图优先/);
  assert.match(c, /时与地/);
  // 玩家行动、原地点、上一回合未完收尾都完整保留，未被新规则强行转场 / 改写。
  assert.ok(u.includes(action), '玩家本回合行动应原样保留');
  assert.match(all, /灰烬港/);
  assert.match(all, /第2日 黄昏/);
  assert.ok(u.includes('等你说下去') || u.includes('话还没问出口'),
    '上一回合未完收尾应作为最近记录保留');
  // 不把具体案例物件硬编码进通用提示词（system 与 user 都不含）。
  assert.doesNotMatch(all, /铜铃|外门杂役录/);
});

test('首次出场与续回合：首回合仍给「这是第一幕」，完整规则单一来源、短提醒同样生效', () => {
  const state = makeState();
  state.turn = 0; // 第一幕
  const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 1 }, '打量四周', { style: 'v1' });
  const c = system.content;
  const u = user.content;
  // 第一幕段仍在（prologue 衔接），但只负责接住序章「此刻」。
  assert.match(c, /这是第一幕/);
  assert.match(c, /序章/);
  // 完整通用条款在首回合同样是单一来源（各一次），不被第一幕重复注入。
  assert.equal((c.match(/不等于玩家已经被告知/g) || []).length, 1);
  assert.equal((c.match(/续回合默认承接/g) || []).length, 1);
  // 旧版只覆盖第一幕的同义指令已移除，避免开局两段雷同。
  assert.doesNotMatch(c, /首次出现的人和地方要带一句交代/);
  assert.doesNotMatch(c, /突兀地丢出陌生名词/);
  // 短提醒在首回合的 user 消息里也在（临近落笔处），与写法无关。
  assert.ok(u.includes('落笔前'));
  assert.match(u, /不等于读者看过的正文/);
  assert.match(u, /以玩家为准/);
});

// ---------- 第一幕：当前地点的环境背景（玩家尚未读过）----------

test('第一幕：仅携带当前匹配地点的环境背景与首幕落位指令，不取别的地点、不夹带内部字段', () => {
  const state = makeState();
  state.turn = 0;
  state.location = '沟口';
  state.clock = { day: 1, period: '清晨' };
  state.bible.places = [
    { name: '沟口', desc: '一块青石板卡在沟口，拨开挪三指就能改水道。' },
    { name: '打谷场', desc: '场边立着一排竹架，摊着新晒的谷。' },
  ];
  state.recent = [
    { turn: 0, action: '睁开眼', narration: '风从水田那头吹来，话还没说出口。' },
  ];
  const action = '先看看水往哪边流';
  const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 1 }, action, { style: 'v1' });
  const c = system.content;
  const u = user.content;
  const all = c + '\n' + u;

  // 片段与配套指令在 user 消息里，且紧邻玩家行动 / 落笔输出之间。
  assert.match(u, /【当前地点的环境背景（玩家尚未读过）】/);
  assert.ok(u.includes('沟口：一块青石板卡在沟口，拨开挪三指就能改水道。'),
    '应带上精确匹配地点的 name/desc');
  const iAction = u.indexOf('玩家本回合的行动');
  const iEnv = u.indexOf('当前地点的环境背景');
  const iOutput = u.indexOf('请据此写出本回合叙事');
  assert.ok(iAction < iEnv && iEnv < iOutput, '环境片段应位于当前行动之后、落笔输出之前');

  // 首幕落位指令要点。
  assert.match(u, /1~2 句/);
  assert.match(u, /自然呈现眼前场景/);
  assert.match(u, /然后立即回应玩家本回合的行动/);
  assert.match(u, /X 旁 \/ X 下/);                    // 不能只埋进 NPC 动作修饰语
  assert.match(u, /不要照抄整段设定/);
  assert.match(u, /不替玩家增加观察、转场、作决定/);     // 不强制观察/转场/决定/新事件
  assert.match(u, /不必重讲环境/);
  assert.match(u, /合理可见 \/ 可听/);                // 按时间/人物视角选取可见可听内容
  assert.match(u, /不得当作玩家已知直接写出来/);        // 秘密 / 看不见的不泄露

  // 只取匹配地点：另一地点的 name/desc 不出现在片段，也不编造环境。
  assert.doesNotMatch(u, /打谷场|竹架|新晒的谷/);
  // 不把 apex / 内部隐藏目标字段塞进这段；提示词不硬编码具体案例物件。
  const envStart = u.indexOf('【当前地点的环境背景');
  const envEnd = u.indexOf('【', envStart + 1);
  const envSection = u.slice(envStart, envEnd < 0 ? undefined : envEnd);
  assert.doesNotMatch(envSection, /apex|隐藏目标|\bhint\b|北方的钟声/);
  assert.doesNotMatch(all, /铜铃|外门杂役录/);

  // 原玩家行动 / 时间地点 / 近期收尾都保留，第一幕段、通用规则、短提醒仍生效。
  assert.ok(u.includes(action), '玩家本回合行动应原样保留');
  assert.match(all, /第1日 清晨/);
  assert.ok(u.includes('话还没说出口'), '上一回合未完收尾应作为最近记录保留');
  assert.match(u, /落笔前/);
  assert.match(c, /这是第一幕/);
  assert.equal((c.match(/不等于玩家已经被告知/g) || []).length, 1,
    '完整通用规则仍是单一来源');
});

test('第一幕：缺资料安全省略，且 location 不匹配时不回退取别的地点', () => {
  // 1) location 指向的地点不在 places（但 start.place 指向存在的地点）——不能回退取 start.place。
  const s1 = makeState();
  s1.turn = 0;
  s1.location = '别处';
  s1.bible.places = [{ name: '沟口', desc: '一块青石板卡在沟口。' }];
  s1.bible.start.place = '沟口';
  const [, m1] = prompts.buildTurnMessages(s1, { nextTurn: 1 }, '张望');
  assert.doesNotMatch(m1.content, /当前地点的环境背景/);
  assert.doesNotMatch(m1.content, /青石板/, '不应回退取 start.place 对应的另一个地点');

  // 2) 匹配到地点但 desc 为空 / 纯空白 ——省略。
  const s2 = makeState();
  s2.turn = 0;
  s2.location = '沟口';
  s2.bible.places = [{ name: '沟口', desc: '   ' }];
  const [, m2] = prompts.buildTurnMessages(s2, { nextTurn: 1 }, '张望');
  assert.doesNotMatch(m2.content, /当前地点的环境背景/);

  // 3) places 为空 ——省略。
  const s3 = makeState();
  s3.turn = 0;
  s3.location = '灰烬港';
  const [, m3] = prompts.buildTurnMessages(s3, { nextTurn: 1 }, '张望');
  assert.doesNotMatch(m3.content, /当前地点的环境背景/);

  // 4) location 缺失时，按 bible.start.place 回退匹配成功。
  const s4 = makeState();
  s4.turn = 0;
  delete s4.location;
  s4.bible.start.place = '沟口';
  s4.bible.places = [{ name: '沟口', desc: '一块青石板卡在沟口，拨开就能改道。' }];
  const [, m4] = prompts.buildTurnMessages(s4, { nextTurn: 1 }, '张望');
  assert.match(m4.content, /当前地点的环境背景/);
  assert.ok(m4.content.includes('青石板'));
});

test('第一幕环境片段：非首回合不重复插入，通用完整规则与短提醒仍生效', () => {
  const state = makeState();
  state.turn = 1;
  state.location = '沟口';
  state.bible.places = [{ name: '沟口', desc: '一块青石板卡在沟口，拨开就能改道。' }];
  const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '继续看水');
  const c = system.content;
  const u = user.content;
  assert.doesNotMatch(u, /当前地点的环境背景/);
  assert.doesNotMatch(u, /上面这段是写作背景/);
  assert.doesNotMatch(u, /青石板/, '非首回合不重讲环境');
  assert.match(c, /不等于玩家已经被告知/, '通用完整规则仍在');
  assert.match(u, /落笔前/, '落笔前短提醒仍在');
  assert.match(u, /不等于读者看过的正文/);
});
