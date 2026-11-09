'use strict';

// 任务3 提示词测试：TURN_OUTPUT_FORMAT 的 npc_updates 协议、v2 派生、
// buildTurnMessages 注入的有界「相关人物档案」片段。
// 验证：完整存储 != 每回合把全史塞进 prompt；内部资料只进模型 prompt、不进公开状态；
// 既有叙事正文 / 数值 / 玩家意图 / TTS(voice_hints) / 出图(scene.cast) 接线不回退。

const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/prompts.js');
const engine = require('../src/engine.js');
const npcs = require('../src/npcs.js');

// 与 test/prompts.test.js 同构的最小 state；按需挂 npcProfiles / bible.npcs。
function makeState(opts) {
  const o = opts || {};
  const s = {
    bible: {
      title: '测试世界', tone: '苍凉', rules: [],
      places: [], factions: [],
      npcs: o.bibleNpcs || [{ name: '守夜人', role: '', desc: '' }],
      start: { place: '灰烬港', situation: '醒来', items: ['旧铜灯'] },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯', '无字信'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 1, life: 1,
  };
  if (o.npcProfiles) s.npcProfiles = o.npcProfiles;
  return s;
}

// 构造一个「已认识」的内部 profile（字段与 src/npcs.js blankProfile / promptBlock 对齐）。
function dossierProfile(o) {
  const x = o || {};
  const at = { turn: x.turn == null ? 1 : x.turn, life: 1, heroName: '旅人', clock: { day: 1, period: '黄昏' } };
  return {
    id: x.id || 'npc_watch',
    name: x.name || '守夜人',
    displayName: '', aliases: [], portraitName: x.name || '守夜人',
    original: {
      role: '更夫',
      desc: '提灯巡夜的老者，沉默寡言。',
      want: x.want || '守住钟声不乱',
      voice: '短句铁令，从不解释',
      internal: { motivation: '暗中护着钟楼里的某人' },
    },
    role: '更夫',
    description: '守夜人提灯拦住去路',
    voice: '短句铁令，从不解释',
    publicGoal: '',
    relationshipSummary: '曾在城门替旅人指过路',
    traits: { appearance: { 衣着: '旧斗篷' } },
    internal: { suspicion: x.internalSentinel || '对陌生人保持戒心' },
    initial: null,
    firstRecord: at, lastRecord: at, lastInteraction: at,
    latestExcerpt: x.excerpt || '守夜人提灯拦住去路',
    relationshipAt: at,
    attitude: 0,
    established: true,
  };
}

// 输出格式段里，JSON 例子必须以 {"narration": 开头（正文第一字段）。
function formatSection(systemContent) {
  return systemContent.slice(systemContent.indexOf('【输出格式】'));
}

// -------------------------------------------------------------------------
// 1. npc_updates 协议：随正文输出数组、narration 永远第一字段、SSE 正文优先
// -------------------------------------------------------------------------

test('TURN_OUTPUT_FORMAT：npc_updates 随正文输出为数组，narration 仍是第一字段（SSE 正文优先）', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style: 'v1' });
  const c = system.content;
  assert.ok(c.includes('"npc_updates":['), '输出格式列出 npc_updates 数组示例');
  const fmt = formatSection(c);
  const firstBrace = fmt.indexOf('{');
  assert.equal(fmt.slice(firstBrace, firstBrace + '{"narration":'.length), '{"narration":',
    'JSON 例子以 narration 开头');
  assert.ok(c.includes('narration 永远是输出的第一个字段'), '强制正文优先');
  assert.ok(c.includes('流式按正文优先边生成边推'), 'SSE 边生成边推');
  assert.ok(c.includes('npc_updates 只作补充，绝不挤到正文前面'), '补充字段不挤到正文前');
});

test('v2 派生格式继承 npc_updates，narration 仍为第一字段', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style: 'v2' });
  const c = system.content;
  assert.ok(c.includes('"npc_updates":['), 'v2 也带 npc_updates');
  const fmt = formatSection(c);
  const firstBrace = fmt.indexOf('{');
  assert.equal(fmt.slice(firstBrace, firstBrace + '{"narration":'.length), '{"narration":',
    'v2 的 JSON 例子仍以 narration 开头');
  assert.ok(c.includes('段落短、段数多'), 'v2 写法说明仍在');
  assert.ok(c.includes('npc_updates 必须随完整正文一并输出为数组'), 'v2 继承新协议说明');
});

