'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const engine = require('../src/engine.js');
const prompts = require('../src/prompts.js');
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
  delete state.facts;
  delete state.threads;
  delete state.fadedThreads;
  delete state.character.marks;
  delete state.location;
  delete state.clock;
  delete state.pastLives;
  delete state.rebirthOpening;
  store.saveWorld(dataDir, state);

  const got = await g.getWorld(id);
  assert.equal('pendingEventTheme' in got, false);
  assert.equal(typeof got.omen, 'boolean');
  assert.equal(typeof got.danger, 'boolean', '老存档补出 danger 布尔');
  assert.equal(got.rebirthOpening, '', '老存档补出 rebirthOpening 默认值');
  assert.ok(Array.isArray(got.rumors), '老存档补出 rumors 默认值');
  assert.ok(Array.isArray(got.facts), '老存档补出 facts 默认值');
  assert.ok(Array.isArray(got.threads), '老存档补出 threads 默认值');
  assert.ok(Array.isArray(got.fadedThreads), '老存档补出 fadedThreads 默认值');
  assert.ok(Array.isArray(got.character.marks), '老存档补出 character.marks 默认值');
  assert.equal(typeof got.location, 'string', '老存档补出 location 默认值');
  assert.ok(got.clock && typeof got.clock.day === 'number', '老存档补出 clock 默认值');
  assert.ok(Array.isArray(got.pastLives), '老存档补出 pastLives 默认值');
  assertNoLeak(got);

  const res = await g.takeTurn(id, { action: '继续' }); // 老存档能正常推进回合
  assert.equal(res.state.turn, 1);
  assert.ok(Array.isArray(res.state.facts));
  assert.ok(Array.isArray(res.state.threads));
  assertNoLeak(res);
  const internal = store.loadWorld(dataDir, id);
  assert.equal('pendingEventTheme' in internal, true, '读取后补齐字段');
  assert.ok(Array.isArray(internal.rumors));
  assert.ok(Array.isArray(internal.facts));
  assert.ok(Array.isArray(internal.threads));
  assert.ok(Array.isArray(internal.fadedThreads));
  assert.ok(Array.isArray(internal.character.marks));
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

