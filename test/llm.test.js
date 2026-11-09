'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const llm = require('../src/llm.js');
const context = require('../src/context.js');

function seedUsage(dir, rows) {
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-llm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseCfg(overrides) {
  return Object.assign({
    LLM_MOCK: false,
    LLM_BASE: 'https://example.test/v1',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'test-model',
    LLM_TIMEOUT_MS: 5000,
    LLM_DAILY_TOKEN_LIMIT: 0,
    LLM_EXTRA_BODY: '',
  }, overrides || {});
}

// 拦截全局 fetch：记录请求体，返回合法的 chat/completions 响应，执行 fn 后返回记录。
async function captureFetch(t, fn) {
  const original = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":1}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    };
  };
  t.after(() => { global.fetch = original; });
  await fn();
  return captured;
}

function stubWarn(t) {
  const original = console.warn;
  const warns = [];
  console.warn = (msg) => warns.push(String(msg));
  t.after(() => { console.warn = original; });
  return warns;
}

test('人物补档可单独限制输出，且计入正常模型用量', async (t) => {
  const dir = tmpDir(t);
  const c = llm.createClient(baseCfg({ LLM_EXTRA_BODY: '{"max_tokens":9999}' }), dir);
  const captured = await captureFetch(t, () => c.complete({ purpose: 'npc_memory',
    messages: [{ role: 'user', content: '摘录' }], maxTokens: 1500, timeoutMs: 1000 }));
  assert.equal(captured.body.max_tokens, 1500);
  const usage = JSON.parse(fs.readFileSync(path.join(dir, 'usage.jsonl'), 'utf8').trim());
  assert.equal(usage.purpose, 'npc_memory');
  assert.equal(usage.prompt_tokens, 2);
});

test('短补档超时覆盖响应体读取，不能等到全局长超时', async (t) => {
  const dir = tmpDir(t), original = global.fetch;
  global.fetch = async (_, opts) => ({ ok: true, json: () => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }) });
  t.after(() => { global.fetch = original; });
  const c = llm.createClient(baseCfg({ LLM_TIMEOUT_MS: 5000 }), dir);
  const start = Date.now();
  await assert.rejects(c.complete({ purpose: 'npc_memory', messages: [], timeoutMs: 25 }), /JSON|超时/);
  assert(Date.now() - start < 1000);
});

test('parseExtraBody: 合法 JSON 对象、空值、解析失败 / 非对象时忽略并告警', (t) => {
  assert.deepEqual(llm.parseExtraBody(''), {});
  assert.deepEqual(llm.parseExtraBody(null), {});
  assert.deepEqual(llm.parseExtraBody('   '), {});
  assert.deepEqual(llm.parseExtraBody('{"thinking":{"type":"disabled"}}'), { thinking: { type: 'disabled' } });

  const warns = stubWarn(t);
  for (const bad of ['{bad json', '[1,2]', '42', '"str"', 'null', 'true']) {
    assert.deepEqual(llm.parseExtraBody(bad), {}, `应忽略：${bad}`);
  }
  assert.ok(warns.length >= 6, '非法值应逐条告警');
  assert.ok(warns.every((w) => w.includes('LLM_EXTRA_BODY')));
});

test('LLM_EXTRA_BODY: 合并进请求体，但 model/messages/response_format 不被覆盖', async (t) => {
  const cfg = baseCfg({
    LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"temperature":0.5,"model":"hacked"}',
  });
  const client = llm.createClient(cfg, tmpDir(t));
  const captured = await captureFetch(t, async () => {
    await client.complete({
      purpose: 'turn',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: 'json_object',
    });
  });
  const body = captured.body;
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0.5);
  assert.equal(body.model, 'test-model', '外部不能覆盖 model');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.ok(captured.url.endsWith('/chat/completions'));
});

