'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../src/images.js');
const store = require('../src/store.js');

const JPEG = Buffer.from('FAKE-JPEG-BYTES');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseCfg(overrides) {
  return Object.assign({
    IMAGE_PROVIDER: 'gateway',
    IMAGE_BASE_URL: 'https://img.test/v1',
    IMAGE_MODEL: 'Doubao-seedream-4.0',
    IMAGE_SIZE: '1024x1024',
    IMAGE_MAX_PER_WORLD: 40,
    IMAGE_CONCURRENCY: 1,
    LLM_MOCK: false,
    LLM_API_KEY: 'sk-test',
    LLM_BASE: 'https://chat.test/v1',
    LLM_MODEL: 'test-model',
    LLM_TIMEOUT_MS: 5000,
    LLM_DAILY_TOKEN_LIMIT: 0,
    LLM_EXTRA_BODY: '',
  }, overrides || {});
}

function makeState(overrides) {
  return Object.assign({
    id: 'w1',
    bible: {
      title: '蒸汽朋克长安', tone: '齿轮与迷雾',
      npcs: [{ name: '守夜人', role: '引路者', desc: '总在雾里提一盏不灭的灯' }],
    },
    character: { items: ['无字信', '旧铜灯'] },
    npcAttitude: { '守夜人': 0 },
  }, overrides || {});
}

// 记录请求，返回成功的 b64_json 响应。
function okFetch(calls) {
  return async (url, opts) => {
    if (calls) {
      calls.push({
        url,
        headers: opts && opts.headers,
        body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body,
      });
    }
    return { ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }) };
  };
}

function stubWarn(t) {
  const original = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  t.after(() => { console.warn = original; });
  return warns;
}

test('画风推断：六类关键词各推一份中英画风，缺省回退「手绘插画」', () => {
  const cases = [
    ['修仙宗门外门杂役', '苍茫', '水墨手绘插画', 'Chinese ink wash illustration'],
    ['蒸汽朋克长安', '齿轮轰鸣', '复古蒸汽朋克手绘', 'steampunk hand-drawn illustration'],
    ['赛博霓虹都市', '未来', '科幻概念插画', 'sci-fi concept art illustration'],
    ['深海殖民站', '幽暗', '科幻概念插画', 'sci-fi concept art illustration'],
    ['民国上海滩', '谍影', '复古民国画报风', 'vintage 1930s poster illustration'],
    ['末日尸潮', '荒凉', '末日写实插画', 'post-apocalyptic gritty illustration'],
    ['一个普通小镇', '平淡', '手绘插画', 'hand-drawn game illustration'],
  ];
  for (const [title, tone, zh, en] of cases) {
    assert.deepEqual(images.inferStyle({ title, tone }), { zh, en }, title);
  }
  assert.deepEqual(images.inferStyle(null), { zh: '手绘插画', en: 'hand-drawn game illustration' });
  // tone 也能命中
  assert.equal(images.inferStyle({ title: '无名之地', tone: '武侠江湖' }).zh, '水墨手绘插画');
});

test('imageKey：物品跨世界同名同画风共享；NPC 按世界区分；12 位十六进制', () => {
  const s = '水墨手绘插画';
  const a = images.imageKey('item', '无字信', s, 'wA');
  const b = images.imageKey('item', '无字信', s, 'wB');
  assert.equal(a, b, '物品不带 worldId，两世界共用一张');
  assert.match(a, /^[0-9a-f]{12}$/);
  const n1 = images.imageKey('npc', '守夜人', s, 'wA');
  const n2 = images.imageKey('npc', '守夜人', s, 'wB');
  assert.notEqual(n1, n2, 'NPC 带 worldId，重名但不同世界不共用');
  assert.notEqual(images.imageKey('item', '甲', s, 'wA'), images.imageKey('item', '乙', s, 'wA'));
});