test('TURN_OUTPUT_FORMAT：npc_updates 协议强调原文证据 / 不猜公开值 / 原始人设并存 / 非在场名单', () => {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  const c = system.content;
  const notes = [
    'npc_updates 必须随完整正文一并输出为数组',
    '没有新资料 / 无需登记就给空数组 []',
    '不强求每回合增资料 / 关系变化 / 人物成长',
    '须是 narration 的连续子串',
    '公共值一律摘自本回合原文',
    '不把后台设定 / 隐藏动机 / 模型猜测包装成玩家已知的身份或性格',
    '一时语气 / 情绪不能无缘由当成永久性格改变',
    '完整原始人设与后来的变化并存',
    '人物档案不是在场名单，也不是任务清单',
    '不得为凑资料插入未登场 / 不在当前场景的外人',
    '不得打断玩家、替玩家做决定',
    '前世的交情不等于新主角已经相识',
    '未来「可能 / 一年后」一律不得写成已发生事件',
    '本轮没有时间推进按钮 / API',
    'name 用 canonical 原名',
    '稳定 id 用来对应已有档案',
    '既有 npc_attitude / voice_hints / scene.cast 继续用原名字',
  ];
  for (const n of notes) assert.ok(c.includes(n), `协议说明应含：${n}`);
});

// -------------------------------------------------------------------------
// 1b. 第 3 轮返工：通用生成契约（真模型写出新外貌资料却整个省略 npc_updates）
//     「可选 / 省略」纠正为「随正文必须输出数组、无新资料给 []」，
//     并补正文写完后的一次资料核对；V2 由 TURN_OUTPUT_FORMAT 派生、自动继承。
// -------------------------------------------------------------------------

// 取指定写法（默认 v1 / v2）的 system 正文。
function turnSystem(style) {
  const [system] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style });
  return system.content;
}

// 新契约的关键指令行：v1 / v2 都必须出现。
const NPC_UPDATE_CONTRACT = [
  'npc_updates 必须随完整正文一并输出为数组',
  '没有新资料 / 无需登记就给空数组 []',
  '正文写完后做一次资料核对',
  '新披露了新人物、新外貌、稳定性格 / 能力 / 处境',
  '已公开的目标或承诺关系',
  '或某项明确变化',
  '就把该人的原文短语摘到 known 对应字段',
  'narration 的连续子串作 evidence',
  '原有未变项不必复述',
  '新值无需硬凑长摘要',
  'traits.appearance 下的「疤痕：原文短语」',
  '不要把情绪 / 一时动作当成永久性格',
  '隐藏设定不公开、不写进 known',
  '有真实新资料就登记进 npc_updates、没有就给 []',
  '不得反过来为填档案编剧情 / 造变化',
];

test('通用输出契约：正文写完后资料核对 + 有真实新资料必登记（v1 与 v2 都继承）', () => {
  for (const style of ['v1', 'v2']) {
    const c = turnSystem(style);
    for (const line of NPC_UPDATE_CONTRACT) {
      assert.ok(c.includes(line), `${style} 应含：${line}`);
    }
    // 旧措辞必须消失：模型不得再把「可选」误读成「有明显新特征也无需登记」。
    assert.equal(c.includes('npc_updates 是可选的人物长期档案更新'), false, `${style} 不再写「可选」`);
    assert.equal(c.includes('没有新资料就省略该字段或给空数组 []'), false, `${style} 不再以省略为主`);
  }
});

test('通用输出契约：narration 仍是第一字段，无变化给 []、不强迫变化（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const c = turnSystem(style);
    const fmt = formatSection(c);
    const firstBrace = fmt.indexOf('{');
    assert.equal(fmt.slice(firstBrace, firstBrace + '{"narration":'.length), '{"narration":',
      `${style} JSON 例子仍以 narration 开头`);
    assert.ok(c.includes('narration 永远是输出的第一个字段'), `${style} 正文第一`);
    assert.ok(c.includes('先自然写出完整正文，再写其他字段'), `${style} 先写完整正文再补档`);
    assert.ok(c.includes('没有新资料 / 无需登记就给空数组 []'), `${style} 无变化 []`);
    assert.ok(c.includes('没有就给 []'), `${style} 最终检查也要求空数组`);
    assert.ok(c.includes('没有新变化绝不可为填数组编造变化、强推关系、打断玩家或改变 NPC 意愿'),
      `${style} 无新变化不得编造 / 强推 / 打断 / 改意愿`);
    assert.ok(c.includes('不强求每回合增资料 / 关系变化 / 人物成长'), `${style} 不强求变化`);
    assert.ok(c.includes('不为填卡编造'), `${style} 缺资料不猜`);
    assert.ok(c.includes('不得打断玩家、替玩家做决定'), `${style} 玩家意图护栏仍在`);
  }
});

