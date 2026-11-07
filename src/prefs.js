'use strict';

// 每玩家偏好（零第三方依赖）：DATA_DIR/prefs.json，形状
//   { "<playerId>": { "scenes": true|false, "tts": {...} } }
// 缺省视为开启 / 默认朗读设置。写入用 store.atomicWriteJson（同目录 tmp + rename，原子覆盖）。

const path = require('node:path');
const store = require('./store.js');
const ttsMod = require('./tts.js');

const VOICE_IDS = Object.freeze(Object.fromEntries(ttsMod.VOICES.map((v) => [v.id, true])));

const DEFAULT_TTS = Object.freeze({
  narrator: 'zh-CN-YunxiNeural',
  npcDefault: Object.freeze({
    m: 'zh-CN-YunjianNeural', f: 'zh-CN-XiaoxiaoNeural',
    old: 'zh-CN-YunyeNeural', young: 'zh-CN-YunxiNeural',
  }),
  npcVoices: Object.freeze({}),
  speed: 1,
  auto: false,
  enabled: true,
});

function prefsPath(dataDir) {
  return path.join(dataDir, 'prefs.json');
}

function readAll(dataDir) {
  const v = store.readJson(prefsPath(dataDir), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// 主人总开关放在 prefs.json 的 "_global" 下（与各玩家 id 平级但独立）。
const GLOBAL_KEY = '_global';
function getGlobal(dataDir) {
  const g = readAll(dataDir)[GLOBAL_KEY];
  return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
}
function getAdultAllowed(dataDir) {
  return getGlobal(dataDir).adultAllowed === true;
}
function setGlobalAdultAllowed(dataDir, on) {
  const all = readAll(dataDir);
  const g = getGlobal(dataDir);
  all[GLOBAL_KEY] = Object.assign({}, g, { adultAllowed: on === true });
  store.atomicWriteJson(prefsPath(dataDir), all);
}
// 生效条件：主人总开关开 且 该玩家自己开启 adult，才对该玩家回合用「成人模式开」档。
function adultModeOn(dataDir, playerId) {
  return getAdultAllowed(dataDir) && getPrefs(dataDir, playerId).adult === true;
}

function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_TTS.speed;
  return n < 0.5 ? 0.5 : n > 2 ? 2 : n;
}

// 归一化 tts：音色必须落在 VOICES 里，speed 夹 0.5~2，其余字段取默认。
function normalizeTts(raw) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const npcDefault = Object.assign({}, DEFAULT_TTS.npcDefault);
  if (t.npcDefault && typeof t.npcDefault === 'object') {
    for (const k of ['m', 'f', 'old', 'young']) {
      if (VOICE_IDS[t.npcDefault[k]]) npcDefault[k] = t.npcDefault[k];
    }
  }
  const npcVoices = {};
  if (t.npcVoices && typeof t.npcVoices === 'object') {
    for (const [name, v] of Object.entries(t.npcVoices)) {
      if (typeof name === 'string' && name && VOICE_IDS[v]) npcVoices[name] = v;
    }
  }
  return {
    narrator: VOICE_IDS[t.narrator] ? t.narrator : DEFAULT_TTS.narrator,
    npcDefault,
    npcVoices,
    speed: clampSpeed(t.speed),
    auto: t.auto === true,
    enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
  };
}

// 部分更新：把 patch 合进当前 tts 再归一化（npcDefault / npcVoices 按键合并）。
function mergeTts(cur, patch) {
  const base = normalizeTts(cur);
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  return normalizeTts({
    narrator: p.narrator !== undefined ? p.narrator : base.narrator,
    npcDefault: Object.assign({}, base.npcDefault, p.npcDefault && typeof p.npcDefault === 'object' ? p.npcDefault : {}),
    npcVoices: Object.assign({}, base.npcVoices, p.npcVoices && typeof p.npcVoices === 'object' ? p.npcVoices : {}),
    speed: p.speed !== undefined ? p.speed : base.speed,
    auto: p.auto !== undefined ? p.auto : base.auto,
    enabled: p.enabled !== undefined ? p.enabled : base.enabled,
  });
}

function getPrefs(dataDir, playerId) {
  const id = typeof playerId === 'string' && playerId ? playerId : 'host';
  const p = readAll(dataDir)[id];
  return {
    scenes: !(p && p.scenes === false),
    tts: normalizeTts(p && p.tts),
    adult: !!(p && p.adult === true),            // 该玩家是否自己开启了成人内容
    adultAllowed: getAdultAllowed(dataDir),      // 主人总开关是否开放
  };
}

// 只改当前玩家自己的偏好。非法 scenes 值忽略；tts 校验后再保存。
// 返回值沿用 { scenes } 形状（仅当本次提交了 tts 才附上 tts），避免影响既有接口断言。
function setPrefs(dataDir, playerId, patch) {
  const id = typeof playerId === 'string' && playerId ? playerId : 'host';
  const all = readAll(dataDir);
  const cur = all[id] && typeof all[id] === 'object' ? all[id] : {};
  const next = Object.assign({}, cur);
  const hasTts = !!(patch && patch.tts && typeof patch.tts === 'object');
  // 开启个人开关必须带 confirm18:true（HTTP 层据此返回 400，这里兜底忽略非法开启）。
  const hasAdult = !!(patch && typeof patch.adult === 'boolean'
    && (patch.adult === false || patch.confirm18 === true));
  if (patch && typeof patch.scenes === 'boolean') next.scenes = patch.scenes;
  if (hasTts) next.tts = mergeTts(cur.tts, patch.tts);
  else if (next.tts === undefined) next.tts = normalizeTts(null);
  if (hasAdult) next.adult = patch.adult;
  all[id] = next;
  store.atomicWriteJson(prefsPath(dataDir), all);
  const out = { scenes: !(next.scenes === false) };
  if (hasTts) out.tts = normalizeTts(next.tts);
  if (hasAdult) out.adult = next.adult === true;
  return out;
}

module.exports = {
  getPrefs, setPrefs, prefsPath, normalizeTts, DEFAULT_TTS,
  getAdultAllowed, setGlobalAdultAllowed, adultModeOn,
};
