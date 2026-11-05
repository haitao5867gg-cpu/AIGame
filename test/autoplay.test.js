'use strict';

// autoplay 冒烟测试：LLM_MOCK=1 起服务到随机端口，跑 5 回合，断言产出三个文件。
// 用 spawn（异步）跑 autoplay，避免 spawnSync 阻塞事件循环导致服务无法响应。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const env = require('../src/env.js');
const { createHttpServer } = require('../server.js');

const ROOT = path.join(__dirname, '..');

function runAutoplay(args, childEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('autoplay 超时\n' + output));
    }, 60000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('autoplay mock 冒烟：5 回合产出三个文件', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-autoplay-'));
  const dataDir = path.join(tmp, 'data');
  const outDir = path.join(tmp, 'report');

  const childEnv = Object.assign({}, process.env, {
    LLM_MOCK: '1',
    DATA_DIR: dataDir,
    PORT: '0',
    HOST: '127.0.0.1',
  });
  const cfg = env.load(path.join(ROOT, '.env'), childEnv);
  const server = createHttpServer(cfg);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(resolve);
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const { code, output } = await runAutoplay([
    path.join(ROOT, 'scripts', 'autoplay.js'),
    '--base', base,
    '--seed', '雾港与永不熄灭的钟声',
    '--turns', '5',
    '--out', outDir,
  ], childEnv);
  assert.equal(code, 0, `autoplay 应正常退出，输出：\n${output}`);

  const turnsPath = path.join(outDir, 'turns.jsonl');
  const reviewPath = path.join(outDir, 'review.json');
  const summaryPath = path.join(outDir, 'summary.md');
  for (const p of [turnsPath, reviewPath, summaryPath]) {
    assert.ok(fs.existsSync(p), `应产出 ${path.basename(p)}，输出：\n${output}`);
  }

  const rows = fs.readFileSync(turnsPath, 'utf8').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 5, 'turns.jsonl 应有 5 行');
  assert.ok(rows.every((r) => typeof r.action === 'string' && r.action.length > 0));
  assert.ok(rows.every((r) => typeof r.narration === 'string'));
  assert.ok(rows.every((r) => Number.isFinite(r.ms)));
  assert.ok(rows.every((r) => 'applied' in r && 'death' in r && 'settlement_tier' in r));

  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  assert.ok(Array.isArray(review.top5_improvements));
  assert.ok(Array.isArray(review.contradictions));
  assert.ok(Array.isArray(review.guardrail_failures));

  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /总回合：5/);
  assert.match(summary, /token 用量/);
});
