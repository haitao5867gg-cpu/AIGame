'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../src/images.js');
const store = require('../src/store.js');
const llm = require('../src/llm.js');
const prefs = require('../src/prefs.js');
const context = require('../src/context.js');

const JPEG = Buffer.from('FAKE-JPEG-BYTES');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-scene-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 默认不让画风设定走真实对话模型：artDirector 返回 null → 关键词规则兜底。
function withArt(opts) { return Object.assign({ artDirector: async () => null }, opts || {}); }
function configureT(cfg, opts) { return images.configure(cfg, withArt(opts)); }

function baseCfg(overrides) {
  return Object.assign({
    IMAGE_PROVIDER: 'gateway',
    IMAGE_BASE_URL: 'https://img.test/v1',
    IMAGE_MODEL: 'Doubao-seedream-4.0',
    IMAGE_SIZE: '1024x1024',
    IMAGE_MAX_PER_WORLD: 40,
    IMAGE_CONCURRENCY: 1,
    IMAGE_SCENE_DAILY_PER_PLAYER: 60,
    LLM_MOCK: false,
    LLM_API_KEY: 'sk-test',
    LLM_BASE: 'https://chat.test/v1',
    LLM_MODEL: 'test-model',
    LLM_TIMEOUT_MS: 5000,
    LLM_DAILY_TOKEN_LIMIT: 0,
    LLM_EXTRA_BODY: '',
  }, overrides || {});
}

// 蒸汽朋克世界 → 规则画风「复古铜版线描淡彩」；守夜人在 desc 里出现，进 cast。
function sceneState(overrides) {
  return Object.assign({
    id: 'wscene',
    life: 2,
    bible: {
      title: '蒸汽朋克长安', tone: '',
      npcs: [{ name: '守夜人', role: '引路者', desc: '总在雾里提一盏不灭的灯' }],
    },
    character: { items: [] },
    npcAttitude: {},
  }, overrides || {});
}

const SCENE_DESC = '守夜人提灯走过雾中的长街';

// 记录请求；智谱 / 硅基流动返回下载 URL，下载返回 JPEG 字节。
function freeFetch(calls) {
  return async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    if (calls) calls.push({ url, headers: opts && opts.headers, body });
    if (url === images.SILICONFLOW_URL) {
      return { ok: true, status: 200, json: async () => ({ images: [{ url: 'https://dl.test/sf.png' }] }) };
    }
    if (url === images.ZHIPU_URL) {
      return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://dl.test/zp.png' }] }) };
    }
    if (url.startsWith('https://dl.test/')) {
      return { ok: true, status: 200, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) };
    }
    throw new Error('意外的 URL ' + url);
  };
}

// Cloudflare Workers AI：同步返回 base64 JPEG。
function cfFetch(calls) {
  return async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    if (calls) calls.push({ url, headers: opts && opts.headers, body });
    if (url.startsWith(images.CLOUDFLARE_API_BASE)) {
      return { ok: true, status: 200, json: async () => ({ success: true, errors: [], result: { image: JPEG.toString('base64') } }) };
    }
    throw new Error('意外的 URL ' + url);
  };
}

// gateway / local 用的 OpenAI 格式出图响应。
function okFetch(calls) {
  return async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    if (calls) calls.push({ url, headers: opts && opts.headers, body });
    return { ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }) };
  };
}

test('sceneKey：同参数同 key，世界/生命/回合/描述任一不同即不同；FILE_NAME_RE 接受 scene-*.png', () => {
  const k = images.sceneKey('w1', 2, 7, SCENE_DESC);
  assert.match(k, /^[0-9a-f]{12}$/);
  assert.equal(images.sceneKey('w1', 2, 7, SCENE_DESC), k);
  assert.notEqual(images.sceneKey('w2', 2, 7, SCENE_DESC), k);
  assert.notEqual(images.sceneKey('w1', 3, 7, SCENE_DESC), k);
  assert.notEqual(images.sceneKey('w1', 2, 8, SCENE_DESC), k);
  assert.notEqual(images.sceneKey('w1', 2, 7, '另一幅画面'), k);
  assert.ok(images.FILE_NAME_RE.test('scene-0123456789ab.png'));
  assert.ok(images.FILE_NAME_RE.test('scene-0123456789ab.jpg'));
});

