'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const { createHttpServer } = require('../server.js');

const KEY_RE = /^[0-9a-f]{12}$/;

// ---- 以下辅助写法参考 test/api.test.js ----
async function req(base, method, pathname, body, headers, extra) {
  const opts = Object.assign({ method, headers: Object.assign({}, headers || {}) }, extra || {});
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(base + pathname, opts);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: resp.status, text, json, headers: resp.headers };
}

function asGuest(cookie) {
  const h = { 'cf-ray': 'test-ray' };
  if (cookie) h.cookie = cookie;
  return h;
}

function readAccessPassword(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8')).password;
}

async function loginGuest(base, dataDir, name) {
  const pw = readAccessPassword(dataDir);
  const r = await req(base, 'POST', '/api/login', { password: pw, name }, asGuest());
  assert.equal(r.status, 200, r.text);
  return r.headers.get('set-cookie').split(';')[0];
}

async function guestMe(base, cookie) {
  const r = await req(base, 'GET', '/api/me', undefined, asGuest(cookie));
  assert.equal(r.status, 200, r.text);
  return r.json;
}

function parseSSE(text) {
  const events = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      cur = { event: line.slice(6).trim(), data: '' };
    } else if (line.startsWith('data:') && cur) {
      let d = line.slice(5);
      if (d.charAt(0) === ' ') d = d.slice(1);
      cur.data += d;
    } else if (line === '' && cur) {
      events.push(cur);
      cur = null;
    }
  }
  if (cur) events.push(cur);
  return events;
}

