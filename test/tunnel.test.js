'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const { createHttpServer } = require('../server.js');
const { startTunnel, findCloudflared, parseTunnelUrl } = require('../src/tunnel.js');

const LOG_LINE = '2026-11-06T05:00:00Z INF |  https://foo-bar-baz.trycloudflare.com                                          |';
const URL = 'https://foo-bar-baz.trycloudflare.com';

// 捕获测试期间的 console 输出，避免污染测试日志，并用于断言「写一行日志」。
function silence() {
  const logs = [];
  const warns = [];
  const ol = console.log;
  const ow = console.warn;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  return {
    logs, warns,
    restore() { console.log = ol; console.warn = ow; },
  };
}

// 假子进程：EventEmitter + stdout/stderr 流 + kill，绝不启动真实进程。
function makeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = false;
  c.kill = () => { c.killed = true; };
  return c;
}

// 组装可注入的 startTunnel 选项，返回隧道句柄和观测数据。
function harness(cfg, over) {
  const spawned = [];
  const timers = [];
  const opts = Object.assign({
    port: 8787,
    hasPassword: () => true,
    exists: () => true,
    env: {},
    process: new EventEmitter(),
    spawn: (exe, args, options) => {
      const child = makeChild();
      spawned.push({ exe, args, options, child });
      return child;
    },
    setTimeout: (fn, delay) => {
      const t = { fn, delay, unrefCalled: false, unref() { this.unrefCalled = true; return this; }, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  }, over || {});
  const result = startTunnel(cfg, opts);
  return { result, spawned, timers, opts };
}

const OK_CFG = { TUNNEL: 'on', LLM_MOCK: false, CLOUDFLARED_PATH: '/fake/cloudflared' };

// ---- 纯函数：parseTunnelUrl ----
test('parseTunnelUrl：从 cloudflared 真实格式日志行提取网址，普通行返回 null', () => {
  assert.equal(parseTunnelUrl(LOG_LINE), URL);
  assert.equal(parseTunnelUrl('2026-11-06T05:00:00Z INF Starting tunnel'), null);
  assert.equal(parseTunnelUrl('2026-11-06T05:00:00Z ERR failed to connect'), null);
  assert.equal(parseTunnelUrl(''), null);
  assert.equal(parseTunnelUrl(null), null);
});

// ---- 纯函数：findCloudflared ----
test('findCloudflared：CLOUDFLARED_PATH 优先', () => {
  const cfg = { CLOUDFLARED_PATH: '/custom/bin/cloudflared' };
  const pathMatch = path.join('/usr', 'bin', 'cloudflared');
  // PATH 里也有一个存在，但显式配置排在最前，应被优先选中。
  const fsLike = {
    existsSync: (p) => p === cfg.CLOUDFLARED_PATH || p === pathMatch,
    readdirSync: () => [],
  };
  assert.equal(findCloudflared(cfg, { PATH: '/usr' + path.sep + 'bin' }, fsLike), cfg.CLOUDFLARED_PATH);
});

test('findCloudflared：PATH 里找到', () => {
  const dir = path.join(path.sep, 'opt', 'bin');
  const existing = path.join(dir, 'cloudflared');
  const fsLike = { existsSync: (p) => p === existing, readdirSync: () => [] };
  const p = [dir, path.join(path.sep, 'usr', 'bin')].join(path.delimiter);
  assert.equal(findCloudflared({}, { PATH: p }, fsLike), existing);
});

test('findCloudflared：Windows 安装位置（Program Files / WinGet Links / WinGet Packages 扫描）找到', () => {
  const pf = 'C:\\Program Files';
  const pf86 = 'C:\\Program Files (x86)';
  const la = 'C:\\Users\\me\\AppData\\Local';
  const pkgDir = path.join(la, 'Microsoft', 'WinGet', 'Packages');
  const pkgName = 'Cloudflare.cloudflared_2026.1.0__win';
  const env = { PATH: '', ProgramFiles: pf, 'ProgramFiles(x86)': pf86, LOCALAPPDATA: la };

  const pfExe = path.join(pf, 'cloudflared', 'cloudflared.exe');
  const pf86Exe = path.join(pf86, 'cloudflared', 'cloudflared.exe');
  const linksExe = path.join(la, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe');
  const pkgExe = path.join(pkgDir, pkgName, 'cloudflared.exe');
  const scan = (d) => (d === pkgDir ? [pkgName] : []);

  for (const target of [pfExe, pf86Exe, linksExe, pkgExe]) {
    const fsLike = { existsSync: (p) => p === target, readdirSync: scan };
    assert.equal(findCloudflared({}, env, fsLike), target, `应找到 ${target}`);
  }
});

test('findCloudflared：都没有返回 null', () => {
  const fsLike = { existsSync: () => false, readdirSync: () => [] };
  assert.equal(findCloudflared({}, { PATH: path.join(path.sep, 'usr', 'bin') }, fsLike), null);
  assert.equal(findCloudflared({ CLOUDFLARED_PATH: '/nope/cloudflared' }, {}, fsLike), null);
});

// ---- startTunnel：不启动的情况 ----
test('startTunnel：TUNNEL=off 不启动', () => {
  const cap = silence();
  try {
    const { result, spawned } = harness({ TUNNEL: 'off', LLM_MOCK: false });
    assert.equal(result, null);
    assert.equal(spawned.length, 0, '不应调用 spawn');
  } finally { cap.restore(); }
});

test('startTunnel：LLM_MOCK 不启动', () => {
  const cap = silence();
  try {
    const { result, spawned } = harness({ TUNNEL: 'on', LLM_MOCK: true });
    assert.equal(result, null);
    assert.equal(spawned.length, 0, '不应调用 spawn');
  } finally { cap.restore(); }
});

test('startTunnel：hasPassword() 为 false 不启动', () => {
  const cap = silence();
  try {
    const { result, spawned } = harness({ TUNNEL: 'on', LLM_MOCK: false }, { hasPassword: () => false });
    assert.equal(result, null);
    assert.equal(spawned.length, 0, '不应调用 spawn');
  } finally { cap.restore(); }
});

test('startTunnel：找不到 cloudflared 不启动', () => {
  const cap = silence();
  try {
    const { result, spawned } = harness({ TUNNEL: 'on', LLM_MOCK: false }, { exists: () => false });
    assert.equal(result, null);
    assert.equal(spawned.length, 0, '不应调用 spawn');
  } finally { cap.restore(); }
});

// ---- startTunnel：正常启动 / 网址解析 / 重启退避 / stop ----
test('startTunnel 正常：网址解析 / spawn 参数 / exit 清空网址并按退避排重启', () => {
  const cap = silence();
  let h;
  try {
    h = harness(OK_CFG);
    const { result, spawned, timers } = h;
    assert.ok(result && typeof result.url === 'function' && typeof result.stop === 'function');
    assert.equal(spawned.length, 1, '应 spawn 一次');
    const s = spawned[0];
    assert.match(s.exe, /cloudflared/);
    assert.ok(s.args.includes('tunnel'));
    assert.ok(s.args.includes('--no-autoupdate'));
    assert.ok(s.args.includes('--url'));
    assert.ok(s.args.includes('http://localhost:8787'));
    assert.equal(s.options.windowsHide, true);
    assert.deepEqual(s.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(result.url(), null, '启动初期尚无网址');

    // cloudflared 把日志写在 stderr：推一行含网址的真实格式日志。
    s.child.stderr.emit('data', Buffer.from(LOG_LINE + '\n'));
    assert.equal(result.url(), URL);
    assert.ok(cap.logs.some((l) => l.includes('朋友链接') && l.includes(URL)));
    assert.ok(cap.logs.some((l) => l.includes('已启动 cloudflared')));

    // 子进程退出：清空网址、warn 一行、按 5s 退避排重启计时器（unref，不真等待）。
    s.child.emit('exit', 1, null);
    assert.equal(result.url(), null, '退出后网址清空');
    assert.ok(cap.warns.some((w) => w.includes('已退出')));
    assert.equal(timers.length, 1, '应排一次重启');
    assert.equal(timers[0].delay, 5000);
    assert.equal(timers[0].unrefCalled, true, '重启计时器应 unref');

    // 触发重启 → 第二次 spawn；第二次退出 → 退避翻倍到 10s。
    timers[0].fn();
    assert.equal(spawned.length, 2, '应重启 spawn 第二次');
    spawned[1].child.emit('exit', 1, null);
    assert.equal(timers.length, 2);
    assert.equal(timers[1].delay, 10000);
    assert.equal(timers[1].unrefCalled, true);
  } finally {
    if (h && h.result) h.result.stop();
    cap.restore();
  }
});

test('startTunnel stop()：kill 当前子进程、清空网址、之后不再重启', () => {
  const cap = silence();
  let h;
  try {
    h = harness(OK_CFG);
    const { result, spawned, timers } = h;
    const child = spawned[0].child;
    child.stderr.emit('data', Buffer.from('INF ' + URL + '\n'));
    assert.equal(result.url(), URL);

    result.stop();
    assert.equal(child.killed, true, 'stop 应 kill 子进程');
    assert.equal(result.url(), null, 'stop 后网址清空');

    // stop 后再触发 exit：不再排重启、不再写退出告警。
    child.emit('exit', 0, null);
    assert.equal(timers.length, 0, 'stop 后不应再排重启');
    assert.equal(cap.warns.some((w) => w.includes('已退出')), false, 'stop 后不应再写退出告警');
    assert.doesNotThrow(() => result.stop(), '重复 stop 应安全');
  } finally {
    cap.restore();
  }
});

test('startTunnel：一小时内最多重启 6 次，超出停止自动重启', () => {
  const cap = silence();
  let h;
  try {
    h = harness(OK_CFG);
    const { result, spawned, timers } = h;
    // 连续 6 次「退出 → 触发计时器 → spawn 新子进程 → 退出」。
    for (let i = 0; i < 6; i++) {
      spawned[i].child.emit('exit', 1, null);
      timers[i].fn();
    }
    assert.equal(spawned.length, 7, '共 6 次重启，spawn 共 7 次');
    // 第 7 次退出：达到上限，停止自动重启（不再排新计时器）。
    spawned[6].child.emit('exit', 1, null);
    assert.equal(timers.length, 6, '达到上限后不再排重启');
    assert.ok(cap.warns.some((w) => w.includes('一小时内已重启 6 次')));
    assert.equal(result.url(), null);
  } finally {
    if (h && h.result) h.result.stop();
    cap.restore();
  }
});

// ---- api：主人 / 来客的 tunnel 字段 ----
test('api：主人 /api/usage/today 有 tunnel 字段（无隧道时 url 为 null），来客没有', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-tunnel-api-'));
  const keys = { LLM_MOCK: '1', DATA_DIR: tmp, PORT: '0', HOST: '127.0.0.1' };
  const prev = {};
  for (const k of Object.keys(keys)) { prev[k] = process.env[k]; process.env[k] = keys[k]; }
  const cfg = Object.assign(env.getConfig(), { ACCESS_PASSWORD: '' });
  const server = createHttpServer(cfg);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const host = await (await fetch(base + '/api/usage/today')).json();
    assert.ok(host.tunnel, '主人响应应含 tunnel');
    assert.equal(host.tunnel.url, null, '未启动隧道时 url 为 null');
    assert.ok(host.access, '主人响应应含 access');

    const pw = JSON.parse(fs.readFileSync(path.join(tmp, 'access.json'), 'utf8')).password;
    const login = await fetch(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-ray': 'test-ray' },
      body: JSON.stringify({ password: pw, name: '朋友' }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const guestText = await (await fetch(base + '/api/usage/today', {
      headers: { 'cf-ray': 'test-ray', cookie },
    })).text();
    const guest = JSON.parse(guestText);
    for (const f of ['tunnel', 'access', 'global', 'players']) {
      assert.equal(f in guest, false, `来客响应不应含 ${f}`);
    }
    assert.equal(guestText.includes(pw), false, '来客响应全文不得含访问密码');
  } finally {
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(resolve);
    });
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
