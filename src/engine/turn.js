'use strict';

const { ATTR_MIN, NPC_MIN, NPC_MAX, TWIST_GAP_MIN, RECENT_MAX, RECENT_NARRATION_MAX, CHRONICLE_MAX, RUMORS_MAX, FACTS_MAX, FACTS_PER_TURN_MAX, MARKS_MAX, THREADS_MAX, FADED_THREADS_MAX } = require('./constants.js');
const { clamp, unit, internalReject, normalizeRumor, normalizeScene, normalizeFact, normalizeMark, normalizeThread, normalizeMoveTo, normalizeTimePasses, normalizeVoiceHints, normalizeFocus, normalizeAdult, advanceClock, cloneState, cleanItemInfo } = require('./util.js');
const { validateProposal } = require('./proposal.js');
const { planTurn, settleEvent, applyRawEffect } = require('./events.js');
const { apexConditionMet, applyDeath } = require('./life.js');
const npcs = require('../npcs.js');

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

  // 玩家意图 / 成人标记：消毒后写入公开状态，供下一回合 planTurn 判定安静模式、前端朗读判定。
  const nf = normalizeFocus(prop);
  s.focus = nf.focus;
  s.continuing = nf.continuing;
  const adult = normalizeAdult(prop.adult);
  s.adult = adult;

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
  // 安静模式顺延结算：给进行中事件累计一次 postpones，超过 3 次后 planTurn 会照常结算。
  if (plan.settlePostponed && s.activeEvent) {
    s.activeEvent = Object.assign({}, s.activeEvent, {
      postpones: (Number.isInteger(s.activeEvent.postpones) ? s.activeEvent.postpones : 0) + 1,
    });
  }

  // 应用已消毒的提议
  s.character.attrs = applyRawEffect(s.character.attrs, applied.state_diff);
  s.character.items = s.character.items
    .filter((i) => !applied.items_remove.includes(i))
    .concat(applied.items_add);
  // 新增物品介绍：只接受本回合真正加入的物品名，介绍消毒后并入 itemInfo。
  // 物品被移除时保留介绍（再次获得可复用），故只增不删。
  const itemInfoAdd = cleanItemInfo(prop.items_info, applied.items_add);
  if (Object.keys(itemInfoAdd).length) {
    s.itemInfo = Object.assign({}, s.itemInfo || {}, itemInfoAdd);
  }
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

  // 最近 6 回合，每条保留引擎已接纳的完整正文（上限 RECENT_NARRATION_MAX = NARRATION_MAX）。
  // applied.narration 已由 validateProposal 截到 NARRATION_MAX，这里再切一次只作同边界兜底。
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
  const prevStreak = Number.isInteger(state.sceneStreak) ? state.sceneStreak : 0;
  if (twist) {
    s.sceneStreak = 0;
    s.lastTwistTurn = nextTurn;
    s.nextTwistTurn = (plan && Number.isInteger(plan.nextTwistTurn))
      ? plan.nextTwistTurn
      : (nextTurn + TWIST_GAP_MIN + 3);
  } else if (plan && plan.quiet) {
    // 安静模式：原地打转计数保持不变，既不累加也不清零，供安静结束后继续按原节奏判定。
    s.sceneStreak = prevStreak;
  } else {
    // 原地打转 = 地点没变 且 本回合没有 new_facts / threads 变化；否则清零重新计数。
    const boring = !moveTo && factsAdded === 0 && !threadsChanged;
    s.sceneStreak = boring ? prevStreak + 1 : 0;
  }

  // 关键回合（开启新事件 / 事件结算 / 死亡）强制出图，其余回合按 proposal.scene 决定。
  const forced = !!(openedEvent || settlement || death);
  const scene = normalizeScene(prop.scene, forced);
  // 亲密 / 成人回合不出图：焦点是玩家与 NPC 的相处，不生成场景插图。
  if (nf.focus === 'intimate' || adult) scene.draw = false;

  // NPC 长期档案：仅在叙事 / 数值结算都已验证有效后应用 npc_updates。
  // 时间 / 主角名 / 世数取原 beforeState（state），死亡当回合不落入下一世。
  // 变化仅落在私有 result.npc_memory，绝不进入公开 applied / 普通回合响应。
  const rawNpcUpdates = prop.npc_updates !== undefined ? prop.npc_updates : data.npc_updates;
  const npcMem = npcs.applyNpcMemory(state, s, rawNpcUpdates, {
    action,
    narration: applied.narration,
  });
  s = npcMem.state;
  for (const r of npcMem.rejected) rejected.push(internalReject(r));

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
    voice_hints: normalizeVoiceHints(prop.voice_hints), // 朗读提示：坏数据不影响回合
    adult,          // 本回合是否含成人露骨内容：进公开结果 / events 记录，供前端朗读判定
    apex: apexInfo, // 仅用于 events.jsonl 内部记录，接口返回前必须过滤
    twist,          // 本回合强制转折，仅写入 events.jsonl，绝不进公开状态 / 公开回合结果
    npc_memory: npcMem.changes, // 私有：仅 game.appendEvent 落库，绝不进公开 applied / 响应
    needChapter: !!(plan.needChapter && !chapter),
    needNewApex: apexInfo.needNewApex,
    ts: now,
  };
  return { state: s, result, invalid: false, error: null, plan };
}

module.exports = {
  resolveTurn,
};
