'use strict';

// ---- NPC 长期人物档案：纯数据层 ----
//
// 纯函数：不读文件、不联网、不改入参（内部先深拷贝）。随机数 / 时间都不用。
// 只依赖 node 内置 crypto 与 ./event-log.js，刻意不 require 任何 engine/* 模块，
// 避免与 util.normalizeState / view / turn 产生循环 require。
//
// 数据模型：
//   state.npcProfiles[id] = 内部 profile（含 original / internal / 记录 / established）
//   state.npcMemoryVersion = 版本号（< CURRENT 表示旧档，需要回填）
//   events.jsonl 每条可带私有 npc_memory（applyNpcMemory 产出的 changes），
//     完整历史（出场 / 共同经历 / 旧值新值）以 canonical 可见事件为唯一来源，
//     state 里的 profile 只是「当前态」缓存，不滚动截断历史。
//
// 公开投影（publicNpcProfiles / getNpcHistory / publicBibleNpcs）是严格白名单，
// 绝不带出 original / internal / want / 隐藏动机 / apex 等私有资料。

const crypto = require('crypto');
const { visibleEventEntries } = require('./event-log.js');

// ---- 常量 ----
const NPC_MEMORY_VERSION = 1;

const TRAIT_CATEGORIES = Object.freeze([
  'identity', 'appearance', 'personality', 'abilities', 'circumstances', 'relationships',
]);
const PUBLIC_SCALARS = Object.freeze([
  'role', 'description', 'voice', 'publicGoal', 'relationshipSummary',
]);
const KINDS = Object.freeze(['interaction', 'mention', 'change']);
// displayName / aliases 是只读身份数据，本轮不接纳任何更新（不做改名 / 串身份引擎）。
const UPDATE_KEYS = new Set([
  'id', 'name', 'kind', 'evidence', 'known', 'internal', 'portraitName',
]);

// 新 profile 文本值：允许长值，但超过合理上限整条更新拒绝（不静默截断）。
const NPC_FIELD_MAX = 2000;
const NPC_EVIDENCE_MAX = 1200;
const NPC_LABEL_MAX = 24;
const NPC_NAME_MAX = 40;
const NPC_EXCERPT_MAX = 80;
const NPC_UPDATES_MAX = 6;

const HISTORY_LIMIT_DEFAULT = 20;
const HISTORY_LIMIT_MAX = 50;
const NPC_PROMPT_MAX_NPCS = 4;
const NPC_PROMPT_MAX_CHARS = 2000;
// 每个 NPC 的提示词总预算：按字段分配，长原始描述不会吞掉关系 / 当前变化 / 身份。
const NPC_PROMPT_PER_NPC_CHARS = 360;
// 玩家行动里明确提到的人物优先级必须高于任意大的最近 turn（固定 +1000 过 1000 回合会失效）。
const NPC_PROMPT_MENTION_WEIGHT = 1e15;
// 提示词各字段独立预算（高优先字段在前，超预算的低优先字段跳过而非整块截断）。
const PROMPT_FIELD_CAPS = Object.freeze({
  identity: 48, current: 90, publicGoal: 48, relationship: 120, recent: 64,
  origImage: 64, origWant: 48, voice: 36, description: 48, internal: 72,
});
// 上一回合焦点承接代词：已公开角色在叙事用代词承接时仍算本回合相关。
const CONTINUATION_PRONOUNS = Object.freeze(['他', '她', '它', '对方', '那人', '此人']);

const DEFAULT_PERIOD = '清晨';

// 公开 bible.npcs 白名单：保留身份 / 形象 / 音色字段（图片队列从公开状态读取
// role/desc/voice 生成头像，不能删），过滤掉 want 等隐藏动机以及任何未知私有字段。
// 玩家「已知档案」来自叙事证据（npcProfiles），绝不从这里整体搬 desc/want。
const BIBLE_PUBLIC_FIELDS = Object.freeze([
  'name', 'displayName', 'aliases', 'role', 'desc', 'look', 'voice', 'portraitName',
]);

// 常见中性属性名：特征标签要么在白名单里，要么在叙事原文中出现，
// 避免用标签本身（如「暗中动机」）泄露秘密。
const NEUTRAL_LABELS = new Set([
  '身份', '职业', '名号', '称谓', '出身', '来历', '种族', '年纪', '年龄',
  '外貌', '相貌', '容色', '身形', '体态', '身高', '衣着', '穿着', '装束',
  '衣饰', '发型', '发色', '眼神', '目光', '神情', '气质', '特征', '标记',
  '疤痕', '旧伤', '伤', '声音', '声线', '口音', '口吻', '语气', '口癖',
  '习惯', '癖好', '性格', '性情', '性子', '脾气', '秉性', '态度', '立场',
  '专长', '能力', '本事', '武艺', '武功', '法术', '技能', '技艺', '武器',
  '兵器', '法宝', '处境', '近况', '现状', '行踪', '去向', '处境',
  '关系', '交情', '渊源', '牵绊', '承诺', '约定', '债务', '恩怨', '立场',
  '目标', '心愿', '职务', '职责', '阵营', '归属',
]);

