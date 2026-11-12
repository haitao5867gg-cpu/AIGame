'use strict';

// 成人模式：按世界走单独网关、单独记 token、未成年 × 性内容过滤、建世界 / 进世界的门禁。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const llm = require('../src/llm.js');
const game = require('../src/game.js');
const context = require('../src/context.js');
const prefs = require('../src/prefs.js');
const adult = require('../src/adult-mode.js');
const { req, asGuest, loginGuest, withServer, postStream, parseSSE } = require('./helpers/api-helpers.js');

const ADULT_KEY = 'xpl_TEST-ADULT-KEY-DO-NOT-LEAK';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-adult-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function usageRows(dataDir) {
  return store.readJsonl(store.usagePath(dataDir));
}

// ---- 过滤 ----

test('过滤：玩家输入里「未成年 + 性内容」或性化的未成年称呼会被拦下', () => {
  assert.equal(adult.inputCrossesLine('和那个十四岁的女孩做爱'), true);
  assert.equal(adult.inputCrossesLine('去找小学生脱光衣服'), true);
  assert.equal(adult.inputCrossesLine('来一个萝莉'), true);
  assert.equal(adult.inputCrossesLine('loli 世界'), true);
  assert.equal(adult.inputCrossesLine('芳龄十六的侍女侍寝'), true);
});

test('过滤：常见的成年人 / 非性表达不误伤', () => {
  assert.equal(adult.inputCrossesLine('和二十岁的老板娘做爱'), false);
  assert.equal(adult.inputCrossesLine('十八岁生日那晚和她云雨'), false);
  assert.equal(adult.inputCrossesLine('芳龄十八的侍女'), false);
  assert.equal(adult.inputCrossesLine('活了三百岁的狐妖'), false);
  assert.equal(adult.inputCrossesLine('孩子们在街上跑，我去孤儿院看看'), false);
  assert.equal(adult.inputCrossesLine('赤裸裸的威胁，我拔刀砍翻了他'), false);
  assert.equal(adult.inputCrossesLine(''), false);
});

test('过滤：正文按段查，同段 / 相邻段才算；整节露骨时全文任何地方提到未成年都算', () => {
  const adultScene = '她解开衣带，两人在烛光下云雨。\n\n窗外起了风。';
  assert.equal(adult.proseCrossesLine(adultScene), false);
  assert.equal(adult.proseCrossesLine('那个十二岁的孩子站在门口。\n她解开衣带，两人云雨。'), true);
  // 相隔很远、性内容不明显：不拦
  assert.equal(adult.proseCrossesLine('街上有儿童在放风筝。\n\n茶馆里人声鼎沸。\n\n酒过三巡。\n\n夜深后两人云雨一番。'), false);
  // 整节露骨（≥3 处）且全文提到未成年：拦
  const explicit = '街上有儿童在放风筝。\n\n茶馆里人声鼎沸。\n\n酒过三巡。\n\n她褪下衣衫露出酥胸，两人交合，抽插良久。';
  assert.equal(adult.proseCrossesLine(explicit), true);
});

test('过滤：只对成人模式世界生效；世界设定按字段查', () => {
  const normal = { adultMode: false };
  const adultWorld = { adultMode: true };
  assert.doesNotThrow(() => adult.assertInputAllowed(normal, '和十四岁的女孩做爱'));
  assert.throws(() => adult.assertInputAllowed(adultWorld, '和十四岁的女孩做爱'), (e) => e.status === 422 && e.expose === true);
  assert.throws(() => adult.assertProseAllowed(adultWorld, '十四岁的她和他云雨。'), (e) => e.status === 422);
  assert.equal(adult.worldCrossesLine({ npcs: [{ name: '甲', desc: '孤儿院的孩童' }, { name: '乙', desc: '青楼头牌，擅长云雨之事' }] }), false);
  assert.equal(adult.worldCrossesLine({ npcs: [{ name: '丙', desc: '十三岁的侍寝丫鬟' }] }), true);
  assert.throws(() => adult.assertSeedAllowed(['萝莉养成世界']), (e) => e.status === 422);
});

