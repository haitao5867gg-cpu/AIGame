'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/engine.js');
const { visibleEventEntries, visibleEventRecords } = require('../src/event-log.js');
const { proposal, run } = require('./helpers/engine-helpers.js');

const clone = (v) => JSON.parse(JSON.stringify(v));

function freshState(opts) {
  const o = opts || {};
  return e.createWorld(
    {
      id: o.id || 'w1',
      name: o.heroName || '旅人',
      appearance: '青衣',
      bible: { title: '测试世界', npcs: o.npcs || [], start: { place: '村口' } },
    },
    { rng: () => 0.5, now: 1000 },
  );
}

function onlyId(state) {
  return Object.keys(state.npcProfiles)[0];
}

function advance(state, turn) {
  const s = clone(state);
  s.turn = turn;
  return s;
}

// 构造一条私有 npc_memory 变化（即 result.npc_memory 的元素）。
function memChange(id, name, o) {
  const x = o || {};
  return {
    id, name,
    kind: x.kind || 'change',
    evidence: x.evidence || '',
    action: x.action || '行动',
    at: {
      turn: x.turn == null ? 1 : x.turn,
      life: x.life == null ? 1 : x.life,
      heroName: x.heroName == null ? '旅人' : x.heroName,
      clock: { day: x.day == null ? 1 : x.day, period: x.period || '清晨' },
    },
    fields: x.fields || [],
  };
}

// 构造一条 events.jsonl 记录。o.memory 给了（非空）=新格式，否则=旧格式（仅叙事/好感）。
function eventRecord(turn, o) {
  const x = o || {};
  return {
    turn,
    life: x.life == null ? 1 : x.life,
    action: x.action || '行动',
    narration: x.narration != null ? x.narration : `第${turn}回合叙事原文，标记${x.marker == null ? turn : x.marker}。`,
    applied: { npc_attitude: x.attitude || {} },
    npc_memory: x.memory || [],
  };
}

// 走一遍 applyNpcMemory，返回 {before, state, changes, rejected}。
function applyUpdates(state, updates, o) {
  const x = o || {};
  const before = clone(state);
  const after = advance(before, x.turn == null ? 1 : x.turn);
  const r = e.applyNpcMemory(before, after, updates, {
    action: x.action || '行动',
    narration: x.narration || '',
  });
  return { before, state: r.state, changes: r.changes, rejected: r.rejected };
}

// =========================================================================
// 1. 新世界初始化 / 旧档标记 / 基线
// =========================================================================

test('initializeNpcMemory：新世界按 bible.npcs 建完整 original 基线，标记已迁移，未登场不公开', () => {
  const longDesc = '博闻强记的守夜人'.repeat(120); // >1000 字，完整保留
  const state = freshState({ npcs: [
    { name: '长老', role: '导师', desc: longDesc, want: 'SENTINEL_WANT', voice: '低语' },
    { name: '铁匠' },
  ] });
  assert.equal(state.npcMemoryVersion, e.NPC_MEMORY_VERSION);
  assert.equal(Object.keys(state.npcProfiles).length, 2);
  const p = Object.values(state.npcProfiles).find((x) => x.name === '长老');
  assert.equal(p.original.desc, longDesc, '完整原始长描述不截断');
  assert.equal(p.original.want, 'SENTINEL_WANT', '完整原始对象（含 want）保留');
  assert.equal(p.original.voice, '低语');
  assert.equal(p.established, false);
  assert.equal(p.portraitName, '长老');
  assert.equal(typeof p.id, 'string');
  // 未登场演员不进公开字典
  assert.deepEqual(e.publicNpcProfiles(state), {});
});

test('normalizeState / normalizeNpcMemory：旧档补默认且保持「需要回填」标记，不伪标迁移完成', () => {
  const old = { id: 'old', turn: 5, life: 2, character: { name: '旧旅人' }, clock: { day: 3, period: '黄昏' },
    bible: { npcs: [{ name: '甲' }] }, npcAttitude: { 甲: 0 } };
  const norm = e.normalizeState(old);
  assert.equal(norm.npcMemoryVersion, 0, '旧档版本 0，不伪标 CURRENT');
  assert.deepEqual(norm.npcProfiles, {});
  assert.equal(e.needsNpcHydration(norm), true);
  assert.equal(JSON.stringify(old).includes('npcProfiles'), false, '不改入参');
  const norm2 = e.normalizeNpcMemory(norm);
  assert.equal(norm2.npcMemoryVersion, 0, 'normalizeNpcMemory 幂等，仍保持需回填标记');
  // 已迁移版本不被降级
  const cur = e.normalizeNpcMemory({ npcMemoryVersion: e.NPC_MEMORY_VERSION, npcProfiles: {} });
  assert.equal(cur.npcMemoryVersion, e.NPC_MEMORY_VERSION);
  assert.equal(e.needsNpcHydration(cur), false);
});

test('稳定 id：同一 world+name 确定性，与好感/特征/描述无关；portraitName 稳定', () => {
  const a = e.stableId('w1', '长老');
  const b = e.stableId('w1', '长老');
  const c = e.stableId('w1', '铁匠');
  const d = e.stableId('w2', '长老');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  const state = freshState({ npcs: [{ name: '长老' }] });
  const id = onlyId(state);
  const narration = '长老点头示意，递来一封旧信，是个信使。'; // 公开值摘自原文
  const r = applyUpdates(state, [{ name: '长老', evidence: '长老点头', known: { role: '信使' } }], { narration });
  assert.equal(r.state.npcProfiles[id].id, id, 'id 不因特征更新变化');
  assert.equal(r.state.npcProfiles[id].portraitName, '长老', 'portraitName 稳定');
  assert.equal(r.state.npcAttitude['长老'], state.npcAttitude['长老'], '无态度变化不强迫改 npcAttitude 数值');
});

// =========================================================================
// 2. applyNpcMemory：多字段增量合并 / 原始长资料 / 长值上限 / 空补丁
// =========================================================================

test('applyNpcMemory：多字段分类键值增量合并，旧值+新值进 npc_memory，未给项不擦除', () => {
  const state = freshState({ npcs: [{ name: '玛拉', role: '卫队长', desc: '完整原始设定', want: 'SENTINEL_WANT', voice: '冷语' }] });
  const id = onlyId(state);
  const narration = '玛拉身披褪色蓝布围裙，腰悬短刃，语气短促而冷，是巡城卫队长，性情冷峻。'; // 公开值摘自原文
  const r1 = applyUpdates(state, [{
    name: '玛拉', kind: 'interaction', evidence: '玛拉身披',
    known: {
      role: '巡城卫队长',
      voice: '语气短促而冷',
      traits: {
        appearance: { 衣着: '褪色蓝布围裙', 兵器: '短刃' },
        personality: { 性情: '冷峻' },
      },
    },
    internal: { motivation: 'SENTINEL_INTERNAL' },
  }], { narration });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  assert.equal(r1.changes.length, 1);
  const fields = r1.changes[0].fields;
  const roleChange = fields.find((f) => f.scope === 'public' && f.kind === 'scalar' && f.key === 'role');
  assert.deepEqual({ from: roleChange.from, to: roleChange.to }, { from: '', to: '巡城卫队长' }, '记录旧值/新值');
  const internalChange = fields.find((f) => f.scope === 'internal' && f.key === 'motivation');
  assert.equal(internalChange.to, 'SENTINEL_INTERNAL', '私有变化也进 npc_memory（私有事件保存）');

  // 第二次只给 description + 一个不同标签 + 私密状态；其余特征/原始对象必须保留。
  const narration2 = '玛拉旧疤未愈，人称北门的守望者，仍守着北门，低声唤住旅人。'; // 公开值摘自原文
  const r2 = applyUpdates(r1.state, [{
    id, name: '玛拉', kind: 'change', evidence: '玛拉旧疤未愈',
    known: { description: '北门的守望者', traits: { circumstances: { 旧伤: '旧疤未愈' } } },
  }], { narration: narration2 });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  const p = r2.state.npcProfiles[id];
  assert.equal(p.role, '巡城卫队长', 'role 保留');
  assert.equal(p.voice, '语气短促而冷', 'voice 保留');
  assert.equal(p.traits.appearance['衣着'], '褪色蓝布围裙', 'appearance.衣着 保留');
  assert.equal(p.traits.appearance['兵器'], '短刃', 'appearance.兵器 保留');
  assert.equal(p.traits.personality['性情'], '冷峻', 'personality 保留');
  assert.equal(p.traits.circumstances['旧伤'], '旧疤未愈', '新增 circumstances 合入');
  assert.equal(p.description, '北门的守望者');
  assert.equal(p.original.desc, '完整原始设定', 'original 不被 patch 覆盖');
  assert.equal(p.original.want, 'SENTINEL_WANT');
  assert.equal(p.internal.motivation, 'SENTINEL_INTERNAL', 'internal 不被后续空补丁擦除');
  assert.equal(p.initial.role, '巡城卫队长', 'initial 只记首次出场，不被改写');
  assert.equal(p.initial.traits.circumstances['旧伤'], undefined, 'initial 不混入后续变化');
});

test('原始长资料保留；已知长 traits 值完整接受；超过合理上限整条拒绝且不静默截断', () => {
  const longOriginal = '守夜人的漫长背景设定'.repeat(200); // 2000+ 字
  const state = freshState({ npcs: [{ name: '守夜人', desc: longOriginal, want: 'SENTINEL_WANT' }] });
  const id = onlyId(state);
  const longValue = '层叠的灰呢斗篷与铜扣'.repeat(90); // ~1000 字，合法长值
  const narration = '守夜人提灯巡夜，' + longValue + '，走过长街。'; // 公开值摘自原文，长值完整出现
  const r1 = applyUpdates(state, [{
    name: '守夜人', evidence: '守夜人提灯',
    known: { traits: { appearance: { 衣着: longValue } } },
  }], { narration });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  assert.equal(r1.state.npcProfiles[id].original.desc, longOriginal, '原始长描述全文保留');
  assert.equal(r1.state.npcProfiles[id].traits.appearance['衣着'], longValue, '长 traits 值完整接受不截断');

  const tooLong = '甲'.repeat(e.NPC_FIELD_MAX + 1);
  const r2 = applyUpdates(r1.state, [{
    id, name: '守夜人', evidence: '守夜人提灯',
    known: { role: '不该写入', traits: { appearance: { 衣着: tooLong } } },
  }], { narration });
  assert.ok(r2.rejected.length >= 1, '超限整条拒绝');
  assert.equal(r2.changes.length, 0, '超限更新不产生任何变化');
  assert.equal(r2.state.npcProfiles[id].traits.appearance['衣着'], longValue, '拒绝后旧值不变，未静默截断');
  assert.equal(r2.state.npcProfiles[id].role, '', '同条里的其它字段也未被写入');
});

test('空补丁不擦旧资料、缺字段不报错、无态度变化的新角色也能登记', () => {
  const narration = '旅人独自穿过石桥，远处钟声回荡，铁匠铺里火星四溅。';
  const state = freshState({ npcs: [] });
  // 无 id、仅 name+evidence+kind 的最简补丁：登记一个动态 NPC（无 attitude 变化）。
  const r1 = applyUpdates(state, [{ name: '铁匠', kind: 'mention', evidence: '铁匠铺里火星四溅' }], { narration });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  assert.equal(r1.changes.length, 1);
  assert.equal(r1.changes[0].fields.length, 0, '空补丁不产生字段变化');
  const id = r1.changes[0].id;
  assert.equal(r1.state.npcProfiles[id].established, true, '无态度变化仍建立记录');
  assert.equal(r1.state.npcAttitude['铁匠'], 0, '登记动态 NPC 补中立 attitude 键供头像流程识别');
  assert.ok(r1.changes[0].baseline, '动态新 NPC 携带原始基线');

  // 缺 known/internal/kind 的补丁不报错，也不擦第一次的记录。
  const r2 = applyUpdates(r1.state, [{ id, name: '铁匠', evidence: '铁匠铺里火星四溅' }], { narration });
  assert.equal(r2.rejected.length, 0);
  assert.equal(r2.state.npcProfiles[id].firstRecord.turn, r1.state.npcProfiles[id].firstRecord.turn);
  assert.equal(r2.state.npcProfiles[id].established, true);

  // 非法/空 known 类型不擦旧资料
  const r3 = applyUpdates(r2.state, [{ name: '铁匠', evidence: '铁匠铺里火星四溅', known: { role: 123 } }], { narration });
  assert.ok(r3.rejected.length >= 1, '字段类型非法被拒');
  assert.equal(r3.state.npcProfiles[id].role, '', '旧资料未被擦除');
});

test('npc_updates 非数组 / 空数组不报错；超过 6 条多余被拒', () => {
  const state = freshState({ npcs: [{ name: '甲' }] });
  const r0 = applyUpdates(state, '不是数组', { narration: '甲走过。' });
  assert.equal(r0.rejected.length, 0);
  assert.equal(r0.changes.length, 0);
  const narration = '甲与众人依次走过长廊，甲的名字反复出现。';
  const updates = [];
  for (let i = 0; i < 7; i++) updates.push({ name: '甲', evidence: '甲' });
  const r = applyUpdates(state, updates, { narration });
  assert.ok(r.rejected.some((x) => x.includes('超过')), '第 7 条被拒');
  assert.ok(r.changes.length <= 6);
});

// =========================================================================
// 3. 校验：缺证据 / 未知角色 / id-name 冲突串人 / 恶意标签 / 未知字段
// =========================================================================

test('缺证据 / 证据非本回合原文 / 未知角色 id / 新名字未登场 → 拒绝', () => {
  const state = freshState({ npcs: [{ name: '甲' }] });
  const narration = '甲在院中扫地，风卷起落叶。';
  const cases = [
    [{ name: '甲' }, '无 evidence'],
    [{ name: '甲', evidence: '不存在的原文' }, 'evidence 不在叙事中'],
    [{ name: '甲', evidence: '甲在院中', id: 'npc_不存在' }, '未知 id'],
    [{ name: '凭空新人', evidence: '甲在院中' }, '新人物名字未出现'],
    [{ name: '甲', evidence: '甲在院中', kind: 'prediction' }, '非法 kind'],
    [{ name: '甲', evidence: '甲在院中', when: '一年后' }, '未知字段/未来预测'],
  ];
  for (const [u, label] of cases) {
    const r = applyUpdates(state, [u], { narration });
    assert.ok(r.rejected.length >= 1, `${label} 应被拒绝`);
    assert.equal(r.changes.length, 0, `${label} 不产生变化`);
  }
});

