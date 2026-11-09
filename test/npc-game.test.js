'use strict';

// 任务3 接线测试：game.js 的旧存档回填 / revision 缓存 / npc_updates 落库 / 公开去私密 /
// 完整档案导出 / getNpcDetail 分页，以及 store.worldRevision 的只读行为。
// 只读旧世界一律手工构造 fixture，不调真模型、不写生产存档。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const engine = require('../src/engine.js');
const eventLog = require('../src/event-log.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');

const SECRET = 'sk-NPC-GAME-TEST-SECRET';

function makeGame(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-npcgame-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = SECRET;
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  return { g: game.createGame(cfg, dataDir), dataDir, tmp, cfg };
}

function assertNoPrivate(value, label) {
  const text = JSON.stringify(value);
  for (const key of ['npc_memory', 'npc_updates', 'original', 'want', 'internal', 'apex', 'twist', 'LLM_API_KEY']) {
    assert.equal(new RegExp(`"${key}"\\s*:`).test(text), false, `${label || '公开响应'} 不应含私有键 ${key}`);
  }
  assert.equal(text.includes(SECRET), false, `${label || '公开响应'} 不应含 API Key 值`);
}

function diskBytes(dataDir, id) {
  return [store.statePath(dataDir, id), store.eventsPath(dataDir, id)].map((p) => {
    try { return fs.readFileSync(p).toString('base64'); } catch (_) { return null; }
  });
}

function writeOldWorld(dataDir, id, opts) {
  const o = opts || {};
  const npcs = (o.npcs || ['甲', '乙']).map((n) => Object.assign(
    { role: '更夫', desc: '旧设定形象', want: 'SENTINEL_WANT', voice: '短句' },
    typeof n === 'string' ? { name: n } : n,
  ));
  const state = engine.createWorld({
    id,
    name: o.heroName || '旧旅人',
    appearance: '青衣',
    genre: 'general', // 合法题材，避免 getWorld 后台补判题材写盘
    bible: { title: '旧世界', npcs, start: { place: '城门' } },
  }, { rng: () => 0.5, now: 1000 });
  state.turn = Number.isInteger(o.turn) ? o.turn : 2;
  state.character.name = o.heroName || '旧旅人';
  delete state.npcProfiles;
  delete state.npcMemoryVersion; // 旧格式：需要只读回填
  store.saveWorld(dataDir, state);
  return state;
}

function appendEvent(dataDir, id, rec) {
  store.appendEvent(dataDir, id, Object.assign({
    turn: 1, life: 1, action: '行动', narration: '', applied: { npc_attitude: {} },
  }, rec));
}

function collectDetail(g, id, npcId, limit) {
  const out = [];
  let before;
  for (let guard = 0; guard < 10000; guard += 1) {
    const opts = before === undefined ? { limit } : { limit, before };
    const d = g.getNpcDetail(id, npcId, opts);
    if (!d) break;
    out.push(...d.history.entries);
    if (d.history.nextCursor === null || d.history.nextCursor === undefined) break;
    before = d.history.nextCursor;
  }
  return out;
}

// 拦截 llm.createClient，统计 complete / completeStream 调用次数（读路径应恒为 0）。
function spyLlm(t) {
  const orig = llm.createClient;
  let calls = 0;
  llm.createClient = function (...args) {
    const client = orig.apply(this, args);
    for (const name of ['complete', 'completeStream']) {
      const fn = client[name];
      client[name] = function (...a) { calls += 1; return fn.apply(this, a); };
    }
    return client;
  };
  t.after(() => { llm.createClient = orig; });
  return () => calls;
}

test('game.visibleEventRecords 引用共享 event-log，撤回语义一致', () => {
  const events = [
    { turn: 1, narration: 'a' },
    { turn: 2, narration: 'b' },
    { turn: 3, narration: 'c-old' },
    { type: 'undo', undoneTurn: 3 },
    { turn: 3, narration: 'c-new' },
  ];
  assert.deepEqual(game.visibleEventRecords(events), eventLog.visibleEventRecords(events));
  assert.deepEqual(eventLog.visibleEventRecords(events).map((r) => r && r.narration), ['a', 'b', 'c-new']);
});