test('提示词：成人模式规则追加到第一条 system 末尾，不改入参；没有 system 就补一条', () => {
  const msgs = [{ role: 'system', content: '你是作者。' }, { role: 'user', content: '写' }];
  const out = adult.withPolicy(msgs);
  assert.equal(msgs[0].content, '你是作者。');
  assert.ok(out[0].content.startsWith('你是作者。'));
  assert.ok(out[0].content.includes('【成人模式】'));
  assert.ok(out[0].content.includes('未成年'));
  const out2 = adult.withPolicy([{ role: 'user', content: 'x' }]);
  assert.equal(out2[0].role, 'system');
  assert.ok(out2[0].content.includes('【成人模式】'));
});

// ---- llm 路由（真实 HTTP，用本地假网关）----

function startFakeGateways(t) {
  const calls = [];
  const server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const json = JSON.parse(body || '{}');
      calls.push({ url: rq.url, auth: rq.headers.authorization || '', body: json });
      if (json.stream) {
        rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
        rs.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' } }] }) + '\n\n');
        rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '正文一段。' } }] }) + '\n\n');
        rs.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }) + '\n\n');
        rs.end('data: [DONE]\n\n');
        return;
      }
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((r) => server.close(r)));
      resolve({ base: `http://127.0.0.1:${server.address().port}`, calls });
    });
  });
}

function realCfg(gw, dataDir, extra) {
  return env.load(path.join(dataDir, 'none.env'), Object.assign({
    LLM_MOCK: '0',
    LLM_BASE: gw.base + '/friend',
    LLM_API_KEY: 'sk-friend',
    LLM_EXTRA_BODY: '{"friend_only":true}',
    ADULT_LLM_BASE: gw.base + '/explabs',
    EXPLABS_API_KEY: ADULT_KEY,
    DATA_DIR: dataDir,
  }, extra || {}));
}

test('llm：成人模式路由换网关 / Key / 模型，追加规则，默认关思考；普通调用不受影响', async (t) => {
  const gw = await startFakeGateways(t);
  const dataDir = tmpDir(t);
  const client = llm.createClient(realCfg(gw, dataDir), dataDir);
  const messages = [{ role: 'system', content: '系统' }, { role: 'user', content: '你好' }];

  await client.complete({ purpose: 'turn', model: 'deepseek-v4.1-flash', messages });
  await context.run({ playerId: 'host', llmRoute: 'adult' }, () => client.complete({
    purpose: 'turn', model: 'deepseek-v4.1-flash', messages, extraBody: { reasoning_effort: 'low', thinking: { type: 'enabled' } },
  }));
  await context.run({ playerId: 'host', llmRoute: 'adult' }, () => client.complete({ purpose: 'suggest', messages }));
  // 显式 route:null 压过上下文：成人模式请求里顺带处理的普通世界出图翻译仍走默认网关
  await context.run({ llmRoute: 'adult' }, () => client.complete({ purpose: 'turn', messages, route: null }));

  assert.equal(gw.calls.length, 4);
  const [plain, fine, bare, forced] = gw.calls;
  assert.equal(plain.url, '/friend/chat/completions');
  assert.equal(plain.auth, 'Bearer sk-friend');
  assert.equal(plain.body.model, 'deepseek-v4.1-flash');
  assert.equal(plain.body.friend_only, true);
  assert.equal(plain.body.messages[0].content, '系统');

  assert.equal(fine.url, '/explabs/chat/completions');
  assert.equal(fine.auth, `Bearer ${ADULT_KEY}`);
  assert.equal(fine.body.model, 'deepseek-v4.1-flash-uncensored');
  assert.equal(fine.body.friend_only, undefined, '普通网关的 LLM_EXTRA_BODY 不带到成人模式');
  assert.equal(fine.body.reasoning_effort, 'low');
  assert.deepEqual(fine.body.thinking, { type: 'enabled' });
  assert.ok(fine.body.messages[0].content.includes('【成人模式】'));

  assert.deepEqual(bare.body.thinking, { type: 'disabled' }, '没指定思考参数时默认关思考');
  assert.equal(forced.url, '/friend/chat/completions');

  const rows = usageRows(dataDir);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].route, undefined);
  assert.equal(rows[1].route, 'adult');
  assert.equal(rows[1].model, 'deepseek-v4.1-flash-uncensored');
  assert.equal(rows[3].route, undefined);
  assert.equal(JSON.stringify(rows).includes(ADULT_KEY), false, '用量记录不含 Key');
});