test('mock：不访问网络，写占位 SVG（文件名 .svg、status ready、url 可拼出）', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let fetched = false;
  images.configure(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: true }), {
    fetchImpl: () => { fetched = true; return Promise.reject(new Error('不应访问网络')); },
  });
  const state = makeState();
  images.ensureImages(dataDir, state, images.listForState(state));
  await images.waitIdle();
  assert.equal(fetched, false, 'mock 不能发起网络请求');
  const idx = images.readIndex(dataDir);
  const keys = Object.keys(idx);
  assert.equal(keys.length, 3, '2 物品 + 1 NPC');
  for (const k of keys) {
    assert.equal(idx[k].status, 'ready');
    assert.match(idx[k].file, /\.svg$/);
    assert.ok(fs.existsSync(path.join(dataDir, 'images', idx[k].file)), 'SVG 文件应写到磁盘');
  }
  const list = images.imageList(dataDir, state);
  assert.equal(list.items['无字信'].status, 'ready');
  assert.match(list.items['无字信'].url, /^\/api\/images\/item-[0-9a-f]{12}\.svg$/);
  assert.equal(list.npcs['守夜人'].status, 'ready');
});

test('共享缓存去重：不同世界同名同画风物品只生成一次（同一 key 不重复排队）', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: okFetch(calls) });
  const s1 = makeState({
    id: 'wA', bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
    character: { items: ['旧铜灯'] }, npcAttitude: {},
  });
  const s2 = makeState({
    id: 'wB', bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
    character: { items: ['旧铜灯'] }, npcAttitude: {},
  });
  images.ensureImages(dataDir, s1, images.listForState(s1));
  images.ensureImages(dataDir, s2, images.listForState(s2));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  const itemKeys = Object.keys(idx).filter((k) => idx[k].kind === 'item');
  assert.equal(itemKeys.length, 1, '同名同画风物品在全局缓存里只有一条');
  assert.equal(calls.length, 1, '只出图一次');
  assert.equal(idx[itemKeys[0]].status, 'ready');
});

test('NPC 按世界区分：重名但不同世界生成两张图', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  images.configure(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: true }));
  const s1 = makeState({
    id: 'wA', bible: { title: '蒸汽朋克长安', tone: '', npcs: [{ name: '守夜人', role: '甲', desc: '甲' }] },
    character: { items: [] }, npcAttitude: { '守夜人': 0 },
  });
  const s2 = makeState({
    id: 'wB', bible: { title: '蒸汽朋克长安', tone: '', npcs: [{ name: '守夜人', role: '乙', desc: '乙' }] },
    character: { items: [] }, npcAttitude: { '守夜人': 0 },
  });
  images.ensureImages(dataDir, s1, images.listForState(s1));
  images.ensureImages(dataDir, s2, images.listForState(s2));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  const npcKeys = Object.keys(idx).filter((k) => idx[k].kind === 'npc');
  assert.equal(npcKeys.length, 2, 'NPC key 带世界 id，重名也各一张');
});

test('gateway 上限：超过 IMAGE_MAX_PER_WORLD 不再排队；请求体/鉴权头/中文提示词正确', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'gateway', IMAGE_MAX_PER_WORLD: 2 }), {
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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'gateway' }), {
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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: okFetch(null) });
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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'gateway' }), {
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

  images.configure(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: false }));
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
  assert.match(entry.prompt, /^a rusty brass lantern glowing in fog, single object centered, game item icon,/);
  assert.match(entry.prompt, /steampunk hand-drawn illustration/);
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

  images.configure(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: false }));
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
  assert.match(entry.prompt, /a mysterious item, single object centered/);

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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: slowFetch });
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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'off' }), {
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

test('GET /images 老存档补图：list 时无索引项会顺手排队，先 pending 后 ready', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowFetch = () => gate.then(() => ({
    ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }),
  }));
  images.configure(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: slowFetch });
  const state = makeState();
  const first = images.imageList(dataDir, state);
  assert.equal(first.items['无字信'].status, 'pending', '请求时顺手排队，立即返回 pending');
  assert.equal(first.npcs['守夜人'].status, 'pending');
  release();
  await images.waitIdle();
  const second = images.imageList(dataDir, state);
  assert.equal(second.items['无字信'].status, 'ready');
  assert.equal(second.npcs['守夜人'].status, 'ready');
});

