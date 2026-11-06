'use strict';

// 第 4 节：纯函数规则引擎。
// 全部导出函数都不修改入参、不读写文件、不联网；随机数经 opts.rng 注入，
// 时间经 opts.now 注入（默认 Date.now()），便于确定性测试。
// 引擎不调用 LLM：事件标题/描述、新 apex、编年史摘要由编排层组装 prompt 后
// 通过 input 回传，引擎只负责检测、发信号（needEvent / needNewApex / needChapter）并写入状态。

const ATTRS = Object.freeze(['体魄', '心智', '魅力', '气运', '声望', '资源']);
const PERSONA_DIMS = Object.freeze(['冒险', '审慎', '共情', '权谋', '坚韧', '秩序']);

const ATTR_MIN = 0;
const ATTR_MAX = 40;
const ATTR_INIT = 5;
const ATTR_EXTRA_TOTAL = 6;
const ATTR_EXTRA_MAX = 3;

const NPC_MIN = -10;
const NPC_MAX = 10;
const NPC_DIFF_MAX = 2;

const DIFF_MIN = -2;
const DIFF_MAX = 1; // 普通回合单项正向最多 +1（负向仍以 DIFF_MIN=-2 为界）
const DIFF_POSITIVE_TOTAL_MAX = 2; // 普通回合正向总预算；事件结算不受此限

// 通用事件主题：建世界 eventThemes 少于 4 个时补齐；引擎开启事件时主题为空也用它兜底。
const GENERIC_EVENT_THEMES = Object.freeze(
  ['天灾', '瘟疫', '战乱', '权力更迭', '神秘来客', '资源枯竭'],
);

// 导演机制：当玩家在同一场景/谈判里绕圈，或距上次转折太久，强制本回合出现明显转折。
// 转折词只进回合 prompt 与 events.jsonl，绝不写进公开状态（见 toPublicState / toPublicTurnResult）。
const TWISTS = Object.freeze(
  ['闯入者', '意外发现', '背叛', '环境突变', '旧识出现', '时机错过', '交易反转'],
);
const TWIST_STREAK_THRESHOLD = 4; // sceneStreak 达到该值即触发转折
const TWIST_GAP_MIN = 9;         // 距上次转折的随机间隔下界（含）
const TWIST_GAP_SPAN = 6;        // 9~14：TWIST_GAP_MIN + floor(unit(rng) * TWIST_GAP_SPAN)

// 内部拒绝原因标记：记入 rejected 供内部日志，但不出现在公开回合结果里（不给玩家看）。
const INTERNAL_REJECT_TAG = '[internal]';

const ITEMS_ADD_MAX = 2;
const ITEM_NAME_MAX = 12;
const NARRATION_MIN = 10;
const NARRATION_MAX = 1200;
const RECENT_MAX = 6;
const RECENT_NARRATION_MAX = 300;
const CHRONICLE_MAX = 300;
const PERSONA_INIT = 50;
const PERSONA_REGRESSION = 0.2;

// 风声预兆：距离下一次事件 1~2 回合且无进行中事件时，叙事里要埋下不祥征兆。
const OMEN_MIN_GAP = 1;
const OMEN_MAX_GAP = 2;

// 坊间传闻：单条 ≤40 字，state 只留最近 10 条。
const RUMOR_MAX = 40;
const RUMORS_MAX = 10;

// 场景插图 desc 上限：引擎消毒时去首尾空白、截到 60 字（模型建议 ≤40 字）。
const SCENE_DESC_MAX = 60;

// 事实账本：本回合新确立的客观事实，[{turn,text}]；单条 ≤30 字，每回合 0~2 条，最多 40 条（丢最旧）。
const FACT_TEXT_MAX = 30;
const FACTS_MAX = 40;
const FACTS_PER_TURN_MAX = 2;

// 印记：落在角色身上的持久处境（被盯上、欠人情、负伤…），单条 ≤16 字，最多 8 条；重生时清空。
const MARK_TEXT_MAX = 16;
const MARKS_MAX = 8;

// 未解之谜：state.threads 最多 6 条活跃，超出时最旧的移入 state.fadedThreads；
// 单条 ≤20 字，解开时文本必须与已有完全一致。fadedThreads 也设上限，避免无限增长。
const THREAD_TEXT_MAX = 20;
const THREADS_MAX = 6;
const FADED_THREADS_MAX = 20;

// 地点与时间：时段依次循环，深夜之后进入次日清晨；单回合推进 0~2 个时段。
const PERIODS = Object.freeze(['清晨', '午后', '黄昏', '深夜']);
const MOVE_TO_MAX = 12;
const TIME_PASSES_MIN = 0;
const TIME_PASSES_MAX = 2;
const TIME_PASSES_DEFAULT = 1;

// 前世墓志铭：单段 ≤80 字。
const EPITAPH_MAX = 80;

// 濒死阈值：体魄 ≤ 该值即「伤势沉重」，公开状态置 danger:true。
// 与 prompts.js 的回合叙事判定保持一致（那里用字面量 2 并有注释互指）。
const DANGER_THRESHOLD = 2;

// 老存档兼容：NPC 缺 voice 时按序补一组彼此不同的默认口吻（每条 ≤20 字）。
// 只给缺字段的补，已有 voice 的世界原样保留（幂等）。
const DEFAULT_VOICES = Object.freeze([
  '短句铁令，从不解释',
  '哄劝式隐喻，句句带笑',
  '记账式冷语，只报数目',
  '慢条斯理，先问再答',
  '粗声打断，只讲结论',
  '低声耳语，话留半句',
]);

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