test('store.worldRevision：读不变、events 追加即变、state 改写即变、缺文件安全', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-npcrev-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const id = 'wrev';
  const r0 = store.worldRevision(tmp, id);
  assert.equal(typeof r0, 'string');
  assert.equal(store.worldRevision(tmp, id), r0, '重复读不改 revision');

  store.saveWorld(tmp, { id, turn: 0 });
  const r1 = store.worldRevision(tmp, id);
  assert.notEqual(r1, r0, 'state 建立后 revision 变化');

  store.appendEvent(tmp, id, { turn: 1, narration: 'x' });
  const r2 = store.worldRevision(tmp, id);
  assert.notEqual(r2, r1, 'events 追加后 revision 变化');
  assert.equal(store.worldRevision(tmp, id), r2);

  // 撤回标记 + 复用同 turn 重走：events 字节继续变化，revision 仍失效
  store.appendEvent(tmp, id, { type: 'undo', undoneTurn: 1 });
  const r3 = store.worldRevision(tmp, id);
  assert.notEqual(r3, r2);
  store.appendEvent(tmp, id, { turn: 1, narration: 'y' });
  assert.notEqual(store.worldRevision(tmp, id), r3);

  store.saveWorld(tmp, { id, turn: 2 });
  assert.notEqual(store.worldRevision(tmp, id), r3, 'state 改写后 revision 变化');
});

test('旧世界：loadState 只读回填，读不写盘 / 不调模型 / 原文完整 / 私密不泄露', async (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'wold';
  writeOldWorld(dataDir, id, { turn: 2 });
  appendEvent(dataDir, id, { turn: 1, action: '找甲', narration: '甲在城门下提灯，甲穿着青布长衫。' });
  appendEvent(dataDir, id, { turn: 2, action: '找乙', narration: '乙在集市摆摊，乙抬头看你。' });
  const llmCalls = spyLlm(t);

  const before = diskBytes(dataDir, id);
  const pub = await g.getWorld(id);
  const idA = engine.stableId(id, '甲');
  const idB = engine.stableId(id, '乙');
  assert.ok(pub.npcProfiles[idA], '甲 由 canonical 可见叙事建立公开档案');
  assert.ok(pub.npcProfiles[idB], '乙 由 canonical 可见叙事建立公开档案');
  assert.equal(pub.npcProfiles[idA].name, '甲');
  assertNoPrivate(pub.npcProfiles[idA], '公共 profile');
  assert.equal(Object.prototype.hasOwnProperty.call(pub.bible.npcs[0], 'want'), false, 'bible 旁路去 want');

  const detail = g.getNpcDetail(id, idA, {});
  assert.ok(detail, '已公开人物返回详情');
  assert.ok(detail.profile && detail.history);
  const all = collectDetail(g, id, idA, 2);
  assert.equal(all.length, detail.history.total, '分页可翻完全部记录');
  assert.ok(all.some((e) => e.narration === '甲在城门下提灯，甲穿着青布长衫。'), '原文完整');
  const indices = all.map((e) => e.eventIndex);
  assert.equal(new Set(indices).size, indices.length, '排他游标不重复');

  g.exportWorld(id);
  g.getWorldLog(id, 50);

  assert.deepEqual(diskBytes(dataDir, id), before, '读取前后磁盘字节不变');
  assert.equal(llmCalls(), 0, '只读回填不得调用模型');
  const disk = store.loadWorld(dataDir, id);
  assert.equal(disk.bible.npcs[0].want, 'SENTINEL_WANT', '私有 state 完整保留 want');
  assert.equal(disk.npcProfiles, undefined, 'loadState 回填不写回 state 文件');
  assert.equal(disk.npcMemoryVersion, undefined, '不伪标迁移完成');
});