// ---- 基础工具 ----

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function safeKey(k) {
  return typeof k === 'string' && k.length > 0
    && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// 外部传入的 id / npcId 必须是安全的字典键，防止 __proto__ 等造成原型污染/串档。
function safeIdRef(id) {
  return typeof id === 'string' && id.length > 0
    && id !== '__proto__' && id !== 'constructor' && id !== 'prototype';
}

// 稳定 id：world id + 首次 canonical name 的确定性 hash。与好感 / 特征 / 描述无关，
// 不随更新变化；portraitName 取 canonical name，沿用现有头像缓存 key。
function stableId(worldId, name) {
  const h = crypto.createHash('sha1')
    .update(String(worldId || '') + String.fromCharCode(0) + String(name))
    .digest('hex');
  return 'npc_' + h.slice(0, 16);
}

function emptyTraits() {
  const t = {};
  for (const c of TRAIT_CATEGORIES) t[c] = {};
  return t;
}

function blankProfile(spec) {
  const s = spec || {};
  return {
    id: s.id,
    name: s.name || '',
    displayName: '',
    aliases: [],
    portraitName: s.portraitName || s.name || '',
    original: deepClone(s.original || {}), // 完整原始对象，深拷贝，后续 patch 不覆盖
    role: '', description: '', voice: '', publicGoal: '', relationshipSummary: '',
    traits: emptyTraits(),
    internal: {},        // 私有 flat map（motivation 等）
    initial: null,       // 首次公开出场快照 {role,description,voice,traits}
    firstRecord: null,
    lastRecord: null,
    lastInteraction: null,
    latestExcerpt: '',
    relationshipAt: null, // 私有：关系摘要最后更新的 at（不改公共 shape）
    attitude: 0,
    established: false,  // 是否已有公开开场 / 真实叙事记录
  };
}

function profileNames(p) {
  const out = new Set();
  if (p && typeof p.name === 'string' && p.name) out.add(p.name);
  if (p && typeof p.displayName === 'string' && p.displayName) out.add(p.displayName);
  if (p && Array.isArray(p.aliases)) {
    for (const a of p.aliases) if (typeof a === 'string' && a) out.add(a);
  }
  return out;
}

// 返回 [{id, profile}]，可能多个（歧义 / 冲突由调用方拒绝）。
function profilesMatchingName(profiles, name) {
  const out = [];
  for (const id of Object.keys(profiles || {})) {
    const p = profiles[id];
    if (p && typeof p === 'object' && profileNames(p).has(name)) out.push({ id, profile: p });
  }
  return out;
}

function readAttitude(state, name) {
  const a = state && state.npcAttitude;
  if (a && typeof a === 'object' && typeof name === 'string' && Number.isFinite(a[name])) return a[name];
  return 0;
}

// 版本达标但 profile 的 original 缺失 / 损坏时，从世界设定里按 canonical name 取回
// 完整原始对象，供 hydrate 的 seed 重建（只进内部，绝不倒灌到公开投影）。
function seedOriginal(p, state) {
  if (isPlainObject(p.original) && Object.keys(p.original).length) return p.original;
  const s = isPlainObject(state) ? state : {};
  const bibleNpcs = (isPlainObject(s.bible) && Array.isArray(s.bible.npcs)) ? s.bible.npcs : [];
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  for (const n of bibleNpcs) {
    if (isPlainObject(n) && typeof n.name === 'string' && name && n.name.trim() === name) return n;
  }
  return isPlainObject(p.original) ? p.original : { name: name || '' };
}

// 给 bible.npcs / npcAttitude 里出现但尚无 profile 的名字建基线（仅补缺）。
// original 对 bible NPC 取完整对象（含 desc/want/voice，不截断），动态 NPC 取最小 {name}。
function ensureBaselines(state) {
  const s = state;
  if (!isPlainObject(s.npcProfiles)) s.npcProfiles = {};
  const bibleNpcs = (s.bible && Array.isArray(s.bible.npcs)) ? s.bible.npcs : [];
  const byName = {};
  for (const n of bibleNpcs) {
    if (n && typeof n.name === 'string' && n.name.trim()) byName[n.name.trim()] = n;
  }
  const attitude = isPlainObject(s.npcAttitude) ? s.npcAttitude : {};
  const names = new Set(Object.keys(byName));
  for (const k of Object.keys(attitude)) if (k) names.add(k);
  for (const name of names) {
    if (!name || typeof name !== 'string') continue;
    if (profilesMatchingName(s.npcProfiles, name).length) continue;
    const id = stableId(s.id, name);
    if (s.npcProfiles[id]) continue;
    const original = byName[name] ? deepClone(byName[name]) : { name };
    s.npcProfiles[id] = blankProfile({ id, name, portraitName: name, original });
  }
  return s;
}

// ---- 字段读写（结构化，不用易碎的 path 字符串解析） ----

function getFieldValue(p, scope, kind, key, label) {
  if (scope === 'internal') return p.internal && p.internal[key];
  if (kind === 'scalar') return p[key];
  if (kind === 'trait') return (p.traits && p.traits[key]) ? p.traits[key][label] : undefined;
  return undefined;
}

function setFieldValue(p, scope, kind, key, label, value) {
  if (typeof value !== 'string') return;
  if (scope === 'internal') {
    if (!isPlainObject(p.internal)) p.internal = {};
    if (safeKey(key)) p.internal[key] = value;
    return;
  }
  if (kind === 'scalar') {
    if (PUBLIC_SCALARS.includes(key)) p[key] = value;
    return;
  }
  if (kind === 'trait' && TRAIT_CATEGORIES.includes(key) && safeKey(label)) {
    if (!isPlainObject(p.traits)) p.traits = emptyTraits();
    if (!isPlainObject(p.traits[key])) p.traits[key] = {};
    p.traits[key][label] = value;
  }
}

function fieldLabel(f) {
  if (f.kind === 'trait') return `traits.${f.key}.${f.label}`;
  if (f.scope === 'internal') return `internal.${f.key}`;
  return String(f.key || '');
}

function snapshotInitial(p) {
  return {
    role: p.role || '',
    description: p.description || '',
    voice: p.voice || '',
    traits: deepClone(isPlainObject(p.traits) ? p.traits : emptyTraits()),
  };
}

// ---- at / Record ----

// 时间 / 主角名 / 世数取 beforeState；未知项留空 / null，不填第 0 日或虚构时段。
function atRecord(before, after) {
  const c = (before && isPlainObject(before.character)) ? before.character : {};
  const clk = (before && isPlainObject(before.clock)) ? before.clock : {};
  return {
    turn: Number.isInteger(after.turn) ? after.turn : (Number(before && before.turn) || 0) + 1,
    life: Number.isInteger(before && before.life) ? before.life : null,
    heroName: typeof c.name === 'string' && c.name ? c.name : '',
    clock: {
      day: Number.isInteger(clk.day) ? clk.day : null,
      period: typeof clk.period === 'string' && clk.period ? clk.period : '',
    },
  };
}

// 旧事件 / 未知时间：缺项一律留空 / null，绝不补 day=0、life=1 或虚构时段。
function normalizeAt(at, record) {
  const a = isPlainObject(at) ? at : {};
  const r = record || {};
  const c = isPlainObject(a.clock) ? a.clock : {};
  return {
    turn: Number.isInteger(a.turn) ? a.turn : (Number.isInteger(r.turn) ? r.turn : null),
    life: Number.isInteger(a.life) ? a.life : (Number.isInteger(r.life) ? r.life : null),
    heroName: typeof a.heroName === 'string' ? a.heroName : '',
    clock: {
      day: Number.isInteger(c.day) ? c.day : null,
      period: typeof c.period === 'string' ? c.period : '',
    },
  };
}

// 从事件已存字段找当时主角姓名（npc_memory[].at.heroName / record.heroName）。
function storedHeroName(record) {
  const r = isPlainObject(record) ? record : {};
  if (typeof r.heroName === 'string' && r.heroName) return r.heroName;
  const memory = Array.isArray(r.npc_memory) ? r.npc_memory : [];
  for (const m of memory) {
    if (isPlainObject(m) && isPlainObject(m.at) && typeof m.at.heroName === 'string' && m.at.heroName) {
      return m.at.heroName;
    }
  }
  return '';
}

// 从 state.pastLives 找某一世的当时主角姓名；找不到返回 ''（未知）。
// 绝不把本次主角（state.character.name）代入上一世。
function heroNameFromPastLives(state, life) {
  if (life === null || life === undefined) return '';
  const lives = state && Array.isArray(state.pastLives) ? state.pastLives : [];
  for (const pl of lives) {
    if (isPlainObject(pl) && pl.life === life && typeof pl.name === 'string' && pl.name) return pl.name;
  }
  return '';
}

// 一条事件的规范 at：死亡旧日志优先 death.life；heroName 来自已存字段 / pastLives；
// changeAt（私有 npc_memory[].at）有值时优先其已知时间，否则保持未知。
function canonicalAt(record, state, changeAt) {
  const r = isPlainObject(record) ? record : {};
  const death = isPlainObject(r.death) ? r.death : null;
  const base = isPlainObject(changeAt) ? changeAt : {};
  const life = death && Number.isInteger(death.life) ? death.life
    : (Number.isInteger(base.life) ? base.life
    : (Number.isInteger(r.life) ? r.life : null));
  let heroName = typeof base.heroName === 'string' ? base.heroName : '';
  if (!heroName) heroName = storedHeroName(r);
  if (!heroName) heroName = heroNameFromPastLives(state, life);
  return normalizeAt({
    turn: Number.isInteger(base.turn) ? base.turn : r.turn,
    life,
    heroName,
    clock: base.clock,
  }, r);
}

function establishRecord(p, at, kind, evidence, action) {
  if (!p.established) {
    p.established = true;
    p.firstRecord = deepClone(at);
    p.initial = snapshotInitial(p); // 首次出场快照：只记已知，缺项留空
  }
  p.lastRecord = deepClone(at); // 所有相关经历（含听闻消息 / 变化）都推进
  // lastInteraction 只由明确 interaction 更新：change/mention 可能只是听闻，未必当面互动。
  if (kind === 'interaction') p.lastInteraction = deepClone(at);
  if (typeof evidence === 'string' && evidence) p.latestExcerpt = evidence.slice(0, NPC_EXCERPT_MAX);
  // action 仅用于 history 展示，profile 本身不存
}

function excerptFromNarration(narration, name) {
  const i = typeof name === 'string' ? narration.indexOf(name) : -1;
  const start = i > 20 ? i - 20 : 0;
  return narration.slice(start, start + NPC_EXCERPT_MAX);
}

// ---- 校验 npc_updates 的 known / internal ----

function isAcceptableLabel(label, narration) {
  if (NEUTRAL_LABELS.has(label)) return true;
  return typeof narration === 'string' && narration.includes(label);
}

// 返回 { ok, specs, knownObj, internalObj, error }。specs 为 {scope,kind,key,label,to} 列表。
// 公开新值（known 的 scalar / trait 值）必须可在本回合叙事原文中引用（摘自原文短语）：
// evidence 真实不等于所有字段都真实，不能凭一句合法 evidence 就把私密 want / 猜测身份写进公开档案。
// internal 是私有资料，不受「摘自原文」限制。
function validateKnownInternal(u, narration, currentProfile) {
  const specs = [];
  const knownObj = { traits: emptyTraits() };
  const internalObj = {};

  if (u.known !== undefined) {
    if (!isPlainObject(u.known)) return { error: 'known 不是对象' };
    for (const key of PUBLIC_SCALARS) {
      if (!Object.prototype.hasOwnProperty.call(u.known, key)) continue;
      const v = u.known[key];
      if (typeof v !== 'string') return { error: `known.${key} 非字符串` };
      const t = v.trim();
      if (!t) continue; // 空值不擦旧资料
      if (t.length > NPC_FIELD_MAX) return { error: `known.${key} 超过 ${NPC_FIELD_MAX} 字，拒绝` };
      specs.push({ scope: 'public', kind: 'scalar', key, to: t });
      knownObj[key] = t;
    }
    if (u.known.traits !== undefined) {
      if (!isPlainObject(u.known.traits)) return { error: 'known.traits 不是对象' };
      for (const cat of Object.keys(u.known.traits)) {
        if (!TRAIT_CATEGORIES.includes(cat)) return { error: `未知特征分类「${cat}」` };
        const m = u.known.traits[cat];
        if (!isPlainObject(m)) return { error: `known.traits.${cat} 不是对象` };
        for (const label of Object.keys(m)) {
          const v = m[label];
          if (typeof v !== 'string') return { error: `traits.${cat}.${label} 非字符串` };
          const t = v.trim();
          if (!t) continue;
          if (t.length > NPC_FIELD_MAX) return { error: `traits.${cat}.${label} 超过 ${NPC_FIELD_MAX} 字，拒绝` };
          if (!safeKey(label) || label.length > NPC_LABEL_MAX || label.includes('.')) {
            return { error: `特征标签「${label}」非法` };
          }
          // 已接纳并公开的同分类、同键旧标签：键名本身无需每回合在正文再出现
          // （如已登记的「头发」，本回合用「白发」等新值描述即可）。只信当前 public
          // traits 里已 own、字符串非空的旧键，不信 original / internal / 别的 NPC 或
          // 本条新提议；新标签仍走中性词表 / 原文字面校验，新值仍须是原文连续子串。
          const acceptedPublicLabel = currentProfile
            && safeKey(label)
            && isPlainObject(currentProfile.traits)
            && isPlainObject(currentProfile.traits[cat])
            && hasOwn(currentProfile.traits[cat], label)
            && typeof currentProfile.traits[cat][label] === 'string'
            && currentProfile.traits[cat][label].length > 0;
          if (!acceptedPublicLabel && !isAcceptableLabel(label, narration)) {
            return { error: `特征标签「${label}」非中性且未在叙事原文出现` };
          }
          specs.push({ scope: 'public', kind: 'trait', key: cat, label, to: t });
          knownObj.traits[cat][label] = t;
        }
      }
    }
  }

  if (u.internal !== undefined) {
    if (!isPlainObject(u.internal)) return { error: 'internal 不是对象' };
    for (const key of Object.keys(u.internal)) {
      const v = u.internal[key];
      if (typeof v !== 'string') return { error: `internal.${key} 非字符串` };
      const t = v.trim();
      if (!t) continue;
      if (t.length > NPC_FIELD_MAX) return { error: `internal.${key} 超过 ${NPC_FIELD_MAX} 字，拒绝` };
      if (!safeKey(key) || key.length > NPC_LABEL_MAX) return { error: `internal 键「${key}」非法` };
      specs.push({ scope: 'internal', kind: 'scalar', key, to: t });
      internalObj[key] = t;
    }
  }

  // 公开值必须摘自本回合叙事原文，不能把私密标记 / 猜测身份包装成玩家已知。
  // 例外：本条 update 里「已经接纳且未变化」的相同旧值无需再复述原文——它本回合
  // 不产生任何字段变化，不能因夹带旧值就挡掉同条里真正变化、且已原文举证的新资料。
  // 新值 / 变化值仍严格按原文举证；internal 私有值不受此规则约束。
  for (const spec of specs) {
    if (spec.scope !== 'public') continue;
    if (currentProfile) {
      const from = getFieldValue(currentProfile, spec.scope, spec.kind, spec.key, spec.label);
      const cur = (from === undefined || from === null) ? '' : from;
      if (cur === spec.to) continue; // 已接纳且未变化：不必再原文复述
    }
    if (!narration.includes(spec.to)) {
      return { error: `公开值「${spec.to}」未在本回合叙事原文出现（拒绝私密/猜测资料）` };
    }
  }

  return { ok: true, specs, knownObj, internalObj };
}

function collectClaimedNames(u) {
  const out = [];
  if (typeof u.name === 'string' && u.name.trim()) out.push(u.name.trim());
  // displayName / aliases 本轮不接纳更新：只读身份数据仅供搜索，不在此收集。
  return out;
}

// 动态新 NPC 的原始基线：保留首次接受的完整 known 与 internal 原始资料，
// 后续更新绝不覆盖此基线（applyOneUpdate 只在 isNew 时设置一次）。
function buildDynamicOriginal(name, knownObj, internalObj) {
  return deepClone({
    name,
    role: knownObj.role || '',
    description: knownObj.description || '',
    voice: knownObj.voice || '',
    publicGoal: knownObj.publicGoal || '',
    relationshipSummary: knownObj.relationshipSummary || '',
    traits: knownObj.traits,
    internal: internalObj || {},
  });
}

// ---- 解析单条 update 指向的 profile ----

function resolveProfile(u, state, narration) {
  const profiles = state.npcProfiles;
  const worldId = state.id || '';

  if (u.id !== undefined) {
    if (typeof u.id !== 'string' || !u.id.trim() || !safeIdRef(u.id)) return { error: 'id 非法' };
    if (!hasOwn(profiles, u.id) || !isPlainObject(profiles[u.id])) {
      return { error: '未知角色 id（拒绝未登场/未知人物）' };
    }
    const p = profiles[u.id];
    if (typeof u.name === 'string' && u.name.trim() && !profileNames(p).has(u.name.trim())) {
      return { error: 'id 与 name 指向不同角色（拒绝改名/串档）' };
    }
    for (const nm of collectClaimedNames(u)) {
      if (profilesMatchingName(profiles, nm).some((m) => m.id !== p.id)) {
        return { error: `名字「${nm}」与他人冲突（拒绝串人）` };
      }
    }
    return { id: p.id, profile: p, isNew: false };
  }

  if (typeof u.name !== 'string' || !u.name.trim()) return { error: '缺少 name / id，无法定位人物' };
  const name = u.name.trim();
  if (name.length > NPC_NAME_MAX) return { error: 'name 过长' };
  const matches = profilesMatchingName(profiles, name);
  if (matches.length > 1) return { error: `名字「${name}」有歧义，拒绝合并` };
  if (matches.length === 1) {
    const found = matches[0];
    for (const nm of collectClaimedNames(u)) {
      if (profilesMatchingName(profiles, nm).some((m) => m.id !== found.id)) {
        return { error: `名字「${nm}」与他人冲突（拒绝串人）` };
      }
    }
    return { id: found.id, profile: found.profile, isNew: false };
  }

  // 全新人物：名字必须在本回合叙事里真实出现，且不与任何现有 id 冲突。
  if (!narration.includes(name)) return { error: '新人物名字未在本回合叙事中出现（拒绝未登场演员）' };
  const id = stableId(worldId, name);
  if (profiles[id]) return { error: 'id/name 冲突（拒绝串人）' };
  return { id, name, isNew: true };
}

// ---- 人物相关性 ----

function lastRecordTurn(p) {
  // 按最新相关经历判断上一回合相关性：lastRecord 记录所有经历（含听闻消息 / 变化），
  // lastInteraction 只记明确互动。取两者最大 turn，与 promptScore 一致，避免「很久前互动、
  // 刚有新消息」的人被按旧互动回合误判为与上一回合无关。lastInteraction 本身不变，听闻不成互动。
  const li = p.lastInteraction && Number.isInteger(p.lastInteraction.turn) ? p.lastInteraction.turn : null;
  const lr = p.lastRecord && Number.isInteger(p.lastRecord.turn) ? p.lastRecord.turn : null;
  if (li === null) return lr;
  if (lr === null) return li;
  return Math.max(li, lr);
}

// 本回合必须真实提及该角色（名字在叙事 / 当前动作里），或为上一回合焦点的已公开角色承接代词。
// 未公开 NPC 没有代词承接豁免：不能凭已知 id 建立公开档案，也不能批量更改无关远方 NPC。
function characterPresent(names, narration, action, established, lastTurn, beforeTurn) {
  for (const nm of names) {
    if (nm && (narration.includes(nm) || action.includes(nm))) return true;
  }
  if (established && lastTurn !== null && Number.isInteger(beforeTurn) && lastTurn === beforeTurn) {
    for (const pron of CONTINUATION_PRONOUNS) {
      if (narration.includes(pron) || action.includes(pron)) return true;
    }
  }
  return false;
}

// ---- 单条 update 应用 ----

function applyOneUpdate(u, state, before, after, ctx) {
  if (!isPlainObject(u)) return { error: '条目不是对象' };
  for (const k of Object.keys(u)) {
    if (!UPDATE_KEYS.has(k)) return { error: `未知字段「${k}」（未来预测/私有字段不接纳）` };
  }

  const narration = typeof ctx.narration === 'string' ? ctx.narration : '';
  const action = typeof ctx.action === 'string' ? ctx.action : '';
  let ev = typeof u.evidence === 'string' ? u.evidence.trim() : '';
  if (!ev) return { error: '缺少 evidence（拒绝缺证据）' };
  if (ev.length > NPC_EVIDENCE_MAX) return { error: 'evidence 过长' };
  if (!narration.includes(ev)) return { error: 'evidence 不是本回合叙事原文片段' };

  let kind = u.kind;
  if (kind === undefined) kind = 'mention'; // 缺字段不报错，保守当「提及」
  else if (!KINDS.includes(kind)) return { error: 'kind 非法' };

  // 先定位档案：判断「已接纳且未变化的旧值」需读取当前档案值。
  // resolveProfile 为纯查找，不改 state；放在校验前不改变任何准入/拒绝结果。
  const resolved = resolveProfile(u, state, narration);
  if (resolved.error) return { error: resolved.error };

  const currentProfile = resolved.isNew ? null : resolved.profile;
  const validated = validateKnownInternal(u, narration, currentProfile);
  if (validated.error) return { error: validated.error };

  // 人物相关性：拒绝未登场 / 无关远方 NPC 的公开档案与批量更改。
  const names = resolved.isNew ? [resolved.name] : Array.from(profileNames(resolved.profile));
  const established = resolved.isNew ? false : resolved.profile.established === true;
  const lastTurn = resolved.isNew ? null : lastRecordTurn(resolved.profile);
  const beforeTurn = Number.isInteger(before && before.turn) ? before.turn : null;
  if (!characterPresent(names, narration, action, established, lastTurn, beforeTurn)) {
    return { error: '人物本回合未被真实提及（拒绝未登场/无关远方 NPC）' };
  }

  let p;
  if (resolved.isNew) {
    const original = buildDynamicOriginal(resolved.name, validated.knownObj, validated.internalObj);
    p = blankProfile({ id: resolved.id, name: resolved.name, portraitName: resolved.name, original });
    state.npcProfiles[resolved.id] = p;
    // 补中立 npcAttitude 键供既有头像流程识别，绝不重置任何原有数值。
    if (!isPlainObject(state.npcAttitude)) state.npcAttitude = {};
    if (!hasOwn(state.npcAttitude, resolved.name)) state.npcAttitude[resolved.name] = 0;
  } else {
    p = resolved.profile;
  }

  const at = atRecord(before, after);
  // 增量合并：只改明确给出且有变化的字段，记录旧值/新值；未给项与 original 保留。
  const fields = [];
  for (const spec of validated.specs) {
    const from = getFieldValue(p, spec.scope, spec.kind, spec.key, spec.label);
    const cur = (from === undefined || from === null) ? '' : from;
    if (cur === spec.to) continue; // 无实际变化，不作为一次变化记录
    const f = {
      scope: spec.scope, kind: spec.kind, key: spec.key,
      from: cur, to: spec.to,
    };
    if (spec.label !== undefined) f.label = spec.label;
    fields.push(f);
    setFieldValue(p, spec.scope, spec.kind, spec.key, spec.label, spec.to);
    if (spec.scope === 'public' && spec.kind === 'scalar' && spec.key === 'relationshipSummary') {
      p.relationshipAt = deepClone(at); // 私有：关系最后更新 at，不改公共 shape
    }
  }

  establishRecord(p, at, kind, ev, ctx.action);
  p.attitude = readAttitude(state, p.name);

  const change = {
    id: p.id,
    name: p.name,
    kind,
    evidence: ev,
    action: typeof ctx.action === 'string' ? ctx.action : '',
    at,
    fields, // 含 public + internal，仅私有事件保存；公开历史会过滤 internal
  };
  if (resolved.isNew) {
    // 动态新 NPC 的原始基线，供 hydrate 在 state 缺 profile 时精确重建（含 internal）。
    change.baseline = {
      original: deepClone(p.original),
      displayName: p.displayName,
      aliases: deepClone(p.aliases),
      portraitName: p.portraitName,
    };
  }
  return { change };
}

// ---- 契约接口 ----

// 新世界：建立 bible.npcs / npcAttitude 基线（完整 original），标记已迁移。
function initializeNpcMemory(state) {
  const s = deepClone(state || {});
  s.npcProfiles = {};
  s.npcMemoryVersion = NPC_MEMORY_VERSION;
  ensureBaselines(s);
  return s;
}

// 旧格式：补齐字段默认，保持「需要回填」标记（version < CURRENT），
// 绝不提前把 version 伪标成 CURRENT。幂等，不改入参。
function normalizeNpcMemory(state) {
  const s = deepClone(state || {});
  if (!isPlainObject(s.npcProfiles)) s.npcProfiles = {};
  if (!Number.isInteger(s.npcMemoryVersion) || s.npcMemoryVersion < 0) s.npcMemoryVersion = 0;
  return s;
}

// 已知角色基线名：bible.npcs / npcAttitude 里出现过的名字，应各自有一份完整 profile。
function knownBaselineNames(state) {
  const s = isPlainObject(state) ? state : {};
  const names = new Set();
  const bibleNpcs = (isPlainObject(s.bible) && Array.isArray(s.bible.npcs)) ? s.bible.npcs : [];
  for (const n of bibleNpcs) {
    if (isPlainObject(n) && typeof n.name === 'string' && n.name.trim()) names.add(n.name.trim());
  }
  if (isPlainObject(s.npcAttitude)) {
    for (const k of Object.keys(s.npcAttitude)) if (k) names.add(k);
  }
  return names;
}

// 一份结构完整的 profile：身份 + 完整 original + 结构化 traits / internal + 公开标记。
// 缺任一项视为「结构缺失 / 损坏」，需要由 canonical 事件回填修复。
function isProfileStructureSound(p) {
  return isPlainObject(p)
    && typeof p.id === 'string' && p.id.length > 0
    && typeof p.name === 'string' && p.name.length > 0
    && isPlainObject(p.original)
    && isPlainObject(p.traits)
    && isPlainObject(p.internal)
    && typeof p.established === 'boolean';
}

function baselineProfilesSound(state) {
  const s = isPlainObject(state) ? state : {};
  if (!isPlainObject(s.npcProfiles)) return false;
  for (const name of knownBaselineNames(s)) {
    const matches = profilesMatchingName(s.npcProfiles, name);
    if (!matches.some((m) => isProfileStructureSound(m.profile))) return false;
  }
  return true;
}

// 旧格式（version < CURRENT）需要回填；版本达标但基线角色的 profile 结构缺失 / 损坏
// （例如旧工具只写了版本号、却漏写 / 写坏了 npcProfiles）时同样需要回填，而非仅看版本号。
// 有效新版 current 档案保持「不需回填」，避免读路径反复全角色全史重建已接纳的当前特征。
function needsNpcHydration(state) {
  const s = isPlainObject(state) ? state : {};
  const v = Number.isInteger(s.npcMemoryVersion) ? s.npcMemoryVersion : 0;
  if (v < NPC_MEMORY_VERSION) return true;
  return knownBaselineNames(s).size > 0 && !baselineProfilesSound(s);
}

// 纯回填：以 canonical 可见事件为唯一来源，重建当前 profile 与记录。
// 内部复用 visibleEventEntries（撤回旧分支被排除，不复活）；幂等、不写盘。
// 每条事件同时处理 npc_memory（typed）与叙事原文（legacy / 混合），逐角色回退，不漏人。
function hydrateNpcMemory(state, rawEvents) {
  const s = deepClone(state || {});
  ensureBaselines(s);

  // seeds：保留身份 + 完整 original；派生字段（known/internal/记录）一律从事件重建。
  const seeds = {};
  for (const id of Object.keys(s.npcProfiles)) {
    const p = s.npcProfiles[id];
    if (!isPlainObject(p)) continue;
    seeds[id] = {
      id,
      name: typeof p.name === 'string' ? p.name : '',
      displayName: typeof p.displayName === 'string' ? p.displayName : '',
      aliases: Array.isArray(p.aliases) ? p.aliases.slice() : [],
      portraitName: p.portraitName || p.name || '',
      original: deepClone(seedOriginal(p, s)),
    };
  }

  const rebuilt = {};
  function profileFor(id, name, baseline) {
    if (hasOwn(rebuilt, id) && isPlainObject(rebuilt[id])) return rebuilt[id];
    const seed = seeds[id] || {};
    const p = blankProfile({
      id,
      name: seed.name || name || '',
      portraitName: seed.portraitName || name || '',
      original: Object.keys(seed.original || {}).length
        ? seed.original
        : (baseline && isPlainObject(baseline.original) ? deepClone(baseline.original) : { name: name || '' }),
    });
    if (seed.displayName) p.displayName = seed.displayName;
    if (seed.aliases && seed.aliases.length) p.aliases = seed.aliases.slice();
    if (baseline) {
      if (baseline.displayName) p.displayName = baseline.displayName;
      if (Array.isArray(baseline.aliases)) p.aliases = baseline.aliases.slice();
      if (baseline.portraitName) p.portraitName = baseline.portraitName;
    }
    rebuilt[id] = p;
    return p;
  }
  // 所有基线先入 rebuilt（未登场者保留 original，但 established=false，不公开）。
  for (const id of Object.keys(seeds)) profileFor(id, seeds[id].name, null);

  const entries = visibleEventEntries(rawEvents);
  for (const { record } of entries) {
    if (!isPlainObject(record)) continue;
    const narration = typeof record.narration === 'string' ? record.narration : '';
    const memories = Array.isArray(record.npc_memory) ? record.npc_memory : null;
    const covered = new Set(); // 本条事件已由 npc_memory 处理过的角色，避免重复计同一 eventIndex

    // 1) 新格式：逐条回放 npc_memory（含 internal 变化、baseline 重建）。
    if (memories && memories.length) {
      for (const chg of memories) {
        if (!isPlainObject(chg) || !safeIdRef(chg.id)) continue;
        const p = profileFor(chg.id, chg.name, chg.baseline);
        covered.add(p.id);
        const at = canonicalAt(record, s, chg.at);
        if (Array.isArray(chg.fields)) {
          for (const f of chg.fields) {
            if (isPlainObject(f)) {
              setFieldValue(p, f.scope, f.kind, f.key, f.label, f.to);
              if (f.scope === 'public' && f.kind === 'scalar' && f.key === 'relationshipSummary') {
                p.relationshipAt = deepClone(at);
              }
            }
          }
        }
        establishRecord(p, at, KINDS.includes(chg.kind) ? chg.kind : 'mention', chg.evidence, chg.action);
      }
    }

    // 2) 混合记录不能漏人：无论有无 npc_memory，都对本回合真实出现、但未被该条 metadata
    //    覆盖的角色逐角色回退到完整原文，保留 canonical 出场 / 共同经历。
    //    好感变化 / 态度 0 本身不能伪装为当面相识：必须名字确在叙事原文里出现。
    if (!narration) continue;
    const attitude = (record.applied && isPlainObject(record.applied.npc_attitude))
      ? record.applied.npc_attitude : {};
    const at = canonicalAt(record, s, null);
    for (const id of Object.keys(rebuilt)) {
      if (covered.has(id)) continue;
      const p = rebuilt[id];
      const names = profileNames(p);
      let relevant = false;
      for (const nm of names) {
        if (nm && narration.includes(nm)) { relevant = true; break; }
      }
      if (!relevant) continue;
      let kind = 'mention';
      if (typeof p.name === 'string'
          && Object.prototype.hasOwnProperty.call(attitude, p.name)
          && Number(attitude[p.name]) !== 0) {
        kind = 'interaction';
      }
      establishRecord(p, at, kind, excerptFromNarration(narration, p.name), record.action);
    }
  }

  for (const id of Object.keys(rebuilt)) {
    const p = rebuilt[id];
    p.attitude = readAttitude(s, p.name);
  }
  s.npcProfiles = rebuilt;
  s.npcMemoryVersion = NPC_MEMORY_VERSION;
  return s;
}

// 在已验证叙事 / 数值结算后调用。返回 { state, changes, rejected }。
// changes 即私有 result.npc_memory：含旧值/新值/证据/时间/原主角 life/name。
// 时间 / 主角名取 beforeState，死亡当回合不落入下一世。
function applyNpcMemory(beforeState, afterState, rawUpdates, ctx) {
  const before = beforeState || {};
  const context = ctx || {};
  const state = deepClone(afterState || {});
  if (!isPlainObject(state.npcProfiles)) state.npcProfiles = {};
  ensureBaselines(state);

  const changes = [];
  const rejected = [];
  const updates = Array.isArray(rawUpdates) ? rawUpdates : [];
  if (updates.length > NPC_UPDATES_MAX) {
    rejected.push(`npc_updates 超过 ${NPC_UPDATES_MAX} 条，多余条目忽略`);
  }
  const list = updates.slice(0, NPC_UPDATES_MAX);
  for (let i = 0; i < list.length; i++) {
    const r = applyOneUpdate(list[i], state, before, state, context);
    if (r.error) rejected.push(`npc_updates[${i}]: ${r.error}`);
    else if (r.change) changes.push(r.change);
  }

  // 真实出场不依赖 metadata 齐全：正文提到的既有角色，即便 npc_updates 缺省 / 空 / 被拒，
  // 也保留出场记录与 lastRecord（只补记录，不强造特征）。好感变化本身不在此伪装为当面相识。
  const narration = typeof context.narration === 'string' ? context.narration : '';
  if (narration) {
    const changed = new Set(changes.map((c) => c.id));
    const at = atRecord(before, state);
    for (const id of Object.keys(state.npcProfiles)) {
      if (!safeIdRef(id) || changed.has(id)) continue;
      const p = state.npcProfiles[id];
      if (!isPlainObject(p)) continue;
      let mentioned = false;
      for (const nm of profileNames(p)) {
        if (nm && narration.includes(nm)) { mentioned = true; break; }
      }
      if (!mentioned) continue;
      establishRecord(p, at, 'mention', excerptFromNarration(narration, p.name), context.action);
      p.attitude = readAttitude(state, p.name);
    }
  }

  return { state, changes, rejected };
}

// ---- 公开投影 ----

function projectTraits(t) {
  const out = {};
  for (const c of TRAIT_CATEGORIES) {
    out[c] = {};
    const m = isPlainObject(t) && isPlainObject(t[c]) ? t[c] : {};
    for (const k of Object.keys(m)) {
      if (typeof m[k] === 'string' && safeKey(k)) out[c][k] = m[k];
    }
  }
  return out;
}

function projectInitial(init) {
  const i = isPlainObject(init) ? init : {};
  return {
    role: typeof i.role === 'string' ? i.role : '',
    description: typeof i.description === 'string' ? i.description : '',
    voice: typeof i.voice === 'string' ? i.voice : '',
    traits: projectTraits(i.traits),
  };
}

// 未知时间保持 null / 空，不把缺项补成第 0 日 / 第 1 世 / 虚构时段。
function projectRecord(r) {
  if (!isPlainObject(r)) return null;
  const c = isPlainObject(r.clock) ? r.clock : {};
  return {
    turn: Number.isInteger(r.turn) ? r.turn : null,
    life: Number.isInteger(r.life) ? r.life : null,
    heroName: typeof r.heroName === 'string' ? r.heroName : '',
    clock: {
      day: Number.isInteger(c.day) ? c.day : null,
      period: typeof c.period === 'string' ? c.period : '',
    },
  };
}

// ---- 「初始设定」基础公开资料（只进公开投影，不改私有 profile / 公共 shape） ----
//
// 已有世界设定（bible.npcs 的完整 original）里可公开的身份 / 外显形象 / 口吻，供
// 「已经有公开出场 / 提及记录」的演员角色卡作基础资料展示：
//   - 只取白名单字段 role / desc / voice，绝不直接倒灌整个 original；
//   - want / internal / 任何未知私有字段永不进入公开 JSON；
//   - 明显含隐藏身份 / 幕后动机 / 暗中 / 秘密 / 实则其实 / 伪装等私密内容的句段
//     保守整段省略（不改写、不凭正则 / 模型另造另一份人物背景），不确定的留空 = 未知；
//   - 只填空缺：已有合法 current 资料与已经存在的初始快照都不被基础默认值覆盖，
//     后来有叙事支持的变化覆盖当前字段，但不覆盖初始快照 / 完整 original。
// 这是「初始设定」基础资料，不是某个旧回合亲口说过；所有共事经历仍只读 canonical 原文。
const PRIVATE_SETTING_MARKERS = Object.freeze([
  '隐藏身份', '真实身份', '真实目的', '幕后', '暗中', '暗地', '私下',
  '秘密', '私密', '隐秘', '实则', '其实', '伪装', '卧底', '内应',
  '密探', '潜伏', '刺探', '不可告人', '隐藏', '暗线',
]);

function safePublicSetting(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  for (const m of PRIVATE_SETTING_MARKERS) {
    if (text.includes(m)) return ''; // 保守整段省略，不另造替代背景
  }
  return text.trim();
}

// bible 原始对象用 desc，动态 NPC 的原始基线用 description；两者都只取可公开部分。
function publicBaseline(original) {
  const o = isPlainObject(original) ? original : {};
  const desc = typeof o.desc === 'string' ? o.desc
    : (typeof o.description === 'string' ? o.description : '');
  return {
    role: safePublicSetting(o.role),
    description: safePublicSetting(desc),
    voice: safePublicSetting(o.voice),
  };
}

function projectProfile(p, attitude) {
  const base = publicBaseline(p.original);
  const initial = projectInitial(p.initial);
  return {
    id: p.id,
    name: typeof p.name === 'string' ? p.name : '',
    displayName: typeof p.displayName === 'string' ? p.displayName : '',
    aliases: Array.isArray(p.aliases) ? p.aliases.slice() : [],
    portraitName: p.portraitName || p.name || '',
    role: (typeof p.role === 'string' && p.role) ? p.role : base.role,
    description: (typeof p.description === 'string' && p.description) ? p.description : base.description,
    voice: (typeof p.voice === 'string' && p.voice) ? p.voice : base.voice,
    publicGoal: p.publicGoal || '',
    relationshipSummary: p.relationshipSummary || '',
    traits: projectTraits(p.traits),
    // 初始公开快照也补基础设定：后来叙事变化只覆盖当前字段，不改写初始快照。
    initial: {
      role: initial.role || base.role,
      description: initial.description || base.description,
      voice: initial.voice || base.voice,
      traits: initial.traits,
    },
    firstRecord: projectRecord(p.firstRecord),
    lastRecord: projectRecord(p.lastRecord),
    lastInteraction: projectRecord(p.lastInteraction),
    latestExcerpt: typeof p.latestExcerpt === 'string' ? p.latestExcerpt : '',
    attitude: (typeof p.name === 'string' && Number.isFinite(attitude[p.name]))
      ? attitude[p.name]
      : (Number.isFinite(p.attitude) ? p.attitude : 0),
  };
}

// 公开字典：只含已由公开开场 / 真实叙事建立记录的人物，严格白名单，
// 不含 original / internal / want / 隐藏动机 / apex / established。
function publicNpcProfiles(state) {
  const s = isPlainObject(state) ? state : {};
  const profiles = isPlainObject(s.npcProfiles) ? s.npcProfiles : {};
  const attitude = isPlainObject(s.npcAttitude) ? s.npcAttitude : {};
  const out = {};
  for (const id of Object.keys(profiles)) {
    const p = profiles[id];
    if (!safeIdRef(id) || !isPlainObject(p) || p.established !== true) continue;
    out[id] = projectProfile(p, attitude);
  }
  return out;
}

// 公开 bible.npcs 投影：过滤 want 等隐藏动机及未知私有字段，保留身份/形象/音色，
// 私有 state 的完整 bible 原文不改写（由调用方在 clone 上替换）。
function publicBibleNpcs(state) {
  const bible = state && isPlainObject(state.bible) ? state.bible : null;
  if (!bible || !Array.isArray(bible.npcs)) return undefined;
  return bible.npcs.map((n) => {
    if (!isPlainObject(n)) return n;
    const out = {};
    for (const k of BIBLE_PUBLIC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(n, k)) out[k] = n[k];
    }
    return out;
  });
}

