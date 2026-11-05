'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const game = require('../src/game.js');

const SECRET = 'sk-GAME-MOCK-SECRET';

// 每个测试用独立临时 DATA_DIR；显式设置 LLM_MOCK=1 / DATA_DIR，
// 再经 env.getConfig() 读取（process.env 优先级高于任何 .env 文件）。
function makeGame(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-game-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = SECRET;
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  return { g: game.createGame(cfg, dataDir), dataDir, tmp, cfg };
}

// 递归检查对象里是否出现某个属性名。
function containsKey(obj, target) {
  if (!obj || typeof obj !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(obj, target)) return true;
  return Object.values(obj).some((v) => containsKey(v, target));
}

function assertNoLeak(value) {
  const text = JSON.stringify(value);
  assert.equal(containsKey(value, 'apex'), false, '公开数据不应含 apex 键');
  assert.equal(containsKey(value, 'LLM_API_KEY'), false, '公开数据不应含 Key 键');
  assert.equal(text.includes(SECRET), false, '公开数据不应含 API Key 值');
  assert.equal(/"apex"\s*:/.test(text), false);
}

test('mock 模式完整跑 30 回合（≥2 次事件）：建世界 / 编年史 / 顶点刷新 / 不泄露', async (t) => {
  const { g, dataDir } = makeGame(t);

  const world = await g.buildWorld({
    seed: '蒸汽与古神并存的黄沙港城',
    name: '旅人',
    appearance: '青衣',
  });
  assert.ok(world.id && WORLD_ID_OK(world.id));
  assert.equal(world.turn, 0);
  assert.equal(world.life, 1);
  assert.equal(world.character.alive, true);
  assert.ok(Array.isArray(world.bible.eventThemes));
  assert.equal(world.bible.eventThemes.length, 6);
  assertNoLeak(world);
  const id = world.id;

  let openings = 0;
  let settlements = 0;
  let invalid = 0;

  for (let i = 0; i < 30; i++) {
    // 万一世界进入等待重生，先提交新一世再继续（mock 默认不会死亡，这里做兜底）。
    const before = await g.getWorld(id);
    if (before.awaitingRebirth) {
      await g.rebirth(id, { name: `第${before.life}世`, appearance: '布衣' });
    }

    const res = await g.takeTurn(id, { action: `第${i + 1}回合，继续探查钟声的来源` });
    assert.ok(res.narration && res.narration.length >= 10, `第 ${i + 1} 回合应有叙事`);
    assert.ok(res.state, '回合结果应带公开状态');
    assertNoLeak(res);
    assert.equal(res.state.turn, i + 1, `第 ${i + 1} 回合应推进到 turn ${i + 1}`);
    if (res.event) openings++;
    if (res.settlement) settlements++;
    if (res.rejected && res.rejected.length) invalid++;
  }

  assert.ok(openings >= 2, `事件开启次数应 ≥2，实际 ${openings}`);
  assert.ok(settlements >= 2, `事件结算次数应 ≥2，实际 ${settlements}`);

  const finalPublic = await g.getWorld(id);
  assert.equal(finalPublic.turn, 30);
  assert.equal(finalPublic.recent.length, 6, 'recent 只保留最近 6 条');
  assert.ok(finalPublic.chronicle.length >= 1, '第 20 回合应压出一章编年史');
  assertNoLeak(finalPublic);

  // 内部状态（含 apex）用于验证顶点检测 / 刷新确实经由编排层发生。
  const internal = store.loadWorld(dataDir, id);
  assert.ok(internal.apex, '内部状态应保留 apex（仅接口不返回）');
  assert.ok(internal.apex.generation >= 2, '高光期后应生成新 apex（generation+1）');
  assert.ok(internal.highlightUntilTurn >= 0);
  assert.equal(internal.turn, 30);

  // usage.jsonl 累积了所有 LLM 调用。
  const usage = g.usage();
  assert.ok(usage.cumulative.total > 0, '应有 token 用量记录');
  assert.ok(usage.today.total > 0);
  assert.equal(usage.cumulative.prompt_tokens + usage.cumulative.completion_tokens, usage.cumulative.total);
  assertNoLeak(usage);

  // events.jsonl 每回合一行，永不删除。
  const events = store.readEvents(dataDir, id);
  assert.equal(events.length, 30);
  assert.equal(events[0].turn, 1);
  assert.equal(events[29].turn, 30);
  assert.ok(events.every((e) => e && typeof e.usage === 'object'));
});

test('重生：等待重生时禁止回合，提交名字/形象后恢复', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雪原上的钟摆之城', name: '甲', appearance: '白衣' });
  const id = world.id;

  // 直接把内部状态置为「本世已终」，模拟死亡后的待重生状态。
  const state = store.loadWorld(dataDir, id);
  state.awaitingRebirth = true;
  state.character.alive = false;
  state.life = 2;
  store.saveWorld(dataDir, state);

  await assert.rejects(
    () => g.takeTurn(id, { action: '继续前行' }),
    (err) => err && err.status === 409,
    '待重生时回合应被拒绝',
  );

  // 待重生状态下，缺少名字应报 400（且不会误改状态）。
  await assert.rejects(
    () => g.rebirth(id, { name: '', appearance: '红衣' }),
    (err) => err && err.status === 400,
    '重生缺少名字应报错',
  );

  const rb = await g.rebirth(id, { name: '二世旅人', appearance: '红衣' });
  assert.equal(rb.character.alive, true);
  assert.equal(rb.character.name, '二世旅人');
  assert.equal(rb.awaitingRebirth, false);
  assertNoLeak(rb);

  const res = await g.takeTurn(id, { action: '重生后的第一步' });
  assert.equal(res.state.turn, 1);
  assertNoLeak(res);
});

test('错误路径：世界不存在返回 404；无效 seed 返回 400；删除后不可访问', async (t) => {
  const { g } = makeGame(t);
  await assert.rejects(
    () => g.getWorld('never-existed'),
    (err) => err && err.status === 404,
  );
  await assert.rejects(
    () => g.buildWorld({ seed: '   ' }),
    (err) => err && err.status === 400,
  );
  const world = await g.buildWorld({ seed: '云端集市', name: '乙', appearance: '灰袍' });
  const del = await g.deleteWorld(world.id);
  assert.equal(del.deleted, true);
  await assert.rejects(
    () => g.getWorld(world.id),
    (err) => err && err.status === 404,
  );
});

function WORLD_ID_OK(id) {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
