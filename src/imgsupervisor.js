'use strict';

// Keeps the local GPU image server (scripts/imgserver.py) running while the game server runs.
// Active only when IMAGE_PROVIDER=local and IMAGE_LOCAL_PYTHON points at a Python interpreter.
// Every 30 s it asks /health; it starts the image server only when nothing answers, so a copy
// left over from a previous game-server run keeps serving (no model reload on redeploy).

const os = require('node:os');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHECK_MS = 30000;
const START_GRACE_MS = 120000; // loading SDXL takes 20~50 s; don't start a second copy meanwhile
const MAX_STARTS_PER_HOUR = 3;
// The SDXL server peaks at ~5.7 GB of RAM while loading. Never start it on a
// machine that is short of memory: on 2026-11-06 it starved the 16 GB home PC.
const DEFAULT_MIN_FREE_MB = 7000;

function healthUrlOf(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '') + '/health';
}

function startImageSupervisor(cfg, opts) {
  const o = opts || {};
  const py = cfg && cfg.IMAGE_LOCAL_PYTHON;
  if (!cfg || cfg.IMAGE_PROVIDER !== 'local' || !py) return null;
  const root = path.join(__dirname, '..');
  const script = path.join(root, 'scripts', 'imgserver.py');
  const logFile = path.join(root, 'logs', 'imgserver.log');
  const healthUrl = healthUrlOf(cfg.IMAGE_BASE_URL);
  const doFetch = o.fetch || fetch;
  const doSpawn = o.spawn || spawn;
  let child = null;
  let startedAt = 0;
  const starts = [];
  let lastSkipLog = 0;
  const freeMb = o.freeMb || (() => os.freemem() / 1048576);
  const minFree = Number(cfg.IMAGE_LOCAL_MIN_FREE_MB) || DEFAULT_MIN_FREE_MB;

  function skip(msg) {
    if (Date.now() - lastSkipLog > 600000) {
      lastSkipLog = Date.now();
      console.warn('[images] 不启动本地画图服务：' + msg);
    }
  }

  async function alive() {
    try {
      const r = await doFetch(healthUrl, { signal: AbortSignal.timeout(5000) });
      return Boolean(r) && r.status < 500;
    } catch (_) {
      return false;
    }
  }

  async function check() {
    if (child) return;
    if (Date.now() - startedAt < START_GRACE_MS) return;
    if (await alive()) return;
    while (starts.length && Date.now() - starts[0] > 3600000) starts.shift();
    if (starts.length >= MAX_STARTS_PER_HOUR) return skip('一小时内已启动 3 次，暂停自动重启');
    const free = freeMb();
    if (free < minFree) return skip(`空闲内存 ${Math.round(free)}MB 少于 ${minFree}MB`);
    starts.push(Date.now());
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const out = fs.openSync(logFile, 'a');
      const env = Object.assign({}, process.env);
      if (cfg.IMAGE_HF_HOME) env.HF_HOME = cfg.IMAGE_HF_HOME;
      if (cfg.IMAGE_LORA) env.IMG_LORA = cfg.IMAGE_LORA;
      startedAt = Date.now();
      child = doSpawn(py, [script], {
        cwd: root, env, stdio: ['ignore', out, out], windowsHide: true, detached: true,
      });
      fs.closeSync(out);
      if (child && typeof child.unref === 'function') child.unref();
      if (child && typeof child.on === 'function') {
        child.on('exit', (code) => {
          console.warn(`[images] 本地画图服务已退出（code=${code}），稍后自动检查重启`);
          child = null;
        });
        child.on('error', (err) => {
          console.warn('[images] 本地画图服务启动失败：' + (err && err.message ? err.message : err));
          child = null;
        });
      }
      console.log('[images] 已启动本地画图服务：' + script);
    } catch (err) {
      child = null;
      console.warn('[images] 启动本地画图服务异常：' + (err && err.message ? err.message : err));
    }
  }

  const first = check();
  const timer = setInterval(check, CHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return { check, first, stop() { clearInterval(timer); } };
}

module.exports = { startImageSupervisor, healthUrlOf };