test('mock 数据覆盖新字段：回合产出 facts / marks / threads / fadedThreads，且不泄露 apex', async (t) => {
  const { g } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港钟声', name: '旅人', appearance: '青衣' });
  const id = world.id;
  for (let i = 0; i < 12; i++) await g.takeTurn(id, { action: '继续探查' });
  const s = await g.getWorld(id);
  assert.ok(Array.isArray(s.facts) && s.facts.length > 0, 'mock 应产出事实');
  assert.ok(Array.isArray(s.character.marks) && s.character.marks.length > 0, 'mock 应产出印记');
  assert.ok(Array.isArray(s.threads) && s.threads.length > 0, 'mock 应产出未解之谜');
  assert.ok(Array.isArray(s.fadedThreads) && s.fadedThreads.length > 0, 'mock 应产出淡去线索');
  s.facts.forEach((f) => {
    assert.equal(typeof f.text, 'string');
    assert.ok(f.text.length <= 30);
    assert.equal(typeof f.turn, 'number');
  });
  s.character.marks.forEach((m) => assert.ok(m.length <= 16));
  s.threads.concat(s.fadedThreads).forEach((x) => assert.ok(x.length <= 20));
  assertNoLeak(s);
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

test('濒死可感知：公开状态带 danger 布尔，体魄归零死亡回合写明死因', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雪原钟摆城', name: '初代', appearance: '白衣' });
  const id = world.id;
  const initial = await g.getWorld(id);
  assert.equal(typeof initial.danger, 'boolean');
  assert.equal(initial.danger, false);
  assertNoLeak(initial);

  const state = store.loadWorld(dataDir, id);
  state.character.attrs['体魄'] = 2;
  state.nextEventTurn = 999;
  state.activeEvent = null;
  store.saveWorld(dataDir, state);
  const near = await g.getWorld(id);
  assert.equal(near.danger, true, '体魄 2 应标记濒死');
  assertNoLeak(near);

  const res = await g.takeTurn(id, { action: '撑住' });
  assert.equal(res.state.character.attrs['体魄'], 2);
  assert.equal(res.state.danger, true, '回合结果的公开状态仍带 danger');
  assertNoLeak(res);

  // 体魄归零死亡：death.reason 供前端遮罩写明死因
  const dying = store.loadWorld(dataDir, id);
  dying.character.attrs['体魄'] = 0;
  dying.nextEventTurn = 999;
  dying.activeEvent = null;
  store.saveWorld(dataDir, dying);
  const dead = await g.takeTurn(id, { action: '倒下' });
  assert.ok(dead.death);
  assert.equal(dead.death.reason, '体魄归零');
  assertNoLeak(dead);
});

// ---------- 新一世开场（rebirth 世界内解释） ----------

test('新一世开场：templateRebirthOpening / openingFromParsed 兜底与 150~300 字', () => {
  const info = { life: 3, name: '三世', place: '灰烬港', title: '残卷', gap: '三年' };
  const tpl = game.templateRebirthOpening(info);
  assert.ok(tpl.length >= 150 && tpl.length <= 300, `模板应在 150~300 字，实际 ${tpl.length}`);
  assert.ok(tpl.includes('三世') && tpl.includes('三年') && tpl.includes('灰烬港'));
  const long = '距上一世已过五年，世界因你而改了规矩，有人隐约记得你。'.repeat(8);
  assert.equal(game.openingFromParsed({ opening: long }, info), long);
  assert.equal(game.openingFromParsed(null, info), tpl.slice(0, 300));       // 缺失回退模板
  assert.equal(game.openingFromParsed({}, info), tpl.slice(0, 300));
  assert.equal(game.openingFromParsed({ opening: '短' }, info), tpl.slice(0, 300)); // 过短回退
  assert.equal(game.openingFromParsed({ opening: '长'.repeat(400) }, info).length, 300);

  const info2 = game.rebirthInfo({
    life: 2, character: { name: '甲', appearance: '乙' },
    pastLives: [{ life: 1, name: '旧', epitaph: '铭', cause: '体魄归零' }],
    bible: { title: 'T', start: { place: 'P' } }, location: 'L',
  });
  assert.equal(info2.prevName, '旧');
  assert.equal(info2.epitaph, '铭');
  assert.equal(info2.place, 'L');
  assert.equal(info2.cause, '体魄归零');
});

test('新一世开场：重生写入 recent / events.jsonl / 公开 log，响应带 rebirthOpening、不泄露 apex', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港与旧钟声', name: '初代', appearance: '白衣' });
  const id = world.id;
  const state = store.loadWorld(dataDir, id);
  state.awaitingRebirth = true;
  state.character.alive = false;
  state.life = 2;
  state.pastLives = [{ life: 1, name: '初代', epitaph: '初代行过雾港，终没能等来钟声落款。', turns: 3, cause: '体魄归零' }];
  state.facts = [{ turn: 0, text: '满月在三日后' }];
  state.npcAttitude = { 守夜人: 2 };
  store.saveWorld(dataDir, state);

  const rb = await g.rebirth(id, { name: '二世旅人', appearance: '红衣' });
  assert.equal(typeof rb.rebirthOpening, 'string');
  assert.ok(rb.rebirthOpening.length >= 150 && rb.rebirthOpening.length <= 300,
    `开场应在 150~300 字，实际 ${rb.rebirthOpening.length}`);
  assertNoLeak(rb);

  // recent：该世第一条叙事
  const internal = store.loadWorld(dataDir, id);
  const last = internal.recent[internal.recent.length - 1];
  assert.equal(last.rebirthOpening, true);
  assert.equal(last.narration, rb.rebirthOpening.slice(0, 300));
  assert.equal(internal.rebirthOpening, rb.rebirthOpening);

  // events.jsonl：一条带 rebirthOpening 标记的公开记录
  const events = store.readEvents(dataDir, id);
  const openingRow = events.filter((x) => x.rebirthOpening);
  assert.equal(openingRow.length, 1);
  assert.equal(openingRow[0].narration, rb.rebirthOpening);
  assert.equal(openingRow[0].life, 2);
  assert.ok(openingRow[0].usage && typeof openingRow[0].usage === 'object');

  // 公开 log 暴露给前端回放
  const log = await g.getWorldLog(id, 50);
  const rec = log.find((x) => x.rebirthOpening);
  assert.ok(rec, '公开 log 应含 rebirthOpening 记录');
  assert.equal(rec.narration, rb.rebirthOpening);
  assertNoLeak(rec);

  // 重生后仍能正常推进回合
  const res = await g.takeTurn(id, { action: '二世第一步' });
  assert.equal(res.state.turn, 1);
  assertNoLeak(res);
});