test('缓存按 state/events revision 失效：undo / 重走同 turn 不复活旧分支 NPC', async (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'wundo';
  writeOldWorld(dataDir, id, { turn: 2 });
  appendEvent(dataDir, id, { turn: 1, action: '找甲', narration: '甲在城门下提灯。' });
  appendEvent(dataDir, id, { turn: 2, action: '找乙', narration: '乙在集市摆摊。' });

  // 只统计 loadState 触发的 hydrateNpcMemory（getNpcHistory 内部用 npcs 局部函数，不计入）。
  const orig = engine.hydrateNpcMemory;
  let calls = 0;
  engine.hydrateNpcMemory = function (...a) { calls += 1; return orig.apply(this, a); };
  t.after(() => { engine.hydrateNpcMemory = orig; });

  let pub = await g.getWorld(id);
  const first = calls;
  assert.equal(first, 1, '首次读取回填一次');
  assert.ok(pub.npcProfiles[engine.stableId(id, '乙')]);

  await g.getWorld(id);
  assert.equal(calls, first, '同一 revision 命中缓存，不重复全史扫描');

  // 撤回第 2 回合 + 复用同一 turn 号重走：world.turn 仍是 2，但 events 字节变了。
  store.appendEvent(dataDir, id, { type: 'undo', undoneTurn: 2 });
  store.appendEvent(dataDir, id, {
    turn: 2, life: 1, action: '重走', narration: '甲独自回到城门，四下空无一人。',
    applied: { npc_attitude: {} },
  });

  pub = await g.getWorld(id);
  assert.ok(calls > first, 'events 字节变化应使 revision 缓存失效');
  assert.equal(pub.turn, 2, '回合号不变，证明不是靠 world.turn 失效');
  assert.equal(pub.npcProfiles[engine.stableId(id, '乙')], undefined, '被撤回分支的乙不得复活');
  assert.ok(pub.npcProfiles[engine.stableId(id, '甲')]);

  assert.equal(g.getNpcDetail(id, engine.stableId(id, '乙'), {}), null, '未公开 / 不存在人物 -> null');
  const detailA = g.getNpcDetail(id, engine.stableId(id, '甲'), {});
  assert.ok(detailA);
  assert.equal(detailA.history.entries.some((e) => e.narration.includes('乙在集市')), false, '旧分支原文不复活');
  assert.ok(detailA.history.entries.some((e) => e.narration.includes('四下空无一人')), '重走原文可见');
});

test('takeTurn：npc_updates 进 state / 内部 events，公开各路径无私密 sentinel', async (t) => {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港', name: '旅人', appearance: '青衣' });
  const id = world.id;
  const result = await g.takeTurn(id, { action: '向守夜人打听钟声' });

  const events = store.readEvents(dataDir, id);
  const npcEvents = events.filter((e) => Array.isArray(e.npc_memory) && e.npc_memory.length);
  assert.ok(npcEvents.length >= 1, 'npc_memory 应进入内部 events.jsonl');
  assert.ok(npcEvents[0].npc_memory[0].evidence.length > 0, '变化带本回合原文 evidence');
  assert.ok(npcEvents[0].npc_memory[0].at, '变化带时间 / 主角记录');

  assertNoPrivate(result, 'turn 结果');
  assert.ok(result.state.npcProfiles);
  const npcId = Object.keys(result.state.npcProfiles)[0];
  assert.ok(npcId, '本回合应建立至少一个已知人物');
  assert.equal(result.state.bible.npcs[0].want, undefined, '公共 bible 不含 want');

  assertNoPrivate(await g.getWorld(id), 'getWorld');
  assertNoPrivate(g.getWorldLog(id, 50), 'log');
  assertNoPrivate(g.exportWorld(id), 'export');
  const detail = g.getNpcDetail(id, npcId, {});
  assert.ok(detail);
  assertNoPrivate(detail, '人物详情');
  assert.ok(detail.history.entries.some((e) => typeof e.narration === 'string' && e.narration.length > 0));
  assert.ok(detail.history.entries.some((e) => e.narration.includes('守夜人提灯拦住去路')), '原文完整保留');
});