// 场景插图校验：desc 去空白并截断到 SCENE_DESC_MAX；draw 仅 raw.draw === true 才为 true，
// forced 为 true 且存在 desc 时强制 draw=true。返回 {draw:true, desc} 或 {draw:false}。
function normalizeScene(raw, forced) {
  if (!raw || typeof raw !== 'object') return { draw: false };
  if (typeof raw.desc !== 'string') return { draw: false };
  const desc = raw.desc.trim().slice(0, SCENE_DESC_MAX);
  if (!desc) return { draw: false };
  const draw = raw.draw === true || forced === true;
  return draw ? { draw: true, desc } : { draw: false };
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

// ---- 建世界 / 分配属性点 ----

// 未传 alloc 时 6 点平均分到 6 项（各 +1）；传入时校验合计 6 点且每项 ≤ 3。
function allocateAttrs(alloc) {
  const attrs = {};
  for (const a of ATTRS) attrs[a] = ATTR_INIT;
  if (alloc == null) {
    for (const a of ATTRS) attrs[a] += 1;
    return attrs;
  }
  if (typeof alloc !== 'object' || Array.isArray(alloc)) {
    throw new Error('额外属性点分配格式错误');
  }
  let total = 0;
  for (const key of Object.keys(alloc)) {
    if (!ATTRS.includes(key)) throw new Error(`额外属性点包含未知属性「${key}」`);
    const v = alloc[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > ATTR_EXTRA_MAX) {
      throw new Error(`属性「${key}」的额外点数必须是 0~${ATTR_EXTRA_MAX} 的整数`);
    }
    total += v;
  }
  if (total !== ATTR_EXTRA_TOTAL) {
    throw new Error(`额外属性点必须合计 ${ATTR_EXTRA_TOTAL} 点，当前 ${total} 点`);
  }
  for (const key of Object.keys(alloc)) attrs[key] += alloc[key];
  return attrs;
}

function createWorld(spec, opts) {
  const s = spec || {};
  const options = opts || {};
  const rng = options.rng || Math.random;
  const now = options.now == null ? Date.now() : options.now;
  const bible = cloneState(s.bible || {});
  // 建世界校验：eventThemes 少于 4 个就用通用主题补齐，保证事件能正常开启。
  bible.eventThemes = normalizeEventThemes(bible.eventThemes);
  return {
    id: s.id,
    createdAt: s.createdAt == null ? now : s.createdAt,
    seed: s.seed || '',
    bible,
    apex: Object.assign({ achievedAt: null, generation: 1 }, cloneState(s.apex || {})),
    life: 1,
    turn: 0,
    character: {
      name: s.name || '',
      appearance: s.appearance || '',
      attrs: allocateAttrs(s.alloc),
      items: startingItems(bible),
      marks: [],
      alive: true,
      bornTurn: 0,
    },
    npcAttitude: initialNpcAttitude(bible, s.npcAttitude),
    persona: freshPersona(),
    nextEventTurn: 7 + Math.floor(unit(rng) * 6), // 7~12 随机
    activeEvent: null,
    pendingEventTheme: null, // 提前锁定、开事件时消费的内部主题，绝不进公开状态
    rumors: [],              // 坊间传闻，只保留最近 10 条 [{turn, text}]
    facts: startingFacts(bible), // 开局关键时间/规则事实 + 后续新确立事实 [{turn, text}]，最多 40 条
    threads: [],             // 活跃未解之谜（文本），最多 6 条
    fadedThreads: [],        // 已淡去/已解开的线索（文本），不再活跃
    sceneStreak: 0,          // 「地点没变且本回合无 new_facts / threads 变化」的连续回合数
    lastTwistTurn: 0,       // 上次强制转折发生的回合（0 = 尚未发生）
    nextTwistTurn: TWIST_GAP_MIN + Math.floor(unit(rng) * TWIST_GAP_SPAN), // 到点触发时间型转折
    oversteps: 0,            // 玩家累计越界次数（用于越界后果升级阶梯）
    location: (bible.start && typeof bible.start.place === 'string') ? bible.start.place : '',
    clock: { day: 1, period: PERIODS[0] },
    pastLives: [],           // 前世墓志铭 [{life,name,epitaph,turns,cause}]
    chronicle: [],
    recent: [],
    rebirthOpening: '',      // 本世（第 1 世为空）由重生生成的新一世开场叙事
    highlightUntilTurn: 0,
    awaitingRebirth: false,
  };
}

// ---- validateProposal：把 LLM 提议消毒成实际可应用的 diff ----

function validateProposal(state, proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const rejected = [];
  const applied = {
    state_diff: {},
    items_add: [],
    items_remove: [],
    npc_attitude: {},
    persona_tags: [],
    persona: {},
    suggestions: [],
    narration: '',
  };

  // 叙事：10~1200 字；超出截断，过短 = 无效回合。
  let narration = typeof p.narration === 'string' ? p.narration : '';
  if (narration.length > NARRATION_MAX) {
    narration = narration.slice(0, NARRATION_MAX);
    rejected.push(`叙事超过 ${NARRATION_MAX} 字，已截断`);
  }
  applied.narration = narration;
  if (narration.length < NARRATION_MIN) {
    return { applied, rejected, error: `叙事过短（少于 ${NARRATION_MIN} 字），本回合无效，请重试` };
  }

  // state_diff：白名单 / 取整 / 单项 [-2,+1] / 正向总和 ≤ 2（按顺序截断）/ 属性 [0,40]
  const diff = p.state_diff && typeof p.state_diff === 'object' ? p.state_diff : {};
  let positiveTotal = 0;
  for (const key of Object.keys(diff)) {
    if (!ATTRS.includes(key)) {
      rejected.push(`忽略未知属性「${key}」`);
      continue;
    }
    const raw = diff[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      rejected.push(`属性「${key}」的变化值无效，已忽略`);
      continue;
    }
    let delta = toInt(raw);
    if (delta === 0) continue;
    if (delta > DIFF_MAX) {
      rejected.push(`「${key}」单项变化超过 +${DIFF_MAX}，已截断`);
      delta = DIFF_MAX;
    }
    if (delta < DIFF_MIN) {
      rejected.push(`「${key}」单项变化超过 ${DIFF_MIN}，已截断`);
      delta = DIFF_MIN;
    }
    if (delta > 0) {
      if (positiveTotal >= DIFF_POSITIVE_TOTAL_MAX) {
        rejected.push(`正向变化总和已达 ${DIFF_POSITIVE_TOTAL_MAX}，忽略「${key}」`);
        continue;
      }
      if (positiveTotal + delta > DIFF_POSITIVE_TOTAL_MAX) {
        const allowed = DIFF_POSITIVE_TOTAL_MAX - positiveTotal;
        rejected.push(`正向变化总和超过 ${DIFF_POSITIVE_TOTAL_MAX}，「${key}」由 +${delta} 截断为 +${allowed}`);
        delta = allowed;
      }
      positiveTotal += delta;
    }
    const cur = state.character.attrs[key];
    if (delta > 0 && cur >= ATTR_MAX) {
      rejected.push(`「${key}」已达上限 ${ATTR_MAX}，增长丢弃（叙事照常）`);
      continue;
    }
    const next = clamp(cur + delta, ATTR_MIN, ATTR_MAX);
    const actual = next - cur;
    if (actual === 0) {
      rejected.push(`「${key}」变化后无实际增减`);
      continue;
    }
    applied.state_diff[key] = actual;
  }

  // items_add：每回合 ≤ 2，每个 ≤ 12 字，不重复已有物品
  const owned = Array.isArray(state.character.items) ? state.character.items : [];
  const addInput = Array.isArray(p.items_add) ? p.items_add : [];
  for (const raw of addInput) {
    if (applied.items_add.length >= ITEMS_ADD_MAX) {
      rejected.push(`每回合最多新增 ${ITEMS_ADD_MAX} 件物品，其余忽略`);
      break;
    }
    if (typeof raw !== 'string') {
      rejected.push('忽略非字符串物品名');
      continue;
    }
    const name = raw.trim();
    if (!name) {
      rejected.push('忽略空物品名');
      continue;
    }
    if (name.length > ITEM_NAME_MAX) {
      rejected.push(`物品「${name}」超过 ${ITEM_NAME_MAX} 字，已忽略`);
      continue;
    }
    if (owned.includes(name) || applied.items_add.includes(name)) {
      rejected.push(`物品「${name}」已拥有，不重复添加`);
      continue;
    }
    applied.items_add.push(name);
  }

  // items_remove：只能移除已拥有的
  const removeInput = Array.isArray(p.items_remove) ? p.items_remove : [];
  const seenRemove = new Set();
  for (const raw of removeInput) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || seenRemove.has(name)) continue;
    seenRemove.add(name);
    if (!owned.includes(name)) {
      rejected.push(`物品「${name}」并未拥有，不能移除`);
      continue;
    }
    applied.items_remove.push(name);
  }

  // npc_attitude：bible.npcs 里存在，或叙事里新出现的人名（零依赖：子串启发式）
  const npcInput = p.npc_attitude && typeof p.npc_attitude === 'object' ? p.npc_attitude : {};
  const bibleNpcs = state.bible && Array.isArray(state.bible.npcs) ? state.bible.npcs : [];
  const knownNames = new Set(
    bibleNpcs.map((n) => (n && typeof n.name === 'string' ? n.name : '')).filter(Boolean),
  );
  const stateNpcs = state.npcAttitude && typeof state.npcAttitude === 'object' ? state.npcAttitude : {};
  for (const name of Object.keys(npcInput)) {
    const known = knownNames.has(name) || Object.prototype.hasOwnProperty.call(stateNpcs, name);
    const appeared = narration.includes(name);
    if (!known && !appeared) {
      rejected.push(`忽略未在设定或叙事中出现的 NPC「${name}」`);
      continue;
    }
    const raw = npcInput[name];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      rejected.push(`NPC「${name}」态度变化值无效，已忽略`);
      continue;
    }
    const wanted = toInt(raw);
    const delta = clamp(wanted, -NPC_DIFF_MAX, NPC_DIFF_MAX);
    if (delta !== wanted) rejected.push(`NPC「${name}」单回合态度变化截断为 ${delta}`);
    const cur = stateNpcs[name] || 0;
    const next = clamp(cur + delta, NPC_MIN, NPC_MAX);
    applied.npc_attitude[name] = next - cur;
  }

  // persona_tags：只接受 6 个维度；命中 +1，其余向 50 回归 0.2；夹 [0,100]
  const tagInput = Array.isArray(p.persona_tags) ? p.persona_tags : [];
  const hits = new Set();
  for (const tag of tagInput) {
    if (PERSONA_DIMS.includes(tag)) hits.add(tag);
    else rejected.push(`忽略未知人格维度「${String(tag)}」`);
  }
  applied.persona_tags = Array.from(hits);
  const curPersona = state.persona && typeof state.persona === 'object' ? state.persona : {};
  for (const dim of PERSONA_DIMS) {
    const cur = typeof curPersona[dim] === 'number' ? curPersona[dim] : PERSONA_INIT;
    const v = hits.has(dim) ? cur + 1 : cur + (PERSONA_INIT - cur) * PERSONA_REGRESSION;
    applied.persona[dim] = Math.round(clamp(v, 0, 100) * 100) / 100;
  }

  applied.suggestions = (Array.isArray(p.suggestions) ? p.suggestions : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim());

  return { applied, rejected, error: null };
}

