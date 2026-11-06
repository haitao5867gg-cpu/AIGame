'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../src/images.js');
const store = require('../src/store.js');
const { JPEG, tmpDir, withArt, configureT, createT, baseCfg, makeState, okFetch, stubWarn, freeFetch, oneItemState, msFetch, cfFetch, XIANXIA_ART, xianxiaState } = require('./helpers/images-helpers.js');

test('gateway 上限：超过 IMAGE_MAX_PER_WORLD 不再排队；请求体/鉴权头/中文提示词正确', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway', IMAGE_MAX_PER_WORLD: 2 }), {
    fetchImpl: okFetch(calls),
  });
  const state = makeState({
    character: { items: ['一', '二', '三', '四', '五'] },
    npcAttitude: {}, bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
  images.ensureImages(dataDir, state, images.listForState(state));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  assert.equal(Object.keys(idx).length, 2, '最多 2 条索引/2 次出图');
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.match(c.url, /\/images\/generations$/);
    assert.equal(c.headers['Authorization'], 'Bearer sk-test');
    assert.equal(c.body.model, 'Doubao-seedream-4.0');
    assert.equal(c.body.size, '1024x1024');
    assert.equal(c.body.n, 1);
    assert.equal(c.body.response_format, 'b64_json');
    assert.equal(c.body.watermark, false);
    assert.match(c.body.prompt, /游戏道具图标|游戏角色半身肖像/); // 中文提示词
  }
});

test('failed 冷却：10 分钟内不重试，过后允许重试', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let nowVal = 1000000;
  const calls = [];
  const failFetch = async (url, opts) => {
    calls.push({ url, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body });
    return { ok: true, json: async () => ({ error: { message: '额度不足' } }) };
  };
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), {
    fetchImpl: failFetch, now: () => nowVal,
  });
  const state = makeState({
    character: { items: ['旧铜灯'] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
  const list = images.listForState(state);

  images.ensureImages(dataDir, state, list);
  await images.waitIdle();
  assert.equal(calls.length, 1);
  assert.equal(images.readIndex(dataDir)[Object.keys(images.readIndex(dataDir))[0]].status, 'failed');

  // 冷却内：不重试
  images.ensureImages(dataDir, state, list);
  await images.waitIdle();
  assert.equal(calls.length, 1, '10 分钟内 failed 不重试');

  // 过了 10 分钟：允许重试
  nowVal += images.FAILED_COOLDOWN_MS + 1;
  images.ensureImages(dataDir, state, list);
  await images.waitIdle();
  assert.equal(calls.length, 2, '冷却结束后可重试');
  // 失败仍记 image 用量（ok:false）
  const rows = store.readJsonl(store.usagePath(dataDir)).filter((r) => r.kind === 'image');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.ok === false && r.provider === 'gateway' && r.worldId === 'w1'));
});

test('假 fetch 成功写 jpg（字节正确）；失败标 failed 且 url 为 null；成功/失败都记 image 用量', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: okFetch(null) });
  const okState = makeState({
    id: 'wok', character: { items: ['旧铜灯'] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
  images.ensureImages(dataDir, okState, images.listForState(okState));
  await images.waitIdle();
  let idx = images.readIndex(dataDir);
  const okKey = Object.keys(idx)[0];
  assert.equal(idx[okKey].status, 'ready');
  assert.match(idx[okKey].file, /^item-[0-9a-f]{12}\.jpg$/);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'images', idx[okKey].file)), JPEG);
  const okList = images.imageList(dataDir, okState);
  assert.equal(okList.items['旧铜灯'].status, 'ready');
  assert.match(okList.items['旧铜灯'].url, /^\/api\/images\//);

  // 失败：error 字段 → failed
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), {
    fetchImpl: async () => ({ ok: true, json: async () => ({ error: { message: 'boom' } }) }),
  });
  const failState = makeState({
    id: 'wbad', character: { items: ['断剑'] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
  images.ensureImages(dataDir, failState, images.listForState(failState));
  await images.waitIdle();
  idx = images.readIndex(dataDir);
  const failKey = Object.keys(idx).find((k) => idx[k].status === 'failed');
  assert.ok(failKey, '应存在 failed 索引项');
  assert.equal(images.imageList(dataDir, failState).items['断剑'].status, 'failed');
  assert.equal(images.imageList(dataDir, failState).items['断剑'].url, null);

  const rows = store.readJsonl(store.usagePath(dataDir)).filter((r) => r.kind === 'image');
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.ok === true).length, 1);
  assert.equal(rows.filter((r) => r.ok === false).length, 1);
  assert.ok(rows.every((r) => r.provider === 'gateway' && typeof r.ms === 'number' && r.model));
});

