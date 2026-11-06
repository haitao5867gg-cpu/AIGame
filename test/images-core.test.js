'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../src/images.js');
const store = require('../src/store.js');
const { JPEG, tmpDir, withArt, configureT, createT, baseCfg, makeState, okFetch, stubWarn, freeFetch, oneItemState, msFetch, cfFetch, XIANXIA_ART, xianxiaState } = require('./helpers/images-helpers.js');


test('画风推断：六类关键词各推一份中英画风，缺省回退「手绘插画」', () => {
  const cases = [
    ['修仙宗门外门杂役', '苍茫', '水墨淡彩插画', 'ink and watercolor illustration, fine ink linework with light color washes'],
    ['蒸汽朋克长安', '齿轮轰鸣', '复古铜版线描淡彩', 'vintage engraving line art with sepia washes'],
    ['赛博霓虹都市', '未来', '数字厚涂概念插画', 'digital painterly concept art'],
    ['深海殖民站', '幽暗', '数字厚涂概念插画', 'digital painterly concept art'],
    ['民国上海滩', '谍影', '民国月份牌画风', '1930s Chinese calendar poster painting'],
    ['末日尸潮', '荒凉', '粗粝炭笔素描淡彩', 'gritty charcoal sketch with muted color washes'],
    ['一个普通小镇', '平淡', '手绘水彩插画', 'hand-drawn watercolor illustration'],
  ];
  for (const [title, tone, zh, en] of cases) {
    assert.deepEqual(images.inferStyle({ title, tone }), { zh, en }, title);
  }
  assert.deepEqual(images.inferStyle(null), { zh: '手绘水彩插画', en: 'hand-drawn watercolor illustration' });
  // tone 也能命中
  assert.equal(images.inferStyle({ title: '无名之地', tone: '武侠江湖' }).zh, '水墨淡彩插画');
});

test('imageKey：物品跨世界同名同画风共享；NPC 按世界区分；12 位十六进制', () => {
  const s = '水墨手绘插画';
  const a = images.imageKey('item', '无字信', s, 'wA');
  const b = images.imageKey('item', '无字信', s, 'wB');
  assert.equal(a, b, '物品不带 worldId，两世界共用一张');
  assert.match(a, /^[0-9a-f]{12}$/);
  const n1 = images.imageKey('npc', '守夜人', s, 'wA');
  const n2 = images.imageKey('npc', '守夜人', s, 'wB');
  assert.notEqual(n1, n2, 'NPC 带 worldId，重名但不同世界不共用');
  assert.notEqual(images.imageKey('item', '甲', s, 'wA'), images.imageKey('item', '乙', s, 'wA'));
});

test('mock：不访问网络，写占位 SVG（文件名 .svg、status ready、url 可拼出）', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let fetched = false;
  configureT(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: true }), {
    fetchImpl: () => { fetched = true; return Promise.reject(new Error('不应访问网络')); },
  });
  const state = makeState();
  images.ensureImages(dataDir, state, images.listForState(state));
  await images.waitIdle();
  assert.equal(fetched, false, 'mock 不能发起网络请求');
  const idx = images.readIndex(dataDir);
  const keys = Object.keys(idx);
  assert.equal(keys.length, 3, '2 物品 + 1 NPC');
  for (const k of keys) {
    assert.equal(idx[k].status, 'ready');
    assert.match(idx[k].file, /\.svg$/);
    assert.ok(fs.existsSync(path.join(dataDir, 'images', idx[k].file)), 'SVG 文件应写到磁盘');
  }
  const list = images.imageList(dataDir, state);
  assert.equal(list.items['无字信'].status, 'ready');
  assert.match(list.items['无字信'].url, /^\/api\/images\/item-[0-9a-f]{12}\.svg$/);
  assert.equal(list.npcs['守夜人'].status, 'ready');
});

test('共享缓存去重：不同世界同名同画风物品只生成一次（同一 key 不重复排队）', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  const calls = [];
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: okFetch(calls) });
  const s1 = makeState({
    id: 'wA', bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
    character: { items: ['旧铜灯'] }, npcAttitude: {},
  });
  const s2 = makeState({
    id: 'wB', bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
    character: { items: ['旧铜灯'] }, npcAttitude: {},
  });
  images.ensureImages(dataDir, s1, images.listForState(s1));
  images.ensureImages(dataDir, s2, images.listForState(s2));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  const itemKeys = Object.keys(idx).filter((k) => idx[k].kind === 'item');
  assert.equal(itemKeys.length, 1, '同名同画风物品在全局缓存里只有一条');
  assert.equal(calls.length, 1, '只出图一次');
  assert.equal(idx[itemKeys[0]].status, 'ready');
});

