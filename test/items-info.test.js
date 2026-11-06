'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../src/engine.js');
const images = require('../src/images.js');
const store = require('../src/store.js');
const { req, withServer, asGuest, loginGuest } = require('./helpers/api-helpers.js');
const ih = require('./helpers/images-helpers.js');

const THEMES = ['魔族入侵', '宫廷政变', '天灾', '秘境开启', '商路断绝', '古神低语'];
function worldSpec(overrides) {
  return Object.assign({
    id: 'wi', seed: '雾港', name: '旅人', appearance: '布衣',
    bible: {
      title: '雾港', tone: '苍凉', rules: [], places: [], factions: [], npcs: [],
      start: { place: '码头', situation: '' },
      eventThemes: THEMES.slice(),
    },
    apex: { title: '隐秘王冠', hint: '钟声', condition: { attrs: { 声望: 30 } } },
  }, overrides || {});
}

// ---- engine：items_info 校验 / 截断 / 写入 + character.items 仍是字符串数组 ----
test('engine：回合 items_info 只接受实际加入的物品、截断 60/6 字并写进 state.itemInfo', () => {
  const s = engine.createWorld(worldSpec(), { rng: () => 0.5, now: 1000 });
  s.character.items = ['旧行囊'];
  const proposal = {
    narration: '你在晨雾里醒来，钟声从远处传来，于是沿古道往前走，想看清提灯的人究竟是谁。',
    state_diff: {},
    items_add: ['新玉佩', '旧剑'],
    items_remove: [],
    npc_attitude: {},
    persona_tags: [],
    suggestions: ['继续走', '问路', '查看行囊'],
    items_info: {
      '新玉佩': { desc: '  ' + '温'.repeat(100) + '  ', type: '法器法器法器法器法器' },
      '旧剑': { desc: '一把生锈的旧剑', type: '兵器' },
      '幽灵物品': { desc: '不该被接受的介绍', type: '杂物' },
    },
  };
  const out = engine.resolveTurn(s, { action: '查看', proposal }, { rng: () => 0.5, now: 1000 });
  assert.equal(out.invalid, false, '本回合应有效');
  assert.ok(out.result, '应产出回合结果');

  const info = out.state.itemInfo;
  assert.ok(info && typeof info === 'object', 'state.itemInfo 应被写入');
  assert.equal(info['新玉佩'].desc, '温'.repeat(60), 'desc 去空白并截 60 字');
  assert.equal(info['新玉佩'].type.length, 6, 'type 截 6 字');
  assert.equal(info['旧剑'].desc, '一把生锈的旧剑');
  assert.equal(info['幽灵物品'], undefined, '只接受 items_add 里实际加入的物品名');

  // 不影响 character.items 的格式：仍是字符串数组，且含新增物品
  assert.ok(Array.isArray(out.state.character.items), 'character.items 仍是数组');
  assert.ok(out.state.character.items.every((n) => typeof n === 'string'), '每个元素仍是字符串');
  assert.deepEqual(out.state.character.items, ['旧行囊', '新玉佩', '旧剑']);
});

test('engine：createWorld 从 start.items_info 写入 itemInfo（限起始物品、截断）', () => {
  const s = engine.createWorld(worldSpec({
    bible: {
      title: '雾港', tone: '', rules: [], places: [], factions: [], npcs: [],
      start: {
        place: '码头', situation: '',
        items: ['旧铜灯', '一封无字信'],
        items_info: {
          '旧铜灯': { desc: '  ' + '灯'.repeat(80) + '  ', type: '法器法器法器' },
          '一封无字信': { desc: '没有落款的信', type: '信物' },
          '幽灵': { desc: '不该被接受', type: '杂物' },
        },
      },
      eventThemes: THEMES.slice(),
    },
  }), { rng: () => 0.5, now: 1 });
  assert.deepEqual(s.character.items, ['旧铜灯', '一封无字信']);
  assert.equal(s.itemInfo['旧铜灯'].desc, '灯'.repeat(60));
  assert.equal(s.itemInfo['旧铜灯'].type.length, 6);
  assert.equal(s.itemInfo['一封无字信'].desc, '没有落款的信');
  assert.equal(s.itemInfo['幽灵'], undefined, '非起始物品的介绍被忽略');
});

test('engine：normalizeState 给老存档补 itemInfo 默认空表', () => {
  const n = engine.normalizeState({ turn: 2, character: { items: ['旧铜灯'] } });
  assert.deepEqual(n.itemInfo, {});
  assert.deepEqual(n.character.items, ['旧铜灯']);
});

// ---- 接口 ----
test('mock 建世界后公开状态带出 itemInfo，起始物品都有介绍（mockWorld 给 items_info）', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/worlds', { seed: '雾港', name: '甲', appearance: '布衣' });
    assert.equal(r.status, 201, r.text);
    const g = await req(base, 'GET', `/api/worlds/${r.json.id}`);
    assert.equal(g.status, 200, g.text);
    const info = g.json.itemInfo;
    assert.ok(info && typeof info === 'object', '公开状态应带出 itemInfo');
    const items = g.json.character.items;
    assert.ok(Array.isArray(items) && items.length >= 2, '应有起始物品');
    for (const n of items) {
      assert.ok(info[n] && typeof info[n].desc === 'string' && info[n].desc, `${n} 应有介绍`);
      assert.ok(typeof info[n].type === 'string', `${n} 应有类型`);
    }
  });
});