test('llm：成人模式流式照常回调正文和思考进度，用量记到成人模式账上', async (t) => {
  const gw = await startFakeGateways(t);
  const dataDir = tmpDir(t);
  const client = llm.createClient(realCfg(gw, dataDir), dataDir);
  const deltas = [];
  let thinking = 0;
  const r = await context.run({ playerId: 'host', llmRoute: 'adult' }, () => client.completeStream({
    purpose: 'story', plainText: true, messages: [{ role: 'user', content: '写' }],
    onThinking: (n) => { thinking = n; },
  }, (d) => deltas.push(d)));
  assert.equal(r.content, '正文一段。');
  assert.equal(deltas.join(''), '正文一段。');
  assert.ok(thinking > 0);
  assert.equal(gw.calls[0].body.stream, true);
  assert.equal(gw.calls[0].url, '/explabs/chat/completions');
  const rows = usageRows(dataDir);
  assert.equal(rows[0].route, 'adult');
  assert.equal(rows[0].prompt_tokens, 11);
});

test('llm：没配 EXPLABS_API_KEY 时成人模式调用报 503，不碰普通网关', async (t) => {
  const gw = await startFakeGateways(t);
  const dataDir = tmpDir(t);
  const client = llm.createClient(realCfg(gw, dataDir, { EXPLABS_API_KEY: '' }), dataDir);
  await assert.rejects(
    context.run({ llmRoute: 'adult' }, () => client.complete({ purpose: 'turn', messages: [] })),
    (e) => e.status === 503 && /EXPLABS_API_KEY/.test(e.message),
  );
  assert.equal(gw.calls.length, 0);
  assert.equal(adult.isConfigured(realCfg(gw, dataDir, { EXPLABS_API_KEY: '' })), false);
  assert.equal(adult.isConfigured(realCfg(gw, dataDir)), true);
});

