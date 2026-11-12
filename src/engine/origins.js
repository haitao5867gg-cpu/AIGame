'use strict';

// 出身（2026-11-12 起取代建世界时手动分配属性点）：建世界时 AI 按世界和玩家的「你是谁」给 3 个出身，
// 每个出身带一套属性倾向（额外 6 点、单项 ≤3）和一件起始物品；玩家在序章卡上选一个。
// 纯函数：不改入参。

const { ATTRS, ATTR_EXTRA_TOTAL, ATTR_EXTRA_MAX, PERSONA_DIMS, ITEM_NAME_MAX, ITEM_INFO_DESC_MAX, ITEM_INFO_TYPE_MAX } = require('./constants.js');
const { cloneState } = require('./util.js');

const ORIGINS_MAX = 4;
const TITLE_MAX = 8;
const BLURB_MAX = 48;

function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// 任意输入 → 合法的额外点分配（整数、单项 0..3、合计正好 6）。先夹单项，再从最大的减 / 给最小的加。
function normalizeAlloc(raw) {
  const out = {};
  for (const a of ATTRS) {
    const v = raw && typeof raw === 'object' ? Number(raw[a]) : NaN;
    out[a] = Number.isFinite(v) ? Math.max(0, Math.min(ATTR_EXTRA_MAX, Math.round(v))) : 0;
  }
  let total = ATTRS.reduce((s, a) => s + out[a], 0);
  if (total === 0) { for (const a of ATTRS) out[a] = 1; return out; }
  while (total > ATTR_EXTRA_TOTAL) {
    const a = ATTRS.slice().sort((x, y) => out[y] - out[x])[0];
    out[a] -= 1; total -= 1;
  }
  while (total < ATTR_EXTRA_TOTAL) {
    const a = ATTRS.slice().filter((x) => out[x] < ATTR_EXTRA_MAX).sort((x, y) => out[x] - out[y])[0];
    out[a] += 1; total += 1;
  }
  return out;
}

function normalizeOrigin(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const title = text(raw.title, TITLE_MAX);
  if (!title) return null;
  const item = raw.item && typeof raw.item === 'object' ? raw.item : null;
  const itemName = item ? text(item.name, ITEM_NAME_MAX) : '';
  return {
    title,
    blurb: text(raw.blurb, BLURB_MAX),
    style: PERSONA_DIMS.includes(raw.style) ? raw.style : '',
    custom: raw.custom === true,
    alloc: normalizeAlloc(raw.attrs || raw.alloc),
    item: itemName ? { name: itemName, desc: text(item.desc, ITEM_INFO_DESC_MAX), type: text(item.type, ITEM_INFO_TYPE_MAX) } : null,
  };
}

function normalizeOrigins(raw) {
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const o = normalizeOrigin(r);
    if (o && !out.some((x) => x.title === o.title)) out.push(o);
    if (out.length >= ORIGINS_MAX) break;
  }
  return out;
}

// 选出身：只在第 0 回合、还没选过时允许。返回 { state, error }。
function applyOrigin(state, index) {
  const s0 = state || {};
  const list = Array.isArray(s0.origins) ? s0.origins : [];
  if (!(s0.turn === 0)) return { state: s0, error: '故事已经开始，不能再换出身' };
  if (s0.character && s0.character.origin) return { state: s0, error: '已经选过出身了' };
  const o = Number.isSafeInteger(index) ? list[index] : null;
  if (!o) return { state: s0, error: '没有这个出身' };
  const s = cloneState(s0);
  const attrs = {};
  for (const a of ATTRS) attrs[a] = 5 + (o.alloc[a] || 0);
  s.character.attrs = attrs;
  s.character.origin = { title: o.title, blurb: o.blurb, style: o.style };
  if (o.item && !s.character.items.includes(o.item.name)) {
    s.character.items = s.character.items.concat([o.item.name]);
    s.itemInfo = Object.assign({}, s.itemInfo || {});
    if (o.item.desc) s.itemInfo[o.item.name] = o.item.type ? { desc: o.item.desc, type: o.item.type } : { desc: o.item.desc };
  }
  return { state: s, error: null };
}

module.exports = { normalizeAlloc, normalizeOrigin, normalizeOrigins, applyOrigin, ORIGINS_MAX };
