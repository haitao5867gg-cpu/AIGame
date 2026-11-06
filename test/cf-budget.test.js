'use strict';

// Cloudflare 每日免费额度（UTC 零点重置）耐用策略 + 用量面板：回归测试。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const images = require('../src/images.js');
const llm = require('../src/llm.js');
const env = require('../src/env.js');
const store = require('../src/store.js');
const {
  JPEG, tmpDir, createT, baseCfg, makeState, oneItemState, stubWarn,
} = require('./helpers/images-helpers.js');
const { withServer, req } = require('./helpers/api-helpers.js');

const T = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z，稳定的 UTC 正午

function cfCfg(overrides) {
  return baseCfg(Object.assign({
    IMAGE_PROVIDER: 'cloudflare,zhipu',
    CLOUDFLARE_ACCOUNT_ID: 'acc1',
    CLOUDFLARE_API_TOKEN: 'cf-t',
    ZHIPU_API_KEY: 'zp-k',
    CLOUDFLARE_DAILY_NEURONS: 10000,
    CLOUDFLARE_RESERVE_FROM: 7000,
  }, overrides || {}));
}

// 记录请求；cloudflare 可由 state.cfFail 切换「429 额度用完」/ 成功（带 cf-ai-neurons 响应头）。
function budgetFetch(calls, state) {
  const s = state || {};
  return async (url, opts) => {
    if (calls) calls.push({ url, headers: opts && opts.headers });
    if (url.startsWith(images.CLOUDFLARE_API_BASE)) {
      if (s.cfFail) {
        return {
          ok: false, status: 429,
          json: async () => ({ success: false, errors: [{ code: 4006, message: 'daily free allocation used' }] }),
        };
      }
      return {
        ok: true, status: 200,
        headers: { get: (k) => (k === 'cf-ai-neurons' ? String(s.cfNeurons || 190) : null) },
        json: async () => ({ success: true, errors: [], result: { image: JPEG.toString('base64') } }),
      };
    }
    if (url === images.ZHIPU_URL) {
      return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://dl.test/zp.png' }] }) };
    }
    if (url.startsWith('https://dl.test/')) {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length),
      };
    }
    throw new Error('意外的 URL ' + url);
  };
}

