'use strict';

const { PERSONA_DIMS, GENERIC_EVENT_THEMES, TWIST_GAP_MIN, INTERNAL_REJECT_TAG, ITEM_NAME_MAX, ITEM_INFO_DESC_MAX, ITEM_INFO_TYPE_MAX, PERSONA_INIT, OMEN_MIN_GAP, OMEN_MAX_GAP, RUMOR_MAX, SCENE_DESC_MAX, SCENE_PLACE_MAX, SCENE_NAME_MAX, SCENE_CAST_MAX, SCENE_ITEMS_MAX, SCENE_ACTION_MAX, FACT_TEXT_MAX, MARK_TEXT_MAX, THREAD_TEXT_MAX, PERIODS, MOVE_TO_MAX, TIME_PASSES_MIN, TIME_PASSES_MAX, TIME_PASSES_DEFAULT, TIME_SKIP_SPANS, TIME_SKIP_PLAN_MAX, DANGER_THRESHOLD, DEFAULT_VOICES } = require('./constants.js');

// 物品介绍消毒：只接受 allowedNames 里的名字（实际被接受的物品名），
// desc 去空白截 60 字、type 去空白截 6 字（可选）；无介绍文字的条目不落库。
// 纯函数，供建世界 / 回合 / 补介绍共用。
function cleanItemInfo(raw, allowedNames) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowed = new Set((Array.isArray(allowedNames) ? allowedNames : []).map((n) => String(n).trim()));
  for (const key of Object.keys(raw)) {
    const name = String(key).trim();
    if (!allowed.has(name)) continue;
    const v = raw[key];
    if (!v || typeof v !== 'object') continue;
    const desc = typeof v.desc === 'string' ? v.desc.trim().slice(0, ITEM_INFO_DESC_MAX) : '';
    if (!desc) continue;
    const entry = { desc };
    if (typeof v.type === 'string' && v.type.trim()) {
      entry.type = v.type.trim().slice(0, ITEM_INFO_TYPE_MAX);
    }
    out[name] = entry;
  }
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 规格「非整数取整」未指明方向，这里统一用四舍五入。
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// 把 rng() 归一到 [0,1)，避免恰好返回 1 时下标越界。
function unit(rng) {
  return clamp(Number(rng()), 0, 0.999999);
}

function internalReject(reason) {
  return `${INTERNAL_REJECT_TAG}${reason}`;
}

function isInternalReject(reason) {
  return typeof reason === 'string' && reason.startsWith(INTERNAL_REJECT_TAG);
}

// 是否处于「风声预兆」窗口：无进行中事件，且 nextEventTurn - turn 落在 1~2。
// 纯函数，供回合 prompt 判定与公开状态计算共用；对老存档缺字段也安全。
function computeOmen(state) {
  if (!state || typeof state !== 'object' || state.activeEvent) return false;
  const net = Number(state.nextEventTurn);
  const turn = Number(state.turn) || 0;
  if (!Number.isFinite(net)) return false;
  const gap = net - turn;
  return gap >= OMEN_MIN_GAP && gap <= OMEN_MAX_GAP;
}

// 濒死判定：体魄 ≤ DANGER_THRESHOLD 且仍在世时为 true。
// 纯函数；老存档缺字段 / 已死亡的待重生状态都安全返回 false。
function computeDanger(state) {
  const c = state && state.character;
  if (!c || c.alive === false || !c.attrs || typeof c.attrs !== 'object') return false;
  const body = Number(c.attrs['体魄']);
  return Number.isFinite(body) && body <= DANGER_THRESHOLD;
}

// 坊间传闻校验：非字符串 / 空串忽略，超过 40 字截断，返回可直接入库的文本（无则 ''）。
function normalizeRumor(value) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (!t) return '';
  return t.slice(0, RUMOR_MAX);
}

