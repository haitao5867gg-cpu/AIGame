'use strict';

// 建世界等待弹窗：服务器记进度（步骤、已写字数、预计耗时），前端轮询画进度条；
// 同一个 clientRequestId 只建一个世界（手机断网后重发不会建出两个）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createBuildProgress, recordStats, expectFor, stageKeys, DEFAULT_EXPECT } = require('../src/build-progress.js');
const { req, withServer } = require('./helpers/api-helpers.js');

const pub = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-bp-')); }

test('tracker：步骤推进、字数只增不减、完成后给出各步耗时', () => {
  let t = 1000;
  const bp = createBuildProgress({ now: () => t });
  const dir = tmpDir();
  try {
    bp.start('p:c1', dir, true);
    let s = bp.snapshot('p:c1');
    assert.deepEqual(s.stages.map((x) => x.key), ['prepare', 'world', 'outline', 'save']);
    assert.equal(s.stage, 'prepare');
    assert.equal(s.stageIndex, 0);
    assert.equal(s.stages[1].expectMs, DEFAULT_EXPECT.world.ms, '没有统计时用默认值');
    t += 500;
    bp.stage('p:c1', 'world');
    t += 1000;
    bp.progress('p:c1', { chars: 300, think: 40 });
    bp.progress('p:c1', { chars: 200, think: 10 });
    s = bp.snapshot('p:c1');
    assert.equal(s.stage, 'world');
    assert.equal(s.stageIndex, 1);
    assert.equal(s.chars, 300, '字数只增不减');
    assert.equal(s.think, 40);
    assert.equal(s.activityAt, 2500);
    assert.equal(s.now, 2500);
    t += 2000;
    bp.stage('p:c1', 'outline');
    assert.equal(bp.snapshot('p:c1').chars, 0, '换步骤字数清零');
    bp.stage('p:c1', 'nope');
    assert.equal(bp.snapshot('p:c1').stage, 'outline', '不认识的步骤忽略');
    t += 3000;
    bp.stage('p:c1', 'save');
    t += 100;
    const timings = bp.finish('p:c1', 'w42');
    assert.deepEqual(timings.world, { ms: 3000, chars: 300 });
    assert.equal(timings.outline.ms, 3000);
    assert.equal(timings.save.ms, 100);
    s = bp.snapshot('p:c1');
    assert.equal(s.done, true);
    assert.equal(s.worldId, 'w42');
    bp.progress('p:c1', { chars: 9999 });
    assert.equal(bp.snapshot('p:c1').chars, 0, '完成后不再记进度');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tracker：失败记原因；不认识的 key 给 null；30 分钟后忘掉；没大纲时三步', () => {
  let t = 0;
  const bp = createBuildProgress({ now: () => t });
  const dir = tmpDir();
  try {
    bp.start('p:c2', dir, false);
    assert.deepEqual(bp.snapshot('p:c2').stages.map((x) => x.key), ['prepare', 'world', 'save']);
    bp.fail('p:c2', '模型挂了');
    assert.equal(bp.snapshot('p:c2').error, '模型挂了');
    assert.equal(bp.snapshot('p:zz'), null);
    t += 31 * 60 * 1000;
    assert.equal(bp.snapshot('p:c2'), null, '过期');
    assert.deepEqual(stageKeys(true), ['prepare', 'world', 'outline', 'save']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('统计：至少 3 次记录才用中位数；只留最近 20 次', () => {
  const dir = tmpDir();
  try {
    recordStats(dir, { world: { ms: 9000, chars: 1000 } });
    recordStats(dir, { world: { ms: 11000, chars: 2000 } });
    assert.equal(expectFor(dir, ['world']).world.ms, DEFAULT_EXPECT.world.ms, '2 次不够');
    recordStats(dir, { world: { ms: 30000, chars: 3000 } });
    const e = expectFor(dir, ['world', 'outline']);
    assert.equal(e.world.ms, 11000, '中位数');
    assert.equal(e.world.chars, 2000);
    assert.equal(e.outline.ms, DEFAULT_EXPECT.outline.ms, '没有大纲记录用默认值');
    for (let i = 0; i < 25; i++) recordStats(dir, { world: { ms: 5000, chars: 800 } });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'build-stats.json'), 'utf8'));
    assert.equal(raw.length, 20);
    assert.equal(expectFor(dir, ['world']).world.ms, 5000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 前端进度计算（vm 执行 build-modal.js 里的纯函数）
function loadMath() {
  const sb = { document: {}, el() { return {}; }, setInterval() { return 0; }, clearInterval() {} };
  vm.createContext(sb);
  vm.runInContext(pub('js/build-modal.js'), sb, { filename: 'build-modal.js' });
  return sb;
}
function snapAt(stageIndex, stageElapsed, extra) {
  return Object.assign({
    stages: [
      { key: 'prepare', expectMs: 600, expectChars: 0 },
      { key: 'world', expectMs: 14000, expectChars: 2200 },
      { key: 'outline', expectMs: 27000, expectChars: 3800 },
      { key: 'save', expectMs: 600, expectChars: 0 },
    ],
    stageIndex: stageIndex, now: 100000, startedAt: 100000 - stageElapsed - 1000,
    stageStartedAt: 100000 - stageElapsed, activityAt: 100000, chars: 0, think: 0, done: false,
  }, extra || {});
}

test('进度计算：按时间推进、只在完成时到 100%、按字数修正、超时给「说不准」', () => {
  const { buildProgressMath: m, formatEta } = loadMath();
  const a = m(snapAt(1, 0), 0);
  const b = m(snapAt(1, 7000), 0);
  const c = m(snapAt(1, 7000), 3000);
  assert.ok(a.frac > 0 && a.frac < b.frac && b.frac < c.frac, '随时间增长（本地时间也算）');
  assert.ok(b.etaMs < a.etaMs, '剩余时间减少');
  const late = m(snapAt(2, 600000), 0);
  assert.ok(late.frac < 1, '没完成不到 100%');
  assert.equal(late.overrun, true);
  assert.equal(late.etaMs, null, '慢很多又没写字：不报具体时间');
  const writing = m(snapAt(1, 3000, { chars: 1650 }), 0);
  assert.ok(writing.stageFrac >= 0.74, '字数 3/4 时这一步至少 74%');
  assert.equal(m(snapAt(3, 0, { done: true }), 0).frac, 1);
  assert.equal(m(snapAt(3, 0, { done: true }), 0).etaMs, 0);
  const idle = m(snapAt(1, 5000, { activityAt: 70000 }), 2000);
  assert.equal(idle.idleMs, 32000, '没动静的时长');
  assert.equal(m({}, 0).frac, 0, '空快照不报错');
  assert.equal(formatEta(null), '比平时久一些，马上就好');
  assert.equal(formatEta(3000), '马上就好');
  assert.equal(formatEta(12000), '预计还要约 12 秒');
  assert.equal(formatEta(43000), '预计还要约 45 秒');
  assert.equal(formatEta(60000), '预计还要约 1 分钟');
  assert.equal(formatEta(95000), '预计还要约 1 分 40 秒');
});

// ---- 接口
test('接口：同一个 clientRequestId 发两次只建一个世界，进度查得到「建好了」', async () => {
  await withServer(async ({ base, dataDir }) => {
    const cid = 'wbuild000001';
    const before = (await req(base, 'GET', '/api/worlds')).json.length;
    const body = { seed: '雨夜旧港', name: '阿岚', clientRequestId: cid };
    const [r1, r2] = await Promise.all([req(base, 'POST', '/api/worlds', body), req(base, 'POST', '/api/worlds', body)]);
    assert.equal(r1.status, 201, r1.text);
    assert.equal(r2.status, 201, r2.text);
    assert.equal(r1.json.id, r2.json.id, '同一个世界');
    assert.equal('clientRequestId' in r1.json, false);
    const after = (await req(base, 'GET', '/api/worlds')).json.length;
    assert.equal(after - before, 1, '只建了一个');
    const r3 = await req(base, 'POST', '/api/worlds', body);
    assert.equal(r3.json.id, r1.json.id, '建好后再发也给同一个');
    const p = await req(base, 'GET', '/api/build-progress?cid=' + cid);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.done, true);
    assert.equal(p.json.worldId, r1.json.id);
    assert.ok(Array.isArray(p.json.stages) && p.json.stages.length >= 3);
    assert.ok(p.json.stages.every((s) => s.label && s.expectMs > 0));
    const stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'build-stats.json'), 'utf8'));
    assert.equal(stats.length, 1, '成功一次记一次耗时');
    assert.ok(stats[0].world && stats[0].world.ms >= 0);
    // 不带 ID：照旧每次都建
    const r4 = await req(base, 'POST', '/api/worlds', { seed: '雨夜旧港' });
    assert.equal(r4.status, 201);
    assert.notEqual(r4.json.id, r1.json.id);
  });
});

test('接口：建世界途中能查到进行中的步骤和已写字数', async () => {
  const prev = process.env.LLM_MOCK_DELAY_MS;
  process.env.LLM_MOCK_DELAY_MS = '400';
  try {
    await withServer(async ({ base }) => {
      const cid = 'wbuild000002';
      const pending = req(base, 'POST', '/api/worlds', { seed: '雪山古寺', clientRequestId: cid });
      let seen = null;
      for (let i = 0; i < 40 && !seen; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const p = await req(base, 'GET', '/api/build-progress?cid=' + cid);
        if (p.status === 200 && !p.json.done && p.json.stage === 'world' && p.json.chars > 0) seen = p.json;
      }
      const r = await pending;
      assert.equal(r.status, 201, r.text);
      assert.ok(seen, '途中应能看到「构思世界」且已写字数 > 0');
      assert.equal(seen.stageIndex, 1);
      assert.ok(seen.now >= seen.stageStartedAt);
    });
  } finally {
    if (prev === undefined) delete process.env.LLM_MOCK_DELAY_MS; else process.env.LLM_MOCK_DELAY_MS = prev;
  }
});

test('接口：进度查询 cid 不合法 400，不认识 404', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await req(base, 'GET', '/api/build-progress?cid=bad')).status, 400);
    const r = await req(base, 'GET', '/api/build-progress?cid=wunknown0001');
    assert.equal(r.status, 404);
    assert.equal(r.json.code, 'build_unknown');
  });
});

