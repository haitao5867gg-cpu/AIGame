'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const images = require('../src/images.js');
const store = require('../src/store.js');
const { JPEG, tmpDir, createT, baseCfg, makeState, stubWarn } = require('./helpers/images-helpers.js');

const KLEIN = images.DEFAULT_SCENE_REF_MODEL; // @cf/black-forest-labs/flux-2-klein-4b
const EN_TRANSLATE = async () => 'a misty gaslit street at night, a watchman on the right';

// 固定画风：bible.art 显式给出，style.zh 可精确算出，便于预置参考图索引项的 key。
const REF_ART = {
  zh: '测试画风', en: 'test art style', eraZh: '测试时代', eraEn: 'test era',
  avoidZh: '无', bgZh: '纯白背景', bgEn: 'plain white background',
};
const STYLE_ZH = `${REF_ART.zh}｜${REF_ART.eraZh}｜${REF_ART.bgZh}`;
const WORLD = 'wref';

function cfg(overrides) {
  return baseCfg(Object.assign({
    IMAGE_PROVIDER: 'cloudflare',
    CLOUDFLARE_ACCOUNT_ID: 'acc1',
    CLOUDFLARE_API_TOKEN: 'cf-t',
    ZHIPU_API_KEY: 'zp-k',
  }, overrides || {}));
}

function refState() {
  return makeState({
    id: WORLD, life: 1,
    character: { name: '旅人', appearance: '青衣', items: ['旧铜灯'] },
    npcAttitude: { '守夜人': 0 },
    bible: {
      title: '测试世界', tone: '', art: REF_ART,
      npcs: [{ name: '守夜人', role: '引路者', desc: '提灯的人' }],
    },
  });
}

// 预先在索引里放好 ready 的 hero / npc / item，并写入对应假图片文件。
function seedRefs(dataDir) {
  const imgDir = path.join(dataDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  const heroKey = images.imageKey('hero', '旅人|青衣', STYLE_ZH, WORLD);
  const npcKey = images.imageKey('npc', '守夜人', STYLE_ZH, WORLD);
  const itemKey = images.imageKey('item', '旧铜灯', STYLE_ZH, WORLD);
  const mk = (kind, key, extra) => {
    const file = `${kind}-${key}.jpg`;
    fs.writeFileSync(path.join(imgDir, file), JPEG);
    return Object.assign({
      kind, style: STYLE_ZH, worldId: WORLD, file, status: 'ready', ts: Date.now(),
      enPrompt: '', prompt: '', provider: 'local',
    }, extra);
  };
  const idx = {};
  idx[`hero-${heroKey}`] = mk('hero', heroKey, { name: '旅人' });
  idx[`npc-${npcKey}`] = mk('npc', npcKey, {
    name: '守夜人', enPrompt: 'a stern night watchman carrying a lantern',
  });
  idx[`item-${itemKey}`] = mk('item', itemKey, {
    name: '旧铜灯', enPrompt: 'an old bronze oil lamp with a curved handle and glass chimney',
  });
  fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify(idx));
  return idx;
}

function respHeaders(neurons) {
  return { get: (k) => (k === 'cf-ai-neurons' && neurons != null ? String(neurons) : null) };
}

// 记录请求：multipart 时 body 保持 FormData 原样，便于断言 prompt / width / input_image_N。
function refFetch(calls, behavior) {
  const b = behavior || {};
  return async (url, opts) => {
    const body = opts && opts.body;
    if (calls) calls.push({ url, headers: opts && opts.headers, body, method: opts && opts.method });
    if (url.includes('flux-2-klein-4b')) {
      if (b.kleinFail) {
        return { ok: false, status: 500, headers: respHeaders(null), json: async () => ({ success: false, errors: [{ message: 'no quota' }] }) };
      }
      const neurons = b.neurons == null ? 114 : b.neurons;
      return {
        ok: true, status: 200, headers: respHeaders(neurons),
        json: async () => ({ success: true, errors: [], result: { image: JPEG.toString('base64') } }),
      };
    }
    if (url.startsWith(images.CLOUDFLARE_API_BASE)) {
      return {
        ok: true, status: 200, headers: respHeaders(null),
        json: async () => ({ success: true, errors: [], result: { image: JPEG.toString('base64') } }),
      };
    }
    if (url === images.ZHIPU_URL) {
      return {
        ok: true, status: 200, headers: respHeaders(null),
        json: async () => ({ data: [{ url: 'https://dl.test/zp.png' }] }),
      };
    }
    if (url.startsWith('https://dl.test/')) {
      return {
        ok: true, status: 200, headers: respHeaders(null),
        arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length),
      };
    }
    // gateway / local：OpenAI 格式
    return {
      ok: true, status: 200, headers: respHeaders(null),
      json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }),
    };
  };
}

