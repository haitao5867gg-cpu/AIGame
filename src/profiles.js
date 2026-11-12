'use strict';

// 玩家画像：按玩家（不是按世界）跨所有世界累积，越玩越贴合玩家本人。
// 文件 data/profiles.json，形状 { [playerId]: profile }，写入用 store.atomicWriteJson（原子覆盖）。
// 玩家 id 缺省按 'host'。读到坏数据一律按默认补齐、绝不抛错。
//
// 同一玩家并发写：recordTurn / applySummary / resetProfile 内部全是同步的
// 「读→改→写」，不含任何 await。Node 单线程下同步代码不会被交错执行，因此
// 同一玩家（乃至不同玩家）的并发写天然串行、不会丢更新，无需额外的 Promise 链。

const path = require('node:path');
const store = require('./store.js');
const { PERSONA_DIMS } = require('./engine/constants.js');

const VERSION = 1;
const DEFAULT_PLAYER = 'host';
const EMA_ALPHA = 0.06;
const RECENT_MAX = 30;
const READY_TURNS = 10;

const SUMMARY_MAX = 120;
const TRAIT_MAX = 8;
const TRAITS_MAX = 6;
const WANTS_MAX = 60;
const ACTION_TEXT_MAX = 60;
const ACTION_TITLE_MAX = 20;

function profilePath(dataDir) {
  return path.join(dataDir, 'profiles.json');
}

function playerId(id) {
  return typeof id === 'string' && id ? id : DEFAULT_PLAYER;
}

function clampEma(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function defaultEma() {
  const ema = {};
  for (const d of PERSONA_DIMS) ema[d] = 0;
  return ema;
}

function defaultProfile() {
  return {
    version: VERSION,
    turns: 0,
    ema: defaultEma(),
    recentActions: [],
    summary: '',
    traits: [],
    wants: '',
    summaryTurn: 0,
    updatedAt: 0,
  };
}

// 消毒 traits：只取字符串、trim、截 8、去重、最多 6 个。
function sanitizeTraits(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  const seen = new Set();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const v = t.trim().slice(0, TRAIT_MAX);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= TRAITS_MAX) break;
  }
  return out;
}

// 归一化：任何输入都补成完整合法 profile 的副本；坏数据一律回退默认。
function normalizeProfile(raw) {
  const out = defaultProfile();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  out.version = VERSION;
  if (Number.isInteger(r.turns) && r.turns >= 0) out.turns = r.turns;
  if (r.ema && typeof r.ema === 'object' && !Array.isArray(r.ema)) {
    for (const d of PERSONA_DIMS) out.ema[d] = clampEma(r.ema[d]);
  }
  if (Array.isArray(r.recentActions)) {
    const acts = [];
    for (const a of r.recentActions) {
      if (!a || typeof a !== 'object' || typeof a.text !== 'string') continue;
      acts.push({
        text: a.text.slice(0, ACTION_TEXT_MAX),
        genre: typeof a.genre === 'string' ? a.genre : '',
        title: typeof a.title === 'string' ? a.title.slice(0, ACTION_TITLE_MAX) : '',
        ts: Number.isFinite(a.ts) ? a.ts : 0,
      });
    }
    out.recentActions = acts.slice(-RECENT_MAX);
  }
  if (typeof r.summary === 'string') out.summary = r.summary.slice(0, SUMMARY_MAX);
  out.traits = sanitizeTraits(r.traits);
  if (typeof r.wants === 'string') out.wants = r.wants.slice(0, WANTS_MAX);
  if (Number.isInteger(r.summaryTurn) && r.summaryTurn >= 0) out.summaryTurn = r.summaryTurn;
  if (Number.isFinite(r.updatedAt)) out.updatedAt = r.updatedAt;
  return out;
}