// ---- 历史详情 ----

// 旧格式 / 逐角色回退：以该条完整原文认人，changes 只含公开变化（好感 delta）。
function oldFormatEntry(record, eventIndex, p, state) {
  if (!isPlainObject(p)) return null;
  const narration = typeof record.narration === 'string' ? record.narration : '';
  if (!narration) return null;
  const attitude = (record.applied && isPlainObject(record.applied.npc_attitude))
    ? record.applied.npc_attitude : {};
  const changes = [];
  let relevant = false;
  let kind = 'mention';
  for (const nm of profileNames(p)) {
    if (nm && narration.includes(nm)) { relevant = true; break; }
  }
  if (!relevant) return null; // 好感变化本身不能伪装为当面相识 / 出场
  if (typeof p.name === 'string'
      && Object.prototype.hasOwnProperty.call(attitude, p.name)
      && Number(attitude[p.name]) !== 0) {
    kind = 'interaction';
    changes.push({ field: 'attitude', delta: Number(attitude[p.name]) });
  }
  return {
    eventIndex,
    kind,
    at: canonicalAt(record, state, null),
    action: typeof record.action === 'string' ? record.action : '',
    excerpt: excerptFromNarration(narration, p.name),
    narration, // 完整原文，不裁剪
    changes,   // 仅公开变化（好感 delta），不含 internal
  };
}

