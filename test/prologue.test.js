'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const engine = require('../src/engine.js');
const prompts = require('../src/prompts.js');
const store = require('../src/store.js');
const { req, withServer, asGuest, loginGuest } = require('./helpers/api-helpers.js');

// ---- normalizePrologue 纯函数 ----
test('normalizePrologue：缺字段 / 非字符串 / 空 → null', () => {
  assert.equal(engine.normalizePrologue(null), null);
  assert.equal(engine.normalizePrologue(undefined), null);
  assert.equal(engine.normalizePrologue('x'), null);
  assert.equal(engine.normalizePrologue({ world: '甲', me: '乙', goal: '丙' }), null, '缺 now');
  assert.equal(engine.normalizePrologue({ world: '甲', me: '乙', goal: '丙', now: 123 }), null, 'now 非字符串');
  assert.equal(engine.normalizePrologue({ world: '甲', me: 5, goal: '丙', now: '丁' }), null, 'me 非字符串');
  assert.equal(engine.normalizePrologue({ world: '甲', me: '乙', goal: '丙', now: '   ' }), null, 'now 为空');
  assert.equal(engine.normalizePrologue({ world: '   ', me: '乙', goal: '丙', now: '丁' }), null, 'world 为空');
});

test('normalizePrologue：去空白并超长截断', () => {
  const p = engine.normalizePrologue({
    world: '  ' + '世'.repeat(300) + '  ',
    me: '我'.repeat(260),
    goal: '愿'.repeat(150),
    now: '今'.repeat(200),
  });
  assert.ok(p);
  assert.equal(p.world.length, 240);
  assert.equal(p.me.length, 200);
  assert.equal(p.goal.length, 120);
  assert.equal(p.now.length, 160);
  assert.equal(p.world.startsWith('  '), false, '应去掉首尾空白');
});

test('normalizePrologue：正常返回四段', () => {
  assert.deepEqual(
    engine.normalizePrologue({ world: '甲', me: '乙', goal: '丙', now: '丁' }),
    { world: '甲', me: '乙', goal: '丙', now: '丁' },
  );
});

// ---- 第一幕衔接 ----
test('第一回合 messages 含「这是第一幕」，第二回合不含', () => {
  const mk = (turn) => ({
    turn,
    bible: {},
    character: { name: '旅人', appearance: '', attrs: {}, items: [] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    facts: [], threads: [], fadedThreads: [], apex: {},
    highlightUntilTurn: 0, location: '', clock: { day: 1, period: '清晨' },
  });
  const first = prompts.buildTurnMessages(mk(0), { nextTurn: 1 }, '探查');
  const second = prompts.buildTurnMessages(mk(1), { nextTurn: 2 }, '探查');
  assert.match(first[0].content, /这是第一幕/);
  assert.doesNotMatch(second[0].content, /这是第一幕/);
});

// ---- 接口 ----
test('mock 建世界后 GET /api/worlds/:id 的 bible.prologue 有四段', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/worlds', { seed: '雾港', name: '甲', appearance: '布衣' });
    assert.equal(r.status, 201, r.text);
    const g = await req(base, 'GET', `/api/worlds/${r.json.id}`);
    assert.equal(g.status, 200, g.text);
    const p = g.json.bible.prologue;
    assert.ok(p, 'bible 应自带 prologue');
    for (const key of ['world', 'me', 'goal', 'now']) {
      assert.equal(typeof p[key], 'string', `${key} 应为字符串`);
      assert.ok(p[key].length > 0, `${key} 不应为空`);
    }
  });
});

test('删掉 state.json 里的 prologue 后 GET /prologue 补生成写回，第二次不再调用 LLM', async () => {
  await withServer(async ({ base, dataDir }) => {
    const r = await req(base, 'POST', '/api/worlds', { seed: '旧港', name: '甲', appearance: '布衣' });
    const id = r.json.id;
    const stateFile = store.statePath(dataDir, id);
    const usageFile = store.usagePath(dataDir);

    // 直接改 DATA_DIR 下的 state.json，删掉 prologue 模拟老世界
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    delete state.bible.prologue;
    fs.writeFileSync(stateFile, JSON.stringify(state));

    // 只数带 purpose 的行（LLM 调用）；异步出图写的是无 purpose 的 image 行，不混入统计。
    const rows = () => fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const llmCalls = () => rows().filter((x) => typeof x.purpose === 'string').length;
    const prologueCalls = () => rows().filter((x) => x.purpose === 'prologue').length;

    const beforePrologueCalls = prologueCalls();
    const p1 = await req(base, 'GET', `/api/worlds/${id}/prologue`);
    assert.equal(p1.status, 200, p1.text);
    assert.ok(p1.json.prologue, '应补出 prologue');
    for (const key of ['world', 'me', 'goal', 'now']) {
      assert.equal(typeof p1.json.prologue[key], 'string', `${key} 应为字符串`);
    }
    assert.equal(prologueCalls(), beforePrologueCalls + 1, '补生成应恰好调用一次序章模型');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(saved.bible.prologue, '应写回 state.json');

    const afterFirst = llmCalls();
    const p2 = await req(base, 'GET', `/api/worlds/${id}/prologue`);
    assert.equal(p2.status, 200, p2.text);
    assert.deepEqual(p2.json.prologue, p1.json.prologue, '第二次应返回同一份');
    assert.equal(prologueCalls(), beforePrologueCalls + 1, '第二次不应再补生成');
    assert.equal(llmCalls(), afterFirst, '已有时不应再调用 LLM（LLM 用量行数不变）');
  });
});

test('别人的世界 GET /prologue 返回 404', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const r = await req(base, 'POST', '/api/worlds',
      { seed: '甲的世界', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(r.status, 201, r.text);
    const x = await req(base, 'GET', `/api/worlds/${r.json.id}/prologue`, undefined, asGuest(cookieB));
    assert.equal(x.status, 404, '越权访问 prologue 应 404');
    assert.deepEqual(x.json, { error: '世界不存在' });
  });
});
