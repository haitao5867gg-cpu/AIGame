'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/images.js'), 'utf8');

// 在 vm 里加载 images.js（全是函数声明，加载期不碰 DOM）。按需覆盖会被 fetchImages 调用的
// 渲染/轮询函数，并注入共享全局（imageState / currentState / currentWorldId / api / Atmosphere）。
function load(extra) {
  const ctx = Object.assign({
    api: () => Promise.resolve({ items: {}, npcs: {}, scenes: {}, hero: {} }),
    currentWorldId: 'w1',
    currentState: { life: 1 },
    imageState: { items: {}, npcs: {}, scenes: {}, hero: {} },
    Atmosphere: { setSceneArt() {} },
  }, extra || {});
  vm.runInNewContext(source, ctx);
  ctx.renderImages = () => {};
  ctx.hasPendingImage = () => false;
  ctx.stopImagePoll = () => {};
  return ctx;
}

test('latestSceneArt：按 life 过滤，其余按 (life 大、turn 大) 取一项', () => {
  const ctx = load();
  const scenes = {
    '1-1': { status: 'ready', url: 'A', life: 1, turn: 1 },
    '1-3': { status: 'ready', url: 'B', life: 1, turn: 3 },
    '1-4': { status: 'pending', url: 'P', life: 1, turn: 4 },
    '2-1': { status: 'ready', url: 'C', life: 2, turn: 1 },
  };
  assert.equal(ctx.latestSceneArt(scenes, 1), 'B');
  assert.equal(ctx.latestSceneArt(scenes, 2), 'C');
  assert.equal(ctx.latestSceneArt(scenes, undefined), 'C');
});

test('latestSceneArt：全不 ready 返回 null，url 非字符串的项跳过', () => {
  const ctx = load();
  assert.equal(ctx.latestSceneArt({
    '1-1': { status: 'pending', url: 'A' },
    '1-2': { status: 'failed', url: 'B' },
  }, 1), null, 'pending/failed 不计入');
  assert.equal(ctx.latestSceneArt({
    '1-1': { status: 'ready', url: 123 },
    '1-2': { status: 'ready', url: 'ok', life: 1, turn: 2 },
  }, 1), 'ok', 'url 非字符串跳过');
  assert.equal(ctx.latestSceneArt({}, 1), null, '空表返回 null');
});

test('images.js 静态：含 Atmosphere.setSceneArt( 与 latestSceneArt( 两处调用', () => {
  assert.ok(source.includes('Atmosphere.setSceneArt('), '应调用 Atmosphere.setSceneArt');
  assert.ok(source.includes('Atmosphere.setSceneArt(null)'), '换世界清空时应传 null');
  assert.ok(source.includes('latestSceneArt('), '应定义/调用 latestSceneArt');
});

test('fetchImages 拿到结果后会调 Atmosphere.setSceneArt', async () => {
  const calls = [];
  const ctx = load({
    Atmosphere: { setSceneArt: (url) => calls.push(url) },
    currentState: { life: 1 },
    api: () => Promise.resolve({
      items: {}, npcs: {},
      scenes: {
        '1-1': { status: 'ready', url: '/api/images/scene-000000000001.jpg', life: 1, turn: 1 },
        '1-2': { status: 'ready', url: '/api/images/scene-000000000012.jpg', life: 1, turn: 2 },
      },
      hero: {},
    }),
  });
  await ctx.fetchImages('w1');
  assert.deepEqual(calls, ['/api/images/scene-000000000012.jpg']);
});