test('输出格式示例：单项外貌变化 + 正确结构，用通用「某人 / 新衣短语」，不绑定真实人物/伤疤/marker（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const fmt = formatSection(turnSystem(style));
    const line = fmt.split('\n').find((l) => l.indexOf('"npc_updates":[') >= 0);
    assert.ok(line, `${style} 有 npc_updates 示例`);
    // 单项外貌变化：kind=change 且只在 known.traits.appearance 放一对键值
    assert.ok(line.includes('"kind":"change"'), `${style} 示例是单项变化`);
    assert.ok(line.includes('"known":{"traits":{"appearance":{"衣着":"新衣短语"}}}'),
      `${style} 示例展示 appearance 单项外貌变化与正确结构`);
    // 正确结构：id / name / evidence / known 齐全
    assert.ok(line.includes('"id":"已存在的稳定 id'), `${style} 示例含稳定 id`);
    assert.ok(line.includes('"name":"某人"'), `${style} 示例用通用人物「某人」`);
    assert.ok(line.includes('"evidence":"本回合叙事里写到新衣着的原文短语'), `${style} 示例含 evidence`);
    // 不绑定这次真实证据 / 测试 marker
    for (const forbidden of ['林伯', '伤疤', '虎口', '腕根', 'MARKER']) {
      assert.equal(line.includes(forbidden), false, `${style} 示例不得含 ${forbidden}`);
    }
  }
});

test('通用最终输出检查：有真实新资料就登记、没有则 []，不得反过来编剧情填档案（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const c = turnSystem(style);
    assert.ok(c.includes('最终输出检查：有真实新资料就登记进 npc_updates、没有就给 []'),
      `${style} 有/无新资料两种情形都讲清`);
    assert.ok(c.includes('不得反过来为填档案编剧情 / 造变化'), `${style} 禁止为填档案造剧情`);
    assert.ok(c.includes('npc_updates 始终是补充，正文优先、第一个字段'), `${style} 正文优先不回退`);
  }
});

test('增量语义承接第 3 轮引擎：不变旧值可重复但不产生变化，新值须原文证据（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const c = turnSystem(style);
    assert.ok(c.includes('已接纳且未变化的旧值允许重复出现、但不产生任何变化'),
      `${style} 不变旧值不产生变化`);
    assert.ok(c.includes('真正的新值 / 变化必须有本回合叙事原文 evidence'),
      `${style} 新值须原文证据`);
    assert.ok(c.includes('这不要求把每个相同旧值都再逐字复述一遍'),
      `${style} 不误说每个相同旧值都要逐字复述`);
    assert.ok(c.includes('须是 narration 的连续子串'), `${style} 连续子串证据规则仍在`);
  }
});

test('通用契约不回退既有规则：玩家意图 / scene / voice_hints / suggestions / 宪法（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style });
    const c = system.content;
    assert.ok(c.includes('玩家意图优先'), `${style} 玩家意图优先`);
    assert.ok(c.includes('cast 只写名字'), `${style} scene.cast 原名规则`);
    assert.ok(c.includes('voice_hints 是可选的朗读提示'), `${style} voice_hints 规则`);
    assert.ok(c.includes('suggestions 固定给 3 条'), `${style} suggestions 规则`);
    assert.ok(c.includes('叙事必须与【时与地】'), `${style} 时与地一致规则`);
    assert.ok(c.includes('只输出一个 JSON 对象'), `${style} 宪法`);
    assert.ok(c.includes('narration 永远是输出的第一个字段'), `${style} 正文第一`);
    assert.ok(user.content.includes('探查'), `${style} 玩家本回合行动原样保留`);
  }
});

// -------------------------------------------------------------------------
// 1c. 第 4 轮返工：真实模型第 2 次把公共值概括 / 换词重组、并自造复合标签，
//     引擎已正确拒绝。这里把「逐值逐字复制连续子串」「标签沿用已有键 / 中性词」
//     写成明文契约并做格式回归；并用真实 npcs.applyNpcMemory 验证运行时
//     证据 / 标签验证一丝未放宽（不得为过验收迁就模型）。
// -------------------------------------------------------------------------

