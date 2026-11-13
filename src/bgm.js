'use strict';

// 配乐曲库与播放统计。
//   曲库 = 仓库自带的十八首（catalog.json 每题材每档一首）+ 候选曲（src/bgm-tracks.json，共 75 首）。
//   候选曲的音频不进仓库：放在 BGM_DIR（默认项目目录旁的 AIGameMedia/bgm，即线上 D:\AIGameMedia\bgm），
//   文件名 = 曲目编号.mp3（如 xx01.mp3）。文件存在才出现在玩家的曲目单里，可以分批放入，不用重启。
//   统计按曲目累计：播放次数、收听秒数、被切走次数、完整播完次数、出错次数、听过的人数，
//   存 DATA_DIR/bgm-stats.json；只增不减，不碰世界存档。

const fs = require('fs');
const path = require('path');
const store = require('./store.js');

const CANDIDATES = require('./bgm-tracks.json');
const MOODS = ['calm', 'explore', 'tense'];
const THEMES = ['lingtian', 'urban', 'game', 'horror', 'cozy', 'general', 'apocalypse', 'fantasy', 'romance'];
const THEME_NAMES = Object.freeze({
  lingtian: '修仙武侠', urban: '都市', game: '科幻·游戏系统', horror: '悬疑恐怖', cozy: '休闲日常',
  general: '通用·史诗', apocalypse: '末日废土', fantasy: '西幻', romance: '言情',
});
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REASONS = new Set(['skip', 'end', 'switch', 'stop', 'fail']);
const SCAN_TTL_MS = 5000;
const MAX_EVENTS = 50;
const MAX_SECONDS = 3600; // 单次上报的收听秒数上限，防止坏客户端灌数

function defaultDir() {
  return path.resolve(__dirname, '..', '..', 'AIGameMedia', 'bgm');
}

function builtinTracks(publicDir) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(path.join(publicDir, 'assets', 'atmosphere', 'catalog.json'), 'utf8'));
  } catch (_) {
    return [];
  }
  const credits = new Map((catalog.credits || []).map((c) => [c.id, c]));
  const out = [];
  for (const theme of Object.keys(catalog.themes || {})) {
    const music = (catalog.themes[theme] && catalog.themes[theme].music) || {};
    for (const mood of MOODS) {
      const e = music[mood];
      if (!e || !ID_RE.test(String(e.creditId || ''))) continue;
      const c = credits.get(e.creditId) || {};
      out.push({
        id: e.creditId, title: String(c.title || e.creditId),
        artist: String(c.author || '').replace(/\s*\(incompetech\.com\)\s*$/, ''),
        theme, mood, src: e.src, builtin: true,
      });
    }
  }
  return out;
}

