'use strict';

// 第 3 节：文件存储。
// - 原子写：同目录 tmp 文件 + rename（覆盖 state.json）
// - jsonl 追加：单行 appendFileSync，永不删除
// - 每个世界一把基于 Promise 的互斥锁（FIFO 串行，异常不破坏队列）
// - 删除世界 = 移动到 data/_trash/（不真删）
// 只用 node 内置模块；路径一律 path.join，符合 Windows 兼容要求。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORLD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// 防止 URL 里的世界 ID 变成 ../ 之类的路径穿越。
function assertWorldId(worldId) {
  const id = String(worldId == null ? '' : worldId);
  if (!WORLD_ID_PATTERN.test(id)) {
    throw new Error(`非法世界 ID：${id}`);
  }
  return id;
}

function worldsDir(dataDir) {
  return path.join(dataDir, 'worlds');
}

function worldDir(dataDir, worldId) {
  return path.join(worldsDir(dataDir), assertWorldId(worldId));
}

function statePath(dataDir, worldId) {
  return path.join(worldDir(dataDir, worldId), 'state.json');
}

function eventsPath(dataDir, worldId) {
  return path.join(worldDir(dataDir, worldId), 'events.jsonl');
}

function usagePath(dataDir) {
  return path.join(dataDir, 'usage.jsonl');
}

function trashDir(dataDir) {
  return path.join(dataDir, '_trash');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  // tmp 必须与目标同目录，rename 才是原子且跨设备无关的。
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 清理失败时不要把原始错误盖掉 */
    }
    throw err;
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteText(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readJson(filePath, fallback) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback === undefined ? null : fallback;
    throw err;
  }
  return JSON.parse(text);
}

// 追加一行 JSON；单行 write 在 O_APPEND 下是原子的，且不会改动已有行。
function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

function readJsonl(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

// ---- 每个世界一把 Promise 互斥锁 ----
// Map<worldId, Promise>：值代表「队列尾部」，新调用排到尾部之后。
// gate 永远 resolve（不 reject），因此某个任务失败不会卡死后续任务。
const locks = new Map();

function withWorldLock(worldId, fn) {
  const key = assertWorldId(worldId);
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  locks.set(key, tail);
  const run = prev.then(() => Promise.resolve().then(fn));
  return run.finally(() => {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  });
}

function getLockedKeys() {
  return Array.from(locks.keys());
}

// ---- 面向世界的高层操作 ----

function saveWorld(dataDir, state) {
  const id = assertWorldId(state && state.id);
  atomicWriteJson(statePath(dataDir, id), state);
}

function loadWorld(dataDir, worldId) {
  return readJson(statePath(dataDir, worldId), null);
}

function worldExists(dataDir, worldId) {
  return fs.existsSync(statePath(dataDir, worldId));
}

function appendEvent(dataDir, worldId, record) {
  appendJsonl(eventsPath(dataDir, worldId), record);
}

function readEvents(dataDir, worldId) {
  return readJsonl(eventsPath(dataDir, worldId));
}

function appendUsage(dataDir, record) {
  appendJsonl(usagePath(dataDir), record);
}

// ---- 撤回备份 ----
// 每回合会改动的「每世界可变文件」：目前只有 state.json（saveWorld 覆盖写）。
// events.jsonl 与全局 usage.jsonl 都是只追加日志，不属于可变文件，故不纳入备份。
// 用数组描述，将来若新增每回合可变文件，只需在此登记即可一并备份/恢复。
const UNDO_BACKUP_FILES = ['state.json'];

function undoPrevName(name) {
  // state.json -> state.prev.json
  return name.replace(/\.json$/, '.prev.json');
}

function undoPrevPath(dataDir, worldId, name) {
  return path.join(worldDir(dataDir, worldId), undoPrevName(name));
}

// 回合执行前调用：把当前各可变文件复制为 .prev 快照（只追加日志不在此列）。
// 由 game.takeTurn 在该世界互斥锁内调用，流式与普通回合都经由它，故只备份一次。
function backupForUndo(dataDir, worldId) {
  const dir = worldDir(dataDir, worldId);
  ensureDir(dir);
  for (const name of UNDO_BACKUP_FILES) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, undoPrevPath(dataDir, worldId, name));
  }
}

function hasUndoBackup(dataDir, worldId) {
  return UNDO_BACKUP_FILES.every((name) =>
    fs.existsSync(undoPrevPath(dataDir, worldId, name)));
}

// 读取备份快照（完整内部 state），供死亡/重生判定使用；不存在时返回 null。
function readUndoBackup(dataDir, worldId) {
  return readJson(undoPrevPath(dataDir, worldId, 'state.json'), null);
}

// 撤回：把 .prev 快照写回原文件并删除 .prev（删除后只能撤回一步）。
function restoreUndoBackup(dataDir, worldId) {
  for (const name of UNDO_BACKUP_FILES) {
    const prev = undoPrevPath(dataDir, worldId, name);
    if (!fs.existsSync(prev)) continue;
    const text = fs.readFileSync(prev, 'utf8');
    atomicWriteText(path.join(worldDir(dataDir, worldId), name), text);
    fs.unlinkSync(prev);
  }
}

// GET /api/worlds 用的列表；updatedAt 取 state.json 的 mtime。
function listWorlds(dataDir) {
  const dir = worldsDir(dataDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !WORLD_ID_PATTERN.test(entry.name)) continue;
    const state = loadWorld(dataDir, entry.name);
    if (!state) continue;
    let updatedAt = null;
    try {
      updatedAt = fs.statSync(statePath(dataDir, entry.name)).mtimeMs;
    } catch (_) {
      /* 并发删除时忽略 */
    }
    out.push({
      id: state.id,
      title: state.bible ? state.bible.title : '',
      turn: state.turn,
      life: state.life,
      alive: !!(state.character && state.character.alive),
      updatedAt,
    });
  }
  return out;
}

// 删除 = 移动到 data/_trash/。同名已存在时加后缀，绝不覆盖旧回收内容。
function deleteWorld(dataDir, worldId) {
  const id = assertWorldId(worldId);
  const src = worldDir(dataDir, id);
  if (!fs.existsSync(src)) return null;
  const trash = trashDir(dataDir);
  ensureDir(trash);
  let dest = path.join(trash, id);
  if (fs.existsSync(dest)) {
    dest = path.join(trash, `${id}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  }
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // 跨卷（Windows 上盘符不同）时 rename 会 EXDEV，退化为复制 + 删除源。
    if (err && err.code === 'EXDEV') {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
  return dest;
}

module.exports = {
  assertWorldId,
  worldsDir,
  worldDir,
  statePath,
  eventsPath,
  usagePath,
  trashDir,
  atomicWriteText,
  atomicWriteJson,
  readJson,
  appendJsonl,
  readJsonl,
  withWorldLock,
  getLockedKeys,
  saveWorld,
  loadWorld,
  worldExists,
  appendEvent,
  readEvents,
  appendUsage,
  backupForUndo,
  hasUndoBackup,
  readUndoBackup,
  restoreUndoBackup,
  listWorlds,
  deleteWorld,
};