// ---------- mock 覆盖新字段 / apex 不泄露 ----------

test('mock 覆盖新字段：建世界把 npcs[].voice 带入公开 bible，且彼此不同、≤20 字', async (t) => {
  const { g } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港与旧钟声', name: '甲', appearance: '乙' });
  const voices = (world.bible.npcs || []).map((n) => n.voice);
  assert.ok(voices.length >= 2);
  assert.ok(voices.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 20));
  assert.equal(new Set(voices).size, voices.length, 'voice 必须彼此不同');
  assertNoLeak(world);
});

test('apex 不泄露：含 danger / rebirthOpening / voice 的公开状态、回合结果、log 均无 apex 与 Key', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港钟摆', name: '甲', appearance: '乙' });
  const id = world.id;
  const s = store.loadWorld(dataDir, id);
  s.character.attrs['体魄'] = 1;   // 濒死
  s.rebirthOpening = '一段由重生生成的开场叙事。';
  s.nextEventTurn = 999;
  s.activeEvent = null;
  store.saveWorld(dataDir, s);

  const got = await g.getWorld(id);
  assert.equal(got.danger, true);
  assert.equal(got.rebirthOpening, '一段由重生生成的开场叙事。');
  assertNoLeak(got);
  assert.ok(store.loadWorld(dataDir, id).apex, '内部状态仍保留 apex');

  const res = await g.takeTurn(id, { action: '撑住伤势' });
  assert.equal(res.state.danger, true);
  assertNoLeak(res);
  const log = await g.getWorldLog(id, 50);
  log.forEach((rec) => assertNoLeak(rec));
});

function WORLD_ID_OK(id) {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

// ---------- 导演机制 / 越界升级 / 开局事实 / 老存档 / 不泄露 ----------

test('导演机制：mock 30 回合出现转折写入 events.jsonl，公开状态/回合结果/log 均不含 twist', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港与永不熄灭的钟声', name: '旅人', appearance: '青衣' });
  const id = world.id;
  for (let i = 0; i < 30; i++) {
    const before = await g.getWorld(id);
    if (before.awaitingRebirth) await g.rebirth(id, { name: '新', appearance: '衣' });
    const res = await g.takeTurn(id, { action: '继续探查钟声的来源' });
    assert.equal('twist' in res, false, '公开回合结果不得含 twist 字段');
    assert.equal('twist' in res.state, false, '公开状态不得含 twist 字段');
    for (const tw of engine.TWISTS) {
      assert.equal(JSON.stringify(res).includes(tw), false, `公开响应不得泄露转折词「${tw}」`);
    }
    assertNoLeak(res);
  }
  const events = store.readEvents(dataDir, id);
  const twistRows = events.filter((x) => x.twist);
  assert.ok(twistRows.length >= 1, `30 回合内应至少出现一次转折，实际 ${twistRows.length}`);
  for (const row of twistRows) {
    assert.ok(engine.TWISTS.includes(row.twist), '转折词必须来自 TWISTS');
  }
  // 公开 log 记录不含 twist
  const log = await g.getWorldLog(id, 50);
  for (const rec of log) {
    assert.equal('twist' in rec, false, '公开 log 记录不得含 twist');
    assertNoLeak(rec);
  }
  // 内部状态确实记录了转折回合与绕圈计数
  const internal = store.loadWorld(dataDir, id);
  assert.equal(typeof internal.lastTwistTurn, 'number');
  assert.ok(internal.lastTwistTurn >= 1, '应记录 lastTwistTurn');
  assert.equal(typeof internal.sceneStreak, 'number');
});