// 名字列表校验：字符串数组，去空白、去重、每条截到 12 字，最多 max 条。
function normalizeSceneNames(value, max) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const name = v.trim().slice(0, SCENE_NAME_MAX);
    if (!name || out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

// 场景插图校验：只列名字（place / cast / items）与动作氛围（action），外貌交给已有参考图。
// desc 给定时照旧去空白并截断；没给定时用 place + action 拼（去掉空部分）。
// draw 仅 raw.draw === true 才为 true，forced 为 true 且存在 desc 时强制 draw=true。
// 返回 {draw:true, desc, place, cast, items, action} 或 {draw:false}。
function normalizeScene(raw, forced) {
  if (!raw || typeof raw !== 'object') return { draw: false };
  const place = typeof raw.place === 'string' ? raw.place.trim().slice(0, SCENE_PLACE_MAX) : '';
  const action = typeof raw.action === 'string' ? raw.action.trim().slice(0, SCENE_ACTION_MAX) : '';
  const cast = normalizeSceneNames(raw.cast, SCENE_CAST_MAX);
  const items = normalizeSceneNames(raw.items, SCENE_ITEMS_MAX);
  const desc = (typeof raw.desc === 'string'
    ? raw.desc.trim()
    : [place, action].filter(Boolean).join('，')).slice(0, SCENE_DESC_MAX);
  if (!desc) return { draw: false };
  const draw = raw.draw === true || forced === true;
  if (!draw) return { draw: false };
  const out = { draw: true, desc, place, cast, items, action };
  const en = normalizeSceneEn(raw, cast);
  if (en) out.en = en;
  return out;
}

// 给画师看的英文画面（记账模型直接写，省掉事后那次自由翻译）：
// place 地方、light 光线气氛、people 每个人「看上去是谁 + 此刻在做什么」和站位。
// 只收纯英文短句（带汉字、过长的整项丢掉）；who 必须是 cast 里的名字。什么都没有时返回 null（走老的翻译链路）。
const SCENE_EN_POS = ['left', 'center', 'right', 'background'];
function cleanSceneEn(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/["'`“”‘’]/g, '').replace(/\s+/g, ' ').trim().replace(/[.;,\s]+$/, '');
  if (!t || /[^\x20-\x7e]/.test(t) || t.length > max) return '';
  return t;
}
function normalizeSceneEn(raw, cast) {
  const place = cleanSceneEn(raw.place_en, 120);
  const light = cleanSceneEn(raw.light_en, 80);
  const people = [];
  for (const p of (Array.isArray(raw.people) ? raw.people : [])) {
    if (!p || typeof p !== 'object' || people.length >= SCENE_CAST_MAX) continue;
    const who = typeof p.who === 'string' ? p.who.trim().slice(0, SCENE_NAME_MAX) : '';
    const en = cleanSceneEn(p.en, 160);
    if (!who || !en || !cast.includes(who) || people.some((x) => x.who === who)) continue;
    const pos = typeof p.pos === 'string' && SCENE_EN_POS.includes(p.pos.trim().toLowerCase()) ? p.pos.trim().toLowerCase() : '';
    people.push({ who, en, pos });
  }
  if (!place && !people.length) return null;
  return { place, light, people };
}

// 事实校验：非字符串 / 空串忽略，超过 30 字截断，返回可直接入库的文本（无则 ''）。
function normalizeFact(value) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (!t) return '';
  return t.slice(0, FACT_TEXT_MAX);
}

// 印记校验：非字符串 / 空串忽略，超过 16 字截断，返回可直接入库的文本（无则 ''）。
function normalizeMark(value) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (!t) return '';
  return t.slice(0, MARK_TEXT_MAX);
}

// 线索校验：非字符串 / 空串忽略，超过 20 字截断，返回可直接入库的文本（无则 ''）。
function normalizeThread(value) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  if (!t) return '';
  return t.slice(0, THREAD_TEXT_MAX);
}

// move_to 校验：≤12 字，且必须是 bible.places 里的名字或本回合叙事里新出现的地点名。
// 返回合法地点名，非法时返回 ''（原地不动）。
function normalizeMoveTo(state, value, narration) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || name.length > MOVE_TO_MAX) return '';
  const places = state && state.bible && Array.isArray(state.bible.places) ? state.bible.places : [];
  const known = places.some((p) => p && typeof p.name === 'string' && p.name === name);
  if (known) return name;
  if (typeof narration === 'string' && narration.includes(name)) return name;
  return '';
}

