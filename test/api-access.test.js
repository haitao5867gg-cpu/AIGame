'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const { createHttpServer, createBackup, BACKUP_KEEP } = require('../server.js');
const { SECRET, containsKey, assertNoLeak, req, asGuest, readAccessPassword, loginGuest, guestMe, parseSSE, postStream, withServer, seedUsage } = require('./helpers/api-helpers.js');

// ---- 访问控制：登录页 + 访问密码 ----
// 来客 = 带 cf-ray 头；主人 = 不带该头的普通 127.0.0.1 请求（原有测试全是主人，无需密码）。
test('访问控制：来客无 cookie 时 /api/* 返回 401(login)、静态页 302 到登录页、登录页可直接访问', async () => {
  await withServer(async ({ base }) => {
    let r = await req(base, 'GET', '/api/worlds', undefined, asGuest());
    assert.equal(r.status, 401);
    assert.equal(r.json.login, true);
    assert.match(r.json.error, /访问密码/);

    r = await req(base, 'GET', '/', undefined, asGuest(), { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login.html');

    r = await req(base, 'GET', '/login.html', undefined, asGuest());
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('无限世界'));

    r = await req(base, 'HEAD', '/login.html', undefined, asGuest());
    assert.equal(r.status, 200);
  });
});

test('访问控制：来客连续输错访问密码 5 次后第 6 次返回 429', async () => {
  await withServer(async ({ base }) => {
    for (let i = 0; i < 5; i++) {
      const r = await req(base, 'POST', '/api/login', { password: 'wrongpw', name: '小明' }, asGuest());
      assert.equal(r.status, 401, `第 ${i + 1} 次错误应 401`);
    }
    const r6 = await req(base, 'POST', '/api/login', { password: 'wrongpw', name: '小明' }, asGuest());
    assert.equal(r6.status, 429);
  });
});

test('访问控制：来客用 access.json 里的密码登录 → Set-Cookie，带 cookie 后 /api/me 与 /api/worlds 可用', async () => {
  await withServer(async ({ base, dataDir }) => {
    const pw = readAccessPassword(dataDir);
    assert.match(pw, /^\d{6}$/, '未配密码时应自动生成 6 位数字');

    let r = await req(base, 'POST', '/api/login', { password: pw, name: '小明' }, asGuest());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.player.name, '小明');
    assert.equal(r.json.player.host, false);
    assert.match(r.json.player.id, /^p[0-9a-f]{12}$/);
    const setCookie = r.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('aig_s='));
    const cookie = setCookie.split(';')[0];

    r = await req(base, 'GET', '/api/me', undefined, asGuest(cookie));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.name, '小明');
    assert.equal(r.json.host, false);
    assert.match(r.json.id, /^p[0-9a-f]{12}$/);

    r = await req(base, 'GET', '/api/worlds', undefined, asGuest(cookie));
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json));
  });
});

test('访问控制：主人 GET /api/me 返回 host:true 且无需登录；调 /api/login 直接成功且不发 cookie', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'GET', '/api/me');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.host, true);
    assert.equal(r.json.id, 'host');
    assert.equal(r.json.name, '主人');

    const lr = await req(base, 'POST', '/api/login', { password: 'whatever', name: 'x' });
    assert.equal(lr.status, 200, lr.text);
    assert.equal(lr.json.ok, true);
    assert.equal(lr.json.player.host, true);
    assert.equal(lr.headers.get('set-cookie'), null, '主人不应收到 Set-Cookie');
  });
});

test('访问控制：所有给来客的响应文本都不包含访问密码', async () => {
  await withServer(async ({ base }) => {
    const pw = 'LEAKCHECK-8848';
    const texts = [];
    let r = await req(base, 'GET', '/api/worlds', undefined, asGuest());
    texts.push(r.text);
    assert.equal(r.status, 401);
    r = await req(base, 'GET', '/', undefined, asGuest(), { redirect: 'manual' });
    texts.push(r.text);
    assert.equal(r.status, 302);
    r = await req(base, 'GET', '/login.html', undefined, asGuest());
    texts.push(r.text);
    assert.equal(r.status, 200);
    r = await req(base, 'POST', '/api/login', { password: 'wrongpw', name: 'x' }, asGuest());
    texts.push(r.text);
    assert.equal(r.status, 401);
    r = await req(base, 'POST', '/api/login', { password: pw, name: '小明' }, asGuest());
    texts.push(r.text);
    assert.equal(r.status, 200, r.text);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    r = await req(base, 'GET', '/api/me', undefined, asGuest(cookie));
    texts.push(r.text);
    assert.equal(r.status, 200);
    r = await req(base, 'GET', '/api/worlds', undefined, asGuest(cookie));
    texts.push(r.text);
    assert.equal(r.status, 200);
    for (let i = 0; i < 5; i++) {
      const x = await req(base, 'POST', '/api/login', { password: 'wrongpw', name: 'x' }, asGuest());
      texts.push(x.text);
      assert.equal(x.status, 401);
    }
    const r429 = await req(base, 'POST', '/api/login', { password: 'wrongpw', name: 'x' }, asGuest());
    texts.push(r429.text);
    assert.equal(r429.status, 429);

    for (const t of texts) {
      assert.equal(t.includes(pw), false, '给来客的响应不得包含访问密码');
    }
  }, { ACCESS_PASSWORD: 'LEAKCHECK-8848' });
});