test('log 公开记录：twist 只进内部日志，绝不出现在公开 log / 公开字段里', () => {
  const pub = game.toPublicLogRecord({
    turn: 9, life: 1, action: '探查', narration: '叙事内容。',
    twist: '闯入者', apex: { achieved: true }, raw: '{}',
    proposal: {}, applied: {}, rejected: [], usage: {}, ts: 1,
  });
  assert.equal('twist' in pub, false);
  assert.equal(JSON.stringify(pub).includes('闯入者'), false);
  assert.equal('apex' in pub, false);
  assert.equal('raw' in pub, false);
  assert.equal('proposal' in pub, false);
});

test('越界升级：mock 回合累计 oversteps，overstep 写进 events.jsonl 的 proposal', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港钟声', name: '甲', appearance: '乙' });
  const id = world.id;
  for (let i = 0; i < 14; i++) await g.takeTurn(id, { action: '继续探查' });
  const s = await g.getWorld(id);
  assert.equal(typeof s.oversteps, 'number');
  assert.ok(s.oversteps >= 1, 'mock 应累计越界次数（约每 7 回合一次）');
  const events = store.readEvents(dataDir, id);
  assert.ok(events.every((e) => e.proposal && typeof e.proposal.overstep === 'boolean'),
    '每回合 proposal 都应带 overstep 布尔');
  assert.ok(events.some((e) => e.proposal.overstep === true), 'events.jsonl 应记录 overstep:true');
  assertNoLeak(s);
});

test('开局事实：mock 建世界把 start.facts 写入 state.facts（turn=0），并进入回合 prompt 的事实段', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '满月诅咒的王国', name: '甲', appearance: '乙' });
  assert.ok(Array.isArray(world.facts));
  const opening = world.facts.filter((f) => f.turn === 0);
  assert.ok(opening.length >= 2 && opening.length <= 3, '开局应写入 2~3 条事实');
  assert.ok(opening.some((f) => f.text === '满月在三日后'), '应含关键时间事实（满月）');
  assert.ok(opening.every((f) => f.text.length <= engine.FACT_TEXT_MAX));
  const internal = store.loadWorld(dataDir, world.id);
  assert.ok(internal.facts.some((f) => f.text === '满月在三日后'));
  // 开局事实作为「已确立的事实」进入回合 prompt，供叙事遵守、不得改写
  const [system] = prompts.buildTurnMessages(internal, { nextTurn: 1 }, '探查');
  assert.match(system.content, /【已确立的事实（叙事必须遵守，不得改写）】/);
  assert.ok(system.content.includes('满月在三日后'));
  assertNoLeak(world);
});

test('老存档：缺 sceneStreak/lastTwistTurn/nextTwistTurn/oversteps 时读取补默认、能正常推进', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '旧世界', name: '甲', appearance: '乙' });
  const id = world.id;
  const state = store.loadWorld(dataDir, id);
  delete state.sceneStreak;
  delete state.lastTwistTurn;
  delete state.nextTwistTurn;
  delete state.oversteps;
  store.saveWorld(dataDir, state);

  const got = await g.getWorld(id);
  assert.equal(got.sceneStreak, 0);
  assert.equal(got.lastTwistTurn, 0);
  assert.equal(got.oversteps, 0);
  assert.equal(typeof got.nextTwistTurn, 'number');
  assertNoLeak(got);

  const res = await g.takeTurn(id, { action: '继续' });
  assert.equal(res.state.turn, 1);
  assert.equal(typeof res.state.sceneStreak, 'number');
  assertNoLeak(res);
  const internal = store.loadWorld(dataDir, id);
  assert.equal(typeof internal.sceneStreak, 'number');
  assert.equal(typeof internal.oversteps, 'number');
  assert.equal(typeof internal.nextTwistTurn, 'number');
});

