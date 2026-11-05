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

test('编年史窗口：包含当前回合（第 20 回合压 1~20 共 20 条）', () => {
  const events = [];
  for (let t = 1; t <= 19; t++) events.push({ turn: t, action: `a${t}`, narration: `n${t}` });
  const current = { turn: 20, action: 'a20', narration: 'n20' };
  const win = game.chapterEventWindow(events, 20, current);
  assert.equal(win.length, 20, '应包含 20 条');
  assert.equal(win[0].turn, 1);
  assert.equal(win[19].turn, 20, '最后一条必须是当前回合');
  assert.equal(win[19].narration, 'n20');

  // 第 40 回合窗口为 21~40，且已存在当前回合时不重复追加。
  const many = [];
  for (let t = 1; t <= 40; t++) many.push({ turn: t });
  const win2 = game.chapterEventWindow(many, 40, { turn: 40 });
  assert.equal(win2.length, 20);
  assert.equal(win2[0].turn, 21);
  assert.equal(win2[19].turn, 40);
});

test('log 公开记录：只含公开字段，绝不含 apex / raw / proposal / rejected / usage', () => {
  const raw = {
    turn: 3, life: 1, action: '探查', narration: '你走进雾里，钟声更近了。',
    raw: '{"内部":1}', proposal: { narration: 'x' },
    applied: {
      state_diff: { 心智: 1, 体魄: -2 },
      items_add: ['一枚旧币'], items_remove: ['破布'], npc_attitude: { 守夜人: 1 },
      persona: {}, persona_tags: ['冒险'], suggestions: [], narration: '',
    },
    rejected: ['内部拒绝原因'], usage: { prompt_tokens: 10 }, ts: 123,
    apex: { achieved: true, title: '隐秘王冠', hint: '北方的钟声' },
    event: { theme: '天灾', title: '地动', desc: '大地颤抖', startedTurn: 3 },
    settlement: null, death: null,
  };
  const pub = game.toPublicLogRecord(raw);
  for (const hidden of ['apex', 'raw', 'proposal', 'rejected', 'usage']) {
    assert.equal(hidden in pub, false, `公开记录不应含 ${hidden}`);
  }
  assert.equal(JSON.stringify(pub).includes('隐秘王冠'), false);
  assert.equal(pub.turn, 3);
  assert.equal(pub.action, '探查');
  assert.equal(pub.event.title, '地动');
  assert.equal('startedTurn' in pub.event, true);
  assert.ok(pub.badges.some((b) => b.type === 'attr' && b.name === '心智' && b.delta === 1));
  assert.ok(pub.badges.some((b) => b.type === 'attr' && b.name === '体魄' && b.delta === -2));
  assert.ok(pub.badges.some((b) => b.type === 'item-add' && b.name === '一枚旧币'));
  assert.ok(pub.badges.some((b) => b.type === 'item-remove' && b.name === '破布'));
  assert.ok(pub.badges.some((b) => b.type === 'npc' && b.name === '守夜人'));

  // settlement / death 也只带公开字段，不夹带内部对象
  const pub2 = game.toPublicLogRecord({
    turn: 9, life: 2, action: '迎战', narration: '你迎了上去。',
    settlement: { theme: 't', title: '事件', tier: '蜕变', attr: '体魄', score: 30, effects: { 体魄: 3 }, rand: 5, response_quality: 3 },
    death: { reason: '事件殒命', life: 2, inheritedReputation: 2 },
    apex: { achieved: true },
  });
  assert.equal('apex' in pub2, false);
  assert.equal(pub2.settlement.tier, '蜕变');
  assert.equal('rand' in pub2.settlement, false);
  assert.equal(pub2.death.reason, '事件殒命');
});

test('风声预兆：mock 30 回合里出现预兆标记，公开状态不含主题名', async (t) => {
  const { g } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港钟声', name: '旅人', appearance: '青衣' });
  const id = world.id;
  let sawOmen = false;
  for (let i = 0; i < 30; i++) {
    const before = await g.getWorld(id);
    if (before.awaitingRebirth) await g.rebirth(id, { name: '新', appearance: '衣' });
    const res = await g.takeTurn(id, { action: '继续探查' });
    assert.equal(typeof res.state.omen, 'boolean');
    assert.equal('pendingEventTheme' in res.state, false, '公开状态不得泄露预选主题');
    if (res.state.omen) sawOmen = true;
  }
  assert.ok(sawOmen, '30 回合内应出现过风声预兆');
});

