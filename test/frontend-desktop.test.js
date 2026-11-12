'use strict';

// 电脑端阅读布局优化：静态检查源文件文本，不执行 DOM / 不请求网络。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
const css = read('app.css');
const gameJs = read('js/game.js');
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort();
const js = jsFiles.map((f) => read('js/' + f)).join('\n');

// 抽出指定 @media 块的规则体（大括号配对，兼容内嵌规则块），返回拼接文本。
function mediaBodies(re) {
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
const m860 = mediaBodies(/@media\s*\(\s*min-width:\s*860px\s*\)\s*\{/g);
const m1200 = mediaBodies(/@media\s*\(\s*min-width:\s*1200px\s*\)\s*\{/g);
const m600 = mediaBodies(/@media\s*\(\s*max-width:\s*600px\s*\)\s*\{/g);

test('滚动条不挡字：内嵌滚动区 scrollbar-gutter:stable / 细滚动条 / 右侧≥12px 内边距', () => {
  assert.match(css, /scrollbar-gutter:\s*stable/, '应有 scrollbar-gutter:stable');
  assert.match(css, /scrollbar-width:\s*thin/, '应有 scrollbar-width:thin');
  assert.match(css, /\.stream,\.panel,\.usage-pop,\.prologue-card,\.item-card-modal-card\{/,
    '#stream / 角色面板 / 弹出卡片都应纳入');
  assert.match(css, /padding-right:\s*16px/, '右侧内边距 ≥12px');
  assert.match(css, /::-webkit-scrollbar[^{]*\{[^}]*width:\s*8px/, 'WebKit 滚动条宽 8px');
  assert.match(css, /scrollbar-color:\s*rgba\([^)]*\)/, '滑块半透明');
});

test('≥860px：#app 最大宽 1440px、.stream 改为 flex:1+min-height:0 且不再 60vh', () => {
  assert.ok(m860.length > 0, '应能抽出 ≥860px 规则体');
  assert.match(m860, /#app\{[^}]*max-width:\s*1440px/, '#app 最大宽 1440px');
  assert.match(m860, /\.stream\{[^}]*flex:\s*1[^}]*min-height:\s*0/, '.stream 应 flex:1 且 min-height:0');
  assert.match(m860, /\.stream\{[^}]*max-height:\s*none/, '.stream 应去掉 60vh 上限');
  assert.match(m860, /\.stream\{[^}]*overflow-y:\s*auto/, '.stream 内部滚动');
  assert.doesNotMatch(m860, /max-height:\s*60vh/, '≥860px 媒体查询里不应再有 60vh');
  assert.match(m860, /\.panel\{[^}]*width:\s*320px/, '右侧面板 320px');
  assert.match(m860, /height:\s*calc\(100vh/, '.stage/#view-game 用视口高度填满');
  assert.match(m860, /line-height:\s*1\.7/, '正文行高约 1.7');
  assert.match(m860, /0\.6em/, '段距约 0.6em');
  assert.match(m860, /max-width:\s*44em/, '正文列约 44 汉字');
});

test('≥1200px：当前回合插图在右侧栏顶部但跟随面板滚动（不再 sticky）、历史回合为 80px 小缩略图', () => {
  assert.ok(m1200.length > 0, '应能抽出 ≥1200px 规则体');
  assert.match(m1200, /#scene-rail\{[^}]*display:\s*block/, '当前回合插图仍在右栏顶部显示');
  assert.doesNotMatch(m1200, /#scene-rail\{[^}]*position:\s*sticky/, '不再 sticky，跟着面板一起滚');
  assert.match(m1200, /#scene-rail\{[^}]*margin:\s*0 0 12px/, '保留 12px 下间距');
  assert.match(m1200, /#scene-rail:empty\{[^}]*display:\s*none/, '空时隐藏仍保留');
  assert.match(m1200, /#scene-rail \.scene-frame\{[^}]*max-height:\s*220px/, '插图尺寸仍保留');
  assert.match(m1200, /\.scene-current\{[^}]*display:\s*none/, '当前回合正文里不再插图');
  assert.match(m1200, /\.scene-history\{[^}]*height:\s*80px/, '历史回合缩略图高 80px');
});

test('插图镜像 JS：把当前回合插图放到 #panel 顶部，复用 data-scene / renderScenes', () => {
  assert.match(gameJs, /function syncSceneRail\s*\(/, '应有 syncSceneRail');
  assert.match(gameJs, /insertBefore\(rail,\s*panel\.firstChild\)/, '作为右侧栏第一个子元素');
  assert.match(gameJs, /scene-current/, '标记当前回合框');
  assert.match(gameJs, /scene-history/, '标记历史回合框');
  assert.match(gameJs, /setAttribute\('data-scene',\s*key\)/, '镜像沿用 data-scene');
});

test('翻页便利：空格 / PageDown 翻叙事区，输入框聚焦时不触发', () => {
  assert.ok(js.includes("'PageDown'"), '应处理 PageDown');
  assert.ok(js.includes("'PageUp'"), '应处理 PageUp');
  assert.ok(js.includes("e.key === ' '") || js.includes("e.code === 'Space'"), '应处理空格');
  assert.ok(js.includes('scrollTop +='), '应滚动 #stream');
  assert.ok(js.includes('document.activeElement === ai'), '输入框聚焦守卫');
  assert.ok(js.includes('e.preventDefault()'), '应阻止默认');
  assert.ok(js.includes('clientHeight - line * 2'), '留 2 行重叠');
  assert.match(gameJs, /function scrollToTurnStart\s*\(/, 'scrollToTurnStart 保持完好');
});

test('手机端（≤600px）媒体查询既有规则未删除', () => {
  assert.ok(m600.length > 0, '应能抽出 ≤600px 规则体');
  assert.match(m600, /\.stream\{[^}]*max-height:\s*none/, '.stream 仍 max-height:none');
  assert.match(m600, /\.stream\{[^}]*overflow:\s*visible/, '.stream 仍整页滚动');
  assert.match(m600, /\.composer\{[^}]*position:\s*sticky/, '.composer 仍 sticky');
  assert.match(m600, /env\(\s*safe-area-inset-bottom\s*\)/, '仍带 safe-area');
  assert.match(m600, /min-height:\s*40px/, '仍保留 ≥40px 点击区域');
  assert.match(m600, /font-size:\s*16px/, '输入仍 16px');
});

test('public/js 无 innerHTML', () => {
  for (const f of jsFiles) {
    assert.ok(!/\.innerHTML/.test(read('js/' + f)), f + ' 不得出现 .innerHTML');
  }
});