test('llm：两本账各自的每日上限互不占用', async (t) => {
  const dataDir = tmpDir(t);
  const now = Date.now();
  fs.writeFileSync(store.usagePath(dataDir), [
    { ts: now - 1000, model: 'm', purpose: 'turn', prompt_tokens: 900, completion_tokens: 100, ok: true },
    { ts: now - 1000, model: 'a', purpose: 'turn', prompt_tokens: 40, completion_tokens: 10, ok: true, route: 'adult', playerId: 'p1' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const cfg = env.load(path.join(dataDir, 'none.env'), {
    LLM_MOCK: '1', DATA_DIR: dataDir, LLM_DAILY_TOKEN_LIMIT: '1000', ADULT_LLM_DAILY_TOKEN_LIMIT: '100',
    ADULT_LLM_PLAYER_DAILY_TOKEN_LIMIT: '50',
  });
  const client = llm.createClient(cfg, dataDir);
  // 默认网关已满 → 普通调用 429，成人模式照常
  await assert.rejects(client.complete({ purpose: 'turn', messages: [] }), (e) => e.status === 429);
  await context.run({ playerId: 'host', llmRoute: 'adult' }, () => client.complete({ purpose: 'turn', messages: [] }));
  // 来客 p1 的成人模式用量已到 50 → 他 429；主人不受每人上限约束
  await assert.rejects(
    context.run({ playerId: 'p1', llmRoute: 'adult' }, () => client.complete({ purpose: 'turn', messages: [] })),
    (e) => e.status === 429 && /成人模式/.test(e.message),
  );
  const u = client.usageToday(now);
  assert.equal(u.tokens.total, 1000, '今日对话 token 只算默认网关');
  const a = client.adultUsageToday(now);
  assert.ok(a.tokens.total > 50);
  assert.equal(a.tokens.limit, 100);
  assert.equal(a.model, 'deepseek-v4.1-flash-uncensored');
  assert.equal(client.adultUsageToday(now, 'p1').tokens.total, 50);
  const players = llm.summarizePlayers(usageRows(dataDir), now);
  const p1 = players.find((p) => p.id === 'p1');
  assert.equal(p1.total, 0);
  assert.equal(p1.adult, 50);
});

// ---- game ----

function makeGame(t) {
  const dataDir = tmpDir(t);
  const cfg = env.load(path.join(dataDir, 'none.env'), { LLM_MOCK: '1', DATA_DIR: dataDir, NARRATIVE_STYLE: 'v2' });
  return { g: game.createGame(cfg, dataDir), dataDir, cfg };
}

test('game：成人模式世界带 adultMode，回合全走成人模式账；行动越线直接 422、不调模型', async (t) => {
  const { g, dataDir } = makeGame(t);
  const w = await context.run({ playerId: 'host', llmRoute: 'adult' }, () => g.buildWorld({ seed: '欲望都市', adultMode: true }));
  assert.equal(w.adultMode, true);
  assert.equal(adult.worldRoute(dataDir, w.id), 'adult');
  const before = usageRows(dataDir).length;
  assert.ok(usageRows(dataDir).every((r) => r.route === 'adult'));

  await assert.rejects(
    context.run({ playerId: 'host', llmRoute: 'adult' }, () => g.takeTurn(w.id, { action: '找个十四岁的女孩做爱' })),
    (e) => e.status === 422,
  );
  assert.equal(usageRows(dataDir).length, before, '越线行动不调模型');

  const res = await context.run({ playerId: 'host', llmRoute: 'adult' }, () => g.takeTurn(w.id, { action: '去酒吧坐坐' }));
  assert.equal(res.state.turn, 1);
  const rows = usageRows(dataDir);
  assert.ok(rows.length > before);
  assert.ok(rows.every((r) => r.route === 'adult'));
});

test('game：普通世界不带 adultMode，同样的行动不被成人模式过滤拦', async (t) => {
  const { g, dataDir } = makeGame(t);
  const w = await context.run({ playerId: 'host' }, () => g.buildWorld({ seed: '江湖' }));
  assert.equal(w.adultMode, undefined);
  assert.equal(adult.worldRoute(dataDir, w.id), null);
  const res = await context.run({ playerId: 'host' }, () => g.takeTurn(w.id, { action: '找个十四岁的女孩做爱' }));
  assert.equal(res.state.turn, 1);
  assert.ok(usageRows(dataDir).every((r) => r.route === undefined));
});

test('game：成人模式世界设定 / 世界观越线时建世界失败', async (t) => {
  const { g } = makeGame(t);
  await assert.rejects(g.buildWorld({ seed: '萝莉后宫', adultMode: true }), (e) => e.status === 422);
  await assert.rejects(g.buildWorld({ seed: '后宫', identity: '十五岁的侍寝丫鬟', adultMode: true }), (e) => e.status === 422);
});

// ---- HTTP ----

test('HTTP：建成人模式世界要确认 18 岁；建好后列表标 adultMode，回合用量记到成人模式账上', async () => {
  await withServer(async ({ base, dataDir }) => {
    let r = await req(base, 'GET', '/api/me');
    assert.deepEqual(r.json.adultMode, { configured: true, allowed: true });
    r = await req(base, 'GET', '/api/health');
    assert.equal(r.json.adultMode, true);

    r = await req(base, 'POST', '/api/worlds', { seed: '夜色', adultMode: true });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /18/);

    r = await req(base, 'POST', '/api/worlds', { seed: '夜色', adultMode: true, confirm18: true });
    assert.equal(r.status, 201, r.text);
    const id = r.json.id;
    assert.equal(r.json.adultMode, true);

    r = await req(base, 'POST', '/api/worlds', { seed: '白昼', adultMode: 'yes', confirm18: true });
    assert.equal(r.status, 201);
    const plainId = r.json.id;
    assert.notEqual(r.json.adultMode, true, '只有布尔 true 才算选了成人模式');

    r = await req(base, 'GET', '/api/worlds');
    const list = Object.fromEntries(r.json.map((w) => [w.id, w]));
    assert.equal(list[id].adultMode, true);
    assert.equal(list[plainId].adultMode, false);

    const before = usageRows(dataDir).length;
    const sr = await postStream(base, id, { action: '去酒吧坐坐' });
    const evs = parseSSE(await sr.text());
    assert.ok(evs.some((e) => e.event === 'result'), JSON.stringify(evs.slice(-1)));
    const after = usageRows(dataDir).slice(before).filter((x) => x.purpose); // 只看 LLM 记录（出图记录没有 purpose）
    assert.ok(after.length > 0);
    assert.ok(after.every((x) => x.route === 'adult'));

    r = await req(base, 'POST', `/api/worlds/${plainId}/turn`, { action: '散步' });
    assert.equal(r.status, 200, r.text);
    assert.ok(usageRows(dataDir).filter((x) => x.purpose).slice(-1)[0].route === undefined);

    r = await req(base, 'GET', '/api/usage/today');
    assert.ok(r.json.adult.tokens.total > 0);
    assert.equal(r.json.adult.configured, true);
    assert.equal(r.json.adult.model, 'deepseek-v4.1-flash-uncensored');
    const host = r.json.players.find((p) => p.id === 'host');
    assert.ok(host.adult > 0);
    assert.equal(r.text.includes('EXPLABS_API_KEY'), false);

    // 越线行动：流式返回 error，不落库
    const turnBefore = (await req(base, 'GET', `/api/worlds/${id}`)).json.turn;
    const bad = parseSSE(await (await postStream(base, id, { action: '和十四岁的女孩做爱' })).text());
    assert.equal(bad.slice(-1)[0].event, 'error');
    assert.match(JSON.parse(bad.slice(-1)[0].data).error, /未成年/);
    assert.equal((await req(base, 'GET', `/api/worlds/${id}`)).json.turn, turnBefore);
  });
});

test('HTTP：来客在主人没开总开关时不能建 / 进成人模式世界；开了就可以', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cookie = await loginGuest(base, dataDir, '阿甲');
    let r = await req(base, 'GET', '/api/me', undefined, asGuest(cookie));
    assert.deepEqual(r.json.adultMode, { configured: true, allowed: false });
    r = await req(base, 'POST', '/api/worlds', { seed: '夜色', adultMode: true, confirm18: true }, asGuest(cookie));
    assert.equal(r.status, 403);

    prefs.setGlobalAdultAllowed(dataDir, true);
    r = await req(base, 'POST', '/api/worlds', { seed: '夜色', adultMode: true, confirm18: true }, asGuest(cookie));
    assert.equal(r.status, 201, r.text);
    const id = r.json.id;
    r = await req(base, 'GET', `/api/worlds/${id}`, undefined, asGuest(cookie));
    assert.equal(r.status, 200);

    prefs.setGlobalAdultAllowed(dataDir, false);
    r = await req(base, 'GET', `/api/worlds/${id}`, undefined, asGuest(cookie));
    assert.equal(r.status, 403);
    r = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '散步' }, asGuest(cookie));
    assert.equal(r.status, 403);
  });
});