test('LLM_EXTRA_BODY: 解析失败时请求体不带多余键，仍能正常完成调用', async (t) => {
  const warns = stubWarn(t);
  const cfg = baseCfg({ LLM_EXTRA_BODY: '{非法 json' });
  const client = llm.createClient(cfg, tmpDir(t));
  let res;
  const captured = await captureFetch(t, async () => {
    res = await client.complete({
      purpose: 'turn', model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
  assert.equal(res.ok, true);
  assert.equal(res.content, '{"ok":1}');
  assert.equal('thinking' in captured.body, false);
  assert.equal(Object.keys(captured.body).sort().join(','), 'messages,model,response_format');
  assert.ok(warns.some((w) => w.includes('解析失败')));
});

test('LLM_EXTRA_BODY: 未设置时请求体只有标准字段，不产生告警', async (t) => {
  const warns = stubWarn(t);
  const cfg = baseCfg();
  delete cfg.LLM_EXTRA_BODY;
  const client = llm.createClient(cfg, tmpDir(t));
  const captured = await captureFetch(t, async () => {
    await client.complete({ purpose: 'turn', model: 'test-model', messages: [] });
  });
  assert.equal(Object.keys(captured.body).sort().join(','), 'messages,model,response_format');
  assert.equal(warns.length, 0);
});

test('mock 模式不发起网络请求，parseExtraBody 仍可用', async (t) => {
  const cfg = baseCfg({ LLM_MOCK: true, LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' });
  const client = llm.createClient(cfg, tmpDir(t));
  const res = await client.complete({ purpose: 'turn', model: 'm', messages: [], mock: { turn: 1 } });
  assert.equal(res.ok, true);
  assert.equal(typeof res.content, 'string');
  assert.deepEqual(llm.parseExtraBody('{"a":1}'), { a: 1 });
});

test('mock 数据覆盖新字段：mockWorld 每个 npc 带 ≤20 字且互不相同的 voice', async (t) => {
  const cfg = baseCfg({ LLM_MOCK: true });
  const client = llm.createClient(cfg, tmpDir(t));
  const w = await client.complete({
    purpose: 'world', model: 'm', messages: [], mock: { seed: '雾港' },
  });
  const npcs = JSON.parse(w.content).bible.npcs;
  assert.ok(Array.isArray(npcs) && npcs.length >= 2);
  const voices = npcs.map((n) => n.voice);
  assert.ok(voices.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 20),
    'voice 应为 ≤20 字非空字符串');
  assert.equal(new Set(voices).size, voices.length, 'voice 必须彼此不同');
});

test('mock 数据覆盖新字段：rebirth 目的返回 150~300 字「新一世开场」', async (t) => {
  const cfg = baseCfg({ LLM_MOCK: true });
  const client = llm.createClient(cfg, tmpDir(t));
  const r = await client.complete({
    purpose: llm.PURPOSES.REBIRTH, model: 'm', messages: [], mock: { life: 3, name: '三世旅人' },
  });
  const out = JSON.parse(r.content);
  assert.equal(typeof out.opening, 'string');
  assert.ok(out.opening.length >= 150 && out.opening.length <= 300,
    `开场应在 150~300 字，实际 ${out.opening.length}`);
  assert.ok(out.opening.includes('三世旅人'));
  assert.equal(llm.PURPOSES.REBIRTH, 'rebirth');
});

test('mock 数据覆盖新字段：mockWorld 带 start.facts、mockTurn 带 overstep 布尔', async (t) => {
  const cfg = baseCfg({ LLM_MOCK: true });
  const client = llm.createClient(cfg, tmpDir(t));
  const w = await client.complete({
    purpose: 'world', model: 'm', messages: [], mock: { seed: '满月诅咒的王国' },
  });
  const wb = JSON.parse(w.content).bible;
  assert.ok(Array.isArray(wb.start.facts), 'start.facts 应为数组');
  assert.ok(wb.start.facts.length >= 2 && wb.start.facts.length <= 3, '给 2~3 条开局事实');
  assert.ok(wb.start.facts.every((f) => typeof f === 'string' && f.length > 0 && f.length <= 30));
  assert.ok(wb.start.facts.some((f) => f.includes('满月')), '应含关键时间事实（满月）');

  const t7 = await client.complete({ purpose: 'turn', model: 'm', messages: [], mock: { turn: 7 } });
  assert.equal(JSON.parse(t7.content).overstep, true, '约每 7 回合模拟一次越界');
  const t8 = await client.complete({ purpose: 'turn', model: 'm', messages: [], mock: { turn: 8 } });
  assert.equal(JSON.parse(t8.content).overstep, false);
});

// ---- 每人每日 token 上限 ----
test('summarizeToday：按 playerId 只统计该玩家 token/出图，无 playerId 记录算 host；不传保持全局', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0).getTime();
  const day = 24 * 3600 * 1000;
  const rows = [
    { ts: now - 1000, prompt_tokens: 10, completion_tokens: 2, playerId: 'pA', ok: true },
    { ts: now - 2000, prompt_tokens: 5, completion_tokens: 1, playerId: 'pB', ok: true },
    { ts: now - 3000, prompt_tokens: 7, completion_tokens: 3, ok: true },           // 无 playerId → host
    { ts: now - 4000, prompt_tokens: 100, completion_tokens: 100, ok: true },        // 无 playerId → host
    { ts: now - 2 * day, prompt_tokens: 999, completion_tokens: 999, playerId: 'pA', ok: true }, // 昨天
    { ts: now - 5000, kind: 'image', provider: 'local', ok: true, playerId: 'pA' },
    { ts: now - 6000, kind: 'image', provider: 'local', ok: false },                // 无 playerId → host
  ];

  const a = llm.summarizeToday(rows, now, 100, 'pA');
  assert.deepEqual(a.tokens, { prompt: 10, completion: 2, total: 12, limit: 100, remaining: 88 });
  assert.deepEqual(a.images.total, { ok: 1, fail: 0 });

  const b = llm.summarizeToday(rows, now, 100, 'pB');
  assert.deepEqual(b.tokens, { prompt: 5, completion: 1, total: 6, limit: 100, remaining: 94 });
  assert.deepEqual(b.images.total, { ok: 0, fail: 0 });

  const h = llm.summarizeToday(rows, now, 100, 'host');
  assert.deepEqual(h.tokens, { prompt: 107, completion: 103, total: 210, limit: 100, remaining: 0 });
  assert.deepEqual(h.images.total, { ok: 0, fail: 1 });

  // 不传 playerId：保持原行为（全局、含所有玩家）
  const all = llm.summarizeToday(rows, now, 100);
  assert.deepEqual(all.tokens, { prompt: 122, completion: 106, total: 228, limit: 100, remaining: 0 });
  assert.deepEqual(all.images.total, { ok: 1, fail: 1 });
});

test('summarizePlayers：今日每个玩家按 total 降序、含 host、无 playerId 记录算 host', () => {
  const now = new Date(2026, 10, 5, 12, 0, 0).getTime();
  const rows = [
    { ts: now - 1000, prompt_tokens: 30, completion_tokens: 0, playerId: 'pA' },
    { ts: now - 2000, prompt_tokens: 10, completion_tokens: 0, playerId: 'pB' },
    { ts: now - 3000, prompt_tokens: 20, completion_tokens: 0 },                 // → host
    { ts: now - 25 * 3600 * 1000, prompt_tokens: 999, completion_tokens: 0, playerId: 'pC' }, // 昨天
  ];
  const out = llm.summarizePlayers(rows, now);
  assert.deepEqual(out.map((p) => p.id), ['pA', 'host', 'pB']);
  assert.deepEqual(out.map((p) => p.total), [30, 20, 10]);
});

test('每人每日上限：当前玩家今日用量达到上限返回 429，其他玩家 / 无玩家身份不受影响', async (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  seedUsage(dir, [
    { ts: now, model: 'm', purpose: 'turn', prompt_tokens: 60, completion_tokens: 0, playerId: 'pA', ok: true },
  ]);
  const cfg = baseCfg({ LLM_MOCK: true, LLM_PLAYER_DAILY_TOKEN_LIMIT: 50 });
  const client = llm.createClient(cfg, dir);

  await context.run({ playerId: 'pA' }, async () => {
    await assert.rejects(
      () => client.complete({ purpose: 'turn', model: 'm', messages: [] }),
      (err) => err.status === 429 && err.expose === true &&
        /你今天的 token 用量已达上限 50，明天再来吧/.test(err.message),
    );
  });
  await context.run({ playerId: 'pB' }, async () => {
    const res = await client.complete({ purpose: 'turn', model: 'm', messages: [] });
    assert.equal(res.ok, true, '别的玩家不受影响');
  });
  const res = await client.complete({ purpose: 'turn', model: 'm', messages: [] });
  assert.equal(res.ok, true, '无玩家身份时也不受每人上限影响');
});

test('每人每日上限：主人（host）不受每人上限约束，只受全局上限', async (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  seedUsage(dir, [
    { ts: now, model: 'm', purpose: 'turn', prompt_tokens: 80, completion_tokens: 0, ok: true }, // 无 playerId
  ]);
  const cfg = baseCfg({ LLM_MOCK: true, LLM_PLAYER_DAILY_TOKEN_LIMIT: 50 });
  const client = llm.createClient(cfg, dir);

  await context.run({ playerId: 'host' }, async () => {
    const r = await client.complete({ purpose: 'turn', model: 'm', messages: [] });
    assert.equal(r.ok, true);
  });
  await context.run({ playerId: 'pX' }, async () => {
    const r = await client.complete({ purpose: 'turn', model: 'm', messages: [] });
    assert.equal(r.ok, true);
  });
});

test('每人每日上限：LLM_PLAYER_DAILY_TOKEN_LIMIT=0 表示不限', async (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  seedUsage(dir, [
    { ts: now, model: 'm', purpose: 'turn', prompt_tokens: 999999, completion_tokens: 0, playerId: 'pA', ok: true },
  ]);
  const cfg = baseCfg({ LLM_MOCK: true, LLM_PLAYER_DAILY_TOKEN_LIMIT: 0 });
  const client = llm.createClient(cfg, dir);
  await context.run({ playerId: 'pA' }, async () => {
    const r = await client.complete({ purpose: 'turn', model: 'm', messages: [] });
    assert.equal(r.ok, true);
  });
});

test('全局每日上限逻辑保留不变：任何人达到全局上限都被拦', async (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  seedUsage(dir, [
    { ts: now, model: 'm', purpose: 'turn', prompt_tokens: 100, completion_tokens: 0, playerId: 'pA', ok: true },
  ]);
  const cfg = baseCfg({ LLM_MOCK: true, LLM_DAILY_TOKEN_LIMIT: 50 });
  const client = llm.createClient(cfg, dir);
  await context.run({ playerId: 'pB' }, async () => {
    await assert.rejects(
      () => client.complete({ purpose: 'turn', model: 'm', messages: [] }),
      (err) => err.status === 429 && /今日 token 用量已达上限 50/.test(err.message),
    );
  });
});

// 第1轮收尾返工：mock 的 npc_updates 证据始终是该分支实际 narration 的连续子串。
test('mockTurn：overstep/event/settlement 分支的 npc_updates 证据始终合法', async (t) => {
  const cfg = baseCfg({ LLM_MOCK: true });
  const client = llm.createClient(cfg, tmpDir(t));
  const cases = [
    { turn: 1 },
    { turn: 1, needEvent: true, theme: '秘境开启' },
    { turn: 1, needEvent: true, needSettlement: true, theme: '天灾' },
    { turn: 5 },
    { turn: 5, needEvent: true, theme: '商路断绝' },
    { turn: 7, needSettlement: true },                        // overstep
    { turn: 7, needEvent: true, needSettlement: true, theme: '古神低语' },
    { turn: 8 },
  ];
  for (const m of cases) {
    const res = await client.complete({ purpose: 'turn', model: 'm', messages: [], mock: m });
    const out = JSON.parse(res.content);
    assert.equal(typeof out.narration, 'string', `turn=${m.turn} 有 narration`);
    const updates = out.npc_updates || [];
    for (const u of updates) {
      assert.ok(out.narration.includes(u.evidence),
        `turn=${m.turn} evidence 必须是该分支最终 narration 的连续子串：${u.evidence}`);
      assert.ok(out.narration.includes(u.name), `turn=${m.turn} 人物须真实出场`);
      const known = u.known || {};
      for (const k of ['role', 'description', 'voice', 'publicGoal', 'relationshipSummary']) {
        if (typeof known[k] === 'string' && known[k]) {
          assert.ok(out.narration.includes(known[k]), `turn=${m.turn} known.${k} 须摘自原文`);
        }
      }
    }
    if (!out.narration.includes('守夜人提灯拦住去路')) {
      assert.deepEqual(updates, [], `turn=${m.turn} 守夜人未出现就不发证据（不自相矛盾）`);
    }
  }
  // 守卫确实按「该分支最终 narration」判断，而不是无条件发固定证据。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/llm.js'), 'utf8');
  assert.match(src, /narration\.includes\(npcEvidence\)/, 'mock 对固定 evidence 有实际 narration 守卫');
});