test('id/name/alias 冲突拒绝，不串人、不静默合并两个既有人物', () => {
  const state = freshState({ npcs: [{ name: '甲' }, { name: '乙' }] });
  const idA = Object.values(state.npcProfiles).find((p) => p.name === '甲').id;
  const idB = Object.values(state.npcProfiles).find((p) => p.name === '乙').id;
  const narration = '甲与乙在集市照面，甲是卖柴人，乙是卖鱼人，彼此点了点头。'; // 公开值摘自原文
  // id 指向甲但 name 写乙 → 拒绝
  let r = applyUpdates(state, [{ id: idA, name: '乙', evidence: '甲与乙' }], { narration });
  assert.ok(r.rejected.length >= 1, 'id/name 指向不同角色被拒');
  // 给甲挂一个属于乙的 alias → 拒绝
  r = applyUpdates(state, [{ id: idA, name: '甲', evidence: '甲与乙', aliases: ['乙'] }], { narration });
  assert.ok(r.rejected.length >= 1, 'alias 与他人名字冲突被拒');
  assert.equal(r.state.npcProfiles[idA].aliases.length, 0);
  // 两个不同 NPC 分别登记，仍是两份独立档案
  r = applyUpdates(state, [
    { name: '甲', evidence: '甲与乙', known: { role: '卖柴人' } },
    { name: '乙', evidence: '甲与乙', known: { role: '卖鱼人' } },
  ], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  assert.notEqual(idA, idB);
  assert.equal(r.state.npcProfiles[idA].role, '卖柴人');
  assert.equal(r.state.npcProfiles[idB].role, '卖鱼人');
});

test('恶意 id / npcId（__proto__ 等）被拒，不造成原型污染或串档', () => {
  const state = freshState({ npcs: [{ name: '甲' }] });
  const narration = '甲走过长街，风声渐起。';
  const r = applyUpdates(state, [{ id: '__proto__', name: '甲', evidence: '甲走过' }], { narration });
  assert.ok(r.rejected.length >= 1, '危险 id 被拒，不把 Object.prototype 当 profile');
  assert.equal(r.changes.length, 0);
  assert.equal(e.getNpcHistory(state, [], '__proto__', {}), null);
  assert.equal(e.getNpcHistory(state, [], 'constructor', {}), null);
  assert.equal({}.polluted, undefined, '原型未被污染');
});

test('特征标签：非中性且未在原文出现被拒，避免用标签泄露秘密；中性/原文标签接受', () => {
  const state = freshState({ npcs: [{ name: '甲' }] });
  const narration = '甲穿着一袭素袍走进屋，神色如常。'; // '一袭'/'素袍' 公开值摘自原文
  // '暗中寻找妹妹' 既非中性、也不在原文里 → 拒绝
  let r = applyUpdates(state, [{ name: '甲', evidence: '甲穿着', known: { traits: { identity: { '暗中寻找妹妹': 'x' } } } }], { narration });
  assert.ok(r.rejected.length >= 1, '秘密型标签被拒');
  // 中性标签接受
  r = applyUpdates(state, [{ name: '甲', evidence: '甲穿着', known: { traits: { appearance: { 衣着: '素袍' } } } }], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  // 出现在原文里的标签也接受
  r = applyUpdates(state, [{ name: '甲', evidence: '甲穿着', known: { traits: { appearance: { 素袍: '一袭' } } } }], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  // 未知分类拒绝
  r = applyUpdates(state, [{ name: '甲', evidence: '甲穿着', known: { traits: { secrets: { 甲: 'x' } } } }], { narration });
  assert.ok(r.rejected.length >= 1, '未知分类被拒');
});

// =========================================================================
// 4. 公开泄密 sentinel / XSS 字符串当数据
// =========================================================================

test('公开投影不泄露 internal/original.want/apex；XSS 字符串作为纯数据原样保留', () => {
  const xss = '<img src=x onerror=alert(1)>';
  const state = freshState({ npcs: [{ name: '玛拉', desc: '卫队长的完整背景', want: 'SENTINEL_PRIVATE_WANT', voice: '冷语' }] });
  const id = onlyId(state);
  const narration = `玛拉身披${xss}的斗篷走了进来，是卫队长，目光冷峻。`; // 公开值摘自原文
  const r = applyUpdates(state, [{
    name: '玛拉', kind: 'interaction', evidence: '玛拉身披',
    known: { role: '卫队长', traits: { appearance: { 衣着: `${xss}的斗篷` } } },
    internal: { motivation: 'SENTINEL_INTERNAL' },
  }], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));

  const pub = e.publicNpcProfiles(r.state)[id];
  // XSS 只是玩家看到的原文数据：原样、完整地作为字符串存在，不被执行/改写/截断。
  assert.equal(pub.traits.appearance['衣着'], `${xss}的斗篷`);
  assert.equal(pub.role, '卫队长');
  // 私有字段绝不出现在公开 profile 里
  for (const k of ['original', 'internal', 'want', 'apex', 'established']) {
    assert.equal(Object.prototype.hasOwnProperty.call(pub, k), false, `公开 profile 不含 ${k}`);
  }
  const pubStr = JSON.stringify(pub);
  assert.equal(pubStr.includes('SENTINEL_PRIVATE_WANT'), false, '不泄露 original.want');
  assert.equal(pubStr.includes('SENTINEL_INTERNAL'), false, '不泄露 internal');

  // 公开 state / 公开 bible.npcs 也不泄露
  const pubStateStr = JSON.stringify(e.toPublicState(r.state));
  assert.equal(pubStateStr.includes('SENTINEL_PRIVATE_WANT'), false);
  assert.equal(pubStateStr.includes('SENTINEL_INTERNAL'), false);
  const biblePub = e.toPublicState(r.state).bible.npcs[0];
  assert.equal(Object.prototype.hasOwnProperty.call(biblePub, 'want'), false, 'bible.npcs 过滤 want');
  assert.equal(biblePub.desc, '卫队长的完整背景', '身份/形象字段保留');
  // 私有存档原始全文未被改写
  assert.equal(r.state.npcProfiles[id].original.want, 'SENTINEL_PRIVATE_WANT');
  assert.equal(r.state.bible.npcs[0].want, 'SENTINEL_PRIVATE_WANT');

  // history 的 changes 只含公开变化，不含 internal
  const events = [eventRecord(1, { narration, memory: r.changes })];
  const hist = e.getNpcHistory(r.state, events, id, {});
  const histStr = JSON.stringify(hist);
  assert.equal(histStr.includes('SENTINEL_INTERNAL'), false, 'history 不过滤则泄密，必须过滤');
  assert.equal(histStr.includes('SENTINEL_PRIVATE_WANT'), false);
  assert.ok(hist.history.entries[0].narration.includes(xss), '完整原文（含 XSS 当数据）可认人');
  assert.ok(hist.history.entries[0].changes.every((c) => c.field !== 'internal.motivation'), 'changes 不含 internal');
});

test('公开档案只来自叙事证据：绝不把 bible.desc/want/role 塞成玩家已知，缺项保留未知', () => {
  const state = freshState({ npcs: [{ name: '影', role: '密探（私密设定）', desc: '影的完整私密背景'.repeat(50), want: 'SENTINEL_WANT' }] });
  const id = onlyId(state);
  const narration = '影从廊柱后走出，只说了一句「别跟着我」，便又隐入暗处。';
  // 仅登记互动、不提供 known：公开身份/描述/音色必须保持未知，不拿 bible 设定填充。
  const r = applyUpdates(state, [{ name: '影', kind: 'interaction', evidence: '影从廊柱后走出' }], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const pub = e.publicNpcProfiles(r.state)[id];
  assert.equal(pub.role, '', '不把 bible.role 当已知');
  assert.equal(pub.description, '', '不把 bible.desc 当已知');
  assert.equal(pub.voice, '', '缺项保留未知');
  assert.equal(Object.keys(pub.traits.identity).length, 0);
  assert.equal(pub.initial.role, '', '最初出场也不编造');
  assert.equal(pub.latestExcerpt, '影从廊柱后走出', '原文线索可认人');
  const str = JSON.stringify(pub);
  assert.equal(str.includes('SENTINEL_WANT'), false);
  assert.equal(str.includes('私密背景'), false, 'bible 私密背景不进公开档案');

  // 只有带本回合原文证据的 known 才写入公开值（摘自原文短语）。
  const r2 = applyUpdates(r.state, [{ id, name: '影', kind: 'change', evidence: '别跟着我',
    known: { voice: '只说了一句「别跟着我」' } }], { narration });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  assert.equal(e.publicNpcProfiles(r2.state)[id].voice, '只说了一句「别跟着我」', '已知值来自本回合原文');
});

test('toPublicTurnResult：applied 白名单过滤，npc_memory / npc_updates / 私有字段不进公开响应', () => {
  let state = freshState({ npcs: [{ name: '甲', want: 'SENTINEL_WANT' }] });
  state.nextEventTurn = 999;
  const narration = '甲沿着古道缓缓走来，手里提着一盏旧灯，是个提灯人，停下脚步望向远方。'; // 公开值摘自原文
  const out = run(state, {
    action: '会面',
    proposal: proposal({
      narration,
      npc_updates: [{ name: '甲', kind: 'interaction', evidence: '甲沿着古道',
        known: { role: '提灯人' }, internal: { motivation: 'SENTINEL_INTERNAL' } }],
    }),
  });
  assert.equal(out.invalid, false);
  assert.equal(out.result.npc_memory.length, 1, '变化落在私有 result.npc_memory');
  // 人为误把私有字段塞进 applied，公开投影仍应过滤
  out.result.applied.npc_memory = out.result.npc_memory;
  out.result.applied.npc_updates = [{ secret: 'SENTINEL_INTERNAL' }];
  out.result.applied.original = { want: 'SENTINEL_WANT' };
  const pub = e.toPublicTurnResult(out.result, out.state);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'npc_memory'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub.applied, 'npc_memory'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub.applied, 'npc_updates'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub.applied, 'original'), false);
  const str = JSON.stringify(pub);
  assert.equal(str.includes('SENTINEL_INTERNAL'), false, '不泄露 internal');
  assert.equal(str.includes('SENTINEL_WANT'), false, '不泄露 want');
  assert.equal(str.includes('"apex"'), false);
});

// =========================================================================
// 5. 共享可见日志过滤 / 旧档 hydrate 回填
// =========================================================================

test('event-log：visibleEventEntries 保留原始 eventIndex，撤回分支被排除', () => {
  const events = [
    { turn: 1, narration: 'a' },
    { turn: 2, narration: 'b' },
    { turn: 3, narration: 'c-old' },
    { type: 'undo', undoneTurn: 3 },
    { turn: 3, narration: 'c-new' },
  ];
  const entries = visibleEventEntries(events);
  assert.deepEqual(entries.map((x) => x.eventIndex), [0, 1, 4], '撤回标记与其前一条隐藏，重走同 turn 仍可见');
  assert.deepEqual(visibleEventRecords(events).map((r) => r.narration), ['a', 'b', 'c-new']);
  // 与 game.visibleEventRecords 行为一致
  const game = require('../src/game.js');
  assert.deepEqual(visibleEventRecords(events), game.visibleEventRecords(events));
});

test('hydrateNpcMemory：旧档（仅叙事/好感）按 canonical 可见记录回填，态度 0 不代表认识', () => {
  const old = {
    id: 'old', turn: 4, life: 1, character: { name: '旧旅人' }, clock: { day: 2, period: '午后' },
    bible: { npcs: [{ name: '甲', desc: '甲的完整设定', want: 'SENTINEL_WANT' }, { name: '乙' }] },
    npcAttitude: { 甲: 0, 乙: 0, 丙: 0 },
  };
  const norm = e.normalizeState(old);
  assert.equal(e.needsNpcHydration(norm), true);
  const events = [
    eventRecord(1, { narration: '甲在城门当值，向旧旅人点头致意。', attitude: { 甲: 2 } }),
    eventRecord(2, { narration: '风掠过空荡的长街，无人经过。', attitude: { 乙: 0 } }),
    eventRecord(3, { narration: '丙只是坊间传闻里的名字。', attitude: { 丙: 0 } }),
  ];
  const r = e.hydrateNpcMemory(norm, events);
  assert.equal(r.npcMemoryVersion, e.NPC_MEMORY_VERSION, '回填后标记迁移完成');
  assert.equal(e.needsNpcHydration(r), false);
  const pub = e.publicNpcProfiles(r);
  const byName = Object.fromEntries(Object.values(r.npcProfiles).map((p) => [p.name, p]));
  assert.equal(byName['甲'].established, true, '甲：叙事+好感 → 认识且当面见过');
  assert.ok(byName['甲'].lastInteraction, '甲有 lastInteraction');
  assert.equal(byName['乙'].established, false, '乙：态度 0 + 无叙事 → 不认识（旧态度 0 本身不代表认识）');
  assert.equal(byName['丙'].established, true, '丙：叙事里「提及」名字 → 可知其名');
  assert.equal(byName['丙'].lastInteraction, null, '「提及」不等于「当面见过」');
  assert.equal(pub[byName['甲'].id].initial.role, '', '旧档无结构特征，不编造已知身份');
  assert.equal(r.npcProfiles[byName['甲'].id].original.desc, '甲的完整设定', '原始完整资料保留');
  assert.equal(r.npcProfiles[byName['甲'].id].original.want, 'SENTINEL_WANT');
  const hist = e.getNpcHistory(r, events, byName['甲'].id, {});
  assert.ok(hist, '认识的人物有历史');
  assert.ok(hist.history.total >= 1);
  assert.equal(e.getNpcHistory(r, events, byName['乙'].id, {}), null, '未公开人物返回 null');
  assert.equal(e.getNpcHistory(r, events, 'npc_不存在', {}), null, '不存在人物返回 null');
  // hydrate 幂等
  const r2 = e.hydrateNpcMemory(r, events);
  assert.deepEqual(e.publicNpcProfiles(r2), e.publicNpcProfiles(r));
});

test('hydrateNpcMemory：新格式 npc_memory 回放重建当前档案，重生不丢、旧变化保留', () => {
  const state = freshState({ npcs: [{ name: '长老', desc: '原始背景', want: 'SENTINEL_WANT' }] });
  const id = onlyId(state);
  const changes1 = [memChange(id, '长老', { turn: 1, life: 1, heroName: '一世旅人', evidence: '长老现身',
    fields: [{ scope: 'public', kind: 'scalar', key: 'role', from: '', to: '导师' }] })];
  const changes2 = [memChange(id, '长老', { turn: 5, life: 2, heroName: '二世旅人', evidence: '长老重逢',
    fields: [{ scope: 'public', kind: 'trait', key: 'circumstances', label: '近况', from: '', to: '隐居北山' }] })];
  const events = [
    eventRecord(1, { life: 1, narration: '长老现身村口。', memory: changes1 }),
    eventRecord(5, { life: 2, narration: '长老重逢于北山。', memory: changes2 }),
  ];
  // 模拟旧存档：没有 npcProfiles、版本 0，但事件里有完整 npc_memory
  const old = e.normalizeState({ id: 'w1', turn: 5, life: 2, character: { name: '二世旅人' },
    bible: { npcs: [{ name: '长老', desc: '原始背景', want: 'SENTINEL_WANT' }] }, npcAttitude: {} });
  const r = e.hydrateNpcMemory(old, events);
  const p = r.npcProfiles[id];
  assert.equal(p.role, '导师', '旧变化保留');
  assert.equal(p.traits.circumstances['近况'], '隐居北山', '跨世变化保留');
  assert.equal(p.original.desc, '原始背景', '重生不丢原始背景/形象');
  assert.equal(p.original.want, 'SENTINEL_WANT');
  assert.equal(p.firstRecord.life, 1);
  assert.equal(p.lastRecord.life, 2);
  assert.equal(p.lastRecord.heroName, '二世旅人');
});

// =========================================================================
// 6. 完整历史分页 / 撤回重走 / 不同世数
// =========================================================================

function buildLongHistory(state, id, count) {
  const events = [];
  for (let i = 1; i <= count; i++) {
    const marker = `HIST-MARKER-${i}`;
    const narration = `第${i}回合，长老与旅人同行，${marker}，留下完整原文。`;
    const chg = memChange(id, '长老', {
      turn: i, life: i <= 60 ? 1 : 2, heroName: i <= 60 ? '一世旅人' : '二世旅人',
      day: i, evidence: `第${i}回合`,
      fields: [{ scope: 'public', kind: 'scalar', key: 'description', from: '', to: `第${i}次记录` }],
    });
    events.push(eventRecord(i, { life: i <= 60 ? 1 : 2, narration, memory: [chg] }));
  }
  return events;
}

test('getNpcHistory：100+ 条完整历史分页可读全，原文完整，cursor 用原始 eventIndex 且非负', () => {
  const state = freshState({ npcs: [{ name: '长老' }] });
  const id = onlyId(state);
  const events = buildLongHistory(state, id, 120);
  const N = 120;
  let before = undefined;
  const seen = new Set();
  let pages = 0;
  let guard = 0;
  while (guard++ < 20) {
    const h = e.getNpcHistory(state, events, id, before === undefined ? {} : { before, limit: 20 });
    pages += 1;
    assert.equal(h.history.total, N + 1, 'total 为全部匹配记录（含 eventIndex=-1 开场）');
    for (const ent of h.history.entries) {
      assert.equal(typeof ent.narration, 'string');
      if (ent.eventIndex >= 0) {
        assert.ok(ent.narration.includes('HIST-MARKER-'), '完整原文含唯一标记');
        assert.ok(ent.narration.includes('留下完整原文'), 'narration 未被截断');
      }
      assert.ok(!seen.has(ent.eventIndex), '无重复');
      seen.add(ent.eventIndex);
    }
    if (!h.history.hasMore) {
      assert.equal(h.history.nextCursor, null, '末页 cursor 为 null');
      break;
    }
    assert.ok(h.history.nextCursor === null || h.history.nextCursor >= 0, 'cursor 恒为非负原始 index');
    // nextCursor 允许 0：翻页到 eventIndex=-1 的最后开场，不因拒绝 0 漏掉开场。
    assert.ok(h.history.nextCursor >= 0, '还有更多时 cursor 非负（可为 0）');
    before = h.history.nextCursor;
  }
  assert.equal(seen.size, N + 1, '分页读回全部 120 条事件 + 1 条开场');
  assert.ok(seen.has(-1), 'eventIndex=-1 的公开开场可回查');
  assert.ok(pages >= 6, '120/20 至少 6 页');
  // newest first
  const first = e.getNpcHistory(state, events, id, { limit: 5 }).history.entries;
  assert.ok(first[0].eventIndex > first[first.length - 1].eventIndex, 'newest first');
  assert.ok(first[0].narration.includes('HIST-MARKER-120'), '首条为最新');
  // limit 上限 50
  assert.equal(e.getNpcHistory(state, events, id, { limit: 999 }).history.entries.length, 50);
});

test('getNpcHistory：撤回旧分支排除、重走同 turn 用原始 index，不复活撤回原文', () => {
  const state = freshState({ npcs: [{ name: '长老' }] });
  const id = onlyId(state);
  const mk = (turn, tag, life) => eventRecord(turn, {
    life: life || 1,
    narration: `第${turn}回合：${tag}的原文，长老在场。`,
    memory: [memChange(id, '长老', { turn, life: life || 1, heroName: '旅人', evidence: `第${turn}回合`, fields: [] })],
  });
  const events = [
    mk(1, 'A'),
    mk(2, 'B'),
    mk(3, 'OLD-BRANCH'),       // index 2：将被撤回
    { type: 'undo', undoneTurn: 3 }, // index 3：标记
    mk(3, 'NEW-BRANCH'),       // index 4：重走同 turn，可见
    mk(4, 'D'),
  ];
  const h = e.getNpcHistory(state, events, id, {});
  const indices = h.history.entries.filter((x) => x.eventIndex >= 0).map((x) => x.eventIndex);
  assert.deepEqual(indices.slice().sort((a, b) => a - b), [0, 1, 4, 5], '撤回分支 index2 排除，重走 index4 用原始 index');
  const all = JSON.stringify(h.history.entries);
  assert.equal(all.includes('OLD-BRANCH'), false, '撤回原文不复活');
  assert.equal(all.includes('NEW-BRANCH'), true, '重走同 turn 的新版本可见');
  // 用 before 原始 index 翻页，撤回标记不干扰
  const page = e.getNpcHistory(state, events, id, { before: 4, limit: 2 }).history.entries;
  assert.deepEqual(page.map((x) => x.eventIndex).sort((a, b) => a - b), [0, 1], 'before=4 取 index<4 的可见记录');
});

test('getNpcHistory：不同主角世数 / 姓名按各自事件 at 记录，死亡回合不落入下一世', () => {
  const state = freshState({ npcs: [{ name: '长老' }] });
  const id = onlyId(state);
  const events = [
    eventRecord(1, { life: 1, narration: '长老初见一世旅人。',
      memory: [memChange(id, '长老', { turn: 1, life: 1, heroName: '一世旅人', evidence: '长老初见', fields: [] })] }),
    eventRecord(9, { life: 2, narration: '长老再见二世旅人。',
      memory: [memChange(id, '长老', { turn: 9, life: 2, heroName: '二世旅人', evidence: '长老再见', fields: [] })] }),
    eventRecord(17, { life: 3, narration: '长老送别三世旅人。',
      memory: [memChange(id, '长老', { turn: 17, life: 3, heroName: '三世旅人', evidence: '长老送别', fields: [] })] }),
  ];
  const h = e.getNpcHistory(state, events, id, {});
  const byLife = Object.fromEntries(h.history.entries.filter((x) => x.eventIndex >= 0).map((x) => [x.at.life, x]));
  assert.equal(byLife[1].at.heroName, '一世旅人');
  assert.equal(byLife[2].at.heroName, '二世旅人');
  assert.equal(byLife[3].at.heroName, '三世旅人');
  assert.equal(h.profile.firstRecord.life, 1);
  assert.equal(h.profile.lastRecord.life, 3);
});

// =========================================================================
// 7. 引擎接线：resolveTurn 私有 npc_memory / 死亡回合 beforeState 时间
// =========================================================================

test('resolveTurn：npc_updates 在有效叙事/数值结算后才应用，变化私有 result.npc_memory', () => {
  let state = freshState({ npcs: [{ name: '长老', want: 'SENTINEL_WANT' }] });
  state.nextEventTurn = 999;
  const narration = '长老在晨雾中递来一封旧信，是个送信人，转身没入人群，钟声正从远处传来。'; // 公开值摘自原文
  const out = run(state, {
    action: '接信',
    proposal: proposal({ narration,
      npc_updates: [{ name: '长老', kind: 'interaction', evidence: '长老在晨雾中', known: { role: '送信人' } }] }),
  });
  assert.equal(out.invalid, false);
  assert.equal(out.state.turn, 1);
  assert.equal(out.result.npc_memory.length, 1);
  const chg = out.result.npc_memory[0];
  assert.equal(chg.at.life, 1);
  assert.equal(chg.at.heroName, '旅人');
  assert.equal(chg.at.turn, 1);
  // applied 不含 npc 私有字段；公开响应不含 npc_memory
  assert.equal(Object.prototype.hasOwnProperty.call(out.result.applied, 'npc_updates'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out.result.applied, 'npc_memory'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(e.toPublicTurnResult(out.result, out.state), 'npc_memory'), false);
  // 公开 state 仍过滤 bible.npcs want
  assert.equal(JSON.stringify(e.toPublicState(out.state)).includes('SENTINEL_WANT'), false);
});

test('resolveTurn：死亡当回合 NPC 记忆记在原主角 life/name，不落入下一世', () => {
  let state = freshState({ npcs: [{ name: '长老' }] });
  state.turn = 4;
  state.nextEventTurn = 999;
  state.character.attrs['体魄'] = 2;
  const narration = '长老扶住倒下的旅人，是守夜人，风雪漫过山道，远处传来最后的钟声。'; // 公开值摘自原文
  const out = run(state, {
    action: '硬闯',
    proposal: proposal({ narration, state_diff: { 体魄: -2 },
      npc_updates: [{ name: '长老', kind: 'interaction', evidence: '长老扶住', known: { role: '守夜人' } }] }),
  });
  assert.equal(out.invalid, false);
  assert.ok(out.result.death, '本回合触发死亡');
  assert.equal(out.result.life, 2, 'result.life 是死亡后的下一世');
  const chg = out.result.npc_memory[0];
  assert.equal(chg.at.life, 1, 'NPC 记忆用 beforeState.life=1，未落入下一世');
  assert.equal(chg.at.heroName, '旅人', 'NPC 记忆用 beforeState 的主角名，未变成空');
});

test('resolveTurn：无 npc_updates 的普通回合不报错、不强加人物', () => {
  const state = freshState({ npcs: [{ name: '长老' }] });
  state.nextEventTurn = 999;
  const out = run(state, { action: '前行', proposal: proposal() });
  assert.equal(out.invalid, false);
  assert.deepEqual(out.result.npc_memory, []);
  assert.deepEqual(e.publicNpcProfiles(out.state), {}, '无证据不提前列出未登场演员');
});

// =========================================================================
// 8. npcPromptContext：有界、仅相关少量人物、不带全史
// =========================================================================

test('npcPromptContext：默认 ≤4 人、有界、含原始身份/动机（内部提示词），不带全史', () => {
  const state = freshState({ npcs: [] });
  // 建立 6 个 NPC，各自带完整 120 条历史（验证提示词不会把全史塞进去）
  const names = ['甲', '乙', '丙', '丁', '戊', '己'];
  let s = state;
  const events = [];
  for (let n = 0; n < names.length; n++) {
    const name = names[n];
    const narration = `${name}在集市中央现身，身份${n}，与旅人攀谈数句。`; // 公开值摘自原文
    const r = applyUpdates(s, [{ name, kind: 'interaction', evidence: `${name}在集市`, known: { role: `身份${n}` } }], { narration });
    const id = r.changes[0].id;
    for (let i = 1; i <= 20; i++) {
      events.push(eventRecord(n * 20 + i, {
        narration: `${name}的第${i}段共同经历 FULL-HIST-${name}-${i} 的完整原文。`,
        memory: [memChange(id, name, { turn: n * 20 + i, heroName: '旅人', evidence: `${name}的第`, fields: [] })],
      }));
    }
    s = r.state;
  }
  // 用 hydrate 把 120 条历史固化到 state（模拟 loadState 回填）
  const hydrated = e.hydrateNpcMemory(s, events);
  const ctx = e.npcPromptContext(hydrated, '与甲交谈', {});
  assert.ok(ctx.length > 0);
  assert.ok(ctx.length <= 1600, '整体有界');
  assert.ok((ctx.match(/NPC「/g) || []).length <= 4, '默认最多 4 人');
  assert.ok(ctx.includes('甲'), '行动相关人物优先注入');
  // 有界提示词不带全史：不含任何完整历史原文标记
  assert.equal(ctx.includes('FULL-HIST'), false, '不携带全史');
  assert.equal(ctx.includes('共同经历'), false);
  // 内部提示词可包含原始动机（私有，仅 AI 用）
  // 公开响应绝不含它
  const pubStr = JSON.stringify(e.toPublicState(hydrated));
  assert.equal(pubStr.includes('FULL-HIST'), false);
  // maxNpcs 可调
  assert.ok((e.npcPromptContext(hydrated, '', { maxNpcs: 2 }).match(/NPC「/g) || []).length <= 2);
});

// =========================================================================
// 9. 门面导出签名
// =========================================================================

test('engine 门面：npc / event-log 函数均为可调用导出', () => {
  for (const fn of [
    'initializeNpcMemory', 'normalizeNpcMemory', 'needsNpcHydration', 'hydrateNpcMemory',
    'applyNpcMemory', 'publicNpcProfiles', 'publicBibleNpcs', 'getNpcHistory',
    'npcPromptContext', 'stableId', 'visibleEventRecords', 'visibleEventEntries',
  ]) {
    assert.equal(typeof e[fn], 'function', `engine.${fn} 应为函数`);
  }
  // 纯函数不改入参
  const state = freshState({ npcs: [{ name: '甲' }] });
  const snap = JSON.stringify(state);
  e.normalizeNpcMemory(state);
  e.hydrateNpcMemory(state, []);
  e.publicNpcProfiles(state);
  e.publicBibleNpcs(state);
  assert.equal(JSON.stringify(state), snap, '各函数不修改入参');
});

// =========================================================================
// 10. 返工回归①：公开值 / 人物相关性（主脑最小夹具）
// =========================================================================

test('返工回归①：无 npc_updates 但正文提及已有角色，仍建立公开出场记录且不强造特征', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }] });
  const narration = '甲先生站在门口，向旅人点了点头。';
  const r = applyUpdates(state, [], { narration }); // 缺 npc_updates
  const pub = e.publicNpcProfiles(r.state);
  assert.equal(Object.keys(pub).length, 1, '正文提到已有角色即建立公开出场（修 publicNpcProfiles=0）');
  const id = Object.keys(pub)[0];
  assert.equal(pub[id].name, '甲先生');
  assert.ok(pub[id].lastRecord && typeof pub[id].lastRecord === 'object', '保留 lastRecord');
  assert.equal(pub[id].role, '', '不强造身份');
  assert.equal(pub[id].description, '', '不强造描述');
  assert.equal(pub[id].voice, '', '不强造音色');
  assert.equal(Object.keys(pub[id].traits.identity).length, 0, '不强造特征');
  assert.ok(pub[id].latestExcerpt.includes('甲先生'), '出场线索来自原文');
  assert.equal(r.changes.length, 0, '缺省 metadata 不伪造字段变化');
});