function postStream(base, id, body) {
  return fetch(base + `/api/worlds/${id}/turn/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

// 随机端口起服务；显式设置 LLM_MOCK=1 与临时 DATA_DIR，并锁定本地出图链。
async function withServer(fn, cfgOverrides) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-scene-api-'));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = 'sk-scene-api-test';
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  const cfg = Object.assign(env.getConfig(),
    { ACCESS_PASSWORD: '', IMAGE_PROVIDER: 'local' }, cfgOverrides || {});
  const dataDir = env.resolveDataDir(cfg);
  const server = createHttpServer(cfg);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, dataDir, tmp });
  } finally {
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(resolve);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 轮询 /images，直到指定回合的场景 ready（mock 下出图很快，轮询兜住异步时序）。
async function waitSceneReady(base, id, turn) {
  for (let i = 0; i < 80; i++) {
    const r = await req(base, 'GET', `/api/worlds/${id}/images`);
    assert.equal(r.status, 200, r.text);
    const hit = Object.values(r.json.scenes || {}).find((s) => s && s.turn === turn);
    if (hit && hit.status === 'ready') return hit;
    await new Promise((res) => setTimeout(res, 25));
  }
  return null;
}

test('场景插图：/turn 与 stream 的 result 带 sceneKey（draw 回合 12 位、其余 null）', async () => {
  await withServer(async ({ base }) => {
    let r = await req(base, 'POST', '/api/worlds', {
      seed: '钟楼雾港', name: '旅人', appearance: '灰袍',
    });
    assert.equal(r.status, 201, r.text);
    const id = r.json.id;

    // 第 1 回合走流式（mock 下 turn%3===1 为 draw）。
    const sres = await postStream(base, id, { action: '流式第一步' });
    assert.equal(sres.status, 200);
    const events = parseSSE(await sres.text());
    const results = events.filter((e) => e.event === 'result');
    assert.equal(results.length, 1, '应恰有一个 result');
    const streamResult = JSON.parse(results[0].data);
    assert.ok('sceneKey' in streamResult, '流式的 result 事件应带 sceneKey');
    assert.equal(streamResult.scene.draw, true, 'turn=1 应为 draw 回合');
    assert.match(streamResult.sceneKey, KEY_RE, 'draw 回合的 sceneKey 应为 12 位');

    const seen = [{ draw: true, key: streamResult.sceneKey }];
    // 继续 3 个普通回合（turn 2/3/4），逐回合核对 sceneKey 与 scene.draw 的对应。
    for (let t = 2; t <= 4; t++) {
      r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '普通行动' + t });
      assert.equal(r.status, 200, r.text);
      assert.ok('sceneKey' in r.json, '/turn 结果应带 sceneKey');
      const draw = !!(r.json.scene && r.json.scene.draw === true);
      seen.push({ draw, key: r.json.sceneKey });
      if (draw) assert.match(r.json.sceneKey, KEY_RE, `turn=${t} draw 回合应有 12 位 sceneKey`);
      else assert.equal(r.json.sceneKey, null, `turn=${t} 非 draw 回合 sceneKey 应为 null`);
    }
    assert.ok(seen.some((x) => x.draw), '应至少有一个 draw 回合');
    assert.ok(seen.some((x) => !x.draw), '应至少有一个非 draw 回合');
  });
});

test('场景插图：/images 的 scenes 含可见场景（ready + url），撤回后移除', async () => {
  await withServer(async ({ base }) => {
    let r = await req(base, 'POST', '/api/worlds', {
      seed: '插图之城', name: '旅人', appearance: '布衣',
    });
    assert.equal(r.status, 201, r.text);
    const id = r.json.id;

    const drawTurns = [];
    for (let t = 1; t <= 4; t++) {
      r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '行动' + t });
      assert.equal(r.status, 200, r.text);
      if (r.json.scene && r.json.scene.draw === true) drawTurns.push(t);
    }
    assert.ok(drawTurns.length >= 1, '4 回合内应有 draw 回合');

    // scenes 只含 draw 回合，且按 "<life>-<turn>" 作为 key。
    r = await req(base, 'GET', `/api/worlds/${id}/images`);
    assert.equal(r.status, 200, r.text);
    const scenes = r.json.scenes;
    assert.ok(scenes && typeof scenes === 'object', '应返回 scenes 字段');
    assert.deepEqual(Object.values(scenes).map((s) => s.turn).sort((a, b) => a - b),
      drawTurns.slice().sort((a, b) => a - b), 'scenes 只含 draw 回合');

    for (const t of drawTurns) {
      const hit = await waitSceneReady(base, id, t);
      assert.ok(hit, `turn=${t} 场景应变为 ready`);
      assert.equal(hit.status, 'ready');
      assert.ok(hit.url && hit.url.startsWith('/api/images/scene-'),
        `turn=${t} 的 url 应以 /api/images/scene- 开头`);
      assert.ok(Object.prototype.hasOwnProperty.call(scenes, `${hit.life}-${hit.turn}`),
        `scenes 的 key 应为 "<life>-<turn>"`);
    }

    // 撤回最近一回合（turn 4 为 draw），它的场景不再出现在 scenes 里。
    const undo = await req(base, 'POST', `/api/worlds/${id}/undo`, {});
    assert.equal(undo.status, 200, undo.text);
    const undone = undo.json.undoneTurn;
    assert.ok(drawTurns.includes(undone), '被撤回的应是 draw 回合');
    r = await req(base, 'GET', `/api/worlds/${id}/images`);
    const turnsAfter = Object.values(r.json.scenes).map((s) => s.turn);
    assert.equal(turnsAfter.includes(undone), false, '撤回回合的场景不应再出现');
    for (const t of drawTurns.filter((x) => x !== undone)) {
      assert.ok(turnsAfter.includes(t), `turn=${t} 的场景仍应可见`);
    }
  });
});

test('场景插图：/api/me prefs、POST /api/prefs 开关（来客隔离、未登录 401、越权 404）', async () => {
  await withServer(async ({ base, dataDir }) => {
    // 主人 /api/me 默认 scenes:true。
    let r = await req(base, 'GET', '/api/me');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.prefs.scenes, true);

    // 未登录来客访问 /api/prefs → 401（沿用全局访问控制）。
    r = await req(base, 'POST', '/api/prefs', { scenes: false }, asGuest());
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json.login, true);

    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const meA = await guestMe(base, cookieA);
    const meB = await guestMe(base, cookieB);
    assert.notEqual(meA.id, meB.id);
    assert.equal(meA.prefs.scenes, true);
    assert.equal(meB.prefs.scenes, true);

    // A 关掉自己的场景插图，B 不受影响。
    r = await req(base, 'POST', '/api/prefs', { scenes: false }, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { prefs: { scenes: false } });
    assert.equal((await guestMe(base, cookieA)).prefs.scenes, false);
    assert.equal((await guestMe(base, cookieB)).prefs.scenes, true, 'B 的偏好不受 A 影响');

    // A 走到 draw 回合：sceneKey 为 null。
    let a = await req(base, 'POST', '/api/worlds',
      { seed: 'A 的世界', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(a.status, 201, a.text);
    const widA = a.json.id;
    a = await req(base, 'POST', `/api/worlds/${widA}/turn`, { action: 'A 的第一步' }, asGuest(cookieA));
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.scene.draw, true, 'A 的首回合应为 draw');
    assert.equal(a.json.sceneKey, null, 'A 关闭插图后 draw 回合 sceneKey 应为 null');

    // B 走到 draw 回合：仍拿到 12 位 sceneKey。
    let b = await req(base, 'POST', '/api/worlds',
      { seed: 'B 的世界', name: '乙', appearance: '布衣' }, asGuest(cookieB));
    assert.equal(b.status, 201, b.text);
    const widB = b.json.id;
    b = await req(base, 'POST', `/api/worlds/${widB}/turn`, { action: 'B 的第一步' }, asGuest(cookieB));
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.scene.draw, true, 'B 的首回合应为 draw');
    assert.match(b.json.sceneKey, KEY_RE, 'B 未关插图，draw 回合应有 12 位 sceneKey');

    // B 访问 A 的世界 /images 仍 404（不泄露存在）。
    r = await req(base, 'GET', `/api/worlds/${widA}/images`, undefined, asGuest(cookieB));
    assert.equal(r.status, 404, r.text);
    assert.deepEqual(r.json, { error: '世界不存在' });
  }, { IMAGE_SCENE_DAILY_PER_PLAYER: 0 });
});
