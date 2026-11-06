'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../../src/env.js');
const store = require('../../src/store.js');
const { createHttpServer, createBackup, BACKUP_KEEP } = require('../../server.js');

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

async function req(base, method, pathname, body, headers, extra) {
  const opts = Object.assign({ method: method, headers: Object.assign({}, headers || {}) }, extra || {});
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(base + pathname, opts);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 静态页等非 JSON */ }
  return { status: resp.status, text, json, headers: resp.headers };
}

// 模拟经 Cloudflare 隧道进来的「公网来客」：带 cf-ray 头，必要时带登录 cookie。
function asGuest(cookie) {
  const h = { 'cf-ray': 'test-ray' };
  if (cookie) h.cookie = cookie;
  return h;
}

function readAccessPassword(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8')).password;
}

// 用 access.json 里的密码登录一个来客，返回可用的 cookie。
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

// 把 text/event-stream 文本解析成 [{event, data}]。
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

// 随机端口起服务；显式设置 LLM_MOCK=1 与临时 DATA_DIR。
// cfgOverrides 可覆盖个别配置（默认强制 ACCESS_PASSWORD='' 走自动生成，保证测试稳定）。
async function withServer(fn, cfgOverrides) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-api-'));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = SECRET;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  const cfg = Object.assign(env.getConfig(), { ACCESS_PASSWORD: '' }, cfgOverrides || {});
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

function seedUsage(dataDir, now) {
  const day = 24 * 3600 * 1000;
  const rows = [
    { ts: now - 1000, model: 'm', purpose: 'turn', prompt_tokens: 100, completion_tokens: 20, ok: true },
    { ts: now - 2000, model: 'm', purpose: 'turn', prompt_tokens: 50, completion_tokens: 5, ok: true },
    { ts: now - 2 * day, model: 'm', purpose: 'turn', prompt_tokens: 9999, completion_tokens: 9999, ok: true },
    { ts: now - 3000, kind: 'image', provider: 'siliconflow', model: 'Kwai-Kolors/Kolors', ok: true, ms: 5000 },
    { ts: now - 4000, kind: 'image', provider: 'siliconflow', model: 'Kwai-Kolors/Kolors', ok: true, ms: 5000 },
    { ts: now - 5000, kind: 'image', provider: 'zhipu', model: 'cogview-3-flash', ok: true, ms: 9000 },
    { ts: now - 6000, kind: 'image', provider: 'local', model: 'local', ok: false, ms: 60000 },
    { ts: now - 2 * day, kind: 'image', provider: 'zhipu', model: 'cogview-3-flash', ok: false, ms: 1 },
  ];
  fs.writeFileSync(store.usagePath(dataDir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

module.exports = { SECRET, containsKey, assertNoLeak, req, asGuest, readAccessPassword, loginGuest, guestMe, parseSSE, postStream, withServer, seedUsage };