test('删掉某物品介绍后 GET /items 会补上并写回，按 character.items 顺序返回', async () => {
  await withServer(async ({ base, dataDir }) => {
    const r = await req(base, 'POST', '/api/worlds', { seed: '旧港', name: '甲', appearance: '布衣' });
    const id = r.json.id;
    const stateFile = store.statePath(dataDir, id);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const items = state.character.items.slice();
    const victim = items[0];
    delete state.itemInfo[victim];
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const res = await req(base, 'GET', `/api/worlds/${id}/items`);
    assert.equal(res.status, 200, res.text);
    assert.ok(Array.isArray(res.json.items));
    assert.deepEqual(res.json.items.map((x) => x.name), items, '按当前 character.items 顺序');
    for (const it of res.json.items) {
      assert.equal(typeof it.desc, 'string');
      assert.equal(typeof it.type, 'string');
    }
    const got = res.json.items.find((x) => x.name === victim);
    assert.ok(got && got.desc, '被删介绍的物品应补上 desc');

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(saved.itemInfo[victim] && saved.itemInfo[victim].desc, '应写回 state.json');
  });
});

test('别人的世界 GET /items 返回 404', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookieA = await loginGuest(base, dataDir, '甲');
    const cookieB = await loginGuest(base, dataDir, '乙');
    const r = await req(base, 'POST', '/api/worlds',
      { seed: '甲的世界', name: '甲', appearance: '灰袍' }, asGuest(cookieA));
    assert.equal(r.status, 201, r.text);
    const x = await req(base, 'GET', `/api/worlds/${r.json.id}/items`, undefined, asGuest(cookieB));
    assert.equal(x.status, 404, '越权访问 items 应 404');
    assert.deepEqual(x.json, { error: '世界不存在' });
  });
});

// ---- 物品图提示词 ----
test('物品图中文提示词含介绍文字：listForState 带 desc、gatewayPrompt 附上，缓存 key 不变', () => {
  const desc = '灯身斑驳却不灭的旧铜灯';
  const st = ih.makeState({
    id: 'witeminfo', character: { items: ['旧铜灯'] }, npcAttitude: {},
    itemInfo: { '旧铜灯': { desc, type: '法器' } },
  });
  const list = images.listForState(st);
  const job = list.find((x) => x.kind === 'item' && x.name === '旧铜灯');
  assert.ok(job, 'listForState 应产出物品项');
  assert.equal(job.desc, desc, '物品项应带 itemInfo 的 desc');
  assert.equal(job.name, '旧铜灯', 'keyName 仍只是物品名（缓存 key 不含 desc）');

  const zh = images.gatewayPrompt(Object.assign({}, job, { style: { zh: '水墨' }, bibleTitle: '雾港' }));
  assert.ok(zh.includes('（' + desc + '）'), '中文提示词应含介绍文字');

  // 缓存 key 只由 kind|name|style 决定，与 desc 无关（已有图不重画）
  assert.equal(images.imageKey('item', '旧铜灯', '水墨', 'witeminfo'),
    images.imageKey('item', '旧铜灯', '水墨', 'witeminfo'));
});

test('物品图英文翻译 subject 也附上介绍文字', async (t) => {
  const desc = '灯身斑驳却不灭的旧铜灯';
  const dataDir = ih.tmpDir(t);
  const st = ih.makeState({
    id: 'witemsubject', character: { items: ['旧铜灯'] }, npcAttitude: {},
    itemInfo: { '旧铜灯': { desc, type: '法器' } },
  });
  const seen = [];
  const inst = ih.createT(ih.baseCfg({ IMAGE_PROVIDER: 'cloudflare', CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }), {
    fetchImpl: ih.cfFetch([]),
    translate: async (job, messages) => { seen.push(messages[1].content); return 'a tarnished bronze oil lamp'; },
  });
  inst.ensureImages(dataDir, st, inst.listForState(st));
  await inst.waitIdle();
  assert.ok(seen.some((s) => s.includes('（' + desc + '）')), '翻译 subject 应含介绍文字');
});

// ---- 前端静态检查 ----
test('前端静态检查：引入顺序 / showItemCard / renderItemGrid 调用 / 请求 /items / 无新增 innerHTML', () => {
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const iItems = html.indexOf('/js/items.js');
  const iGame = html.indexOf('/js/game.js');
  assert.ok(iItems >= 0, 'index.html 应引入 /js/items.js');
  assert.ok(iGame >= 0 && iItems < iGame, 'items.js 应在 game.js 之前引入');

  const itemsJs = fs.readFileSync(path.join(root, 'js', 'items.js'), 'utf8');
  assert.match(itemsJs, /function showItemCard\(/, '应有 showItemCard');
  assert.match(itemsJs, /\/items/, '应有请求 /items 的代码');

  const imagesJs = fs.readFileSync(path.join(root, 'js', 'images.js'), 'utf8');
  const gridStart = imagesJs.indexOf('function renderItemGrid');
  const gridEnd = imagesJs.indexOf('function renderNpcList');
  assert.ok(gridStart >= 0 && gridEnd > gridStart, '应能定位 renderItemGrid');
  assert.match(imagesJs.slice(gridStart, gridEnd), /showItemCard\(/, 'renderItemGrid 里调用 showItemCard');

  const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));
  const js = jsFiles.map((f) => fs.readFileSync(path.join(root, 'js', f), 'utf8')).join('\n');
  assert.equal(/\.innerHTML/.test(js), false, 'public/js 不得出现 .innerHTML 拼接');
  assert.equal(/innerHTML/.test(itemsJs), false, 'items.js 不得出现 innerHTML');
});
