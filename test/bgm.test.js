'use strict';

// 配乐曲库与播放统计：src/bgm.js 单测 + /api/bgm/* 接口。
// 音频用临时目录里的假 mp3 字节，不联网、不调任何 AI。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bgmMod = require('../src/bgm.js');
const { withServer, req, asGuest, loginGuest } = require('./helpers/api-helpers.js');

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function put(dir, name, bytes) { fs.writeFileSync(path.join(dir, name), bytes === undefined ? Buffer.from('ID3-fake-audio') : bytes); }

test('候选清单：75 首，编号唯一，题材和档位都合法', () => {
  assert.equal(bgmMod.CANDIDATES.length, 75);
  assert.equal(new Set(bgmMod.CANDIDATES.map((t) => t.id)).size, 75);
  for (const t of bgmMod.CANDIDATES) {
    assert.match(t.id, /^[a-z]{2}\d{2}$/);
    assert.ok(bgmMod.THEMES.includes(t.theme), t.id + ' 题材');
    assert.ok(bgmMod.MOODS.includes(t.mood), t.id + ' 档位');
    assert.ok(t.title && t.artist, t.id + ' 有曲名和作者');
  }
});

test('曲目单：没放文件时只有自带十八首；放进文件几秒内出现，空文件和不认识的名字不算', () => {
  const data = tmpDir('bgm-data-'), dir = tmpDir('bgm-dir-');
  let now = 1000;
  const bgm = bgmMod.createBgm({ BGM_DIR: dir }, data, { now: () => now });
  const first = bgm.catalog().tracks;
  assert.equal(first.length, 18);
  assert.ok(first.every((t) => t.src.startsWith('/assets/atmosphere/')));
  put(dir, 'xx01.mp3'); put(dir, 'UR02.MP3'); put(dir, 'ho01.mp3', Buffer.alloc(0));
  put(dir, 'zz99.mp3'); put(dir, 'manifest.csv'); put(dir, 'calm.mp3');
  assert.equal(bgm.catalog().tracks.length, 18, '缓存期内不重扫');
  now += 6000;
  const ids = bgm.catalog().tracks.map((t) => t.id);
  assert.equal(ids.length, 20);
  assert.ok(ids.includes('xx01') && ids.includes('ur02'));
  const xx01 = bgm.catalog().tracks.find((t) => t.id === 'xx01');
  assert.deepEqual(xx01, { id: 'xx01', title: '琵琶语', artist: '林海', theme: 'lingtian', mood: 'calm', src: '/api/bgm/file/xx01.mp3' });
  assert.ok(bgm.filePath('ur02').endsWith('UR02.MP3'));
  assert.equal(bgm.filePath('calm'), null, '自带曲不走候选目录');
  assert.equal(bgm.filePath('../x'), null);
  assert.equal(bgm.filePath('xx02'), null);
});

test('统计：播放次数只在首条上报时加，秒数累计，切走/播完/出错分开记，落盘可重读', () => {
  const data = tmpDir('bgm-data-'), dir = tmpDir('bgm-dir-');
  const bgm = bgmMod.createBgm({ BGM_DIR: dir }, data);
  const n = bgm.record('p1', [
    { id: 'xx01', seconds: 30.4, reason: 'stop', first: true },
    { id: 'xx01', seconds: 12, reason: 'skip', first: false },
    { id: 'xx01', seconds: 200, reason: 'end', first: true },
    { id: 'xx01', seconds: 0, reason: 'fail', first: false },
    { id: 'nope', seconds: 5, reason: 'skip', first: true },
    { id: 'xx01', seconds: 5, reason: 'weird', first: true },
    { id: 'xx02', seconds: 1e9, reason: 'switch', first: true },
    null, 'x',
  ]);
  assert.equal(n, 5);
  bgm.record('p2', [{ id: 'xx01', seconds: 3, reason: 'skip', first: true }]);
  assert.equal(bgm.record('p2', 'bad'), 0);
  const again = bgmMod.createBgm({ BGM_DIR: dir }, data);
  const rep = again.report();
  assert.equal(rep.total, 93);
  assert.equal(rep.ready, 18);
  assert.equal(rep.missing.length, 75);
  const row = rep.tracks.find((t) => t.id === 'xx01');
  assert.equal(row.plays, 3);
  assert.equal(row.seconds, 245);
  assert.equal(row.skips, 2);
  assert.equal(row.ends, 1);
  assert.equal(row.fails, 1);
  assert.equal(row.listeners, 2);
  assert.equal(row.hasFile, false);
  assert.equal(row.themeName, '修仙武侠');
  assert.equal(rep.tracks.find((t) => t.id === 'xx02').seconds, 3600, '单条秒数有上限');
  assert.equal(rep.tracks.find((t) => t.id === 'calm').hasFile, true);
});

test('接口：曲目单、音频分段、上报、统计只给主人', async () => {
  const dir = tmpDir('bgm-dir-');
  put(dir, 'xx01.mp3', Buffer.from('0123456789'));
  await withServer(async ({ base, dataDir }) => {
    const cat = await req(base, 'GET', '/api/bgm/catalog');
    assert.equal(cat.status, 200);
    assert.equal(cat.json.tracks.length, 19);

    const full = await fetch(base + '/api/bgm/file/xx01.mp3');
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'audio/mpeg');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(await full.text(), '0123456789');
    const part = await fetch(base + '/api/bgm/file/xx01.mp3', { headers: { Range: 'bytes=2-4' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '234');
    assert.equal((await fetch(base + '/api/bgm/file/xx02.mp3')).status, 404);
    assert.equal((await fetch(base + '/api/bgm/file/..%2Fx.mp3')).status, 404);

    const ev = await req(base, 'POST', '/api/bgm/events', { events: [{ id: 'xx01', seconds: 42, reason: 'skip', first: true }] });
    assert.equal(ev.status, 200);
    assert.equal(ev.json.accepted, 1);

    const stats = await req(base, 'GET', '/api/bgm/stats');
    assert.equal(stats.status, 200);
    const row = stats.json.tracks.find((t) => t.id === 'xx01');
    assert.deepEqual([row.plays, row.seconds, row.skips, row.hasFile], [1, 42, 1, true]);
    assert.equal(stats.json.ready, 19);

    // 来客：能听、能上报，看不了统计；没登录什么都拿不到。
    assert.equal((await req(base, 'GET', '/api/bgm/catalog', undefined, asGuest())).status, 401);
    assert.equal((await fetch(base + '/api/bgm/file/xx01.mp3', { headers: asGuest() })).status, 401);
    const cookie = await loginGuest(base, dataDir, '阿青');
    assert.equal((await req(base, 'GET', '/api/bgm/catalog', undefined, asGuest(cookie))).status, 200);
    assert.equal((await req(base, 'POST', '/api/bgm/events', { events: [{ id: 'xx01', seconds: 9, reason: 'end', first: true }] }, asGuest(cookie))).json.accepted, 1);
    assert.equal((await req(base, 'GET', '/api/bgm/stats', undefined, asGuest(cookie))).status, 403);
    const after = (await req(base, 'GET', '/api/bgm/stats')).json.tracks.find((t) => t.id === 'xx01');
    assert.deepEqual([after.plays, after.listeners, after.ends], [2, 2, 1]);
  }, { BGM_DIR: dir });
});
