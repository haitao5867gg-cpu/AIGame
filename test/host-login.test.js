'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../src/env.js');
const accessMod = require('../src/access.js');
const { req, asGuest, loginGuest, guestMe, withServer } = require('./helpers/api-helpers.js');

function accessJson(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'access.json'), 'utf8'));
}
function readHostPassword(dataDir) {
  return accessJson(dataDir).hostPassword;
}
function ownersJson(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'owners.json'), 'utf8'));
}

// 把 cookie（aig_s=<body>.<mac>）里的 pid 改成 newPid，签名保持不变。
function tamperPid(cookie, newPid) {
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const dot = token.lastIndexOf('.');
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  p.pid = newPid;
  const newBody = Buffer.from(JSON.stringify(p)).toString('base64url');
  return 'aig_s=' + newBody + '.' + mac;
}

test('环境：DEFAULTS 含 HOST_PASSWORD，且 withoutKey 会剔除 *PASSWORD', () => {
  assert.equal(env.DEFAULTS.HOST_PASSWORD, '');
  const pub = env.withoutKey({ HOST_PASSWORD: 'secret-value', ACCESS_PASSWORD: 'x', KEEP: 'y' });
  assert.equal('HOST_PASSWORD' in pub, false);
  assert.equal('ACCESS_PASSWORD' in pub, false);
  assert.equal(pub.KEEP, 'y');
});

test('主人口令：未配置时自动生成 16 位、写入 access.json、再次启动复用', async () => {
  await withServer(async ({ dataDir }) => {
    const hp = readHostPassword(dataDir);
    assert.match(hp, /^[A-Za-z0-9]{16}$/, '应生成 16 位字母数字');
    assert.equal(/[0O1lI]/.test(hp), false, '应去掉易混字符 0O1lI');
    const cfg = Object.assign(env.getConfig(), { ACCESS_PASSWORD: '' });
    const a2 = accessMod.createAccess(cfg, dataDir);
    assert.equal(a2.hostPassword(), hp, '第二次应复用同一口令');
    assert.equal(readHostPassword(dataDir), hp, 'access.json 内容不变');
  });
});

test('主人口令：HOST_PASSWORD 配置优先于自动生成值', async () => {
  const CONFIGURED = 'ConfigHostPass9';
  await withServer(async ({ base, dataDir }) => {
    const generated = readHostPassword(dataDir);
    assert.notEqual(generated, CONFIGURED);
    // 自动生成的那个值不再能通过主人登录。
    const bad = await req(base, 'POST', '/api/login', { mode: 'host', password: generated }, asGuest());
    assert.equal(bad.status, 401, bad.text);
    // 配置值才能登录。
    const ok = await req(base, 'POST', '/api/login', { mode: 'host', password: CONFIGURED }, asGuest());
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.player.host, true);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const me = await req(base, 'GET', '/api/me', undefined, asGuest(cookie));
    assert.equal(me.json.host, true);
  }, { HOST_PASSWORD: CONFIGURED });
});

test('主人登录：来客（cf-ray）用主人口令登录 → 签名 cookie → /api/me host:true，能看到主人世界', async () => {
  await withServer(async ({ base, dataDir }) => {
    const hp = readHostPassword(dataDir);
    // 主人名下的世界：本机直连（主人）创建，归属 host。
    const w = await req(base, 'POST', '/api/worlds', { seed: '主人秘境', name: '主人', appearance: '布衣' });
    assert.equal(w.status, 201, w.text);
    const wid = w.json.id;

    const r = await req(base, 'POST', '/api/login', { mode: 'host', password: hp }, asGuest());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.player.host, true);
    assert.equal(r.json.player.id, 'host');
    const setCookie = r.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('aig_s='));
    const cookie = setCookie.split(';')[0];

    const me = await req(base, 'GET', '/api/me', undefined, asGuest(cookie));
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.host, true);
    assert.equal(me.json.id, 'host');
    assert.equal(me.json.name, '主人');

    const usage = await req(base, 'GET', '/api/usage/today', undefined, asGuest(cookie));
    assert.equal(usage.status, 200, usage.text);
    assert.equal(usage.json.access.hostPassword, hp, '主人用量面板含主人口令');

    const worlds = await req(base, 'GET', '/api/worlds', undefined, asGuest(cookie));
    assert.equal(worlds.status, 200, worlds.text);
    assert.ok(worlds.json.some((x) => x.id === wid), '主人能看到 host 名下的世界');
  });
});