function buildHistoryEntry(record, eventIndex, npcId, p, state) {
  if (!isPlainObject(record)) return null;
  const narration = typeof record.narration === 'string' ? record.narration : '';
  const memories = Array.isArray(record.npc_memory) ? record.npc_memory : null;
  if (memories && memories.length) {
    const mine = memories.filter((m) => isPlainObject(m) && m.id === npcId);
    if (mine.length) {
      const first = mine[0];
      const changes = [];
      for (const m of mine) {
        if (!Array.isArray(m.fields)) continue;
        for (const f of m.fields) {
          if (isPlainObject(f) && f.scope === 'public') {
            changes.push({ field: fieldLabel(f), from: f.from, to: f.to });
          }
        }
      }
      return {
        eventIndex,
        kind: KINDS.includes(first.kind) ? first.kind : 'mention',
        at: canonicalAt(record, state, first.at),
        action: typeof record.action === 'string' ? record.action : '',
        excerpt: typeof first.evidence === 'string' ? first.evidence.slice(0, NPC_EXCERPT_MAX) : '',
        narration, // 完整原文
        changes,   // 仅公开变化；internal / baseline 绝不进入
      };
    }
    // 本条 metadata 没列该 NPC：逐角色回退到该条完整原文（出场 / 共同经历），不漏人。
  }
  return oldFormatEntry(record, eventIndex, p, state);
}

