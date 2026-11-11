'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../src/images.js');

function tmpData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-cover-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeIndex(dataDir, index) {
  const imgDir = path.join(dataDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify(index));
}

function touchFile(dataDir, file) {
  const imgDir = path.join(dataDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, file), 'x');
}

function entry(kind, file, worldId, extra) {
  return Object.assign({ kind, file, worldId, status: 'ready', ts: 0 }, extra || {});
}

test('coverForWorlds：场景图优先于主角图，场景按 life>turn>ts、主角按 ts 选', () => {
  const dir = tmpData();
  try {
    const idx = {};
    const add = (key, kind, file, worldId, extra) => {
      idx[key] = entry(kind, file, worldId, extra);
      touchFile(dir, file);
    };
    // w1：4 张场景 + 1 张主角（有场景时主角应被忽略）
    add('a', 'scene', 'scene-000000000001.jpg', 'w1', { life: 1, turn: 9, ts: 99 });
    add('b', 'scene', 'scene-000000000002.jpg', 'w1', { life: 5, turn: 1, ts: 1 });
    add('c', 'scene', 'scene-000000000003.jpg', 'w1', { life: 5, turn: 7, ts: 1 });
    add('d', 'scene', 'scene-000000000004.jpg', 'w1', { life: 5, turn: 7, ts: 3 }); // 胜出
    add('e', 'hero', 'hero-000000000001.jpg', 'w1', { ts: 100 }); // 被忽略
    // w2：无场景，3 张主角取 ts 最新
    add('f', 'hero', 'hero-000000000002.jpg', 'w2', { ts: 10 });
    add('g', 'hero', 'hero-000000000003.jpg', 'w2', { ts: 50 }); // 胜出
    add('h', 'hero', 'hero-000000000004.jpg', 'w2', { ts: 30 });
    writeIndex(dir, idx);

    const out = images.coverForWorlds(dir, ['w1', 'w2', 'w3']);
    assert.deepEqual(out, {
      w1: { url: '/api/images/scene-000000000004.jpg', kind: 'scene' },
      w2: { url: '/api/images/hero-000000000003.jpg', kind: 'hero' },
    });
    assert.equal('w3' in out, false, '没有图的世界不出现在结果里');
  } finally {
    cleanup(dir);
  }
});

test('coverForWorlds：忽略 pending/failed/文件缺失/非法文件名/其他世界/非对象/非 scene|hero', () => {
  const dir = tmpData();
  try {
    const idx = {};
    // 唯一有效项
    idx.ok = entry('scene', 'scene-0000000000aa.jpg', 'w1', { life: 1, turn: 1, ts: 1 });
    touchFile(dir, 'scene-0000000000aa.jpg');
    // pending
    idx.pending = entry('scene', 'scene-0000000000ab.jpg', 'w2', { status: 'pending', life: 9, turn: 9, ts: 9 });
    touchFile(dir, 'scene-0000000000ab.jpg');
    // failed
    idx.failed = entry('scene', 'scene-0000000000ac.jpg', 'w3', { status: 'failed', life: 9, turn: 9, ts: 9 });
    touchFile(dir, 'scene-0000000000ac.jpg');
    // ready 但文件不存在（未 touch）
    idx.missing = entry('scene', 'scene-0000000000ad.jpg', 'w4', { life: 9, turn: 9, ts: 9 });
    // 非法文件名（路径穿越 / 非 12 位十六进制）
    idx.badname = entry('scene', '../evil.jpg', 'w5', { life: 9, turn: 9, ts: 9 });
    idx.badname2 = entry('scene', 'scene-ZZZZ.jpg', 'w5', { life: 9, turn: 9, ts: 9 });
    // 其他世界（不在 worldIds 里）
    idx.other = entry('hero', 'hero-0000000000ae.jpg', 'wX', { ts: 9 });
    touchFile(dir, 'hero-0000000000ae.jpg');
    // 非对象项
    idx.nullItem = null;
    idx.strItem = 'oops';
    // 非 scene/hero
    idx.item = entry('item', 'item-0000000000af.jpg', 'w6', { ts: 9 });
    touchFile(dir, 'item-0000000000af.jpg');
    writeIndex(dir, idx);

    const out = images.coverForWorlds(dir, ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
    assert.deepEqual(out, {
      w1: { url: '/api/images/scene-0000000000aa.jpg', kind: 'scene' },
    });
  } finally {
    cleanup(dir);
  }
});

test('coverForWorlds：非数组返回 {}，index 损坏/不存在/非对象时返回 {}，绝不抛错', () => {
  const dir = tmpData();
  try {
    assert.deepEqual(images.coverForWorlds(dir, null), {});
    assert.deepEqual(images.coverForWorlds(dir, 'w1'), {});
    assert.deepEqual(images.coverForWorlds(dir, 123), {});
    // index.json 不存在
    assert.deepEqual(images.coverForWorlds(dir, ['w1']), {});
    const imgDir = path.join(dir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    // index.json 损坏（非法 JSON）
    fs.writeFileSync(path.join(imgDir, 'index.json'), '{ broken json');
    assert.deepEqual(images.coverForWorlds(dir, ['w1']), {});
    // index.json 是数组（非对象）
    fs.writeFileSync(path.join(imgDir, 'index.json'), '[1, 2, 3]');
    assert.deepEqual(images.coverForWorlds(dir, ['w1']), {});
    // life/turn/ts 非数字当 0，不影响选择
    writeIndex(dir, {
      a: entry('scene', 'scene-0000000000ba.jpg', 'w1', { life: 'x', turn: null, ts: 'y' }),
    });
    touchFile(dir, 'scene-0000000000ba.jpg');
    assert.deepEqual(images.coverForWorlds(dir, ['w1']), {
      w1: { url: '/api/images/scene-0000000000ba.jpg', kind: 'scene' },
    });
  } finally {
    cleanup(dir);
  }
});
