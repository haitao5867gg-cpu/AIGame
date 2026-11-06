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

// ---- 各自存档隔离 ----
test('各自存档隔离：来客只见自己的世界，越权访问带世界 id 的接口一律 404，图片文件仍共享', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const idA = (await guestMe(base, cookieA)).id;

    // A 建世界，owners.json 记录归属
    let r = await req(base, 'POST', '/api/worlds', { seed: 'A 的世界', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(r.status, 201, r.text);
    const wid = r.json.id;
    const ownersPath = path.join(dataDir, 'owners.json');
    const readOwners = () => JSON.parse(fs.readFileSync(ownersPath, 'utf8'));
    assert.equal(readOwners()[wid], idA, '建世界后 owners.json 应记录归属');

    // A 的列表只含自己的
    r = await req(base, 'GET', '/api/worlds', undefined, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.map((w) => w.id), [wid]);

    // 造一个「老世界」：主人建后抹掉 owners.json 记录，模拟无归属记录的旧存档
    const hr = await req(base, 'POST', '/api/worlds', { seed: '老存档', name: '旧旅人', appearance: '布衣' });
    assert.equal(hr.status, 201, hr.text);
    const legacyId = hr.json.id;
    const owners = readOwners();
    delete owners[legacyId];
    fs.writeFileSync(ownersPath, JSON.stringify(owners));

    // 主人：看不到 A 的世界，但能看到无归属记录的老世界
    r = await req(base, 'GET', '/api/worlds');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.some((w) => w.id === wid), false, '主人不应看到来客 A 的世界');
    assert.equal(r.json.some((w) => w.id === legacyId), true, '主人应能看到无归属记录的老世界');

    // B：看不到 A 的世界，也看不到归属 host 的老世界
    r = await req(base, 'GET', '/api/worlds', undefined, asGuest(cookieB));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.some((w) => w.id === wid), false);
    assert.equal(r.json.some((w) => w.id === legacyId), false);

    // B 越权访问 A 的世界：所有带 id 的接口一律 404（不泄露存在）
    const attempts = [
      ['GET', `/api/worlds/${wid}`],
      ['GET', `/api/worlds/${wid}/images`],
      ['GET', `/api/worlds/${wid}/export`],
      ['GET', `/api/worlds/${wid}/log`],
      ['POST', `/api/worlds/${wid}/turn`],
      ['POST', `/api/worlds/${wid}/rebirth`],
      ['POST', `/api/worlds/${wid}/undo`],
      ['DELETE', `/api/worlds/${wid}`],
    ];
    for (const [m, p] of attempts) {
      const x = await req(base, m, p, m === 'POST' ? { action: 'x' } : undefined, asGuest(cookieB));
      assert.equal(x.status, 404, `${m} ${p} 越权应 404，实际 ${x.status}`);
      assert.deepEqual(x.json, { error: '世界不存在' });
    }

    // 流式回合：开流之前校验，越权返回 404 JSON，而非 SSE 流
    const sres = await fetch(base + `/api/worlds/${wid}/turn/stream`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, asGuest(cookieB)),
      body: JSON.stringify({ action: 'x' }),
    });
    assert.equal(sres.status, 404);
    assert.equal((sres.headers.get('content-type') || '').includes('text/event-stream'), false, '越权不应开流');
    assert.deepEqual(await sres.json(), { error: '世界不存在' });

    // 图片文件保持共享：B 虽不拥有任何世界，仍可取到图片
    const imgDir = path.join(dataDir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'item-abcdef012345.jpg'), Buffer.from('JPEG'));
    const imgRes = await fetch(base + '/api/images/item-abcdef012345.jpg', { headers: asGuest(cookieB) });
    assert.equal(imgRes.status, 200, '图片文件保持共享，不校验归属');

    // A 仍能正常访问自己的世界（B 的越权 DELETE 没有误删）
    r = await req(base, 'GET', `/api/worlds/${wid}`, undefined, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);
    r = await req(base, 'POST', `/api/worlds/${wid}/turn`, { action: 'A 自己的回合' }, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);

    // A 删除自己的世界后，owners.json 里的归属记录被移除
    r = await req(base, 'DELETE', `/api/worlds/${wid}`, undefined, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);
    assert.equal(wid in readOwners(), false, '删除后应移除 owners.json 归属记录');
  });
});