// ---- 事件排程 ----

// 本回合开始前决定：是否开新事件、是否结算旧事件、是否压编年史。
function planTurn(state, opts) {
  const options = opts || {};
  const rng = options.rng || Math.random;
  const nextTurn = state.turn + 1;
  let themes =
    state.bible && Array.isArray(state.bible.eventThemes)
      ? state.bible.eventThemes.filter((t) => typeof t === 'string' && t)
      : [];
  // 主题为空（旧世界或异常设定）时用通用主题兜底，保证事件仍能开启。
  if (themes.length === 0) themes = GENERIC_EVENT_THEMES.slice();
  const hasActive = !!state.activeEvent;
  const settling = hasActive && state.activeEvent.startedTurn < nextTurn;
  const opening = !hasActive && nextTurn >= state.nextEventTurn && themes.length > 0;
  // 风声预兆窗口：无进行中事件、距下次事件 1~2 回合。
  const omen = computeOmen(state);

  // 提前锁定即将到来的事件主题，保证预兆回合的征兆最终对应真正开启的大事：
  // 优先沿用已存的 pendingEventTheme（连续预兆回合指向同一主题），否则现在随机选一个。
  let pendingTheme = null;
  if (opening || omen) {
    const stored = state.pendingEventTheme;
    if (typeof stored === 'string' && themes.includes(stored)) {
      pendingTheme = stored;
    } else {
      pendingTheme = themes[Math.floor(unit(rng) * themes.length)];
    }
  }
  // 开事件用预选主题；老存档没有预选主题时现选一个兜底。
  const theme = opening ? (pendingTheme || themes[Math.floor(unit(rng) * themes.length)]) : null;

  // 导演机制：只在非事件回合介入（事件开启/结算回合已有专门指令，不叠加转折）。
  // 触发条件二选一：① sceneStreak 达到 4（玩家在同一场景/谈判里连续绕圈）；
  // ② 距上次转折已过随机 9~14 回合（nextTwistTurn 到点）。
  // 用注入的 rng 从 TWISTS 里选一个转折；转折只进 prompt 与 events.jsonl，不进公开状态。
  const eventTurn = opening || settling;
  const streak = Number.isInteger(state.sceneStreak) ? state.sceneStreak : 0;
  const dueTurn = Number.isInteger(state.nextTwistTurn)
    ? state.nextTwistTurn
    : (nextTurn + TWIST_GAP_MIN);
  const streakHit = streak >= TWIST_STREAK_THRESHOLD;
  const timeHit = nextTurn >= dueTurn;
  let twist = null;
  let nextTwistTurn = null;
  if (!eventTurn && (streakHit || timeHit)) {
    twist = TWISTS[Math.floor(unit(rng) * TWISTS.length)];
    // 本次转折后重新排下一次时间型转折（随机 9~14 回合），避免连续触发。
    nextTwistTurn = nextTurn + TWIST_GAP_MIN + Math.floor(unit(rng) * TWIST_GAP_SPAN);
  }

  return {
    nextTurn,
    settling,
    opening,
    theme,
    omen,                                   // 本回合叙事需要埋不祥征兆
    omenTheme: omen ? pendingTheme : null,   // 供 prompt 写与主题相关的征兆（仅服务端可见）
    pendingEventTheme: pendingTheme,          // 供 resolveTurn 写入 / 消费
    twist,                                   // 本回合必须出现的明显转折（仅服务端可见）
    nextTwistTurn,                           // 触发后重新排定的下次转折回合（供 resolveTurn 写入）
    needEvent: opening, // 需要本回合 LLM 输出 event.title / event.desc
    needSettlement: settling, // 需要本回合 LLM 输出 event_check
    needChapter: nextTurn % 20 === 0,
  };
}