test('ensureScene：off 或（非 mock）desc 为空返回 null', (t) => {
  const dataDir = tmpDir(t);
  const st = sceneState();
  configureT(baseCfg({ IMAGE_PROVIDER: 'off' }), { fetchImpl: freeFetch([]) });
  assert.equal(images.ensureScene(dataDir, st, { turn: 1, desc: SCENE_DESC }), null);
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: okFetch(null) });
  assert.equal(images.ensureScene(dataDir, st, { turn: 1, desc: '' }), null);
});

test('智谱场景插图：size 1344x768，中文场景提示词，scene-*.jpg，索引 kind=scene / status=ready / 有 turn', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(calls) });
  const st = sceneState();
  const key = images.ensureScene(dataDir, st, { turn: 7, desc: SCENE_DESC });
  await images.waitIdle();
  assert.match(key, /^[0-9a-f]{12}$/);
  const zp = calls.find((c) => c.url === images.ZHIPU_URL);
  assert.ok(zp, '应请求智谱');
  assert.equal(zp.body.size, '1344x768');
  const p = zp.body.prompt;
  assert.match(p, /^复古铜版线描淡彩/);
  assert.match(p, /世界背景/);
  assert.match(p, /游戏场景插画/);
  assert.match(p, /横幅/);
  assert.match(p, /在场人物/);
  const e = Object.values(images.readIndex(dataDir))[0];
  assert.equal(e.kind, 'scene');
  assert.equal(e.status, 'ready');
  assert.equal(e.turn, 7);
  assert.match(e.file, /^scene-[0-9a-f]{12}\.jpg$/);
});

test('硅基流动场景插图：image_size 1024x576', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sf-k' }), { fetchImpl: freeFetch(calls) });
  const key = images.ensureScene(dataDir, sceneState(), { turn: 3, desc: SCENE_DESC });
  await images.waitIdle();
  assert.match(key, /^[0-9a-f]{12}$/);
  const sf = calls.find((c) => c.url === images.SILICONFLOW_URL);
  assert.ok(sf, '应请求硅基流动');
  assert.equal(sf.body.image_size, '1024x576');
  assert.match(sf.body.prompt, /游戏场景插画/);
});

test('Cloudflare 场景插图：英文画风开头、含 cinematic wide composition、无题字/印章/文字/水印词；translate 走 ≤40 词场景口径', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  let seen = null;
  configureT(baseCfg({ IMAGE_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_API_TOKEN: 'cf-t' }), {
    fetchImpl: cfFetch(calls),
    translate: async (job, messages) => {
      seen = { job, messages };
      return 'a misty gaslit street with a lone lamplighter';
    },
  });
  const key = images.ensureScene(dataDir, sceneState(), { turn: 5, desc: SCENE_DESC });
  await images.waitIdle();
  assert.match(key, /^[0-9a-f]{12}$/);
  const cf = calls.find((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE));
  assert.ok(cf, '应请求 Cloudflare');
  const p = cf.body.prompt;
  assert.match(p, /^vintage engraving line art with sepia washes\./);
  assert.match(p, /cinematic wide composition/);
  assert.ok(!/calligraphy|seal|text|watermark/i.test(p), '不得出现 calligraphy / seal / text / watermark');
  assert.equal(seen.job.kind, 'scene');
  assert.match(seen.messages[0].content, /40 words/);
  assert.match(seen.messages[1].content, /^场景：/);
  assert.match(seen.messages[1].content, /在场人物/);
  assert.match(seen.messages[1].content, /时代背景/);
});