test('第 4 轮：逐值必须是 narration 单个连续子串、禁止概括 / 拼接 / 换词（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const c = turnSystem(style);
    for (const line of [
      '每一个「真正新增 / 变化」的公共文本值',
      '单个连续子串',
      '不得概括、换词、删词后重组、换词序',
      '把正文里相隔的几处拼成一句',
      '可以直接引用一整句可见描写，不必压成摘要',
      'evidence 是原文连续子串，并不代表 known 里其它字符串就合法',
      '每个 value 都要单独通过这项检查',
    ]) assert.ok(c.includes(line), `${style} 应含：${line}`);
  }
});

test('第 4 轮：标签沿用已有键 / 简单中性、禁复合自造标签、不泄露隐藏身份（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const c = turnSystem(style);
    for (const line of [
      '优先沿用当前档案里该人物已有的键',
      '简单中性标签',
      '「外貌」「衣着」「疤痕」「声音」「性格」「专长」「近况」「关系」',
      '标签本身不携带新事实、不泄露隐藏身份',
      '复合自造标签',
      '这类正文里并不存在的标签不应输出',
      '标签要么中性、要么逐字出现在 narration 里',
    ]) assert.ok(c.includes(line), `${style} 应含：${line}`);
  }
});

test('第 4 轮：通用原文→JSON 正确示例，值逐字取自正文、不绑定真实人物 / 物件 / marker（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const c = turnSystem(style);
    for (const line of [
      '原文→JSON 正确示例',
      '那人今日换了件灰袍，袖口磨得发白',
      '示例里的「值」必须真的出现在本回合正文',
      '切勿照抄示例凭空填值',
      '不要概括成「发白的旧灰袍」',
      '不要自造「灰袍袖口」',
    ]) assert.ok(c.includes(line), `${style} 应含：${line}`);
    // 通用示例不得引用这次真实测试的姓名 / 物件 / marker；只取示例所在几行核对。
    const exampleLines = c.split('\n').filter((l) => l.includes('灰袍') || l.includes('原文→JSON 正确示例'));
    const joined = exampleLines.join('\n');
    for (const forbidden of ['林伯', '绷带', '药草包', 'MARKER', 'QA-私密目标', '伤疤', '虎口', '腕根']) {
      assert.equal(joined.includes(forbidden), false, `${style} 通用示例不得含 ${forbidden}`);
    }
  }
});

test('第 4 轮：通用最终检查与 user 末行都逐字段核对，正文仍第一（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style });
    const c = system.content;
    const u = user.content;
    for (const line of [
      '逐字段检查',
      '每个 value 是本回合 narration 的连续子串',
      '标签是已有键 / 中性词',
      '真正新资料就按原文登记，无变化给 []，不得编剧情填档案',
      'narration 仍第一、正文先自然写完，不为 metadata 回头改写正文',
    ]) assert.ok(c.includes(line), `${style} 最终检查应含：${line}`);
    assert.ok(u.includes('逐字段核对'), `${style} user 末行含逐字段核对`);
    assert.ok(u.includes('value 是 narration 连续子串'), `${style} user 末行含逐值子串`);
    assert.ok(u.includes('无变化 []'), `${style} user 末行含无变化 []`);
    assert.ok(u.includes('正文第一、先写完正文再补档'), `${style} user 末行正文优先`);
    assert.ok(u.includes('请据此写出本回合叙事'), `${style} 落笔指令仍在`);
  }
});

test('第 4 轮不回退既有约束：正文第一 / 无变化不强求 / 玩家意图 / 行动原样（v1 与 v2）', () => {
  for (const style of ['v1', 'v2']) {
    const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style });
    const c = system.content;
    for (const line of [
      'narration 永远是输出的第一个字段',
      '先自然写出完整正文，再写其他字段',
      'npc_updates 只作补充，绝不挤到正文前面',
      '没有新变化绝不可为填数组编造变化、强推关系、打断玩家或改变 NPC 意愿',
      '不强求每回合增资料 / 关系变化 / 人物成长',
      '没有新资料 / 无需登记就给空数组 []',
      '玩家意图优先',
      '增量语义：已接纳且未变化的旧值允许重复出现、但不产生任何变化',
    ]) assert.ok(c.includes(line), `${style} 既有约束仍在：${line}`);
    assert.ok(user.content.includes('探查'), `${style} 玩家行动原样保留`);
  }
});

