'use strict';

// 叙事 v3 · 修仙题材写法（2026-11-12 对照修仙网文的改动）：
// 文风全文进写手、金手指（作者笔记）与进度、压扬计数、章末「另一边」、大纲/灵感的题材节奏、漏字 bug。
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
const { STORY_STYLES, OUTLINE_NOTES, SUGGEST_NOTES, GENRE_STYLES } = require('../src/genres.js');

const EDGE = {
  name: '残镜',
  look: '胸口一块巴掌大的灰镜片，平时冰凉',
  rules: ['照过的灵草药力翻倍', '每夜子时能照一次', '照活物会反噬心神'],
  cost: '每照一次头疼半日',
  secret: '被人知道会被夺走',
};

function state(genre, extra) {
  const s = engine.createWorld({
    id: 'wxx', genre: genre || 'xuanhuan',
    bible: {
      title: '青霞宗记名弟子', rules: ['灵根分五等'],
      npcs: [{ name: '赵管事', role: '药田管事', desc: '瘦', want: '克扣灵石', voice: '阴阳怪气', rank: '练气七层' }],
      start: { place: '药田', period: '清晨', situation: '你在药田拔草。' },
      prologue: { world: '青霞宗', me: '你是记名弟子', goal: '入外门', now: '清晨' },
    },
    name: '林远',
  }, { rng: () => 0.5, now: 1 });
  return Object.assign(s, extra || {});
}

const card = { index: 1, title: '药田', goal: '站稳脚跟', start: '药田', beats: ['受辱'], end: '得到机会', question: '那株灵草是什么', avoid: [] };
const history = { text: '【开场】\n你在药田拔草。' };

function writer(s, ctx) {
  const [sys, user] = prompts.buildWriterMessages(s, Object.assign({ action: '去后山修炼', history, card, chapterTurn: 2, plan: {} }, ctx || {}));
  return { sys: sys.content, user: user.content };
}

test('修仙文风：写手拿到全文（不再截在 400 字）；其他题材不出现修仙专属写法', () => {
  const x = writer(state('xuanhuan'));
  assert.ok(STORY_STYLES.xuanhuan.length > 400);
  assert.ok(x.sys.includes(STORY_STYLES.xuanhuan), '修仙文风整段进 system');
  assert.match(x.sys, /境界是读者的计分板/);
  assert.match(x.sys, /扬只能来自读者这回合行动的结果/);
  const u = writer(state('urban'));
  assert.ok(u.sys.includes(GENRE_STYLES.urban));
  assert.doesNotMatch(u.sys + u.user, /金手指|计分板/);
  assert.doesNotMatch(u.user, /另一边/);
  // v2 的旧文风不动（老测试依赖「打脸」）。
  assert.match(GENRE_STYLES.xuanhuan, /打脸/);
});

test('修仙篇幅按分量、时光推进修炼要有看得见的结果', () => {
  const x = writer(state('xuanhuan'), { timeSkip: { label: '一季', plan: '闭关冲击练气二层' } });
  assert.match(x.user, /过场[^\n]*300~600/);
  assert.match(x.user, /闭关|修炼/);
  assert.match(x.user, /看得见/);
  const u = writer(state('urban'), { timeSkip: { label: '一季', plan: '找工作' } });
  assert.doesNotMatch(u.user, /300~600/);
});

