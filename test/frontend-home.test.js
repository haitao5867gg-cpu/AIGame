'use strict';

// 首页重做：静态检查源文件文本，不执行 DOM / 不请求网络。
// 与 frontend-genre.test.js 同法读取 index.html / app.css / public/js 脚本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const html = read('index.html');
const css = read('app.css');
const coreJs = read('js/core.js');
const skyJs = read('js/sky.js');
const homeJs = read('js/home.js');
const mainJs = read('js/main.js');

test('首页结构：背景层、首屏、题材之门、玩法区齐全', () => {
  const ids = [
    'id="home-backdrop"', 'canvas id="home-sky"', 'id="hero-form"',
    'textarea id="home-seed"', 'maxlength="300"', 'id="hero-resume"',
    'id="home-shelf"', 'id="world-list"', 'id="home-doors"', 'id="door-row"',
    'home-pillars',
  ];
  for (const s of ids) assert.ok(html.includes(s), 'index.html 应包含 ' + s);
  // sky.js 必须在 core.js 之后、home.js 之前加载
  const iCore = html.indexOf('src="/js/core.js"');
  const iSky = html.indexOf('src="/js/sky.js"');
  const iHome = html.indexOf('src="/js/home.js"');
  assert.ok(iCore >= 0 && iSky > iCore && iHome > iSky, '脚本顺序应为 core → sky → home');
});