test('主人登录：口令错误 401；与访问密码共用失败计数，连续失败后 429', async () => {
  await withServer(async ({ base, dataDir }) => {
    const hp = readHostPassword(dataDir);
    // 累计 5 次失败（主人口令错 + 访问密码错，同一 IP 共用计数），每次都 401。
    const badHost = await req(base, 'POST', '/api/login', { mode: 'host', password: 'definitely-wrong' }, asGuest());
    assert.equal(badHost.status, 401);
    assert.equal(badHost.text.includes(hp), false, '错误响应不得含主人口令');
    for (let i = 0; i < 3; i++) {
      const x = await req(base, 'POST', '/api/login', { password: 'no', name: 'x' }, asGuest());
      assert.equal(x.status, 401, `访问密码第 ${i + 1} 次应 401`);
    }
    const badHost2 = await req(base, 'POST', '/api/login', { mode: 'host', password: 'no' }, asGuest());
    assert.equal(badHost2.status, 401, '第 5 次仍应 401');
    // 第 6 次：即便用正确主人口令也被限速挡住（证明与访问密码共用计数）。
    const blocked = await req(base, 'POST', '/api/login', { mode: 'host', password: hp }, asGuest());
    assert.equal(blocked.status, 429, blocked.text);
  });
});

test('主人登录：把来客 cookie 的 pid 改成 host 但不改签名 → 不是主人', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookie = await loginGuest(base, dataDir, '小明');
    const forged = tamperPid(cookie, 'host');
    const r = await req(base, 'GET', '/api/me', undefined, asGuest(forged));
    assert.ok(!(r.json && r.json.host === true), '篡改 payload 不得变成主人');
    assert.equal(r.status, 401, '签名不符应视为未登录');
  });
});

test('/api/usage/today：来客不含 hostPassword，主人含', async () => {
  await withServer(async ({ base, dataDir }) => {
    const hp = readHostPassword(dataDir);
    const cookie = await loginGuest(base, dataDir, '小红');
    const guest = await req(base, 'GET', '/api/usage/today', undefined, asGuest(cookie));
    assert.equal(guest.status, 200, guest.text);
    assert.equal('access' in guest.json, false);
    assert.equal(guest.text.includes('hostPassword'), false);
    assert.equal(guest.text.includes(hp), false, '来客响应全文不得含主人口令');

    const host = await req(base, 'GET', '/api/usage/today');
    assert.equal(host.status, 200, host.text);
    assert.equal(host.json.access.hostPassword, hp);
  });
});

test('claim-worlds：主人把玩家世界全部并到 host 名下，来客 403', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookieA = await loginGuest(base, dataDir, '甲');
    const idA = (await guestMe(base, cookieA)).id;
    const w1 = await req(base, 'POST', '/api/worlds', { seed: '甲的世界一', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(w1.status, 201, w1.text);
    const wid1 = w1.json.id;
    // 再登记一个甲名下的世界（无需真实存档，直接写 owners.json）。
    const ownersPath = path.join(dataDir, 'owners.json');
    const owners = ownersJson(dataDir);
    owners['stale-world-2'] = idA;
    fs.writeFileSync(ownersPath, JSON.stringify(owners));

    let list = await req(base, 'GET', '/api/worlds', undefined, asGuest(cookieA));
    assert.ok(list.json.some((x) => x.id === wid1), '收回前甲能看到自己的世界');
    let hostList = await req(base, 'GET', '/api/worlds');
    assert.equal(hostList.json.some((x) => x.id === wid1), false, '收回前主人看不到甲的世界');

    // 来客调用一律 403。
    const denied = await req(base, 'POST', '/api/admin/claim-worlds', { playerId: idA }, asGuest(cookieA));
    assert.equal(denied.status, 403, denied.text);

    // 主人（本机直连）收回。
    const claim = await req(base, 'POST', '/api/admin/claim-worlds', { playerId: idA });
    assert.equal(claim.status, 200, claim.text);
    assert.deepEqual(claim.json.moved.sort(), [wid1, 'stale-world-2'].sort(), '应返回被移动的两个世界');

    const after = ownersJson(dataDir);
    assert.equal(after[wid1], 'host');
    assert.equal(after['stale-world-2'], 'host');

    list = await req(base, 'GET', '/api/worlds', undefined, asGuest(cookieA));
    assert.equal(list.json.some((x) => x.id === wid1), false, '收回后甲看不到');
    hostList = await req(base, 'GET', '/api/worlds');
    assert.ok(hostList.json.some((x) => x.id === wid1), '收回后主人能看到');
  });
});