// ---------- 流式回合（onDelta）----------

test('流式回合：takeTurn 传入 onDelta 时逐段回调叙事，结果与非流式一致且仍在互斥锁内', async (t) => {
  const { g } = makeGame(t);
  const world = await g.buildWorld({ seed: '流式叙事世界', name: '甲', appearance: '乙' });
  const id = world.id;

  const deltas = [];
  const res = await g.takeTurn(id, { action: '开始流式' }, (text) => deltas.push(text));
  assert.ok(deltas.length >= 2, '应多次回调 delta');
  assert.equal(deltas.join(''), res.narration, '回调拼接应等于完整叙事');
  assert.ok(res.narration && res.narration.length >= 10);
  assert.equal(res.state.turn, 1);
  assertNoLeak(res);

  // 后续回合仍可流式，且互斥锁保证同世界串行推进。
  const deltas2 = [];
  const res2 = await g.takeTurn(id, { action: '继续流式' }, (text) => deltas2.push(text));
  assert.equal(res2.state.turn, 2);
  assert.equal(deltas2.join(''), res2.narration);
  assertNoLeak(res2);

  // 同一世界并发两个流式回合仍严格串行（turn 依次 3、4）。
  const [a, b] = await Promise.all([
    g.takeTurn(id, { action: '并发甲' }, () => {}),
    g.takeTurn(id, { action: '并发乙' }, () => {}),
  ]);
  assert.deepEqual([a.state.turn, b.state.turn].sort((x, y) => x - y), [3, 4]);
});

// ---------- 撤回上一步 ----------

test('撤回：成功后恢复上一回合状态、追加 undo 标记、/log 跳过被撤回回合、只能一步', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港钟声', name: '甲', appearance: '乙' });
  const id = world.id;

  const r1 = await g.takeTurn(id, { action: '第一步：环顾' });
  assert.equal(r1.state.turn, 1);
  assert.equal(r1.state.undoAvailable, true, '回合后应可撤回');
  assert.ok(store.hasUndoBackup(dataDir, id), '回合前应生成 state.prev.json');

  const r2 = await g.takeTurn(id, { action: '第二步：探查' });
  assert.equal(r2.state.turn, 2);

  // 撤回：恢复到第 1 回合后的状态（turn=1）
  const u = await g.undoTurn(id);
  assert.equal(u.turn, 1, '撤回后应回到第 1 回合');
  assert.equal(u.undoneTurn, 2, '应报告被撤回的回合号');
  assert.equal(u.undoneAction, '第二步：探查', '应返回被撤回的行动文字（供前端回填）');
  assert.equal(u.undoAvailable, false, '撤回后不再可撤回（只一步）');
  assert.equal(store.hasUndoBackup(dataDir, id), false, '.prev 应被删除');

  // events.jsonl 只追加：undo 标记追加、原回合记录仍在（不删除）
  const events = store.readEvents(dataDir, id);
  const markers = events.filter((e) => e.type === 'undo');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].undoneTurn, 2);
  assert.equal(typeof markers[0].ts, 'number');
  assert.equal(events.filter((e) => e.turn === 2).length, 1, '原第 2 回合日志仍保留');

  // /log 跳过被撤回的第 2 回合，也不把 undo 标记当公开记录
  const log = await g.getWorldLog(id, 50);
  assert.ok(log.every((rec) => rec.turn !== 2), '被撤回回合不应出现在 /log');
  assert.equal(log.length, 1, '/log 只剩第 1 回合');
  assert.ok(log.every((rec) => !('type' in rec)), 'undo 标记不应作为公开记录出现');

  // 只能撤回一步
  await assert.rejects(
    () => g.undoTurn(id),
    (err) => err && err.status === 409 && /没有可以撤回的回合/.test(err.message),
  );

  // 撤回后再走一步会复用回合号 2，新回合仍可见、可再次撤回
  const r2b = await g.takeTurn(id, { action: '第二步（重来）' });
  assert.equal(r2b.state.turn, 2);
  assert.equal(r2b.state.undoAvailable, true);
  const log2 = await g.getWorldLog(id, 50);
  assert.equal(log2.filter((rec) => rec.turn === 2).length, 1, '重来的第 2 回合应可见');
  assert.equal(log2[log2.length - 1].action, '第二步（重来）');
});