test('local 翻译成功：英文提示词 + enPrompt 入索引；请求体无 model / 无鉴权', async (t) => {
  const dataDir = tmpDir(t);
  const warns = stubWarn(t);
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith('/chat/completions')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'a rusty brass lantern glowing in fog' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }),
      };
    }
    calls.push({ url, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body, headers: opts.headers });
    return { ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }) };
  };
  t.after(() => { global.fetch = original; });

  configureT(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: false }));
  const state = makeState({
    character: { items: ['旧铜灯'] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
  images.ensureImages(dataDir, state, images.listForState(state));
  await images.waitIdle();

  const idx = images.readIndex(dataDir);
  const entry = idx[Object.keys(idx)[0]];
  assert.equal(entry.status, 'ready');
  assert.equal(entry.enPrompt, 'a rusty brass lantern glowing in fog');
  assert.match(entry.prompt, /^vintage engraving line art with sepia washes\. a rusty brass lantern glowing in fog, steam-powered clockwork era style, period-accurate object, single object centered, game item icon, plain light tan background, clean empty background, unsigned$/);
  assert.match(entry.prompt, /vintage engraving line art with sepia washes/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.prompt, entry.prompt);
  assert.equal(calls[0].body.size, '1024x1024');
  assert.equal(calls[0].body.response_format, 'b64_json');
  assert.equal('model' in calls[0].body, false, 'local 不带 model');
  assert.equal('n' in calls[0].body, false);
  assert.equal('watermark' in calls[0].body, false);
  assert.equal('Authorization' in (calls[0].headers || {}), false, 'local 无需鉴权');
  assert.equal(warns.length, 0, '正常路径不应告警');
});

test('local 翻译失败：用英文兜底短语，仍能出图，不抛错', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith('/chat/completions')) {
      return { ok: false, status: 500, text: async () => 'oops' };
    }
    calls.push({ url, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body });
    return { ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }) };
  };
  t.after(() => { global.fetch = original; });

  configureT(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: false }));
  const itemState = makeState({
    id: 'wi', character: { items: ['旧铜灯'] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
  images.ensureImages(dataDir, itemState, images.listForState(itemState));
  await images.waitIdle();
  let idx = images.readIndex(dataDir);
  let entry = idx[Object.keys(idx).find((k) => idx[k].kind === 'item')];
  assert.equal(entry.status, 'ready', '翻译失败仍要出图');
  assert.equal(entry.enPrompt, 'a mysterious item');
  assert.match(entry.prompt, /a mysterious item, steam-powered clockwork era style, period-accurate object, single object centered/);

  // NPC 用另一个兜底短语
  const npcState = makeState({
    id: 'wn', character: { items: [] }, npcAttitude: { '守夜人': 0 },
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [{ name: '守夜人', role: '甲', desc: '提灯' }] },
  });
  images.ensureImages(dataDir, npcState, images.listForState(npcState));
  await images.waitIdle();
  idx = images.readIndex(dataDir);
  entry = idx[Object.keys(idx).find((k) => idx[k].kind === 'npc')];
  assert.equal(entry.enPrompt, 'a mysterious person');
  assert.match(entry.prompt, /half-body portrait, clear face/);
});