test('imageList 只含当前 character.items 与 npcAttitude 的名字', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  images.configure(baseCfg({ IMAGE_PROVIDER: 'off' }));
  const state = makeState({
    character: { items: ['无字信', '旧铜灯'] },
    npcAttitude: { '守夜人': 0, '铸剑师': 2 },
  });
  const list = images.imageList(dataDir, state);
  assert.deepEqual(Object.keys(list.items).sort(), ['无字信', '旧铜灯'].sort());
  assert.deepEqual(Object.keys(list.npcs).sort(), ['守夜人', '铸剑师'].sort());
  assert.equal(list.items['半张海图'], undefined, '已不在物品里的名字不返回');
});

test('serveImage：文件名严格校验（非法 400 / 缺失 404 / 正确 200 + Content-Type）', (t) => {
  const dataDir = tmpDir(t);
  for (const bad of [
    'item-ABCDEF012345.jpg',   // 大写
    'item-abcdef.jpg',         // 长度不足
    'foo-abcdef012345.jpg',    // 非法 kind
    'item-abcdef012345.png',   // 非法扩展名
    'item-abcdef012345.jpg.bak',
    '../item-abcdef012345.jpg',
    'npc-abcdef01234g.jpg',    // 非十六进制
    '',
  ]) {
    assert.equal(images.serveImage(dataDir, bad).status, 400, `非法文件名应 400：${bad}`);
  }
  const good = 'item-abcdef012345.jpg';
  assert.equal(images.serveImage(dataDir, good).status, 404, '合法但不存在 → 404');

  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'images', good), JPEG);
  const r = images.serveImage(dataDir, good);
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'image/jpeg');
  assert.equal(r.filePath, path.join(dataDir, 'images', good));
  const svg = 'npc-0123456789ab.svg';
  fs.writeFileSync(path.join(dataDir, 'images', svg), '<svg/>');
  assert.equal(images.serveImage(dataDir, svg).contentType, 'image/svg+xml');
});

// ---- 免费提供方 + 回退链 ----
// 假服务：硅基流动返回 images[0].url，智谱返回 data[0].url，下载 URL 返回 JPEG。
function freeFetch(calls, behavior) {
  const b = behavior || {};
  return async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    if (calls) calls.push({ url, headers: opts && opts.headers, body });
    if (url === images.SILICONFLOW_URL) {
      if (b.sf === 'fail') return { ok: false, status: 429, json: async () => ({ code: 50603, message: 'rate limited' }) };
      return { ok: true, status: 200, json: async () => ({ images: [{ url: 'https://dl.test/sf.png' }] }) };
    }
    if (url === images.ZHIPU_URL) {
      if (b.zp === 'fail') return { ok: false, status: 500, json: async () => ({ error: { message: 'zp down' } }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://dl.test/zp.png' }] }) };
    }
    if (url.startsWith('https://dl.test/')) {
      return { ok: true, status: 200, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) };
    }
    throw new Error('意外的 URL ' + url);
  };
}

function oneItemState(id) {
  return makeState({
    id, character: { items: ['旧铜灯'] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
}

test('siliconflow：请求体 / 鉴权头 / 中文提示词正确，下载 URL 写 jpg，用量记 siliconflow', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  images.configure(baseCfg({ IMAGE_PROVIDER: 'siliconflow,zhipu', SILICONFLOW_API_KEY: 'sf-k', ZHIPU_API_KEY: 'zp-k' }),
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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'siliconflow,zhipu', SILICONFLOW_API_KEY: 'sf-k', ZHIPU_API_KEY: 'zp-k' }),
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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'siliconflow,zhipu', SILICONFLOW_API_KEY: '', ZHIPU_API_KEY: 'zp-k' }),
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
  images.configure(baseCfg({ IMAGE_PROVIDER: 'zhipu', ZHIPU_API_KEY: 'zp-k', IMAGE_MAX_PER_WORLD: 1 }),
    { fetchImpl: freeFetch(null) });
  const st = makeState({ id: 'wcap', npcAttitude: {}, bible: { title: 'x', tone: '', npcs: [] } });
  images.ensureImages(dataDir, st, images.listForState(st));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  assert.equal(Object.values(idx).filter((e) => e.status === 'ready').length, 2);
  assert.equal(images.configure(baseCfg({ IMAGE_PROVIDER: 'zhipu,gateway' })).config.providers.join(','), 'zhipu,gateway');
});