test('takeTurn：主模型漏记时短补档入库并聚合用量，公开响应无补档诊断', async (t) => {
  const original = llm.createClient;
  const calls = [];
  const narration = '甲摘下斗笠，额角露出一道浅疤。';
  llm.createClient = (...args) => {
    const c = original(...args), complete = c.complete;
    c.complete = async (o) => {
      if (o.purpose === 'turn') {
        calls.push(o.purpose);
        return { content: JSON.stringify({ narration, state_diff: {}, suggestions: [],
          npc_updates: [], focus: 'social', continuing: true, scene: { draw: false } }),
        usage: { prompt_tokens: 20, completion_tokens: 10 } };
      }
      if (o.purpose === 'npc_memory') {
        calls.push(o.purpose);
        return { content: JSON.stringify({ npc_updates: [{ name: '甲', kind: 'interaction',
          evidence: narration, known: { traits: { appearance: { 疤痕: '一道浅疤' } } } }] }),
        usage: { prompt_tokens: 50, completion_tokens: 30 } };
      }
      return complete.call(c, o);
    };
    return c;
  };
  t.after(() => { llm.createClient = original; });
  const { g, dataDir } = makeGame(t);
  const s = writeOldWorld(dataDir, 'wextract', { npcs: ['甲'], turn: 2 });
  s.focus = 'social'; s.continuing = true; s.nextEventTurn = 9999; s.nextTwistTurn = 9999;
  store.saveWorld(dataDir, s);
  appendEvent(dataDir, s.id, { narration: '甲在门口招呼你。', turn: 2 });
  const result = await g.takeTurn(s.id, { action: '与甲说话' });
  assert.deepEqual(calls, ['turn', 'npc_memory']);
  assert.equal(result.narration, narration);
  const id = engine.stableId(s.id, '甲');
  assert.equal(result.state.npcProfiles[id].traits.appearance.疤痕, '一道浅疤');
  const last = store.readEvents(dataDir, s.id).at(-1);
  assert.equal(last.npc_memory_extraction.accepted, 1);
  assert.deepEqual(last.usage, { prompt_tokens: 70, completion_tokens: 40 });
  assert(!JSON.stringify(result).includes('npc_memory_extraction'));
  assert(!JSON.stringify(g.getWorldLog(s.id, 50)).includes('npc_memory_extraction'));
  assertNoPrivate(g.exportWorld(s.id), '补档公开导出');
});

test('exportWorld：公开档案导出翻页收集全部履历（>50 条），原文完整、不含私密', async (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'warch';
  const state = engine.createWorld({
    id,
    name: '旅人',
    appearance: '青衣',
    genre: 'general',
    bible: {
      title: '档案例世界',
      npcs: [{ name: '甲', role: '更夫', desc: '旧设定形象', want: 'SENTINEL_WANT', voice: '短句' }],
      start: { place: '城门' },
    },
  }, { rng: () => 0.5, now: 1000 });
  store.saveWorld(dataDir, state);
  // 120 条 canonical 可见叙事，甲 每条都出现：分页上限 50，必须翻三页才读得全。
  for (let i = 1; i <= 120; i += 1) {
    appendEvent(dataDir, id, {
      turn: i, life: 1, action: `第${i}回合`,
      narration: `第${i}回合：甲在城门下提灯，甲说了第${i}句完整原话，风从港上来。`,
    });
  }

  const exp = g.exportWorld(id);
  assertNoPrivate(exp, 'export');
  assert.equal(exp.events.some((e) => Object.prototype.hasOwnProperty.call(e, 'npc_memory')), false,
    '公开 events 记录不含 npc_memory');
  const npcId = engine.stableId(id, '甲');
  const arch = exp.npcArchive[npcId];
  assert.ok(arch, '档案以稳定 id 索引');
  assert.ok(arch.profile);
  assert.ok(arch.history.entries.length > 50, '不能只导出前 20/50 条');
  assert.equal(arch.history.entries.length, arch.history.total, '导出条目数等于 total');
  assert.ok(arch.history.entries.every((e) => typeof e.narration === 'string'));
  assert.ok(arch.history.entries.some((e) => e.narration.includes('第120句完整原话')), '最旧原文也在');
  assert.ok(arch.history.entries.some((e) => e.narration.length > 30), '原文完整不截断');
  assertNoPrivate(arch, '公开档案');
});

