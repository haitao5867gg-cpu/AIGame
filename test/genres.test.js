'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const game = require('../src/game.js');
const prompts = require('../src/prompts.js');
const { GENRES, GENRE_NAMES, GENRE_STYLES, normalizeGenre } = require('../src/genres.js');
const { withServer, req, asGuest, loginGuest } = require('./helpers/api-helpers.js');

// 作者名只允许出现在代码注释里，绝不能进入任何提示词字符串。
const AUTHORS = ['耳根', '忘语', '辰东', '会说话的肘子', '骁骑校', '蝴蝶蓝', '骷髅精灵', '蔡骏', '南派三叔'];

function assertNoAuthors(text, label) {
  for (const a of AUTHORS) {
    assert.ok(!text.includes(a), `${label} 不应含作者名「${a}」`);
  }
}

function makeState(genre) {
  const s = {
    bible: {
      title: '测试世界', tone: '苍凉', rules: [], places: [], factions: [],
      npcs: [{ name: '守夜人', role: '', desc: '' }],
      start: { place: '灰烬港', situation: '醒来', items: ['旧铜灯'] },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 1,
  };
  if (genre !== undefined) s.genre = genre;
  return s;
}

function systemText(style, genre) {
  const [sys] = prompts.buildTurnMessages(makeState(genre), { nextTurn: 2 }, '探查', { style });
  return sys.content;
}

// 独立临时 DATA_DIR + 离线 mock 的 game，直接测 ensureGenre。
function makeGame(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-genre-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = 'sk-GENRE-MOCK-SECRET';
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  return { g: game.createGame(cfg, dataDir), dataDir };
}

test('normalizeGenre：合法值原样、非法值一律归 general', () => {
  for (const g of GENRES) assert.equal(normalizeGenre(g), g);
  for (const bad of [undefined, null, '', 'auto', 'AUTO', 'XUANHUAN', 'bogus', 0, 123, {}, []]) {
    assert.equal(normalizeGenre(bad), 'general', `${String(bad)} 应归 general`);
  }
});

test('GENRE_STYLES：五类各自关键句，general 为空串', () => {
  assert.ok(GENRE_STYLES.xuanhuan.includes('打脸'), '玄幻应含「打脸」');
  assert.ok(GENRE_STYLES.urban.includes('外卖'), '都市应含「外卖」');
  assert.ok(GENRE_STYLES.game.includes('【获得：'), '游戏应含「【获得：」');
  assert.ok(GENRE_STYLES.horror.includes('留白'), '恐怖应含「留白」');
  assert.ok(GENRE_STYLES.cozy.includes('节奏舒缓'), '休闲应含「节奏舒缓」');
  assert.equal(GENRE_STYLES.general, '', 'general 应为空串');
});

test('中文名映射：六类都有对应中文名', () => {
  for (const g of GENRES) {
    assert.equal(typeof GENRE_NAMES[g], 'string');
    assert.ok(GENRE_NAMES[g].length > 0);
  }
  assert.equal(GENRE_NAMES.xuanhuan, '玄幻修仙');
  assert.equal(GENRE_NAMES.general, '通用');
});

test('任何提示词字符串都不含作者名（GENRE_STYLES + buildTurnMessages 五类全跑）', () => {
  for (const [key, text] of Object.entries(GENRE_STYLES)) {
    assertNoAuthors(text, `GENRE_STYLES.${key}`);
  }
  for (const g of GENRES) {
    for (const style of ['v1', 'v2', 'v2-3p']) {
      assertNoAuthors(systemText(style, g), `buildTurnMessages(${style}, ${g})`);
    }
  }
});

test('v2 / v2-3p 追加选中文风段；horror 不含玄幻段；general 只有底座；v1 不追加', () => {
  const horror = systemText('v2', 'horror');
  assert.ok(horror.includes(GENRE_STYLES.horror), 'v2 + horror 应含恐怖文风段');
  assert.ok(!horror.includes(GENRE_STYLES.xuanhuan), 'v2 + horror 不应含玄幻文风段');

  const h3p = systemText('v2-3p', 'cozy');
  assert.ok(h3p.includes(GENRE_STYLES.cozy), 'v2-3p 也应追加选中文风段');

  const general = systemText('v2', 'general');
  assert.equal(general, systemText('v2', undefined), 'general 应只有底座，与不带 genre 一致');
  for (const [key, text] of Object.entries(GENRE_STYLES)) {
    if (text) assert.ok(!general.includes(text), `general 不应含 ${key} 文风段`);
  }

  const v1 = systemText('v1', 'horror');
  for (const [key, text] of Object.entries(GENRE_STYLES)) {
    if (text) assert.ok(!v1.includes(text), `v1 不应含 ${key} 文风段`);
  }
});

test('建世界：body.genre 手选优先于模型判断；mock 建世界带 genre', async () => {
  await withServer(async ({ base }) => {
    const seedBody = { seed: '雾港', name: '甲', appearance: '布衣' };
    // mockWorld 给的模型判断是 xuanhuan。
    const r0 = await req(base, 'POST', '/api/worlds', seedBody);
    assert.equal(r0.status, 201, r0.text);
    assert.equal(r0.json.genre, 'xuanhuan', '未手选时应采用模型判断的 genre');
    assert.ok(GENRES.includes(r0.json.genre), 'mock 建世界应带合法 genre');

    const ra = await req(base, 'POST', '/api/worlds', Object.assign({}, seedBody, { genre: 'auto' }));
    assert.equal(ra.status, 201, ra.text);
    assert.equal(ra.json.genre, 'xuanhuan', "genre='auto' 应交由模型判断");

    const rp = await req(base, 'POST', '/api/worlds', Object.assign({}, seedBody, { genre: 'horror' }));
    assert.equal(rp.status, 201, rp.text);
    assert.equal(rp.json.genre, 'horror', '手选 genre 应优先于模型判断');
    const got = await req(base, 'GET', `/api/worlds/${rp.json.id}`);
    assert.equal(got.json.genre, 'horror', 'GET 也应带出手选 genre');
  });
});

test('POST /api/worlds/:id/genre：修改成功、越权 404、非法值归一为 general', async () => {
  await withServer(async ({ base, dataDir }) => {
    const r = await req(base, 'POST', '/api/worlds', { seed: '雾港', name: '甲', appearance: '布衣' });
    const id = r.json.id;

    const ok = await req(base, 'POST', `/api/worlds/${id}/genre`, { genre: 'cozy' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json, { genre: 'cozy' });
    const g1 = await req(base, 'GET', `/api/worlds/${id}`);
    assert.equal(g1.json.genre, 'cozy', '修改后应保存并带出');

    const bad = await req(base, 'POST', `/api/worlds/${id}/genre`, { genre: '不存在的题材' });
    assert.equal(bad.status, 200, bad.text);
    assert.deepEqual(bad.json, { genre: 'general' }, '非法值应归一为 general');

    // 别人的世界 404（两个来客）。
    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const wa = await req(base, 'POST', '/api/worlds', { seed: 'A 的世界', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(wa.status, 201, wa.text);
    const denied = await req(base, 'POST', `/api/worlds/${wa.json.id}/genre`, { genre: 'horror' }, asGuest(cookieB));
    assert.equal(denied.status, 404, denied.text);
    assert.deepEqual(denied.json, { error: '世界不存在' });
  });
});

test('老世界没有 genre：ensureGenre 判断并保存（mock），且有 genre 时幂等直接返回', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '苍茫诡谲的旧港', name: '旅人', appearance: '布衣' });
  const id = world.id;
  // 抹掉 genre 模拟老世界。
  const stateFile = store.statePath(dataDir, id);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete state.genre;
  fs.writeFileSync(stateFile, JSON.stringify(state));

  const judged = await g.ensureGenre(id);
  assert.ok(GENRES.includes(judged), `ensureGenre 应返回合法 genre，实际 ${judged}`);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.genre, judged, '判断结果应写回存档');

  // 已有 genre 时直接返回，不再改写。
  const again = await g.ensureGenre(id);
  assert.equal(again, judged);
  const saved2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved2.genre, judged);
});
