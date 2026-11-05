'use strict';

// 第 6 节入口：读配置、启动 http、路由、静态托管 public/。
// 公开状态一律经 engine.toPublicState / toPublicTurnResult / listWorlds 过滤，
// 任何接口返回都不含 apex，也绝不含 API Key。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const env = require('./src/env.js');
const game = require('./src/game.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const WORLD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_BODY = 1024 * 1024; // 1 MiB

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: String(message) });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) {
        done = true;
        reject(Object.assign(new Error('请求体过大'), { status: 413, expose: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400, expose: true }));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function serveStatic(req, res, pathname, isHead) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (_) {
    return sendError(res, 400, '非法的 URL 路径');
  }
  rel = rel.split('\\').join('/');
  if (rel === '' || rel.endsWith('/')) rel = path.posix.join(rel, 'index.html');
  const suffix = rel.startsWith('/') ? rel : '/' + rel;
  const filePath = path.resolve(PUBLIC_DIR, '.' + suffix);
  const prefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(prefix)) {
    return sendError(res, 403, '禁止访问该路径');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendError(res, 404, '页面不存在');
    const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    fs.readFile(filePath, (err2, data) => {
      if (err2) return sendError(res, 500, '读取静态文件失败');
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(isHead ? undefined : data);
    });
  });
}

async function handle(req, res, cfg, g) {
  const method = (req.method || 'GET').toUpperCase();
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    pathname = (req.url || '/').split('?')[0];
  }

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- 无世界 ID 的接口 ----
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, model: cfg.LLM_MODEL, mock: !!cfg.LLM_MOCK });
  }
  if (pathname === '/api/usage' && method === 'GET') {
    return sendJson(res, 200, g.usage());
  }
  if (pathname === '/api/worlds' && method === 'GET') {
    return sendJson(res, 200, g.listWorlds());
  }
  if (pathname === '/api/worlds' && method === 'POST') {
    const body = await readJsonBody(req);
    return sendJson(res, 201, await g.buildWorld(body));
  }

  // ---- 带世界 ID 的接口 ----
  const m = pathname.match(/^\/api\/worlds\/([^/]+)(?:\/(turn|rebirth))?$/);
  if (m) {
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch (_) {
      return sendError(res, 400, '非法的世界 ID');
    }
    if (!WORLD_ID_PATTERN.test(id)) return sendError(res, 400, '非法的世界 ID');
    const sub = m[2];
    if (!sub && method === 'GET') return sendJson(res, 200, await g.getWorld(id));
    if (!sub && method === 'DELETE') return sendJson(res, 200, await g.deleteWorld(id));
    if (sub === 'turn' && method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await g.takeTurn(id, body));
    }
    if (sub === 'rebirth' && method === 'POST') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await g.rebirth(id, body));
    }
    return sendError(res, 405, '该路径不支持此 HTTP 方法');
  }

  if (pathname.startsWith('/api/')) return sendError(res, 404, '接口不存在');

  // ---- 其余路径静态托管 public/ ----
  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(req, res, pathname, method === 'HEAD');
  }
  return sendError(res, 405, '不支持该 HTTP 方法');
}

function createHttpServer(cfg) {
  const dataDir = env.resolveDataDir(cfg);
  const g = game.createGame(cfg, dataDir);
  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res, cfg, g))
      .catch((err) => {
        const status = (err && err.expose && err.status) || 500;
        const message = err && err.expose && err.message ? err.message : '服务器内部错误';
        if (!res.headersSent) sendError(res, status, message);
        else res.end();
      });
  });
  return server;
}

if (require.main === module) {
  const cfg = env.getConfig();
  const server = createHttpServer(cfg);
  server.listen(cfg.PORT, cfg.HOST, () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : cfg.PORT;
    process.stdout.write(
      `无限世界服务已启动： http://${cfg.HOST}:${port}（mock=${cfg.LLM_MOCK}）\n`,
    );
  });
}

module.exports = { createHttpServer, serveStatic, PUBLIC_DIR };
