'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatStamp, installLogTimestamps } = require('../src/log-time.js');

const FIXED = () => new Date(2026, 0, 2, 3, 4, 5); // 本地时区：2026-01-02 03:04:05
const PREFIX = `[${formatStamp(FIXED())}] `;

function makeEnv() {
  const out = [];
  const err = [];
  return {
    console: {}, // 每次用全新的目标对象，避免幂等标记跨测试串扰
    stdout: { write: (chunk) => { out.push(chunk); return true; } },
    stderr: { write: (chunk) => { err.push(chunk); return true; } },
    now: FIXED,
    out,
    err,
  };
}

test('formatStamp：本地时区、月日时分秒两位补零', () => {
  assert.equal(formatStamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

test('formatStamp：已是两位数的部分不改动', () => {
  assert.equal(formatStamp(new Date(2026, 10, 12, 13, 14, 15)), '2026-11-12 13:14:15');
});

test('单行：行首恰好一个前缀，其余原样', () => {
  const e = makeEnv();
  const restore = installLogTimestamps(e);
  e.stdout.write('hello world\n');
  restore();
  assert.equal(e.out.join(''), PREFIX + 'hello world\n');
});

test('多行：一次 write 里每个非空行都加前缀，空行不加', () => {
  const e = makeEnv();
  const restore = installLogTimestamps(e);
  e.stdout.write('a\nb\n\nc\n');
  restore();
  assert.equal(e.out.join(''), PREFIX + 'a\n' + PREFIX + 'b\n' + '\n' + PREFIX + 'c\n');
});

test('上行未以 \\n 结尾：下一次 write 首行续接、不再加前缀', () => {
  const e = makeEnv();
  const restore = installLogTimestamps(e);
  e.stdout.write('a');   // 不以换行结尾
  e.stdout.write('b\n'); // 首行是上一行的续接
  e.stdout.write('c\n'); // 新行，重新加前缀
  restore();
  assert.equal(e.out.join(''), PREFIX + 'ab\n' + PREFIX + 'c\n');
});

test('Buffer 原样写、不加前缀', () => {
  const e = makeEnv();
  const restore = installLogTimestamps(e);
  const buf = Buffer.from('raw\nbytes');
  e.stdout.write(buf);
  restore();
  assert.equal(e.out.length, 1);
  assert.ok(Buffer.isBuffer(e.out[0]));
  assert.equal(e.out[0].toString('utf8'), 'raw\nbytes');
});

test('非字符串（Uint8Array）原样写、不加前缀', () => {
  const e = makeEnv();
  const restore = installLogTimestamps(e);
  const u = new Uint8Array([104, 105]);
  e.stdout.write(u);
  restore();
  assert.equal(e.out.length, 1);
  assert.strictEqual(e.out[0], u);
});

test('stderr（console.warn/error 走这里）同样加前缀', () => {
  const e = makeEnv();
  const restore = installLogTimestamps(e);
  e.stderr.write('warned\n');
  restore();
  assert.equal(e.err.join(''), PREFIX + 'warned\n');
});

test('重复安装幂等：不会加两层前缀', () => {
  const e = makeEnv();
  const r1 = installLogTimestamps(e);
  const r2 = installLogTimestamps(e);
  assert.equal(r1, r2);
  e.stdout.write('hello\n');
  r1();
  assert.equal(e.out.join(''), PREFIX + 'hello\n');
  assert.ok(!e.out.join('').includes(PREFIX + PREFIX));
});

test('restore：恢复原 write，之后输出无前缀，且可重新安装', () => {
  const e = makeEnv();
  const orig = e.stdout.write;
  const restore = installLogTimestamps(e);
  assert.notEqual(e.stdout.write, orig);
  restore();
  assert.equal(e.stdout.write, orig);
  e.stdout.write('plain\n');
  const r2 = installLogTimestamps(e);
  e.stdout.write('again\n');
  r2();
  assert.equal(e.out.join(''), 'plain\n' + PREFIX + 'again\n');
});

test('集成：console.log/info/warn/error 每行恰好一个前缀', () => {
  const root = path.join(__dirname, '..');
  const script = [
    "const { installLogTimestamps } = require('./src/log-time.js');",
    'installLogTimestamps({ now: () => new Date(2026, 0, 2, 3, 4, 5) });',
    "console.log('hello');",
    "console.info('info');",
    "console.warn('warned');",
    "console.error('errored');",
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(PREFIX + 'hello\n'));
  assert.ok(r.stdout.includes(PREFIX + 'info\n'));
  assert.ok(r.stderr.includes(PREFIX + 'warned\n'));
  assert.ok(r.stderr.includes(PREFIX + 'errored\n'));
  assert.ok(!(r.stdout + r.stderr).includes(PREFIX + PREFIX)); // 没有重复前缀
});

test('server.js：在 require.main 块的第一行调用 installLogTimestamps', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const marker = 'if (require.main === module) {';
  const idx = src.indexOf(marker);
  assert.ok(idx >= 0, '找不到 require.main 块');
  const firstStmt = src.slice(idx + marker.length)
    .split('\n').find((l) => l.trim().length > 0).trim();
  assert.match(firstStmt, /installLogTimestamps\(\)/);
  assert.match(firstStmt, /log-time\.js/);
});
