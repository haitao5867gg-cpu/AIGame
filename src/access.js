'use strict';

// 访问控制（零第三方依赖）：
// - 经 Cloudflare 隧道进来的请求（带 cf-connecting-ip / cf-ray 头）是「公网来客」，必须先用访问密码登录；
// - 来自本机 127.0.0.1 / ::1、Tailscale 100.64.0.0/10 且不带这些头的是主人（host），不需要密码；
// - 其他来源（比如局域网）同样按来客处理，要密码。
// 登录成功发签名 cookie（HMAC-SHA256，含 playerId / 名字），HttpOnly + SameSite=Lax（+ 隧道下 Secure）。
// 访问密码：.env 的 ACCESS_PASSWORD；没配就首次生成 6 位数字，存 data/access.json（同时存 HMAC 密钥）。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.js');

const COOKIE_NAME = 'aig_s';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 5;
const NAME_MAX = 12;
const HOST_PLAYER = Object.freeze({ id: 'host', name: '主人', host: true });

function accessPath(dataDir) { return path.join(dataDir, 'access.json'); }

function genPassword() {
  // 6 位数字，好记好输；用 crypto 保证不可预测。
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// 读或初始化 data/access.json：{ password, secret, players: { <id>: { name, createdAt } } }
function loadAccessFile(dataDir) {
  const p = accessPath(dataDir);
  let v = store.readJson(p, null);
  let changed = false;
  if (!v || typeof v !== 'object' || Array.isArray(v)) { v = {}; changed = true; }
  if (typeof v.secret !== 'string' || v.secret.length < 32) { v.secret = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (typeof v.password !== 'string' || !v.password) { v.password = genPassword(); changed = true; }
  if (!v.players || typeof v.players !== 'object' || Array.isArray(v.players)) { v.players = {}; changed = true; }
  if (changed) {
    fs.mkdirSync(dataDir, { recursive: true });
    store.atomicWriteJson(p, v);
  }
  return v;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// IPv4（含 ::ffff: 映射）是否在 127.0.0.0/8 或 100.64.0.0/10；IPv6 只认 ::1。
function isHostAddress(addr) {
  let a = String(addr || '').trim().toLowerCase();
  if (a === '::1') return true;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const o1 = Number(m[1]);
  const o2 = Number(m[2]);
  if (o1 === 127) return true;
  return o1 === 100 && o2 >= 64 && o2 <= 127;
}

function viaTunnel(req) {
  const h = (req && req.headers) || {};
  return h['cf-connecting-ip'] != null || h['cf-ray'] != null;
}

function clientIp(req) {
  const h = (req && req.headers) || {};
  if (h['cf-connecting-ip']) return String(h['cf-connecting-ip']).trim();
  return String((req && req.socket && req.socket.remoteAddress) || '');
}

function cleanName(name) {
  // 只留可见字符，去掉尖括号 / 引号等，截到 12 字。
  const t = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f<>"'`\\&]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, NAME_MAX).join('');
}

function createAccess(cfg, dataDir, opts) {
  const o = opts || {};
  const nowFn = o.now || (() => Date.now());
  const file = loadAccessFile(dataDir);
  const password = String((cfg && cfg.ACCESS_PASSWORD) || '').trim() || file.password;
  const secret = file.secret;
  const fails = new Map(); // ip → [失败时间戳]

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const mac = b64url(crypto.createHmac('sha256', secret).update(body).digest());
    return `${body}.${mac}`;
  }

  function verify(token) {
    const s = String(token || '');
    const dot = s.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = s.slice(0, dot);
    const mac = s.slice(dot + 1);
    const want = b64url(crypto.createHmac('sha256', secret).update(body).digest());
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let p;
    try { p = JSON.parse(fromB64url(body).toString('utf8')); } catch (_) { return null; }
    if (!p || typeof p.pid !== 'string' || !/^p[0-9a-f]{12}$/.test(p.pid)) return null;
    if (typeof p.iat !== 'number' || nowFn() - p.iat > COOKIE_MAX_AGE_S * 1000) return null;
    return { id: p.pid, name: cleanName(p.name) || '旅人', host: false };
  }

  // 当前请求是谁：host / 已登录来客 / null（未登录来客）
  function playerOf(req) {
    if (!viaTunnel(req) && isHostAddress(req && req.socket && req.socket.remoteAddress)) return HOST_PLAYER;
    const cookies = parseCookies(req && req.headers && req.headers.cookie);
    return verify(cookies[COOKIE_NAME]);
  }

  function recentFails(ip) {
    const now = nowFn();
    const list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (list.length) fails.set(ip, list); else fails.delete(ip);
    return list;
  }

  // 登录：返回 { status, body, cookie? }。body 里绝不带密码。
  function login(req, body) {
    const ip = clientIp(req);
    if (recentFails(ip).length >= FAIL_MAX) {
      return { status: 429, body: { error: '尝试次数过多，请 10 分钟后再试' } };
    }
    const b = body && typeof body === 'object' ? body : {};
    const given = Buffer.from(String(b.password == null ? '' : b.password).trim());
    const want = Buffer.from(password);
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      const list = recentFails(ip);
      list.push(nowFn());
      fails.set(ip, list);
      return { status: 401, body: { error: '访问密码不对' } };
    }
    const name = cleanName(b.name);
    if (!name) return { status: 400, body: { error: '请填一个名字' } };
    fails.delete(ip);
    const pid = 'p' + crypto.randomBytes(6).toString('hex');
    const f = loadAccessFile(dataDir);
    f.players[pid] = { name, createdAt: nowFn() };
    store.atomicWriteJson(accessPath(dataDir), f);
    const token = sign({ pid, name, iat: nowFn() });
    const secure = viaTunnel(req) ? '; Secure' : '';
    const cookie = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure}`;
    return { status: 200, body: { ok: true, player: { id: pid, name, host: false } }, cookie };
  }

  function logoutCookie(req) {
    const secure = viaTunnel(req) ? '; Secure' : '';
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }

  function playerNames() {
    const f = loadAccessFile(dataDir);
    const out = { host: HOST_PLAYER.name };
    for (const [id, p] of Object.entries(f.players || {})) out[id] = (p && p.name) || id;
    return out;
  }

  return { playerOf, login, logoutCookie, playerNames, password: () => password, hasPassword: () => !!password };
}

// ---- 世界归属：data/owners.json { <worldId>: <playerId> }；没有记录的世界归 host ----
function ownersPath(dataDir) { return path.join(dataDir, 'owners.json'); }
function readOwners(dataDir) {
  const v = store.readJson(ownersPath(dataDir), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function ownerOf(dataDir, worldId) {
  const o = readOwners(dataDir)[worldId];
  return typeof o === 'string' && o ? o : HOST_PLAYER.id;
}
function setOwner(dataDir, worldId, playerId) {
  const all = readOwners(dataDir);
  all[worldId] = playerId;
  fs.mkdirSync(dataDir, { recursive: true });
  store.atomicWriteJson(ownersPath(dataDir), all);
}
function removeOwner(dataDir, worldId) {
  const all = readOwners(dataDir);
  if (!(worldId in all)) return;
  delete all[worldId];
  store.atomicWriteJson(ownersPath(dataDir), all);
}

module.exports = {
  createAccess, isHostAddress, viaTunnel, parseCookies, cleanName, genPassword,
  ownerOf, setOwner, removeOwner, readOwners,
  COOKIE_NAME, HOST_PLAYER, FAIL_MAX,
};
