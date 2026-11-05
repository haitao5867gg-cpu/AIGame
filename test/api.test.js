'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const { createHttpServer, createBackup, BACKUP_KEEP } = require('../server.js');

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
    assert.equal(typeof r.json.danger, 'boolean', '公开状态应含 danger 布尔');
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

test('接口层 /turn/stream：mock 下多个 delta + 一个 result，result 不含 apex，原 /turn 不变', async () => {
  await withServer(async ({ base }) => {
    let r = await req(base, 'POST', '/api/worlds', {
      seed: '流式钟声之城', name: '旅人', appearance: '灰袍',
    });
    assert.equal(r.status, 201, r.text);
    const id = r.json.id;

    const resp = await postStream(base, id, { action: '流式行动' });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /text\/event-stream/);
    const events = parseSSE(await resp.text());

    const deltas = events.filter((e) => e.event === 'delta');
    const results = events.filter((e) => e.event === 'result');
    assert.ok(deltas.length >= 2, `应收到多个 delta，实际 ${deltas.length}`);
    let narr = '';
    for (const d of deltas) {
      const obj = JSON.parse(d.data);
      assert.equal(typeof obj.text, 'string');
      narr += obj.text;
    }
    assert.equal(results.length, 1, '应恰有一个 result');
    const result = JSON.parse(results[0].data);
    // result 形状与普通 /turn 完全一致，且叙事等于所有 delta 的拼接。
    assert.equal(result.narration, narr);
    assert.ok(result.state && typeof result.state.turn === 'number');
    assert.ok(Array.isArray(result.suggestions));
    assertNoLeak(results[0].data, result);

    // 原 /turn 接口保留不变，且回合同步推进。
    const normal = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '普通行动' });
    assert.equal(normal.status, 200, normal.text);
    assert.equal(normal.json.state.turn, 2);
    assertNoLeak(normal.text, normal.json);

    // 错误路径：不存在的世界 → event: error（中文说明），而非 result。
    const errResp = await postStream(base, 'w-not-exist', { action: '继续' });
    const errEvents = parseSSE(await errResp.text());
    const errEvt = errEvents.find((e) => e.event === 'error');
    assert.ok(errEvt, '应返回 event: error');
    assert.equal(typeof JSON.parse(errEvt.data).error, 'string');
    assert.ok(JSON.parse(errEvt.data).error.length > 0);
  });
});

test('接口层 /export：下载 state（去 apex）+ events 公开字段，带附件头', async () => {
  await withServer(async ({ base, dataDir }) => {
    let r = await req(base, 'POST', '/api/worlds', {
      seed: '导出用世界', name: '旅人', appearance: '青衣',
    });
    const id = r.json.id;
    for (let i = 0; i < 2; i++) {
      r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '探查' + i });
      assert.equal(r.status, 200, r.text);
    }

    const resp = await fetch(base + `/api/worlds/${id}/export`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-disposition') || '', /attachment/);
    assert.match(resp.headers.get('content-type') || '', /application\/json/);
    const text = await resp.text();
    const data = JSON.parse(text);
    assert.ok(data.state && typeof data.state === 'object');
    assert.ok(Array.isArray(data.events));
    assert.equal(data.events.length, 2, '应含已产生的 2 条公开回合记录');
    assert.equal('apex' in data.state, false);
    assertNoLeak(text, data);
    for (const e of data.events) {
      for (const hidden of ['apex', 'raw', 'proposal', 'rejected', 'usage', 'twist']) {
        assert.equal(hidden in e, false, `导出事件不应含内部字段 ${hidden}`);
      }
    }
    // 导出只读：内部存档仍保留 apex，未被改动。
    assert.ok(store.loadWorld(dataDir, id).apex);

    const nf = await fetch(base + '/api/worlds/w-nope/export');
    assert.equal(nf.status, 404, '不存在世界的导出应 404');
  });
});

test('备份轮转：启动备份复制 worlds，只保留最近 7 份，更旧的删除；失败只告警', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-backup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // dataDir 放在 tmp/data，则 dataDir/../backups == tmp/backups，隔离在本次测试目录内。
  const dataDir = path.join(tmp, 'data');
  const worlds = path.join(dataDir, 'worlds');
  fs.mkdirSync(path.join(worlds, 'w1'), { recursive: true });
  fs.writeFileSync(path.join(worlds, 'w1', 'state.json'), JSON.stringify({ id: 'w1', turn: 5 }));
  const backups = path.join(tmp, 'backups');

  const originalWarn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    // 10 次「启动」（秒递增）→ 只留最近 7 份。
    for (let i = 0; i < 10; i++) {
      const dest = createBackup(dataDir, new Date(2026, 10, 5, 12, 0, i));
      assert.ok(dest, '正常备份应返回目标路径');
    }
    const dirs = fs.readdirSync(backups)
      .filter((d) => /^\d{8}-\d{6}$/.test(d))
      .sort();
    assert.equal(dirs.length, BACKUP_KEEP, '应只保留最近 7 份');
    assert.deepEqual(dirs, [
      '20261105-120003', '20261105-120004', '20261105-120005',
      '20261105-120006', '20261105-120007', '20261105-120008', '20261105-120009',
    ]);
    // 更旧的（秒 0/1/2）已删除。
    for (const s of ['20261105-120000', '20261105-120001', '20261105-120002']) {
      assert.equal(fs.existsSync(path.join(backups, s)), false, `${s} 应已删除`);
    }
    // 备份内容确实复制了整个 worlds（直接含世界目录与 state.json）。
    const kept = path.join(backups, dirs[dirs.length - 1]);
    assert.ok(fs.existsSync(path.join(kept, 'w1', 'state.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(kept, 'w1', 'state.json'), 'utf8')).turn, 5);
    assert.equal(warns.length, 0, '正常情况不应告警');

    // 失败场景：worlds 不存在时只告警、不抛错、不影响「启动」。
    const failWarns = [];
    console.warn = (m) => failWarns.push(String(m));
    let ret;
    assert.doesNotThrow(() => {
      ret = createBackup(path.join(tmp, 'emptydata'), new Date(2026, 10, 5, 13, 0, 0));
    });
    assert.equal(ret, null);
    assert.ok(failWarns.length >= 1, '失败应产生告警');
    assert.ok(failWarns[0].includes('备份失败'));
  } finally {
    console.warn = originalWarn;
  }
});