test('getNpcDetail：分页排他游标、limit 夹取、未知/跨 id 返回 null', async (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'wpage';
  writeOldWorld(dataDir, id, { turn: 5, npcs: ['甲'] });
  for (let i = 1; i <= 8; i += 1) {
    appendEvent(dataDir, id, { turn: i, action: '回合' + i, narration: `第${i}回合：甲在城门。` });
  }
  const npcId = engine.stableId(id, '甲');

  const p1 = g.getNpcDetail(id, npcId, { limit: 3 });
  assert.ok(p1);
  assert.equal(p1.history.entries.length, 3);
  assert.equal(p1.history.hasMore, true);
  assert.ok(Number.isInteger(p1.history.nextCursor) && p1.history.nextCursor >= 0);
  const p2 = g.getNpcDetail(id, npcId, { limit: 3, before: p1.history.nextCursor });
  assert.ok(p2);
  assert.equal(p2.history.entries.every((e) => e.eventIndex < p1.history.nextCursor), true, 'before 排他');
  const all = collectDetail(g, id, npcId, 3);
  assert.equal(all.length, p1.history.total);
  assert.equal(new Set(all.map((e) => e.eventIndex)).size, all.length, '翻页无重复');

  assert.equal(g.getNpcDetail(id, 'npc_missing', {}), null);
  assert.equal(g.getNpcDetail(id, '__proto__', {}), null, '危险 id 不串档');
  assert.equal(g.getNpcDetail('wother', npcId, {}), null, '跨世界 / 不存在世界返回 null');
});

// =========================================================================
// 第1轮收尾返工：有效当前档案导出 / 完整导出分页安全 / 回填缓存有界
// =========================================================================

// 有效 schema1 世界：npcMemoryVersion 达标、基线结构完整，甲 有一份「完整的当前档案」，
// 且 established=true。旧日志可以全缺，或只剩部分记录。
function writeRichCurrentWorld(dataDir, id) {
  const state = engine.createWorld({
    id,
    name: '旅人',
    appearance: '青衣',
    genre: 'general',
    bible: {
      title: '当前档案世界',
      npcs: [{ name: '甲', role: '更夫', desc: '旧设定里的更夫形象', want: 'SENTINEL_WANT', voice: '短句' }],
      start: { place: '城门' },
    },
  }, { rng: () => 0.5, now: 1000 });
  const npcId = engine.stableId(id, '甲');
  const p = state.npcProfiles[npcId];
  p.role = '当朝太医';
  p.description = '甲常穿青布长衫，说话慢条斯理';
  p.voice = '低声细语';
  p.publicGoal = '替旅人查清旧案';
  p.relationshipSummary = '曾在城门替旅人指过路';
  p.traits.appearance = { 衣着: '青布长衫' };
  p.traits.personality = { 沉稳: '处事不惊' };
  p.traits.abilities = { 医术: '通晓药性' };
  p.internal = { 隐秘: 'SENTINEL_INTERNAL' };
  p.established = true;
  const at = { turn: 1, life: 1, heroName: '旅人', clock: { day: 1, period: '清晨' } };
  p.initial = {
    role: '当朝太医',
    description: '甲常穿青布长衫，说话慢条斯理',
    voice: '低声细语',
    traits: JSON.parse(JSON.stringify(p.traits)),
  };
  p.firstRecord = at;
  p.lastRecord = at;
  p.lastInteraction = at;
  p.latestExcerpt = '甲在城门下提灯';
  p.attitude = 2;
  state.npcAttitude = Object.assign({}, state.npcAttitude, { 甲: 2 });
  store.saveWorld(dataDir, state);
  return { state, npcId };
}

