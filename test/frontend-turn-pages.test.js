'use strict';
// 按回合分页 + 手机顶栏 / 输入区 + 「获得」标签可点：静态检查前端源码和样式。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = (p) => fs.readFileSync(path.join(__dirname, '..', 'public', p), 'utf8');
const game = pub('js/game.js');
const html = pub('index.html');
const css = pub('app.css');
const main = pub('js/main.js');
const core = pub('js/core.js');

test('分页：每条回合记录一页，正文只加到当前页，不直接挂在 #stream 下', () => {
  assert.match(game, /function beginPage\(meta\)/);
  assert.match(game, /function showPage\(i, opts\)/);
  assert.match(game, /pages\[k\]\.el\.hidden = \(k !== i\)/, '同一时间只显示一页');
  const direct = game.match(/\$\('stream'\)\.appendChild\(/g) || [];
  assert.equal(direct.length, 1, '只有 beginPage 把页挂到 #stream');
  assert.match(game, /var page = beginPage\(\{ kind: isRebirth \? 'rebirth' : 'turn', turn: rec\.turn, life: rec\.life \}\)/);
  assert.match(game, /\/log\?limit=200/, '进世界取最近 200 回合，都能翻到');
});

test('分页：发送行动 / 时光推进先开新页，失败撤掉那一页', () => {
  const opens = game.match(/beginPage\(\{ kind: 'turn', turn: currentState \? currentState\.turn \+ 1 : null/g) || [];
  assert.ok(opens.length >= 4, 'sendAction / sendTimeSkip / 取回上一回合都开新页');
  assert.match(game, /if \(!stale\) dropLastPage\(\)/);
  assert.match(game, /function dropLastPage\(\)/);
});

test('分页：顶栏回合切换、回合列表、旧回合页脚', () => {
  for (const id of ['turn-nav', 'turn-prev', 'turn-pick', 'turn-next', 'page-foot', 'foot-prev', 'foot-next', 'foot-latest']) {
    assert.match(html, new RegExp('id="' + id + '"'), id);
  }
  assert.match(main, /\$\('turn-pick'\)\.addEventListener\('click', function \(\) \{ openTurnList\(\); \}\)/);
  assert.match(game, /turn-row-gain', '获得 · ' \+ p\.gains\.join/, '回合列表里写出那一回合拿到的物品');
  assert.match(core, /turn-list-modal/, '回合列表算弹层（锁背景滚动）');
  assert.match(core, /showPageOf\(target\)/, '线索「跳到那一回合」先翻到那一页');
  assert.match(css, /#view-game\[data-page="old"\] \.composer,#view-game\[data-page="old"\] \.undo-btn\{display:none\}/);
});

test('手机顶栏：世界名不常驻，角色按钮直接放出来', () => {
  const mobile = css.slice(css.lastIndexOf('@media(max-width:600px){'));
  assert.match(mobile, /\.game-head-title\{display:none\}/);
  assert.match(mobile, /#btn-panel\{display:inline-flex/);
  assert.match(game, /\$\('g-subtitle'\)\.textContent = \(\(s\.bible && s\.bible\.title\) \|\| '无限世界'\)/, '世界名挪到顶栏下一行');
});

test('手机输入区：跟在正文末尾，不再固定在屏幕底部；有「✎ 行动」直达', () => {
  const mobile = css.slice(css.lastIndexOf('@media(max-width:600px){'));
  assert.match(mobile, /\.composer,body\[data-genre\] \.composer\{position:static\}/);
  assert.match(html, /id="btn-compose"/);
  assert.match(game, /new IntersectionObserver\(/);
});

test('「获得 · 物品」标签可点，打开和角色面板同一张物品卡片', () => {
  assert.match(game, /s = el\('button', 'badge up badge-item'\)/);
  assert.match(game, /showItemCard\(b\.name\)/);
});
