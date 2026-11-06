'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const access = require('../src/access.js');

const { createAccess, isHostAddress, cleanName, COOKIE_NAME, FAIL_MAX } = access;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-access-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 伪造一个最小 req：headers + socket.remoteAddress 足够 access.js 用。
function fakeReq(opts) {
  opts = opts || {};
  const headers = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.cfRay) headers['cf-ray'] = 'test-ray';
  if (opts.cfIp) headers['cf-connecting-ip'] = opts.cfIp;
  return { headers, socket: { remoteAddress: opts.ip || '8.8.8.8' } };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function readAccessFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'access.json'), 'utf8'));
}

function tokenFromCookie(cookie) {
  return cookie.split(';')[0].slice(COOKIE_NAME.length + 1);
}

// ---- 谁是谁 ----
test('isHostAddress：本机 / ::1 / ::ffff 映射 / Tailscale 段是主人，其它来源不是', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '100.64.0.1', '100.127.255.255', '127.20.3.4']) {
    assert.equal(isHostAddress(a), true, `${a} 应判定为主人`);
  }
  for (const a of ['100.128.0.1', '192.168.1.2', '8.8.8.8', '10.0.0.1', '::ffff:8.8.8.8']) {
    assert.equal(isHostAddress(a), false, `${a} 不应判定为主人`);
  }
});

// ---- 签名 cookie ----
test('cookie 签名可验证、篡改签名或 payload 后失效', (t) => {
  const dir = tmpDir(t);
  const a = createAccess({ ACCESS_PASSWORD: 'secret-pass' }, dir);
  const res = a.login(fakeReq({ ip: '8.8.8.8' }), { password: 'secret-pass', name: '小明' });
  assert.equal(res.status, 200);
  assert.ok(res.cookie, '登录成功应下发 cookie');

  const token = tokenFromCookie(res.cookie);
  const dot = token.lastIndexOf('.');
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  // 直接验证 HMAC-SHA256：密钥写在 access.json，签名应与之吻合。
  const file = readAccessFile(dir);
  const want = b64url(crypto.createHmac('sha256', file.secret).update(body).digest());
  assert.equal(mac, want, '签名应等于用 access.json 密钥算出的 HMAC');
  const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.match(payload.pid, /^p[0-9a-f]{12}$/);
  assert.equal(payload.name, '小明');

  // playerOf 能从有效 cookie 认出玩家。
  const p = a.playerOf(fakeReq({ ip: '8.8.8.8', cookie: COOKIE_NAME + '=' + token }));
  assert.ok(p, '带有效 cookie 的来客应被识别为已登录玩家');
  assert.equal(p.id, payload.pid);
  assert.equal(p.name, '小明');
  assert.equal(p.host, false);

  // 篡改签名段 / 篡改 payload 均失效。
  const badMac = mac.slice(0, -1) + (mac.slice(-1) === 'A' ? 'B' : 'A');
  assert.equal(a.playerOf(fakeReq({ ip: '8.8.8.8', cookie: COOKIE_NAME + '=' + body + '.' + badMac })), null);
  const badBody = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
  assert.equal(a.playerOf(fakeReq({ ip: '8.8.8.8', cookie: COOKIE_NAME + '=' + badBody + '.' + mac })), null);
});

// ---- 失败限流 ----
test('同一 IP 密码错 5 次后第 6 次返回 429（窗口内正确密码也被挡）', (t) => {
  const dir = tmpDir(t);
  const a = createAccess({ ACCESS_PASSWORD: 'right' }, dir);
  const req = fakeReq({ ip: '8.8.8.8' });
  for (let i = 0; i < FAIL_MAX; i++) {
    const r = a.login(req, { password: 'wrong', name: 'x' });
    assert.equal(r.status, 401, `第 ${i + 1} 次错误应 401`);
  }
  assert.equal(a.login(req, { password: 'wrong', name: 'x' }).status, 429);
  assert.equal(a.login(req, { password: 'right', name: 'x' }).status, 429);
});

// ---- 名字清洗 ----
test('名字清洗：去尖括号引号、截 12 字、空名字 400', (t) => {
  assert.equal(cleanName('<script>'), 'script');
  assert.equal(cleanName('<a>"b\'c&d\\e'), 'abcde');
  assert.equal(cleanName('abcdefghijklmn'), 'abcdefghijkl');
  assert.equal(Array.from(cleanName('甲乙丙丁戊己庚辛壬癸子丑寅卯')).length, 12);

  const dir = tmpDir(t);
  const a = createAccess({ ACCESS_PASSWORD: 'pw' }, dir);
  const req = fakeReq({ ip: '8.8.8.8' });
  assert.equal(a.login(req, { password: 'pw', name: '' }).status, 400);
  assert.equal(a.login(req, { password: 'pw', name: '   ' }).status, 400);
  assert.equal(a.login(req, { password: 'pw', name: '<>"\'' }).status, 400);
  const ok = a.login(req, { password: 'pw', name: '小<明>"' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.player.name, '小明');
});

// ---- 返回体不含密码 ----
test('login 返回体里没有访问密码', (t) => {
  const dir = tmpDir(t);
  const a = createAccess({ ACCESS_PASSWORD: 'TOPSECRET9' }, dir);
  const req = fakeReq({ ip: '8.8.8.8' });
  const ok = a.login(req, { password: 'TOPSECRET9', name: '小明' });
  assert.equal(ok.status, 200);
  assert.equal('password' in ok.body, false);
  assert.equal(JSON.stringify(ok.body).includes('TOPSECRET9'), false);
  const bad = a.login(req, { password: 'no', name: 'x' });
  assert.equal(bad.status, 401);
  assert.equal(JSON.stringify(bad.body).includes('TOPSECRET9'), false);
});

// ---- 配置优先 / 自动生成复用 ----
test('ACCESS_PASSWORD 配置优先于自动生成的密码', (t) => {
  const dir = tmpDir(t);
  const a = createAccess({ ACCESS_PASSWORD: 'CONFIG-PW-7' }, dir);
  assert.equal(a.password(), 'CONFIG-PW-7');
  const filePw = readAccessFile(dir).password;
  assert.match(filePw, /^\d{6}$/);
  assert.notEqual(a.password(), filePw);
  const req = fakeReq({ ip: '8.8.8.8' });
  assert.equal(a.login(req, { password: 'CONFIG-PW-7', name: '小明' }).status, 200);
  assert.equal(a.login(req, { password: filePw, name: '小明' }).status, 401);
});

test('未配 ACCESS_PASSWORD：自动生成 6 位数字写入 access.json，第二次 createAccess 复用', (t) => {
  const dir = tmpDir(t);
  const a1 = createAccess({}, dir);
  const file = readAccessFile(dir);
  assert.match(file.password, /^\d{6}$/);
  assert.equal(a1.password(), file.password);
  assert.equal(typeof file.secret, 'string');
  const a2 = createAccess({}, dir);
  assert.equal(a2.password(), file.password, '第二次 createAccess 应复用同一个密码');
});
