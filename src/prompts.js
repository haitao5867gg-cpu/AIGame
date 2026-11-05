'use strict';

// 第 5 节：所有 prompt 模板 + JSON 解析。
// 只组装字符串 / 消息数组，是纯函数：不联网、不读写文件、不调用引擎。
// 回合 prompt 恒定由「宪法 + 锁定 bible + 当前状态 + 最近 2 章 + 最近 6 回合 + 条件片段」组成，
// 近期记录有上限，因此不随回合数增长（约 3K token 量级）。

function section(title, body) {
  return `【${title}】\n${body}`;
}

const CONSTITUTION = [
  '你是「无限世界」的叙事引擎，只负责写第二人称叙事与提议状态变化。',
  '铁律：',
  '- 只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 文字。',
  '- 用第二人称「你」叙述，永远不替玩家做决定、不替玩家说话。',
  '- 不改写、不新增、不否定下面锁定的世界设定（bible）。',
  '- 世界没有主线也没有结局，永不结束；不要写「终章」「完结」。',
  '- 不要说破、点名或解释任何隐藏目标；隐藏线索只能通过传闻、机会、NPC 态度隐晦暗示。',
  '- 你的状态变化只是「提议」，真正的数值由后端引擎裁定，可能与你提议的不同，叙事不要依赖数值一定生效。',
].join('\n');

const TURN_OUTPUT_FORMAT = [
  '输出 JSON 格式（字段固定，数组可为空）：',
  '{"narration":"第二人称叙事，10~1200 字",',
  ' "state_diff":{"心智":1},',
  ' "items_add":[],"items_remove":[],',
  ' "npc_attitude":{"某人":1},',
  ' "persona_tags":["冒险"],',
  ' "suggestions":["可选项一","可选项二","可选项三"],',
  ' "event":{"title":"事件标题","desc":"事件描述"},',
  ' "event_check":{"attr":"体魄","response_quality":2}}',
  '说明：',
  '- event 仅在「本回合需要开启事件」时出现，否则不要输出该字段。',
  '- event_check 仅在「本回合需要结算事件」时出现；response_quality 为 0~3 整数，据实评价玩家应对；',
  '  attr 只能是 体魄/心智/魅力/气运/声望/资源 之一。',
].join('\n');

const WORLD_OUTPUT_FORMAT = [
  '输出 JSON：',
  '{"bible":{"title":...,"tone":...,"rules":[str],"places":[{name,desc}],',
  ' "factions":[{name,desc,stance}],"npcs":[{name,role,desc}],',
  ' "start":{"place","situation"},"eventThemes":[str x6]},',
  ' "apex":{"title":...,"hint":...,"condition":{"attrs":{"声望":30}}}}',
  '要求：名词具体、有张力、起点明确；eventThemes 给 6 个符合世界观的大事类型；',
  'apex 是玩家不可见的隐藏长期目标，condition.attrs 用 体魄/心智/魅力/气运/声望/资源 中的键与可达阈值。',
].join('\n');

function worldBibleText(bible) {
  const b = bible || {};
  const places = (b.places || []).map((p) => `${p.name}：${p.desc || ''}`).join('；');
  const factions = (b.factions || []).map((f) => `${f.name}（${f.stance || ''}）：${f.desc || ''}`).join('；');
  const npcs = (b.npcs || []).map((n) => `${n.name}（${n.role || ''}）：${n.desc || ''}`).join('；');
  return [
    `标题：${b.title || ''}`,
    `基调：${b.tone || ''}`,
    `规则：${(b.rules || []).join('；')}`,
    `地点：${places}`,
    `势力：${factions}`,
    `人物：${npcs}`,
    `起点：${(b.start && b.start.place) || ''} — ${(b.start && b.start.situation) || ''}`,
    `事件主题：${(b.eventThemes || []).join('、')}`,
  ].join('\n');
}

function characterText(state) {
  const c = state.character || {};
  const attrs = Object.entries(c.attrs || {}).map(([k, v]) => `${k}:${v}`).join(' ');
  const attitude = Object.entries(state.npcAttitude || {}).map(([k, v]) => `${k}:${v}`).join(' ');
  return [
    `姓名：${c.name || '（无名）'}；形象：${c.appearance || ''}`,
    `属性：${attrs}`,
    `物品：${(c.items || []).join('、') || '无'}`,
    `NPC 态度：${attitude || '无记录'}`,
  ].join('\n');
}

function recentText(state) {
  const rec = state.recent || [];
  if (!rec.length) return '（尚无近期记录）';
  return rec.map((r) => `#${r.turn} 行动：${r.action} / 叙事：${r.narration}`).join('\n');
}

function chronicleText(state) {
  const ch = (state.chronicle || []).slice(-2);
  if (!ch.length) return '（尚无编年史）';
  return ch.map((c) => `第${c.chapter}章（${c.fromTurn}-${c.toTurn}）：${c.summary}`).join('\n');
}