// 版本达标、且目标人物已公开、当前 profile 结构完整（含完整 original / 结构化特征），
// 即视为「有效新版 current profile」：读详情时优先保留，绝不因旧日志缺失 / 部分备份
// 全史重建把 state 里已经接纳的当前特征抹掉，也不复活 undo 后快照本不存在的资料。
// 旧格式 / 缺字段确需迁移（版本未达标、目标不存在 / 损坏或未公开）时才走回填。
function hasValidCurrentProfile(state, npcId) {
  const s = isPlainObject(state) ? state : {};
  const v = Number.isInteger(s.npcMemoryVersion) ? s.npcMemoryVersion : 0;
  if (v < NPC_MEMORY_VERSION) return false;
  const profiles = isPlainObject(s.npcProfiles) ? s.npcProfiles : null;
  if (!profiles || !hasOwn(profiles, npcId)) return false;
  const p = profiles[npcId];
  return isPlainObject(p) && p.established === true
    && typeof p.name === 'string' && p.name.length > 0
    && isPlainObject(p.original)
    && isPlainObject(p.traits);
}

// 公共详情或 null。newest first；before 为排他原始 eventIndex；limit 默认 20、最大 50。
// 有效新版 current 档案直接以 state 为读源（普通读详情不再反复全角色全史重建）；
// 仅旧格式 / 缺字段确需迁移才 hydrateNpcMemory。canonical 过滤 / 撤回分支不复活不变。
function getNpcHistory(state, rawEvents, npcId, opts) {
  if (!safeIdRef(npcId)) return null;
  const options = isPlainObject(opts) ? opts : {};
  const source = hasValidCurrentProfile(state, npcId)
    ? state
    : hydrateNpcMemory(state, rawEvents);
  const profiles = isPlainObject(source.npcProfiles) ? source.npcProfiles : {};
  const dict = publicNpcProfiles(source);
  if (!hasOwn(dict, npcId) || !dict[npcId]) return null; // 不存在 / 未公开人物
  const pub = dict[npcId];
  const hp = hasOwn(profiles, npcId) ? profiles[npcId] : null;

  const collected = [];
  for (const { eventIndex, record } of visibleEventEntries(rawEvents)) {
    const e = buildHistoryEntry(record, eventIndex, npcId, hp, source);
    if (e) collected.push(e);
  }
  // 公开开场记录：首次公开出场 / 初始已知快照，以 eventIndex=-1 可回查（最旧一条）。
  if (hp && hp.established === true) {
    const init = isPlainObject(hp.initial) ? hp.initial : {};
    const debut = typeof init.description === 'string' && init.description
      ? init.description
      : (typeof hp.latestExcerpt === 'string' ? hp.latestExcerpt : '');
    collected.push({
      eventIndex: -1,
      kind: 'mention',
      at: normalizeAt(hp.firstRecord, {}),
      action: '',
      excerpt: debut,
      narration: '', // 合成开场记录：无回合原文；真实出场仍由各事件保留完整原文
      changes: [],
    });
  }
  collected.sort((a, b) => b.eventIndex - a.eventIndex);
  const total = collected.length;

  let limit = Number.isInteger(options.limit) ? options.limit : HISTORY_LIMIT_DEFAULT;
  limit = clampInt(limit, 1, HISTORY_LIMIT_MAX);
  const beforeRaw = options.before;
  const before = (beforeRaw === undefined || beforeRaw === null || beforeRaw === '')
    ? null
    : (Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : null);
  const filtered = before === null ? collected : collected.filter((c) => c.eventIndex < before);
  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > page.length;
  // 下一页 cursor 用原始 eventIndex（排他边界）；允许 0 才能翻到 eventIndex=-1 的最后开场，
  // 恒为 null 或非负整数，开场/最旧记录不会产生负数 cursor。
  let nextCursor = null;
  if (hasMore && page.length) {
    const oldest = page[page.length - 1].eventIndex;
    if (oldest >= 0) nextCursor = oldest;
  }
  return {
    profile: pub,
    history: { entries: page, nextCursor, hasMore, total },
  };
}

