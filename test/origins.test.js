'use strict';

// 出身：取代建世界时的手动分点。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const engine = require('../src/engine.js');
const prompts = require('../src/prompts.js');
const game = require('../src/game.js');
const { withServer, req } = require('./helpers/api-helpers.js');

test('normalizeAlloc：任意输入都变成合计 6、单项 0~3 的整数', () => {
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  for (const raw of [null, {}, { 体魄: 9, 心智: 9 }, { 体魄: 1.6, 心智: -2, 魅力: '3' }, { 体魄: 1 }, { 体魄: 3, 心智: 3, 魅力: 3, 气运: 3 }]) {
    const a = engine.normalizeAlloc(raw);
    assert.equal(sum(a), 6, JSON.stringify(raw));
    assert.ok(Object.values(a).every((v) => Number.isInteger(v) && v >= 0 && v <= 3));
  }
});

test('normalizeOrigins：去掉没有 title 的、重名的，最多 4 个，字段截断', () => {
  const list = engine.normalizeOrigins([
    { title: '镖局少主很长很长很长', blurb: 'x'.repeat(100), style: '冒险', attrs: { 体魄: 3, 魅力: 3 }, item: { name: '镖旗', desc: 'd' } },
    { title: '' }, null, { title: '镖局少主很长很长很长' },
    { title: '账房', style: '乱填' }, { title: '道士' }, { title: '书生' }, { title: '多余' },
  ]);
  assert.equal(list.length, 4);
  assert.equal(list[0].title.length, 8);
  assert.equal(list[0].blurb.length, 48);
  assert.equal(list[0].item.name, '镖旗');
  assert.equal(list[1].style, '');
});

function world(origins) {
  return engine.createWorld({ id: 'wtest', bible: { start: { place: '甲', items: ['旧刀'] } }, origins }, { rng: () => 0.5, now: 1 });
}

test('applyOrigin：属性按出身重分、多带一件物品、只能选一次、开局后不能选', () => {
  const s = world([{ title: '镖局少主', blurb: 'b', style: '冒险', attrs: { 体魄: 3, 魅力: 3 }, item: { name: '镖旗', desc: '一面旧镖旗', type: '信物' } }]);
  assert.equal(s.character.attrs['体魄'], 6); // 选之前平均分配
  const r = engine.applyOrigin(s, 0);
  assert.equal(r.error, null);
  assert.equal(r.state.character.attrs['体魄'], 8);
  assert.equal(r.state.character.attrs['魅力'], 8);
  assert.equal(r.state.character.attrs['心智'], 5);
  assert.ok(r.state.character.items.includes('镖旗'));
  assert.equal(r.state.itemInfo['镖旗'].desc, '一面旧镖旗');
  assert.deepEqual(r.state.character.origin, { title: '镖局少主', blurb: 'b', style: '冒险' });
  assert.equal(s.character.origin, undefined); // 不改入参
  assert.match(engine.applyOrigin(r.state, 0).error, /已经选过/);
  assert.match(engine.applyOrigin(Object.assign({}, s, { turn: 1 }), 0).error, /不能再换出身/);
  assert.match(engine.applyOrigin(s, 5).error, /没有这个出身/);
});

test('提示词：建世界要 hero 和 3 个出身，带上「你是谁」；出身进人物描述', () => {
  const [sys, user] = prompts.buildWorldMessages('一句话', { identity: '退伍兵，枪法准' });
  assert.match(sys.content, /origins 给 3 个主角出身/);
  assert.match(sys.content, /第一个出身就照玩家写的来/);
  assert.match(sys.content, /"hero"/);
  assert.match(user.content, /退伍兵，枪法准/);
  assert.match(user.content, /请在 hero\.name 里起一个/);
  const s = engine.applyOrigin(world([{ title: '镖局少主', blurb: '仇家多', attrs: {} }]), 0).state;
  const msgs = prompts.buildTurnMessages(s, engine.planTurn(s, { rng: () => 0.5 }), '走', {});
  assert.match(msgs.map((m) => m.content).join('\n'), /出身：镖局少主——仇家多/);
});

function makeGame(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-origin-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const keys = { LLM_MOCK: '1', DATA_DIR: tmp, LLM_API_KEY: 'sk-O' };
  const saved = {};
  for (const k of Object.keys(keys)) { saved[k] = process.env[k]; process.env[k] = keys[k]; }
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const cfg = env.getConfig();
  return game.createGame(cfg, env.resolveDataDir(cfg));
}

test('建世界：不给名字时 AI 起名；写了「你是谁」时第一个出身按玩家写的', async (t) => {
  const g = makeGame(t);
  const w = await g.buildWorld({ seed: '雾里的旧港', identity: '欠了一屁股债的退伍兵' });
  assert.equal(w.character.name, '雾生');
  assert.equal(w.origins.length, 3);
  assert.equal(w.origins[0].custom, true);
  const w2 = await g.buildWorld({ seed: '雾里的旧港', name: '林野' });
  assert.equal(w2.character.name, '林野');
  assert.equal(w2.origins.some((o) => o.custom), false);
});

test('选出身：成功后属性 / 物品变化；再选 409；开局后 409', async (t) => {
  const g = makeGame(t);
  const w = await g.buildWorld({ seed: '雾里的旧港', name: '林野' });
  const r = await g.chooseOrigin(w.id, { index: 1 });
  assert.equal(r.character.origin.title, w.origins[1].title);
  await assert.rejects(() => g.chooseOrigin(w.id, { index: 0 }), (e) => e.status === 409);
  const w2 = await g.buildWorld({ seed: '雾里的旧港', name: '林野' });
  await g.takeTurn(w2.id, { action: '走' });
  await assert.rejects(() => g.chooseOrigin(w2.id, { index: 0 }), (e) => e.status === 409);
});

test('HTTP：POST /api/worlds/:id/origin；GET 405', async () => {
  await withServer(async (base) => {
    const w = (await req(base, 'POST', '/api/worlds', { seed: '雾里的旧港', name: '林野' })).json;
    const ok = await req(base, 'POST', `/api/worlds/${w.id}/origin`, { index: 0 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.character.origin.title, w.origins[0].title);
    const again = await req(base, 'POST', `/api/worlds/${w.id}/origin`, { index: 1 });
    assert.equal(again.status, 409);
    const get = await req(base, 'GET', `/api/worlds/${w.id}/origin`);
    assert.equal(get.status, 405);
  });
});