// 回合：返回 OpenAI chat/completions 的 messages 数组。
function buildTurnMessages(state, plan, action) {
  const p = plan || {};
  const nextTurn = p.nextTurn || (state.turn || 0) + 1;

  const sys = [];
  sys.push(CONSTITUTION);
  sys.push(section('锁定的世界设定（只读，不得改写）', worldBibleText(state.bible)));

  // 隐晦提示：apex.hint，只要求通过传闻 / 机会 / NPC 态度暗示，绝不点破。
  const hint = state.apex && state.apex.hint;
  if (hint) {
    sys.push(section('隐晦线索（绝不点破）',
      `有一条隐藏线索：「${hint}」。只通过传闻、偶发的机会、NPC 微妙的态度去暗示它，` +
      '禁止直接说明、命名或解释它代表什么，也不要把它写成任务或目标。'));
  }

  // 高光期：写法提示，但不说破原因。
  if (state.highlightUntilTurn > 0 && nextTurn <= state.highlightUntilTurn) {
    sys.push(section('写法提示',
      '本回合值得写一段克制的高光时刻：气氛更浓、留白更多，但不要说破原因，也不要宣布达成任何目标。'));
  }

  // 事件中：开启事件 / 结算事件说明。
  if (p.opening) {
    sys.push(section('本回合要求：开启事件',
      `引擎已排定开启一个世界性事件，主题是「${p.theme}」。请在输出里给出 event:{title,desc}，` +
      '把这桩大事写进叙事，但把应对留给玩家下一回合。'));
  } else if (p.settling && state.activeEvent) {
    const ev = state.activeEvent;
    sys.push(section('本回合要求：结算事件',
      `进行中的事件：「${ev.title}」（${ev.theme}）— ${ev.desc}。` +
      '玩家本回合的行动将用于结算，请输出 event_check:{attr,response_quality}，据实评价玩家应对（0~3）。' +
      '事件回合玩家不可回避。'));
  }

  sys.push(section('输出格式', TURN_OUTPUT_FORMAT));

  const user = [
    section('当前状态', characterText(state)),
    section('最近两章编年史', chronicleText(state)),
    section('最近六回合', recentText(state)),
    section('玩家本回合的行动', String(action == null ? '' : action) || '（未填写，自由行动）'),
    '请据此写出本回合叙事与提议，只输出 JSON。',
  ].join('\n\n');

  return [
    { role: 'system', content: sys.join('\n\n') },
    { role: 'user', content: user },
  ];
}

// 建世界：输入玩家一句话，输出 bible + apex。
function buildWorldMessages(seed, input) {
  const i = input || {};
  const system = [
    '你是「无限世界」的开局架构师，只输出一个 JSON 对象（bible + apex），不要任何解释文字。',
    CONSTITUTION,
    WORLD_OUTPUT_FORMAT,
  ].join('\n\n');
  const user = [
    `玩家的一句话世界观：${String(seed == null ? '' : seed)}`,
    `主角姓名：${i.name || '（由玩家稍后决定）'}；形象：${i.appearance || ''}`,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 编年史压缩：把若干回合压成 ≤300 字一章，输出 {summary}。
function buildChapterMessages(state, events) {
  const system = [
    '你是「无限世界」的编年史官，只输出一个 JSON 对象：{"summary":"不超过 300 字的一章摘要"}。',
    '把给定的若干回合压缩成一段连贯的中文编年史，保留关键转折与人物，不要编造未发生之事，不要输出解释文字。',
  ].join('\n');
  const lines = (events || [])
    .map((e) => `#${e.turn}（第${e.life}世）行动：${e.action} / ${e.narration || ''}`)
    .join('\n');
  const user = `以下是需要压缩的回合记录：\n${lines || '（无）'}\n\n请输出 {"summary":"..."}。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 新顶点：玩家不可见，输出一个新的 apex（不含 achievedAt / generation，由引擎补齐）。
function buildApexMessages(state) {
  const system = [
    '你是「无限世界」的隐藏目标设计师，只输出一个 JSON 对象，不要解释文字。',
    '为这个世界设计一个新的、玩家不可见的长期隐藏目标（apex）。',
    '输出：{"title":...,"hint":...,"condition":{"attrs":{"声望":N}}}，可加 "npc":{"name":...,"minAttitude":M}。',
    'condition.attrs 的键只能是 体魄/心智/魅力/气运/声望/资源；阈值应高于当前属性、可达但需长期经营。',
    'hint 是一句可借传闻 / 机会 / NPC 态度暗示的线索，不要直接写出条件本身。',
  ].join('\n');
  const user = [
    section('世界设定', worldBibleText(state.bible)),
    section('当前属性', characterText(state)),
    section('上一代隐藏目标（仅作避免重复之参考，勿复述给玩家）',
      `title：${(state.apex && state.apex.title) || ''}；generation：${(state.apex && state.apex.generation) || 1}`),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 解析：去掉 ```json 包裹、截取第一个 { 到最后一个 }；失败返回 null。
function parseJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

module.exports = {
  buildTurnMessages,
  buildWorldMessages,
  buildChapterMessages,
  buildApexMessages,
  parseJson,
};
