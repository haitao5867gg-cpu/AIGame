'use strict';

// 配乐统计弹窗：静态检查源文件 + require 顶层纯函数（require 时不能碰 document），
// 验证 formatSeconds / skipRate / sortTracks / rowText 的行为。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const bgmSrc = read('js/bgm-stats.js');
const html = read('index.html');
const css = read('app.css');

// ===== 静态 =====

test('bgm-stats.js 不用 innerHTML', () => {
  assert.ok(!/innerHTML/.test(bgmSrc), 'bgm-stats.js 里不该出现 innerHTML');
});

test('index.html 引入 /js/bgm-stats.js', () => {
  assert.match(html, /\/js\/bgm-stats\.js/);
});

test('app.css 里有 .bgm-stats-row', () => {
  assert.match(css, /\.bgm-stats-row/);
});

// ===== 纯函数：顶层不访问 document，require 不应报错 =====

const BgmStats = require(path.join(__dirname, '..', 'public', 'js', 'bgm-stats.js'));

test('require 成功，返回 open/close 与四个纯函数', () => {
  assert.equal(typeof BgmStats.open, 'function');
  assert.equal(typeof BgmStats.close, 'function');
  assert.equal(typeof BgmStats.formatSeconds, 'function');
  assert.equal(typeof BgmStats.skipRate, 'function');
  assert.equal(typeof BgmStats.sortTracks, 'function');
  assert.equal(typeof BgmStats.rowText, 'function');
});

test('formatSeconds：不足 60 秒显示秒，其余四舍五入到分钟', () => {
  assert.equal(BgmStats.formatSeconds(45), '45 秒');
  assert.equal(BgmStats.formatSeconds(1830), '31 分钟');
});

test('skipRate：没播放过返回 -1', () => {
  assert.equal(BgmStats.skipRate({ plays: 0, skips: 0 }), -1);
});

test('sortTracks 按 plays 从大到小，且返回新数组、不改原数组', () => {
  const tracks = [
    { id: 'a', plays: 3 },
    { id: 'b', plays: 12 },
    { id: 'c', plays: 7 },
  ];
  const snapshot = tracks.map((t) => Object.assign({}, t));
  const sorted = BgmStats.sortTracks(tracks, 'plays');
  assert.deepEqual(sorted.map((t) => t.plays), [12, 7, 3]);
  assert.notEqual(sorted, tracks, '应返回新数组');
  assert.deepEqual(tracks, snapshot, '原数组顺序不变');
});

test('sortTracks 的 skiprate 模式把没播放过的排最后', () => {
  const tracks = [
    { id: 'none', plays: 0, skips: 0 },
    { id: 'high', plays: 10, skips: 8 },
    { id: 'low', plays: 10, skips: 1 },
  ];
  const sorted = BgmStats.sortTracks(tracks, 'skiprate');
  assert.deepEqual(sorted.map((t) => t.id), ['high', 'low', 'none']);
});

test('rowText：hasFile 为 false 只显示「还没有音频文件」', () => {
  const t = { hasFile: false, plays: 12, seconds: 1830, skips: 5, ends: 3, listeners: 2, fails: 0 };
  assert.equal(BgmStats.rowText(t), '还没有音频文件');
});

test('rowText：正常曲目包含「播放 12 次」「切走 5 次（42%）」', () => {
  const t = { hasFile: true, plays: 12, seconds: 1830, skips: 5, ends: 3, listeners: 2, fails: 0 };
  const text = BgmStats.rowText(t);
  assert.ok(text.includes('播放 12 次'), '应含播放 12 次');
  assert.ok(text.includes('切走 5 次（42%）'), '应含切走 5 次（42%）');
});
