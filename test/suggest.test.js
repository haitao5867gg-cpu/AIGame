'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const prompts = require('../src/prompts.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');
const { withServer, req, asGuest, loginGuest } = require('./helpers/api-helpers.js');

// 带各种内部字段的 state：断言 buildSuggestMessages 只取玩家已看到的信息。
function makePromptState() {
  return {
    bible: {
      title: '测试世界标题',
      tone: '苍凉基调',
      rules: ['RULES_SENTINEL'],
      npcs: [{ name: '守夜人', want: 'NPC_WANT_SENTINEL', desc: 'NPC_DESC_SENTINEL' }],
      start: { place: '灰烬港', situation: 'SITUATION_SENTINEL' },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯'] },
    npcAttitude: {}, persona: {},
    location: '灰烬港',
    clock: { day: 2, period: '黄昏' },
    recent: [{ turn: 1, action: '行动一', narration: 'RECENT_NARR_SENTINEL' }],
    apex: { hint: 'APEX_SENTINEL' },
    turn: 3,
  };
}

// 每个测试独立临时 DATA_DIR + LLM_MOCK=1；可注入一个 purpose=suggest 的假 client，
// 其余 purpose（建世界等）仍走真实 mock，绝不发起真实模型调用。
function makeGame(t, fakeSuggestions) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-suggest-game-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  process.env.LLM_API_KEY = 'sk-SUGGEST-TEST';
  const cfg = env.getConfig();
  const dataDir = env.resolveDataDir(cfg);
  let g;
  if (fakeSuggestions) {
    const orig = llm.createClient;
    llm.createClient = function (...args) {
      const c = orig.apply(this, args);
      const real = c.complete;
      c.complete = async (o) => {
        if (o && o.purpose === 'suggest') {
          return {
            content: JSON.stringify({ suggestions: fakeSuggestions() }),
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        return real.call(c, o);
      };
      return c;
    };
    t.after(() => { llm.createClient = orig; });
    g = game.createGame(cfg, dataDir);
    llm.createClient = orig;
  } else {
    g = game.createGame(cfg, dataDir);
  }
  return { g, dataDir, tmp };
}

function buildWorld(g) {
  return g.buildWorld({ seed: '雾里的旧港', name: '旅人', appearance: '灰袍' });
}

// ---- buildSuggestMessages ----
test('buildSuggestMessages：system 含 3 条/JSON/suggestions；user 含标题/地点/最近叙事/avoid', () => {
  const [system, user] = prompts.buildSuggestMessages(makePromptState(), { avoid: ['旧建议一', '旧建议二'] });
  assert.match(system.content, /3 条/);
  assert.match(system.content, /JSON/);
  assert.match(system.content, /suggestions/);
  assert.ok(user.content.includes('测试世界标题'));
  assert.ok(user.content.includes('灰烬港'));
  assert.ok(user.content.includes('RECENT_NARR_SENTINEL'));
  assert.ok(user.content.includes('旧建议一'));
  assert.ok(user.content.includes('旧建议二'));
});

test('buildSuggestMessages：不含 NPC want / rules / apex 等内部信息', () => {
  const [system, user] = prompts.buildSuggestMessages(makePromptState(), { avoid: [] });
  const all = system.content + '\n' + user.content;
  for (const hidden of ['NPC_WANT_SENTINEL', 'NPC_DESC_SENTINEL', 'RULES_SENTINEL', 'APEX_SENTINEL']) {
    assert.ok(!all.includes(hidden), `不应包含内部信息 ${hidden}`);
  }
});

test('buildSuggestMessages：recent 超过 2 条只带最后 2 条，长叙事截到 900 字以内', () => {
  const state = makePromptState();
  const long = 'HEAD_MARKER' + 'X'.repeat(1200) + 'TAIL_MARKER';
  state.recent = [
    { turn: 1, action: 'OLD_ACTION_1', narration: 'OLD_NARR_1' },
    { turn: 2, action: 'OLD_ACTION_2', narration: 'OLD_NARR_2' },
    { turn: 3, action: 'NEW_ACTION_3', narration: long },
    { turn: 4, action: 'NEW_ACTION_4', narration: 'NEW_NARR_4' },
  ];
  const [, user] = prompts.buildSuggestMessages(state, { avoid: [] });
  const text = user.content;
  for (const hidden of ['OLD_ACTION_1', 'OLD_ACTION_2', 'OLD_NARR_1', 'OLD_NARR_2', 'HEAD_MARKER']) {
    assert.ok(!text.includes(hidden), `不应包含 ${hidden}`);
  }
  assert.ok(text.includes('NEW_ACTION_3'));
  assert.ok(text.includes('NEW_ACTION_4'));
  assert.ok(text.includes('NEW_NARR_4'));
  assert.ok(text.includes('TAIL_MARKER'));
  assert.ok(!text.includes('X'.repeat(1000)), '长叙事应被截到 900 字以内');
  assert.ok(text.includes('无'), 'avoid 为空写「无」');
});

test('buildSuggestMessages：无 recent 时回退 bible.start.situation', () => {
  const state = makePromptState();
  state.recent = [];
  const [, user] = prompts.buildSuggestMessages(state, { avoid: [] });
  assert.ok(user.content.includes('SITUATION_SENTINEL'));
});

// ---- mockSuggest（经 LLM_MOCK 的 client.complete，绝不联网）----
function mockClient(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-suggest-llm-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  return llm.createClient(env.getConfig(), tmp);
}

async function mockSuggest(client, avoid, turn) {
  const res = await client.complete({
    purpose: llm.PURPOSES.SUGGEST,
    model: 'm',
    messages: [],
    mock: { avoid, turn },
  });
  return JSON.parse(res.content).suggestions;
}

test('mockSuggest：同输入同输出、正好 3 条、avoid 里的条目不出现', async (t) => {
  const client = mockClient(t);
  const a = await mockSuggest(client, ['先四下看看，找条退路', '顺着声音摸过去看看'], 3);
  const b = await mockSuggest(client, ['先四下看看，找条退路', '顺着声音摸过去看看'], 3);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3, '3 条应互不相同');
  assert.ok(!a.includes('先四下看看，找条退路'));
  assert.ok(!a.includes('顺着声音摸过去看看'));
});

test('mockSuggest：avoid 不同时结果不同', async (t) => {
  const client = mockClient(t);
  const base = await mockSuggest(client, [], 1);
  // 把 base 的第一条放进 avoid：它被排除后结果必然与 base 不同。
  const changed = await mockSuggest(client, [base[0]], 1);
  assert.notDeepEqual(changed, base);
  assert.equal(changed.length, 3);
});

// ---- suggestActions ----
test('suggestActions：LLM_MOCK 下正常返回 1~3 条，同输入稳定', async (t) => {
  const { g } = makeGame(t);
  const w = await buildWorld(g);
  const r = await g.suggestActions(w.id, { avoid: [] });
  assert.ok(Array.isArray(r.suggestions));
  assert.ok(r.suggestions.length >= 1 && r.suggestions.length <= 3);
  const r2 = await g.suggestActions(w.id, { avoid: [] });
  assert.deepEqual(r2.suggestions, r.suggestions);
});

test('suggestActions：清洗序号/引号/人称/句号/重复/avoid/非字符串/超长，最多 3 条', async (t) => {
  let box = null;
  const { g } = makeGame(t, () => box);
  const w = await buildWorld(g);
  const id = w.id;

  box = [
    '  旧建议甲  ',          // trim 后与 avoid 完全相同 → 去掉
    null,                    // 非字符串 → 去掉
    42,                      // 非字符串 → 去掉
    '  1. 大胆冲上去看看  ',  // 序号 → 大胆冲上去看看
    '“你上前搭话”。',         // 引号 + 你 + 句号 → 上前搭话
    '大胆冲上去看看',          // 重复 → 去掉
    '- 先退到暗处观察。',      // 项目符号 + 句号 → 先退到暗处观察
    '多余第四条',             // 超过 3 条 → 去掉
  ];
  let r = await g.suggestActions(id, { avoid: ['旧建议甲'] });
  assert.deepEqual(r.suggestions, ['大胆冲上去看看', '上前搭话', '先退到暗处观察']);

  box = [
    '我' + 'Y'.repeat(100),  // 去掉「我」开头 → 截到 60 字
    '“绕到侧门看看”',         // 引号 → 绕到侧门看看
    '顺着声音摸过去。',        // 句号 → 顺着声音摸过去
  ];
  r = await g.suggestActions(id, {});
  assert.equal(r.suggestions[0], 'Y'.repeat(60), '超长应截到 60 字');
  assert.equal(r.suggestions[0].length, 60);
  assert.deepEqual(r.suggestions.slice(1), ['绕到侧门看看', '顺着声音摸过去']);
});

test('suggestActions：结果全被过滤时抛 502', async (t) => {
  const box = [null, 42, '   ', '旧建议甲'];
  const { g } = makeGame(t, () => box);
  const w = await buildWorld(g);
  await assert.rejects(
    () => g.suggestActions(w.id, { avoid: ['旧建议甲'] }),
    (err) => err.status === 502 && /再点一次/.test(err.message),
  );
});

test('suggestActions：世界不存在抛 404', async (t) => {
  const { g } = makeGame(t);
  await assert.rejects(
    () => g.suggestActions('no-such-world', {}),
    (err) => err.status === 404 && /世界不存在/.test(err.message),
  );
});

test('suggestActions：等待重生时抛 409', async (t) => {
  const { g, dataDir } = makeGame(t);
  const w = await buildWorld(g);
  const raw = store.loadWorld(dataDir, w.id);
  raw.awaitingRebirth = true;
  store.saveWorld(dataDir, raw);
  await assert.rejects(
    () => g.suggestActions(w.id, {}),
    (err) => err.status === 409 && /新的一世/.test(err.message),
  );
});

test('suggestActions：只读，调用后 state.json 内容不变', async (t) => {
  const { g, dataDir } = makeGame(t);
  const w = await buildWorld(g);
  const statePath = store.statePath(dataDir, w.id);
  const before = fs.readFileSync(statePath, 'utf8');
  await g.suggestActions(w.id, { avoid: ['甲'] });
  const after = fs.readFileSync(statePath, 'utf8');
  assert.equal(after, before);
});

test('用量：mock 下调用一次 suggestActions 后 usage 多一条 purpose=suggest 记录', async (t) => {
  const { g, dataDir } = makeGame(t);
  const w = await buildWorld(g);
  const rows = () => store.readJsonl(store.usagePath(dataDir)).filter((r) => r.purpose === 'suggest');
  const before = rows().length;
  await g.suggestActions(w.id, {});
  assert.equal(rows().length, before + 1);
});

// ---- toPublicLogRecord ----
test('toPublicLogRecord：applied.suggestions 有值时带 suggestions（最多 3 条、只留字符串）', () => {
  const pub = game.toPublicLogRecord({
    turn: 1, life: 1, action: 'a', narration: 'n',
    applied: { suggestions: ['甲', '乙', '丙', '丁', 123, null] }, ts: 1,
  });
  assert.deepEqual(pub.suggestions, ['甲', '乙', '丙']);
});

test('toPublicLogRecord：applied.suggestions 缺失 / 非数组时不带该字段', () => {
  const base = { turn: 1, life: 1, action: 'a', narration: 'n', applied: {}, ts: 1 };
  assert.equal('suggestions' in game.toPublicLogRecord(base), false);
  const bad = game.toPublicLogRecord(Object.assign({}, base, { applied: { suggestions: 'x' } }));
  assert.equal('suggestions' in bad, false);
});

// ---- HTTP ----
test('HTTP：POST /api/worlds/:id/suggest 返回 200 和 suggestions；GET 405；别人的世界 404', async () => {
  await withServer(async ({ base, dataDir }) => {
    let r = await req(base, 'POST', '/api/worlds', { seed: '灵感测试世界', name: '旅人', appearance: '灰袍' });
    assert.equal(r.status, 201, r.text);
    const id = r.json.id;

    r = await req(base, 'POST', `/api/worlds/${id}/suggest`, { avoid: [] });
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.suggestions));
    assert.ok(r.json.suggestions.length >= 1 && r.json.suggestions.length <= 3);

    r = await req(base, 'GET', `/api/worlds/${id}/suggest`);
    assert.equal(r.status, 405, r.text);

    const cookieB = await loginGuest(base, dataDir, '乙');
    r = await req(base, 'POST', `/api/worlds/${id}/suggest`, { avoid: [] }, asGuest(cookieB));
    assert.equal(r.status, 404, r.text);
    assert.deepEqual(r.json, { error: '世界不存在' });
  });
});