// ---- 有界内部提示词片段 ----

function promptScore(p, action) {
  let mentioned = false;
  for (const nm of profileNames(p)) {
    if (nm && action.includes(nm)) { mentioned = true; break; }
  }
  // 普通最近度按「最新相关经历」：lastRecord 记录所有经历（含听闻消息 / 变化），
  // lastInteraction 只记明确互动。取两者最大 turn，避免「很久前互动、刚有新消息」
  // 的人被一直按旧互动回合排序。点名绝对优先级与 ≤4 人预算不变。
  const li = p.lastInteraction && Number.isInteger(p.lastInteraction.turn) ? p.lastInteraction.turn : 0;
  const lr = p.lastRecord && Number.isInteger(p.lastRecord.turn) ? p.lastRecord.turn : 0;
  const lastTurn = Math.min(Math.max(li, lr), 1e9);
  // 玩家明确提到的旧人优先于任意大的最近 turn；turn 先夹到 1e9，1e15 权重恒占优。
  return (mentioned ? NPC_PROMPT_MENTION_WEIGHT : 0) + lastTurn;
}

function clipExcerpt(text, cap) {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= cap) return s;
  return s.slice(0, cap) + '…（摘录）'; // 注明摘录；存储原文不裁剪
}

// 关系 / 旧经历的来源：世数、当时主角姓名、时间；前世交情明确标注，不当作本世已经相识。
function provenanceTag(at, currentLife) {
  if (!isPlainObject(at)) return '';
  const life = Number.isInteger(at.life) ? at.life : null;
  const hero = typeof at.heroName === 'string' ? at.heroName : '';
  const c = isPlainObject(at.clock) ? at.clock : {};
  const day = Number.isInteger(c.day) ? c.day : null;
  const period = typeof c.period === 'string' ? c.period : '';
  const bits = [];
  if (life !== null) {
    const past = Number.isInteger(currentLife) && life !== currentLife;
    bits.push(past ? `前世第${life}世` : `第${life}世`);
  }
  if (hero) bits.push(`当时主角${hero}`);
  const time = [];
  if (day !== null) time.push(`第${day}日`);
  if (period) time.push(period);
  if (time.length) bits.push(time.join(''));
  return bits.length ? `（${bits.join('·')}）` : '';
}