test('返工回归①：正文无关句子 + 私密/猜测 known 值被拒，未公开 NPC 不建公开档案', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }] });
  // 主脑夹具：正文只有「风吹过门口。」却给未公开甲先生写 known.description=私密标记
  const narration = '风吹过门口。';
  const r = applyUpdates(state, [
    { name: '甲先生', evidence: '风吹过门口', known: { description: '私密标记' } },
  ], { narration });
  assert.ok(r.rejected.length >= 1, '整条更新被拒');
  assert.equal(r.changes.length, 0, '不产生任何变化');
  assert.deepEqual(e.publicNpcProfiles(r.state), {}, 'NPC 未在正文出现 → 不建立公开档案');
  assert.equal(JSON.stringify(e.publicNpcProfiles(r.state)).includes('私密标记'), false);
});

test('返工回归①：evidence 合法但公开新值未在原文出现 → 拒绝；internal 私有不要求摘自原文且不进公开投影', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }] });
  const narration = '甲先生站在门口，向旅人点了点头。';
  const r = applyUpdates(state, [
    { name: '甲先生', evidence: '甲先生站在门口', known: { description: '暗中寻找妹妹的密探' } },
  ], { narration });
  assert.ok(r.rejected.some((x) => x.includes('未在本回合叙事原文出现')), '公开值必须摘自原文');
  assert.equal(r.changes.length, 0);
  const pub = e.publicNpcProfiles(r.state);
  // 更新被拒，但正文提到了 NPC → 仍登记一个不含私密值的 mention 出场
  const id = Object.keys(pub)[0];
  assert.equal(pub[id].description, '', '私密/猜测值不进公开档案');
  assert.equal(JSON.stringify(pub).includes('暗中寻找妹妹'), false);
  // internal 是私有资料，不受「摘自原文」限制，但绝不进公开投影
  const r2 = applyUpdates(state, [
    { name: '甲先生', evidence: '甲先生站在门口', internal: { motivation: '暗中寻找妹妹' } },
  ], { narration });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected), 'internal 私有资料不要求摘自原文');
  const pub2 = e.publicNpcProfiles(r2.state);
  assert.equal(JSON.stringify(pub2).includes('暗中寻找妹妹'), false, 'internal 不进公开投影');
  assert.equal(Object.prototype.hasOwnProperty.call(pub2[Object.keys(pub2)[0]], 'internal'), false);
});

