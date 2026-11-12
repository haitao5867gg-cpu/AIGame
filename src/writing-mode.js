'use strict';

// 叙事 v3：写作模式 → 写正文 / 记账用的模型和按次请求参数。
// 网关实测（2026-11-12）：强模型默认先思考，第一句约 50 秒；reasoning_effort:"low" 第一句约 6 秒；
// thinking:{type:"disabled"} 关掉思考。快速模型默认也会思考，记账时必须关掉。
// 显式写出 thinking，避免全局 LLM_EXTRA_BODY 里的设置把模式盖掉；null 表示从请求体删掉该键。

const MODES = Object.freeze({
  fine: { label: '精写', extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'low' } },
  deep: { label: '深度精写', extraBody: { thinking: { type: 'enabled' }, reasoning_effort: null } },
  fast: { label: '快写', extraBody: { thinking: { type: 'disabled' }, reasoning_effort: null } },
});

function writingCall(cfg, mode) {
  const c = cfg || {};
  const m = MODES[mode] ? mode : 'fine';
  return {
    mode: m,
    model: c.STORY_MODEL || c.LLM_MODEL_WORLD || c.LLM_MODEL,
    extraBody: JSON.parse(JSON.stringify(MODES[m].extraBody)),
    label: MODES[m].label,
  };
}

function ledgerCall(cfg) {
  const c = cfg || {};
  return {
    model: c.STORY_LEDGER_MODEL || c.LLM_MODEL,
    extraBody: { thinking: { type: 'disabled' }, reasoning_effort: null },
  };
}

module.exports = { writingCall, ledgerCall, MODES };
