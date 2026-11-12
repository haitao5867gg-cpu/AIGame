'use strict';

const { ATTRS, ATTR_INIT, ATTR_EXTRA_TOTAL, ATTR_EXTRA_MAX, TWIST_GAP_MIN, TWIST_GAP_SPAN, PERIODS } = require('./constants.js');
const { normalizeGenre } = require('../genres.js');
const { unit, normalizeEventThemes, cloneState, freshPersona, startingItems, startingFacts, initialNpcAttitude, normalizePrologue, cleanItemInfo } = require('./util.js');
const { normalizeStatsSpec } = require('./stats.js');
const npcs = require('../npcs.js');

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
  // 序章规范化：非法 / 缺字段就整段删掉，留待老世界补生成。
  const prologue = normalizePrologue(bible.prologue);
  if (prologue) bible.prologue = prologue;
  else delete bible.prologue;
  const startItems = startingItems(bible);
  const genre = normalizeGenre(s.genre);
  const world = {
    id: s.id,
    createdAt: s.createdAt == null ? now : s.createdAt,
    seed: s.seed || '',
    genre,
    bible,
    apex: Object.assign({ achievedAt: null, generation: 1 }, cloneState(s.apex || {})),
    life: 1,
    turn: 0,
    character: {
      name: s.name || '',
      appearance: s.appearance || '',
      attrs: allocateAttrs(s.alloc),
      items: startItems,
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
    // 开场时段跟着开场情境走（bible.start.period）；缺失 / 非法时仍从清晨开始。
    clock: { day: 1, period: (bible.start && PERIODS.includes(bible.start.period)) ? bible.start.period : PERIODS[0] },
    pastLives: [],           // 前世墓志铭 [{life,name,epitaph,turns,cause}]
    chronicle: [],
    recent: [],
    rebirthOpening: '',      // 本世（第 1 世为空）由重生生成的新一世开场叙事
    highlightUntilTurn: 0,
    awaitingRebirth: false,
    // 起始物品介绍：只接受真正加入物品栏的名字，desc/type 由 cleanItemInfo 消毒。
    itemInfo: cleanItemInfo(bible.start && bible.start.items_info, startItems),
    // 世界专属状态：bible.stats 是原始设计（原样存进 bible），这里按归一后的 genre
    // 消毒成运行数据；缺失 / 非法时用题材兜底模板。
    stats: normalizeStatsSpec(bible.stats, genre),
  };
  // 新世界：初始化 NPC 长期档案（按 bible.npcs 建立完整 original 基线，标记已迁移）。
  return npcs.initializeNpcMemory(world);
}

module.exports = {
  allocateAttrs,
  createWorld,
};