test('不阻塞：ensureImages 同步立即返回，慢 fetch 不拖住调用方', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let released = false;
  const slowFetch = () => new Promise((resolve) => setTimeout(() => {
    released = true;
    resolve({ ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }) });
  }, 60));
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: slowFetch });
  const state = makeState({ character: { items: ['旧铜灯'] }, npcAttitude: {} });
  const t0 = Date.now();
  const ret = images.ensureImages(dataDir, state, images.listForState(state));
  assert.equal(ret, undefined, '应同步返回，不返回 Promise');
  assert.ok(Date.now() - t0 < 30, '应立即返回');
  assert.equal(released, false, '网络请求尚未完成，不应阻塞回合');
  await images.waitIdle();
  assert.equal(released, true);
  assert.equal(images.readIndex(dataDir)[Object.keys(images.readIndex(dataDir))[0]].status, 'ready');
});

test('IMAGE_PROVIDER=off：什么都不生成，列表为 none', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  configureT(baseCfg({ IMAGE_PROVIDER: 'off' }), {
    fetchImpl: () => { throw new Error('off 不应访问网络'); },
  });
  const state = makeState();
  images.ensureImages(dataDir, state, images.listForState(state));
  await images.waitIdle();
  assert.deepEqual(images.readIndex(dataDir), {}, '不写任何索引项/文件');
  const list = images.imageList(dataDir, state);
  assert.equal(list.items['无字信'].status, 'none');
  assert.equal(list.items['无字信'].url, null);
  assert.equal(list.npcs['守夜人'].status, 'none');
  assert.equal(fs.existsSync(path.join(dataDir, 'images')), false, '不应创建 images 目录');
});

// ---- 免费提供方 + 回退链 ----
// 假服务：硅基流动返回 images[0].url，智谱返回 data[0].url，下载 URL 返回 JPEG。


test('siliconflow：请求体 / 鉴权头 / 中文提示词正确，下载 URL 写 jpg，用量记 siliconflow', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'siliconflow,zhipu', SILICONFLOW_API_KEY: 'sf-k', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: freeFetch(calls) });
  const st = oneItemState('wsf');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, images.SILICONFLOW_URL);
  assert.equal(calls[0].headers.Authorization, 'Bearer sf-k');
  assert.equal(calls[0].body.model, 'Kwai-Kolors/Kolors');
  assert.equal(calls[0].body.image_size, '1024x1024');
  assert.match(calls[0].body.prompt, /旧铜灯/);
  assert.equal(calls[1].url, 'https://dl.test/sf.png');
  const idx = images.readIndex(dataDir);
  const e = idx[Object.keys(idx)[0]];
  assert.equal(e.status, 'ready');
  assert.equal(e.provider, 'siliconflow');
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'images', e.file)), JPEG);
});

test('回退链：siliconflow 失败换 zhipu；失败的一家进冷却，下一张直接先走 zhipu', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'siliconflow,zhipu', SILICONFLOW_API_KEY: 'sf-k', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: freeFetch(calls, { sf: 'fail' }) });
  const st = makeState({ id: 'wfb', npcAttitude: {}, bible: { title: '蒸汽朋克长安', tone: '', npcs: [] } });
  images.ensureImages(dataDir, st, images.listForState(st)); // 两件物品
  await images.waitIdle();
  const urls = calls.map((c) => c.url);
  assert.deepEqual(urls, [
    images.SILICONFLOW_URL, images.ZHIPU_URL, 'https://dl.test/zp.png', // 第一张：sf 失败 → zp
    images.ZHIPU_URL, 'https://dl.test/zp.png',                         // 第二张：sf 冷却中，先走 zp
  ]);
  assert.equal(calls[1].body.model, 'cogview-3-flash');
  assert.equal(calls[1].body.watermark_enabled, false);
  assert.equal(calls[1].headers.Authorization, 'Bearer zp-k');
  const idx = images.readIndex(dataDir);
  for (const k of Object.keys(idx)) {
    assert.equal(idx[k].status, 'ready');
    assert.equal(idx[k].provider, 'zhipu');
  }
});

test('回退链：没配 Key 的一家不发请求直接跳过；全部失败标 failed', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'siliconflow,zhipu', SILICONFLOW_API_KEY: '', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: freeFetch(calls, { zp: 'fail' }) });
  const st = oneItemState('wnk');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.deepEqual(calls.map((c) => c.url), [images.ZHIPU_URL]);
  const idx = images.readIndex(dataDir);
  assert.equal(idx[Object.keys(idx)[0]].status, 'failed');
});