// 读整张表：文件损坏 / 非对象时返回 {}，绝不抛错。
function readAll(dataDir) {
  let v;
  try {
    v = store.readJson(profilePath(dataDir), {});
  } catch (_) {
    return {};
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function writeProfile(dataDir, id, profile) {
  const all = readAll(dataDir);
  all[playerId(id)] = profile;
  store.atomicWriteJson(profilePath(dataDir), all);
}

function getProfile(dataDir, id) {
  return normalizeProfile(readAll(dataDir)[playerId(id)]);
}

function recordTurn(dataDir, id, opts) {
  const o = opts || {};
  const p = getProfile(dataDir, id);
  const hit = new Set(
    (Array.isArray(o.tags) ? o.tags : []).filter((t) => PERSONA_DIMS.includes(t)),
  );
  for (const d of PERSONA_DIMS) {
    const target = hit.has(d) ? 1 : 0;
    // ema += 0.06 * (是否命中 - ema)，保留 4 位小数。
    const next = p.ema[d] + EMA_ALPHA * (target - p.ema[d]);
    p.ema[d] = Math.round(next * 10000) / 10000;
  }
  p.turns += 1;
  const action = typeof o.action === 'string' ? o.action.trim() : '';
  const timeSkip = action.startsWith('【时光推进');
  if (action && o.adult !== true && !timeSkip) {
    p.recentActions.push({
      text: action.slice(0, ACTION_TEXT_MAX),
      genre: typeof o.genre === 'string' ? o.genre : '',
      title: typeof o.title === 'string' ? o.title.slice(0, ACTION_TITLE_MAX) : '',
      ts: Number.isFinite(o.now) ? o.now : Date.now(),
    });
    if (p.recentActions.length > RECENT_MAX) {
      p.recentActions = p.recentActions.slice(-RECENT_MAX);
    }
  }
  p.updatedAt = Number.isFinite(o.now) ? o.now : Date.now();
  writeProfile(dataDir, id, p);
  return p;
}

function applySummary(dataDir, id, input, now) {
  const p = getProfile(dataDir, id);
  const src = input && typeof input === 'object' ? input : {};
  p.summary = typeof src.summary === 'string' ? src.summary.slice(0, SUMMARY_MAX) : '';
  p.traits = sanitizeTraits(src.traits);
  p.wants = typeof src.wants === 'string' ? src.wants.slice(0, WANTS_MAX) : '';
  p.summaryTurn = p.turns;
  p.updatedAt = Number.isFinite(now) ? now : Date.now();
  writeProfile(dataDir, id, p);
  return p;
}

function resetProfile(dataDir, id) {
  const all = readAll(dataDir);
  delete all[playerId(id)];
  store.atomicWriteJson(profilePath(dataDir), all);
  return defaultProfile();
}

// 给前端 / 提示词的视图：不暴露 recentActions。dims 把 ema 归一到 0..100，
// 六项全为 0 时都给 50（尚无倾向）。ready = turns >= 10。
function publicProfile(profile) {
  const p = normalizeProfile(profile);
  let maxEma = 0;
  for (const d of PERSONA_DIMS) maxEma = Math.max(maxEma, p.ema[d]);
  const dims = {};
  for (const d of PERSONA_DIMS) {
    dims[d] = maxEma === 0 ? 50 : Math.round((100 * p.ema[d]) / maxEma);
  }
  return {
    turns: p.turns,
    dims,
    traits: p.traits.slice(),
    summary: p.summary,
    wants: p.wants,
    ready: p.turns >= READY_TURNS,
  };
}

// 给新世界用的初始 persona：turns < 10 返回 null；否则 35~65，保留个人倾向但不走极端。
function seedPersona(profile) {
  const pp = publicProfile(profile);
  if (pp.turns < READY_TURNS) return null;
  const persona = {};
  for (const d of PERSONA_DIMS) {
    persona[d] = 35 + Math.round((30 * pp.dims[d]) / 100);
  }
  return persona;
}

module.exports = {
  VERSION,
  profilePath,
  defaultProfile,
  getProfile,
  recordTurn,
  applySummary,
  resetProfile,
  publicProfile,
  seedPersona,
};
