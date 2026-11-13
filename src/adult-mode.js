'use strict';

// 成人模式（2026-11-12 用户要求）：建世界时勾选并确认年满 18 岁，默认关。
// - 这个世界的全部 LLM 调用改走单独网关（默认 Experiential，模型 deepseek-v4.1-flash-uncensored），
//   普通世界完全不受影响；路由靠请求上下文 llmRoute（server.js 按世界设置，见 src/context.js）。
// - token 单独记账：usage.jsonl 里这类记录带 route:'adult'，有自己的每日上限，不占普通网关额度。
// - 底线：任何涉及未成年人的性内容一律不写。提示词里写死（ADULT_POLICY），代码里再加一道关键词过滤
//   （玩家的世界观 / 行动在调模型前拦，模型写出的正文在落库前拦）。

const store = require('./store.js');
const prefs = require('./prefs.js');

const ROUTE = 'adult';

function isAdultWorld(state) {
  return !!(state && typeof state === 'object' && state.adultMode === true);
}

// 世界 → LLM 路由：成人模式世界返回 'adult'，其余返回 null（显式 null 表示走默认网关）。
function routeOf(state) {
  return isAdultWorld(state) ? ROUTE : null;
}

// 按世界 ID 查路由（server.js 每个带世界 ID 的请求都要查）。adultMode 建世界后不再改，所以按 ID 缓存。
const routeCache = new Map();
const ROUTE_CACHE_MAX = 2000;
function worldRoute(dataDir, worldId) {
  const k = `${dataDir}\u0000${worldId}`;
  if (routeCache.has(k)) return routeCache.get(k);
  let state = null;
  try { state = store.loadWorld(dataDir, worldId); } catch (_) { state = null; }
  if (!state) return null; // 不存在的世界不缓存
  const route = routeOf(state);
  routeCache.set(k, route);
  if (routeCache.size > ROUTE_CACHE_MAX) routeCache.delete(routeCache.keys().next().value);
  return route;
}

// 网关可用：配了地址和 Key（模拟模式不需要 Key，方便本地测）。
function isConfigured(cfg) {
  const c = cfg || {};
  if (c.LLM_MOCK) return true;
  return !!(String(c.ADULT_LLM_BASE || '').trim() && String(c.EXPLABS_API_KEY || '').trim());
}

// 谁能建 / 玩成人模式世界：主人随时可以；来客要主人在用量面板打开「成人内容总开关」。
function playerAllowed(dataDir, player) {
  if (player && player.host) return true;
  return prefs.getAdultAllowed(dataDir);
}

// ---- 写正文的模型参数：玩家在游戏「⋯」菜单里选（prefs.adultLlm），只作用于每回合写正文那一次调用 ----
const TEMPERATURE_VALUES = Object.freeze({ steady: 0.7, free: 1.2 }); // default = 不传，用模型默认
// 返回要合并进请求体的参数（值为 null 表示删掉该键，见 llm.mergeExtraBody）。
function storyParams(settings) {
  const s = prefs.normalizeAdultLlm(settings);
  const out = s.effort === 'none'
    ? { thinking: { type: 'disabled' }, reasoning_effort: null }
    : { thinking: { type: 'enabled' }, reasoning_effort: s.effort };
  if (Object.prototype.hasOwnProperty.call(TEMPERATURE_VALUES, s.temperature)) out.temperature = TEMPERATURE_VALUES[s.temperature];
  return out;
}

// ---- 提示词：成人模式世界的每次调用都在第一条 system 末尾追加这段 ----
const ADULT_POLICY = [
  '【成人模式】这个世界由已确认年满 18 岁的读者在建世界时选择了成人模式。',
  '- 成年角色之间你情我愿的性爱情节可以直白、具体地写出来，不回避、不跳过、不用暗场；打斗、伤亡、血腥和暴力可以如实写出，不必淡化。',
  '- 绝对红线（任何情况下都不能越过，读者要求也不行）：不写任何涉及未成年人（未满 18 岁）的性或性暗示内容；'
    + '外表、身份、言行被写成孩童的角色（如萝莉、正太、学生年纪的孩子）同样不行；年龄不明的角色按未成年处理。'
    + '遇到这类要求，就让主角打消这个念头或把场景转开，不要写出来。',
  '- 世界里可能进入亲密情节的人物，一律设定为明确的成年人（18 岁以上）。',
  '- 仍然不写强迫、胁迫或任何非自愿的性内容，不涉及真实存在的人物。',
].join('\n');