test('返工回归①：未公开 NPC 不能凭已知 id + 合法 evidence 建立公开档案（必须本回合真实提及）', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }] });
  const id = onlyId(state);
  const narration = '风吹过门口，檐角挂着一串旧铃。'; // 甲先生完全没出现，但 '旧铃' 可引用
  const r = applyUpdates(state, [
    { id, name: '甲先生', evidence: '风吹过门口', known: { role: '旧铃' } },
  ], { narration });
  assert.ok(r.rejected.some((x) => x.includes('真实提及')), '因未在正文真实提及被拒');
  assert.equal(r.changes.length, 0);
  assert.equal(e.publicNpcProfiles(r.state)[id], undefined, '不凭 id 建立公开档案');
});

test('返工回归①：已公开角色可用上回合焦点承接代词，无关远方 NPC 不被批量更改', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }, { name: '乙员外' }] });
  const idA = Object.values(state.npcProfiles).find((p) => p.name === '甲先生').id;
  const idB = Object.values(state.npcProfiles).find((p) => p.name === '乙员外').id;
  // turn 1：两人同场公开
  const r1 = applyUpdates(state, [
    { name: '甲先生', evidence: '甲先生与乙员外' },
    { name: '乙员外', evidence: '甲先生与乙员外' },
  ], { turn: 1, narration: '甲先生与乙员外在村口寒暄几句。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  // turn 10：只有甲先生出场，刷新其 lastRecord；乙员外仍停在旧记录
  const r2 = applyUpdates(r1.state, [
    { name: '甲先生', evidence: '甲先生独自' },
  ], { turn: 10, narration: '甲先生独自坐在阶前。' });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  assert.equal(r2.state.npcProfiles[idA].lastRecord.turn, 10);
  assert.equal(r2.state.npcProfiles[idB].lastRecord.turn, 1, '乙员外仍是遥远旧记录');
  // turn 11：正文只有承接代词、无名字；给两人各写一条（值 '坐在阶前' 可引用，单独考察相关性）
  const r3 = applyUpdates(r2.state, [
    { id: idA, name: '甲先生', evidence: '他轻轻点头' },
    { id: idB, name: '乙员外', evidence: '他轻轻点头', known: { description: '坐在阶前' } },
  ], { turn: 11, narration: '他轻轻点头，把门掩上，坐在阶前。' });
  assert.equal(r3.rejected.length, 1, '只有无关远方 NPC 被拒');
  assert.ok(r3.rejected[0].includes('npc_updates[1]'), '被拒的是乙员外那条');
  assert.ok(r3.rejected[0].includes('真实提及'), '因未在正文真实提及被拒');
  assert.equal(r3.changes.length, 1, '甲先生的承接代词更新被接受');
});

// =========================================================================
// 11. 返工回归②：真实出场不依赖 metadata 齐全 / 好感变化不伪装相识
// =========================================================================

test('返工回归②：npc_updates 被拒时正文提及仍保留出场与 lastRecord，不写私密值', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }] });
  const id = onlyId(state);
  const narration1 = '甲先生第一次站在门口。';
  const r1 = applyUpdates(state, [{ name: '甲先生', evidence: '甲先生第一次' }], { turn: 1, narration: narration1 });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  const firstTurn = r1.state.npcProfiles[id].lastRecord.turn;
  // 本回合补丁被拒（公开值非原文），但正文确实提到甲先生
  const narration2 = '甲先生第二次站在门口，手里多了一盏灯。';
  const r2 = applyUpdates(r1.state, [
    { id, name: '甲先生', evidence: '甲先生第二次', known: { description: '凭空捏造的私密标记' } },
  ], { turn: 2, narration: narration2 });
  assert.ok(r2.rejected.length >= 1, '补丁被拒');
  assert.equal(r2.changes.length, 0, '不产生字段变化');
  const p2 = r2.state.npcProfiles[id];
  assert.ok(p2.lastRecord && p2.lastRecord.turn > firstTurn, '被拒回合仍推进 lastRecord / 出场记录');
  assert.equal(p2.description, '', '不写入被拒的私密/捏造值');
  assert.equal(Object.keys(e.publicNpcProfiles(r2.state)).length, 1, '仍只公开这一个真实出场的人');
});

test('返工回归②：好感/态度变化本身不伪装为当面相识（正文无名不建立出场）', () => {
  const old = {
    id: 'old', turn: 2, life: 1, character: { name: '旅人' }, clock: { day: 1, period: '清晨' },
    bible: { npcs: [{ name: '甲先生' }] }, npcAttitude: { 甲先生: 3 },
  };
  const norm = e.normalizeState(old);
  const events = [eventRecord(1, { narration: '风吹过空荡的长街，无人经过。', attitude: { 甲先生: 3 } })];
  const r = e.hydrateNpcMemory(norm, events);
  const p = Object.values(r.npcProfiles).find((x) => x.name === '甲先生');
  assert.equal(p.established, false, '好感变化但正文没提到名字 → 不建立出场');
  assert.equal(p.lastInteraction, null, '没有 lastInteraction');
  assert.equal(e.publicNpcProfiles(r)[p.id], undefined, '不进公开档案');
  assert.equal(e.getNpcHistory(r, events, p.id, {}), null, '未公开人物无历史');
});

test('返工回归②：合法 name/evidence 的新 NPC 登记并补中立 npcAttitude（不重置既有数值）', () => {
  const state = freshState({ npcs: [] });
  const narration = '铁匠铺里火星四溅，旅人停下看了一眼。';
  const r = applyUpdates(state, [{ name: '铁匠', kind: 'mention', evidence: '铁匠铺里火星四溅' }], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  assert.equal(r.changes.length, 1);
  assert.equal(r.state.npcAttitude['铁匠'], 0, '补中立键供头像流程识别');
  const id = r.changes[0].id;
  assert.equal(r.state.npcProfiles[id].established, true, '无好感变化仍登记出场');
  assert.ok(r.changes[0].baseline, '携带原始基线');
  // 既有态度数值不被覆盖
  const s2 = clone(r.state);
  s2.npcAttitude['铁匠'] = 7;
  const r2 = applyUpdates(s2, [{ id, name: '铁匠', evidence: '铁匠铺里火星四溅' }], { narration });
  assert.equal(r2.state.npcAttitude['铁匠'], 7, '不重置已有态度数值');
});

// =========================================================================
// 12. 返工回归③：混合记录不能漏人 / 不重复计
// =========================================================================

test('返工回归③：同回合 npc_memory 只有甲时正文中的乙不漏人（乙应有 2 条历史）', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }, { name: '乙先生' }] });
  const idA = Object.values(state.npcProfiles).find((p) => p.name === '甲先生').id;
  const idB = Object.values(state.npcProfiles).find((p) => p.name === '乙先生').id;
  const mk = (turn, place) => eventRecord(turn, {
    narration: `甲先生与乙先生在${place}并肩而立，风从巷口穿过。`,
    memory: [memChange(idA, '甲先生', { turn, heroName: '旅人', evidence: '甲先生与乙先生', fields: [] })],
  });
  const events = [mk(1, '东市'), mk(2, '西桥')];
  // hydrate：乙先生虽不在 npc_memory 里，叙事原文出现 → 仍有出场记录
  const r = e.hydrateNpcMemory(state, events);
  const pB = r.npcProfiles[idB];
  assert.equal(pB.established, true, '正文出现的乙先生被登记');
  assert.ok(pB.lastRecord, '乙先生有 lastRecord');
  // history：乙先生应能回查 2 条真实出场（+1 条开场）
  const h = e.getNpcHistory(state, events, idB, {});
  assert.ok(h, '乙先生有公开历史');
  const real = h.history.entries.filter((x) => x.eventIndex >= 0);
  assert.equal(real.length, 2, '乙先生的两条共同经历都保留，不漏人');
  assert.ok(real.some((x) => x.narration.includes('东市')), '含东市原文');
  assert.ok(real.some((x) => x.narration.includes('西桥')), '含西桥原文');
  assert.equal(h.history.total, 3, '2 条出场 + 1 条 eventIndex=-1 开场');
});

test('返工回归③：typed + 正文同时含乙时，同一 eventIndex 不重复计', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }, { name: '乙先生' }] });
  const idA = Object.values(state.npcProfiles).find((p) => p.name === '甲先生').id;
  const idB = Object.values(state.npcProfiles).find((p) => p.name === '乙先生').id;
  const mem = [
    memChange(idA, '甲先生', { turn: 1, heroName: '旅人', evidence: '甲先生与乙先生', fields: [] }),
    memChange(idB, '乙先生', { turn: 1, heroName: '旅人', evidence: '甲先生与乙先生', fields: [] }),
  ];
  const events = [eventRecord(1, { narration: '甲先生与乙先生在村口并肩而立。', memory: mem })];
  const h = e.getNpcHistory(state, events, idB, {});
  const real = h.history.entries.filter((x) => x.eventIndex >= 0);
  assert.equal(real.length, 1, '乙先生该 eventIndex 恰好 1 条，不因正文回退重复计');
  assert.equal(h.history.total, 2, '1 条出场 + 1 条开场');
  assert.ok(real[0].narration.includes('乙先生'), '完整原文可认人');
});

