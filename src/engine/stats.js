'use strict';

// 第 4 节 · 世界专属状态（state.stats）。
// 纯函数：不改入参、不读写文件、不联网。数据存在 state.stats（数组），
// 老存档可能没有该字段，所有函数都把「缺失 / 非数组」当 [] 处理，绝不抛错。

const {
  ATTRS,
  STATS_MAX,
  STATS_GAUGE_DIFF,
  STATS_RANK_DIFF,
  STATS_SKIP_GAUGE_DIFF,
  STATS_SKIP_RANK_DIFF,
  TIME_PASSES_MIN,
  TIME_PASSES_MAX,
} = require('./constants.js');
const { clamp, toInt, cloneState } = require('./util.js');

const STAT_DESC_MAX = 30;
const STAT_WARN_LABEL_MAX = 8;
const STAT_WARN_EFFECT_MAX = 40;
const STAT_WARN_MAX = 3;
const STAT_RANKS_MAX = 12;
const STAT_RANK_NAME_MAX = 8;

function asStats(stats) {
  return Array.isArray(stats) ? stats : [];
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// 数值槽 / 阶梯的整数字段：缺省或非法值用 def，其余取整后夹到 [lo,hi]。
function intField(v, def, lo, hi) {
  return clamp(isNum(v) ? toInt(v) : def, lo, hi);
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// 单条警戒：必须恰好有 below 或 above 之一，label 非空，drain 仅保留基础属性。
function cleanWarn(raw, max) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const below = isNum(raw.below) ? clamp(toInt(raw.below), 1, max - 1) : null;
  const above = isNum(raw.above) ? clamp(toInt(raw.above), 1, max - 1) : null;
  if ((below === null) === (above === null)) return null; // 都有或都没有 → 丢
  if (typeof raw.label !== 'string') return null;
  const label = cleanText(raw.label, STAT_WARN_LABEL_MAX);
  if (!label) return null;
  const out = {};
  if (below !== null) out.below = below;
  else out.above = above;
  out.label = label;
  out.effect = cleanText(raw.effect, STAT_WARN_EFFECT_MAX);
  if (ATTRS.includes(raw.drain)) out.drain = raw.drain;
  return out;
}

// 单个 stat 消毒：不合法返回 null；value 一律等于 start（新开局形状）。
function cleanStat(raw, seen) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 1 || name.length > 6) return null;
  if (ATTRS.includes(name) || seen.has(name)) return null;
  const kind = raw.kind === 'rank' ? 'rank' : 'gauge';
  let icon = '';
  if (typeof raw.icon === 'string') {
    const t = raw.icon.trim();
    if (t.length >= 1 && t.length <= 4) icon = t;
  }
  if (!icon) icon = kind === 'rank' ? '★' : '◆';
  const desc = cleanText(raw.desc, STAT_DESC_MAX);

  if (kind === 'rank') {
    if (!Array.isArray(raw.ranks)) return null;
    const ranks = [];
    for (const r of raw.ranks) {
      if (typeof r !== 'string') continue;
      const t = cleanText(r, STAT_RANK_NAME_MAX);
      if (!t || ranks.includes(t)) continue;
      ranks.push(t);
      if (ranks.length >= STAT_RANKS_MAX) break;
    }
    if (ranks.length < 2) return null;
    const start = intField(raw.start, 0, 0, ranks.length - 1);
    seen.add(name);
    return { name, kind, icon, desc, ranks, start, value: start };
  }

  const max = intField(raw.max, 100, 10, 1000);
  const start = intField(raw.start, Math.round(max * 0.7), 0, max);
  const drift = intField(raw.drift, 0, -10, 10);
  const warn = [];
  const rawWarn = Array.isArray(raw.warn) ? raw.warn : [];
  for (const w of rawWarn) {
    if (warn.length >= STAT_WARN_MAX) break;
    const cw = cleanWarn(w, max);
    if (cw) warn.push(cw);
  }
  seen.add(name);
  return { name, kind, icon, desc, max, start, value: start, drift, warn };
}

// normalizeStatsSpec(raw, genre) → 合法专属状态数组。
// 逐项消毒，不合法的项丢弃；0 个合法项时用题材兜底；只 1 项时原样返回。
function normalizeStatsSpec(raw, genre) {
  const list = asStats(raw);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (out.length >= STATS_MAX) break;
    const st = cleanStat(item, seen);
    if (st) out.push(st);
  }
  if (out.length === 0) return fallbackStats(genre);
  return out;
}

