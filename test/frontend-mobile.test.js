'use strict';

// 手机端（宽度 ≤ 600px）交互优化：静态检查源文件文本，不执行 DOM / 不请求网络。
// 与 frontend.test.js 同法读取 index.html / app.css / public/js 全部脚本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const css = read('app.css');
const html = read('index.html');
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort();
const js = jsFiles.map((f) => read('js/' + f)).join('\n');

// 抽出所有 @media (max-width:600px) 块的规则体（大括号配对，兼容内嵌规则块）。
function media600Bodies() {
  const re = /@media\s*\(\s*max-width:\s*600px\s*\)\s*\{/g;
  const bodies = [];
  let m;
  while ((m = re.exec(css)) !== null) {
    const start = re.lastIndex;
    let depth = 1, i = start;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    bodies.push(css.slice(start, i - 1));
  }
  return bodies.join('\n');
}
const mb = media600Bodies();

test('手机端：app.css 有 @media (max-width:600px)，桌面 ≥860px 布局保持不变', () => {
  assert.match(css, /@media\s*\(\s*max-width:\s*600px\s*\)/, '应有 ≤600px 媒体查询');
  assert.match(css, /@media\s*\(\s*min-width:\s*860px\s*\)/, '桌面 ≥860px 媒体查询仍保留');
  assert.match(css, /max-height:60vh/, '桌面 .stream 仍保留 60vh 上限');
  assert.ok(mb.length > 0, '应能抽出 ≤600px 规则体');
});

test('手机端：.stream 去掉 max-height 限制、.composer sticky bottom 且带 safe-area', () => {
  assert.match(mb, /\.stream\s*\{[^}]*max-height\s*:\s*none/, '.stream 应 max-height:none（整页自然滚动）');
  assert.match(mb, /\.stream\s*\{[^}]*overflow\s*:\s*visible/, '.stream 应去掉内嵌滚动');
  assert.match(mb, /\.composer\s*\{[^}]*position\s*:\s*sticky/, '.composer 应 sticky');
  assert.match(mb, /\.composer\s*\{[^}]*bottom\s*:\s*0/, '.composer 应 bottom:0');
  assert.match(mb, /env\(\s*safe-area-inset-bottom\s*\)/, '应带 env(safe-area-inset-bottom) 内边距');
  assert.match(mb, /\.composer\s*\{[^}]*background\s*:\s*var\(--bg\)/, '输入区背景应不透明');
});

test('手机端：#action-input 及 input/textarea/select 为 16px，建议按钮单行横滑', () => {
  assert.match(mb, /#action-input[^{]*\{[^}]*font-size\s*:\s*16px/,
    '#action-input / input / textarea / select 应为 16px（防 iOS 聚焦放大）');
  assert.match(mb, /\.suggestions\s*\{[^}]*flex-wrap\s*:\s*nowrap/, '.suggestions 不换行');
  assert.match(mb, /\.suggestions\s*\{[^}]*overflow-x\s*:\s*auto/, '.suggestions 横向滑动');
});

test('手机端：顶栏 sticky 紧凑单行、⋯ 菜单元素齐全、细条横滑、朗读按钮 28px', () => {
  assert.match(mb, /\.game-head\s*\{[^}]*position\s*:\s*sticky/, '顶栏 sticky');
  assert.match(mb, /\.game-head\s*\{[^}]*flex-wrap\s*:\s*nowrap/, '顶栏单行不换行');
  assert.match(mb, /\.game-head-title\s*\{[^}]*text-overflow\s*:\s*ellipsis/, '标题单行省略号');
  assert.match(mb, /\.g-strip\s*\{[^}]*overflow-x\s*:\s*auto/, '地点/属性细条横向滑动');
  assert.match(mb, /\.tts-read-btn\s*\{[^}]*width\s*:\s*28px/, '朗读按钮缩到 28px');
  assert.match(html, /id="btn-more"/, '应有 ⋯ 按钮');
  assert.match(html, /⋯/, '按钮文案为 ⋯');
  assert.match(html, /id="more-menu"/, '应有 ⋯ 菜单元素');
  for (const a of ['usage', 'panel', 'export', 'logout']) {
    assert.ok(html.includes('data-menu="' + a + '"'), '菜单应含 ' + a + ' 项');
  }
  assert.match(html, /id="g-subtitle"/, '应有标题下方小字（第几世/回合）');
});

test('手机端：⋯ 菜单有点击外部关闭的代码', () => {
  assert.match(js, /moreMenu\.contains\(e\.target\)/, '应由点击目标判定是否在菜单内');
  assert.match(js, /moreMenu\.hidden\s*=\s*true/, '点外面应关闭菜单');
  assert.match(js, /document\.addEventListener\('click'/, '应有全局点击监听');
});

test('手机端：visualViewport resize 时滚到底并保持输入框可见', () => {
  assert.match(js, /window\.visualViewport/, '应处理 visualViewport');
  assert.match(js, /visualViewport\.addEventListener\('resize'/, '应监听 resize');
  assert.match(js, /scrollBottom\(\)/, 'resize 时应把叙事滚到底');
});

test('手机端：弹层打开时锁定 body 滚动、关闭时恢复', () => {
  assert.match(js, /document\.body\.style\.overflow\s*=\s*locked\s*\?\s*'hidden'\s*:\s*''/,
    '应由弹层状态决定 body.overflow（hidden / 恢复 ""）');
  assert.match(js, /syncBodyScrollLock\(\)/, '开关弹层时应同步锁滚动');
});

test('手机端：bottom sheet 85vh 可滚动、有关闭 ×、全宽抽屉、≥40px 点击区域', () => {
  assert.match(mb, /max-height\s*:\s*85vh/, 'bottom sheet 最大高度 85vh');
  assert.match(mb, /\.sheet-close\s*\{[^}]*display\s*:\s*flex/, '应有明显关闭按钮');
  assert.match(mb, /\.panel\s*\{[^}]*width\s*:\s*100%/, '角色面板抽屉全宽');
  assert.match(mb, /min-height\s*:\s*40px/, '可点元素点击区域 ≥40px');
});

test('手机端：public/js 无新增 innerHTML', () => {
  for (const f of jsFiles) {
    assert.equal(/\.innerHTML/.test(read('js/' + f)), false, f + ' 不得出现 .innerHTML');
  }
});