const SCENE_SPEC = {
  turn: 3,
  desc: '守夜人提灯走过雾中的长街',
  place: '雾中长街',
  cast: ['你', '守夜人'],
  items: ['旧铜灯'],
  action: '主角在左侧，守夜人提灯在右侧，暖黄灯光',
};

test('主角形象图：listForState 首项 hero、文件名 hero-xxx、GET /images 列表含 hero', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const inst = createT(cfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: true }));
  const state = makeState({
    id: 'whero',
    character: { name: '旅人', appearance: '青衣', items: ['旧铜灯'] },
    npcAttitude: { '守夜人': 0 },
  });
  const list = inst.listForState(state);
  assert.equal(list[0].kind, 'hero');
  assert.equal(list[0].name, '旅人');
  assert.equal(list[0].role, '主角');
  assert.equal(list[0].desc, '青衣');
  inst.ensureImages(dataDir, state, list);
  await inst.waitIdle();
  const idx = images.readIndex(dataDir);
  const heroKey = Object.keys(idx).find((k) => idx[k].kind === 'hero');
  assert.ok(heroKey, '应有 hero 索引项');
  assert.equal(idx[heroKey].status, 'ready');
  assert.match(idx[heroKey].file, /^hero-[0-9a-f]{12}\.svg$/);
  assert.ok(images.FILE_NAME_RE.test(idx[heroKey].file));
  const out = inst.imageList(dataDir, state);
  assert.ok(out.hero, 'imageList 应含 hero');
  assert.equal(out.hero.status, 'ready');
  assert.match(out.hero.url, /^\/api\/images\/hero-[0-9a-f]{12}\.svg$/);
  // hero key 与 NPC 一样带 worldId
  assert.notEqual(images.imageKey('hero', '旅人|青衣', 'x', 'wA'), images.imageKey('hero', '旅人|青衣', 'x', 'wB'));
});

test('场景多参考图：对 klein-4b 发 multipart（prompt/width/height/input_image_0..2），用量记 model 与 neurons', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(cfg(), { fetchImpl: refFetch(calls, { neurons: 114 }), translate: EN_TRANSLATE });
  const state = refState();
  seedRefs(dataDir);
  const key = inst.ensureScene(dataDir, state, SCENE_SPEC);
  await inst.waitIdle();
  assert.match(key, /^[0-9a-f]{12}$/);

  const klein = calls.find((c) => c.url.includes('flux-2-klein-4b'));
  assert.ok(klein, '应请求 flux-2-klein-4b');
  assert.equal(klein.headers.Authorization, 'Bearer cf-t');
  const form = klein.body;
  assert.ok(form && typeof form.get === 'function', 'body 应是 FormData（multipart）');
  assert.equal(form.get('width'), '1024');
  assert.equal(form.get('height'), '576');
  assert.ok(form.get('input_image_0'), '应有主角参考图');
  assert.ok(form.get('input_image_1'), '应有 NPC 参考图');
  assert.ok(form.get('input_image_2'), '应有物品参考图');
  assert.equal(form.get('input_image_3'), null, '最多 3 张参考图');
  const p = String(form.get('prompt') || '');
  assert.match(p, /image 0/);
  assert.match(p, /image 1/);
  assert.match(p, /image 2/);
  assert.match(p, /Keep each person's face/);
  assert.match(p, /the main character/);

  const e = images.readIndex(dataDir)[`scene-${key}`];
  assert.equal(e.status, 'ready');
  assert.equal(e.provider, 'cloudflare');
  assert.equal(e.refCount, 3, '索引项记 refs 数量');
  const rows = store.readJsonl(store.usagePath(dataDir)).filter((r) => r.kind === 'scene');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].provider, 'cloudflare');
  assert.equal(rows[0].model, KLEIN);
  assert.equal(rows[0].neurons, 114);
});