// 题材兜底模板：已是合法形状（含 desc/max 等全字段）、value=start，每次返回全新对象。
function fallbackStats(genre) {
  const g = (name, icon, start, drift, warn) => ({
    name, kind: 'gauge', icon, desc: '',
    max: 100, start, value: start, drift, warn,
  });
  const r = (name, icon, ranks, start) => ({
    name, kind: 'rank', icon, desc: '',
    ranks, start, value: start,
  });
  switch (genre) {
    case 'xuanhuan':
      return [
        r('境界', '☯', ['凡人', '炼气', '筑基', '金丹', '元婴', '化神'], 1),
        g('灵力', '✦', 60, 0, [
          { below: 15, label: '灵力枯竭', effect: '术法难以施展，强行运功会反噬伤身', drain: '体魄' },
        ]),
      ];
    case 'urban':
      return [
        g('精力', '⚡', 80, -2, [
          { below: 25, label: '疲惫不堪', effect: '反应变慢、容易出错' },
          { below: 8, label: '透支', effect: '随时可能倒下', drain: '体魄' },
        ]),
        g('心情', '☀', 65, 0, [
          { below: 25, label: '心情低落', effect: '不想与人打交道，判断偏消极' },
        ]),
      ];
    case 'game':
      return [
        r('等级', '★', Array.from({ length: 10 }, (_, i) => `Lv.${i + 1}`), 0),
        g('能量', '⚡', 80, -1, [
          { below: 15, label: '能量见底', effect: '技能无法使用', drain: '体魄' },
        ]),
      ];
    case 'horror':
      return [
        g('理智', '👁', 85, 0, [
          { below: 40, label: '心神不宁', effect: '开始出现幻听幻视，难辨真假' },
          { below: 15, label: '濒临崩溃', effect: '言行失控，可能做出伤害自己的事', drain: '心智' },
        ]),
        g('体力', '❤', 80, -2, [
          { below: 20, label: '精疲力竭', effect: '跑不动、躲不开', drain: '体魄' },
        ]),
      ];
    case 'cozy':
      return [
        g('心情', '☀', 75, -1, [
          { below: 25, label: '闷闷不乐', effect: '做什么都提不起劲' },
        ]),
        g('体力', '❤', 80, -2, [
          { below: 20, label: '累坏了', effect: '只想躺着' },
        ]),
      ];
    case 'general':
    default:
      return [
        g('精力', '⚡', 80, -2, [
          { below: 25, label: '疲惫不堪', effect: '反应变慢、容易出错' },
          { below: 8, label: '透支', effect: '随时可能倒下', drain: '体魄' },
        ]),
      ];
  }
}

// 单条警戒是否生效：gauge 且（有 below 时 value<=below；有 above 时 value>=above）。
function warnActive(stat, w) {
  if (!stat || typeof stat !== 'object' || stat.kind !== 'gauge') return false;
  if (!w || typeof w !== 'object') return false;
  const v = Number(stat.value);
  if (!Number.isFinite(v)) return false;
  if (isNum(w.below)) return v <= w.below;
  if (isNum(w.above)) return v >= w.above;
  return false;
}

// 所有 gauge 的所有生效警戒，按 stats 顺序。
function activeWarnings(stats) {
  const out = [];
  for (const st of asStats(stats)) {
    if (!st || typeof st !== 'object' || st.kind !== 'gauge') continue;
    for (const w of (Array.isArray(st.warn) ? st.warn : [])) {
      if (!warnActive(st, w)) continue;
      const item = {
        stat: st.name,
        label: typeof w.label === 'string' ? w.label : '',
        effect: typeof w.effect === 'string' ? w.effect : '',
      };
      if (typeof w.drain === 'string' && w.drain) item.drain = w.drain;
      out.push(item);
    }
  }
  return out;
}

// validateStatsDiff(stats, raw, opts) → { diff, rejected }
// raw 形如 { 专属状态名: 数字 }；opts.timeSkip 为真时放宽单回合上限。
function validateStatsDiff(stats, raw, opts) {
  const byName = new Map();
  for (const st of asStats(stats)) {
    if (st && typeof st === 'object' && typeof st.name === 'string' && !byName.has(st.name)) {
      byName.set(st.name, st);
    }
  }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const timeSkip = !!(opts && opts.timeSkip);
  const diff = {};
  const rejected = [];
  for (const key of Object.keys(src)) {
    const st = byName.get(key);
    if (!st) {
      rejected.push(`忽略未知专属状态「${key}」`);
      continue;
    }
    const v = src[key];
    if (!isNum(v)) {
      rejected.push(`专属状态「${key}」的变化值无效，已忽略`);
      continue;
    }
    let delta = toInt(v);
    if (delta === 0) continue;
    const limit = st.kind === 'rank'
      ? (timeSkip ? STATS_SKIP_RANK_DIFF : STATS_RANK_DIFF)
      : (timeSkip ? STATS_SKIP_GAUGE_DIFF : STATS_GAUGE_DIFF);
    if (delta > limit) {
      rejected.push(`专属状态「${key}」单回合变化超过 +${limit}，已截断`);
      delta = limit;
    } else if (delta < -limit) {
      rejected.push(`专属状态「${key}」单回合变化超过 ${-limit}，已截断`);
      delta = -limit;
    }
    const isRank = st.kind === 'rank';
    const hi = isRank
      ? (Array.isArray(st.ranks) ? Math.max(0, st.ranks.length - 1) : 0)
      : (isNum(st.max) && st.max > 0 ? toInt(st.max) : 100);
    const cur = Number.isFinite(Number(st.value)) ? toInt(st.value) : 0;
    const next = clamp(cur + delta, 0, hi);
    const actual = next - cur;
    if (actual === 0) continue;
    diff[key] = actual;
  }
  return { diff, rejected };
}

