'use strict';

const { isInternalReject, computeOmen, computeDanger, cloneState } = require('./util.js');
const npcs = require('../npcs.js');

// ---- 对外视图：apex / Key / 私有档案绝不出现在接口返回里 ----

// 普通回合 applied 的公开白名单：即便有人误把 npc_memory / npc_updates /
// original / internal 塞进 applied，也只放行这些已消毒的玩法字段。
const APPLIED_PUBLIC_KEYS = Object.freeze([
  'state_diff', 'items_add', 'items_remove', 'npc_attitude',
  'persona_tags', 'persona', 'suggestions', 'narration',
]);

function toPublicApplied(applied) {
  const a = applied && typeof applied === 'object' ? applied : {};
  const out = {};
  for (const k of APPLIED_PUBLIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
  }
  return out;
}

function toPublicState(state) {
  const out = cloneState(state || {});
  for (const key of Object.keys(out)) {
    // pendingEventTheme 是提前锁定的内部主题，绝不能以主题名暴露给玩家；
    // twist 是导演的强制转折信号，只写进 events.jsonl，绝不出现在公开状态里。
    if (key === 'apex' || key === 'pendingEventTheme' || key === 'twist' || /api.?key/i.test(key)) {
      delete out[key];
    }
  }
  // NPC 长期档案：内部 profile（含 original / internal / want / 隐藏动机）→ 公开白名单投影。
  // 私有 state 的完整 bible / npcProfiles 原文不改写（cloneState 已是副本）。
  out.npcProfiles = npcs.publicNpcProfiles(out);
  const bibleNpcs = npcs.publicBibleNpcs(out);
  if (bibleNpcs !== undefined && out.bible && typeof out.bible === 'object') {
    out.bible.npcs = bibleNpcs; // 过滤 want 等隐藏动机及未知私有字段
  }
  // 风声预兆：只给出布尔标记，从不带出主题名。
  out.omen = computeOmen(out);
  // 濒死可感知：体魄 ≤ 2 时公开状态带 danger:true，前端据此变红闪烁并提示「伤势沉重」。
  out.danger = computeDanger(out);
  return out;
}

// 时光推进公开字段：逐字段取，类型不对就不输出；无有效字段时整体不输出。
function publicTimeSkip(ts) {
  if (!ts || typeof ts !== 'object' || Array.isArray(ts)) return null;
  const out = {};
  if (typeof ts.span === 'string') out.span = ts.span;
  if (typeof ts.days === 'number' && Number.isFinite(ts.days)) out.days = ts.days;
  if (typeof ts.label === 'string') out.label = ts.label;
  if (typeof ts.plan === 'string') out.plan = ts.plan;
  return Object.keys(out).length ? out : null;
}

function toPublicTurnResult(result, state) {
  const ts = publicTimeSkip(result.timeSkip);
  return {
    ...(ts ? { timeSkip: ts } : {}),
    narration: result.narration,
    applied: toPublicApplied(result.applied),
    // 内部原因（如收益递减 / npc_updates 拒绝）只进内部日志，不给玩家看。
    rejected: (result.rejected || []).filter((r) => !isInternalReject(r)),
    suggestions: result.suggestions,
    event: result.event,
    settlement: result.settlement,
    death: result.death,
    scene: result.scene || { draw: false },
    voice_hints: Array.isArray(result.voice_hints) ? result.voice_hints : [],
    adult: result.adult === true, // 成人回合标记：前端据此只用浏览器朗读
    state: toPublicState(state),
  };
}

module.exports = {
  toPublicState,
  toPublicTurnResult,
};
