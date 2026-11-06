'use strict';

const { isInternalReject, computeOmen, computeDanger, cloneState } = require('./util.js');

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
    voice_hints: Array.isArray(result.voice_hints) ? result.voice_hints : [],
    adult: result.adult === true, // 成人回合标记：前端据此只用浏览器朗读
    state: toPublicState(state),
  };
}

module.exports = {
  toPublicState,
  toPublicTurnResult,
};