// applyStatsTurn(stats, diff, passes) → { stats, drift, drains }
// 1 应用 diff → 2 施加 gauge 自然变化 → 3 按新值算带 drain 的生效警戒（同一 attr 只收一次）。
function applyStatsTurn(stats, diff, passes) {
  const src = asStats(stats);
  const d = diff && typeof diff === 'object' && !Array.isArray(diff) ? diff : {};
  const p = clamp(toInt(passes), TIME_PASSES_MIN, TIME_PASSES_MAX);
  const drift = {};
  const drains = [];
  const seenAttr = new Set();
  const out = [];
  for (const st of src) {
    const n = cloneState(st);
    if (!n || typeof n !== 'object' || typeof n.name !== 'string') {
      out.push(n);
      continue;
    }
    const isRank = n.kind === 'rank';
    const ranksLen = isRank && Array.isArray(n.ranks) ? n.ranks.length : 0;
    const max = !isRank && isNum(n.max) && n.max > 0 ? toInt(n.max) : 100;
    const hi = isRank ? Math.max(0, ranksLen - 1) : max;
    let v = clamp(Number.isFinite(Number(n.value)) ? toInt(n.value) : 0, 0, hi);

    // 1) diff（已消毒的实际变化量）
    const delta = d[n.name];
    if (isNum(delta) && toInt(delta) !== 0) {
      v = clamp(v + toInt(delta), 0, hi);
    }

    // 2) 自然变化：value += drift * passes，夹 [0,max]；记录实际变化量
    if (!isRank) {
      const dr = isNum(n.drift) ? toInt(n.drift) : 0;
      const before = v;
      v = clamp(v + dr * p, 0, max);
      const change = v - before;
      if (change !== 0) drift[n.name] = change;
    }
    n.value = v;

    // 3) 按新值结算带 drain 的生效警戒
    for (const w of (Array.isArray(n.warn) ? n.warn : [])) {
      if (!warnActive(n, w)) continue;
      const attr = w && w.drain;
      if (typeof attr !== 'string' || !ATTRS.includes(attr) || seenAttr.has(attr)) continue;
      seenAttr.add(attr);
      drains.push({
        stat: n.name,
        label: typeof w.label === 'string' ? w.label : '',
        attr,
      });
    }
    out.push(n);
  }
  return { stats: out, drift, drains };
}

// 重生用：每项 value 回到 start 的新数组。
function resetStats(stats) {
  return asStats(stats).map((st) => {
    const n = cloneState(st);
    if (n && typeof n === 'object') {
      const start = Number(n.start);
      if (Number.isFinite(start)) n.value = toInt(start);
    }
    return n;
  });
}

// 给前端的副本：每项带 alerts（当前生效警戒），rank 另带 rankName。不改入参。
function publicStats(stats) {
  return asStats(stats).map((st) => {
    const n = cloneState(st);
    if (!n || typeof n !== 'object') return n;
    const alerts = [];
    if (n.kind === 'gauge' && Array.isArray(n.warn)) {
      for (const w of n.warn) {
        if (!warnActive(n, w)) continue;
        alerts.push({
          label: typeof w.label === 'string' ? w.label : '',
          effect: typeof w.effect === 'string' ? w.effect : '',
          severe: !!(w && w.drain),
        });
      }
    }
    n.alerts = alerts;
    if (n.kind === 'rank') {
      const ranks = Array.isArray(n.ranks) ? n.ranks : [];
      const idx = clamp(toInt(n.value), 0, Math.max(0, ranks.length - 1));
      n.rankName = ranks[idx] !== undefined ? ranks[idx] : '';
    }
    return n;
  });
}

module.exports = {
  normalizeStatsSpec,
  fallbackStats,
  warnActive,
  activeWarnings,
  validateStatsDiff,
  applyStatsTurn,
  resetStats,
  publicStats,
};