test('回退链：免费链不受 IMAGE_MAX_PER_WORLD 限制；链里有 gateway 时才限', async (t) => {
  const dataDir = tmpDir(t);
  configureT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k', IMAGE_MAX_PER_WORLD: 1 }),
    { fetchImpl: freeFetch(null) });
  const st = makeState({ id: 'wcap', npcAttitude: {}, bible: { title: 'x', tone: '', npcs: [] } });
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  assert.equal(Object.values(idx).filter((e) => e.status === 'ready').length, 2);
  assert.equal(configureT(baseCfg({ IMAGE_PROVIDER: 'zhipu,gateway' })).config.providers.join(','), 'zhipu,gateway');
});

test('重启后遗留的 pending（不在本进程 inFlight 里）会重新排队并生成', async (t) => {
  const dataDir = tmpDir(t);
  configureT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(null) });
  const st = oneItemState('wstale');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  // 模拟上个进程留下的 pending：改写索引，再新建实例（inFlight 为空）。
  const idx = images.readIndex(dataDir);
  const k = Object.keys(idx)[0];
  fs.unlinkSync(path.join(dataDir, 'images', idx[k].file));
  idx[k] = Object.assign({}, idx[k], { status: 'pending', file: null });
  store.atomicWriteJson(path.join(dataDir, 'images', 'index.json'), idx);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k' }), { fetchImpl: freeFetch(calls) });
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(calls.length, 2, '应重新请求生成');
  const e = images.readIndex(dataDir)[k];
  assert.equal(e.status, 'ready');
  assert.ok(fs.existsSync(path.join(dataDir, 'images', e.file)));
});

test('提供方返回 PNG 字节时存成 .png，serveImage 返回 image/png', async (t) => {
  const dataDir = tmpDir(t);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const base = freeFetch(null);
  const fetchImpl = async (url, opts) => {
    if (url.startsWith('https://dl.test/')) {
      return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) };
    }
    return base(url, opts);
  };
  configureT(baseCfg({ IMAGE_PROVIDER: 'siliconflow', SILICONFLOW_API_KEY: 'sf-k' }), { fetchImpl });
  const st = oneItemState('wpng');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  const e = idx[Object.keys(idx)[0]];
  assert.equal(e.status, 'ready');
  assert.match(e.file, /^item-[0-9a-f]{12}\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'images', e.file)), PNG);
  const r = images.serveImage(dataDir, e.file);
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'image/png');
});

test('providerStatus：返回出图链，只列仍在冷却的提供方及剩余毫秒', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let now = 1_000_000;
  const inst = createT(baseCfg({ IMAGE_PROVIDER: 'siliconflow,zhipu', SILICONFLOW_API_KEY: 'sf-k', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: freeFetch(null, { sf: 'fail' }), now: () => now });
  assert.deepEqual(inst.providerStatus(), { chain: ['siliconflow', 'zhipu'], cooling: {} });
  const st = oneItemState('wps');
  inst.ensureImages(dataDir, st, inst.listForState(st));
  await inst.waitIdle();
  assert.deepEqual(inst.providerStatus().cooling, { siliconflow: images.PROVIDER_COOLDOWN_MS });
  now += images.PROVIDER_COOLDOWN_MS + 1;
  assert.deepEqual(inst.providerStatus().cooling, {});
});

// ---- 魔搭 ModelScope：异步任务 ----

test('modelscope：异步提交 → 轮询到 SUCCEED → 下载 output_images[0]，provider 记 modelscope', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const sleeps = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'modelscope', MODELSCOPE_API_KEY: 'ms-k' }),
    { fetchImpl: msFetch(calls, ['PENDING', 'RUNNING', 'SUCCEED']), sleep: async (ms) => { sleeps.push(ms); } });
  const st = oneItemState('wms');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(calls[0].url, images.MODELSCOPE_URL);
  assert.equal(calls[0].headers.Authorization, 'Bearer ms-k');
  assert.equal(calls[0].headers['X-ModelScope-Async-Mode'], 'true');
  assert.equal(calls[0].body.model, 'Tongyi-MAI/Z-Image-Turbo');
  assert.match(calls[0].body.prompt, /旧铜灯/);
  const polls = calls.filter((c) => c.url.startsWith(images.MODELSCOPE_TASK_URL));
  assert.equal(polls.length, 3);
  assert.equal(polls[0].headers['X-ModelScope-Task-Type'], 'image_generation');
  assert.deepEqual(sleeps, [2000, 2000, 2000]);
  assert.equal(calls[calls.length - 1].url, 'https://dl.test/ms.png');
  const e = Object.values(images.readIndex(dataDir))[0];
  assert.equal(e.status, 'ready');
  assert.equal(e.provider, 'modelscope');
});