test('klein-4b 返回 500：落回文生图链仍然出图成功', async (t) => {
  const dataDir = tmpDir(t);
  const warns = stubWarn(t);
  const calls = [];
  const inst = createT(cfg({ IMAGE_PROVIDER: 'cloudflare,zhipu' }), {
    fetchImpl: refFetch(calls, { kleinFail: true }), translate: EN_TRANSLATE,
  });
  const state = refState();
  seedRefs(dataDir);
  const key = inst.ensureScene(dataDir, state, SCENE_SPEC);
  await inst.waitIdle();
  assert.ok(key);
  assert.equal(calls.filter((c) => c.url.includes('flux-2-klein-4b')).length, 1, '先试过 klein');
  assert.ok(calls.some((c) => c.url.includes('flux-1-schnell')), '落回文生图');
  assert.ok(warns.some((w) => w.includes('多参考图出图失败')), '应打日志');
  assert.equal(images.readIndex(dataDir)[`scene-${key}`].status, 'ready', '场景绝不能失败');
  const rows = store.readJsonl(store.usagePath(dataDir)).filter((r) => r.kind === 'scene');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
  assert.notEqual(rows[0].model, KLEIN, '用量 model 应是文生图模型');
});

test('没有 ready 的参考图：不调 klein，直接文生图', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(cfg(), { fetchImpl: refFetch(calls), translate: EN_TRANSLATE });
  const state = refState();
  // 故意不 seed 参考图
  const key = inst.ensureScene(dataDir, state, SCENE_SPEC);
  await inst.waitIdle();
  assert.ok(key);
  assert.equal(calls.filter((c) => c.url.includes('flux-2-klein-4b')).length, 0, '不调 klein');
  assert.ok(calls.some((c) => c.url.includes('flux-1-schnell')), '走文生图');
  assert.equal(images.readIndex(dataDir)[`scene-${key}`].status, 'ready');
});

test('translate 返回中文：cloudflare 被跳过，换到中文提供方 zhipu', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(cfg({ IMAGE_PROVIDER: 'cloudflare,zhipu' }), {
    fetchImpl: refFetch(calls),
    translate: async () => '雾中的长街，一个提灯的人缓缓走过',
  });
  const state = refState();
  const key = inst.ensureScene(dataDir, state, {
    turn: 6, desc: '守夜人提灯走过雾中的长街', place: '雾中长街',
    cast: ['守夜人'], items: [], action: '提灯走过',
  });
  await inst.waitIdle();
  assert.ok(key);
  assert.equal(calls.filter((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE)).length, 0, 'cloudflare 整体被跳过');
  assert.ok(calls.some((c) => c.url === images.ZHIPU_URL), '换到 zhipu');
  assert.equal(images.readIndex(dataDir)[`scene-${key}`].status, 'ready');
});

test('物品 / 人物图同样：翻译仍是中文就跳过 cloudflare，换 zhipu', async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(cfg({ IMAGE_PROVIDER: 'cloudflare,zhipu' }), {
    fetchImpl: refFetch(calls),
    translate: async () => '一个旧铜灯',
  });
  const state = makeState({ id: 'witem' }); // 无 character.name，避免 hero 混入
  inst.ensureImages(dataDir, state, [{ kind: 'item', name: '旧铜灯', role: '', desc: '' }]);
  await inst.waitIdle();
  assert.equal(calls.filter((c) => c.url.startsWith(images.CLOUDFLARE_API_BASE)).length, 0, 'cloudflare 被跳过');
  assert.ok(calls.some((c) => c.url === images.ZHIPU_URL), '换到 zhipu');
  const idx = images.readIndex(dataDir);
  const itemKeys = Object.keys(idx).filter((k) => idx[k].kind === 'item');
  assert.equal(itemKeys.length, 1);
  assert.equal(idx[itemKeys[0]].status, 'ready');
});

test("IMAGE_SCENE_REF_MODEL='' → 停用参考图，直接文生图", async (t) => {
  const dataDir = tmpDir(t);
  const calls = [];
  const inst = createT(cfg({ IMAGE_SCENE_REF_MODEL: '' }), {
    fetchImpl: refFetch(calls), translate: EN_TRANSLATE,
  });
  const state = refState();
  seedRefs(dataDir);
  const key = inst.ensureScene(dataDir, state, SCENE_SPEC);
  await inst.waitIdle();
  assert.ok(key);
  assert.equal(calls.filter((c) => c.url.includes('flux-2-klein-4b')).length, 0, '不调 klein');
  assert.ok(calls.some((c) => c.url.includes('flux-1-schnell')), '走文生图');
  const e = images.readIndex(dataDir)[`scene-${key}`];
  assert.equal(e.status, 'ready');
  assert.equal(e.refCount, undefined, '索引不记 refCount');
});
