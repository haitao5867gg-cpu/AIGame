'use strict';

// 第 6 节入口：读配置、启动 http、路由、静态托管 public/。
// 公开状态一律经 engine.toPublicState / toPublicTurnResult / listWorlds 过滤，
// 任何接口返回都不含 apex，也绝不含 API Key。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const env = require('./src/env.js');
const game = require('./src/game.js');
const imagesMod = require('./src/images.js');
const accessMod = require('./src/access.js');
const context = require('./src/context.js');
const store = require('./src/store.js');
const llmMod = require('./src/llm.js');
const prefs = require('./src/prefs.js');
const ttsMod = require('./src/tts.js');

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

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(text);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: String(message) });
}

// 带世界 ID 的接口在调 game 之前校验归属；不是本人一律 404，且不泄露世界是否存在。
function requireOwner(res, dataDir, id, player) {
  if (accessMod.ownerOf(dataDir, id) !== player.id) {
    sendError(res, 404, '世界不存在');
    return false;
  }
  return true;
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

// ---- 导出 ----
// 把公开状态（去掉 apex）+ events.jsonl 公开字段打包成 JSON 附件下载。
function handleExport(res, g, id) {
  const data = g.exportWorld(id);
  const text = JSON.stringify(data, null, 2);
  const filename = `world-${id}.json`;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

// ---- 启动备份 ----
const BACKUP_KEEP = 7;
const BACKUP_NAME = /^\d{8}-\d{6}$/;

function backupTimestamp(now) {
  const d = now == null ? new Date() : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

// 把 DATA_DIR/worlds 整个（只）用 fs.cpSync 复制到 DATA_DIR/../backups/<ts>/；
// 只保留最近 7 份，更旧的删除；失败只告警，绝不影响启动。返回 dest 或 null。
function createBackup(dataDir, now) {
  const ts = backupTimestamp(now);
  const baseDir = path.join(dataDir, '..', 'backups');
  const dest = path.join(baseDir, ts);
  const src = path.join(dataDir, 'worlds');
  try {
    fs.cpSync(src, dest, { recursive: true });
    const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && BACKUP_NAME.test(e.name))
      .map((e) => e.name)
      .sort();
    while (dirs.length > BACKUP_KEEP) {
      const old = dirs.shift();
      fs.rmSync(path.join(baseDir, old), { recursive: true, force: true });
    }
    return dest;
  } catch (err) {
    console.warn('[backup] 启动备份失败（已忽略，不影响启动）：' +
      (err && err.message ? err.message : err));
    return null;
  }
}

// ---- SSE 流式回合 ----
function startEventStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁止反向代理缓冲，保证 delta 边生成边到达
  });
}