test('HTTP：网关没配好时不能建成人模式世界，新世界页也不显示选项', async () => {
  await withServer(async ({ base }) => {
    let r = await req(base, 'GET', '/api/me');
    assert.equal(r.json.adultMode.configured, false);
    r = await req(base, 'POST', '/api/worlds', { seed: '夜色', adultMode: true, confirm18: true });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /EXPLABS_API_KEY/);
  }, { LLM_MOCK: false, LLM_BASE: 'http://127.0.0.1:9/v1', EXPLABS_API_KEY: '' });
});

// ---- 玩家选的写正文参数（思考强度 / 发挥）----

test('prefs：adultLlm 默认思考低 + 发挥默认，非法值保留原值，只改提交的那一项', (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(prefs.getPrefs(dir, 'host').adultLlm, { effort: 'low', temperature: 'default' });
  let out = prefs.setPrefs(dir, 'host', { adultLlm: { effort: 'max' } });
  assert.deepEqual(out.adultLlm, { effort: 'max', temperature: 'default' });
  out = prefs.setPrefs(dir, 'host', { adultLlm: { effort: 'bogus', temperature: 'free' } });
  assert.deepEqual(out.adultLlm, { effort: 'max', temperature: 'free' });
  assert.deepEqual(prefs.getPrefs(dir, 'p2').adultLlm, { effort: 'low', temperature: 'default' }, '各玩家互不影响');
  assert.equal(prefs.setPrefs(dir, 'host', { scenes: false }).adultLlm, undefined);
});

