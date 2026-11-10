'use strict';

const { ATTRS, ATTR_MIN, ATTR_MAX, GENERIC_EVENT_THEMES, TWISTS, TWIST_STREAK_THRESHOLD, TWIST_GAP_MIN, TWIST_GAP_SPAN } = require('./constants.js');
const { clamp, toInt, unit, computeOmen, QUIET_FOCUS } = require('./util.js');

// 同一进行中事件的结算在安静模式下最多顺延的回合数，超过后照常结算。
const MAX_QUIET_POSTPONE = 3;

// ---- 事件排程 ----

// 本回合开始前决定：是否开新事件、是否结算旧事件、是否压编年史。
function planTurn(state, opts) {
  const options = opts || {};
  // 时光推进：复用回合流程但不排新事件 / 预兆 / 转折，安静模式一律关掉。
  // 有进行中事件时本回合照常结算（不论 startedTurn，也不顺延），让模型在这段时间里交代结局。
  if (options.timeSkip) {
    const nextTurn = state.turn + 1;
    const settling = !!state.activeEvent;
    return {
      nextTurn,
      quiet: false,
      settlePostponed: false,
      settling,
      opening: false,
      theme: null,
      omen: false,
      omenTheme: null,
      pendingEventTheme: null,
      twist: null,
      nextTwistTurn: null,
      needEvent: false,
      needSettlement: settling,
      needChapter: nextTurn % 20 === 0,
      timeSkip: options.timeSkip,
    };
  }
  const rng = options.rng || Math.random;
  const nextTurn = state.turn + 1;
  let themes =
    state.bible && Array.isArray(state.bible.eventThemes)
      ? state.bible.eventThemes.filter((t) => typeof t === 'string' && t)
      : [];
  // 主题为空（旧世界或异常设定）时用通用主题兜底，保证事件仍能开启。
  if (themes.length === 0) themes = GENERIC_EVENT_THEMES.slice();
  const hasActive = !!state.activeEvent;
  // 安静模式：上一回合玩家在社交 / 私下独处 / 休息 / 亲密，或在继续同一件事。
  // 此时不让定时事件、导演转折打断玩家正在做的事；nextEventTurn 保持不变，
  // 等安静结束后的第一回合再按原排程开启。
  const quiet = QUIET_FOCUS.includes(state.focus) || state.continuing === true;
  const shouldSettle = hasActive && state.activeEvent.startedTurn < nextTurn;
  const postpones = hasActive && Number.isInteger(state.activeEvent.postpones)
    ? state.activeEvent.postpones : 0;
  // 进行中事件的结算也顺延，但同一事件最多顺延 3 回合，超过后照常结算（叙事写成背景里发生）。
  const settlePostponed = shouldSettle && quiet && postpones < MAX_QUIET_POSTPONE;
  const settling = shouldSettle && !settlePostponed;
  const opening = !quiet && !hasActive && nextTurn >= state.nextEventTurn && themes.length > 0;
  // 风声预兆窗口：无进行中事件、距下次事件 1~2 回合。安静模式下照常（只是背景钩子）。
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
  // 安静模式不注入导演转折，sceneStreak 也不累加（由 resolveTurn 处理）。
  if (!quiet && !eventTurn && (streakHit || timeHit)) {
    twist = TWISTS[Math.floor(unit(rng) * TWISTS.length)];
    // 本次转折后重新排下一次时间型转折（随机 9~14 回合），避免连续触发。
    nextTwistTurn = nextTurn + TWIST_GAP_MIN + Math.floor(unit(rng) * TWIST_GAP_SPAN);
  }

  return {
    nextTurn,
    quiet,                                  // 本回合是否安静模式（供提示词使用）
    settlePostponed,                        // 本回合把进行中事件的结算顺延了一回合
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

module.exports = {
  planTurn,
  settleEvent,
  applyRawEffect,
};