// 事件四档结算（纯函数）。score = min(属性,20)*0.5 + response_quality*4 + rng 0~8。
// 属性贡献封顶 10，避免高属性必然蜕变；阈值不变。
function settleEvent(state, event, eventCheck, rng) {
  const check = eventCheck && typeof eventCheck === 'object' ? eventCheck : {};
  const attrValid = ATTRS.includes(check.attr);
  const attr = attrValid ? check.attr : '体魄';
  const quality = clamp(toInt(check.response_quality == null ? 0 : check.response_quality), 0, 3);
  const rand = Math.floor(unit(rng) * 9); // 0~8 的整数
  const attrPart = Math.min(state.character.attrs[attr], 20) * 0.5;
  const score = attrPart + quality * 4 + rand;
  const effects = {};
  let tier;
  let death = false;
  if (score >= 24) {
    tier = '蜕变';
    effects[attr] = 3;
    effects['声望'] = (effects['声望'] || 0) + 2;
  } else if (score >= 16) {
    tier = '险胜';
    effects[attr] = 1;
  } else if (score >= 9) {
    tier = '代价';
    effects['体魄'] = -2;
    effects['资源'] = -2;
  } else {
    tier = '殒命';
    death = true;
  }
  return { tier, attr, response_quality: quality, rand, score, effects, death, invalidAttr: !attrValid, event };
}