test('老存档：缺新字段的 state.json 读取时补默认，不报错', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '旧世界', name: '甲', appearance: '乙' });
  const id = world.id;
  // 抹掉新字段，模拟升级前写下的老存档
  const state = store.loadWorld(dataDir, id);
  delete state.pendingEventTheme;
  delete state.rumors;
  delete state.location;
  delete state.clock;
  delete state.pastLives;
  store.saveWorld(dataDir, state);

  const got = await g.getWorld(id);
  assert.equal('pendingEventTheme' in got, false);
  assert.equal(typeof got.omen, 'boolean');
  assert.ok(Array.isArray(got.rumors), '老存档补出 rumors 默认值');
  assert.equal(typeof got.location, 'string', '老存档补出 location 默认值');
  assert.ok(got.clock && typeof got.clock.day === 'number', '老存档补出 clock 默认值');
  assert.ok(Array.isArray(got.pastLives), '老存档补出 pastLives 默认值');

  const res = await g.takeTurn(id, { action: '继续' }); // 老存档能正常推进回合
  assert.equal(res.state.turn, 1);
  const internal = store.loadWorld(dataDir, id);
  assert.equal('pendingEventTheme' in internal, true, '读取后补齐字段');
  assert.ok(Array.isArray(internal.rumors));
});

test('坊间传闻：mock 回合产生传闻，约每 3 回合一条，公开状态可见', async (t) => {
  const { g } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港钟声', name: '旅人', appearance: '青衣' });
  const id = world.id;
  for (let i = 0; i < 9; i++) await g.takeTurn(id, { action: '继续探查' });
  const s = await g.getWorld(id);
  assert.ok(Array.isArray(s.rumors));
  assert.ok(s.rumors.length >= 2 && s.rumors.length <= 4, '约每 3 回合一条传闻');
  s.rumors.forEach((r) => {
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.length <= 40);
    assert.equal(typeof r.turn, 'number');
  });
});

test('地点与时间：mock 回合推进时段、偶发移动，公开状态可见', async (t) => {
  const { g } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港钟声', name: '旅人', appearance: '青衣' });
  const id = world.id;
  const initial = await g.getWorld(id);
  assert.equal(typeof initial.location, 'string');
  assert.deepEqual(initial.clock, { day: 1, period: '清晨' });
  for (let i = 0; i < 8; i++) await g.takeTurn(id, { action: '继续探查' });
  const s = await g.getWorld(id);
  assert.equal(typeof s.location, 'string');
  assert.ok(['清晨', '午后', '黄昏', '深夜'].includes(s.clock.period));
  assert.ok(s.clock.day > 1 || s.clock.period !== '清晨', '时间应随回合推进');
});

test('前世墓志铭：templateEpitaph / epitaphFromParsed 兜底与 ≤80 字', () => {
  const info = { life: 3, name: '旅人', turns: 12, cause: '事件殒命' };
  const tpl = game.templateEpitaph(info);
  assert.ok(tpl.length <= 80 && tpl.includes('旅人') && tpl.includes('事件殒命'));
  assert.equal(game.epitaphFromParsed({ epitaph: '  真实墓志铭  ' }, info), '真实墓志铭');
  assert.equal(game.epitaphFromParsed(null, info), tpl.slice(0, 80)); // 缺失回退模板
  assert.equal(game.epitaphFromParsed({}, info), tpl.slice(0, 80));
  assert.equal(game.epitaphFromParsed({ epitaph: '长'.repeat(100) }, info).length, 80);
});

test('前世墓志铭：死亡回合写入 pastLives，公开可见、≤80 字、不泄露 apex、不阻断重生', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雪原钟摆之城', name: '初代', appearance: '白衣' });
  const id = world.id;

  // 强制本回合体魄归零死亡（mock 事件结算不会致死）：直接把内部状态体魄设为 0。
  const state = store.loadWorld(dataDir, id);
  state.character.attrs['体魄'] = 0;
  state.nextEventTurn = 999;
  state.activeEvent = null;
  store.saveWorld(dataDir, state);

  const res = await g.takeTurn(id, { action: '力竭倒下' });
  assert.ok(res.death, '本回合应触发死亡');
  assert.ok(Array.isArray(res.state.pastLives));
  assert.equal(res.state.pastLives.length, 1);
  const pl = res.state.pastLives[0];
  assert.equal(pl.life, 1);
  assert.equal(pl.name, '初代');
  assert.equal(typeof pl.epitaph, 'string');
  assert.ok(pl.epitaph.length > 0 && pl.epitaph.length <= 80, '墓志铭 ≤80 字');
  assert.equal(typeof pl.turns, 'number');
  assert.equal(pl.cause, '体魄归零');
  assertNoLeak(res);

  // 死亡不阻断重生，且重生后仍保留前世
  const rb = await g.rebirth(id, { name: '二世', appearance: '红衣' });
  assert.equal(rb.character.alive, true);
  assert.equal(rb.pastLives.length, 1, '重生保留前世');
  assertNoLeak(rb);

  // 内部状态也确实落库
  assert.equal(store.loadWorld(dataDir, id).pastLives.length, 1);
});

function WORLD_ID_OK(id) {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