function promptBlock(p, currentLife) {
  const orig = isPlainObject(p.original) ? p.original : {};
  const budget = NPC_PROMPT_PER_NPC_CHARS;
  const lines = [`NPC「${p.name}」[${p.id}]`]; // 稳定 id
  let used = lines[0].length + 1;

  // 按字段给预算，优先当前变化 / 关系 / 身份；超预算的低优先字段跳过，绝不整块截断。
  function add(label, value, cap, tag) {
    if (value === undefined || value === null || value === '') return;
    const text = clipExcerpt(value, cap) + (tag || '');
    const line = `${label}:${text}`;
    if (used + line.length > budget) return;
    lines.push(line);
    used += line.length + 1;
  }

  const role = p.role || (typeof orig.role === 'string' ? orig.role : '');
  add('身份', role, PROMPT_FIELD_CAPS.identity);
  const traitBits = [];
  if (isPlainObject(p.traits)) {
    for (const cat of TRAIT_CATEGORIES) {
      const m = isPlainObject(p.traits[cat]) ? p.traits[cat] : {};
      for (const k of Object.keys(m)) if (typeof m[k] === 'string') traitBits.push(`${k}:${m[k]}`);
    }
  }
  if (traitBits.length) add('现状', traitBits.join('；'), PROMPT_FIELD_CAPS.current);
  add('当前动机', p.publicGoal, PROMPT_FIELD_CAPS.publicGoal);
  // 关系摘要带来源世数 / 当时主角姓名 / 时间，前世交情不自动当本世相识。
  add('关系', p.relationshipSummary, PROMPT_FIELD_CAPS.relationship,
    provenanceTag(p.relationshipAt || p.lastRecord, currentLife));
  // 最近线索的来源是 latestExcerpt 对应的那次经历（lastRecord）：它与 latestExcerpt 一起由
  // establishRecord 推进，含本世新听闻的消息；不能错用旧 lastInteraction（可能是前世 / 旧主角）的来源。
  add('最近线索', p.latestExcerpt, PROMPT_FIELD_CAPS.recent,
    provenanceTag(p.lastRecord, currentLife));
  // 内部档案 / 原始资料补充（仅 AI 提示词用，不进公开响应），注明摘录。
  add('[内部档案]原始形象', typeof orig.desc === 'string' ? orig.desc : '', PROMPT_FIELD_CAPS.origImage);
  add('[内部档案]原始动机', typeof orig.want === 'string' ? orig.want : '', PROMPT_FIELD_CAPS.origWant);
  const voice = p.voice || (typeof orig.voice === 'string' ? orig.voice : '');
  add('音色', voice, PROMPT_FIELD_CAPS.voice);
  add('形象补', p.description, PROMPT_FIELD_CAPS.description);
  const oInternal = isPlainObject(orig.internal) ? orig.internal : {};
  const internalBits = [];
  if (isPlainObject(p.internal)) {
    for (const k of Object.keys(p.internal)) {
      if (typeof p.internal[k] === 'string') internalBits.push(`${k}:${p.internal[k]}`);
    }
  }
  for (const k of Object.keys(oInternal)) {
    if (typeof oInternal[k] === 'string' && !hasOwn(isPlainObject(p.internal) ? p.internal : {}, k)) {
      internalBits.push(`${k}:${oInternal[k]}`);
    }
  }
  if (internalBits.length) add('[内部状态]', internalBits.join('；'), PROMPT_FIELD_CAPS.internal);
  return lines.join('｜');
}

