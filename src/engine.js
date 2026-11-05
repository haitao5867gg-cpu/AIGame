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
const DIFF_MAX = 2;
const DIFF_POSITIVE_TOTAL_MAX = 3;

const ITEMS_ADD_MAX = 2;
const ITEM_NAME_MAX = 12;
const NARRATION_MIN = 10;
const NARRATION_MAX = 1200;
const RECENT_MAX = 6;
const RECENT_NARRATION_MAX = 300;
const CHRONICLE_MAX = 300;
const PERSONA_INIT = 50;
const PERSONA_REGRESSION = 0.2;

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

function cloneState(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function freshPersona() {
  const p = {};
  for (const dim of PERSONA_DIMS) p[dim] = PERSONA_INIT;
  return p;
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
  return {
    id: s.id,
    createdAt: s.createdAt == null ? now : s.createdAt,
    seed: s.seed || '',
    bible: cloneState(s.bible || {}),
    apex: Object.assign({ achievedAt: null, generation: 1 }, cloneState(s.apex || {})),
    life: 1,
    turn: 0,
    character: {
      name: s.name || '',
      appearance: s.appearance || '',
      attrs: allocateAttrs(s.alloc),
      items: [],
      alive: true,
      bornTurn: 0,
    },
    npcAttitude: Object.assign({}, s.npcAttitude || {}),
    persona: freshPersona(),
    nextEventTurn: 7 + Math.floor(unit(rng) * 6), // 7~12 随机
    activeEvent: null,
    chronicle: [],
    recent: [],
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

  // state_diff：白名单 / 取整 / 单项 [-2,2] / 正向总和 ≤ 3（按顺序截断）/ 属性 [0,40]
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
  const themes =
    state.bible && Array.isArray(state.bible.eventThemes)
      ? state.bible.eventThemes.filter((t) => typeof t === 'string' && t)
      : [];
  const hasActive = !!state.activeEvent;
  const settling = hasActive && state.activeEvent.startedTurn < nextTurn;
  const opening = !hasActive && nextTurn >= state.nextEventTurn && themes.length > 0;
  const theme = opening ? themes[Math.floor(unit(rng) * themes.length)] : null;
  return {
    nextTurn,
    settling,
    opening,
    theme,
    needEvent: opening, // 需要本回合 LLM 输出 event.title / event.desc
    needSettlement: settling, // 需要本回合 LLM 输出 event_check
    needChapter: nextTurn % 20 === 0,
  };
}

// 事件四档结算（纯函数）。score = 属性 + response_quality*4 + rng 0~6。
function settleEvent(state, event, eventCheck, rng) {
  const check = eventCheck && typeof eventCheck === 'object' ? eventCheck : {};
  const attrValid = ATTRS.includes(check.attr);
  const attr = attrValid ? check.attr : '体魄';
  const quality = clamp(toInt(check.response_quality == null ? 0 : check.response_quality), 0, 3);
  const rand = Math.floor(unit(rng) * 7); // 0~6
  const score = state.character.attrs[attr] + quality * 4 + rand;
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

// 直接套用数值效果（事件结算绕过 ±2 / 正向总和 3 的限制），仍夹在 [0,40]。
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
  s.character.bornTurn = s.turn;
  s.awaitingRebirth = false;
  return { state: s, error: null };
}

function canTakeTurn(state) {
  return !state.awaitingRebirth;
}

// ---- 对外视图：apex 与 Key 绝不出现在接口返回里 ----

function toPublicState(state) {
  const out = cloneState(state || {});
  for (const key of Object.keys(out)) {
    if (key === 'apex' || /api.?key/i.test(key)) delete out[key];
  }
  return out;
}

function toPublicTurnResult(result, state) {
  return {
    narration: result.narration,
    applied: result.applied,
    rejected: result.rejected,
    suggestions: result.suggestions,
    event: result.event,
    settlement: result.settlement,
    death: result.death,
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

  let s = cloneState(state);
  const nextTurn = plan.nextTurn;
  s.turn = nextTurn;

  // 事件开启（本回合开始前，标题/描述由本回合 LLM 输出通过 data.event 回传）
  let openedEvent = null;
  if (plan.opening) {
    const meta = data.event && typeof data.event === 'object' ? data.event : {};
    const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : plan.theme;
    const desc = typeof meta.desc === 'string' ? meta.desc : '';
    if (!meta.title) rejected.push('事件标题未提供，使用主题占位');
    openedEvent = { theme: plan.theme, title, desc, startedTurn: nextTurn };
    s.activeEvent = openedEvent;
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
    apex: apexInfo, // 仅用于 events.jsonl 内部记录，接口返回前必须过滤
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
  NARRATION_MIN,
  NARRATION_MAX,
  clamp,
  toInt,
  allocateAttrs,
  createWorld,
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