// time_passes 校验：0~2 的整数，缺省 / 非法值回退默认 1。
function normalizeTimePasses(value) {
  if (value == null) return TIME_PASSES_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return TIME_PASSES_DEFAULT;
  return clamp(Math.round(n), TIME_PASSES_MIN, TIME_PASSES_MAX);
}

// 时光推进参数校验：非法参数一律返回 null，绝不改动入参。
// span 必须是 TIME_SKIP_SPANS 的键；plan 去控制字符 / 去首尾空白 / 截到上限，非字符串为 ''。
function normalizeTimeSkip(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const span = raw.span;
  if (typeof span !== 'string' || !Object.prototype.hasOwnProperty.call(TIME_SKIP_SPANS, span)) {
    return null;
  }
  const def = TIME_SKIP_SPANS[span];
  let plan = '';
  if (typeof raw.plan === 'string') {
    plan = raw.plan.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, TIME_SKIP_PLAN_MAX);
  }
  return { span, days: def.days, label: def.label, plan };
}

// 朗读提示校验：只保留合法条目，最多 8 条；坏数据一律丢弃/回退，绝不影响回合。
// para 必须是非负整数（否则整条丢弃）；mood/pace 非法或缺省一律回退 calm/normal；
// speaker 仅在该段是 NPC 台词时给（字符串、去空白、截 24 字），旁白段不输出该字段。
const VOICE_HINT_MOODS = ['calm', 'tense', 'sad', 'joyful', 'angry', 'mysterious'];
const VOICE_HINT_PACES = ['slow', 'normal', 'fast'];
function normalizeVoiceHints(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const h of value) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    if (!Number.isInteger(h.para) || h.para < 0) continue;
    const hint = {
      para: h.para,
      mood: VOICE_HINT_MOODS.includes(h.mood) ? h.mood : 'calm',
      pace: VOICE_HINT_PACES.includes(h.pace) ? h.pace : 'normal',
    };
    if (typeof h.speaker === 'string') {
      const s = h.speaker.trim().slice(0, 24);
      if (s) hint.speaker = s;
    }
    out.push(hint);
    if (out.length >= 8) break;
  }
  return out;
}

// 按推进时段数滚动 clock；返回全新对象，不改入参。
function advanceClock(clock, passes) {
  const c = clock && typeof clock === 'object' ? clock : {};
  let day = Number.isInteger(c.day) && c.day >= 1 ? c.day : 1;
  let idx = PERIODS.indexOf(c.period);
  if (idx < 0) idx = 0;
  const total = idx + clamp(toInt(passes), TIME_PASSES_MIN, TIME_PASSES_MAX);
  day += Math.floor(total / PERIODS.length);
  const period = PERIODS[total % PERIODS.length];
  return { day, period };
}