test('modelscope：任务 FAILED 换下一家（zhipu）；没配 Key 直接跳过', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'modelscope,zhipu', MODELSCOPE_API_KEY: 'ms-k', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: msFetch(calls, ['FAILED']), sleep: async () => {} });
  const st = oneItemState('wmsf');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.ok(calls.some((c) => c.url === images.ZHIPU_URL));
  assert.equal(Object.values(images.readIndex(dataDir))[0].provider, 'zhipu');

  const dataDir2 = tmpDir(t);
  const calls2 = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'modelscope,zhipu', MODELSCOPE_API_KEY: '', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: msFetch(calls2), sleep: async () => {} });
  images.ensureImages(dataDir2, st, images.listForState(st));
  await images.waitIdle();
  assert.ok(!calls2.some((c) => c.url.startsWith('https://api-inference.modelscope.cn')));
  assert.equal(Object.values(images.readIndex(dataDir2))[0].provider, 'zhipu');
});

test('modelscope：一直 RUNNING 到超时则失败', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let n = 0;
  configureT(baseCfg({ IMAGE_PROVIDER: 'modelscope', MODELSCOPE_API_KEY: 'ms-k' }),
    { fetchImpl: msFetch(null, ['RUNNING']), sleep: async () => { n += 1; } });
  const st = oneItemState('wmst');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(n, 90);
  assert.equal(Object.values(images.readIndex(dataDir))[0].status, 'failed');
});

// ---- Cloudflare Workers AI ----

test('cloudflare：URL 带账户与模型、Bearer Token、steps=4、英文提示词，base64 解码落盘', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_API_TOKEN: 'cf-t' }),
    { fetchImpl: cfFetch(calls), translate: async () => 'old brass oil lamp' });
  const st = oneItemState('wcf');
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, images.CLOUDFLARE_API_BASE + 'acc1/ai/run/@cf/black-forest-labs/flux-1-schnell');
  assert.equal(calls[0].headers.Authorization, 'Bearer cf-t');
  assert.equal(calls[0].body.steps, 4);
  assert.match(calls[0].body.prompt, /\. old brass oil lamp, .* style, period-accurate object, single object centered/);
  const e = Object.values(images.readIndex(dataDir))[0];
  assert.equal(e.status, 'ready');
  assert.equal(e.provider, 'cloudflare');
  assert.match(e.file, /\.jpg$/);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, 'images', e.file)), JPEG);
});

test('cloudflare：额度用完（success:false）换下一家；账户或 Token 缺一就跳过不请求', async (t) => {
  stubWarn(t);
  const st = oneItemState('wcff');
  const dataDir = tmpDir(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'cloudflare,zhipu', CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_API_TOKEN: 'cf-t', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: cfFetch(calls, { fail: true }), translate: async () => 'lamp' });
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  assert.equal(Object.values(images.readIndex(dataDir))[0].provider, 'zhipu');

  const dataDir2 = tmpDir(t);
  const calls2 = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'cloudflare,zhipu', CLOUDFLARE_ACCOUNT_ID: 'acc1', CLOUDFLARE_API_TOKEN: '', ZHIPU_API_KEY: 'zp-k' }),
    { fetchImpl: cfFetch(calls2), translate: async () => 'lamp' });
  images.ensureImages(dataDir2, st, images.listForState(st));
  await images.waitIdle();
  assert.ok(!calls2.some((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE)));
  assert.equal(Object.values(images.readIndex(dataDir2))[0].provider, 'zhipu');
});