test('返工回归③：100+ 条混合 typed/legacy/空metadata/undo 分页读全，逐角色不漏人不重复', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }, { name: '乙先生' }] });
  const idA = Object.values(state.npcProfiles).find((p) => p.name === '甲先生').id;
  const idB = Object.values(state.npcProfiles).find((p) => p.name === '乙先生').id;
  const N = 150;
  const mkMem = (id, name, turn) => memChange(id, name, {
    turn, heroName: '旅人', evidence: '甲先生',
    fields: [{ scope: 'public', kind: 'scalar', key: 'description', from: '', to: `第${turn}次记录` }],
  });
  const events = [];
  for (let i = 0; i < N; i++) {
    const turn = i + 1;
    const mode = i % 5;
    const both = mode !== 4; // 仅 mode4 正文只提甲，乙本回合无关
    const narration = `甲先生${both ? '与乙先生' : ''}在第${turn}回合的巷口照面，留下 MIX-MARK-${i} 的完整原文。`;
    let rec;
    if (mode === 0) {
      // 混合：npc_memory 只有甲，但正文也有乙 → 乙必须走原文回退
      rec = eventRecord(turn, { narration, memory: [mkMem(idA, '甲先生', turn)] });
    } else if (mode === 1) {
      // typed：甲乙都在 npc_memory
      rec = eventRecord(turn, { narration, memory: [mkMem(idA, '甲先生', turn), mkMem(idB, '乙先生', turn)] });
    } else if (mode === 2) {
      // 空 metadata
      rec = eventRecord(turn, { narration, memory: [] });
    } else if (mode === 3) {
      // legacy：完全无 npc_memory 字段
      rec = { turn, life: 1, action: '行动', narration, applied: { npc_attitude: {} } };
    } else {
      // typed 只有甲，且正文只提甲（乙本回合无关）
      rec = eventRecord(turn, { narration, memory: [mkMem(idA, '甲先生', turn)] });
    }
    events.push(rec);
  }
  // 注入 undo：撤回第 7/23/57/101 回合，再各重走同 turn 一条（提乙的新叙事）
  const undoneTurns = new Set([7, 23, 57, 101]);
  const withUndo = [];
  for (const rec of events) {
    withUndo.push(rec);
    if (rec.turn && undoneTurns.has(rec.turn)) {
      withUndo.push({ type: 'undo', undoneTurn: rec.turn });
      withUndo.push(eventRecord(rec.turn, {
        narration: `甲先生与乙先生重走第${rec.turn}回合，REWALK-${rec.turn} 的完整原文。`,
        memory: [mkMem(idA, '甲先生', rec.turn)],
      }));
    }
  }
  // 期望：所有 canonical 可见且正文提到乙先生的记录（含重走）
  const expected = new Set();
  for (const { eventIndex, record } of visibleEventEntries(withUndo)) {
    if (record && typeof record.narration === 'string' && record.narration.includes('乙先生')) {
      expected.add(eventIndex);
    }
  }
  assert.ok(expected.size >= 100, `混合样本含 100+ 条乙先生可见出场（实得 ${expected.size}）`);

  // 分页读全乙先生历史
  const seen = new Set();
  const narrationByIdx = new Map();
  let sawDebut = false;
  let before;
  let guard = 0;
  while (guard++ < 40) {
    const h = e.getNpcHistory(state, withUndo, idB, before === undefined ? { limit: 17 } : { before, limit: 17 });
    assert.ok(h, '乙先生有公开历史');
    assert.equal(h.history.total, expected.size + 1, 'total = 全部可见出场 + 1 开场');
    for (const ent of h.history.entries) {
      if (ent.eventIndex === -1) { sawDebut = true; continue; }
      assert.ok(!seen.has(ent.eventIndex), `eventIndex=${ent.eventIndex} 不重复计`);
      seen.add(ent.eventIndex);
      narrationByIdx.set(ent.eventIndex, ent.narration);
      assert.ok(ent.narration.includes('MIX-MARK-') || ent.narration.includes('REWALK-'), '完整原文不截断');
    }
    if (!h.history.hasMore) {
      assert.equal(h.history.nextCursor, null, '末页 cursor 为 null');
      break;
    }
    assert.ok(h.history.nextCursor === null || h.history.nextCursor >= 0, 'cursor 恒为非负（可为 0）');
    assert.ok(h.history.nextCursor >= 0, '还有更多时 cursor 非负');
    before = h.history.nextCursor;
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [...expected].sort((a, b) => a - b),
    '乙先生的每一条可见出场都被回查，既不漏人也不重复（撤回旧分支不复活）');
  assert.ok(sawDebut, 'eventIndex=-1 的公开开场可回查');
  const joined = [...narrationByIdx.values()].join('\n');
  for (const t of [7, 23, 57, 101]) {
    assert.ok(joined.includes(`REWALK-${t}`), `重走第${t}回合可见`);
  }
});

// =========================================================================
// 13. 返工回归④：初始记录 / 旧时间 / 前世
// =========================================================================

test('返工回归④：nextCursor=0 可翻到 eventIndex=-1 开场，不因拒绝 0 漏掉最后开场', () => {
  const state = freshState({ npcs: [{ name: '长老' }] });
  const id = onlyId(state);
  const events = [eventRecord(1, {
    narration: '长老在村口现身。',
    memory: [memChange(id, '长老', { turn: 1, heroName: '旅人', evidence: '长老在村口', fields: [] })],
  })];
  const page = e.getNpcHistory(state, events, id, { before: 0, limit: 20 });
  assert.deepEqual(page.history.entries.map((x) => x.eventIndex), [-1], 'before=0 取到 eventIndex=-1 的公开开场');
  assert.equal(page.history.nextCursor, null);
  assert.equal(page.history.total, 2, '1 条真实出场 + 1 条开场');
});

test('返工回归④：未知历史时间留空/null；死亡旧日志 life 优先 death.life，主角名不串世', () => {
  const state = freshState({ npcs: [{ name: '长老' }] });
  const id = onlyId(state);
  // 旧事件：无任何 at / death / life / hero 信息 → 时间项保持未知，不补第 0 日 / 虚构时段
  const legacy = { turn: 1, action: '行动', narration: '长老站在旧渡口，风吹过芦苇。', applied: { npc_attitude: {} } };
  const r1 = e.hydrateNpcMemory(state, [legacy]);
  const p1 = r1.npcProfiles[id];
  assert.equal(p1.established, true, '正文提及登记出场');
  assert.equal(p1.firstRecord.life, null, '未知 life 留 null');
  assert.equal(p1.firstRecord.heroName, '', '未知主角名留空');
  assert.equal(p1.firstRecord.clock.day, null, '未知 day 留 null，不填第 0 日');
  assert.equal(p1.firstRecord.clock.period, '', '未知时段留空，不虚构');
  const pub1 = e.publicNpcProfiles(r1)[id];
  assert.equal(pub1.firstRecord.life, null, '投影同样保持未知');
  assert.equal(pub1.firstRecord.clock.day, null);
  assert.equal(pub1.firstRecord.clock.period, '');
  assert.equal(pub1.firstRecord.heroName, '');
  assert.equal(JSON.stringify(pub1).includes('"day":0'), false, '不出现第 0 日');

  // 死亡旧日志：death.life 优先，heroName 来自 pastLives，不把本次主角代入上一世
  const withPast = clone(state);
  withPast.life = 3;
  withPast.character = { name: '本世旅人' };
  withPast.pastLives = [{ life: 1, name: '一世旅人' }, { life: 2, name: '二世旅人' }];
  const deathEvent = {
    turn: 9, life: 3, action: '送别',
    narration: '长老在旧战场送别二世旅人。',
    applied: { npc_attitude: {} },
    death: { life: 2, name: '二世旅人' },
  };
  const r2 = e.hydrateNpcMemory(withPast, [deathEvent]);
  const p2 = r2.npcProfiles[id];
  assert.equal(p2.firstRecord.life, 2, '优先 death.life=2，而非事件/当前 life=3');
  assert.equal(p2.firstRecord.heroName, '二世旅人', '从 pastLives 找当时主角姓名');
  assert.notEqual(p2.firstRecord.heroName, '本世旅人', '不把本次主角代入上一世');
});

// =========================================================================
// 14. 返工回归⑤：提示词不丢关键人设 / 优先级 / 来源
// =========================================================================

test('返工回归⑤：长原始描述不吞掉关系/当前动机/音色，提示词含关系记录且存储不裁', () => {
  const longDesc = '守夜人的漫长背景设定'.repeat(150); // >2000 字
  const state = freshState({ npcs: [{ name: '长老', desc: longDesc, want: 'SENTINEL_ORIG_WANT', voice: '低语' }] });
  const id = onlyId(state);
  const narration = '长老与旅人是旧识，递来一封旧信，语气低缓，托付一件要事。';
  const r = applyUpdates(state, [{
    name: '长老', kind: 'interaction', evidence: '长老与旅人',
    known: {
      relationshipSummary: '长老与旅人是旧识',
      publicGoal: '托付一件要事',
      voice: '语气低缓',
    },
  }], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  assert.equal(r.state.npcProfiles[id].original.desc, longDesc, '存储原文不裁剪');
  const ctx = e.npcPromptContext(r.state, '长老', {});
  // 主脑夹具：长原始描述不再整块吞掉尾部关系记录
  assert.ok(ctx.includes('旧识'), '关系记录仍在提示词中');
  assert.ok(ctx.includes('托付一件要事'), '当前动机保留');
  assert.ok(ctx.includes('语气低缓'), '当前音色保留');
  assert.ok(ctx.includes('摘录'), '长原始描述以「摘录」标注');
  assert.ok(ctx.length <= 2000, '整体有界');
  const pub = e.publicNpcProfiles(r.state)[id];
  assert.equal(JSON.stringify(pub).includes('SENTINEL_ORIG_WANT'), false, '公开投影不带出原始 want');
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'original'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'internal'), false);
});

test('返工回归⑤：动态 NPC 的 description/voice/publicGoal 与稳定 id 纳入提示词', () => {
  const state = freshState({ npcs: [] });
  const narration = '货郎挑着担子，是个走街货郎，说话带着浓重的乡音，想把这批货卖个好价钱。';
  const r = applyUpdates(state, [{
    name: '货郎', evidence: '货郎挑着担子',
    known: {
      role: '走街货郎', description: '挑着担子',
      voice: '说话带着浓重的乡音', publicGoal: '想把这批货卖个好价钱',
    },
  }], { narration });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const id = r.changes[0].id;
  const ctx = e.npcPromptContext(r.state, '货郎', {});
  assert.ok(ctx.includes(`[${id}]`), '提示词含稳定 id');
  assert.ok(ctx.includes('挑着担子'), '动态 description 纳入');
  assert.ok(ctx.includes('说话带着浓重的乡音'), '动态 voice 纳入');
  assert.ok(ctx.includes('想把这批货卖个好价钱'), '动态 publicGoal 纳入');
});

test('返工回归⑤：玩家提到的旧人(lastTurn=1) 优先于任意大的最近 turn(lastTurn=10000)', () => {
  let s = freshState({ npcs: [] });
  // 故人：最近记录 turn=1
  const r1 = applyUpdates(s, [{ name: '故人', evidence: '故人现身' }],
    { turn: 1, narration: '故人现身旧巷，与旅人寒暄数句。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  s = r1.state;
  // 其余 4 人：最近记录 turn=10000
  for (const name of ['甲', '乙', '丙', '丁']) {
    const r = applyUpdates(s, [{ name, evidence: `${name}现身` }],
      { turn: 10000, narration: `${name}现身长街，人群熙攘。` });
    assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
    s = r.state;
  }
  // 只给 1 个名额：玩家提到的故人必须挤掉 turn=10000 的其他人
  const ctx1 = e.npcPromptContext(s, '向故人问起往事', { maxNpcs: 1 });
  assert.equal((ctx1.match(/NPC「/g) || []).length, 1, '只注入 1 人');
  assert.ok(ctx1.includes('NPC「故人」'), '玩家提到的旧人被优先注入');
  assert.equal(ctx1.includes('NPC「甲」'), false, 'turn=10000 的其他人被挤出');
  // 默认 4 名额：故人仍排在最前
  const ctx4 = e.npcPromptContext(s, '向故人问起往事', {});
  assert.ok(ctx4.includes('NPC「故人」'), '故人在默认名额内');
  assert.ok(ctx4.indexOf('NPC「故人」') < ctx4.indexOf('NPC「甲」'), '故人排在最近大 turn 人物之前');
});

test('返工回归⑤：关系摘要带来源世数/当时主角/时间，前世交情标注前世，记忆不代表在场', () => {
  const state = freshState({ npcs: [{ name: '长老' }] });
  const id = onlyId(state);
  const chg = memChange(id, '长老', {
    turn: 3, life: 1, heroName: '一世旅人', day: 5, period: '黄昏', evidence: '长老与一世旅人',
    fields: [{ scope: 'public', kind: 'scalar', key: 'relationshipSummary', from: '', to: '长老与一世旅人是旧交' }],
  });
  const events = [eventRecord(3, { life: 1, narration: '长老与一世旅人在旧亭叙旧。', memory: [chg] })];
  const r = e.hydrateNpcMemory(state, events);
  r.life = 2; // 本世是第 2 世
  r.character = { name: '二世旅人' };
  const ctx = e.npcPromptContext(r, '长老', {});
  assert.ok(ctx.includes('旧交'), '关系摘要保留');
  assert.ok(ctx.includes('前世第1世'), '前世交情明确标注前世，不当本世相识');
  assert.ok(ctx.includes('一世旅人'), '带当时主角姓名');
  assert.ok(ctx.includes('第5日') && ctx.includes('黄昏'), '带来源时间');
  assert.ok(ctx.includes('不代表在场'), '明确记忆资料不代表在场');
});

// =========================================================================
// 15. 返工回归⑥：别名更新范围（拒绝动态改名，保留只读数据）
// =========================================================================

test('返工回归⑥：displayName/aliases 更新被拒；已有只读身份数据经 hydrate 保留供搜索', () => {
  const state = freshState({ npcs: [{ name: '甲先生' }] });
  const id = onlyId(state);
  const narration = '甲先生站在门口，向旅人点头。';
  // 1) 任何 displayName/aliases 更新都被拒，不静默 slice(40)
  for (const extra of [{ displayName: '换名' }, { aliases: ['新别名'] }, { aliases: ['A'.repeat(100)] }]) {
    const r = applyUpdates(state, [{ name: '甲先生', evidence: '甲先生站在门口', ...extra }], { narration });
    assert.ok(r.rejected.some((x) => x.includes('未知字段')), `拒绝 ${Object.keys(extra)[0]} 更新`);
    assert.equal(r.changes.length, 0, '不产生变化/不写字段记录');
  }
  // 2) 稳定身份字段不变
  const p = state.npcProfiles[id];
  assert.equal(p.name, '甲先生');
  assert.equal(p.portraitName, '甲先生');
  assert.equal(p.id, id);

  // 3) 动态 NPC 的只读身份基线经 hydrate 从 baseline 重建并保留供搜索
  const empty = freshState({ npcs: [] });
  const dynId = e.stableId(empty.id, '货郎');
  const baseline = {
    original: { name: '货郎', role: '走街货郎' },
    displayName: '货郎老张', aliases: ['老张'], portraitName: '货郎',
  };
  const chg = memChange(dynId, '货郎', { turn: 1, heroName: '旅人', evidence: '货郎老张', fields: [] });
  chg.baseline = baseline;
  const ev = [eventRecord(1, { narration: '货郎老张挑着担子经过巷口。', memory: [chg] })];
  const r2 = e.hydrateNpcMemory(empty, ev);
  const p2 = r2.npcProfiles[dynId];
  assert.ok(p2, '动态 NPC 从 baseline 重建');
  assert.equal(p2.displayName, '货郎老张', '只读 displayName 保留供搜索');
  assert.deepEqual(p2.aliases, ['老张'], '只读 aliases 保留供搜索');
  assert.equal(p2.name, '货郎', 'canonical name 稳定');
  assert.equal(p2.portraitName, '货郎', 'portraitName 稳定');
  const pub2 = e.publicNpcProfiles(r2)[dynId];
  assert.equal(pub2.displayName, '货郎老张', '白名单内只读身份字段可公开');
  assert.deepEqual(pub2.aliases, ['老张']);
  assert.equal(Object.prototype.hasOwnProperty.call(pub2, 'original'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub2, 'internal'), false);
});

// =========================================================================
// 16. 返工回归⑦：动态原始基线保留首次完整 known+internal
// =========================================================================

test('返工回归⑦：动态 NPC 原始基线保留首次完整 known+internal，后续更新不覆盖', () => {
  const state = freshState({ npcs: [] });
  const narration1 = '琴师抱着一张旧琴，自称是个流浪琴师，心里惦记着失散的师妹，低声报了平安。';
  const r1 = applyUpdates(state, [{
    name: '琴师', evidence: '琴师抱着一张旧琴',
    known: { role: '流浪琴师', voice: '低声报了平安' },
    internal: { motivation: '惦记着失散的师妹' },
  }], { narration: narration1 });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  const id = r1.changes[0].id;
  const p1 = r1.state.npcProfiles[id];
  assert.equal(p1.original.role, '流浪琴师', '基线含首次 known.role');
  assert.equal(p1.original.voice, '低声报了平安', '基线含首次 known.voice');
  assert.equal(p1.original.internal.motivation, '惦记着失散的师妹', '基线含首次 internal 原始资料');
  assert.ok(r1.changes[0].baseline, 'change 携带 baseline');
  assert.equal(r1.changes[0].baseline.original.internal.motivation, '惦记着失散的师妹', 'baseline 含 internal');

  const narration2 = '琴师换了身青衫，如今是宫中乐师，改了主意要留在京城，高声唱了一曲。';
  const r2 = applyUpdates(r1.state, [{
    id, name: '琴师', evidence: '琴师换了身青衫',
    known: { role: '宫中乐师', voice: '高声唱了一曲' },
    internal: { motivation: '要留在京城' },
  }], { narration: narration2 });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  const p2 = r2.state.npcProfiles[id];
  assert.equal(p2.role, '宫中乐师', '当前值更新');
  assert.equal(p2.internal.motivation, '要留在京城', '当前 internal 更新');
  assert.equal(p2.original.role, '流浪琴师', '基线 role 不被后续覆盖');
  assert.equal(p2.original.voice, '低声报了平安', '基线 voice 不被后续覆盖');
  assert.equal(p2.original.internal.motivation, '惦记着失散的师妹', '基线 internal 不被后续覆盖');
  const fields = r2.changes[0].fields;
  assert.ok(fields.find((f) => f.key === 'role' && f.from === '流浪琴师' && f.to === '宫中乐师'),
    'role 旧值/新值进私有历史');
  assert.ok(fields.find((f) => f.scope === 'internal' && f.key === 'motivation'
    && f.from === '惦记着失散的师妹' && f.to === '要留在京城'), 'internal 旧值/新值进私有历史');
  const pub = e.publicNpcProfiles(r2.state)[id];
  const str = JSON.stringify(pub);
  assert.equal(str.includes('惦记着失散的师妹'), false, '公开 profile 不含首次 internal');
  assert.equal(str.includes('要留在京城'), false, '公开 profile 不含当前 internal');
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'original'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'internal'), false);
});