function assertCurrentProfileKept(exp, npcId, label) {
  assertNoPrivate(exp, label);
  const arch = exp.npcArchive[npcId];
  assert.ok(arch, `${label}：有效当前档案的人物不得因缺 / 部分日志被丢掉`);
  assert.equal(arch.profile.name, '甲');
  assert.equal(arch.profile.role, '当朝太医', `${label}：当前 role 不丢`);
  assert.equal(arch.profile.description, '甲常穿青布长衫，说话慢条斯理', `${label}：当前描述不丢`);
  assert.equal(arch.profile.voice, '低声细语');
  assert.deepEqual(arch.profile.traits.appearance, { 衣着: '青布长衫' }, `${label}：当前 traits 不丢`);
  assert.deepEqual(arch.profile.traits.personality, { 沉稳: '处事不惊' });
  assert.deepEqual(arch.profile.traits.abilities, { 医术: '通晓药性' });
  assert.equal(arch.history.entries.length, arch.history.total, `${label}：total 与实收条目一致`);
  return arch;
}

test('exportWorld：有效 schema1 当前档案 + 旧日志全缺，保留当前人物/traits 不谎报完整原文', (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'wcur0';
  const { npcId } = writeRichCurrentWorld(dataDir, id);
  const exp = g.exportWorld(id); // 完全不写 events.jsonl
  const arch = assertCurrentProfileKept(exp, npcId, '缺日志');
  assert.equal(arch.history.entries.some((e) => e.narration.length > 0), false,
    '缺日志时不谎报存在完整回合原文（合成开场 narration 为空）');
  assert.equal(exp.events.length, 0, '公开 events 不造记录');
});

test('exportWorld：有效 schema1 当前档案 + 只剩与甲无关的部分日志，仍保留当前档案', (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'wcur1';
  const { npcId } = writeRichCurrentWorld(dataDir, id);
  appendEvent(dataDir, id, { turn: 1, action: '沿旧道', narration: '雾里传来断续的钟声，四下空无一人。' });
  appendEvent(dataDir, id, { turn: 2, action: '看榜', narration: '城门口贴出新的更漏告示，路人匆匆而过。' });
  const exp = g.exportWorld(id);
  const arch = assertCurrentProfileKept(exp, npcId, '部分日志（不含甲）');
  assert.equal(arch.history.entries.some((e) => e.narration.length > 0), false,
    '无关日志不得被谎报成甲的履历原文');
  assert.equal(exp.events.length, 2, '公开 events 只来自剩余 canonical 记录');
});

test('exportWorld：有效 schema1 当前档案 + 只剩少量甲真实记录，履历恰好等于剩余记录不造全文', (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'wcur2';
  const { npcId } = writeRichCurrentWorld(dataDir, id);
  appendEvent(dataDir, id, { turn: 1, action: '找甲', narration: '甲在城门下提灯，甲穿着青布长衫。' });
  appendEvent(dataDir, id, { turn: 2, action: '再找甲', narration: '甲把旧册子递给你，甲没多说。' });
  const exp = g.exportWorld(id);
  const arch = assertCurrentProfileKept(exp, npcId, '部分日志（含甲）');
  const realNarrations = arch.history.entries.map((e) => e.narration).filter((s) => s.length > 0);
  assert.deepEqual(realNarrations.sort(), [
    '甲在城门下提灯，甲穿着青布长衫。', '甲把旧册子递给你，甲没多说。',
  ].sort(), '履历原文恰好是剩余 canonical 记录，不多造 / 不补全成完整历史');
});

// ---- 完整导出的分页安全：用小 stub 模拟异常，不造巨量日志文件 ----