// 老存档兼容：读取时补齐新增字段的默认值，缺字段的世界不报错。
// 纯函数，返回新对象；不改动入参。各玩法新增字段在此集中补默认。
function normalizeState(state) {
  const s = cloneState(state || {});
  if (typeof s.pendingEventTheme !== 'string' || !s.pendingEventTheme) s.pendingEventTheme = null;
  if (typeof s.rebirthOpening !== 'string') s.rebirthOpening = '';
  // 老存档缺物品介绍：补空表，接口 /items 会按需补生成。
  if (!s.itemInfo || typeof s.itemInfo !== 'object' || Array.isArray(s.itemInfo)) s.itemInfo = {};
  // NPC 长期档案：老存档缺字段补默认，且不 require npcs 模块（避免循环 require）。
  // npcMemoryVersion 缺省为 0 = 旧档「需要回填」标记；绝不在此伪标为当前版本，
  // 真正的回填由 loadState 调 hydrateNpcMemory(state, events) 完成。
  if (!s.npcProfiles || typeof s.npcProfiles !== 'object' || Array.isArray(s.npcProfiles)) s.npcProfiles = {};
  if (!Number.isInteger(s.npcMemoryVersion) || s.npcMemoryVersion < 0) s.npcMemoryVersion = 0;
  if (!Array.isArray(s.rumors)) s.rumors = [];
  if (!Array.isArray(s.pastLives)) s.pastLives = [];
  if (!Array.isArray(s.facts)) s.facts = [];
  if (!Array.isArray(s.threads)) s.threads = [];
  if (!Array.isArray(s.fadedThreads)) s.fadedThreads = [];
  // 导演机制 / 越界累计：老存档缺字段时补默认，避免 undefined 参与比较或 NaN 扩散。
  if (!Number.isInteger(s.sceneStreak) || s.sceneStreak < 0) s.sceneStreak = 0;
  if (!Number.isInteger(s.lastTwistTurn) || s.lastTwistTurn < 0) s.lastTwistTurn = 0;
  if (!Number.isInteger(s.nextTwistTurn) || s.nextTwistTurn < 0) {
    const baseTurn = Number.isInteger(s.turn) && s.turn >= 0 ? s.turn : 0;
    s.nextTwistTurn = baseTurn + TWIST_GAP_MIN + 3; // 老存档给一个合理间隔，不立刻触发
  }
  if (!Number.isInteger(s.oversteps) || s.oversteps < 0) s.oversteps = 0;
  // 玩家意图 / 成人标记：老存档缺字段补默认，避免 undefined 参与 quiet 判定。
  if (!FOCUS_VALUES.includes(s.focus)) s.focus = 'action';
  if (typeof s.continuing !== 'boolean') s.continuing = false;
  if (typeof s.adult !== 'boolean') s.adult = false;
  if (s.character && typeof s.character === 'object' && !Array.isArray(s.character.marks)) {
    s.character.marks = [];
  }
  // 老存档 NPC 无 voice：按序补彼此不同的默认口吻，保证回合 prompt 的语言指纹段有具体可依的内容。
  if (s.bible && Array.isArray(s.bible.npcs)) {
    s.bible.npcs = s.bible.npcs.map((n, idx) => {
      if (!n || typeof n !== 'object' || (typeof n.voice === 'string' && n.voice.trim())) return n;
      const base = DEFAULT_VOICES[idx % DEFAULT_VOICES.length];
      return Object.assign({}, n, {
        voice: idx >= DEFAULT_VOICES.length ? `${base}·${idx + 1}` : base,
      });
    });
  }
  if (typeof s.location !== 'string' || !s.location) {
    const start = s.bible && s.bible.start;
    s.location = start && typeof start.place === 'string' ? start.place : '';
  }
  const c = s.clock && typeof s.clock === 'object' ? s.clock : {};
  s.clock = {
    day: Number.isInteger(c.day) && c.day >= 1 ? c.day : 1,
    period: PERIODS.includes(c.period) ? c.period : PERIODS[0],
  };
  return s;
}

// eventThemes 少于 4 个时用通用主题补齐（过滤无效项、去重）。
function normalizeEventThemes(themes) {
  const valid = (Array.isArray(themes) ? themes : [])
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim());
  if (valid.length >= 4) return valid;
  const out = valid.slice();
  for (const g of GENERIC_EVENT_THEMES) {
    if (!out.includes(g)) out.push(g);
  }
  return out;
}