test('金手指：作者笔记分「已摸清 / 没摸清」，没露过面时提示这一章让它出现', () => {
  const fresh = writer(state('xuanhuan', { edge: EDGE }));
  assert.match(fresh.user, /金手指「残镜」/);
  assert.match(fresh.user, /还没摸清的规律[^\n]*照过的灵草药力翻倍[^\n]*每夜子时能照一次/);
  assert.match(fresh.user, /还没在正文里露过面/);
  assert.match(fresh.user, /每照一次头疼半日/);

  const later = writer(state('xuanhuan', { edge: EDGE, edgeProgress: { shown: true, learned: [0] } }));
  assert.match(later.user, /已经在正文里摸清的规律：照过的灵草药力翻倍/);
  assert.match(later.user, /还没摸清的规律[^\n]*每夜子时能照一次/);
  assert.doesNotMatch(later.user, /还没在正文里露过面/);
  assert.doesNotMatch(later.user.split('还没摸清的规律')[1].split('\n')[0], /药力翻倍/);

  // 金手指只属于修仙：改成别的题材后写手、大纲、记账都不再带它。
  const u = state('urban', { edge: EDGE });
  assert.doesNotMatch(writer(u).user, /残镜/);
  assert.doesNotMatch(prompts.buildOutlineMessages(u, {})[1].content, /残镜/);
  assert.doesNotMatch(prompts.buildLedgerMessages(u, { action: '走', prose: '正文' })[1].content, /残镜/);
  assert.equal(prompts.edgeOf(u), null);
});

test('压扬：连着吃亏 3 节起提醒「该扬一次」，不到 3 节或非修仙不提醒', () => {
  assert.match(writer(state('xuanhuan', { pressure: { streak: 3 } })).user, /连着 3 节只吃亏/);
  assert.doesNotMatch(writer(state('xuanhuan', { pressure: { streak: 2 } })).user, /只吃亏/);
  assert.doesNotMatch(writer(state('urban', { pressure: { streak: 5 } })).user, /只吃亏/);
});

test('章末「另一边」：修仙第 4 节起才允许，用单独一行 * * * 隔开；其他题材没有', () => {
  assert.match(writer(state('xuanhuan'), { chapterTurn: 4 }).user, /另一边[\s\S]*\* \* \*/);
  assert.doesNotMatch(writer(state('xuanhuan'), { chapterTurn: 2 }).user, /另一边/);
  assert.doesNotMatch(writer(state('urban'), { chapterTurn: 4 }).user, /另一边/);
  assert.match(prompts.WRITER_RULES || writer(state('xuanhuan')).sys, /章末「另一边」除外/);
});

test('主角的腔调和配角修为进任务书', () => {
  const s = state('xuanhuan');
  s.character.voice = '话少，开口就带刺';
  const x = writer(s, { action: '去找赵管事' });
  assert.match(x.user, /主角林远说话：话少，开口就带刺/);
  assert.match(x.user, /修为练气七层/);
});

test('写作准则：不许把「这章收在这里」这类说明写进正文', () => {
  assert.match(writer(state('urban')).sys, /这章收在这里/);
});

test('大纲与下一章：修仙带题材节奏和金手指笔记，并禁止「不写冲突」类禁令；其他题材不带', () => {
  const s = state('xuanhuan', { edge: EDGE });
  const [osys, ouser] = prompts.buildOutlineMessages(s, {});
  assert.ok(osys.content.includes(OUTLINE_NOTES.xuanhuan));
  assert.match(osys.content, /第 1 章就让金手指露头/);
  assert.match(ouser.content, /主角的金手指（作者笔记）[\s\S]*残镜[\s\S]*每夜子时能照一次/);
  const [nsys, nuser] = prompts.buildNextChapterMessages(s, { bridge: '承接', summaries: [] });
  assert.match(nsys.content, /修仙题材的节奏/);
  assert.match(nuser.content, /残镜/);
  const [usys] = prompts.buildOutlineMessages(state('urban'), {});
  assert.doesNotMatch(usys.content, /修仙题材的节奏/);
});

test('灵感：修仙按「稳、进、险」给，至少一条和变强有关；记账给的灵感同样要求', () => {
  const [xs] = prompts.buildSuggestMessages(state('xuanhuan'), {});
  assert.ok(xs.content.includes(SUGGEST_NOTES.xuanhuan));
  assert.match(xs.content, /只输出一个 JSON 对象/);
  const [us] = prompts.buildSuggestMessages(state('urban'), {});
  assert.doesNotMatch(us.content, /稳、进、险/);
  const [ls] = prompts.buildLedgerMessages(state('xuanhuan'), { action: '走', prose: '正文' });
  assert.match(ls.content, /稳、进、险/);
});