// =========================================================================
// 17. 第 2 轮收尾返工：有效 current 档案保留 / 「初始设定」基础公开资料
// =========================================================================

// 构造一份「已接纳」的 schema1 current 档案：林伯已公开、当前衣着=青色旧袍、
// 完整 original 在；初始快照保留灰袍。state 本身版本达标、结构完整。
function richLinBoState(clothing) {
  const state = freshState({ npcs: [
    { name: '林伯', role: '药铺药师', desc: '林伯年过半百，常穿灰色旧袍。',
      voice: '说话缓慢', want: 'SENTINEL_HIDDEN_WANT' },
  ] });
  const id = onlyId(state);
  const p = state.npcProfiles[id];
  const at = { turn: 1, life: 1, heroName: '旅人', clock: { day: 1, period: '清晨' } };
  p.established = true;
  p.role = '药铺药师';
  p.description = '林伯年过半百，常穿灰色旧袍。';
  p.voice = '说话缓慢';
  p.traits.appearance['衣着'] = clothing;
  // 第一轮档案：初始快照未纳入基础设定（留空），本次修复后由公开投影补基线。
  p.initial = null;
  p.firstRecord = clone(at);
  p.lastRecord = clone(at);
  p.lastInteraction = clone(at);
  p.latestExcerpt = '林伯给你倒了一碗热茶';
  return { state, id };
}

test('第2轮①：schema1 有效 current 档案 + 空日志仍能读人物，当前特征不被清空', () => {
  const { state, id } = richLinBoState('青色旧袍');
  const h = e.getNpcHistory(state, [], id, {});
  assert.ok(h, '读详情不再返回 null（旧无条件 hydrate 会整张卡消失）');
  assert.equal(h.profile.traits.appearance['衣着'], '青色旧袍', '已接纳的当前特征保留');
  assert.equal(h.profile.role, '药铺药师');
  assert.equal(h.profile.description, '林伯年过半百，常穿灰色旧袍。');
  assert.equal(h.profile.voice, '说话缓慢');
  assert.ok(h.profile.initial.description.includes('灰色旧袍'), '初始公开快照补回灰袍基础设定');
  assert.equal(h.history.total, 1, '缺日志无可回看原文，仅 eventIndex=-1 合成开场');
  assert.equal(h.history.entries[0].narration, '', '不编造任何回合原文');
  assert.equal(h.history.entries[0].excerpt, '林伯给你倒了一碗热茶', '开场线索回退到已发生原文摘录');
  // 普通读详情不反复全角色全史重建已有效 current cache：多次读当前特征始终一致
  // （若每次 hydrate 重建，种子只留 identity+original，青色旧袍会被抹掉）。
  for (let i = 0; i < 6; i++) {
    const h2 = e.getNpcHistory(state, [], id, { limit: 3 });
    assert.equal(h2.profile.traits.appearance['衣着'], '青色旧袍', '重复读不重建抹掉当前特征');
  }
  // 纯函数：不改入参
  assert.equal(state.npcProfiles[id].traits.appearance['衣着'], '青色旧袍');
  assert.equal(state.npcProfiles[id].established, true);
});

test('第2轮①：当前资料丰富但缺/部分日志仍能读人物且资料保持，历史严格只读 canonical 原文', () => {
  const { state, id } = richLinBoState('青色旧袍');
  // 部分日志：只有一条提到该角色的 canonical 原文，不含任何 typed 变化
  const partial = [eventRecord(1, { narration: '林伯给你倒了一碗热茶。' })];
  const h = e.getNpcHistory(state, partial, id, {});
  assert.ok(h);
  assert.equal(h.profile.traits.appearance['衣着'], '青色旧袍', '部分日志不抹掉当前特征');
  const real = h.history.entries.filter((x) => x.eventIndex >= 0);
  assert.equal(real.length, 1, '历史只取 canonical 可见原文，不编造');
  assert.ok(real[0].narration.includes('热茶'), '完整原文可认人');
  assert.deepEqual(real[0].changes, [], '缺 typed metadata 不伪造字段变化');
  // 缺日志：仅一条与该人物无关的原文，仍读人物且资料保持
  const unrelated = [eventRecord(2, { narration: '风吹过空荡的长街，无人经过。' })];
  const h2 = e.getNpcHistory(state, unrelated, id, {});
  assert.ok(h2);
  assert.equal(h2.profile.traits.appearance['衣着'], '青色旧袍', '无关日志也不重建抹掉当前特征');
  assert.equal(h2.history.entries.filter((x) => x.eventIndex >= 0).length, 0, '无关原文不算该人物经历');
});

test('第2轮①：完整日志 + undo 恢复旧快照仍正确，不复活快照里本不存在的资料', () => {
  const { state, id } = richLinBoState('灰色旧袍'); // undo 后快照里的旧值
  const events = [
    eventRecord(1, { narration: '林伯给你倒了一碗热茶。' }),
    eventRecord(2, { narration: '林伯换上青色旧袍，OLD-BRANCH-青袍。' }),
    { type: 'undo', undoneTurn: 2 },
    eventRecord(2, { narration: '林伯仍在药铺，NEW-BRANCH。' }),
  ];
  const h = e.getNpcHistory(state, events, id, {});
  assert.ok(h);
  assert.equal(h.profile.traits.appearance['衣着'], '灰色旧袍', 'undo 快照旧值不被重建抹掉 / 不复活旧分支');
  const all = JSON.stringify(h.history.entries);
  assert.equal(all.includes('OLD-BRANCH'), false, '撤回原文不复活');
  assert.equal(all.includes('青色旧袍'), false, '撤回分支的青袍资料不复活');
  assert.ok(all.includes('NEW-BRANCH'), '重走同 turn 的新版本可见');
  assert.equal(e.getNpcHistory(state, events, 'npc_不存在', {}), null, '快照里本不存在的人物不复活');
});

test('第2轮①：needsNpcHydration 识别版本达标但 profile 结构缺失/损坏（有基线/已知角色）', () => {
  const sound = e.initializeNpcMemory({ id: 'w', bible: { npcs: [{ name: '林伯', role: '药铺药师' }] } });
  assert.equal(e.needsNpcHydration(sound), false, '有效新版档案不需回填');
  const missing = clone(sound);
  missing.npcProfiles = {};
  assert.equal(e.needsNpcHydration(missing), true, 'version=1 但基线人物缺 profile → 需回填');
  const broken = clone(sound);
  const id = onlyId(broken);
  broken.npcProfiles[id].original = null;
  assert.equal(e.needsNpcHydration(broken), true, '完整 original 损坏 → 需回填');
  const brokenTraits = clone(sound);
  brokenTraits.npcProfiles[id].traits = 'not-an-object';
  assert.equal(e.needsNpcHydration(brokenTraits), true, '结构化 traits 损坏 → 需回填');
  assert.equal(e.needsNpcHydration(e.normalizeState({ bible: { npcs: [{ name: '甲' }] } })), true,
    '旧格式仍判需回填');
  assert.equal(e.needsNpcHydration({ npcMemoryVersion: e.NPC_MEMORY_VERSION, npcProfiles: {} }), false,
    '无任何基线/已知角色的空档不需无谓回填');
  // 结构损坏档能经 hydrate 修复，基线与原文保留
  const ev = [eventRecord(1, { narration: '林伯给你倒了一碗热茶。' })];
  const repaired = e.hydrateNpcMemory(missing, ev);
  assert.equal(e.needsNpcHydration(repaired), false);
  const repairedId = e.stableId('w', '林伯');
  assert.equal(repaired.npcProfiles[repairedId].original.role, '药铺药师', '缺 profile 时从世界设定补回完整 original');
  // original 损坏但 profile 仍在时，hydrate 也从世界设定补回，卡片基础资料不丢
  const repaired2 = e.hydrateNpcMemory(broken, ev);
  assert.equal(repaired2.npcProfiles[repairedId].original.role, '药铺药师', 'original 损坏时按基线补回');
  const pub = e.publicNpcProfiles(repaired2)[repairedId];
  assert.ok(pub, '修复后已公开出场人物有卡片');
  assert.equal(pub.role, '药铺药师', '修复后基础身份可读');
});

test('第2轮②：旧格式迁移后角色卡有「初始设定」基础身份/灰袍，隐藏 want 不进公开 JSON', () => {
  const old = {
    id: 'wlin', turn: 1, life: 1, character: { name: '旅人' }, clock: { day: 1, period: '清晨' },
    bible: { npcs: [
      { name: '林伯', role: '药铺药师', desc: '林伯年过半百，常穿灰色旧袍。',
        voice: '说话缓慢', want: 'SENTINEL_HIDDEN_WANT' },
    ] },
    npcAttitude: { 林伯: 0 },
  };
  const norm = e.normalizeState(old);
  const events = [eventRecord(1, { narration: '林伯给你倒了一碗热茶。' })];
  const r = e.hydrateNpcMemory(norm, events);
  const id = e.stableId('wlin', '林伯');
  const pub = e.publicNpcProfiles(r)[id];
  assert.ok(pub, '已有公开出场记录的人物有卡片');
  assert.equal(pub.role, '药铺药师', '基础公开身份来自已有世界设定');
  assert.equal(pub.description, '林伯年过半百，常穿灰色旧袍。', '初始灰袍外显形象');
  assert.equal(pub.voice, '说话缓慢', '基础口吻');
  assert.equal(pub.initial.role, '药铺药师', '初始设定快照可读');
  assert.ok(pub.initial.description.includes('灰色旧袍'), '初始快照保留灰袍资料');
  const str = JSON.stringify(pub);
  assert.equal(str.includes('SENTINEL_HIDDEN_WANT'), false, '隐藏 want marker 不在公开 JSON');
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'original'), false, '完整 original 不倒灌');
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'want'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'internal'), false);
  assert.ok(pub.latestExcerpt.includes('热茶'), '共事经历仍只读 canonical 原文');
  // getNpcHistory 的 profile 与公开字典同源
  const h = e.getNpcHistory(r, events, id, {});
  assert.equal(h.profile.role, '药铺药师');
  assert.ok(h.history.entries.some((x) => x.narration.includes('热茶')), '原文可回看');
});

test('第2轮②：后来叙事支持的青袍变化覆盖当前字段，但不覆盖灰袍初始快照/完整 original', () => {
  const old = {
    id: 'wlin', turn: 2, life: 1, character: { name: '旅人' }, clock: { day: 1, period: '清晨' },
    bible: { npcs: [
      { name: '林伯', role: '药铺药师', desc: '林伯年过半百，常穿灰色旧袍。', voice: '说话缓慢' },
    ] },
    npcAttitude: { 林伯: 0 },
  };
  const norm = e.normalizeState(old);
  const id = e.stableId('wlin', '林伯');
  const chg = memChange(id, '林伯', { turn: 2, evidence: '林伯换上青色旧袍',
    fields: [{ scope: 'public', kind: 'trait', key: 'appearance', label: '衣着', from: '', to: '青色旧袍' }] });
  const events = [
    eventRecord(1, { narration: '林伯给你倒了一碗热茶。' }),
    eventRecord(2, { narration: '林伯换上青色旧袍，站在药铺门口。', memory: [chg] }),
  ];
  const r = e.hydrateNpcMemory(norm, events);
  const pub = e.publicNpcProfiles(r)[id];
  assert.equal(pub.traits.appearance['衣着'], '青色旧袍', '后来叙事变化覆盖当前特征');
  assert.ok(pub.initial.description.includes('灰色旧袍'), '初始快照仍保留灰袍初始资料');
  assert.equal(pub.initial.traits.appearance['衣着'], undefined, '初始快照不混入后续变化');
  assert.equal(r.npcProfiles[id].original.desc, '林伯年过半百，常穿灰色旧袍。', '完整 original 不被覆盖');
  assert.equal(r.npcProfiles[id].original.want, undefined);
});

