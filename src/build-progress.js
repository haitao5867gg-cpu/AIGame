'use strict';

// 建世界进度：服务器记下每个建世界请求走到哪一步、模型已经写了多少字，前端轮询画进度条。
//
// 步骤固定：读懂设定 → 构思世界（一次模型调用）→ 规划大纲（叙事 v3 才有）→ 落笔保存。
// 每步的「通常要多久 / 通常写多少字」用最近几次建世界的实际耗时（data/build-stats.json）估算，
// 没有记录时用线上统计的默认值（2026-11-12：构思世界中位约 12 秒，大纲约 26 秒）。
// 进度只放内存，30 分钟后忘掉；服务重启后前端查不到，会按「连接断了」处理。

const fs = require('node:fs');
const path = require('node:path');

const STAGE_LABELS = {
  prepare: '读懂你的设定',
  world: '构思世界、人物和出身',
  outline: '规划故事大纲',
  save: '落笔，整理成书',
};
const DEFAULT_EXPECT = {
  prepare: { ms: 600, chars: 0 },
  world: { ms: 14000, chars: 2200 },
  outline: { ms: 27000, chars: 3800 },
  save: { ms: 600, chars: 0 },
};
const STATS_FILE = 'build-stats.json';
const STATS_KEEP = 20;
const TTL_MS = 30 * 60 * 1000;

function stageKeys(withOutline) {
  return withOutline ? ['prepare', 'world', 'outline', 'save'] : ['prepare', 'world', 'save'];
}

function median(list) {
  const a = list.filter((n) => Number.isFinite(n) && n > 0).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}

function readStats(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, STATS_FILE), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

// 一次成功建世界的各步耗时 / 字数，追加进 build-stats.json（只留最近 20 次）。
function recordStats(dataDir, timings) {
  try {
    const list = readStats(dataDir);
    list.push(Object.assign({ at: Date.now() }, timings));
    const file = path.join(dataDir, STATS_FILE);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-STATS_KEEP)));
    fs.renameSync(tmp, file);
  } catch (_) { /* 统计写不进去不影响建世界 */ }
}

// 每一步的预计耗时和字数：最近记录的中位数，至少 3 条才用，否则用默认值。
function expectFor(dataDir, keys) {
  const list = readStats(dataDir).slice(-10);
  const out = {};
  for (const k of keys) {
    const def = DEFAULT_EXPECT[k] || { ms: 1000, chars: 0 };
    const rows = list.map((r) => r && r[k]).filter((x) => x && typeof x === 'object');
    const ms = rows.length >= 3 ? median(rows.map((x) => Number(x.ms))) : null;
    const chars = rows.length >= 3 ? median(rows.map((x) => Number(x.chars))) : null;
    out[k] = { ms: ms || def.ms, chars: chars || def.chars };
  }
  return out;
}

function createBuildProgress(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const entries = new Map();

  function prune() {
    const t = now();
    for (const [k, e] of entries) {
      if (t - e.updatedAt > TTL_MS) entries.delete(k);
    }
  }

  function start(key, dataDir, withOutline) {
    prune();
    const keys = stageKeys(withOutline);
    const t = now();
    const e = {
      keys,
      expect: expectFor(dataDir, keys),
      stage: keys[0],
      startedAt: t,
      stageStartedAt: t,
      activityAt: t,
      updatedAt: t,
      chars: 0,
      think: 0,
      timings: {},
      done: false,
      worldId: null,
      error: null,
    };
    entries.set(key, e);
    return e;
  }

  function closeStage(e, t) {
    e.timings[e.stage] = { ms: t - e.stageStartedAt, chars: e.chars };
  }

  function stage(key, stageKey) {
    const e = entries.get(key);
    if (!e || e.done || e.error || !e.keys.includes(stageKey) || e.stage === stageKey) return;
    const t = now();
    closeStage(e, t);
    e.stage = stageKey;
    e.stageStartedAt = t;
    e.activityAt = t;
    e.updatedAt = t;
    e.chars = 0;
    e.think = 0;
  }

  function progress(key, p) {
    const e = entries.get(key);
    if (!e || e.done || e.error || !p) return;
    const chars = Number(p.chars) || 0;
    const think = Number(p.think) || 0;
    const t = now();
    if (chars > e.chars || think > e.think) e.activityAt = t;
    e.chars = Math.max(e.chars, chars);
    e.think = Math.max(e.think, think);
    e.updatedAt = t;
  }

  // 成功：返回各步耗时（调用方写进 build-stats.json）。
  function finish(key, worldId) {
    const e = entries.get(key);
    if (!e) return null;
    const t = now();
    closeStage(e, t);
    e.done = true;
    e.worldId = worldId || null;
    e.updatedAt = t;
    return e.timings;
  }

  function fail(key, message) {
    const e = entries.get(key);
    if (!e) return;
    e.error = String(message || '建世界失败');
    e.updatedAt = now();
  }

  // 给前端的快照：服务器自己的 now，前端用它算已过时间（不受手机时钟偏差影响）。
  function snapshot(key) {
    prune();
    const e = entries.get(key);
    if (!e) return null;
    return {
      stages: e.keys.map((k) => ({ key: k, label: STAGE_LABELS[k] || k, expectMs: e.expect[k].ms, expectChars: e.expect[k].chars })),
      stage: e.stage,
      stageIndex: e.keys.indexOf(e.stage),
      now: now(),
      startedAt: e.startedAt,
      stageStartedAt: e.stageStartedAt,
      activityAt: e.activityAt,
      chars: e.chars,
      think: e.think,
      done: e.done,
      worldId: e.worldId,
      error: e.error,
    };
  }

  return { start, stage, progress, finish, fail, snapshot };
}

module.exports = { createBuildProgress, recordStats, expectFor, stageKeys, STAGE_LABELS, DEFAULT_EXPECT };