test('core.js：HOME_DOORS 恰好 6 项，题材顺序与配图正确', () => {
  const block = coreJs.slice(coreJs.indexOf('var HOME_DOORS'), coreJs.indexOf('function homeDoorFor'));
  const genres = [...block.matchAll(/genre:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(genres, ['xuanhuan', 'urban', 'game', 'horror', 'cozy', 'general']);
  const imgs = [...block.matchAll(/img:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(imgs.length, 6, '每扇门都应配图');
  for (const p of imgs) {
    const f = path.join(root, p.replace(/^\//, ''));
    assert.ok(fs.existsSync(f), '配图应存在：' + p);
    assert.ok(fs.statSync(f).size < 150 * 1024, '配图应小于 150KB：' + p);
  }
});

test('首页主视觉：hero-worlds-v1.jpg 存在且小于 200KB', () => {
  const f = path.join(root, 'assets/home/hero-worlds-v1.jpg');
  assert.ok(fs.existsSync(f), '首屏背景图应存在');
  assert.ok(fs.statSync(f).size < 200 * 1024, '首屏背景图应小于 200KB');
});

test('sky.js：独立星空画布，支持减少动态效果与 dpr 上限', () => {
  assert.match(skyJs, /window\.Sky\s*=\s*\{\s*start:\s*start\s*,\s*stop:\s*stop\s*\}/);
  assert.match(skyJs, /prefers-reduced-motion/);
  assert.match(skyJs, /visibilitychange/);
  assert.match(skyJs, /devicePixelRatio/);
  assert.match(skyJs, /Math\.min\([^)]*,\s*2\)/, 'dpr 应有 2 倍上限');
  // 必须独立，不引用其他脚本里的辅助函数
  assert.equal(/\$\(/.test(skyJs), false, '不得依赖 $');
  assert.equal(/\bel\(/.test(skyJs), false, '不得依赖 el()');
  assert.equal(/\bapi\(/.test(skyJs), false, '不得依赖 api()');
});

test('home.js：打字机提交、预填、清理与安全的 DOM 构建', () => {
  assert.match(homeJs, /isComposing/, 'Enter 提交要避开输入法选词');
  const hide = homeJs.slice(homeJs.indexOf('function hideAllViews'), homeJs.indexOf('function route'));
  assert.match(hide, /Sky\.stop\(\)/, '离开首页应停止星空');
  assert.match(hide, /clearTimeout\(heroTypeTimer\)/, '离开首页应停打字机');
  const showNewBody = homeJs.slice(homeJs.indexOf('function showNew'), homeJs.indexOf('function renderPresets'));
  assert.match(showNewBody, /homeDraft/, '新世界页应使用 homeDraft 预填');
  assert.equal(/innerHTML/.test(homeJs), false, '不得使用 innerHTML');
  assert.match(homeJs, /textContent/, '门与列表用 textContent 构建');
});

// 抽出所有 prefers-reduced-motion 块（大括号配对，兼容内嵌规则块）。
function reducedBodies() {
  const re = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
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

test('app.css：首页新样式与减少动态效果规则', () => {
  assert.match(css, /--gold\s*:/, '应新增 --gold');
  assert.match(css, /\.hero-title\{[^}]*clamp\(/, '大标题用 clamp 流体字号');
  assert.match(css, /scroll-snap-type/, '题材之门手机端用 scroll snap');
  assert.match(css, /#view-home\{[^}]*overflow-x:clip/, '首页禁止横向滚动');
  const rm = reducedBodies();
  assert.match(rm, /\.reveal/, '减少动态效果时区块直接可见');
  assert.match(rm, /\.hero-portal/, '减少动态效果时圆环停转');
});

test('main.js：不再有 btn-new 的 click 跳转绑定', () => {
  assert.equal(/\$\('btn-new'\)\.addEventListener\('click'/.test(mainJs), false,
    'btn-new 现在是表单提交按钮，跳转改由 hero-form submit 处理');
});

// ---- 世界卡片重做：relTime / 封面卡片 / showNew 两处修复 ----

test('core.js relTime：相对时间、边界与本地日期（node:vm 隔离执行）', () => {
  // core.js 顶层只有声明与赋值，不碰 DOM；仅给 Date / Math 即可。
  const ctx = { Date, Math };
  vm.runInNewContext(coreJs, ctx);
  assert.equal(typeof ctx.relTime, 'function', 'core.js 应定义 relTime');
  const rel = ctx.relTime;
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  assert.equal(rel('x', now), '', '非数字 → 空串');
  assert.equal(rel(NaN, now), '', 'NaN → 空串');
  assert.equal(rel(now - 30 * 1000, now), '刚刚', '30 秒前 → 刚刚');
  assert.equal(rel(now - 5 * 60 * 1000, now), '5 分钟前');
  assert.equal(rel(now - 3 * 3600 * 1000, now), '3 小时前');
  assert.equal(rel(now - 2 * 86400 * 1000, now), '2 天前');
  const old = now - 40 * 86400 * 1000;
  const local = new Date(old);
  const dateStr = local.getFullYear() + '-' + (local.getMonth() + 1) + '-' + local.getDate();
  assert.equal(rel(old, now), dateStr, '40 天前 → 本地日期');
  assert.match(rel(old, now), /^\d{4}-\d{1,2}-\d{1,2}$/, '本地日期应为 YYYY-M-D 格式');
  assert.equal(rel(now + 60 * 1000, now), '刚刚', '未来时间（时钟误差）→ 刚刚');
  assert.equal(rel(Date.now()), '刚刚', 'now 缺省时用 Date.now()');
});

test('home.js renderWorldList：封面字段、状态类、图片回退与安全构建', () => {
  const body = homeJs.slice(homeJs.indexOf('function renderWorldList'), homeJs.indexOf('function showNew'));
  for (const s of ['w.cover', 'w.excerpt', 'w.charName', 'w.place', 'relTime', 'homeDoorFor', 'formatGameDay']) {
    assert.ok(body.includes(s), 'renderWorldList 应使用 ' + s);
  }
  for (const s of ["'featured'", "'no-img'", "'wc-recent'"]) {
    assert.ok(body.includes(s), 'renderWorldList 应含类 ' + s);
  }
  assert.match(body, /setAttribute\('loading'/, 'img 应设置 loading');
  assert.match(body, /addEventListener\('error'/, 'img 应处理 error 事件');
  assert.equal(/innerHTML/.test(homeJs), false, 'home.js 仍不得使用 innerHTML');
  assert.ok(homeJs.includes('确认删除？'), '删除仍是两步确认');
});

test('home.js showNew：进入回到顶部 + 首屏来源重置文风为 auto', () => {
  const body = homeJs.slice(homeJs.indexOf('function showNew'), homeJs.indexOf('function renderPresets'));
  assert.match(body, /scrollTo\(0,\s*0\)/, '应 window.scrollTo(0, 0)');
  assert.match(body, /selectedGenre\s*=\s*'auto'/, "应有把 selectedGenre 设为 'auto' 的分支");
});

test('app.css：小说封面卡片样式、16/9 与宽屏 featured 规则', () => {
  assert.match(css, /\.wc-cover\{/, '应有 .wc-cover 规则');
  assert.match(css, /\.wc-excerpt\{/, '应有 .wc-excerpt 规则');
  assert.ok(css.includes('aspect-ratio:16/9'), '封面应为 aspect-ratio:16/9');
  // 抽出 @media (min-width:900px) 块（大括号配对），确认 featured 规则在其中。
  const open = css.indexOf('@media (min-width:900px){');
  assert.ok(open >= 0, '应有 min-width:900px 宽屏媒体查询');
  let i = css.indexOf('{', open) + 1, depth = 1;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
    i++;
  }
  const block = css.slice(open, i);
  assert.match(block, /\.world-card\.featured/, '宽屏块内应有 .world-card.featured 规则');
});