function sseEvent(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// POST /api/worlds/:id/turn/stream：多次 event: delta，最后 event: result / event: error。
// result 的 data 与普通 /turn 的响应体完全相同（来自同一个 takeTurn）。
async function handleStreamTurn(req, res, g, id, images, dataDir) {
  startEventStream(res);
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const message = err && err.expose && err.message ? err.message : '请求体不是合法 JSON';
    sseEvent(res, 'error', { error: String(message) });
    res.end();
    return;
  }
  try {
    const result = await g.takeTurn(id, body, (text) => sseEvent(res, 'delta', { text }));
    // 结果写入后、锁外异步排队本回合新增物品 / 新出现的 NPC。
    triggerImages(images, dataDir, result && result.state);
    if (result) result.sceneKey = triggerScene(images, dataDir, result);
    sseEvent(res, 'result', result);
    res.end();
  } catch (err) {
    const message = err && err.expose && err.message ? err.message : '服务器内部错误';
    sseEvent(res, 'error', { error: String(message) });
    res.end();
  }
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

// 锁外异步触发图片排队：只用公开状态里的 character.items / npcAttitude / bible。
// 完全不 await（ensureImages 内部同步登记后自行异步出图），异常只写日志，绝不影响响应。
function triggerImages(images, dataDir, state) {
  if (!images || !state) return;
  try {
    images.ensureImages(dataDir, state, images.listForState(state));
  } catch (err) {
    console.warn('[images] 触发异常（已忽略）：' + (err && err.message ? err.message : err));
  }
}

// 只在 draw=true 的回合触发场景登记，同步拿到 12 位 key（或 null）；异常只写日志，绝不影响响应。
function triggerScene(images, dataDir, result) {
  if (!images || !result || !result.scene || !result.scene.draw) return null;
  try {
    const sc = result.scene;
    const spec = {
      turn: result.state.turn, desc: sc.desc, place: sc.place, action: sc.action,
    };
    if (Array.isArray(sc.cast)) spec.cast = sc.cast;
    if (Array.isArray(sc.items)) spec.items = sc.items;
    return images.ensureScene(dataDir, result.state, spec);
  } catch (err) {
    console.warn('[images] 场景触发异常（已忽略）：' + (err && err.message ? err.message : err));
    return null;
  }
}

function handle(req, res, cfg, g, images, dataDir, access, runtime) {
  const player = access.playerOf(req);
  // 整个请求处理放进 ALS 上下文：同一请求触发的 LLM / 出图用量都能带上当前玩家。
  return context.run({ playerId: player ? player.id : null },
    () => route(req, res, cfg, g, images, dataDir, access, player, runtime));
}

async function route(req, res, cfg, g, images, dataDir, access, player, runtime) {
  const method = (req.method || 'GET').toUpperCase();
  let pathname;
  let searchParams = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = url.pathname;
    searchParams = url.searchParams;
  } catch (_) {
    pathname = (req.url || '/').split('?')[0];
  }

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- 访问控制：仅登录页 / 登录 / 登出无需玩家身份 ----
  const isPublic =
    (pathname === '/login.html' && (method === 'GET' || method === 'HEAD')) ||
    (pathname === '/api/login' && method === 'POST') ||
    (pathname === '/api/logout' && method === 'POST');
  if (!player && !isPublic) {
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 401, { error: '需要先输入访问密码', login: true });
    }
    if (method === 'GET' || method === 'HEAD') {
      res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    return sendJson(res, 401, { error: '需要先输入访问密码', login: true });
  }

  // ---- 登录 / 登出 / 当前玩家 ----
  if (pathname === '/api/login' && method === 'POST') {
    // 主人（本机 / Tailscale 直连）无需密码，也不发 cookie。
    if (player && player.host) {
      return sendJson(res, 200, { ok: true, player: { id: player.id, name: player.name, host: true } });
    }
    const body = await readJsonBody(req);
    const r = access.login(req, body);
    return sendJson(res, r.status, r.body, r.cookie ? { 'Set-Cookie': r.cookie } : undefined);
  }
  if (pathname === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': access.logoutCookie(req) });
  }
  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, {
      id: player.id, name: player.name, host: !!(player && player.host),
      prefs: prefs.getPrefs(dataDir, player.id),
    });
  }
  if (pathname === '/api/prefs' && method === 'POST') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { prefs: prefs.setPrefs(dataDir, player.id, body) });
  }

  // ---- 朗读（Azure 语音服务）：需登录，错误按 status 返回 JSON ----
  if (pathname === '/api/tts' && method === 'POST') {
    const body = await readJsonBody(req);
    const audio = await runtime.tts.synth(Object.assign({}, body, { playerId: player.id }));
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(audio);
    return;
  }
  if (pathname === '/api/tts/voices' && method === 'GET') {
    const month = runtime.tts.monthUsage();
    return sendJson(res, 200, {
      configured: runtime.tts.isConfigured() && !month.exhausted,
      exhausted: month.exhausted,
      voices: ttsMod.VOICES,
      moods: Object.keys(ttsMod.MOODS),
      month: { used: month.used, limit: month.limit, stopAt: month.stopAt },
    });
  }

  // ---- 无世界 ID 的接口 ----
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, model: cfg.LLM_MODEL, mock: !!cfg.LLM_MOCK });
  }
  if (pathname === '/api/usage' && method === 'GET') {
    return sendJson(res, 200, g.usage());
  }
  if (pathname === '/api/usage/today' && method === 'GET') {
    const now = Date.now();
    const isHost = !!(player && player.host);
    // 来客：只看自己（按 player.id 过滤，用每人上限）；主人：保持原来的全局视图（全局上限）。
    const u = isHost ? g.usageToday() : g.usageToday(player.id);
    const st = images.providerStatus();
    u.images.chain = st.chain;
    u.images.cooling = st.cooling;
    const mth = runtime.tts.monthUsage();
    u.tts = {
      monthUsed: mth.used,
      monthLimit: mth.limit,
      todayChars: runtime.tts.todayChars(player.id),
    };
    const cfLimit = Number(cfg.CLOUDFLARE_DAILY_NEURONS) || 10000;
    const cfReserve = Number(cfg.CLOUDFLARE_RESERVE_FROM) || 7000;
    const cfUsed = llmMod.cloudflareNeuronsToday(store.readJsonl(store.usagePath(dataDir)), now);
    u.images.cloudflare = {
      used: cfUsed, limit: cfLimit, remaining: Math.max(0, cfLimit - cfUsed), reserveFrom: cfReserve,
    };
    if (isHost) {
      // host 专属字段：全局今日 token（用全局上限）、今日各玩家、访问密码、临时隧道地址。
      u.global = g.usageToday().tokens;
      const names = access.playerNames();
      u.players = llmMod.summarizePlayers(store.readJsonl(store.usagePath(dataDir)), now)
        .map((p) => ({ id: p.id, name: names[p.id] || p.id, total: p.total }));
      u.access = { password: access.password() };
      u.tunnel = { url: runtime && runtime.tunnel ? runtime.tunnel.url() : null };
    }
    return sendJson(res, 200, u);
  }
  if (pathname === '/api/worlds' && method === 'GET') {
    const list = g.listWorlds().filter((w) => accessMod.ownerOf(dataDir, w.id) === player.id);
    return sendJson(res, 200, list);
  }
  if (pathname === '/api/worlds' && method === 'POST') {
    const body = await readJsonBody(req);
    const world = await g.buildWorld(body);
    // 建世界成功后登记归属；无记录的老世界默认归 host。
    accessMod.setOwner(dataDir, world.id, player.id);
    // 建世界成功后、锁外异步排队起始物品 + 全部 bible.npcs。
    triggerImages(images, dataDir, world);
    return sendJson(res, 201, world);
  }

  // ---- 带世界 ID 的接口 ----
  // 流式回合：POST /api/worlds/:id/turn/stream（text/event-stream），须在通用路由前匹配。
  const streamMatch = pathname.match(/^\/api\/worlds\/([^/]+)\/turn\/stream$/);
  if (streamMatch) {
    if (method !== 'POST') return sendError(res, 405, '该路径不支持此 HTTP 方法');
    let id;
    try {
      id = decodeURIComponent(streamMatch[1]);
    } catch (_) {
      return sendError(res, 400, '非法的世界 ID');
    }
    if (!WORLD_ID_PATTERN.test(id)) return sendError(res, 400, '非法的世界 ID');
    // 校验归属必须在开流（startEventStream）之前，越权直接返回 404 JSON。
    if (!requireOwner(res, dataDir, id, player)) return;
    return handleStreamTurn(req, res, g, id, images, dataDir);
  }

  // 导出：GET /api/worlds/:id/export（打包 state + events 的 JSON 附件）。
  const exportMatch = pathname.match(/^\/api\/worlds\/([^/]+)\/export$/);
  if (exportMatch) {
    if (method !== 'GET') return sendError(res, 405, '该路径不支持此 HTTP 方法');
    let id;
    try {
      id = decodeURIComponent(exportMatch[1]);
    } catch (_) {
      return sendError(res, 400, '非法的世界 ID');
    }
    if (!WORLD_ID_PATTERN.test(id)) return sendError(res, 400, '非法的世界 ID');
    if (!requireOwner(res, dataDir, id, player)) return;
    return handleExport(res, g, id);
  }

  // 序章：GET /api/worlds/:id/prologue（给老世界补生成，新世界已随 bible 带出）。
  const prologueMatch = pathname.match(new RegExp('^/api/worlds/([^/]+)/prologue$'));
  if (prologueMatch) {
    if (method !== 'GET') return sendError(res, 405, '该路径不支持此 HTTP 方法');
    let id;
    try {
      id = decodeURIComponent(prologueMatch[1]);
    } catch (_) {
      return sendError(res, 400, '非法的世界 ID');
    }
    if (!WORLD_ID_PATTERN.test(id)) return sendError(res, 400, '非法的世界 ID');
    if (!requireOwner(res, dataDir, id, player)) return;
    const prologue = await g.ensurePrologue(id);
    return sendJson(res, 200, { prologue });
  }

  // 物品介绍：GET /api/worlds/:id/items（按需补生成缺失介绍，按当前物品栏顺序返回）。
  const itemsMatch = pathname.match(/^\/api\/worlds\/([^/]+)\/items$/);
  if (itemsMatch) {
    if (method !== 'GET') return sendError(res, 405, '该路径不支持此 HTTP 方法');
    let id;
    try {
      id = decodeURIComponent(itemsMatch[1]);
    } catch (_) {
      return sendError(res, 400, '非法的世界 ID');
    }
    if (!WORLD_ID_PATTERN.test(id)) return sendError(res, 400, '非法的世界 ID');
    if (!requireOwner(res, dataDir, id, player)) return;
    const items = await g.ensureItemInfo(id);
    return sendJson(res, 200, { items });
  }

  // 图片状态：GET /api/worlds/:id/images（只含当前物品 / NPC；顺手给老存档补图）。
  const imagesMatch = pathname.match(/^\/api\/worlds\/([^/]+)\/images$/);
  if (imagesMatch) {
    if (method !== 'GET') return sendError(res, 405, '该路径不支持此 HTTP 方法');
    let id;
    try {
      id = decodeURIComponent(imagesMatch[1]);
    } catch (_) {
      return sendError(res, 400, '非法的世界 ID');
    }
    if (!WORLD_ID_PATTERN.test(id)) return sendError(res, 400, '非法的世界 ID');
    if (!requireOwner(res, dataDir, id, player)) return;
    const state = await g.getWorld(id);
    const list = images.imageList(dataDir, state);
    const idx = images.readIndex(dataDir);
    const scenes = {};
    for (const rec of g.listScenes(id)) {
      const key = imagesMod.sceneKey(id, rec.life, rec.turn, rec.desc);
      const e = idx['scene-' + key];
      let status = 'none';
      let url = null;
      if (e) {
        if (e.status === 'ready' && e.file) {
          status = 'ready';
          url = '/api/images/' + e.file;
        } else if (e.status === 'pending') status = 'pending';
        else if (e.status === 'failed') status = 'failed';
      }
      scenes[`${rec.life}-${rec.turn}`] = { turn: rec.turn, life: rec.life, status, url };
    }
    list.scenes = scenes;
    return sendJson(res, 200, list);
  }

  // 图片文件：GET /api/images/<file>（严格校验文件名，长缓存）。
  const imageFileMatch = pathname.match(/^\/api\/images\/([^/]+)$/);
  if (imageFileMatch) {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, '该路径不支持此 HTTP 方法');
    let filename;
    try {
      filename = decodeURIComponent(imageFileMatch[1]);
    } catch (_) {
      return sendError(res, 400, '非法的图片文件名');
    }
    const info = images.serveImage(dataDir, filename);
    if (info.status === 400) return sendError(res, 400, '非法的图片文件名');
    if (info.status === 404) return sendError(res, 404, '图片不存在');
    let data;
    try {
      data = fs.readFileSync(info.filePath);
    } catch (_) {
      return sendError(res, 404, '图片不存在');
    }
    res.writeHead(200, {
      'Content-Type': info.contentType,
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(method === 'HEAD' ? undefined : data);
    return;
  }

  const m = pathname.match(/^\/api\/worlds\/([^/]+)(?:\/(turn|rebirth|log|undo))?$/);
  if (m) {
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch (_) {
      return sendError(res, 400, '非法的世界 ID');
    }
    if (!WORLD_ID_PATTERN.test(id)) return sendError(res, 400, '非法的世界 ID');
    if (!requireOwner(res, dataDir, id, player)) return;
    const sub = m[2];
    if (!sub && method === 'GET') return sendJson(res, 200, await g.getWorld(id));
    if (!sub && method === 'DELETE') {
      const result = await g.deleteWorld(id);
      accessMod.removeOwner(dataDir, id);
      return sendJson(res, 200, result);
    }
    if (sub === 'log' && method === 'GET') {
      let limit;
      if (searchParams && searchParams.has('limit')) limit = Number(searchParams.get('limit'));
      return sendJson(res, 200, await g.getWorldLog(id, limit));
    }
    if (sub === 'turn' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await g.takeTurn(id, body);
      // 结果写入后、锁外异步排队本回合新增物品 / 新出现的 NPC。
      triggerImages(images, dataDir, result && result.state);
      if (result) result.sceneKey = triggerScene(images, dataDir, result);
      return sendJson(res, 200, result);
    }
    if (sub === 'rebirth' && method === 'POST') {
      const body = await readJsonBody(req);
      const result = await g.rebirth(id, body);
      // 重生后排队新的起始物品（及仍在的 NPC）。
      triggerImages(images, dataDir, result);
      return sendJson(res, 200, result);
    }
    if (sub === 'undo' && method === 'POST') {
      return sendJson(res, 200, await g.undoTurn(id));
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

function createHttpServer(cfg, opts) {
  const o = opts || {};
  const dataDir = env.resolveDataDir(cfg);
  const g = game.createGame(cfg, dataDir);
  const images = imagesMod.createImages(cfg);
  const access = accessMod.createAccess(cfg, dataDir);
  // 朗读实例：opts.tts 可注入整实例；否则用 opts.ttsFetchImpl / opts.now 注入（测试用假 fetch）。
  const tts = o.tts || ttsMod.createTts(cfg, dataDir, {
    fetchImpl: o.ttsFetchImpl || o.fetchImpl,
    now: o.ttsNow || o.now,
  });
  // 隧道在 server.listen 之后才启动，用可写 holder 让路由拿到最新 tunnel（测试可经 opts.tunnel 注入）。
  const runtime = { tunnel: o.tunnel || null, tts };
  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res, cfg, g, images, dataDir, access, runtime))
      .catch((err) => {
        const status = (err && err.expose && err.status) || 500;
        const message = err && err.expose && err.message ? err.message : '服务器内部错误';
        if (!res.headersSent) sendError(res, status, message);
        else res.end();
      });
  });
  server.access = access;
  server.setTunnel = (t) => { runtime.tunnel = t; };
  return server;
}

if (require.main === module) {
  const cfg = env.getConfig();
  // 启动时先做一次存档备份（失败只告警，不阻断启动）。
  createBackup(env.resolveDataDir(cfg));
  const server = createHttpServer(cfg);
  server.listen(cfg.PORT, cfg.HOST, () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : cfg.PORT;
    process.stdout.write(
      `无限世界服务已启动： http://${cfg.HOST}:${port}（mock=${cfg.LLM_MOCK}）\n`,
    );
    require('./src/imgsupervisor.js').startImageSupervisor(cfg);
    // 自动启动 Cloudflare 临时隧道；未启动时返回 null，setTunnel 接受 null。
    const tunnel = require('./src/tunnel.js').startTunnel(cfg, {
      port,
      hasPassword: () => server.access.hasPassword(),
    });
    server.setTunnel(tunnel);
  });
}

module.exports = {
  createHttpServer, serveStatic, PUBLIC_DIR,
  createBackup, backupTimestamp, BACKUP_KEEP,
};