async function worldWithEstablishedNpc(t) {
  const { g, dataDir } = makeGame(t);
  const world = await g.buildWorld({ seed: '雾港', name: '旅人', appearance: '青衣' });
  const id = world.id;
  await g.takeTurn(id, { action: '向守夜人打听钟声' });
  return { g, dataDir, id };
}

function histEntry(eventIndex, narration) {
  return { eventIndex, kind: 'mention', narration, excerpt: '', action: '', at: null, changes: [] };
}
function histPage(entries, nextCursor, hasMore, total) {
  return { profile: { name: '甲' }, history: { entries, nextCursor, hasMore, total } };
}
function stubNpcHistory(t, responder) {
  const orig = engine.getNpcHistory;
  let calls = 0;
  engine.getNpcHistory = function (state, rawEvents, npcId, opts) {
    calls += 1;
    return responder(opts || {}, calls);
  };
  t.after(() => { engine.getNpcHistory = orig; });
  return () => calls;
}

test('exportWorld：hasMore=true 却无 nextCursor → 明确失败，不返回半份导出', async (t) => {
  const { g, id } = await worldWithEstablishedNpc(t);
  stubNpcHistory(t, () => histPage([histEntry(9, 'x')], null, true, 40));
  assert.throws(() => g.exportWorld(id), /导出中止|游标异常/);
});

test('exportWorld：分页游标不前进 / 倒退循环 → 明确失败', async (t) => {
  const { g, id } = await worldWithEstablishedNpc(t);
  stubNpcHistory(t, (opts) => (opts.before === undefined
    ? histPage([histEntry(9, 'x')], 5, true, 40)
    : histPage([histEntry(4, 'y')], 5, true, 40)));
  assert.throws(() => g.exportWorld(id), /导出中止|游标/);
});

test('exportWorld：后续页为空 → 明确失败', async (t) => {
  const { g, id } = await worldWithEstablishedNpc(t);
  stubNpcHistory(t, (opts) => (opts.before === undefined
    ? histPage([histEntry(9, 'x')], 5, true, 40)
    : histPage([], null, false, 40)));
  assert.throws(() => g.exportWorld(id), /导出中止|空页/);
});

test('exportWorld：读完条目数不足 total → 明确失败，不返回「完整」半份', async (t) => {
  const { g, id } = await worldWithEstablishedNpc(t);
  stubNpcHistory(t, () => histPage([histEntry(9, 'x')], null, false, 40));
  assert.throws(() => g.exportWorld(id), /导出中止|不完整/);
});

test('exportWorld：游标恒真 / guard 耗尽 → 明确失败而非静默成功', async (t) => {
  const { g, id } = await worldWithEstablishedNpc(t);
  const seq = { 10: 5, 5: 2, 2: 0 };
  stubNpcHistory(t, (opts) => (opts.before === undefined
    ? histPage([histEntry(10, 'x')], 10, true, 3)
    : histPage([histEntry(Number(opts.before), 'y')], seq[Number(opts.before)], true, 3)));
  assert.throws(() => g.exportWorld(id), /导出中止|安全上限/);
});

