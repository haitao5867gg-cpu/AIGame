'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const { createHttpServer } = require('../server.js');

const SECRET = 'sk-API-SECRET-DO-NOT-LEAK';

function containsKey(obj, target) {
  if (!obj || typeof obj !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(obj, target)) return true;
  return Object.values(obj).some((v) => containsKey(v, target));
}

function assertNoLeak(text, json) {
  assert.equal(text.includes(SECRET), false, '响应不应含 API Key 值');
  assert.equal(text.includes('LLM_API_KEY'), false, '响应不应含 Key 字段');
  assert.equal(/"apex"\s*:/.test(text), false, '响应不应含 apex 字段');
  // 导演转折只进 events.jsonl，绝不出现在任何公开响应里。
  assert.equal(/"twist"\s*:/.test(text), false, '响应不应含 twist 字段');
  for (const tw of ['闯入者', '意外发现', '背叛', '环境突变', '旧识出现', '时机错过', '交易反转']) {
    assert.equal(text.includes(tw), false, `响应不应泄露转折词「${tw}」`);
  }
  if (json && typeof json === 'object') {
    assert.equal(containsKey(json, 'apex'), false);
    assert.equal(containsKey(json, 'twist'), false);
    assert.equal(containsKey(json, 'LLM_API_KEY'), false);
  }
}

async function req(base, method, pathname, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(base + pathname, opts);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 静态页等非 JSON */ }
  return { status: resp.status, text, json };
}