function sceneState(id) {
  return makeState({
    id, life: 1,
    character: { items: [] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
}

function seedCfUsage(dataDir, now, neurons) {
  const rows = [{ ts: now - 1000, kind: 'image', provider: 'cloudflare', model: 'm', ok: true, neurons }];
  fs.writeFileSync(store.usagePath(dataDir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---- 1. cloudflareNeuronsToday 纯函数 ----

test('cloudflareNeuronsToday：按 UTC 日累计、老记录按 175 估算、别的 provider 不计', () => {
  // 刚过 UTC 零点：UTC 日与本地日容易错开，专门验证按 UTC 日统计。
  const now = Date.UTC(2026, 5, 15, 0, 30, 0);
  const rows = [
    { ts: now - 20 * 60000, provider: 'cloudflare', ok: true, neurons: 100 },   // 06-15 00:10Z（今日 UTC）
    { ts: now - 10 * 60000, provider: 'cloudflare', ok: true },                  // 06-15 00:20Z 老记录 → 175
    { ts: now - 40 * 60000, provider: 'cloudflare', ok: true, neurons: 9000 },  // 06-14 23:50Z（昨日 UTC）→ 不计
    { ts: now - 10 * 60000, provider: 'siliconflow', ok: true, neurons: 5000 }, // 别的 provider → 不计
    { ts: now - 10 * 60000, provider: 'cloudflare', ok: false },                 // 失败且无 neurons → 0
  ];
  assert.equal(llm.cloudflareNeuronsToday(rows, now), 275);
});

test('env：CLOUDFLARE_DAILY_NEURONS / CLOUDFLARE_RESERVE_FROM 默认值与数值归一', () => {
  assert.equal(env.DEFAULTS.CLOUDFLARE_DAILY_NEURONS, '10000');
  assert.equal(env.DEFAULTS.CLOUDFLARE_RESERVE_FROM, '7000');
  const cfg = env.load('/__aigame_no_such_env__/.env', {});
  assert.equal(cfg.CLOUDFLARE_DAILY_NEURONS, 10000);
  assert.equal(cfg.CLOUDFLARE_RESERVE_FROM, 7000);
});

// ---- 2. 文生图读取 cf-ai-neurons 响应头 ----

test('文生图成功时用量记录带 neurons（来自 cf-ai-neurons 响应头）', async (t) => {
  stubWarn(t);
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(cfCfg({ IMAGE_PROVIDER: 'cloudflare' }), {
    now: () => T,
    fetchImpl: budgetFetch(calls, { cfFail: false, cfNeurons: 233 }),
    translate: async () => 'old brass lamp',
  });
  const st = oneItemState('wneurons');
  inst.ensureImages(dataDir, st, images.listForState(st));
  await inst.waitIdle();
  assert.ok(calls.some((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE)), '应请求 cloudflare');
  const rows = store.readJsonl(store.usagePath(dataDir)).filter((r) => r.kind === 'image');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'cloudflare');
  assert.equal(rows[0].neurons, 233);
});

// ---- 3. 预留额度：非场景图让出 cloudflare，场景图仍用 ----

test('今日已用 ≥ 7000：物品图不请求 cloudflare，改走回退链下一家', async (t) => {
  stubWarn(t);
  const dataDir = tmpDir(t);
  seedCfUsage(dataDir, T, 7500);
  const calls = [];
  const inst = createT(cfCfg(), {
    now: () => T,
    fetchImpl: budgetFetch(calls, { cfFail: false }),
    translate: async () => 'old brass lamp',
  });
  const st = oneItemState('wreserveitem');
  inst.ensureImages(dataDir, st, images.listForState(st));
  await inst.waitIdle();
  assert.equal(calls.filter((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE)).length, 0,
    '物品图不应请求 cloudflare');
  assert.ok(calls.some((c) => c.url === images.ZHIPU_URL), '应改走下一家 zhipu');
  assert.equal(Object.values(images.readIndex(dataDir))[0].provider, 'zhipu');
});

test('今日已用 ≥ 7000：场景图仍请求 cloudflare', async (t) => {
  stubWarn(t);
  const dataDir = tmpDir(t);
  seedCfUsage(dataDir, T, 7500);
  const calls = [];
  const inst = createT(cfCfg(), {
    now: () => T,
    fetchImpl: budgetFetch(calls, { cfFail: false }),
    translate: async () => 'a misty gaslit street',
  });
  inst.ensureScene(dataDir, sceneState('wreservescene'), { turn: 1, desc: '守夜人提灯走过雾中的长街' });
  await inst.waitIdle();
  assert.ok(calls.some((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE)),
    '场景图仍应请求 cloudflare');
});

// ---- 4. 429 今日额度用完 → 冷却到下一个 UTC 零点，零点后恢复 ----

test('4006 / daily free allocation 的 429 后冷却到下一个 UTC 零点，零点后恢复', async (t) => {
  stubWarn(t);
  let now = T;
  const calls = [];
  const state = { cfFail: true, cfNeurons: 190 };
  const inst = createT(cfCfg(), {
    now: () => now,
    fetchImpl: budgetFetch(calls, state),
    translate: async () => 'old brass lamp',
  });
  const cfCalls = () => calls.filter((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE)).length;

  // 第一次：cloudflare 返回 429 → 触发额度用完冷却，本张图回退到 zhipu。
  const d1 = tmpDir(t);
  const st1 = oneItemState('w429a');
  inst.ensureImages(d1, st1, images.listForState(st1));
  await inst.waitIdle();
  assert.ok(cfCalls() >= 1, '第一次应请求 cloudflare 并遇到 429');
  const after429 = cfCalls();

  // 冷却期间：物品 + 场景都不再请求 cloudflare（多参考图也不尝试）。
  const d2 = tmpDir(t);
  const st2 = oneItemState('w429b');
  inst.ensureImages(d2, st2, images.listForState(st2));
  const d3 = tmpDir(t);
  inst.ensureScene(d3, sceneState('w429c'), { turn: 1, desc: '雾中长街' });
  await inst.waitIdle();
  assert.equal(cfCalls(), after429, '冷却期间不应再请求 cloudflare');

  // 推进到下一个 UTC 零点之后：cloudflare 恢复可用。
  now = T + 2 * 24 * 3600 * 1000;
  state.cfFail = false;
  const d4 = tmpDir(t);
  const st4 = oneItemState('w429d');
  inst.ensureImages(d4, st4, images.listForState(st4));
  await inst.waitIdle();
  assert.ok(cfCalls() > after429, '零点后应恢复请求 cloudflare');
  assert.equal(Object.values(images.readIndex(d4))[0].provider, 'cloudflare', '恢复后由 cloudflare 出图');
});

// ---- 5. collectRefs 不带水印 ----

test('collectRefs 只收 cloudflare / local 的图，不收 siliconflow 与缺 provider 的老记录', (t) => {
  const dataDir = tmpDir(t);
  const imgDir = path.join(dataDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const WORLD = 'wrefs';
  const style = { zh: '测试画风' };
  const heroId = { name: '你', keyName: '你|青衣', desc: '青衣' };
  const castNames = ['你', '守夜人', '路人甲'];
  const itemNames = ['旧铜灯'];
  const idx = {};
  const put = (kind, key, provider) => {
    const indexKey = `${kind}-${key}`;
    const file = `${indexKey}.jpg`;
    fs.writeFileSync(path.join(imgDir, file), JPEG);
    const e = {
      kind, style: style.zh, worldId: WORLD, file, status: 'ready', ts: Date.now(),
      enPrompt: '', prompt: '',
    };
    if (provider != null) e.provider = provider;
    idx[indexKey] = e;
  };
  put('hero', images.imageKey('hero', heroId.keyName, style.zh, WORLD), 'siliconflow'); // 有水印
  put('npc', images.imageKey('npc', '守夜人', style.zh, WORLD), 'local');
  put('npc', images.imageKey('npc', '路人甲', style.zh, WORLD), undefined);             // 缺 provider
  put('item', images.imageKey('item', '旧铜灯', style.zh, WORLD), 'cloudflare');
  fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify(idx));

  const refs = images.collectRefs(dataDir, WORLD, style, heroId, castNames, itemNames);
  assert.equal(refs.length, 2, '只应收 local 头像 + cloudflare 物品图');
  assert.equal(refs.filter((r) => r.type === 'person').length, 1);
  assert.equal(refs.filter((r) => r.type === 'item').length, 1);
  assert.ok(refs.every((r) => !r.path.includes('hero-')), '不得收 siliconflow 的主角形象图');
});

// ---- 6. /api/usage/today ----

test('/api/usage/today 返回 images.cloudflare（used/limit/remaining/reserveFrom）', async () => {
  await withServer(async ({ base, dataDir }) => {
    const now = Date.now();
    const rows = [
      { ts: now - 1000, kind: 'image', provider: 'cloudflare', ok: true, neurons: 2000 },
      { ts: now - 2000, kind: 'image', provider: 'cloudflare', ok: true },            // 老记录 → 175
      { ts: now - 3000, kind: 'image', provider: 'siliconflow', ok: true, neurons: 9999 }, // 不计
    ];
    fs.writeFileSync(store.usagePath(dataDir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = await req(base, 'GET', '/api/usage/today');
    assert.equal(r.status, 200, r.text);
    const cf = r.json.images.cloudflare;
    assert.ok(cf, '应有 images.cloudflare');
    assert.equal(cf.used, 2175);
    assert.equal(cf.limit, 10000);
    assert.equal(cf.remaining, 10000 - 2175);
    assert.equal(cf.reserveFrom, 7000);
  }, { CLOUDFLARE_DAILY_NEURONS: 10000, CLOUDFLARE_RESERVE_FROM: 7000 });
});
