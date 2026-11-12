'use strict';

// 叙事 v3：章节收尾（章摘要 + 规划下一章），排在本回合之后、下一回合之前。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');
const prompts = require('../src/prompts.js');

function makeGame(t, opts) {
  const o = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-v3-ch-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const keys = { LLM_MOCK: '1', DATA_DIR: tmp, LLM_API_KEY: 'sk-V3', NARRATIVE_STYLE: o.style || 'v3' };
  const saved = {};
  for (const k of Object.keys(keys)) { saved[k] = process.env[k]; process.env[k] = keys[k]; }
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  const orig = llm.createClient;
  llm.createClient = function (...args) {
    const c = orig.apply(this, args);
    const real = c.complete;
    c.complete = (q) => {
      if (q.purpose === 'ledger' && o.chapterEnd) {
        return Promise.resolve({ content: JSON.stringify({ time_passes: 1, suggestions: ['a', 'b', 'c'], chapter: { beats_done: [], chapter_end: o.chapterEnd(q) } }), usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }
      if (o.failClose && (q.purpose === 'chapter-close' || q.purpose === 'chapter-plan')) return Promise.reject(new Error('down'));
      return real.call(c, q);
    };
    return c;
  };
  const g = game.createGame(cfg, dataDir);
  llm.createClient = orig;
  const read = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'worlds', id, 'state.json'), 'utf8'));
  const events = (id) => fs.readFileSync(path.join(dataDir, 'worlds', id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { g, read, events };
}

const flush = () => new Promise((r) => setTimeout(r, 30));

test('记账判定收章：下一回合开始时已经是第 2 章，章节回顾有摘要', async (t) => {
  let n = 0;
  const { g, read } = makeGame(t, { chapterEnd: () => { n++; return n === 2; } });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  await g.takeTurn(w.id, { action: '一' });
  await g.takeTurn(w.id, { action: '二' }); // 收章
  const r3 = await g.takeTurn(w.id, { action: '三' });
  assert.equal(r3.state.chapter.index, 2);
  assert.equal(r3.state.chapter.startTurn, 3);
  assert.equal(r3.state.chapters.length, 1);
  assert.equal(r3.state.chapters[0].fromTurn, 1);
  assert.equal(r3.state.chapters[0].toTurn, 2);
  assert.ok(r3.state.chapters[0].summary.length > 20);
  assert.equal(r3.state.chapterTitle, '第2章·续');
  assert.equal(r3.state.outline, undefined);
  const st = read(w.id);
  assert.equal(st.outline.chapters.find((c) => c.index === 2).title, '第2章·续');
});

test('一章满 7 节强制收章；没满且未判定收章时不收', async (t) => {
  const { g, read } = makeGame(t, { chapterEnd: () => false });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  for (let i = 0; i < 6; i++) await g.takeTurn(w.id, { action: '走' + i });
  await flush();
  assert.equal(read(w.id).chapter.index, 1);
  await g.takeTurn(w.id, { action: '第七节' });
  await flush();
  const st = read(w.id);
  assert.equal(st.chapter.index, 2);
  assert.equal(st.chapters[0].toTurn, 7);
});

test('收章调用都失败：照样换章，下一章用大纲原卡或兜底卡，不抛错', async (t) => {
  const { g, read } = makeGame(t, { chapterEnd: () => true, failClose: true });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  await g.takeTurn(w.id, { action: '一' });
  await flush();
  const st = read(w.id);
  assert.equal(st.chapter.index, 2);
  assert.equal(st.chapters[0].summary, '');
  assert.ok(st.outline.chapters.find((c) => c.index === 2));
});

test('撤回触发了收章的回合：章节回到回合前', async (t) => {
  const { g, read } = makeGame(t, { chapterEnd: () => true });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  await g.takeTurn(w.id, { action: '一' });
  await flush();
  assert.equal(read(w.id).chapter.index, 2);
  await g.undoTurn(w.id);
  const st = read(w.id);
  assert.equal(st.chapter.index, 1);
  assert.equal((st.chapters || []).length, 0);
});

test('日志记录带 chapter（只有 index / title）；v2 不收章', async (t) => {
  const { g, events } = makeGame(t, { chapterEnd: () => false });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  await g.takeTurn(w.id, { action: '一' });
  const log = await g.getWorldLog(w.id);
  const rec = log[log.length - 1];
  assert.deepEqual(rec.chapter, { index: 1, title: '搁浅' });
  assert.equal(events(w.id).length, 1);
});

test('v2 世界：没有章节、不收章', async (t) => {
  const { g, read } = makeGame(t, { style: 'v2' });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  await g.takeTurn(w.id, { action: '一' });
  await flush();
  assert.equal(read(w.id).chapter, undefined);
});

test('收章提示词：摘要只依据正文；规划下一章从承接点接着写、读者方向优先', () => {
  const st = { bible: { title: '书' }, chapter: { index: 1 }, outline: { premise: '主线', core_truth: '谜底', volume: { crises: [] }, chapters: [] }, chapters: [{ index: 1, title: '一', summary: '摘要', bridge: '承接' }], threads: ['线索'] };
  const [s1, u1] = prompts.buildChapterCloseMessages(st, [{ turn: 1, action: '走', narration: '正文甲' }], { title: '一' });
  assert.match(s1.content, /只依据正文/);
  assert.match(u1.content, /正文甲/);
  const [s2, u2] = prompts.buildNextChapterMessages(st, { recentRecords: [{ turn: 2, action: '跑', narration: '正文乙' }], dueThreads: ['线索'] });
  assert.match(s2.content, /不要强行拉回原来的计划/);
  assert.match(u2.content, /承接/);
  assert.match(u2.content, /正文乙/);
  assert.match(u2.content, /第 2 章/);
});