test('NPC 按世界区分：重名但不同世界生成两张图', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  configureT(baseCfg({ IMAGE_PROVIDER: 'local', LLM_MOCK: true }));
  const s1 = makeState({
    id: 'wA', bible: { title: '蒸汽朋克长安', tone: '', npcs: [{ name: '守夜人', role: '甲', desc: '甲' }] },
    character: { items: [] }, npcAttitude: { '守夜人': 0 },
  });
  const s2 = makeState({
    id: 'wB', bible: { title: '蒸汽朋克长安', tone: '', npcs: [{ name: '守夜人', role: '乙', desc: '乙' }] },
    character: { items: [] }, npcAttitude: { '守夜人': 0 },
  });
  images.ensureImages(dataDir, s1, images.listForState(s1));
  images.ensureImages(dataDir, s2, images.listForState(s2));
  await images.waitIdle();
  const idx = images.readIndex(dataDir);
  const npcKeys = Object.keys(idx).filter((k) => idx[k].kind === 'npc');
  assert.equal(npcKeys.length, 2, 'NPC key 带世界 id，重名也各一张');
});

test('GET /images 老存档补图：list 时无索引项会顺手排队，先 pending 后 ready', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowFetch = () => gate.then(() => ({
    ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }),
  }));
  configureT(baseCfg({ IMAGE_PROVIDER: 'gateway' }), { fetchImpl: slowFetch });
  const state = makeState();
  const first = images.imageList(dataDir, state);
  assert.equal(first.items['无字信'].status, 'pending', '请求时顺手排队，立即返回 pending');
  assert.equal(first.npcs['守夜人'].status, 'pending');
  release();
  await images.waitIdle();
  const second = images.imageList(dataDir, state);
  assert.equal(second.items['无字信'].status, 'ready');
  assert.equal(second.npcs['守夜人'].status, 'ready');
});

test('imageList 只含当前 character.items 与 npcAttitude 的名字', async (t) => {
  const dataDir = tmpDir(t);
  stubWarn(t);
  configureT(baseCfg({ IMAGE_PROVIDER: 'off' }));
  const state = makeState({
    character: { items: ['无字信', '旧铜灯'] },
    npcAttitude: { '守夜人': 0, '铸剑师': 2 },
  });
  const list = images.imageList(dataDir, state);
  assert.deepEqual(Object.keys(list.items).sort(), ['无字信', '旧铜灯'].sort());
  assert.deepEqual(Object.keys(list.npcs).sort(), ['守夜人', '铸剑师'].sort());
  assert.equal(list.items['半张海图'], undefined, '已不在物品里的名字不返回');
});

test('serveImage：文件名严格校验（非法 400 / 缺失 404 / 正确 200 + Content-Type）', (t) => {
  const dataDir = tmpDir(t);
  for (const bad of [
    'item-ABCDEF012345.jpg',   // 大写
    'item-abcdef.jpg',         // 长度不足
    'foo-abcdef012345.jpg',    // 非法 kind
    'item-abcdef012345.gif',   // 非法扩展名
    'item-abcdef012345.jpg.bak',
    '../item-abcdef012345.jpg',
    'npc-abcdef01234g.jpg',    // 非十六进制
    '',
  ]) {
    assert.equal(images.serveImage(dataDir, bad).status, 400, `非法文件名应 400：${bad}`);
  }
  const good = 'item-abcdef012345.jpg';
  assert.equal(images.serveImage(dataDir, good).status, 404, '合法但不存在 → 404');

  fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'images', good), JPEG);
  const r = images.serveImage(dataDir, good);
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'image/jpeg');
  assert.equal(r.filePath, path.join(dataDir, 'images', good));
  const svg = 'npc-0123456789ab.svg';
  fs.writeFileSync(path.join(dataDir, 'images', svg), '<svg/>');
  assert.equal(images.serveImage(dataDir, svg).contentType, 'image/svg+xml');
});