test('记账：修仙多记 pressure、境界破层、另一边不算主角经历；金手指只列没摸清的条目', () => {
  const s = state('xuanhuan', { edge: EDGE, edgeProgress: { shown: true, learned: [0] } });
  const [sys, user] = prompts.buildLedgerMessages(s, { action: '照灵草', prose: '正文' });
  assert.match(sys.content, /"pressure":"down\|up\|none"/);
  assert.match(sys.content, /破了一层/);
  assert.match(sys.content, /\* \* \*/);
  assert.match(user.content, /主角的金手指（作者笔记，只用来对照正文记账）/);
  assert.match(user.content, /（正文里已经露过面）/);
  assert.match(user.content, /2\. 每夜子时能照一次/);
  assert.match(user.content, /3\. 照活物会反噬心神/);
  assert.doesNotMatch(user.content, /1\. 照过的灵草药力翻倍/);
  const [usys] = prompts.buildLedgerMessages(state('urban'), { action: '走', prose: '正文' });
  assert.doesNotMatch(usys.content, /pressure/);
});

test('建世界提示：要真境界小层、配角修为、主角腔调、修仙金手指', () => {
  const [sys] = prompts.buildWorldMessages('山村少年拜入仙门', {});
  assert.match(sys.content, /"edge":\{"name"/);
  assert.match(sys.content, /"voice":"主角的说话方式/);
  assert.match(sys.content, /rank/);
  assert.match(sys.content, /练气一层/);
});

test('公开状态：金手指、金手指进度、压扬计数都不公开；主角腔调公开', () => {
  const s = state('xuanhuan', { edge: EDGE, edgeProgress: { shown: true, learned: [0] }, pressure: { streak: 2 } });
  s.character.voice = '话少';
  const pub = engine.toPublicState(s);
  assert.equal(pub.edge, undefined);
  assert.equal(pub.edgeProgress, undefined);
  assert.equal(pub.pressure, undefined);
  assert.doesNotMatch(JSON.stringify(pub), /残镜|反噬心神/);
  assert.equal(pub.character.voice, '话少');
});

test('题材写法里不含任何作者名或参考书的原文人名', () => {
  const banned = ['耳根', '忘语', '辰东', '仙逆', '王林', '恒岳', '铁柱'];
  const text = [STORY_STYLES.xuanhuan, OUTLINE_NOTES.xuanhuan, SUGGEST_NOTES.xuanhuan,
    writer(state('xuanhuan', { edge: EDGE }), { chapterTurn: 4 }).user].join('\n');
  for (const b of banned) assert.ok(!text.includes(b), b);
});

// ---- 整条回合 ----
function makeGame(t, wrap) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-v3-xx-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const keys = { LLM_MOCK: '1', DATA_DIR: tmp, LLM_API_KEY: 'sk-XX', NARRATIVE_STYLE: 'v3' };
  const saved = {};
  for (const k of Object.keys(keys)) { saved[k] = process.env[k]; process.env[k] = keys[k]; }
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  const orig = llm.createClient;
  llm.createClient = function (...args) {
    const c = orig.apply(this, args);
    const realComplete = c.complete;
    const realStream = c.completeStream;
    c.complete = (o) => (wrap.complete ? wrap.complete(o, () => realComplete.call(c, o)) : realComplete.call(c, o));
    c.completeStream = (o, d) => (wrap.stream ? wrap.stream(o, d, () => realStream.call(c, o, d)) : realStream.call(c, o, d));
    return c;
  };
  const g = game.createGame(cfg, dataDir);
  llm.createClient = orig;
  const readState = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'worlds', id, 'state.json'), 'utf8'));
  return { g, readState };
}

const PROSE = '你蹲在药田最里头，指尖拨开一丛灵草的叶子。胸口那块灰镜片忽然一烫，像有人往里头吹了口热气。' +
  '你没声张，手上照旧拔草，心里却算了一笔：赵管事午后才来，这半个时辰够试一次。\n\n' +
  '镜面里那株灵草的叶脉亮了一下，药香浓得呛人。你把它连根拔起，揣进袖里。\n\n这章收在这里。';