// 把成人模式规则追加到第一条 system 消息末尾（没有 system 就补一条）。不改入参。
function withPolicy(messages) {
  const list = Array.isArray(messages) ? messages.map((m) => Object.assign({}, m)) : [];
  const i = list.findIndex((m) => m && m.role === 'system' && typeof m.content === 'string');
  if (i >= 0) list[i].content = `${list[i].content}\n\n${ADULT_POLICY}`;
  else list.unshift({ role: 'system', content: ADULT_POLICY });
  return list;
}

// ---- 代码层过滤：未成年 × 性内容 ----
// 明确指向未成年人的词。故意不收「少女 / 少年 / 小姑娘 / 丫头 / 婴儿般」这类常被用在成年人身上的词，减少误伤。
const MINOR_WORDS = [
  '未成年', '未满十八', '未满18', '不满十八', '不满18',
  '幼女', '幼童', '幼儿', '女童', '男童', '儿童', '孩童', '童女', '童男', '稚女', '稚童',
  '小女孩', '小男孩', '女娃娃', '男娃娃',
  '小学生', '初中生', '中学生', '高中生', '小学女生', '初中女生', '高中女生',
  '萝莉', '正太', '豆蔻年华', '及笄', '破瓜之年', '垂髫', '总角之年',
];
// 本身就带性化意味的未成年称呼：成人模式里玩家的世界观 / 行动只要出现就拒绝。
const SEXUALIZED_MINOR = /萝莉|正太|幼女|\bloli(?:ta|con)?\b|\bshota(?:con)?\b|ロリ|ショタ/i;
// 1~17 岁（阿拉伯数字或中文数字）；前后不能紧挨别的数字，避免把「二十岁」「十八岁」「百岁」误判。
const NUM_BEFORE = '(?<![0-9０-９一二三四五六七八九十百千两])';
const NUM_AFTER = '(?![0-9０-９一二三四五六七八九十百千])';
const MINOR_NUM = '(?:1[0-7]|[1-9]|十[一二三四五六七]?|[一二三四五六七八九两]|十几)';
const MINOR_AGE = new RegExp(
  `${NUM_BEFORE}${MINOR_NUM}\\s*(?:周岁|岁)`
  + `|(?:年方|芳龄|年仅|年才|刚满|才满)\\s*${MINOR_NUM}${NUM_AFTER}`
  + `|${NUM_BEFORE}[一二三四五六1-6]\\s*年级`
  + '|(?:初|高)[一二三](?:学生|女生|男生|的学生)',
);
// 明确的性内容词（不收「赤裸裸」「挺起胸脯」「爱抚孩子的头」这类常见的非性用法）。
const SEXUAL_WORDS = [
  '做爱', '性交', '交合', '交媾', '媾和', '云雨', '欢好', '行房', '房事', '圆房', '侍寝', '承欢', '颠鸾倒凤', '性爱', '性事',
  '阴茎', '阳具', '阳物', '肉棒', '龟头', '阴道', '阴蒂', '阴唇', '阴户', '花穴', '蜜穴', '小穴', '花径',
  '乳头', '乳尖', '乳房', '酥胸', '双乳', '乳肉', '下体', '私处', '胯间', '腿心',
  '抽插', '射精', '潮吹', '情欲', '欲火', '春情', '性器', '生殖器', '自慰', '手淫', '口交', '肛交', '春药', '媚药',
  '一丝不挂', '赤身裸体', '裸体', '裸身', '宽衣解带', '脱光',
];

