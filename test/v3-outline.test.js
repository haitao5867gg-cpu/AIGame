'use strict';

// 叙事 v3 第一块：隐藏大纲、开场时辰、本世前文、读过/没读过的事实。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');
const engine = require('../src/engine.js');
const prompts = require('../src/prompts.js');
const outline = require('../src/outline.js');
const { buildStoryHistory } = require('../src/history.js');

const SAVE = path.join(__dirname, '..', 'reports', 'continuity-20261112', 'world-wdd0bd51213c84772.json');

function makeGame(t, extraEnv, wrapComplete) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-v3-outline-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const keys = { LLM_MOCK: '1', DATA_DIR: tmp, LLM_API_KEY: 'sk-V3-TEST', NARRATIVE_STYLE: 'v3', ...(extraEnv || {}) };
  const saved = {};
  for (const k of Object.keys(keys)) { saved[k] = process.env[k]; process.env[k] = keys[k]; }
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  let g;
  if (wrapComplete) {
    const orig = llm.createClient;
    llm.createClient = function (...args) {
      const c = orig.apply(this, args);
      const real = c.complete;
      c.complete = (o) => wrapComplete(o, () => real.call(c, o));
      return c;
    };
    g = game.createGame(cfg, dataDir);
    llm.createClient = orig;
  } else {
    g = game.createGame(cfg, dataDir);
  }
  return { g, dataDir, cfg };
}

function readState(dataDir, id) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'worlds', id, 'state.json'), 'utf8'));
}

// ---- normalizeOutline ----
test('normalizeOutline：合法保留、截断、章卡重排、无章卡返回 null', () => {
  const o = outline.normalizeOutline({
    premise: '主线'.repeat(50),
    chapters: [
      null,
      { title: '很长很长很长很长的章名一二三', goal: '目标', beats: ['a', 'b', 'c', 'd', 'e'], avoid: ['x', 'y', 'z', 'w'] },
      { title: '第二', goal: '目标二' },
    ],
  });
  assert.ok(o);
  assert.equal(o.premise.length, 60);
  assert.deepEqual(o.chapters.map((c) => c.index), [1, 2]);
  assert.equal(o.chapters[0].title.length, 10);
  assert.equal(o.chapters[0].beats.length, 4);
  assert.equal(o.chapters[0].avoid.length, 3);
  assert.equal(outline.normalizeOutline({ chapters: [] }), null);
  assert.equal(outline.normalizeOutline(null), null);
  assert.equal(outline.currentCard({ outline: o, chapter: { index: 2 } }).title, '第二');
  assert.equal(outline.currentCard({ chapter: { index: 1 } }), null);
});

// ---- buildOutlineMessages ----
test('buildOutlineMessages：新世界与老世界两种输入', () => {
  const state = { genre: 'urban', bible: { title: '书名X', rules: ['规则甲'], npcs: [{ name: '甲', want: '想要甲' }], start: { situation: '开场X' } }, character: { name: '主角' } };
  const [sys, user] = prompts.buildOutlineMessages(state, {});
  assert.match(sys.content, /信号/);
  assert.match(sys.content, /4~6 回合/);
  assert.match(sys.content, /不要写死主角的具体行动/);
  assert.match(user.content, /书名X/);
  assert.match(user.content, /想要甲/); // 作者笔记可以给隐秘想法
  assert.doesNotMatch(user.content, /已经发生的故事/);
  const [, user2] = prompts.buildOutlineMessages(state, { history: { text: '第 1 回合　你：走\n正文' } });
  assert.match(user2.content, /已经发生的故事/);
  assert.match(user2.content, /第 1 张章卡就是正在进行的这一章/);
});

// ---- 建世界 ----
test('v3 建世界：生成合法大纲、chapter=1，公开接口与导出都不含 outline', async (t) => {
  const { g, dataDir } = makeGame(t);
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人', appearance: '灰袍' });
  const st = readState(dataDir, w.id);
  assert.ok(outline.normalizeOutline(st.outline));
  assert.equal(st.chapter.index, 1);
  assert.equal(st.chapter.startTurn, 1);
  assert.equal(w.outline, undefined);
  const pub = await g.getWorld(w.id);
  assert.equal(pub.outline, undefined);
  assert.equal(pub.chapter.index, 1);
  const exp = g.exportWorld(w.id);
  assert.equal(JSON.stringify(exp).includes('core_truth'), false);
  assert.equal(engine.toPublicState({ outline: { a: 1 }, threadMeta: {}, _chapterUndo: {} }).outline, undefined);
});

test('v3 建世界：大纲调用失败时世界照样建成、无 outline', async (t) => {
  const { g, dataDir } = makeGame(t, null, (o, real) => {
    if (o && o.purpose === 'outline') return Promise.reject(new Error('boom'));
    return real();
  });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  const st = readState(dataDir, w.id);
  assert.equal(st.outline, undefined);
});

test('v2 建世界：不生成大纲', async (t) => {
  const { g, dataDir } = makeGame(t, { NARRATIVE_STYLE: 'v2' });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人' });
  assert.equal(readState(dataDir, w.id).outline, undefined);
});

// ---- 开场时辰 ----
test('createWorld：bible.start.period 决定开场时段，非法回退清晨', () => {
  const base = { id: 'wtest', bible: { start: { place: '天台', period: '深夜', situation: '雨夜' } } };
  assert.equal(engine.createWorld(base, { rng: () => 0.5, now: 1 }).clock.period, '深夜');
  const bad = { id: 'wtest', bible: { start: { place: '天台', period: '半夜' } } };
  assert.equal(engine.createWorld(bad, { rng: () => 0.5, now: 1 }).clock.period, '清晨');
  assert.match(prompts.buildWorldMessages('一句话', {})[0].content, /start\.period/);
});

