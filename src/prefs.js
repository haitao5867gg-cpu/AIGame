'use strict';

// 每玩家偏好开关（零第三方依赖）：DATA_DIR/prefs.json，形状
//   { "<playerId>": { "scenes": true|false } }
// 缺省视为开启。写入用 store.atomicWriteJson（同目录 tmp + rename，原子覆盖）。

const path = require('node:path');
const store = require('./store.js');

function prefsPath(dataDir) {
  return path.join(dataDir, 'prefs.json');
}

function readAll(dataDir) {
  const v = store.readJson(prefsPath(dataDir), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// 只返回当前玩家自己的偏好；缺字段一律默认开（scenes:true）。
function getPrefs(dataDir, playerId) {
  const id = typeof playerId === 'string' && playerId ? playerId : 'host';
  const p = readAll(dataDir)[id];
  return { scenes: !(p && p.scenes === false) };
}

// 只改当前玩家自己的偏好，返回新的偏好对象。非法 scenes 值忽略该字段。
function setPrefs(dataDir, playerId, patch) {
  const id = typeof playerId === 'string' && playerId ? playerId : 'host';
  const all = readAll(dataDir);
  const cur = all[id] && typeof all[id] === 'object' ? all[id] : {};
  const next = Object.assign({}, cur);
  if (patch && typeof patch.scenes === 'boolean') next.scenes = patch.scenes;
  all[id] = next;
  store.atomicWriteJson(prefsPath(dataDir), all);
  return { scenes: !(next.scenes === false) };
}

module.exports = { getPrefs, setPrefs, prefsPath };