// 普通回合只注入行动相关 / 最近相关少量 NPC（默认 ≤4）的关键特征、原始身份形象/
// 动机与关系记忆摘录；按字段有界、绝不携带全史或全 NPC 全集。存储原文不裁剪。
function npcPromptContext(state, action, opts) {
  const s = isPlainObject(state) ? state : {};
  const options = isPlainObject(opts) ? opts : {};
  const maxNpcs = Number.isInteger(options.maxNpcs)
    ? clampInt(options.maxNpcs, 1, 8) : NPC_PROMPT_MAX_NPCS;
  const maxChars = Number.isInteger(options.maxChars)
    ? clampInt(options.maxChars, 200, 8000) : NPC_PROMPT_MAX_CHARS;
  const act = typeof action === 'string' ? action : '';
  const currentLife = Number.isInteger(s.life) ? s.life : null;
  const profiles = isPlainObject(s.npcProfiles) ? s.npcProfiles : {};
  const scored = [];
  for (const id of Object.keys(profiles)) {
    const p = profiles[id];
    if (isPlainObject(p) && p.established === true) scored.push({ p, score: promptScore(p, act) });
  }
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored.slice(0, maxNpcs);

  const NOTE = '（人物记忆摘录，不代表在场）';
  const blocks = [];
  let used = NOTE.length + 1;
  for (const { p } of chosen) {
    const block = promptBlock(p, currentLife); // 已按字段分配预算，不整块截断
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length + 1;
  }
  if (!blocks.length) return '';
  return NOTE + '\n' + blocks.join('\n');
}

module.exports = {
  NPC_MEMORY_VERSION,
  NPC_FIELD_MAX,
  NPC_UPDATES_MAX,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  TRAIT_CATEGORIES,
  KINDS,
  stableId,
  initializeNpcMemory,
  normalizeNpcMemory,
  needsNpcHydration,
  hydrateNpcMemory,
  applyNpcMemory,
  publicNpcProfiles,
  publicBibleNpcs,
  getNpcHistory,
  npcPromptContext,
};
