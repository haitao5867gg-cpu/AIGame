'use strict';

// 自动启动 Cloudflare 临时隧道（cloudflared tunnel --url http://localhost:<port>），
// 让朋友能用访问密码访问本机服务。零第三方依赖，风格与 src/imgsupervisor.js 一致。
// 关键约束：没有访问密码绝不启动隧道；TUNNEL=off / LLM_MOCK / 找不到 cloudflared 都不启动。

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000; // 退避最长 5 分钟
const RESTART_WINDOW_MS = 60 * 60 * 1000; // 一小时内
const MAX_RESTARTS_PER_HOUR = 6;
const EXE_WIN = 'cloudflared.exe';
const EXE_UNIX = 'cloudflared';

// 同一「不启动原因」只写一行日志（进程内去重），避免刷屏。
const skipLogged = new Set();
function skip(reason) {
  if (!skipLogged.has(reason)) {
    skipLogged.add(reason);
    console.warn('[tunnel] 不启动临时隧道：' + reason);
  }
  return null;
}

function isMock(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

// 从 cloudflared 的一行日志里提取第一个 trycloudflare.com 网址；普通日志行返回 null。
function parseTunnelUrl(line) {
  const m = URL_RE.exec(String(line == null ? '' : line));
  return m ? m[0] : null;
}

function entryName(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  return String(e.name || '');
}

// 纯函数：按优先级返回第一个存在的 cloudflared 可执行文件完整路径；都没有返回 null。
// env 是 process.env 风格对象；fsLike 需含 existsSync / readdirSync（均可注入便于测试）。
function findCloudflared(cfg, env, fsLike) {
  const e = env || {};
  const f = fsLike || fs;
  const exists = typeof f.existsSync === 'function' ? f.existsSync : () => false;
  const readdir = typeof f.readdirSync === 'function' ? f.readdirSync : () => [];
  const c = cfg || {};
  const candidates = [];

  // 1) 显式配置的路径优先。
  const configured = String(c.CLOUDFLARED_PATH || '').trim().replace(/^["']|["']$/g, '');
  if (configured) candidates.push(configured);

  // 2) PATH 里每个目录：Windows 是 cloudflared.exe，Unix 是 cloudflared；两个名字都查更稳。
  const dirs = String(e.PATH || e.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    candidates.push(path.join(dir, EXE_WIN));
    candidates.push(path.join(dir, EXE_UNIX));
  }

  // 3) Windows 常见安装位置（对应环境变量缺失时自然跳过）。
  const programFiles = e.ProgramFiles || e.PROGRAMFILES;
  const programFilesX86 = e['ProgramFiles(x86)'] || e['PROGRAMFILES(X86)'];
  const localAppData = e.LOCALAPPDATA || e.LocalAppData;
  if (programFiles) candidates.push(path.join(programFiles, 'cloudflared', EXE_WIN));
  if (programFilesX86) candidates.push(path.join(programFilesX86, 'cloudflared', EXE_WIN));
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Links', EXE_WIN));
    // WinGet Packages 下以 Cloudflare.cloudflared 开头的目录，readdirSync 扫一层。
    const pkgDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    let entries = [];
    try { entries = readdir(pkgDir) || []; } catch (_) { entries = []; }
    for (const ent of entries) {
      const name = entryName(ent);
      if (/^cloudflare\.cloudflared/i.test(name)) {
        candidates.push(path.join(pkgDir, name, EXE_WIN));
      }
    }
  }

  for (const p of candidates) {
    try { if (p && exists(p)) return p; } catch (_) { /* 忽略无权限等异常 */ }
  }
  return null;
}

function startTunnel(cfg, opts) {
  const o = opts || {};
  const c = cfg || {};

  // ---- 不启动的几种情况（同一原因只写一行日志）----
  if (String(c.TUNNEL || '').toLowerCase() === 'off') return skip('TUNNEL=off');
  if (isMock(c.LLM_MOCK)) return skip('LLM_MOCK 模式');
  const hasPassword = typeof o.hasPassword === 'function' ? o.hasPassword : () => false;
  if (!hasPassword()) return skip('没有访问密码');

  const port = o.port;
  const doSpawn = o.spawn || spawn;
  const doSetTimeout = o.setTimeout || setTimeout;
  const doClearTimeout = o.clearTimeout || clearTimeout;
  const proc = o.process || process;
  const envObj = o.env || process.env;
  const fsLike = {
    existsSync: o.exists || fs.existsSync,
    readdirSync: o.readdirSync || fs.readdirSync,
  };

  const exe = findCloudflared(c, envObj, fsLike);
  if (!exe) return skip('找不到 cloudflared（可配置 CLOUDFLARED_PATH）');

  let currentUrl = null;
  let child = null;
  let restartTimer = null;
  let active = true;
  const restartTimes = []; // 一小时内已排定的重启时间

  function handleLine(line) {
    if (currentUrl) return; // 只取第一个网址
    const url = parseTunnelUrl(line);
    if (!url) return;
    currentUrl = url;
    console.log('[tunnel] 朋友链接：' + url);
  }

  // 逐行读 stdout / stderr（cloudflared 把日志写在 stderr）；子进程已结束时其流不再处理。
  function watchStream(stream, c) {
    if (!stream || typeof stream.on !== 'function') return;
    let buf = '';
    const flush = () => {
      if (child !== c) { buf = ''; return; }
      if (buf) { handleLine(buf); buf = ''; }
    };
    stream.on('data', (chunk) => {
      if (child !== c) return;
      buf += Buffer.from(chunk).toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    });
    stream.on('end', flush);
    stream.on('close', flush);
  }

  function endChild(c, reason) {
    if (child !== c) return; // 忽略旧子进程 / stop 之后的事件
    child = null;
    currentUrl = null;
    console.warn('[tunnel] cloudflared 已退出：' + reason + '，准备自动重启');
    scheduleRestart();
  }

  function spawnChild() {
    if (!active) return;
    let c;
    try {
      c = doSpawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.warn('[tunnel] 启动 cloudflared 失败：' + (err && err.message ? err.message : err));
      scheduleRestart();
      return;
    }
    child = c;
    if (c && typeof c.on === 'function') {
      c.on('exit', (code, signal) => endChild(c, `code=${code}${signal ? ' signal=' + signal : ''}`));
      c.on('error', (err) => endChild(c, 'error=' + (err && err.message ? err.message : err)));
    }
    watchStream(c && c.stdout, c);
    watchStream(c && c.stderr, c);
    console.log('[tunnel] 已启动 cloudflared：' + exe);
  }

  function scheduleRestart() {
    if (!active) return;
    const now = Date.now();
    while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
    if (restartTimes.length >= MAX_RESTARTS_PER_HOUR) {
      active = false;
      console.warn('[tunnel] 一小时内已重启 6 次，停止自动重启');
      return;
    }
    // 退避 5s、10s、20s、40s… 最长 5 分钟。
    const delay = Math.min(BACKOFF_BASE_MS * (2 ** restartTimes.length), BACKOFF_MAX_MS);
    restartTimes.push(now);
    const t = doSetTimeout(() => {
      restartTimer = null;
      if (active) spawnChild();
    }, delay);
    restartTimer = t;
    if (t && typeof t.unref === 'function') t.unref(); // 计时器不阻止进程退出
  }

  function onProcessExit() {
    if (child && typeof child.kill === 'function') {
      try { child.kill(); } catch (_) { /* ignore */ }
    }
  }
  // 服务退出时一并结束子进程（不 detached）。
  if (proc && typeof proc.on === 'function') proc.on('exit', onProcessExit);

  spawnChild();

  return {
    url() { return currentUrl; },
    stop() {
      if (!active && !child && !restartTimer) return;
      active = false;
      if (restartTimer) {
        doClearTimeout(restartTimer);
        restartTimer = null;
      }
      const c = child;
      child = null;
      currentUrl = null;
      if (c && typeof c.kill === 'function') {
        try { c.kill(); } catch (_) { /* ignore */ }
      }
      if (proc && typeof proc.removeListener === 'function') proc.removeListener('exit', onProcessExit);
    },
  };
}

module.exports = { startTunnel, findCloudflared, parseTunnelUrl };
