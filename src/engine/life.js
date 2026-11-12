'use strict';

const { ATTRS, ATTR_MIN, ATTR_MAX, ATTR_INIT, RECENT_MAX, RECENT_NARRATION_MAX, EPITAPH_MAX } = require('./constants.js');
const { clamp, toInt, cloneState, baseItem } = require('./util.js');
const { resetStats } = require('./stats.js');

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
  s.stats = resetStats(s.stats); // 新一世：专属状态回到各自 start
  return { state: s, error: null };
}

// 新一世开场：重生时由编排层生成后写入状态。纯函数，不改入参。
// 作为该世第一条叙事：存进 state.rebirthOpening（供前端进入新一世显示），并压入 recent
// （供回合 prompt 的最近记录读取）；events.jsonl 由编排层另写一条公开记录。
// recent 正文与正常回合共用同一边界 RECENT_NARRATION_MAX（= NARRATION_MAX），保持完整。
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

module.exports = {
  apexConditionMet,
  applyDeath,
  rebirth,
  applyRebirthOpening,
  applyEpitaph,
  canTakeTurn,
};