test('第2轮②：含秘密的反例不主动展开暗线；普通公开岗位不一律置空；不确定留未知', () => {
  const state = freshState({ npcs: [
    { name: '影卫', role: '药铺伙计', desc: '表面是药铺伙计，实则是暗中守护钟楼的密探。',
      voice: '低声', want: 'SENTINEL_HIDDEN_WANT' },
  ] });
  const id = onlyId(state);
  const r = applyUpdates(state, [{ name: '影卫', evidence: '影卫替你' }],
    { narration: '影卫替你斟了一杯茶。' });
  assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
  const pub = e.publicNpcProfiles(r.state)[id];
  assert.ok(pub, '已公开出场');
  assert.equal(pub.role, '药铺伙计', '普通公开岗位不被一律置空');
  assert.equal(pub.description, '', '含秘密/伪装/暗中的私密句段保守省略，不展开暗线');
  assert.equal(pub.initial.description, '', '初始快照也不编私密背景');
  const str = JSON.stringify(pub);
  for (const secret of ['实则', '暗中', '密探', '钟楼', 'SENTINEL_HIDDEN_WANT']) {
    assert.equal(str.includes(secret), false, `公开 JSON 不泄露 ${secret}`);
  }
  // 隐藏身份直接写在 role / desc 里时整段省略，不另造一个人物背景
  const state2 = freshState({ npcs: [
    { name: '影', role: '密探（私密设定）', desc: '影的完整私密背景', want: 'SENTINEL_WANT' },
  ] });
  const id2 = onlyId(state2);
  const narration = '影从廊柱后走出，只说了一句「别跟着我」。';
  const r2 = applyUpdates(state2, [{ name: '影', evidence: '影从廊柱后走出' }], { narration });
  const pub2 = e.publicNpcProfiles(r2.state)[id2];
  assert.equal(pub2.role, '', '不确定的隐藏身份留未知');
  assert.equal(pub2.description, '', '私密背景不进公开档案');
  assert.equal(pub2.initial.role, '', '初始快照不编造隐藏身份');
  assert.equal(JSON.stringify(pub2).includes('私密背景'), false);
});

test('第2轮②：已有合法 current 资料不被基础默认设定覆盖；原文证据规则不放开', () => {
  const state = freshState({ npcs: [
    { name: '林伯', role: '药铺药师', desc: '林伯年过半百，常穿灰色旧袍。', voice: '说话缓慢' },
  ] });
  const id = onlyId(state);
  const narration = '林伯如今是坐堂大夫，说话缓慢地报出药名。';
  const r1 = applyUpdates(state, [{ name: '林伯', evidence: '林伯如今是', known: { role: '坐堂大夫' } }],
    { narration });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  const pub1 = e.publicNpcProfiles(r1.state)[id];
  assert.equal(pub1.role, '坐堂大夫', '叙事支持的当前身份不被基础默认值覆盖');
  assert.equal(pub1.initial.role, '坐堂大夫', '初始快照记录首次已知资料，不被基础默认值改写');
  // 后来另一条合法原文变化只覆盖当前字段，不覆盖已存在的初始快照
  const narration2 = '林伯如今是药铺掌柜，拨着算盘。';
  const r2 = applyUpdates(r1.state, [{ id, name: '林伯', evidence: '林伯如今是', known: { role: '药铺掌柜' } }],
    { narration: narration2 });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  const pub2 = e.publicNpcProfiles(r2.state)[id];
  assert.equal(pub2.role, '药铺掌柜', '后来变化覆盖当前字段');
  assert.equal(pub2.initial.role, '坐堂大夫', '初始快照不被后续变化覆盖');
  // 普通 npc_updates 的新变化仍按第一轮原文证据规则校验：非原文公开值被拒
  const r3 = applyUpdates(state, [{ name: '林伯', evidence: '林伯如今是',
    known: { role: '凭空捏造的隐世高手' } }], { narration });
  assert.ok(r3.rejected.some((x) => x.includes('未在本回合叙事原文出现')), '不因基础设定放开元数据编造');
  assert.equal(r3.state.npcProfiles[id].role, '', '被拒的编造值不写入私有 profile');
});

// =========================================================================
// 18. 第 3 轮收尾返工：夹带已接纳旧值 / change 不记互动 / 最近度按最新经历
// =========================================================================

test('第3轮①：夹带「已接纳且未变化」的旧值不再整条被拒，只合并真正变化的字段', () => {
  const state = freshState({ npcs: [
    { name: '林伯', role: '药铺药师', desc: '林伯年过半百，常穿灰色旧袍。', voice: '说话缓慢' },
  ] });
  const id = onlyId(state);
  const original = JSON.stringify(state.npcProfiles[id].original);
  // 回合 1：原文接纳 role 药铺药师 + appearance.衣着 灰袍
  const r1 = applyUpdates(state, [{
    name: '林伯', kind: 'interaction', evidence: '林伯是药铺药师',
    known: { role: '药铺药师', traits: { appearance: { 衣着: '灰袍' } } },
  }], { turn: 1, narration: '林伯是药铺药师，身穿灰袍。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  const p1 = r1.state.npcProfiles[id];
  assert.equal(p1.role, '药铺药师');
  assert.equal(p1.traits.appearance['衣着'], '灰袍');
  const initial = JSON.stringify(p1.initial);

  // 回合 2：同条同时带未变化的 role（不在本回合原文）+ 变化的 衣着 蓝袍（在本回合原文）
  const r2 = applyUpdates(r1.state, [{
    id, name: '林伯', kind: 'change', evidence: '林伯换上蓝袍',
    known: { role: '药铺药师', traits: { appearance: { 衣着: '蓝袍' } } },
  }], { turn: 2, narration: '林伯换上蓝袍，走到你面前。' });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected), '不得因夹带未变化旧值整条被拒');
  assert.equal(r2.changes.length, 1);
  const fields = r2.changes[0].fields;
  const cloth = fields.find((f) => f.scope === 'public' && f.kind === 'trait'
    && f.key === 'appearance' && f.label === '衣着');
  assert.ok(cloth, '记录衣着变化');
  assert.deepEqual({ from: cloth.from, to: cloth.to }, { from: '灰袍', to: '蓝袍' }, '灰袍→蓝袍');
  assert.equal(fields.some((f) => f.scope === 'public' && f.key === 'role'), false,
    '未变化的 role 不新增字段变化');
  assert.equal(fields.length, 1, '整条只新增 1 个字段变化');
  const p2 = r2.state.npcProfiles[id];
  assert.equal(p2.role, '药铺药师', '保留其它资料');
  assert.equal(e.publicNpcProfiles(r2.state)[id].voice, '说话缓慢', '未给项不擦除（基线音色仍可见）');
  assert.equal(p2.traits.appearance['衣着'], '蓝袍', '衣着增量更新为蓝袍');
  // 原始 original 与初始快照保持不变
  assert.equal(JSON.stringify(p2.original), original, '完整 original 不被 patch 覆盖');
  assert.equal(JSON.stringify(p2.initial), initial, '初始快照保持不变');
  assert.equal(p2.initial.traits.appearance['衣着'], '灰袍', '初始快照仍是灰袍');

  // 相同字段重复 patch（此时两者都已等于当前值）：不新增字段变化、不被拒
  const r3 = applyUpdates(r2.state, [{
    id, name: '林伯', kind: 'change', evidence: '林伯仍穿着蓝袍',
    known: { role: '药铺药师', traits: { appearance: { 衣着: '蓝袍' } } },
  }], { turn: 3, narration: '林伯仍穿着蓝袍，走到你面前。' });
  assert.equal(r3.rejected.length, 0, JSON.stringify(r3.rejected), '相同值重复 patch 不被拒');
  assert.equal(r3.changes.length, 1);
  assert.equal(r3.changes[0].fields.length, 0, '相同字段重复 patch 不新增字段变化');
  assert.equal(r3.state.npcProfiles[id].traits.appearance['衣着'], '蓝袍');
});