// ---- 本世前文 ----
function fixture() {
  return {
    state: {
      life: 1,
      bible: { start: { situation: '开场：天台来电。' } },
      chronicle: [{ fromTurn: 1, toTurn: 1, summary: '第一回合的摘要' }],
    },
    events: [
      { turn: 1, life: 1, action: '接电话', narration: '第一回合正文，天台的水箱在雨里泛着湿光。' },
      { turn: 2, life: 1, action: '回拨', narration: '第二回合正文' },
      { turn: 3, life: 1, action: '被撤回的行动', narration: '被撤回的正文' },
      { type: 'undo', undoneTurn: 3 },
      { turn: 3, life: 1, action: '新行动', narration: '第三回合正文' },
    ],
  };
}

test('buildStoryHistory：开场 + 全部可见回合，撤回的不出现', () => {
  const { state, events } = fixture();
  const h = buildStoryHistory(events, state, {});
  assert.match(h.text, /开场：天台来电/);
  assert.match(h.text, /第 1 回合　你：接电话/);
  assert.match(h.text, /第三回合正文/);
  assert.doesNotMatch(h.text, /被撤回的正文/);
  assert.equal(h.coveredFrom, 1);
});

test('buildStoryHistory：预算小时只留最新回合，更早的用摘要；上一世不出现；重生用 rebirthOpening', () => {
  const { state, events } = fixture();
  const h = buildStoryHistory(events, state, { budget: 30 });
  assert.match(h.text, /更早的经过（摘要）/);
  assert.match(h.text, /第一回合的摘要/);
  assert.match(h.text, /第三回合正文/);
  assert.doesNotMatch(h.text, /第一回合正文/);
  const s2 = { life: 2, rebirthOpening: '新一世开场', bible: state.bible };
  const ev2 = events.concat([{ turn: 4, life: 2, action: '醒来', narration: '第二世正文' }]);
  const h2 = buildStoryHistory(ev2, s2, {});
  assert.match(h2.text, /新一世开场/);
  assert.match(h2.text, /第二世正文/);
  assert.doesNotMatch(h2.text, /第一回合正文/);
});

test('buildStoryHistory：用玩家真实存档（文件存在时）', (t) => {
  if (!fs.existsSync(SAVE)) { t.skip('reports/ 不在仓库里'); return; }
  const w = JSON.parse(fs.readFileSync(SAVE, 'utf8'));
  const h = buildStoryHistory(w.events, w.state, {});
  assert.match(h.text, /天台的水箱在雨里泛着湿光/);
  assert.match(h.text, /纸箱里那部不知道从哪来的旧手机/);
});

// ---- 读过 / 没读过 ----
test('splitFacts：第 1 回合后「零点到三点」读者还不知道，「三分钟倒计时」已经知道', () => {
  const visible = [
    '你刚被公司裁员，抱着纸箱回到租住的旧公寓，在天台抽最后一根烟时，旧手机突然亮了。',
    '「时间不多。三分钟。」你盯着手机右上角，那里本该是信号格子，此刻空着，只有一小截倒计时在跳。屏幕上「来电：十年后的叶峰」。旧手机。',
  ].join('\n');
  const r = prompts.splitFacts([
    { text: '手机只在深夜零点到三点之间能接通' },
    { text: '旧手机通话上限为三分钟，屏幕上会出现倒计时' },
    '「天眼」公司',
  ], visible + '天眼');
  assert.deepEqual(r.unseen, ['手机只在深夜零点到三点之间能接通']);
  assert.ok(r.seen.includes('旧手机通话上限为三分钟，屏幕上会出现倒计时'));
  assert.ok(r.seen.includes('「天眼」公司'));
  assert.equal(prompts.factSeen('任何事', ''), false);
});

test('回指规则与「规则读者不知道」提醒都进了 v2 回合提示词', () => {
  const st = engine.createWorld({ id: 'wtest', bible: { title: 't', rules: ['规则一'], start: { place: '甲' } } }, { rng: () => 0.5, now: 1 });
  const msgs = prompts.buildTurnMessages(st, engine.planTurn(st, { rng: () => 0.5 }), '走', {});
  const all = msgs.map((m) => m.content).join('\n');
  assert.match(all, /你没听漏/);
  assert.match(all, /正文没写过之前读者并不知道/);
  assert.match(all, /最近六回合/); // v2 前文段不变
});

test('env：NARRATIVE_STYLE 只认 v1/v2/v3，STORY_MODEL 默认取 LLM_MODEL_WORLD', () => {
  const cfg = env.load(path.join(os.tmpdir(), 'no-such-env-file'), { NARRATIVE_STYLE: 'V3', LLM_MODEL_WORLD: 'pro-x', LLM_MODEL: 'flash-x' });
  assert.equal(cfg.NARRATIVE_STYLE, 'v3');
  assert.equal(cfg.STORY_MODEL, 'pro-x');
  assert.equal(cfg.STORY_LEDGER_MODEL, 'flash-x');
  assert.equal(cfg.STORY_HISTORY_BUDGET, 30000);
  assert.equal(env.load(path.join(os.tmpdir(), 'no-such-env-file'), { NARRATIVE_STYLE: 'v9' }).NARRATIVE_STYLE, 'v3'); // 非法值回退默认 v3
});