test('llm：写正文（story）按玩家选的思考强度 / 发挥发参数；记账等其它调用不受影响', async (t) => {
  const gw = await startFakeGateways(t);
  const dataDir = tmpDir(t);
  const client = llm.createClient(realCfg(gw, dataDir), dataDir);
  const msgs = [{ role: 'user', content: '写' }];
  const fine = { thinking: { type: 'enabled' }, reasoning_effort: 'low' };

  prefs.setPrefs(dataDir, 'host', { adultLlm: { effort: 'none', temperature: 'free' } });
  await context.run({ playerId: 'host', llmRoute: 'adult' }, () => client.completeStream({
    purpose: 'story', plainText: true, messages: msgs, extraBody: fine,
  }, () => {}));
  prefs.setPrefs(dataDir, 'host', { adultLlm: { effort: 'max', temperature: 'steady' } });
  await context.run({ playerId: 'host', llmRoute: 'adult' }, () => client.completeStream({
    purpose: 'story', plainText: true, messages: msgs, extraBody: fine,
  }, () => {}));
  await context.run({ playerId: 'host', llmRoute: 'adult' }, () => client.complete({
    purpose: 'ledger', messages: msgs, extraBody: { thinking: { type: 'disabled' }, reasoning_effort: null },
  }));
  // 普通世界写正文：不碰成人模式设置
  await context.run({ playerId: 'host' }, () => client.completeStream({
    purpose: 'story', plainText: true, messages: msgs, extraBody: fine,
  }, () => {}));

  const [off, max, ledger, plain] = gw.calls.map((c) => c.body);
  assert.deepEqual(off.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in off, false);
  assert.equal(off.temperature, 1.2);
  assert.deepEqual(max.thinking, { type: 'enabled' });
  assert.equal(max.reasoning_effort, 'max');
  assert.equal(max.temperature, 0.7);
  assert.deepEqual(ledger.thinking, { type: 'disabled' });
  assert.equal('temperature' in ledger, false);
  assert.equal(plain.reasoning_effort, 'low');
  assert.equal('temperature' in plain, false);
});

test('HTTP：/api/prefs 能存 adultLlm，/api/me 带回', async () => {
  await withServer(async ({ base }) => {
    let r = await req(base, 'POST', '/api/prefs', { adultLlm: { effort: 'high', temperature: 'steady' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.prefs.adultLlm, { effort: 'high', temperature: 'steady' });
    r = await req(base, 'GET', '/api/me');
    assert.deepEqual(r.json.prefs.adultLlm, { effort: 'high', temperature: 'steady' });
  });
});
