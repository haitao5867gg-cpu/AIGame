'use strict';

// 回合防重 / 取回（手机切后台、锁屏、换网络后断流的场景）：
// 同一个 clientTurnId 只执行一次；断流后用同一个 ID 走普通 /turn 拿到同一份结果；
// attachOnly 只取回不执行；前端行动、时光推进、刷新取回都带同一个 ID。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIdempotency, validId } = require('../src/idempotency.js');
const { req, parseSSE, postStream, withServer } = require('./helpers/api-helpers.js');

const pub = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');

test('idempotency：并发同一个 key 只执行一次，后来的拿同一份结果', async () => {
  const once = createIdempotency();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = async () => { calls++; await gate; return { n: calls }; };
  const a = once.run('k1', fn);
  const b = once.run('k1', fn);
  assert.equal(once.status('k1'), 'running');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(ra.value, rb.value, '同一个对象');
  assert.equal(ra.replay, false);
  assert.equal(rb.replay, true);
  assert.equal(once.status('k1'), 'done');
  const rc = await once.run('k1', fn);
  assert.equal(calls, 1, '写完后再来直接给缓存');
  assert.equal(rc.value, ra.value);
});

test('idempotency：失败不缓存，同一个 key 再来会重新执行；attach 不认识的 key 返回 undefined', async () => {
  const once = createIdempotency();
  let calls = 0;
  await assert.rejects(once.run('k2', async () => { calls++; throw new Error('模型挂了'); }), /模型挂了/);
  assert.equal(once.status('k2'), null);
  const r = await once.run('k2', async () => { calls++; return 'ok'; });
  assert.equal(r.value, 'ok');
  assert.equal(calls, 2);
  assert.equal(await once.attach('nope'), undefined);
  assert.equal(await once.attach('k2'), 'ok');
});

test('idempotency：过了保留期就忘掉；超出上限先丢最老的已完成项', async () => {
  let t = 1000;
  const once = createIdempotency({ ttlMs: 100, max: 2, now: () => t });
  await once.run('a', async () => 1);
  t += 150;
  assert.equal(once.status('a'), null, '过期');
  await once.run('b', async () => 2);
  await once.run('c', async () => 3);
  await once.run('d', async () => 4);
  assert.ok(once.size() <= 2);
  assert.equal(once.status('b'), null, '最老的被丢掉');
  assert.equal(once.status('d'), 'done');
});

test('validId：只认 8~64 位字母数字 _ -', () => {
  assert.equal(validId('tabc12345'), true);
  assert.equal(validId('short'), false);
  assert.equal(validId('has space 123'), false);
  assert.equal(validId(123456789), false);
  assert.equal(validId('x'.repeat(65)), false);
});

async function newWorld(base) {
  const r = await req(base, 'POST', '/api/worlds', { seed: '雨夜旧港', name: '阿岚' });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
}

test('接口：同一个 clientTurnId 发两次 /turn，只推进一回合，返回同一份结果', async () => {
  await withServer(async ({ base }) => {
    const id = await newWorld(base);
    const cid = 'tresume0001';
    const [r1, r2] = await Promise.all([
      req(base, 'POST', `/api/worlds/${id}/turn`, { action: '推门进去', clientTurnId: cid }),
      req(base, 'POST', `/api/worlds/${id}/turn`, { action: '推门进去', clientTurnId: cid }),
    ]);
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r1.json.state.turn, 1);
    assert.equal(r2.json.state.turn, 1, '第二次是取回，不是又写一回合');
    assert.equal(r1.json.narration, r2.json.narration);
    const w = await req(base, 'GET', `/api/worlds/${id}`);
    assert.equal(w.json.turn, 1, '世界只推进了一回合');

    // 不同 ID（或不带 ID）照常推进
    const r3 = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '再走一步', clientTurnId: 'tresume0002' });
    assert.equal(r3.json.state.turn, 2);
    const r4 = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '不带 ID' });
    assert.equal(r4.json.state.turn, 3);
  });
});

test('接口：流式回合断开后，用同一个 ID 走普通 /turn 取回同一回合（不会写两遍）', async () => {
  await withServer(async ({ base }) => {
    const id = await newWorld(base);
    const cid = 'tstreamcut01';
    // 流式请求读到第一块就断开，模拟手机切后台掐断连接。
    const ctrl = new AbortController();
    const resp = await fetch(base + `/api/worlds/${id}/turn/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: '沿着码头走', clientTurnId: cid }),
      signal: ctrl.signal,
    });
    const reader = resp.body.getReader();
    await reader.read();
    ctrl.abort();
    await reader.read().catch(() => {});
    const r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '沿着码头走', clientTurnId: cid });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state.turn, 1);
    const log = await req(base, 'GET', `/api/worlds/${id}/log`);
    assert.equal(log.json.filter((x) => x.action === '沿着码头走').length, 1, '日志里只有一条这句行动');

    // 流式完整收完后，attachOnly 取回同一份结果
    const s2 = await postStream(base, id, { action: '敲门', clientTurnId: 'tstreamok02' });
    const ev = parseSSE(await s2.text()).find((e) => e.event === 'result');
    const streamed = JSON.parse(ev.data);
    const att = await req(base, 'POST', `/api/worlds/${id}/turn`, { clientTurnId: 'tstreamok02', attachOnly: true });
    assert.equal(att.status, 200, att.text);
    assert.equal(att.json.state.turn, streamed.state.turn);
    assert.equal(att.json.narration, streamed.narration);
  });
});

test('接口：attachOnly 不认识的 ID 返回 404 且不执行；ID 非法 400', async () => {
  await withServer(async ({ base }) => {
    const id = await newWorld(base);
    const r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '不该执行', clientTurnId: 'tunknown001', attachOnly: true });
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'turn_unknown');
    const w = await req(base, 'GET', `/api/worlds/${id}`);
    assert.equal(w.json.turn, 0, '只取回，绝不执行');
    const bad = await req(base, 'POST', `/api/worlds/${id}/turn`, { clientTurnId: 'x', attachOnly: true });
    assert.equal(bad.status, 400);
  });
});

test('前端：行动 / 时光推进带 clientTurnId，断流回退用同一个 ID，进世界会取回上一回合', () => {
  const game = pub('js/game.js');
  assert.match(game, /function newClientTurnId\(/);
  assert.match(game, /streamTurn\(\{ action: action, clientTurnId: cid \}, block\)/);
  assert.match(game, /JSON\.stringify\(\{ action: action, clientTurnId: cid \}\)/);
  assert.match(game, /timeSkip: \{ span: span, plan: plan \}, clientTurnId: cid/);
  assert.match(game, /attachOnly: true/);
  assert.match(game, /resumePendingTurn\(id\)/, 'showGame 进世界时取回');
  assert.match(game, /navigator\.wakeLock/, '等待时保持亮屏');
  assert.match(game, /AbortController/, '断流看门狗');
  const main = pub('js/main.js');
  assert.match(main, /e\.isComposing \|\| e\.keyCode === 229/, '输入法选词时回车不发送');
  const html = pub('index.html');
  assert.match(html, /enterkeyhint="send"/, '手机键盘回车键显示「发送」');
  assert.match(html, /id="btn-latest"/);
  assert.match(html, /data-menu="font"/);
});
