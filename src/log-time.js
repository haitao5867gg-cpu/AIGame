'use strict';

// 给服务器日志的每一行加本地时间戳。
// 验证（.logs/probe-console.js）：console.log/info 走 process.stdout.write，
// console.warn/error 走 process.stderr.write。因此只包 stdout/stderr.write，
// 不单独包 console.*，这样所有 console 输出都恰好带一个前缀。

const MARK = Symbol('installLogTimestamps');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

// 把一段字符串按行加前缀。atLineStart 表示当前写位置是否处于行首
//（上一次 write 以 \n 结尾，或尚未写过）。返回新文本与新的行首状态。
function stampString(s, prefix, atLineStart) {
  const parts = s.split('\n');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const atStart = i === 0 ? atLineStart : true; // 前一个 \n 之后总是新行
    if (atStart && seg.length > 0) out += prefix; // 只在非空行行首加
    out += seg;
    if (i < parts.length - 1) out += '\n';
  }
  return { text: out, atLineStart: s.endsWith('\n') };
}

function wrapWrite(orig, now) {
  let atLineStart = true;
  return function wrappedWrite(chunk, ...rest) {
    if (typeof chunk !== 'string') {
      // Buffer 或非字符串原样写；Buffer 末尾是否换行会影响后续行首判断。
      if (Buffer.isBuffer(chunk) && chunk.length > 0) {
        atLineStart = chunk[chunk.length - 1] === 0x0a;
      }
      return orig.call(this, chunk, ...rest);
    }
    if (chunk.length === 0) return orig.call(this, chunk, ...rest);
    const prefix = `[${formatStamp(now())}] `;
    const res = stampString(chunk, prefix, atLineStart);
    atLineStart = res.atLineStart;
    return orig.call(this, res.text, ...rest);
  };
}

function installLogTimestamps(opts = {}) {
  const targetConsole = opts.console || console;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const now = opts.now || (() => new Date());

  // 幂等：已安装则直接返回既有 restore，避免加两层前缀。
  const existing = targetConsole[MARK] || stdout[MARK] || stderr[MARK];
  if (existing) return existing;

  const origStdoutWrite = stdout.write;
  const origStderrWrite = stderr.write;
  const wrappedStdout = wrapWrite(origStdoutWrite, now);
  const wrappedStderr = wrapWrite(origStderrWrite, now);
  stdout.write = wrappedStdout;
  stderr.write = wrappedStderr;

  function restore() {
    stdout.write = origStdoutWrite;
    stderr.write = origStderrWrite;
    delete targetConsole[MARK];
    delete stdout[MARK];
    delete stderr[MARK];
  }

  targetConsole[MARK] = restore;
  stdout[MARK] = restore;
  stderr[MARK] = restore;
  return restore;
}

module.exports = { formatStamp, installLogTimestamps };
