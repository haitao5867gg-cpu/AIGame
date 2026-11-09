'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine.js');
const extract = require('../src/npc-extraction.js');

const clone = (v) => JSON.parse(JSON.stringify(v));
const narration = '林伯解开绷带，右手露出一道浅红的旧疤。';
function fixture() {
  let before = engine.createWorld({ id: 'extract-test', name: '旅人',
    bible: { start: { place: '药铺' }, npcs: [{ name: '林伯', role: '药师', want: 'PRIVATE_EXTRACTION_SENTINEL' }] },
  }, { rng: () => 0.5, now: 1 });
  const after = clone(before); after.turn = 1;
  before = engine.applyNpcMemory(before, after, [{ name: '林伯', kind: 'interaction',
    evidence: '林伯右手裹着绷带。', known: { traits: { appearance: { 右手: '右手裹着绷带' } } },
  }], { action: '问候林伯', narration: '林伯右手裹着绷带。' }).state;
  const state = clone(before); state.turn = 2;
  return { before, resolved: { state, result: { narration, npc_memory: [],
    applied: { state_diff: { 体魄: 0 } }, scene: { draw: false }, adult: false } },
    id: Object.keys(before.npcProfiles)[0] };
}
function response(id, value = '一道浅红的旧疤') {
  return { content: JSON.stringify({ npc_updates: [{ id, name: '林伯', kind: 'change',
    evidence: narration, known: { traits: { appearance: { 右手: value } } },
  }] }), usage: { prompt_tokens: 30, completion_tokens: 20 } };
}

test('补档只读取公开摘录与已接纳正文，无私有人设，输入有硬上限', () => {
  const f = fixture(); const request = extract.buildRequest(f.before, f.resolved, '看看林伯的手');
  assert(request && request.inputUpper <= extract.MAX_INPUT);
  const text = JSON.stringify(request.messages);
  assert(!text.includes('PRIVATE_EXTRACTION_SENTINEL'));
  assert(text.includes(narration));
  assert(text.includes('裹着绷带'));
});

test('漏记新特征时独立摘录入库，正文、数值、场景、初始人设不改，费用进入回合用量', async () => {
  const f = fixture(); const original = clone(f.before.npcProfiles[f.id]);
  let calls = 0; const usages = [];
  const client = { complete: async (opts) => {
    calls++; assert.equal(opts.purpose, 'npc_memory');
    assert.equal(opts.maxTokens, 1500); assert.equal(opts.timeoutMs, 12000);
    return response(f.id);
  } };
  const result = await extract.completeMemory(client, 'test-model', f.before, f.resolved, '看看林伯的手', usages);
  assert.equal(calls, 1); assert.equal(result.accepted, 1);
  assert.equal(f.resolved.state.npcProfiles[f.id].traits.appearance.右手, '一道浅红的旧疤');
  assert.deepEqual(f.resolved.state.npcProfiles[f.id].original, original.original);
  assert.deepEqual(f.resolved.state.npcProfiles[f.id].initial, original.initial);
  assert.equal(f.resolved.result.narration, narration);
  assert.deepEqual(f.resolved.result.applied, { state_diff: { 体魄: 0 } });
  assert.deepEqual(f.resolved.result.scene, { draw: false });
  assert.deepEqual(usages, [{ prompt_tokens: 30, completion_tokens: 20 }]);
  assert(!JSON.stringify(engine.toPublicState(f.resolved.state)).includes('PRIVATE_EXTRACTION_SENTINEL'));
});

test('已有有效公共增量、无相关人物、成人回合与超大输入均不增加调用', async () => {
  let calls = 0; const client = { complete: async () => { calls++; throw Error('不应调用'); } };
  for (const mode of ['valid', 'alone', 'adult', 'oversized', 'invalid']) {
    const f = fixture();
    if (mode === 'valid') f.resolved.result.npc_memory = [{ fields: [{ scope: 'public' }] }];
    if (mode === 'alone') f.resolved.result.narration = '你独自望着窗外的雨。';
    if (mode === 'adult') f.resolved.result.adult = true;
    if (mode === 'oversized') f.resolved.result.narration = '林伯' + '雨'.repeat(10000);
    if (mode === 'invalid') f.resolved.invalid = true;
    assert.equal((await extract.completeMemory(client, 'm', f.before, f.resolved, '', [])).attempted, false);
  }
  assert.equal(calls, 0);
});

test('补档网络或JSON失败不重试、不阻断原回合，也不伪造特征', async () => {
  for (const mode of ['network', 'json']) {
    const f = fixture(); const original = clone(f.resolved); let calls = 0;
    const r = await extract.completeMemory({ complete: async () => {
      calls++; if (mode === 'network') throw Error('offline');
      return { content: 'bad json', usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } }, 'm', f.before, f.resolved, '看林伯', []);
    assert.equal(calls, 1); assert(r.attempted);
    assert.deepEqual(f.resolved, original);
  }
});

test('补档概括值仍被拒绝，不能借机放宽原文证据', async () => {
  const f = fixture(); const result = await extract.completeMemory({ complete: async () =>
    response(f.id, '已经彻底愈合的红色伤口') }, 'm', f.before, f.resolved, '看林伯', []);
  assert.equal(result.status, 'rejected');
  assert.equal(f.resolved.result.npc_memory.length, 0);
  assert.equal(f.resolved.state.npcProfiles[f.id].traits.appearance.右手, '右手裹着绷带');
});

test('补档不能注册候选名单之外的人或改写剧情', async () => {
  const f = fixture(); const result = await extract.completeMemory({ complete: async () => ({
    content: JSON.stringify({ narration: '强制转场', npc_updates: [{ name: '外人', kind: 'interaction',
      evidence: narration, known: { role: '林伯' } }] }),
  }) }, 'm', f.before, f.resolved, '看林伯', []);
  assert.equal(result.accepted, 0);
  assert.equal(Object.keys(f.resolved.state.npcProfiles).length, 1);
  assert.equal(f.resolved.result.narration, narration);
});

test('同一提议中坏标签单独拒绝，不能挡掉有原文依据的新外貌', async () => {
  const f = fixture();
  const r = await extract.completeMemory({ complete: async () => ({ content: JSON.stringify({
    npc_updates: [{ name: '林伯', kind: 'change', evidence: narration,
      known: { traits: { appearance: { 疤痕: '一道浅红的旧疤', 秘密身份: '林伯' } } },
      internal: { motivation: '不能从补档写入' } }],
  }) }) }, 'm', f.before, f.resolved, '看林伯', []);
  assert.equal(r.status, 'partial'); assert.equal(r.accepted, 1); assert.equal(r.rejected, 1);
  const p = f.resolved.state.npcProfiles[f.id];
  assert.equal(p.traits.appearance.疤痕, '一道浅红的旧疤');
  assert.equal(p.traits.appearance.秘密身份, undefined);
  assert.equal(p.internal.motivation, undefined);
  assert.equal(f.resolved.result.narration, narration);
});
