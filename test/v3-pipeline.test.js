'use strict';

// 叙事 v3：纯文本流式与思考进度、按次请求参数、写作模式、两步回合（写正文 → 记账 → 结算）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');
const engine = require('../src/engine.js');
const prefs = require('../src/prefs.js');
const { writingCall, ledgerCall } = require('../src/writing-mode.js');

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-v3-pipe-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function realClient(t, extra) {
  return llm.createClient(Object.assign({
    LLM_MOCK: false, LLM_BASE: 'https://example.test/v1', LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'm', LLM_TIMEOUT_MS: 5000, LLM_DAILY_TOKEN_LIMIT: 0, LLM_EXTRA_BODY: '',
  }, extra || {}), tmpDir(t));
}

function fakeSse(t, chunks, capture) {
  const original = global.fetch;
  let sse = '';
  for (const c of chunks) sse += 'data: ' + JSON.stringify(c) + '\n\n';
  sse += 'data: [DONE]\n\n';
  global.fetch = async (url, opts) => {
    capture.body = JSON.parse(opts.body);
    return { ok: true, body: (async function* () { yield new TextEncoder().encode(sse); })() };
  };
  t.after(() => { global.fetch = original; });
}

// ---- LLM 底层 ----
test('按次请求参数：叠在全局 LLM_EXTRA_BODY 上，null 删除键，model/messages 不可被覆盖', async (t) => {
  const cap = {};
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    cap.body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  t.after(() => { global.fetch = original; });
  const c = realClient(t, { LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"top_p":0.9,"reasoning_effort":"high"}' });
  await c.complete({ purpose: 'turn', model: 'mm', messages: [{ role: 'user', content: 'x' }], extraBody: { thinking: { type: 'enabled' }, reasoning_effort: null, model: 'evil' } });
  assert.deepEqual(cap.body.thinking, { type: 'enabled' });
  assert.equal(cap.body.top_p, 0.9);
  assert.equal('reasoning_effort' in cap.body, false);
  assert.equal(cap.body.model, 'mm');
});

test('纯文本流式：正文片段原样回调，思考只回调字数、不进返回值', async (t) => {
  const cap = {};
  fakeSse(t, [
    { choices: [{ delta: { reasoning_content: '作者在想核心谜底是……' } }] },
    { choices: [{ delta: { reasoning_content: '再想一下' } }] },
    { choices: [{ delta: { content: '你推开门，' } }] },
    { choices: [{ delta: { content: '雨停了。' } }] },
    { usage: { prompt_tokens: 10, completion_tokens: 20 }, choices: [] },
  ], cap);
  const c = realClient(t);
  const deltas = [];
  const thinking = [];
  const res = await c.completeStream({
    purpose: 'story', model: 'm', messages: [{ role: 'user', content: 'x' }],
    plainText: true, onThinking: (n) => thinking.push(n), extraBody: { reasoning_effort: 'low' },
  }, (d) => deltas.push(d));
  assert.deepEqual(deltas, ['你推开门，', '雨停了。']);
  assert.equal(res.content, '你推开门，雨停了。');
  assert.ok(thinking.length >= 1 && thinking[0] > 0);
  assert.doesNotMatch(JSON.stringify(res), /核心谜底/);
  assert.equal(cap.body.response_format.type, 'text');
  assert.equal(cap.body.reasoning_effort, 'low');
  assert.equal(cap.body.stream, true);
  assert.equal(res.usage.completion_tokens, 20);
});

test('JSON 流式照旧走叙事解码器（v2 不受影响）', async (t) => {
  const cap = {};
  fakeSse(t, [{ choices: [{ delta: { content: '{"narration":"甲乙' } }] }, { choices: [{ delta: { content: '丙"}' } }] }], cap);
  const deltas = [];
  const res = await realClient(t).completeStream({ purpose: 'turn', model: 'm', messages: [] }, (d) => deltas.push(d));
  assert.equal(deltas.join(''), '甲乙丙');
  assert.equal(JSON.parse(res.content).narration, '甲乙丙');
  assert.equal(cap.body.response_format.type, 'json_object');
});

test('mock：story 纯文本正文、ledger 无 narration、思考回调在正文之前', async (t) => {
  const c = llm.createClient({ LLM_MOCK: true, LLM_MODEL: 'm', LLM_DAILY_TOKEN_LIMIT: 0, LLM_EXTRA_BODY: '' }, tmpDir(t));
  const order = [];
  const res = await c.completeStream({ purpose: 'story', model: 'm', messages: [], plainText: true, mock: { action: '敲门' }, onThinking: () => order.push('think') }, (d) => order.push('delta'));
  assert.equal(order[0], 'think');
  assert.match(res.content, /敲门/);
  assert.doesNotMatch(res.content, /^\{/);
  const l = await c.complete({ purpose: 'ledger', model: 'm', messages: [], mock: { turn: 1 } });
  const parsed = JSON.parse(l.content);
  assert.equal('narration' in parsed, false);
  assert.ok(Array.isArray(parsed.suggestions));
});

// ---- 写作模式 ----
test('写作模式：默认精写；三种模式的模型与请求参数；记账关思考', () => {
  const cfg = { STORY_MODEL: 'pro', LLM_MODEL: 'flash', STORY_LEDGER_MODEL: 'flash2' };
  assert.deepEqual(writingCall(cfg, 'fine').extraBody, { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  assert.equal(writingCall(cfg, 'deep').extraBody.reasoning_effort, null);
  assert.deepEqual(writingCall(cfg, 'fast').extraBody.thinking, { type: 'disabled' });
  assert.equal(writingCall(cfg, 'bogus').mode, 'fine');
  assert.equal(writingCall(cfg, 'fine').model, 'pro');
  assert.equal(writingCall({ LLM_MODEL_WORLD: 'w' }, 'fine').model, 'w');
  assert.deepEqual(ledgerCall(cfg), { model: 'flash2', extraBody: { thinking: { type: 'disabled' }, reasoning_effort: null } });
});

test('偏好：writing 默认 fine、合法值保存、非法忽略、不动其他偏好', (t) => {
  const d = tmpDir(t);
  assert.equal(prefs.getPrefs(d, 'host').writing, 'fine');
  prefs.setPrefs(d, 'host', { atmosphere: { reading: 'paper' } });
  assert.equal(prefs.setPrefs(d, 'host', { writing: 'deep' }).writing, 'deep');
  prefs.setPrefs(d, 'host', { writing: 'turbo' });
  const p = prefs.getPrefs(d, 'host');
  assert.equal(p.writing, 'deep');
  assert.equal(p.atmosphere.reading, 'paper');
  assert.equal(prefs.getPrefs(d, 'friend').writing, 'fine');
});

// ---- 引擎 storyMode ----
test('planTurn storyMode：不开事件 / 不预兆 / 不转折 / 不压编年史，进行中事件照常结算', () => {
  const s = engine.createWorld({ id: 'wtest', bible: { start: { place: '甲' } } }, { rng: () => 0.5, now: 1 });
  s.turn = 19; s.nextEventTurn = 20; s.nextTwistTurn = 20;
  const p = engine.planTurn(s, { rng: () => 0.01, storyMode: true });
  assert.equal(p.opening, false); assert.equal(p.omen, false); assert.equal(p.twist, null); assert.equal(p.needChapter, false);
  s.activeEvent = { theme: '天灾', title: '洪水', startedTurn: 18 };
  assert.equal(engine.planTurn(s, { storyMode: true }).settling, true);
});

test('resolveTurn storyMode：伏笔满 5 条拒收新线索、不淡去；正文上限放宽到 2400', () => {
  const s = engine.createWorld({ id: 'wtest', bible: { start: { place: '甲' } } }, { rng: () => 0.5, now: 1 });
  s.threads = ['一', '二', '三', '四', '五'];
  const plan = engine.planTurn(s, { storyMode: true });
  const long = '字'.repeat(1700);
  const r = engine.resolveTurn(s, { action: '走', plan, proposal: { narration: long, threads_add: ['六'] } }, { rng: () => 0.5, now: 2, storyMode: true });
  assert.deepEqual(r.state.threads, ['一', '二', '三', '四', '五']);
  assert.equal(r.state.fadedThreads.length, 0);
  assert.equal(r.result.narration.length, 1700);
  const r2 = engine.resolveTurn(s, { action: '走', plan: engine.planTurn(s, {}), proposal: { narration: long, threads_add: ['六'] } }, { rng: () => 0.5, now: 2 });
  assert.equal(r2.result.narration.length, 1200); // v2 不变
  assert.ok(r2.state.threads.includes('六'));
});

// ---- 两步回合 ----
function makeGame(t, wrap) {
  const tmp = tmpDir(t);
  const keys = { LLM_MOCK: '1', DATA_DIR: tmp, LLM_API_KEY: 'sk-V3', NARRATIVE_STYLE: 'v3' };
  const saved = {};
  for (const k of Object.keys(keys)) { saved[k] = process.env[k]; process.env[k] = keys[k]; }
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  const calls = [];
  const orig = llm.createClient;
  llm.createClient = function (...args) {
    const c = orig.apply(this, args);
    const realComplete = c.complete;
    const realStream = c.completeStream;
    c.complete = (o) => { calls.push({ kind: 'complete', o }); return wrap && wrap.complete ? wrap.complete(o, () => realComplete.call(c, o)) : realComplete.call(c, o); };
    c.completeStream = (o, d) => { calls.push({ kind: 'stream', o }); return realStream.call(c, o, d); };
    return c;
  };
  const g = game.createGame(cfg, dataDir);
  llm.createClient = orig;
  return { g, dataDir, calls };
}

test('v3 回合：纯文本流式、思考进度、记账生效、章节进度、事件记录带 story / chapter', async (t) => {
  const { g, dataDir, calls } = makeGame(t);
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  const deltas = [];
  let thinking = 0;
  const r = await g.takeTurn(w.id, { action: '去钟楼' }, (d) => deltas.push(d), { onThinking: () => { thinking++; } });
  assert.ok(deltas.length > 1);
  assert.doesNotMatch(deltas.join(''), /^\s*\{/);
  assert.equal(deltas.join('').trim(), r.narration);
  assert.ok(thinking >= 1);
  assert.equal(r.state.turn, 1);
  assert.equal(r.state.chapter.turns, 1);
  assert.equal(r.state.outline, undefined);
  assert.ok(Array.isArray(r.suggestions) && r.suggestions.length === 3);
  const story = calls.find((c) => c.kind === 'stream' && c.o.purpose === 'story');
  assert.ok(story && story.o.plainText === true);
  assert.deepEqual(story.o.extraBody, { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  const ledger = calls.find((c) => c.kind === 'complete' && c.o.purpose === 'ledger');
  assert.deepEqual(ledger.o.extraBody, { thinking: { type: 'disabled' }, reasoning_effort: null });
  const ev = fs.readFileSync(path.join(dataDir, 'worlds', w.id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const last = ev[ev.length - 1];
  assert.equal(last.story.style, 'v3');
  assert.equal(last.story.writing, 'fine');
  assert.equal(last.chapter.index, 1);
});

test('v3 回合：写作模式按玩家偏好；快写关思考', async (t) => {
  const { g, dataDir, calls } = makeGame(t);
  prefs.setPrefs(dataDir, 'host', { writing: 'fast' });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  await g.takeTurn(w.id, { action: '走' });
  const story = calls.find((c) => c.kind === 'stream' && c.o.purpose === 'story');
  assert.deepEqual(story.o.extraBody.thinking, { type: 'disabled' });
});

test('v3 回合：记账失败时正文照样落库、标 ledger_failed', async (t) => {
  const { g, dataDir } = makeGame(t, { complete: (o, real) => (o.purpose === 'ledger' ? Promise.reject(new Error('ledger down')) : real()) });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  const r = await g.takeTurn(w.id, { action: '走' });
  assert.equal(r.state.turn, 1);
  assert.ok(r.narration.length > 50);
  const ev = fs.readFileSync(path.join(dataDir, 'worlds', w.id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ev[ev.length - 1].story.ledger_failed, true);
});

test('v3 回合：章末记账给 chapter_end 时标 pendingClose；新线索记预计回收章', async (t) => {
  const { g, dataDir } = makeGame(t, { complete: (o, real) => {
    if (o.purpose !== 'ledger') return real();
    return Promise.resolve({ content: JSON.stringify({ time_passes: 1, suggestions: ['a', 'b', 'c'], threads_add: [{ text: '钟声为何多敲一下', due: 1 }], chapter: { beats_done: [], chapter_end: true } }), usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  await g.takeTurn(w.id, { action: '走' });
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'worlds', w.id, 'state.json'), 'utf8'));
  assert.equal(st.chapter.pendingClose, true);
  assert.deepEqual(st.threadMeta['钟声为何多敲一下'], { plantedTurn: 1, dueChapter: 2 });
});

test('v2 回合不走两步（默认 NARRATIVE_STYLE）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'game.js'), 'utf8');
  assert.match(src, /if \(cfg\.NARRATIVE_STYLE === 'v3' && writingPref !== 'classic'\) \{\s*return takeStoryTurn/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /sseEvent\(res, 'thinking', \{ chars \}\)/);
});

test('v3 回合：记账没写时间就不推进时钟；每回合最多新埋 1 条线索', async (t) => {
  const { g, dataDir } = makeGame(t, { complete: (o, real) => {
    if (o.purpose !== 'ledger') return real();
    return Promise.resolve({ content: JSON.stringify({ suggestions: ['a', 'b', 'c'], threads_add: ['线索甲', '线索乙', { text: '线索丙', due: 1 }] }), usage: { prompt_tokens: 1, completion_tokens: 1 } });
  } });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'worlds', w.id, 'state.json'), 'utf8')).clock;
  await g.takeTurn(w.id, { action: '走' });
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'worlds', w.id, 'state.json'), 'utf8'));
  assert.deepEqual(st.clock, before);
  assert.deepEqual(st.threads, ['线索甲']);
});