test('撤回：从未走过回合时返回 409「没有可以撤回的回合」', async (t) => {
  const { g } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港', name: '甲', appearance: '乙' });
  await assert.rejects(
    () => g.undoTurn(world.id),
    (err) => err && err.status === 409 && /没有可以撤回的回合/.test(err.message),
  );
  const got = await g.getWorld(world.id);
  assert.equal(got.undoAvailable, false, '新世界无撤回');
});

test('撤回：死亡回合返回 409 并说明', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雪原', name: '甲', appearance: '乙' });
  const id = world.id;
  const s = store.loadWorld(dataDir, id);
  s.character.attrs['体魄'] = 0;
  s.nextEventTurn = 999;
  s.activeEvent = null;
  store.saveWorld(dataDir, s);
  const res = await g.takeTurn(id, { action: '倒下' });
  assert.ok(res.death, '本回合应触发死亡');
  assert.equal(res.state.undoAvailable, false, '死亡回合不可撤回');
  await assert.rejects(
    () => g.undoTurn(id),
    (err) => err && err.status === 409 && /死亡/.test(err.message),
  );
});

test('撤回：重生之后不允许撤回上一世，返回 409 并说明', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雪原', name: '甲', appearance: '乙' });
  const id = world.id;
  const s = store.loadWorld(dataDir, id);
  s.character.attrs['体魄'] = 0;
  s.nextEventTurn = 999;
  s.activeEvent = null;
  store.saveWorld(dataDir, s);
  await g.takeTurn(id, { action: '倒下' }); // 死亡回合（生成 .prev 快照）
  await g.rebirth(id, { name: '二世', appearance: '红衣' }); // 重生
  const got = await g.getWorld(id);
  assert.equal(got.undoAvailable, false, '重生后不可撤回上一世');
  await assert.rejects(
    () => g.undoTurn(id),
    (err) => err && err.status === 409 && /重生/.test(err.message),
  );
});

test('撤回：流式回合与普通回合都在回合前生成 .prev 备份', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '流式备份世界', name: '甲', appearance: '乙' });
  const id = world.id;
  await g.takeTurn(id, { action: '普通' });
  assert.equal(store.hasUndoBackup(dataDir, id), true, '普通回合应备份');
  await g.takeTurn(id, { action: '流式' }, () => {});
  assert.equal(store.hasUndoBackup(dataDir, id), true, '流式回合应备份');
  const u = await g.undoTurn(id);
  assert.equal(u.undoneAction, '流式', '撤回的是最近一次流式回合');
  assert.equal(u.turn, 1, '恢复到第 1 回合后状态');
});

test('撤回日志过滤：undo 标记及其前一条同回合记录被跳过，复用回合号的新记录仍可见', () => {
  const events = [
    { turn: 1, action: 'a1', narration: 'n1' },
    { turn: 2, action: 'a2', narration: 'n2' },
    { type: 'undo', undoneTurn: 2, ts: 1 },
    { turn: 2, action: 'a2-重来', narration: 'n2b' },
  ];
  const vis = game.visibleEventRecords(events);
  assert.deepEqual(vis.map((e) => e.action), ['a1', 'a2-重来']);
  assert.ok(vis.every((e) => e.type !== 'undo'), 'undo 标记本身不应出现');
  // 撤回发生时尚无重来回合：取最近一条同回合记录
  assert.equal(game.lastTurnAction(events.slice(0, 3), 2), 'a2');
});