test('整回合（mock）：修仙建世界存金手指和腔调；记账推进压扬与金手指进度；正文去掉漏出的写作说明', async (t) => {
  let ledgerOut = { time_passes: 0, suggestions: ['a', 'b', 'c'], pressure: 'down' };
  const { g, readState } = makeGame(t, {
    complete: async (o, real) => {
      if (o.purpose === 'world') {
        const r = await real();
        const parsed = JSON.parse(r.content);
        parsed.hero = Object.assign({}, parsed.hero, { voice: '话少，开口就带刺，这句超过二十个字一定会被截断' });
        parsed.edge = Object.assign({}, EDGE, { rules: EDGE.rules.concat(['第四条', '第五条不该留下']), extra: 'x' });
        return Object.assign({}, r, { content: JSON.stringify(parsed) });
      }
      if (o.purpose === 'ledger') return { content: JSON.stringify(ledgerOut), usage: { prompt_tokens: 1, completion_tokens: 1 } };
      return real();
    },
    stream: async (o, d, real) => {
      if (o.purpose !== 'story') return real();
      if (typeof d === 'function') d(PROSE);
      return { content: PROSE, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  });
  const w = await g.buildWorld({ seed: '山村少年被选进修仙门派', name: '林远', genre: 'xuanhuan' });
  assert.equal(w.state ? w.state.edge : w.edge, undefined, '建世界返回值不带金手指');
  let st = readState(w.id);
  assert.equal(st.genre, 'xuanhuan');
  assert.equal(st.edge.name, '残镜');
  assert.equal(st.edge.rules.length, 4);
  assert.equal('extra' in st.edge, false);
  assert.equal(st.character.voice.length, 20);

  const r1 = await g.takeTurn(w.id, { action: '拔草时偷偷试那块镜片' });
  assert.doesNotMatch(r1.narration, /收在这里/);
  assert.match(r1.narration, /揣进袖里/);
  assert.equal(r1.state.edge, undefined);
  assert.equal(r1.state.pressure, undefined);
  st = readState(w.id);
  assert.deepEqual(st.pressure, { streak: 1 });
  assert.deepEqual(st.edgeProgress, { shown: false, learned: [] });

  ledgerOut = { time_passes: 0, suggestions: ['a', 'b', 'c'], pressure: 'down', edge_shown: true, edge_learned: [2, 1, 9] };
  await g.takeTurn(w.id, { action: '再试一次' });
  st = readState(w.id);
  assert.deepEqual(st.pressure, { streak: 2 });
  assert.deepEqual(st.edgeProgress, { shown: true, learned: [1] }, '一节最多摸清一条，序号越界忽略');

  ledgerOut = { time_passes: 0, suggestions: ['a', 'b', 'c'], pressure: 'up', edge_learned: [1] };
  await g.takeTurn(w.id, { action: '拿灵草去换灵石' });
  st = readState(w.id);
  assert.deepEqual(st.pressure, { streak: 0 });
  assert.deepEqual(st.edgeProgress, { shown: true, learned: [1, 0] });
});

test('整回合（mock）：非修仙世界不生成金手指、不记压扬', async (t) => {
  const { g, readState } = makeGame(t, {
    complete: async (o, real) => {
      if (o.purpose === 'world') {
        const r = await real();
        const parsed = JSON.parse(r.content);
        parsed.edge = EDGE;
        return Object.assign({}, r, { content: JSON.stringify(parsed) });
      }
      if (o.purpose === 'ledger') return { content: JSON.stringify({ time_passes: 0, suggestions: ['a', 'b', 'c'], pressure: 'down' }), usage: { prompt_tokens: 1, completion_tokens: 1 } };
      return real();
    },
  });
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '旅人', genre: 'urban' });
  await g.takeTurn(w.id, { action: '走' });
  const st = readState(w.id);
  assert.equal(st.edge, undefined);
  assert.equal(st.pressure, undefined);
  assert.equal(st.edgeProgress, undefined);
});