test('exportWorld：正常 120+ 条、before=0 合成开场仍读全（小 stub，不写巨量日志）', async (t) => {
  const { g, id } = await worldWithEstablishedNpc(t);
  const REAL = 150;
  const all = [];
  for (let i = 0; i < REAL; i += 1) all.push(histEntry(i, `第${i}回合：甲在城门下提灯的原文。`));
  all.push(histEntry(-1, '')); // 合成开场：narration 为空
  all.sort((a, b) => b.eventIndex - a.eventIndex);
  stubNpcHistory(t, (opts) => {
    const limit = engine.HISTORY_LIMIT_MAX;
    const before = (opts.before === undefined || opts.before === null || opts.before === '')
      ? null : Number(opts.before);
    const filtered = before === null ? all : all.filter((c) => c.eventIndex < before);
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > page.length;
    let nextCursor = null;
    if (hasMore && page.length) {
      const oldest = page[page.length - 1].eventIndex;
      if (oldest >= 0) nextCursor = oldest;
    }
    return histPage(page, nextCursor, hasMore, all.length);
  });
  const exp = g.exportWorld(id);
  const npcId = Object.keys(exp.npcArchive)[0];
  const arch = exp.npcArchive[npcId];
  assert.ok(arch, '档案收集成功');
  assert.equal(arch.history.total, REAL + 1, 'total = 150 条真实 + 1 条合成开场');
  assert.equal(arch.history.entries.length, arch.history.total, '导出条目数等于 total，不漏读');
  assert.ok(arch.history.entries.length > 120, '120+ 条全部收齐');
  assert.ok(arch.history.entries.some((e) => e.eventIndex === -1), 'before=0 翻到最旧合成开场');
  assert.ok(arch.history.entries.some((e) => e.narration.includes('第0回合')), '最旧真实原文也在');
  assert.equal(new Set(arch.history.entries.map((e) => e.eventIndex)).size,
    arch.history.entries.length, '排他游标无重复');
});

// ---- 旧回填缓存：有界 / LRU / 失效世界清理 / 命中 clone ----

test('npcHydrationCache 有界（LRU）：超出上限淘汰最旧，命中不重复回填', async (t) => {
  const { g, dataDir } = makeGame(t);
  const MAX = game.NPC_HYDRATION_CACHE_MAX;
  const orig = engine.hydrateNpcMemory;
  let calls = 0;
  engine.hydrateNpcMemory = function (...a) { calls += 1; return orig.apply(this, a); };
  t.after(() => { engine.hydrateNpcMemory = orig; });

  const ids = [];
  for (let i = 0; i < MAX + 2; i += 1) {
    const id = 'wlru' + i;
    writeOldWorld(dataDir, id, { turn: 1 });
    appendEvent(dataDir, id, { turn: 1, action: '找甲', narration: '甲在城门下提灯。' });
    await g.getWorld(id);
    ids.push(id);
  }
  assert.ok(game.npcHydrationCacheSize() <= MAX, '缓存条目数不超过上限');
  assert.equal(calls, MAX + 2, '每个旧世界首次读取各回填一次');

  const before = calls;
  await g.getWorld(ids[0]);
  assert.ok(calls > before, '超出上限后最旧条目被淘汰，重读重新回填');
  const hit = calls;
  await g.getWorld(ids[ids.length - 1]);
  assert.equal(calls, hit, '最近条目命中缓存不重复扫描全史');
});

test('npcHydrationCache：删除 / 不存在世界清理对应项，命中返回 clone 不被污染', async (t) => {
  const { g, dataDir } = makeGame(t);
  const id = 'wcache';
  writeOldWorld(dataDir, id, { turn: 1 });
  appendEvent(dataDir, id, { turn: 1, action: '找甲', narration: '甲在城门下提灯。' });
  await g.getWorld(id);
  const s1 = game.npcHydrationCacheSize();

  // 命中返回 clone：调用方改动返回 state 不应把缓存里的 hydrated 对象改脏。
  // 把 saveWorld 短路，保持 revision 不变，确保下一次读仍是缓存命中。
  const origSave = store.saveWorld;
  store.saveWorld = function () {};
  t.after(() => { store.saveWorld = origSave; });
  await g.setGenre(id, 'xuanhuan');
  const pub = await g.getWorld(id);
  assert.equal(pub.genre, 'general', '缓存命中返回 clone，调用方改动不污染缓存');

  // 删除世界清理对应项
  await g.deleteWorld(id);
  assert.equal(game.npcHydrationCacheSize(), s1 - 1, '删除后清理对应缓存项');

  // 读不到 world 时清理 / 不残留
  const s2 = game.npcHydrationCacheSize();
  await assert.rejects(g.getWorld('wnever'), /不存在|回收站/);
  assert.equal(game.npcHydrationCacheSize(), s2, '不存在世界不新增 / 不残留缓存项');
});