function cloneState(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function freshPersona() {
  const p = {};
  for (const dim of PERSONA_DIMS) p[dim] = PERSONA_INIT;
  return p;
}

// 从 bible.start.items 提取 ≤3 个合法起始物品（字符串、去空白、≤12 字、去重）。
function startingItems(bible) {
  const start = bible && typeof bible === 'object' ? bible.start : null;
  const raw = start && Array.isArray(start.items) ? start.items : [];
  const out = [];
  for (const it of raw) {
    if (typeof it !== 'string') continue;
    const name = it.trim();
    if (!name || name.length > ITEM_NAME_MAX || out.includes(name)) continue;
    out.push(name);
    if (out.length >= 3) break;
  }
  return out;
}

// 从 bible.start.facts 提取 ≤3 条开局关键时间/规则事实（如「满月在三日后」）。
// 用与事实账本一致的校验（非空字符串、≤30 字、去重），以 {turn:0, text} 写入 state.facts，
// 使开局时间线/规则成为叙事必须遵守、不得改写的客观事实。
function startingFacts(bible) {
  const start = bible && typeof bible === 'object' ? bible.start : null;
  const raw = start && Array.isArray(start.facts) ? start.facts : [];
  const out = [];
  for (const it of raw) {
    const text = normalizeFact(it);
    if (!text || out.some((f) => f.text === text)) continue;
    out.push({ turn: 0, text });
    if (out.length >= 3) break;
  }
  return out;
}

// 重生时给 1 个符合世界观的基础物品：取世界自身起始物品的首个，无则兜底。
function baseItem(bible) {
  const items = startingItems(bible);
  return items.length ? items[0] : '旧行囊';
}

// npcAttitude 初始化为 bible.npcs 每人 0；显式传入的取值可覆盖。
function initialNpcAttitude(bible, provided) {
  const out = {};
  const npcs = bible && Array.isArray(bible.npcs) ? bible.npcs : [];
  for (const n of npcs) {
    if (n && typeof n.name === 'string' && n.name.trim()) out[n.name.trim()] = 0;
  }
  return Object.assign(out, provided && typeof provided === 'object' ? provided : {});
}

// 序章规范化：四字段都必须是非空字符串，各自去空白并截断；
// 任一字段缺失 / 非字符串 / 去空白后为空 → 返回 null（整段作废）。
function normalizePrologue(raw) {
  const limits = { world: 240, me: 200, goal: 120, now: 160 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of ['world', 'me', 'goal', 'now']) {
    if (typeof raw[key] !== 'string') return null;
    const t = raw[key].trim().slice(0, limits[key]);
    if (!t) return null;
    out[key] = t;
  }
  return out;
}

// 兜底清理：模型把 voice「总在句尾提问」当成口头禅标签，在台词末尾硬贴
// 「，问？」「，说：」等机械尾巴。只清理中文引号「…」内、紧贴结束引号的
// 这几种固定模式；引号外旁白与其它正常文字一律不动。纯函数。
function cleanDialogueTics(text) {
  if (typeof text !== 'string' || !text.includes('」')) return text;
  return text.replace(/「([^」]*)」/g, (_full, inner) => {
    // 「，说：」「，答：」「，道：」：删掉这个分句，不加问号。
    const sayTail = /[，、]\s*(?:说|答|道)\s*[：:]\s*$/;
    if (sayTail.test(inner)) {
      return '「' + inner.replace(sayTail, '') + '」';
    }
    // 「，问？」「，问?」「、问？」：删掉这个分句并确保句末是问号；
    // 原句末已有句号/问号/省略号则不重复加（避免「？，问？」出现双问号）。
    const askTail = /[，、]\s*问\s*[？?]\s*$/;
    if (askTail.test(inner)) {
      let body = inner.replace(askTail, '');
      if (!/[。？！…!?]$/.test(body)) body += '？';
      return '「' + body + '」';
    }
    return '「' + inner + '」';
  });
}

// 玩家意图字段校验：focus 只能取白名单之一，非法 / 缺省当 action；
// continuing 仅 true 为真，其余（含字符串 / 数字 / 缺省）当 false。
// 入参为整份提议（含 focus / continuing），返回可直接入库的 {focus, continuing}。
const FOCUS_VALUES = Object.freeze(['action', 'explore', 'travel', 'social', 'private', 'rest', 'intimate']);
const QUIET_FOCUS = Object.freeze(['social', 'private', 'rest', 'intimate']);
function normalizeFocus(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    focus: FOCUS_VALUES.includes(src.focus) ? src.focus : 'action',
    continuing: src.continuing === true,
  };
}

// 成人内容标记：仅布尔 true 为真，其余当 false。
function normalizeAdult(value) {
  return value === true;
}

module.exports = {
  clamp,
  cleanDialogueTics,
  cleanItemInfo,
  toInt,
  unit,
  internalReject,
  isInternalReject,
  computeOmen,
  computeDanger,
  FOCUS_VALUES,
  QUIET_FOCUS,
  normalizeFocus,
  normalizeAdult,
  normalizeRumor,
  normalizeScene,
  normalizeFact,
  normalizeMark,
  normalizeThread,
  normalizeMoveTo,
  normalizeTimePasses,
  normalizeTimeSkip,
  normalizeVoiceHints,
  advanceClock,
  normalizeState,
  normalizeEventThemes,
  cloneState,
  freshPersona,
  startingItems,
  startingFacts,
  baseItem,
  initialNpcAttitude,
  normalizePrologue,
};
