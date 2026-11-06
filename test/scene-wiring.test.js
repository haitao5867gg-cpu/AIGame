'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const imagesMod = require('../src/images.js');
const { createHttpServer } = require('../server.js');
const { JPEG, tmpDir, createT, baseCfg, makeState, stubWarn } = require('./helpers/images-helpers.js');

const KEY_RE = /^[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// 1. triggerScene 传参：mock 的 draw 回合 scene 有 cast:['你','守夜人']，
//    用替身 images 记录 ensureScene 收到的 spec，确认 desc/place/cast/items/action 齐全。
// ---------------------------------------------------------------------------
async function req(base, method, pathname, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(base + pathname, opts);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: resp.status, text, json };
}

// 替换 createImages，返回一个包住真实实例、只记录 ensureScene spec 的替身对象。
async function withSpyServer(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-scene-wiring-'));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = 'sk-scene-wiring-test';
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  const cfg = Object.assign(env.getConfig(), { ACCESS_PASSWORD: '', IMAGE_PROVIDER: 'local' });

  const calls = [];
  const original = imagesMod.createImages;
  imagesMod.createImages = function (c) {
    const real = original(c);
    return Object.assign({}, real, {
      ensureScene(dataDir, state, spec) {
        calls.push(spec);
        return real.ensureScene(dataDir, state, spec);
      },
    });
  };

  const server = createHttpServer(cfg);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, calls });
  } finally {
    imagesMod.createImages = original;
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(resolve);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('triggerScene 把 scene 的 desc/place/cast/items/action 全传给 ensureScene', async () => {
  await withSpyServer(async ({ base, calls }) => {
    let r = await req(base, 'POST', '/api/worlds', {
      seed: '钟楼雾港', name: '旅人', appearance: '灰袍',
    });
    assert.equal(r.status, 201, r.text);
    const id = r.json.id;
    r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '第一步' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scene.draw, true, '首回合应为 draw 回合');
    assert.match(r.json.sceneKey, KEY_RE, 'draw 回合应有 12 位 sceneKey');

    const spec = calls[calls.length - 1];
    assert.ok(spec, 'draw 回合应调用一次 ensureScene');
    assert.equal(typeof spec.desc, 'string');
    assert.equal(typeof spec.place, 'string');
    assert.equal(typeof spec.action, 'string');
    assert.ok(Array.isArray(spec.cast), 'cast 应是数组');
    assert.deepEqual(spec.cast, ['你', '守夜人'], 'mock 的 cast 应原样传入');
    assert.ok(Array.isArray(spec.items), 'items 应是数组（即便是空数组也传）');
  });
});

// ---------------------------------------------------------------------------
// 2. sceneWithRefs 降级：老格式只有 desc（place/action 为空）时，
//    翻译 subject 改用 job.desc，而不是拿空字符串去翻译。
// ---------------------------------------------------------------------------
const EN_TRANSLATE = 'a misty gaslit street at night, a watchman on the right';

// 固定画风（bible.art 显式给出），便于预置参考图索引项的 key。
const REF_ART = {
  zh: '测试画风', en: 'test art style', eraZh: '测试时代', eraEn: 'test era',
  avoidZh: '无', bgZh: '纯白背景', bgEn: 'plain white background',
};
const STYLE_ZH = `${REF_ART.zh}｜${REF_ART.eraZh}｜${REF_ART.bgZh}`;
const WORLD = 'wwiring';

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
  const heroKey = imagesMod.imageKey('hero', '旅人|青衣', STYLE_ZH, WORLD);
  const npcKey = imagesMod.imageKey('npc', '守夜人', STYLE_ZH, WORLD);
  const itemKey = imagesMod.imageKey('item', '旧铜灯', STYLE_ZH, WORLD);
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
    name: '旧铜灯', enPrompt: 'an old bronze oil lamp with a curved handle',
  });
  fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify(idx));
  return idx;
}

function respHeaders(neurons) {
  return { get: (k) => (k === 'cf-ai-neurons' && neurons != null ? String(neurons) : null) };
}

function refFetch(calls) {
  return async (url, opts) => {
    const body = opts && opts.body;
    if (calls) calls.push({ url, headers: opts && opts.headers, body });
    if (url.includes('flux-2-klein-4b')) {
      return {
        ok: true, status: 200, headers: respHeaders(114),
        json: async () => ({ success: true, errors: [], result: { image: JPEG.toString('base64') } }),
      };
    }
    if (url.startsWith(imagesMod.CLOUDFLARE_API_BASE)) {
      return {
        ok: true, status: 200, headers: respHeaders(null),
        json: async () => ({ success: true, errors: [], result: { image: JPEG.toString('base64') } }),
      };
    }
    // gateway / local：OpenAI 格式
    return {
      ok: true, status: 200, headers: respHeaders(null),
      json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }),
    };
  };
}

test('sceneWithRefs 只有 desc 时，translate 的 subject 改用 job.desc（不拿空 place/action 翻译）', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  const seenSubjects = [];
  const inst = createT(cfg(), {
    fetchImpl: refFetch(calls),
    translate: async (job, messages) => {
      seenSubjects.push(messages[1].content);
      return EN_TRANSLATE;
    },
  });
  const state = refState();
  seedRefs(dataDir);
  const desc = '守夜人提灯走过雾中的长街';
  // 老格式：spec 只给 desc，没有 place / action / cast / items。
  const key = inst.ensureScene(dataDir, state, { turn: 1, desc });
  await inst.waitIdle();
  assert.match(key, KEY_RE, '应排队出图');
  assert.ok(calls.some((c) => c.url.includes('flux-2-klein-4b')), '应走 sceneWithRefs（klein-4b）');

  const subject = seenSubjects.find((s) => s && s.startsWith('场景：'));
  assert.ok(subject, 'translate 应收到以「场景：」开头的 subject');
  assert.ok(subject.includes(desc), 'subject 应包含 job.desc');
  assert.ok(!subject.includes('场景地点：'), 'place/action 为空时不应拼「场景地点：」');
  assert.ok(seenSubjects.every((s) => s.trim().length > 0), '不得拿空字符串去翻译');
});

// ---------------------------------------------------------------------------
// 3. 前端静态检查：public/js 用 imageState.hero 渲染主角头像，且未使用 innerHTML。
// ---------------------------------------------------------------------------
test('前端静态：imageState.hero 渲染主角头像、fetchImages 存 data.hero、无 innerHTML', () => {
  const jsDir = path.join(__dirname, '..', 'public', 'js');
  const img = fs.readFileSync(path.join(jsDir, 'images.js'), 'utf8');
  const game = fs.readFileSync(path.join(jsDir, 'game.js'), 'utf8');
  assert.match(img, /imageState\.hero/, 'images.js 应使用 imageState.hero');
  assert.match(img, /makeImageVisual\(\s*'你'\s*,\s*imageState\.hero/,
    '应用 makeImageVisual 以 imageState.hero 渲染主角头像');
  assert.match(img, /data\.hero/, 'fetchImages 应把 data.hero 存进 imageState.hero');
  assert.match(img, /hero-row/, 'images.js 应有主角头像容器');
  assert.match(game, /hero-row/, 'game.js 的 renderPanel 应在「认识的人」上方放置主角容器');
  assert.ok(!/innerHTML/.test(img), 'images.js 不得用 innerHTML');
  assert.ok(!/innerHTML/.test(game), 'game.js 不得用 innerHTML');
});