// 直接套用数值效果（事件结算绕过普通回合的单项 +1 / 正向总预算 2 限制），仍夹在 [0,40]。
function applyRawEffect(attrs, effects) {
  const out = Object.assign({}, attrs);
  for (const key of Object.keys(effects)) {
    if (!ATTRS.includes(key)) continue;
    out[key] = clamp(out[key] + effects[key], ATTR_MIN, ATTR_MAX);
  }
  return out;
}

// ---- 顶点 ----

function apexConditionMet(state) {
  const c = state.apex && state.apex.condition;
  if (!c || typeof c !== 'object') return false;
  const attrs = c.attrs && typeof c.attrs === 'object' ? c.attrs : {};
  const hasNpc = !!(c.npc && c.npc.name);
  if (Object.keys(attrs).length === 0 && !hasNpc) return false;
  for (const key of Object.keys(attrs)) {
    if (!ATTRS.includes(key)) return false;
    if (state.character.attrs[key] < toInt(attrs[key])) return false;
  }
  if (hasNpc) {
    const cur = state.npcAttitude[c.npc.name];
    if (typeof cur !== 'number' || cur < Number(c.npc.minAttitude)) return false;
  }
  return true;
}

// ---- 死亡 / 重生 ----

function applyDeath(state, reason, turn) {
  const s = cloneState(state);
  const endedLife = s.life;
  const bornTurn = s.character.bornTurn;
  const inherited = Math.floor(s.character.attrs['声望'] * 0.2);
  const attrs = {};
  for (const a of ATTRS) attrs[a] = ATTR_INIT;
  attrs['声望'] = clamp(inherited, ATTR_MIN, ATTR_MAX);
  s.life = endedLife + 1;
  s.character = {
    name: '',
    appearance: '',
    attrs,
    items: [],
    marks: [], // 本世结束，印记随角色清空
    alive: false,
    bornTurn: null,
  };
  s.activeEvent = null; // 本世结束，未结算事件作废
  s.awaitingRebirth = true; // 需玩家提交新的名字/形象
  s.chronicle.push({
    chapter: s.chronicle.length + 1,
    fromTurn: bornTurn == null ? 0 : bornTurn,
    toTurn: turn,
    summary: `第 ${endedLife} 世终`,
  });
  return {
    state: s,
    death: { reason, life: endedLife, inheritedReputation: inherited },
  };
}

function rebirth(state, input) {
  const data = input && typeof input === 'object' ? input : {};
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const appearance = typeof data.appearance === 'string' ? data.appearance.trim() : '';
  if (!name || !appearance) return { state, error: '重生需要提交新的名字与形象' };
  const s = cloneState(state);
  s.character.name = name;
  s.character.appearance = appearance;
  s.character.alive = true;
  // 重生给 1 个符合世界观的基础物品（死亡时已清空，这里补上）。
  s.character.items = [baseItem(s.bible)];
  s.character.marks = []; // 重生清空上一世的所有印记
  s.character.bornTurn = s.turn;
  s.awaitingRebirth = false;
  return { state: s, error: null };
}

// 新一世开场：重生时由编排层生成后写入状态。纯函数，不改入参。
// 作为该世第一条叙事：存进 state.rebirthOpening（供前端进入新一世显示），并压入 recent
// （供回合 prompt 的最近记录读取）；events.jsonl 由编排层另写一条公开记录。
function applyRebirthOpening(state, opening) {
  const s = cloneState(state);
  const text = typeof opening === 'string' ? opening.trim() : '';
  if (!text) return s;
  s.rebirthOpening = text;
  if (!Array.isArray(s.recent)) s.recent = [];
  s.recent.push({
    turn: s.turn,
    action: '',
    narration: text.slice(0, RECENT_NARRATION_MAX),
    rebirthOpening: true,
  });
  if (s.recent.length > RECENT_MAX) s.recent = s.recent.slice(-RECENT_MAX);
  return s;
}

// 前世墓志铭：把一条本世记录追加到 state.pastLives；引擎在此强制 ≤80 字与字段形状。
function applyEpitaph(state, entry) {
  const s = cloneState(state);
  if (!Array.isArray(s.pastLives)) s.pastLives = [];
  const e = entry && typeof entry === 'object' ? entry : {};
  s.pastLives.push({
    life: Number.isInteger(e.life) ? e.life : (s.life || 1),
    name: typeof e.name === 'string' ? e.name : '',
    epitaph: typeof e.epitaph === 'string' ? e.epitaph.slice(0, EPITAPH_MAX) : '',
    turns: Number.isFinite(e.turns) ? e.turns : 0,
    cause: typeof e.cause === 'string' ? e.cause : '',
  });
  return s;
}