test('运行时验证不放宽：通用示例被接纳，概括值 / 复合自造标签仍被拒', () => {
  const base = makeState({ npcProfiles: { npc_watch: dossierProfile() } });
  const clone = () => JSON.parse(JSON.stringify(base));
  const narration = '守夜人今日换了件灰袍，袖口磨得发白，仍守着钟声。';
  const runOne = (update) => {
    const before = clone();
    const after = clone();
    after.turn = before.turn + 1;
    return npcs.applyNpcMemory(before, after, [update], { action: '探查', narration });
  };

  // 正确登记：每个 value 逐字是 narration 连续子串、标签中性、evidence 是该句连续子串。
  const good = runOne({
    name: '守夜人', kind: 'change',
    evidence: '守夜人今日换了件灰袍，袖口磨得发白',
    known: { traits: { appearance: { 衣着: '灰袍', 特征: '袖口磨得发白' } } },
  });
  assert.equal(good.rejected.length, 0, '合法逐值登记不应被拒');
  assert.ok(good.changes.length >= 1, '合法新值应产生 change');

  // 真实缺口形态：evidence 是原文（取自别处），value 概括拼接、标签自造复合词 → 仍整条拒绝。
  const badLabel = runOne({
    name: '守夜人', kind: 'change', evidence: '仍守着钟声',
    known: { traits: { appearance: { '灰袍绷带': '发白的旧灰袍' } } },
  });
  assert.ok(badLabel.rejected.length >= 1, '复合自造标签 / 概括值仍须被引擎拒绝');
  assert.match(badLabel.rejected.join('；'), /非中性|未在叙事原文出现/);

  // 即便标签中性，概括 / 换词重组后的 value 非连续子串，也仍被拒。
  const badValue = runOne({
    name: '守夜人', kind: 'change', evidence: '守夜人今日换了件灰袍',
    known: { traits: { appearance: { 衣着: '发白的旧灰袍' } } },
  });
  assert.match(badValue.rejected.join('；'), /未在本回合叙事原文出现/, '概括值仍因非连续子串被拒');
});

// -------------------------------------------------------------------------
// 2. buildTurnMessages 注入有界「相关人物档案」
// -------------------------------------------------------------------------

test('buildTurnMessages：有已知档案时注入有界「相关人物档案」，带原始人设/关系来源/内部标记与护栏', () => {
  const state = makeState({
    npcProfiles: { npc_watch: dossierProfile({ id: 'npc_watch', name: '守夜人' }) },
  });
  const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '向守夜人打听钟声');
  const c = system.content;
  assert.ok(c.includes('【相关人物档案（仅内部连续性参考）】'), '注入相关人物档案段');
  assert.ok(c.includes('人物记忆摘录，不代表在场'), '注明档案不代表在场');
  assert.ok(c.includes('NPC「守夜人」[npc_watch]'), '带稳定 id 的人物块');
  assert.ok(c.includes('[内部档案]原始形象'), '原始形象全文摘录');
  assert.ok(c.includes('[内部档案]原始动机'), '原始动机摘录');
  assert.ok(c.includes('守住钟声不乱'), '原始动机全文');
  assert.ok(c.includes('[内部状态]'), '内部状态标记');
  // 注入片段自带的护栏
  assert.ok(c.includes('绝不为凑字把不在场 / 无关的人写进本回合'));
  assert.ok(c.includes('玩家意图优先'));
  assert.ok(c.includes('隐藏动机 / 秘密只作内部参考'));
  assert.ok(c.includes('不得当成玩家已知事实写进叙事'));
  // 玩家意图原样保留，不被替做决定
  assert.ok(user.content.includes('向守夜人打听钟声'), '本回合行动原样保留');
});

test('buildTurnMessages：无已知档案 / 未登场人物时不注入档案段，普通 prompt 不凭空增长', () => {
  const [s1] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查');
  assert.equal(s1.content.includes('相关人物档案'), false, '无 npcProfiles 不加段');

  const notEstablished = makeState({
    npcProfiles: { npc_x: { ...dossierProfile(), established: false } },
  });
  const [s2] = prompts.buildTurnMessages(notEstablished, { nextTurn: 2 }, '探查');
  assert.equal(s2.content.includes('相关人物档案'), false, '未登场人物不注入');
});