// 随机端口起服务；显式设置 LLM_MOCK=1 与临时 DATA_DIR。
async function withServer(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-api-'));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = SECRET;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  const cfg = env.getConfig();
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

test('接口层：随机端口测各接口，公开状态不含 apex 与 Key', async () => {
  await withServer(async ({ base, dataDir }) => {
    // health
    let r = await req(base, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.mock, true);
    assert.equal(typeof r.json.model, 'string');
    assertNoLeak(r.text, r.json);

    // worlds 列表（初始为空）
    r = await req(base, 'GET', '/api/worlds');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assertNoLeak(r.text, r.json);

    // 建世界
    r = await req(base, 'POST', '/api/worlds', {
      seed: '黄沙覆盖的机械圣城',
      name: '旅人',
      appearance: '灰袍',
    });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.id);
    assert.ok(r.json.bible && r.json.bible.eventThemes.length === 6);
    assert.equal('apex' in r.json, false);
    assertNoLeak(r.text, r.json);
    const id = r.json.id;

    // 取世界
    r = await req(base, 'GET', `/api/worlds/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.id, id);
    assert.equal('apex' in r.json, false);
    assert.equal(typeof r.json.omen, 'boolean', '公开状态应含 omen 布尔');
    assert.ok(Array.isArray(r.json.rumors), '公开状态应含 rumors 数组');
    assert.equal(typeof r.json.location, 'string', '公开状态应含 location');
    assert.ok(r.json.clock && typeof r.json.clock.day === 'number', '公开状态应含 clock');
    assert.ok(Array.isArray(r.json.pastLives), '公开状态应含 pastLives 数组');
    assert.ok(Array.isArray(r.json.facts), '公开状态应含 facts 数组');
    assert.ok(Array.isArray(r.json.threads), '公开状态应含 threads 数组');
    assert.ok(Array.isArray(r.json.fadedThreads), '公开状态应含 fadedThreads 数组');
    assert.ok(Array.isArray(r.json.character.marks), '公开状态应含 character.marks 数组');
    assert.equal('pendingEventTheme' in r.json, false, '公开状态不得含预选主题');
    assertNoLeak(r.text, r.json);

    // 同一世界并发两个回合 → 串行，turn 依次 1、2
    const [c1, c2] = await Promise.all([
      req(base, 'POST', `/api/worlds/${id}/turn`, { action: '并发甲' }),
      req(base, 'POST', `/api/worlds/${id}/turn`, { action: '并发乙' }),
    ]);
    assert.equal(c1.status, 200, c1.text);
    assert.equal(c2.status, 200, c2.text);
    const seq = [c1.json.state.turn, c2.json.state.turn].sort((a, b) => a - b);
    assert.deepEqual(seq, [1, 2]);
    assertNoLeak(c1.text, c1.json);
    assertNoLeak(c2.text, c2.json);

    // 连续回合：跨过事件开启 + 结算
    let sawEvent = false;
    let sawSettlement = false;
    for (let i = 0; i < 14; i++) {
      r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: `第${i + 3}回合，沿街探查` });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.narration && r.json.narration.length >= 10);
      assert.ok(r.json.state);
      assert.equal('apex' in r.json.state, false);
      assertNoLeak(r.text, r.json);
      if (r.json.event) sawEvent = true;
      if (r.json.settlement) sawSettlement = true;
    }
    assert.ok(sawEvent, '应经历事件开启');
    assert.ok(sawSettlement, '应经历事件结算');

    // log：最近 N 条，只返回公开字段，绝不含 apex / raw / proposal / rejected / usage
    r = await req(base, 'GET', `/api/worlds/${id}/log?limit=50`);
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length > 0, '应返回已产生的回合记录');
    for (const item of r.json) {
      assert.equal(typeof item.turn, 'number');
      assert.equal(typeof item.action, 'string');
      assert.equal(typeof item.narration, 'string');
      assert.ok(Array.isArray(item.badges));
      for (const hidden of ['apex', 'raw', 'proposal', 'rejected', 'usage']) {
        assert.equal(hidden in item, false, `log 不应含内部字段 ${hidden}`);
      }
    }
    assertNoLeak(r.text, r.json);

    r = await req(base, 'GET', `/api/worlds/${id}/log?limit=2`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.length, 2, 'limit=2 应只返回 2 条');

    r = await req(base, 'GET', `/api/worlds/${id}/log?limit=abc`);
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json), '非法 limit 回退默认，不报错');

    r = await req(base, 'GET', '/api/worlds/does-not-exist/log');
    assert.equal(r.status, 404, '不存在世界的 log 应 404');
    assertNoLeak(r.text, r.json);

    // usage
    r = await req(base, 'GET', '/api/usage');
    assert.equal(r.status, 200);
    assert.ok(r.json.cumulative.total > 0);
    assert.ok(r.json.today.total > 0);
    assertNoLeak(r.text, r.json);

    // rebirth：直接把内部状态置为等待重生，测 409 → 重生 → 回合
    const state = store.loadWorld(dataDir, id);
    state.awaitingRebirth = true;
    state.character.alive = false;
    state.life = 2;
    store.saveWorld(dataDir, state);

    r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '继续' });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error, /重生/);
    assertNoLeak(r.text, r.json);

    r = await req(base, 'POST', `/api/worlds/${id}/rebirth`, {
      name: '二世旅人', appearance: '红衣',
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.character.alive, true);
    assert.equal(r.json.character.name, '二世旅人');
    assert.equal('apex' in r.json, false);
    assertNoLeak(r.text, r.json);

    r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '重生后第一步' });
    assert.equal(r.status, 200, r.text);
    assertNoLeak(r.text, r.json);

    // 404 / 非法 ID
    r = await req(base, 'GET', '/api/worlds/does-not-exist');
    assert.equal(r.status, 404);
    assertNoLeak(r.text, r.json);
    r = await req(base, 'GET', '/api/nope');
    assert.equal(r.status, 404);
    assertNoLeak(r.text, r.json);

    // 静态首页
    r = await req(base, 'GET', '/');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('无限世界'));
    assert.equal(r.text.includes(SECRET), false);

    // 删除 → 移入 _trash，之后不可访问、列表不再含
    r = await req(base, 'DELETE', `/api/worlds/${id}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.deleted, true);
    assertNoLeak(r.text, r.json);

    r = await req(base, 'GET', `/api/worlds/${id}`);
    assert.equal(r.status, 404);
    r = await req(base, 'GET', '/api/worlds');
    assert.equal(r.status, 200);
    assert.equal(r.json.some((w) => w.id === id), false);

    // 回收站内容仍在（数据只追加不删除语义下的「软删除」）
    const trash = path.join(dataDir, '_trash');
    assert.ok(fs.existsSync(trash));
  });
});