// ---- 每人每日 token 上限 ----
test('每人每日上限：某玩家今日用到上限后 LLM 调用返回 429，其他玩家和主人不受影响', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const idA = (await guestMe(base, cookieA)).id;

    // 预置：A 今天已用到上限（本测试把每人上限设为 50）
    fs.writeFileSync(store.usagePath(dataDir), JSON.stringify({
      ts: Date.now(), model: 'm', purpose: 'turn',
      prompt_tokens: 100, completion_tokens: 0, playerId: idA, ok: true,
    }) + '\n');

    // A 再触发 LLM（mock 建世界）→ 429
    let r = await req(base, 'POST', '/api/worlds', { seed: 'A 超限', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(r.status, 429, r.text);
    assert.match(r.json.error, /你今天的 token 用量已达上限 50，明天再来吧/);

    // B 不受影响
    r = await req(base, 'POST', '/api/worlds', { seed: 'B 正常', name: '乙', appearance: '布衣' }, asGuest(cookieB));
    assert.equal(r.status, 201, r.text);

    // 主人不受影响
    r = await req(base, 'POST', '/api/worlds', { seed: '主人正常', name: '主人', appearance: '锦衣' });
    assert.equal(r.status, 201, r.text);
  }, { LLM_PLAYER_DAILY_TOKEN_LIMIT: 50 });
});

test('每人每日上限：LLM_PLAYER_DAILY_TOKEN_LIMIT=0 表示不限', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookie = await loginGuest(base, dataDir, '甲');
    const id = (await guestMe(base, cookie)).id;
    fs.writeFileSync(store.usagePath(dataDir), JSON.stringify({
      ts: Date.now(), model: 'm', purpose: 'turn',
      prompt_tokens: 999999, completion_tokens: 0, playerId: id, ok: true,
    }) + '\n');
    const r = await req(base, 'POST', '/api/worlds', { seed: '不限', name: '甲', appearance: '布衣' }, asGuest(cookie));
    assert.equal(r.status, 201, r.text);
  }, { LLM_PLAYER_DAILY_TOKEN_LIMIT: 0 });
});

// ---- /api/usage/today 主人 / 来客 ----
test('/api/usage/today：来客不含 global/players/access 且全文无密码；主人含 access.players.global.tunnel', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const idA = (await guestMe(base, cookieA)).id;
    const idB = (await guestMe(base, cookieB)).id;

    const now = Date.now();
    const rows = [
      { ts: now - 1000, model: 'm', purpose: 'turn', prompt_tokens: 100, completion_tokens: 20, playerId: idA, ok: true },
      { ts: now - 2000, model: 'm', purpose: 'turn', prompt_tokens: 50, completion_tokens: 5, playerId: idB, ok: true },
      { ts: now - 3000, model: 'm', purpose: 'turn', prompt_tokens: 7, completion_tokens: 3, ok: true }, // 无 playerId → host
    ];
    fs.writeFileSync(store.usagePath(dataDir), rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const pw = readAccessPassword(dataDir);

    // 来客 A
    let r = await req(base, 'GET', '/api/usage/today', undefined, asGuest(cookieA));
    assert.equal(r.status, 200, r.text);
    for (const f of ['global', 'players', 'access', 'tunnel']) {
      assert.equal(f in r.json, false, `来客响应不应含 ${f}`);
    }
    assert.equal(r.text.includes(pw), false, '来客响应全文不得含访问密码');
    assert.equal(r.json.tokens.total, 120, '来客只统计自己的 token');
    assert.equal(r.json.tokens.limit, 1000000, '来客用每人上限');

    // 主人
    r = await req(base, 'GET', '/api/usage/today');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.access, '主人响应应含 access');
    assert.equal(r.json.access.password, pw, 'access.password 应等于 access.json 里的密码');
    assert.ok(r.json.global, '主人响应应含 global');
    assert.equal(r.json.global.total, 185, 'global 为全局今日 token');
    assert.equal(r.json.global.limit, 2000000, 'global 用全局上限');
    assert.ok(Array.isArray(r.json.players));
    const names = r.json.players.map((p) => p.name);
    assert.ok(names.includes('主人'), 'players 含 host（主人）');
    assert.ok(names.includes('甲'), 'players 含甲');
    assert.ok(names.includes('乙'), 'players 含乙');
    const totals = r.json.players.map((p) => p.total);
    assert.deepEqual(totals, totals.slice().sort((a, b) => b - a), 'players 按 total 降序');
    assert.ok(r.json.tunnel && r.json.tunnel.url === null);
  });
});
