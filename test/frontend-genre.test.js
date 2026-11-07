'use strict';

// 文风预设（前端）：静态检查源文件文本，不执行 DOM / 不请求网络。
// 与 frontend-mobile.test.js 同法读取 index.html / app.css / public/js 全部脚本。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const html = read('index.html');
const css = read('app.css');
const homeJs = read('js/home.js');
const gameJs = read('js/game.js');
const coreJs = read('js/core.js');
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort();

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

const GENRE_LABELS = ['玄幻修仙', '都市', '游戏系统', '恐怖悬疑', '休闲日常', '通用'];
const GENRE_VALUES = ['xuanhuan', 'urban', 'game', 'horror', 'cozy', 'general'];

test('新建世界页：有 6 个文风选项和「自动」，默认选中 auto', () => {
  assert.match(html, /id="genre-row"/, '新世界页应有文风胶囊容器');
  assert.match(coreJs, /var\s+GENRE_OPTIONS\s*=\s*\[/, 'core.js 应定义共享的 GENRE_OPTIONS');
  for (const label of GENRE_LABELS) {
    assert.ok(coreJs.includes("label: '" + label + "'"), '应含文风「' + label + '」');
  }
  for (const v of GENRE_VALUES) {
    assert.ok(coreJs.includes("value: '" + v + "'"), '应含文风值 ' + v);
  }
  assert.ok(coreJs.includes("value: 'auto', label: '自动'"), '应含「自动」选项');
  assert.match(homeJs, /var\s+selectedGenre\s*=\s*'auto'/, '默认文风应为 auto');
  assert.match(homeJs, /GENRE_OPTIONS\.forEach/, '应据 GENRE_OPTIONS 渲染胶囊');
  assert.match(homeJs, /'genre-pill'/, '应渲染 .genre-pill 胶囊');
});

test('创建世界请求带 genre', () => {
  assert.match(homeJs, /api\('\/api\/worlds'/, '应有创建世界请求');
  assert.match(homeJs, /genre:\s*selectedGenre/, 'POST /api/worlds 的 body 应带 genre');
});

test('游戏页：有 POST /genre 修改文风的代码', () => {
  assert.match(gameJs, /'\/genre'/, '应有 /genre 修改请求');
  assert.match(gameJs, /method:\s*'POST'/, '修改请求应为 POST');
  assert.match(gameJs, /JSON\.stringify\(\{\s*genre:/, 'body 应带 genre');
});

test('「⋯」菜单有文风项', () => {
  assert.match(html, /data-menu="genre"/, '菜单应有 genre 项');
  assert.match(html, /文风：/, '菜单项应显示「文风：」');
  assert.match(html, /id="menu-genre-name"/, '应有可更新的当前文风名元素');
});

test('切换成功 toast 有「下一回合生效」提示', () => {
  assert.match(gameJs, /文风已切换为/, 'toast 应含新文风名前缀');
  assert.match(gameJs, /下一回合生效/, 'toast 应提示下一回合生效');
});

test('桌面地点行有文风标签，缺 genre 时回退「识别中」，共用选择列表当前项打勾', () => {
  assert.match(html, /id="g-genre"/, '桌面地点行应有文风标签');
  assert.match(html, /id="genre-pop"/, '应有共用选择列表容器');
  assert.match(gameJs, /文风·/, '标签文案应为「文风·…」');
  assert.match(gameJs, /识别中/, '缺 genre 时回退「识别中」');
  assert.match(gameJs, /✓/, '选择列表当前项应打勾');
  assert.match(gameJs, /renderGenreLabels\(\)/, 'renderHeader 应刷新文风标签');
});

test('手机端：文风胶囊横向滑动、点击区域 ≥40px，桌面标签隐藏', () => {
  assert.match(mb, /\.genre-row\s*\{[^}]*overflow-x\s*:\s*auto/, '文风行应可横向滑动');
  assert.match(mb, /\.genre-pill\s*\{[^}]*min-height\s*:\s*40px/, '胶囊点击区域 ≥40px');
  assert.match(mb, /\.genre-tag\s*\{[^}]*display\s*:\s*none/, '桌面标签在手机端隐藏');
});

test('public/js 没有新增 innerHTML', () => {
  for (const f of jsFiles) {
    assert.equal(/\.innerHTML/.test(read('js/' + f)), false, f + ' 不得出现 .innerHTML');
  }
});