test('第3轮①：旧值免除原文举证不放松私密防护——新造公开值与人物相关性仍被拒', () => {
  const state = freshState({ npcs: [{ name: '林伯' }] });
  const id = onlyId(state);
  const r1 = applyUpdates(state, [{ name: '林伯', kind: 'interaction', evidence: '林伯是药铺药师',
    known: { role: '药铺药师' } }], { turn: 1, narration: '林伯是药铺药师，站在药铺里。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  // 夹带未变化旧值 role + 凭空捏造的新公开值（不在本回合原文）→ 整条仍被拒
  const r2 = applyUpdates(r1.state, [{ id, name: '林伯', kind: 'change', evidence: '林伯走到你面前',
    known: { role: '药铺药师', description: '暗中寻找妹妹的隐世密探' } }],
    { turn: 2, narration: '林伯走到你面前，点了点头。' });
  assert.ok(r2.rejected.some((x) => x.includes('未在本回合叙事原文出现')),
    '真正变化的捏造值仍须本回合原文举证');
  assert.equal(r2.changes.length, 0, '整条不产生变化');
  assert.equal(r2.state.npcProfiles[id].description, '', '捏造值不写入');
  assert.equal(r2.state.npcProfiles[id].role, '药铺药师', '未变化旧值保持');
  // 人物相关性：正文未真实提及该角色时，即便夹带已接纳旧值也不能建立/更改
  const r3 = applyUpdates(r1.state, [{ id, name: '林伯', kind: 'change', evidence: '风吹过门口',
    known: { role: '药铺药师' } }], { turn: 3, narration: '风吹过门口，檐角挂着一串旧铃。' });
  assert.ok(r3.rejected.some((x) => x.includes('真实提及')), '未在本回合真实提及仍被拒');
  assert.equal(r3.changes.length, 0);
});

test('第3轮②：lastInteraction 只由明确 interaction 更新；change/mention 只推进 lastRecord', () => {
  const state = freshState({ npcs: [{ name: '林伯' }] });
  const id = onlyId(state);
  // 回合 1：明确互动
  const r1 = applyUpdates(state, [{ name: '林伯', kind: 'interaction', evidence: '林伯递来' }],
    { turn: 1, narration: '林伯递来一碗热茶，与你寒暄几句。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  assert.equal(r1.state.npcProfiles[id].lastInteraction.turn, 1);
  assert.equal(r1.state.npcProfiles[id].lastRecord.turn, 1);
  // 回合 2：听闻消息导致的 change（未实际互动）
  const r2 = applyUpdates(r1.state, [{ id, name: '林伯', kind: 'change', evidence: '你听说林伯' }],
    { turn: 2, narration: '你听说林伯换了蓝袍，并未见着他。' });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  const p2 = r2.state.npcProfiles[id];
  assert.equal(p2.lastInteraction.turn, 1, 'change 不默默记为见过面，保持原互动时间');
  assert.equal(p2.lastRecord.turn, 2, 'lastRecord 记录所有相关经历，前进到 2');
  // 回合 3：mention 同样不刷新 lastInteraction
  const r3 = applyUpdates(r2.state, [{ id, name: '林伯', kind: 'mention', evidence: '有人提起林伯' }],
    { turn: 3, narration: '有人提起林伯，说书人讲了几句。' });
  assert.equal(r3.rejected.length, 0, JSON.stringify(r3.rejected));
  const p3 = r3.state.npcProfiles[id];
  assert.equal(p3.lastInteraction.turn, 1, 'mention 也不记为当面互动');
  assert.equal(p3.lastRecord.turn, 3, 'lastRecord 继续前进到 3');
});

test('第3轮③：普通最近度按最新 lastRecord，旧互动+新消息的人不被较旧记录挤走', () => {
  let s = freshState({ npcs: [] });
  // 故人：turn 1 互动（lastInteraction=1, lastRecord=1）
  const r0 = applyUpdates(s, [{ name: '故人', kind: 'interaction', evidence: '故人现身' }],
    { turn: 1, narration: '故人现身旧巷，与旅人寒暄数句。' });
  assert.equal(r0.rejected.length, 0, JSON.stringify(r0.rejected));
  s = r0.state;
  const targetId = onlyId(s);
  // 4 个「较旧记录」的人：各自互动于 turn 50~53
  let t = 50;
  for (const name of ['甲', '乙', '丙', '丁']) {
    const r = applyUpdates(s, [{ name, kind: 'interaction', evidence: `${name}现身` }],
      { turn: t, narration: `${name}现身长街，人群熙攘。` });
    assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
    s = r.state;
    t += 1;
  }
  // 故人：turn 100 仅听闻消息（change，不实际互动）→ lastRecord=100，lastInteraction 仍=1
  const rNew = applyUpdates(s, [{ name: '故人', kind: 'change', evidence: '你听人说故人' }],
    { turn: 100, narration: '你听人说故人近日回了旧巷，并未见着。' });
  assert.equal(rNew.rejected.length, 0, JSON.stringify(rNew.rejected));
  s = rNew.state;
  const pt = s.npcProfiles[targetId];
  assert.equal(pt.lastInteraction.turn, 1, '互动发生在很久以前');
  assert.equal(pt.lastRecord.turn, 100, '刚有新消息（最新相关经历）');
  // 不点名任何人：普通相关性按最近度排序，最新消息的人应排在最前
  const ctx1 = e.npcPromptContext(s, '四处张望', { maxNpcs: 1 });
  assert.ok(ctx1.includes('NPC「故人」'), '按最新 lastRecord 而非旧互动排序');
  // 4 个较旧记录的人不能把刚有新消息的人挤出 ≤4 人预算
  const ctx4 = e.npcPromptContext(s, '四处张望', { maxNpcs: 4 });
  assert.ok(ctx4.includes('NPC「故人」'), '旧互动+最新消息的人仍在 ≤4 人预算内');
  assert.ok((ctx4.match(/NPC「/g) || []).length <= 4, '至多 4 人预算');
  // 玩家明确点名仍是绝对优先
  const ctxNamed = e.npcPromptContext(s, '向甲问起往事', { maxNpcs: 1 });
  assert.ok(ctxNamed.includes('NPC「甲」'), '玩家明确点名绝对优先于最近度');
});

// =========================================================================
// 16. 接线第2轮收尾：跨两世的时间 / 来源对齐（最近线索、代词承接）
// =========================================================================

test('跨两世时间/来源对齐：新线索标本世主角与时间、旧关系仍带前世来源、下一回合代词可承接、未公开/不相关代词不解锁', () => {
  const state = freshState({ npcs: [
    { name: '林伯' },
    { name: '乙员外' }, // 仅第一世同场公开，之后停在旧记录（不相关）
    { name: '旁人' },   // 基线存在但从未出场（未公开）
  ] });
  const idOf = (n) => Object.values(state.npcProfiles).find((p) => p.name === n).id;
  const linId = idOf('林伯');
  const yiId = idOf('乙员外');
  const otherId = idOf('旁人');

  // 第一世 / 顾长风 / turn 1：林伯当面互动结下旧交（关系来源 = 前世），乙员外同场公开。
  const s1 = clone(state);
  s1.life = 1;
  s1.character = { name: '顾长风' };
  s1.clock = { day: 5, period: '黄昏' };
  const r1 = applyUpdates(s1, [
    { name: '林伯', kind: 'interaction', evidence: '林伯与顾长风',
      known: { relationshipSummary: '林伯与顾长风是旧交' } },
    { name: '乙员外', evidence: '乙员外也在座' },
  ], { turn: 1, narration: '林伯与顾长风是旧交，二人在旧亭叙旧，乙员外也在座。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  const p1 = r1.state.npcProfiles[linId];
  assert.equal(p1.lastInteraction.turn, 1);
  assert.equal(p1.lastInteraction.life, 1);
  assert.equal(p1.lastRecord.turn, 1);
  assert.equal(p1.relationshipAt.life, 1, '旧关系锚定第一世');

  // 第二世 / 林晚 / turn 3：仅听闻林伯近况（mention，不当面互动）。
  const s2 = clone(r1.state);
  s2.life = 2;
  s2.character = { name: '林晚' };
  s2.clock = { day: 2, period: '清晨' };
  const r2 = applyUpdates(s2, [
    { id: linId, name: '林伯', kind: 'mention', evidence: '林伯如今在城里开药铺。' },
  ], { turn: 3, narration: '有人提起，林伯如今在城里开药铺。' });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected));
  const p2 = r2.state.npcProfiles[linId];
  assert.equal(p2.lastRecord.turn, 3, 'lastRecord 前进到本世新线索');
  assert.equal(p2.lastRecord.life, 2);
  assert.equal(p2.lastRecord.heroName, '林晚');
  assert.equal(p2.lastInteraction.turn, 1, '听闻不刷新 lastInteraction');
  assert.equal(p2.lastInteraction.life, 1, 'lastInteraction 仍保留第一世，听闻不成互动');
  assert.equal(p2.relationshipAt.life, 1, '旧关系来源不变');

  // 提示词：最近线索用 lastRecord（本世 / 林晚），关系仍用 relationshipAt（前世 / 顾长风）。
  const ctx = e.npcPromptContext(r2.state, '向人打听林伯', {});
  const linBlock = ctx.split('\n').find((line) => line.startsWith('NPC「林伯」'));
  assert.ok(linBlock, '林伯档案在提示词中');
  const relLine = linBlock.split('｜').find((f) => f.startsWith('关系:'));
  const clueLine = linBlock.split('｜').find((f) => f.startsWith('最近线索:'));
  assert.ok(relLine, '含关系摘要');
  assert.ok(clueLine, '含最近线索');
  assert.ok(clueLine.includes('林伯如今在城里开药铺'), '最近线索为本世新听闻');
  assert.ok(clueLine.includes('第2世') && clueLine.includes('林晚'), '新线索标本世主角与时间');
  assert.equal(clueLine.includes('前世第1世'), false, '新线索不误标为前世来源');
  assert.equal(clueLine.includes('顾长风'), false, '新线索不带旧主角顾长风');
  assert.ok(relLine.includes('前世第1世') && relLine.includes('顾长风'), '原关系仍带前世来源');
  assert.equal(relLine.includes('林晚'), false, '旧关系不自动改标本世主角');

  // 紧接下一回合（turn 4）：正文仅用代词「他」承接本世上一回合焦点林伯。
  const r4 = applyUpdates(r2.state, [
    { id: linId, name: '林伯', kind: 'mention', evidence: '他已经搬到东城' },
    { id: yiId, name: '乙员外', kind: 'mention', evidence: '他已经搬到东城' },
    { id: otherId, name: '旁人', kind: 'mention', evidence: '他已经搬到东城' },
  ], { turn: 4, narration: '他已经搬到东城，药铺也盘了出去。' });
  assert.equal(r4.rejected.length, 2, '未公开 / 不相关（旧记录）人物的代词更新被拒');
  assert.ok(r4.rejected[0].includes('npc_updates[1]'), '被拒的是不相关的乙员外');
  assert.ok(r4.rejected[1].includes('npc_updates[2]'), '被拒的是未公开的旁人');
  assert.equal(r4.changes.length, 1, '仅林伯的代词承接被接受');
  assert.equal(r4.changes[0].id, linId, '接受的是本世上一回合相关者林伯');
  assert.equal(r4.state.npcProfiles[linId].lastInteraction.turn, 1, '代词承接不把听闻变成互动');
});

// =========================================================================
// 19. 协议对齐：已有公共标签的键名豁免（标签优先复用当前档案已有键）
// =========================================================================

// 构造「已接纳」的当前 public 档案：appearance.头发=头发花白 是首回合靠正文字面
// 登记的非中性标签；后续回合正文里不再出现「头发」二字。
function acceptedHairState() {
  const state = freshState({ npcs: [{ name: '林伯' }] });
  const id = onlyId(state);
  const r1 = applyUpdates(state, [{
    name: '林伯', kind: 'interaction', evidence: '林伯头发花白',
    known: { traits: { appearance: { 头发: '头发花白' } } },
  }], { turn: 1, narration: '林伯头发花白。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  return { state: r1.state, id };
}

test('协议对齐①：已接纳同分类同键公共标签，旧键+本回合原文新值成功，其它特征/original/initial 不丢', () => {
  const state = freshState({ npcs: [
    { name: '林伯', desc: '林伯少年时走南闯北的完整原始设定', want: 'SENTINEL_WANT' },
  ] });
  const id = onlyId(state);
  const originalStr = JSON.stringify(state.npcProfiles[id].original);
  // 回合 1：正文「头发花白」含键名「头发」，登记非中性标签 头发 + 中性标签 衣着 + role
  const narration1 = '林伯头发花白，身穿灰色旧袍，是村里的药铺药师。';
  const r1 = applyUpdates(state, [{
    name: '林伯', kind: 'interaction', evidence: '林伯头发花白',
    known: { role: '药铺药师', traits: { appearance: { 头发: '头发花白', 衣着: '灰色旧袍' } } },
  }], { turn: 1, narration: narration1 });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  const p1 = r1.state.npcProfiles[id];
  assert.equal(p1.traits.appearance['头发'], '头发花白');
  assert.equal(p1.traits.appearance['衣着'], '灰色旧袍');
  const initialStr = JSON.stringify(p1.initial);

  // 主脑复现：回合 2 正文「林伯露出一撮白发。」不含键名「头发」，但新值「一撮白发」
  // 是本回合原文连续子串。旧键应被豁免，不再要求键名本身再写进正文。
  const narration2 = '林伯露出一撮白发。';
  const r2 = applyUpdates(r1.state, [{
    id, name: '林伯', kind: 'change', evidence: '林伯露出一撮白发',
    known: { traits: { appearance: { 头发: '一撮白发' } } },
  }], { turn: 2, narration: narration2 });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected), '旧键+原文新值不得被标签校验误拒');
  const p2 = r2.state.npcProfiles[id];
  assert.equal(p2.traits.appearance['头发'], '一撮白发', '新值被接纳');
  assert.equal(p2.traits.appearance['衣着'], '灰色旧袍', '其它特征不丢');
  assert.equal(p2.role, '药铺药师', '其它公开字段不丢');
  assert.equal(JSON.stringify(p2.original), originalStr, '完整 original 不被 patch 覆盖');
  assert.equal(JSON.stringify(p2.initial), initialStr, 'initial 快照不丢');
  assert.equal(p2.initial.traits.appearance['头发'], '头发花白', 'initial 仍是首回合旧值');
  // 是真正在变化的字段（from→to），不是被跳过的未变化值
  assert.equal(r2.changes.length, 1);
  const hair = r2.changes[0].fields.find((f) => f.scope === 'public' && f.kind === 'trait' && f.label === '头发');
  assert.ok(hair, '记录头发变化');
  assert.deepEqual({ from: hair.from, to: hair.to }, { from: '头发花白', to: '一撮白发' });
});

test('协议对齐②：未变化旧键重送幂等（标签与旧值都不在本回合正文）', () => {
  const { state, id } = acceptedHairState();
  // 本回合正文既不含键名「头发」，也不含旧值「头发花白」；重送同一旧键+旧值。
  const r2 = applyUpdates(state, [{
    id, name: '林伯', kind: 'change', evidence: '林伯露出一撮白发',
    known: { traits: { appearance: { 头发: '头发花白' } } },
  }], { turn: 2, narration: '林伯露出一撮白发。' });
  assert.equal(r2.rejected.length, 0, JSON.stringify(r2.rejected), '不得因旧键/旧值不在正文整条被拒');
  assert.equal(r2.state.npcProfiles[id].traits.appearance['头发'], '头发花白', '旧值保持不变');
  assert.equal(r2.changes.length, 1);
  assert.equal(r2.changes[0].fields.length, 0, '未变化旧键重送不新增字段变化');
});

test('协议对齐③：新造非中性标签仍拒绝；已接纳键的概括/非子串新值仍拒绝', () => {
  // (a) 全新非中性标签：既不在中性词表、也不在本回合正文 → 仍拒绝
  const s = freshState({ npcs: [{ name: '林伯' }] });
  const rNew = applyUpdates(s, [{
    name: '林伯', kind: 'interaction', evidence: '林伯站在门口',
    known: { traits: { identity: { '秘密身份': '密探' } } },
  }], { narration: '林伯站在门口，点了点头。' });
  assert.ok(rNew.rejected.some((x) => x.includes('非中性且未在叙事原文出现')), '新造猜测标签仍拒绝');
  assert.equal(rNew.changes.length, 0);
  assert.equal(JSON.stringify(e.publicNpcProfiles(rNew.state)).includes('秘密身份'), false,
    '私密/猜测标签不进公开档案');

  // (b) 已接纳的「头发」键，但新值是概括/非子串（不在本回合原文）→ 仍拒绝
  const { state, id } = acceptedHairState();
  const rSum = applyUpdates(state, [{
    id, name: '林伯', kind: 'change', evidence: '林伯露出一撮白发',
    known: { traits: { appearance: { 头发: '银白色的头发' } } },
  }], { turn: 2, narration: '林伯露出一撮白发。' });
  assert.ok(rSum.rejected.some((x) => x.includes('未在本回合叙事原文出现')),
    '真正变化的新值仍须原文连续子串，标签键名豁免不迁就概括值');
  assert.equal(rSum.changes.length, 0);
  assert.equal(rSum.state.npcProfiles[id].traits.appearance['头发'], '头发花白', '旧值不变');
});

test('协议对齐④：只存在于另一 NPC 或 internal 的同键不能借用', () => {
  // (a) 另一 NPC 的公开「头发」键不能借用
  const s1 = freshState({ npcs: [{ name: '林伯' }, { name: '陈伯' }] });
  const idLin = Object.values(s1.npcProfiles).find((p) => p.name === '林伯').id;
  const r1 = applyUpdates(s1, [
    { name: '陈伯', kind: 'interaction', evidence: '陈伯头发花白',
      known: { traits: { appearance: { 头发: '头发花白' } } } },
    { name: '林伯', kind: 'interaction', evidence: '林伯身穿青衫',
      known: { traits: { appearance: { 衣着: '青衫' } } } },
  ], { turn: 1, narration: '陈伯头发花白，林伯身穿青衫，两人站在门口。' });
  assert.equal(r1.rejected.length, 0, JSON.stringify(r1.rejected));
  // 林伯自身无「头发」键；正文也不含「头发」二字 → 不得借用陈伯的同键
  const r2 = applyUpdates(r1.state, [{
    id: idLin, name: '林伯', kind: 'change', evidence: '林伯露出一撮白发',
    known: { traits: { appearance: { 头发: '一撮白发' } } },
  }], { turn: 2, narration: '林伯露出一撮白发。' });
  assert.ok(r2.rejected.some((x) => x.includes('非中性且未在叙事原文出现')), '别的 NPC 的同键不能借用');
  assert.equal(r2.state.npcProfiles[idLin].traits.appearance['头发'], undefined, '林伯不被写入该键');

  // (b) 只放在 internal（私有 flat map）的同键也不能借用
  const s2 = freshState({ npcs: [{ name: '林伯' }] });
  const id2 = onlyId(s2);
  const q1 = applyUpdates(s2, [{
    name: '林伯', kind: 'interaction', evidence: '林伯站在门口',
    internal: { '头发': '花白' },
  }], { turn: 1, narration: '林伯站在门口，点了点头。' });
  assert.equal(q1.rejected.length, 0, JSON.stringify(q1.rejected));
  assert.equal(q1.state.npcProfiles[id2].internal['头发'], '花白', '同键只存在于 internal');
  assert.equal(q1.state.npcProfiles[id2].traits.appearance['头发'], undefined, 'public traits 无该键');
  const q2 = applyUpdates(q1.state, [{
    id: id2, name: '林伯', kind: 'change', evidence: '林伯露出一撮白发',
    known: { traits: { appearance: { 头发: '一撮白发' } } },
  }], { turn: 2, narration: '林伯露出一撮白发。' });
  assert.ok(q2.rejected.some((x) => x.includes('非中性且未在叙事原文出现')), 'internal 的同键不能借用');
  assert.equal(q2.state.npcProfiles[id2].traits.appearance['头发'], undefined, 'internal 同键不写入公开 traits');
});
