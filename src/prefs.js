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
});

function prefsPath(dataDir) {
  return path.join(dataDir, 'prefs.json');
}

function readAll(dataDir) {
  const v = store.readJson(prefsPath(dataDir), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
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
  });
}

function getPrefs(dataDir, playerId) {
  const id = typeof playerId === 'string' && playerId ? playerId : 'host';
  const p = readAll(dataDir)[id];
  return { scenes: !(p && p.scenes === false), tts: normalizeTts(p && p.tts) };
}

// 只改当前玩家自己的偏好。非法 scenes 值忽略；tts 校验后再保存。
// 返回值沿用 { scenes } 形状（仅当本次提交了 tts 才附上 tts），避免影响既有接口断言。
function setPrefs(dataDir, playerId, patch) {
  const id = typeof playerId === 'string' && playerId ? playerId : 'host';
  const all = readAll(dataDir);
  const cur = all[id] && typeof all[id] === 'object' ? all[id] : {};
  const next = Object.assign({}, cur);
  const hasTts = !!(patch && patch.tts && typeof patch.tts === 'object');
  if (patch && typeof patch.scenes === 'boolean') next.scenes = patch.scenes;
  if (hasTts) next.tts = mergeTts(cur.tts, patch.tts);
  else if (next.tts === undefined) next.tts = normalizeTts(null);
  all[id] = next;
  store.atomicWriteJson(prefsPath(dataDir), all);
  const out = { scenes: !(next.scenes === false) };
  if (hasTts) out.tts = normalizeTts(next.tts);
  return out;
}

module.exports = { getPrefs, setPrefs, prefsPath, normalizeTts, DEFAULT_TTS };