function canTakeTurn(state) {
  return !state.awaitingRebirth;
}

// ---- 对外视图：apex 与 Key 绝不出现在接口返回里 ----

function toPublicState(state) {
  const out = cloneState(state || {});
  for (const key of Object.keys(out)) {
    // pendingEventTheme 是提前锁定的内部主题，绝不能以主题名暴露给玩家；
    // twist 是导演的强制转折信号，只写进 events.jsonl，绝不出现在公开状态里。
    if (key === 'apex' || key === 'pendingEventTheme' || key === 'twist' || /api.?key/i.test(key)) {
      delete out[key];
    }
  }
  // 风声预兆：只给出布尔标记，从不带出主题名。
  out.omen = computeOmen(out);
  // 濒死可感知：体魄 ≤ 2 时公开状态带 danger:true，前端据此变红闪烁并提示「伤势沉重」。
  out.danger = computeDanger(out);
  return out;
}

function toPublicTurnResult(result, state) {
  return {
    narration: result.narration,
    applied: result.applied,
    // 内部原因（如收益递减）只进内部日志，不给玩家看。
    rejected: (result.rejected || []).filter((r) => !isInternalReject(r)),
    suggestions: result.suggestions,
    event: result.event,
    settlement: result.settlement,
    death: result.death,
    scene: result.scene || { draw: false },
    state: toPublicState(state),
  };
}

// ---- 单回合主流程（纯函数） ----