test('相关人物档案片段有界：多人物只取相关少量，长历史被摘录而非整段塞入', () => {
  const profiles = {};
  const names = ['甲', '乙', '丙', '丁', '戊', '己'];
  for (const n of names) {
    // 每人给一段很长的「最近线索」，尾部打标记：有界片段只能摘录开头，不能把整段历史带进 prompt。
    const longExcerpt = `${n}旧事`.repeat(400) + `HISTORY_TAIL_${n}_MARKER`;
    profiles[`id_${n}`] = dossierProfile({ id: `id_${n}`, name: n, excerpt: longExcerpt });
  }
  const state = makeState({ npcProfiles: profiles });

  // 直接测 npcPromptContext 的有界性（引擎默认 ≤4 人、整体有界）。
  const ctx = npcs.npcPromptContext(state, '与甲交谈');
  assert.ok(ctx.length > 0);
  assert.ok(ctx.length <= 1600, `整体有界，实际 ${ctx.length}`);
  assert.ok((ctx.match(/NPC「/g) || []).length <= 4, '默认最多 4 人');
  assert.ok(ctx.includes('NPC「甲」'), '行动提到的人物优先');
  assert.equal(/HISTORY_TAIL/.test(ctx), false, '长历史被摘录，不带完整尾部');
  assert.ok(ctx.includes('摘录'), '长文本注明摘录');

  // 经 buildTurnMessages 注入后同样有界，不把 6 个人全塞进 prompt。
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 200 }, '与甲交谈');
  assert.ok((system.content.match(/NPC「/g) || []).length <= 4, '注入后仍最多 4 人');
  assert.equal(/HISTORY_TAIL/.test(system.content), false, '全量历史不进 prompt');
});

// -------------------------------------------------------------------------
// 3. 内部资料分层 / 既有接线不回退
// -------------------------------------------------------------------------

test('内部档案只进模型 prompt，不进公开状态；bible.want 不通过旁路泄露', () => {
  const state = makeState({
    bibleNpcs: [{ name: '守夜人', role: '更夫', desc: '提灯巡夜', want: 'SENTINEL_WANT_VALUE', voice: '短句铁令' }],
    npcProfiles: {
      npc_watch: dossierProfile({
        id: 'npc_watch', want: 'SENTINEL_WANT_VALUE', internalSentinel: 'SENTINEL_INTERNAL_VALUE',
      }),
    },
  });
  const [system] = prompts.buildTurnMessages(state, { nextTurn: 2 }, '向守夜人打听钟声');
  // 模型侧：档案连续性、内部资料、原始 want 都给模型作内部参考。
  assert.ok(system.content.includes('【相关人物档案'), '模型拿到档案连续性');
  assert.ok(system.content.includes('SENTINEL_INTERNAL_VALUE'), '内部状态给模型参考');
  assert.ok(system.content.includes('想要：SENTINEL_WANT_VALUE'), 'worldBibleText 把 want 给模型');
  // 公开状态：内部档案 / 原始 want / 隐藏动机 / 私有协议字段一律不出现。
  const pub = JSON.stringify(engine.toPublicState(state));
  assert.equal(pub.includes('SENTINEL_INTERNAL_VALUE'), false, '内部状态不泄露');
  assert.equal(pub.includes('SENTINEL_WANT_VALUE'), false, 'bible.want 不通过旁路泄露');
  assert.equal(pub.includes('npc_memory'), false, '无私 memory 字段');
  assert.equal(pub.includes('npc_updates'), false, '无私 updates 字段');
  assert.equal(pub.includes('"original"'), false, '无私 original 字段');
});

test('npc_updates 协议不回退既有字段：narration/数值/意图/TTS(voice_hints)/出图(scene.cast) 仍在', () => {
  const state = makeState({ npcProfiles: { npc_watch: dossierProfile() } });
  const action = '用旧铜灯照路，向守夜人打听钟声';
  const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 2 }, action);
  const c = system.content;
  for (const field of ['"narration"', '"state_diff"', '"npc_attitude"', '"suggestions"',
    '"voice_hints"', '"scene"', '"focus"', '"npc_updates"']) {
    assert.ok(c.includes(field), `输出格式仍含 ${field}`);
  }
  assert.ok(c.includes('cast 只写名字'), 'scene.cast 用原名规则仍在');
  assert.ok(c.includes('只输出一个 JSON 对象'), '宪法 / 正文优先仍在');
  assert.ok(c.includes('玩家意图优先'), '玩家意图优先护栏仍在');
  assert.ok(user.content.includes(action), '玩家本回合行动原样保留');
});