test('登录过程的 console.log/warn 输出里不含主人口令', async () => {
  await withServer(async ({ base, dataDir }) => {
    const hp = readHostPassword(dataDir);
    const logs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = function () { logs.push(Array.from(arguments).join(' ')); };
    console.warn = function () { logs.push(Array.from(arguments).join(' ')); };
    try {
      await req(base, 'POST', '/api/login', { mode: 'host', password: hp }, asGuest());
      await req(base, 'POST', '/api/login', { mode: 'host', password: 'wrong' }, asGuest());
      await req(base, 'POST', '/api/login', { password: 'no', name: 'x' }, asGuest());
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
    assert.equal(logs.join('\n').includes(hp), false, '日志不得出现主人口令');
  });
});

// ---- 主人 cookie 绑定口令指纹：改口令后旧 cookie 立即失效 ----

test('口令指纹：改口令后旧主人 cookie 失效、新口令可登录，payload 不含明文口令', async () => {
  await withServer(async ({ dataDir }) => {
    const A = 'HostOldPass9aaa';
    const B = 'HostNewPass9bbb';
    // 两次 createAccess 共用 dataDir/access.json 里的同一个 secret，模拟「改口令前后重启」。
    const aA = accessMod.createAccess({ HOST_PASSWORD: A }, dataDir);
    const aB = accessMod.createAccess({ HOST_PASSWORD: B }, dataDir);
    const guest = (cookie) => ({
      headers: cookie ? { 'cf-ray': 'x', cookie } : { 'cf-ray': 'x' },
      socket: { remoteAddress: '8.8.8.8' },
    });

    const old = aA.login(guest(), { mode: 'host', password: A });
    assert.equal(old.status, 200, '用口令 A 应能登录');
    const cookie = old.cookie.split(';')[0];

    // base64url 解码 payload：不含明文口令，含 16 位十六进制指纹 hv。
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const payload = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString('utf8'));
    assert.equal(JSON.stringify(payload).includes(A), false, 'payload 不得含明文旧口令');
    assert.equal(JSON.stringify(payload).includes(B), false, 'payload 不得含明文新口令');
    assert.match(payload.hv, /^[0-9a-f]{16}$/, 'payload 应含 16 位十六进制 hv');

    // 改口令前：aA 认它是主人。
    assert.equal(aA.playerOf(guest(cookie)).host, true);
    // 换成口令 B（重新 createAccess）后：签名仍有效，但 hv 不匹配，按未登录来客处理。
    assert.equal(aB.playerOf(guest(cookie)), null, '改口令后旧 cookie 应视为未登录来客');
    // 用 B 重新登录可以。
    const fresh = aB.login(guest(), { mode: 'host', password: B });
    assert.equal(fresh.status, 200, '用口令 B 应能登录');
    assert.equal(aB.playerOf(guest(fresh.cookie.split(';')[0])).host, true);
  });
});

test('改口令后：旧主人 cookie 在 /api/me 不再是主人、来客被要求登录；新口令可重新登录', async () => {
  const A = 'HostOldPass9aaa';
  const B = 'HostNewPass9bbb';
  await withServer(async ({ base, dataDir }) => {
    // 改口令前（口令 A）的 createAccess 签出旧主人 cookie，与当前服务共用 secret。
    const aA = accessMod.createAccess({ HOST_PASSWORD: A }, dataDir);
    const old = aA.login({ headers: { 'cf-ray': 'x' }, socket: { remoteAddress: '8.8.8.8' } }, { mode: 'host', password: A });
    assert.equal(old.status, 200);
    const oldCookie = old.cookie.split(';')[0];

    // 当前服务已换成口令 B（等价于改口令后重启）：旧 cookie 在 /api/me 不再是主人。
    const stale = await req(base, 'GET', '/api/me', undefined, asGuest(oldCookie));
    assert.equal(stale.status, 401, stale.text);
    assert.ok(!(stale.json && stale.json.host === true), '/api/me 不得 host:true');
    assert.equal(stale.json && stale.json.login, true, '来客头下应被要求登录');

    // 用 B 重新登录可以，/api/me host:true。
    const fresh = await req(base, 'POST', '/api/login', { mode: 'host', password: B }, asGuest());
    assert.equal(fresh.status, 200, fresh.text);
    const newCookie = fresh.headers.get('set-cookie').split(';')[0];
    const me = await req(base, 'GET', '/api/me', undefined, asGuest(newCookie));
    assert.equal(me.status, 200, me.text);
    assert.equal(me.json.host, true);
  }, { HOST_PASSWORD: B });
});
