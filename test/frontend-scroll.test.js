'use strict';

// 回合定位：新回合停在本回合开头而不是页面底部（静态检查源文件文本，不执行 DOM）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const gameJs = read('js/game.js');
const mainJs = read('js/main.js');
const css = read('app.css');
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));

// 从 fromStr 抽到 toStr（不含）之间的源码片段，用于把检查限定在某个函数体里。
function section(src, fromStr, toStr) {
  const i = src.indexOf(fromStr);
  assert.ok(i >= 0, '应能定位 ' + fromStr);
  const j = toStr ? src.indexOf(toStr, i + fromStr.length) : src.length;
  assert.ok(j > i, '应能定位 ' + toStr + '（在 ' + fromStr + ' 之后）');
  return src.slice(i, j);
}

const actBody = section(gameJs, 'function appendActionLine(action) {', 'function appendDivider');
const deltaBody = section(gameJs, 'function appendStreamDelta(block, text) {', 'function appendNarration(text, badges, sceneId) {');
const resultBody = section(gameJs, 'function renderResult(res) {', 'async function sendAction() {');
const showBody = section(gameJs, 'async function showGame(id) {', 'function renderHeader(s) {');
const undoBody = section(gameJs, 'async function doUndo() {', '// ---- 游戏页 ----');
const vvBody = section(mainJs, "visualViewport.addEventListener('resize'", '// 输入框最多约 4 行自动增高');

test('前端滚动：有 scrollToTurnStart，手机整页滚动 / 电脑 #stream 内滚动、behavior smooth', () => {
  assert.match(gameJs, /function scrollToTurnStart\s*\(/, '应有 scrollToTurnStart 函数');
  assert.match(gameJs, /behavior\s*:\s*'smooth'/, '应平滑滚动');
  assert.match(gameJs, /scrollIntoView\(\{\s*behavior\s*:\s*'smooth'\s*,\s*block\s*:\s*'start'\s*\}\)/,
    '手机用 scrollIntoView 对齐可视区顶部');
  assert.match(gameJs, /s\.scrollTo\(\{[\s\S]*?scrollTop[\s\S]*?behavior\s*:\s*'smooth'/,
    '电脑在 #stream 内部滚动对齐');
});

test('前端滚动：appendStreamDelta 不再调用 scrollBottom，流式期间不自动滚动', () => {
  assert.ok(!/scrollBottom\s*\(/.test(deltaBody), 'appendStreamDelta 不应调用 scrollBottom');
  assert.ok(!/scrollToTurnStart\s*\(/.test(deltaBody), '流式期间也不应自动定位');
});

test('前端滚动：appendActionLine 和 renderResult 都使用 scrollToTurnStart', () => {
  assert.match(actBody, /scrollToTurnStart\s*\(/, 'appendActionLine 应定位到本回合行动行');
  assert.match(resultBody, /scrollToTurnStart\s*\(/, 'renderResult 应定位到本回合开头');
});

test('前端滚动：进入世界滚到最新回合开头，撤回后定位保持现状（仍滚到底）', () => {
  assert.match(showBody, /scrollToTurnStart\s*\(/, 'showGame 应滚到最新回合开头');
  assert.ok(!/scrollBottom\s*\(/.test(showBody), 'showGame 不再滚到页面最底');
  assert.match(undoBody, /scrollBottom\s*\(/, '撤回后仍滚到底（定位保持现状）');
});

test('前端滚动：main.js 的 visualViewport 处理不再调用 scrollBottom，仍保证输入框可见', () => {
  assert.ok(!/scrollBottom\s*\(/.test(vvBody), 'resize 不应把叙事滚到底');
  assert.match(vvBody, /scrollIntoView\(\{\s*block\s*:\s*'end'\s*\}\)/,
    '保留 ai.scrollIntoView({block:"end"})');
});

test('前端滚动：app.css 有 scroll-margin-top（sticky 顶栏高度 + 8px）', () => {
  assert.ok(/scroll-margin-top/.test(css), '应有 scroll-margin-top');
  assert.ok(/--head-h/.test(css), '应有顶栏高度变量');
  assert.ok(/\+\s*8px/.test(css), '应在顶栏高度之外再留 8px');
});

test('前端滚动：手机 #stream 底部按 --composer-h 留白，避免输入区挡住正文最后一段', () => {
  assert.ok(/--composer-h/.test(css), '应定义 --composer-h');
  assert.match(css, /padding-bottom\s*:\s*calc\(\s*var\(--composer-h\)/,
    '#stream 底部留白应与输入区高度相当');
});

test('前端滚动：.scene-frame 用 aspect-ratio 16/9 预留高度，图片加载不改变阅读位置', () => {
  assert.match(css, /\.scene-frame\{[^}]*aspect-ratio\s*:\s*16\/9/, '插图框应预留 16/9 高度');
});

test('前端滚动：public/js 无新增 innerHTML', () => {
  for (const f of jsFiles) {
    assert.ok(!/\.innerHTML/.test(read('js/' + f)), f + ' 不得出现 .innerHTML');
  }
});