function createBgm(cfg, dataDir, opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const publicDir = o.publicDir || path.join(__dirname, '..', 'public');
  const dir = cfg && cfg.BGM_DIR ? path.resolve(String(cfg.BGM_DIR)) : defaultDir();
  const statsPath = path.join(dataDir, 'bgm-stats.json');
  const builtin = builtinTracks(publicDir);
  const candidates = CANDIDATES.filter((t) => ID_RE.test(t.id) && THEMES.includes(t.theme) && MOODS.includes(t.mood));
  const known = new Map();
  for (const t of builtin) known.set(t.id, t);
  for (const t of candidates) if (!known.has(t.id)) known.set(t.id, t);

  let scan = { at: -Infinity, ids: new Set() };
  // 哪些候选曲的文件已经放进来了（非空的 <编号>.mp3）。短缓存，放入新文件几秒后生效。
  function available() {
    const t = now();
    if (t - scan.at < SCAN_TTL_MS) return scan.ids;
    const ids = new Set();
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { names = []; }
    for (const name of names) {
      const m = /^([a-z0-9][a-z0-9-]{0,39})\.mp3$/i.exec(name);
      if (!m) continue;
      const id = m[1].toLowerCase();
      const track = known.get(id);
      if (!track || track.builtin) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile() && st.size > 0) ids.add(id);
      } catch (_) { /* 刚被移走：当作没有 */ }
    }
    scan = { at: t, ids };
    return ids;
  }

  function publicTrack(t) {
    return {
      id: t.id, title: t.title, artist: t.artist, theme: t.theme, mood: t.mood,
      src: t.builtin ? t.src : '/api/bgm/file/' + t.id + '.mp3',
    };
  }

  // 玩家能播的曲目单：自带曲 + 文件已到位的候选曲。
  function catalog() {
    const have = available();
    return { tracks: builtin.concat(candidates.filter((t) => have.has(t.id))).map(publicTrack) };
  }

  // 候选曲文件的真实路径；编号不认识或文件不在返回 null。按目录里的真实文件名匹配（大小写不敏感）。
  function filePath(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const track = known.get(id);
    if (!track || track.builtin) return null;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return null; }
    const want = id + '.mp3';
    const name = names.find((n) => n.toLowerCase() === want);
    return name ? path.join(dir, name) : null;
  }

  let stats = null;
  function loadStats() {
    if (stats) return stats;
    let raw = null;
    try { raw = store.readJson(statsPath, null); } catch (_) { raw = null; }
    stats = { version: 1, tracks: {} };
    const src = raw && raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : {};
    for (const id of Object.keys(src)) {
      if (ID_RE.test(id) && src[id] && typeof src[id] === 'object') stats.tracks[id] = normalizeRow(src[id]);
    }
    return stats;
  }
  function count(v) { return Number.isFinite(v) && v > 0 ? v : 0; }
  function normalizeRow(r) {
    const listeners = {};
    if (r.listeners && typeof r.listeners === 'object') {
      for (const k of Object.keys(r.listeners)) listeners[k] = 1;
    }
    return {
      plays: count(r.plays), seconds: count(r.seconds), skips: count(r.skips),
      ends: count(r.ends), fails: count(r.fails), listeners,
      lastAt: typeof r.lastAt === 'string' ? r.lastAt : null,
    };
  }

  // 记一批播放事件：[{id, seconds, reason, first}]。
  //   first=true 表示这是这次播放的第一条上报（播放次数 +1）；同一次播放后续的补报只加秒数。
  //   reason: skip=玩家手动切走  end=自然播完  switch=场景换了档位  stop=关声音/离开  fail=音源出错
  // 不认识的编号、非法字段一律丢弃；返回实际记下的条数。
  function record(playerId, events) {
    if (!Array.isArray(events)) return 0;
    const s = loadStats();
    const pid = typeof playerId === 'string' && playerId ? playerId : 'unknown';
    let accepted = 0;
    for (const e of events.slice(0, MAX_EVENTS)) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !known.has(e.id)) continue;
      if (!REASONS.has(e.reason)) continue;
      const seconds = Number.isFinite(e.seconds) ? Math.max(0, Math.min(MAX_SECONDS, e.seconds)) : 0;
      const row = s.tracks[e.id] || (s.tracks[e.id] = normalizeRow({}));
      if (e.reason === 'fail') {
        row.fails += 1;
      } else {
        if (e.first === true) { row.plays += 1; row.listeners[pid] = 1; }
        row.seconds = Math.round((row.seconds + seconds) * 10) / 10;
        if (e.reason === 'skip') row.skips += 1;
        if (e.reason === 'end') row.ends += 1;
      }
      row.lastAt = new Date(now()).toISOString();
      accepted += 1;
    }
    if (accepted) store.atomicWriteJson(statsPath, s);
    return accepted;
  }

  // 主人看的统计：全部曲目（含还没放文件的），带文件是否到位。
  function report() {
    const s = loadStats();
    const have = available();
    const rows = builtin.concat(candidates).map((t) => {
      const r = s.tracks[t.id] || normalizeRow({});
      return {
        id: t.id, title: t.title, artist: t.artist, theme: t.theme, themeName: THEME_NAMES[t.theme] || t.theme,
        mood: t.mood, builtin: !!t.builtin, hasFile: !!t.builtin || have.has(t.id),
        plays: r.plays, seconds: Math.round(r.seconds), skips: r.skips, ends: r.ends, fails: r.fails,
        listeners: Object.keys(r.listeners).length, lastAt: r.lastAt,
      };
    });
    return {
      tracks: rows,
      total: rows.length,
      ready: rows.filter((r) => r.hasFile).length,
      missing: rows.filter((r) => !r.hasFile).map((r) => r.id),
    };
  }

  return { catalog, filePath, record, report, available, dir };
}

module.exports = { createBgm, THEMES, THEME_NAMES, MOODS, CANDIDATES };