test('每日上限：来客 pA 今天 60 张 scene 返回 null 且不发请求；host 不受限；上限 0 不限', async (t) => {
  const now = Date.now();
  const rows = Array.from({ length: 60 }, (_, i) => ({
    ts: now - i, kind: 'scene', provider: 'zhipu', ok: true, playerId: 'pA',
  }));
  const seed = (dir) => fs.writeFileSync(store.usagePath(dir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const cfg = (limit) => baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k', IMAGE_SCENE_DAILY_PER_PLAYER: limit });
  const st = sceneState();

  // pA 到上限
  const dA = tmpDir(t);
  seed(dA);
  const callsA = [];
  configureT(cfg(60), { fetchImpl: freeFetch(callsA) });
  const keyA = context.run({ playerId: 'pA' }, () => images.ensureScene(dA, st, { turn: 1, desc: SCENE_DESC }));
  assert.equal(keyA, null);
  assert.equal(callsA.length, 0, '到上限不应发任何请求');

  // host 不受限
  const dH = tmpDir(t);
  seed(dH);
  const callsH = [];
  configureT(cfg(60), { fetchImpl: freeFetch(callsH) });
  const keyH = context.run({ playerId: 'host' }, () => images.ensureScene(dH, st, { turn: 1, desc: SCENE_DESC }));
  assert.match(keyH, /^[0-9a-f]{12}$/);
  await images.waitIdle();
  assert.ok(callsH.length > 0, 'host 应照常出图');

  // 上限 0 表示不限
  const d0 = tmpDir(t);
  seed(d0);
  const calls0 = [];
  configureT(cfg(0), { fetchImpl: freeFetch(calls0) });
  const key0 = context.run({ playerId: 'pA' }, () => images.ensureScene(d0, st, { turn: 2, desc: '另一幅画面' }));
  assert.match(key0, /^[0-9a-f]{12}$/);
  await images.waitIdle();
  assert.ok(calls0.length > 0, '上限 0 应照常出图');
});

test('prefs 开关：pA 关闭 scenes 后返回 null，pB 不受影响', async (t) => {
  const dataDir = tmpDir(t);
  prefs.setPrefs(dataDir, 'pA', { scenes: false });
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(calls) });
  const st = sceneState();
  const a = context.run({ playerId: 'pA' }, () => images.ensureScene(dataDir, st, { turn: 1, desc: SCENE_DESC }));
  assert.equal(a, null);
  assert.equal(calls.length, 0, '关闭开关不应发请求');
  const b = context.run({ playerId: 'pB' }, () => images.ensureScene(dataDir, st, { turn: 1, desc: SCENE_DESC }));
  assert.match(b, /^[0-9a-f]{12}$/);
  await images.waitIdle();
  assert.ok(calls.length > 0, 'pB 应照常出图');
});

test('用量：出一张场景图后 usage.jsonl 记 kind:scene；summarizeToday 的 images.scenes 计数正确', async (t) => {
  const dataDir = tmpDir(t);
  const fixed = Date.now();
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: okFetch(null), now: () => fixed });
  const key = images.ensureScene(dataDir, sceneState(), { turn: 4, desc: SCENE_DESC });
  await images.waitIdle();
  assert.match(key, /^[0-9a-f]{12}$/);
  const rows = store.readJsonl(store.usagePath(dataDir));
  const sceneRows = rows.filter((r) => r.kind === 'scene');
  assert.equal(sceneRows.length, 1);
  assert.equal(sceneRows[0].ok, true);
  const sum = llm.summarizeToday(rows, fixed, 0);
  assert.equal(sum.images.scenes, 1);
  assert.deepEqual(sum.images.total, { ok: 1, fail: 0 });

  // image 与 scene 都计入 byProvider / total
  const mixed = [
    { ts: fixed, kind: 'image', provider: 'gateway', ok: true },
    { ts: fixed, kind: 'scene', provider: 'gateway', ok: true },
  ];
  const s2 = llm.summarizeToday(mixed, fixed, 0);
  assert.deepEqual(s2.images.total, { ok: 2, fail: 0 });
  assert.equal(s2.images.scenes, 1);
});