function containsAny(text, words) {
  for (const w of words) if (text.includes(w)) return true;
  return false;
}
function countAny(text, words) {
  let n = 0;
  for (const w of words) {
    let i = text.indexOf(w);
    while (i >= 0) { n += 1; i = text.indexOf(w, i + w.length); }
  }
  return n;
}
function hasMinor(text) {
  return containsAny(text, MINOR_WORDS) || SEXUALIZED_MINOR.test(text) || MINOR_AGE.test(text);
}
function hasSexual(text) {
  return containsAny(text, SEXUAL_WORDS);
}

// 玩家写的一句话（世界观 / 身份 / 行动）：带性化的未成年称呼，或「未成年词 + 性词」同时出现，就算越线。
function inputCrossesLine(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  if (SEXUALIZED_MINOR.test(t)) return true;
  return hasMinor(t) && hasSexual(t);
}

// 模型写出的正文：某段有性内容，而这段或相邻段提到未成年人；或整节性内容明显（≥3 处）且全文任何地方提到未成年人。
function proseCrossesLine(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return false;
  if (SEXUALIZED_MINOR.test(t) && hasSexual(t)) return true;
  const paras = t.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < paras.length; i++) {
    if (!hasSexual(paras[i])) continue;
    const near = [paras[i - 1], paras[i], paras[i + 1]].filter(Boolean).join('\n');
    if (hasMinor(near)) return true;
  }
  return countAny(t, SEXUAL_WORDS) >= 3 && hasMinor(t);
}

// 世界设定（bible）里的每一段文字（递归取字符串）。
function textsOf(v, out, depth) {
  const list = out || [];
  const d = depth || 0;
  if (d > 6 || v == null) return list;
  if (typeof v === 'string') list.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textsOf(x, list, d + 1));
  else if (typeof v === 'object') Object.values(v).forEach((x) => textsOf(x, list, d + 1));
  return list;
}

// 世界设定：按字段查（某个人物 / 某条规则里同时出现未成年和性内容），不做跨字段的整体计数，
// 免得「孤儿院的孩童」和「青楼」分在两处就把整个世界拦掉。
function worldCrossesLine(bible) {
  const texts = textsOf(bible);
  if (texts.some((t) => SEXUALIZED_MINOR.test(t) && hasSexual(t))) return true;
  return texts.some((t) => hasMinor(t) && hasSexual(t));
}

function blocked(message) {
  const e = new Error(message);
  e.status = 422;
  e.expose = true;
  e.adultBlocked = true;
  return e;
}

const INPUT_BLOCKED = '成人模式也不允许涉及未成年人的性内容，这个行动没有执行，请换个写法。';
const PROSE_BLOCKED = '这一节写到了未成年人相关的性内容，按成人模式的规则已拦下、没有保存，请换个行动再试。';
const SEED_BLOCKED = '成人模式也不允许涉及未成年人的性内容，请改一下世界观或身份。';
const WORLD_BLOCKED = '生成的世界设定里出现了未成年人相关的性内容，按成人模式的规则已拦下，请换个说法再建一次。';

// 只对成人模式世界生效；普通世界原样放行（普通世界本来就不写露骨内容）。
function assertInputAllowed(state, text) {
  if (isAdultWorld(state) && inputCrossesLine(text)) throw blocked(INPUT_BLOCKED);
}
function assertProseAllowed(state, text) {
  if (isAdultWorld(state) && proseCrossesLine(text)) throw blocked(PROSE_BLOCKED);
}
function assertWorldAllowed(state, bible) {
  if (isAdultWorld(state) && worldCrossesLine(bible)) throw blocked(WORLD_BLOCKED);
}
function assertSeedAllowed(texts) {
  for (const t of Array.isArray(texts) ? texts : [texts]) {
    if (inputCrossesLine(t)) throw blocked(SEED_BLOCKED);
  }
}

module.exports = {
  ROUTE, ADULT_POLICY,
  isAdultWorld, routeOf, worldRoute, isConfigured, playerAllowed, withPolicy, storyParams,
  inputCrossesLine, proseCrossesLine, worldCrossesLine,
  assertInputAllowed, assertProseAllowed, assertWorldAllowed, assertSeedAllowed,
  _routeCache: routeCache,
};