function resolveTurn(state, input, opts) {
  const options = opts || {};
  const rng = options.rng || Math.random;
  const now = options.now == null ? Date.now() : options.now;
  const data = input && typeof input === 'object' ? input : {};
  const action = typeof data.action === 'string' ? data.action : '';

  const plan = data.plan || planTurn(state, { rng });
  const validation = validateProposal(state, data.proposal);
  if (validation.error) {
    // 无效回合：不推进 turn，状态原样退回。
    return { state, result: null, invalid: true, error: validation.error, plan };
  }
  const applied = validation.applied;
  const rejected = validation.rejected.slice();
  const prop = data.proposal && typeof data.proposal === 'object' ? data.proposal : {};

  // 收益递减：普通回合每个正向 +1 以概率 p=clamp((30-v)/25, 0.1, 1) 生效（用注入的 rng）。
  // 未生效的静默丢弃并记入 rejected（内部原因，不给玩家看）。事件结算绕过此处，不受此限。
  for (const key of Object.keys(applied.state_diff)) {
    const delta = applied.state_diff[key];
    if (delta <= 0) continue;
    let v = state.character.attrs[key];
    let landed = 0;
    for (let i = 0; i < delta; i++) {
      const p = clamp((30 - v) / 25, 0.1, 1);
      if (unit(rng) < p) {
        landed += 1;
        v += 1;
      } else {
        rejected.push(internalReject(`「${key}」+1 因收益递减未生效（当前值 ${v}）`));
      }
    }
    if (landed === 0) delete applied.state_diff[key];
    else applied.state_diff[key] = landed;
  }

  let s = cloneState(state);
  const nextTurn = plan.nextTurn;
  s.turn = nextTurn;

  // 越界累计：仅当回合 JSON 明确判定 overstep:true 才 +1（升级阶梯由 prompt 按累计次数给出）。
  if (prop.overstep === true) {
    s.oversteps = (Number.isInteger(s.oversteps) ? s.oversteps : 0) + 1;
  }

  // 事件开启（本回合开始前，标题/描述由本回合 LLM 输出通过 data.event 回传）
  let openedEvent = null;
  if (plan.opening) {
    const meta = data.event && typeof data.event === 'object' ? data.event : {};
    const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : plan.theme;
    const desc = typeof meta.desc === 'string' ? meta.desc : '';
    if (!meta.title) rejected.push('事件标题未提供，使用主题占位');
    openedEvent = { theme: plan.theme, title, desc, startedTurn: nextTurn };
    s.activeEvent = openedEvent;
    s.pendingEventTheme = null; // 预选主题已用于开启事件，消费掉
  } else if (plan.omen && plan.pendingEventTheme) {
    // 预兆回合：提前锁定主题，供后续预兆回合与真正开事件时使用。
    s.pendingEventTheme = plan.pendingEventTheme;
  }

  // 应用已消毒的提议
  s.character.attrs = applyRawEffect(s.character.attrs, applied.state_diff);
  s.character.items = s.character.items
    .filter((i) => !applied.items_remove.includes(i))
    .concat(applied.items_add);
  for (const name of Object.keys(applied.npc_attitude)) {
    if (!Object.prototype.hasOwnProperty.call(s.npcAttitude, name)) s.npcAttitude[name] = 0;
    s.npcAttitude[name] = clamp(s.npcAttitude[name] + applied.npc_attitude[name], NPC_MIN, NPC_MAX);
  }
  s.persona = Object.assign({}, applied.persona);

  // 事件结算（事件持续本回合，下一回合玩家的行动用于结算）
  let settlement = null;
  if (plan.settling) {
    if (!action.trim()) rejected.push('事件回合不可回避，空行动仍按公式结算');
    const raw = settleEvent(s, s.activeEvent, data.event_check, rng);
    if (raw.invalidAttr) rejected.push('event_check.attr 非白名单属性，回退为「体魄」');
    settlement = {
      theme: s.activeEvent.theme,
      title: s.activeEvent.title,
      tier: raw.tier,
      attr: raw.attr,
      response_quality: raw.response_quality,
      rand: raw.rand,
      score: raw.score,
      effects: raw.effects,
    };
    s.character.attrs = applyRawEffect(s.character.attrs, raw.effects);
    s.activeEvent = null;
    s.nextEventTurn = nextTurn + 7 + Math.floor(unit(rng) * 6); // turn + 7~12
  }

  // 死亡判定：体魄归零或事件殒命
  let death = null;
  const slainByEvent = !!(settlement && settlement.tier === '殒命');
  if (slainByEvent || s.character.attrs['体魄'] <= ATTR_MIN) {
    s.character.attrs['体魄'] = ATTR_MIN;
    const d = applyDeath(s, slainByEvent ? '事件殒命' : '体魄归零', nextTurn);
    s = d.state;
    death = d.death;
  }

  // 最近 6 回合，narration 截 300 字
  s.recent.push({ turn: nextTurn, action, narration: applied.narration.slice(0, RECENT_NARRATION_MAX) });
  if (s.recent.length > RECENT_MAX) s.recent = s.recent.slice(-RECENT_MAX);

  // 坊间传闻：可选字段，校验长度后入库，只留最近 10 条（含 turn）
  const rumor = normalizeRumor(prop.rumor);
  if (rumor) {
    if (!Array.isArray(s.rumors)) s.rumors = [];
    s.rumors.push({ turn: nextTurn, text: rumor });
    if (s.rumors.length > RUMORS_MAX) s.rumors = s.rumors.slice(-RUMORS_MAX);
  }

  // 事实账本：本回合新确立的客观事实（0~2 条，每条 ≤30 字），去重后入库，最多 40 条丢最旧。
  if (!Array.isArray(s.facts)) s.facts = [];
  const factInput = Array.isArray(prop.new_facts) ? prop.new_facts : [];
  let factsAdded = 0;
  for (const raw of factInput) {
    if (factsAdded >= FACTS_PER_TURN_MAX) break;
    const text = normalizeFact(raw);
    if (!text) continue;
    if (s.facts.some((f) => f && f.text === text)) continue; // 同一事实不重复入库
    s.facts.push({ turn: nextTurn, text });
    factsAdded += 1;
  }
  if (s.facts.length > FACTS_MAX) s.facts = s.facts.slice(-FACTS_MAX);

  // 印记：先按完全一致的文本移除已了结的，再追加新印记（每条 ≤16 字，最多 8 条丢最旧）。
  if (!Array.isArray(s.character.marks)) s.character.marks = [];
  const markRemove = Array.isArray(prop.marks_remove) ? prop.marks_remove : [];
  for (const raw of markRemove) {
    const text = normalizeMark(raw);
    if (!text) continue;
    s.character.marks = s.character.marks.filter((m) => m !== text);
  }
  const markAdd = Array.isArray(prop.marks_add) ? prop.marks_add : [];
  for (const raw of markAdd) {
    const text = normalizeMark(raw);
    if (!text || s.character.marks.includes(text)) continue;
    s.character.marks.push(text);
  }
  if (s.character.marks.length > MARKS_MAX) {
    s.character.marks = s.character.marks.slice(-MARKS_MAX);
  }

  // 未解之谜：先按完全一致的文本解开旧线索，再追加新线索；活跃最多 6 条，超出把最旧移入 fadedThreads。
  // threadsChanged 供导演机制判定「本回合 threads 是否变化」。
  let threadsChanged = false;
  if (!Array.isArray(s.threads)) s.threads = [];
  if (!Array.isArray(s.fadedThreads)) s.fadedThreads = [];
  const threadResolve = Array.isArray(prop.threads_resolve) ? prop.threads_resolve : [];
  for (const raw of threadResolve) {
    const text = normalizeThread(raw);
    if (!text) continue;
    const idx = s.threads.indexOf(text); // 必须与已有文本完全一致
    if (idx >= 0) {
      s.threads.splice(idx, 1);
      s.fadedThreads.push(text); // 已解开，归档不再活跃
      threadsChanged = true;
    }
  }
  const threadAdd = Array.isArray(prop.threads_add) ? prop.threads_add : [];
  for (const raw of threadAdd) {
    const text = normalizeThread(raw);
    if (!text || s.threads.includes(text)) continue;
    s.threads.push(text);
    threadsChanged = true;
    if (s.threads.length > THREADS_MAX) {
      s.fadedThreads.push(s.threads.shift()); // 最旧的淡去
    }
  }
  if (s.fadedThreads.length > FADED_THREADS_MAX) {
    s.fadedThreads = s.fadedThreads.slice(-FADED_THREADS_MAX);
  }

  // 地点与时间：校验 move_to / time_passes 后写入（叙事须与之一致，由 prompt 约束）
  const moveTo = normalizeMoveTo(state, prop.move_to, applied.narration);
  if (moveTo) s.location = moveTo;
  s.clock = advanceClock(s.clock, normalizeTimePasses(prop.time_passes));

  // 编年史：turn % 20 == 0，摘要由 LLM_MODEL_WORLD 生成后从 data.chapterSummary 回传
  let chapter = null;
  if (plan.needChapter && typeof data.chapterSummary === 'string' && data.chapterSummary.trim()) {
    chapter = {
      chapter: s.chronicle.length + 1,
      fromTurn: Math.max(1, nextTurn - 19),
      toTurn: nextTurn,
      summary: data.chapterSummary.trim().slice(0, CHRONICLE_MAX),
    };
    s.chronicle.push(chapter);
  }

  // 隐晦顶点：满足 → achievedAt + 高光 3 回合；3 回合后换新 apex（由编排层生成后回传）
  const apexInfo = { achieved: false, needNewApex: false, needHighlight: false, regenerated: false };
  if (s.apex && s.apex.achievedAt == null && apexConditionMet(s)) {
    s.apex.achievedAt = now;
    s.highlightUntilTurn = nextTurn + 3;
    apexInfo.achieved = true;
  }
  apexInfo.needHighlight = s.highlightUntilTurn > 0 && nextTurn <= s.highlightUntilTurn;
  if (s.apex && s.apex.achievedAt != null && nextTurn > s.highlightUntilTurn) {
    apexInfo.needNewApex = true;
    if (data.newApex && typeof data.newApex === 'object') {
      const generation = s.apex.generation + 1;
      s.apex = Object.assign({}, cloneState(data.newApex), { achievedAt: null, generation });
      s.highlightUntilTurn = 0;
      apexInfo.needNewApex = false;
      apexInfo.regenerated = true;
    }
  }

  // 导演机制：本回合的转折（plan.twist 由 planTurn 用 rng 选定）。
  // 触发转折的回合是明显的大事，sceneStreak 清零、记录 lastTwistTurn、重排 nextTwistTurn；
  // 转折词只随 result 写入 events.jsonl，绝不进入公开状态 / 公开回合结果。
  const twist = (plan && typeof plan.twist === 'string' && plan.twist) ? plan.twist : null;
  if (twist) {
    s.sceneStreak = 0;
    s.lastTwistTurn = nextTurn;
    s.nextTwistTurn = (plan && Number.isInteger(plan.nextTwistTurn))
      ? plan.nextTwistTurn
      : (nextTurn + TWIST_GAP_MIN + 3);
  } else {
    // 原地打转 = 地点没变 且 本回合没有 new_facts / threads 变化；否则清零重新计数。
    const boring = !moveTo && factsAdded === 0 && !threadsChanged;
    const prevStreak = Number.isInteger(state.sceneStreak) ? state.sceneStreak : 0;
    s.sceneStreak = boring ? prevStreak + 1 : 0;
  }

  // 关键回合（开启新事件 / 事件结算 / 死亡）强制出图，其余回合按 proposal.scene 决定。
  const forced = !!(openedEvent || settlement || death);
  const scene = normalizeScene(prop.scene, forced);

  const result = {
    turn: nextTurn,
    life: s.life,
    action,
    raw: data.raw === undefined ? null : data.raw,
    proposal: data.proposal === undefined ? null : data.proposal,
    applied,
    rejected,
    narration: applied.narration,
    suggestions: applied.suggestions,
    event: openedEvent,
    settlement,
    death,
    scene,
    apex: apexInfo, // 仅用于 events.jsonl 内部记录，接口返回前必须过滤
    twist,          // 本回合强制转折，仅写入 events.jsonl，绝不进公开状态 / 公开回合结果
    needChapter: !!(plan.needChapter && !chapter),
    needNewApex: apexInfo.needNewApex,
    ts: now,
  };
  return { state: s, result, invalid: false, error: null, plan };
}