// ---- 静态检查
test('页面：弹窗脚本在 home.js 之后加载；createWorld 带 ID、开弹窗、轮询进度、断网同 ID 重发', () => {
  const html = pub('index.html');
  const home = pub('js/home.js');
  assert.ok(html.indexOf('/js/build-modal.js') > html.indexOf('/js/home.js'));
  assert.match(home, /body\.clientRequestId = cid/);
  assert.match(home, /BuildModal\.open\(seed\)/);
  assert.match(home, /\/api\/build-progress\?cid=/);
  assert.match(home, /err\.status >= 520 && err\.status <= 524/);
  assert.doesNotMatch(home, /findNewWorld/, '靠 ID 防重后不再按列表猜新世界');
});

test('样式：遮罩盖住整页；手机顶栏不用 backdrop-filter（否则「用量」面板被困成顶上一条）', () => {
  const css = pub('app.css');
  assert.match(css, /\.build-mask\{position:fixed;inset:0;z-index:200/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\s*\.build-mask\{animation:none\}/);
  const mobileHead = css.match(/body\[data-genre\] \.game-head,body\.atmosphere-background\[data-genre\] \.game-head\{background:rgba\(var\(--g-tint\),\.96\);\s*-webkit-backdrop-filter:none;backdrop-filter:none;/);
  assert.ok(mobileHead, '手机顶栏 backdrop-filter:none');
  // 顶栏里的规则（.game-head 自身）在手机媒体查询里不得再有 blur
  assert.doesNotMatch(css, /\.game-head\{[^}]*backdrop-filter:blur/);
});

// ---- 建世界走流式时的保险
test('流式：带 idleTimeoutMs 时流停住会中止并报 504；不带时不受影响', async (t) => {
  const llm = require('../src/llm.js');
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const first = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"name":"雾' } }] }) + '\n\n';
  global.fetch = async (url, opts) => ({
    ok: true,
    body: (async function* () {
      yield new Uint8Array(Buffer.from(first, 'utf8'));
      // 之后一直不来新数据，直到被中止。
      await new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    })(),
  });
  const client = llm.createClient({
    LLM_MOCK: false, LLM_BASE: 'https://example.test/v1', LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'm', LLM_TIMEOUT_MS: 5000, LLM_DAILY_TOKEN_LIMIT: 0, LLM_EXTRA_BODY: '',
  }, dir);
  const seen = [];
  const t0 = Date.now();
  await assert.rejects(client.completeStream({
    purpose: 'world', model: 'm', messages: [{ role: 'user', content: 'hi' }], responseFormat: 'json_object',
    idleTimeoutMs: 150, onProgress: (p) => seen.push(p.chars),
  }, null), (err) => err.status === 504 && /停住/.test(err.message));
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(seen.length >= 1 && seen[0] > 0, '停住之前的字数也报告过');
});

test('建世界：流式出错时退回非流式照样建成；用量超限直接报错', async (t) => {
  const llm = require('../src/llm.js');
  const env = require('../src/env.js');
  const game = require('../src/game.js');
  const tmp = tmpDir();
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  process.env.LLM_MOCK = '1';
  process.env.DATA_DIR = tmp;
  const cfg = env.getConfig();
  const orig = llm.createClient;
  let mode = 'fail';
  const calls = [];
  llm.createClient = function (...args) {
    const client = orig.apply(this, args);
    const stream = client.completeStream;
    const complete = client.complete;
    client.completeStream = function (opts, ...rest) {
      calls.push('stream:' + opts.purpose);
      if (opts && opts.onProgress) {
        if (mode === 'fail') return Promise.reject(Object.assign(new Error('网关不支持流式'), { status: 502 }));
        if (mode === 'limit') return Promise.reject(Object.assign(new Error('今日 token 用量已达上限'), { status: 429, expose: true }));
      }
      return stream.call(this, opts, ...rest);
    };
    client.complete = function (opts, ...rest) {
      calls.push('plain:' + opts.purpose);
      return complete.call(this, opts, ...rest);
    };
    return client;
  };
  t.after(() => { llm.createClient = orig; });
  const g = game.createGame(cfg, env.resolveDataDir(cfg));
  const stages = [];
  const w = await g.buildWorld({ seed: '雨夜旧港' }, { onStage: (k) => stages.push(k), onProgress: () => {} });
  assert.ok(w && w.id, '照样建成');
  assert.ok(calls.includes('stream:world') && calls.includes('plain:world'), '流式失败后走了非流式');
  assert.equal(stages[0], 'world');
  assert.equal(stages[stages.length - 1], 'save');
  mode = 'limit';
  await assert.rejects(g.buildWorld({ seed: '雨夜旧港' }, { onProgress: () => {} }), (err) => err.status === 429);
});
