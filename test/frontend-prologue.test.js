'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
const jsFiles = fs.readdirSync(path.join(root, 'js'))
  .filter((f) => f.endsWith('.js'))
  .sort();
// 拼接整页文本（index.html + app.css + 所有 public/js），与 frontend.test.js 同法。
const html = [
  fs.readFileSync(path.join(root, 'index.html'), 'utf8'),
  '<style>\n' + fs.readFileSync(path.join(root, 'app.css'), 'utf8') + '\n</style>',
  ...jsFiles.map((f) => '<script>\n' + fs.readFileSync(path.join(root, 'js', f), 'utf8') + '\n</script>'),
].join('\n');
// 仅 public/js，用于检查是否新增 innerHTML。
const js = jsFiles.map((f) => fs.readFileSync(path.join(root, 'js', f), 'utf8')).join('\n');

const prologueSrc = fs.readFileSync(path.join(root, 'js', 'prologue.js'), 'utf8');
const gameSrc = fs.readFileSync(path.join(root, 'js', 'game.js'), 'utf8');

// 截出函数体，做「在某函数内」的精确判断。
function bodyOf(src, startSig, endSig) {
  const i = src.indexOf(startSig);
  assert.ok(i >= 0, '应存在 ' + startSig);
  const j = endSig ? src.indexOf(endSig, i + startSig.length) : src.length;
  return src.slice(i, j < 0 ? src.length : j);
}

test('序章：index.html 在 game.js 之前引入 /js/prologue.js', () => {
  const p = html.indexOf('<script src="/js/prologue.js"></script>');
  const g = html.indexOf('<script src="/js/game.js"></script>');
  assert.ok(p >= 0, '应引入 /js/prologue.js');
  assert.ok(g >= 0, '应引入 /js/game.js');
  assert.ok(p < g, 'prologue.js 应在 game.js 之前');
});

test('序章：showPrologue 含四段小标题与「开始」按钮', () => {
  assert.ok(/function showPrologue\(title, prologue, onStart, opts\)/.test(prologueSrc), '应有 showPrologue');
  for (const h of ['这个世界', '你是谁', '你想要的', '此刻']) {
    assert.ok(prologueSrc.includes(h), '应含小标题「' + h + '」');
  }
  assert.ok(/'开始'/.test(prologueSrc), '应有「开始」按钮');
  assert.ok(/'继续'/.test(prologueSrc), '重看应显示「继续」');
});

test('序章：showGame 按 state.turn === 0 与 prologueSeen 判断首次弹出，localStorage 读写在 try 内', () => {
  const sg = bodyOf(gameSrc, 'async function showGame', 'function renderHeader');
  assert.ok(/state\.turn === 0/.test(sg), '首次弹出应要求 state.turn === 0');
  assert.ok(/'prologueSeen:'/.test(sg), '应使用 localStorage 键 prologueSeen:');
  assert.ok(/showPrologue\(/.test(sg), 'showGame 应调用 showPrologue');
  assert.ok(/try\s*\{[^}]*localStorage\.getItem/s.test(sg), 'localStorage 读应在 try 内');
  assert.ok(/try\s*\{[^}]*localStorage\.setItem/s.test(sg), 'localStorage 写应在 try 内');
});

test('序章：有请求 /prologue 的代码，renderPanel 里有「序章」入口', () => {
  assert.ok(/'\/prologue'/.test(html), '应有请求 /prologue 的代码');
  const rp = bodyOf(gameSrc, 'function renderPanel', 'function showDeath');
  assert.ok(/序章/.test(rp), 'renderPanel 里应有「序章」入口');
  assert.ok(/btn tiny/.test(rp), '入口应使用 .btn.tiny');
  assert.ok(/'\/prologue'/.test(rp), 'renderPanel 无 prologue 时应请求 /prologue');
});

test('序章：public/js 未新增 innerHTML', () => {
  assert.equal(/\.innerHTML/.test(js), false, 'public/js 不得出现 .innerHTML 拼接');
});