module.exports = {
  ATTRS,
  PERSONA_DIMS,
  ATTR_MIN,
  ATTR_MAX,
  ATTR_INIT,
  NPC_MIN,
  NPC_MAX,
  DIFF_MIN,
  DIFF_MAX,
  DIFF_POSITIVE_TOTAL_MAX,
  GENERIC_EVENT_THEMES,
  TWISTS,
  TWIST_STREAK_THRESHOLD,
  TWIST_GAP_MIN,
  TWIST_GAP_SPAN,
  normalizeEventThemes,
  isInternalReject,
  NARRATION_MIN,
  NARRATION_MAX,
  clamp,
  toInt,
  allocateAttrs,
  startingFacts,
  createWorld,
  normalizeState,
  computeOmen,
  computeDanger,
  DANGER_THRESHOLD,
  DEFAULT_VOICES,
  OMEN_MIN_GAP,
  OMEN_MAX_GAP,
  RUMOR_MAX,
  RUMORS_MAX,
  normalizeRumor,
  normalizeScene,
  FACT_TEXT_MAX,
  FACTS_MAX,
  FACTS_PER_TURN_MAX,
  normalizeFact,
  MARK_TEXT_MAX,
  MARKS_MAX,
  normalizeMark,
  THREAD_TEXT_MAX,
  THREADS_MAX,
  FADED_THREADS_MAX,
  normalizeThread,
  PERIODS,
  MOVE_TO_MAX,
  TIME_PASSES_DEFAULT,
  normalizeMoveTo,
  normalizeTimePasses,
  advanceClock,
  EPITAPH_MAX,
  applyEpitaph,
  applyRebirthOpening,
  validateProposal,
  planTurn,
  settleEvent,
  applyRawEffect,
  apexConditionMet,
  applyDeath,
  rebirth,
  canTakeTurn,
  toPublicState,
  toPublicTurnResult,
  resolveTurn,
};
