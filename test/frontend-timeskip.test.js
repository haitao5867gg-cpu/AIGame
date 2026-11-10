'use strict';

// 时光推进（前端）：静态检查源文件文本 + 在 Node 里直接跑 formatGameDay / npcAtLine。
// 与 frontend-genre.test.js、frontend-atmosphere.test.js 同法，不依赖浏览器 / 网络。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const html = read('index.html');
const css = read('app.css');
const coreJs = read('js/core.js');
const gameJs = read('js/game.js');
const npcsJs = read('js/npcs.js');
const mainJs = read('js/main.js');

// 从 fromStr 抽到 toStr（不含）之间的源码片段，把检查限定在某个函数体里。
function section(src, fromStr, toStr) {
  const i = src.indexOf(fromStr);
  assert.ok(i >= 0, '应能定位 ' + fromStr);
  const j = toStr ? src.indexOf(toStr, i + fromStr.length) : src.length;
  assert.ok(j > i, '应能定位 ' + toStr);
  return src.slice(i, j);
}

// 按大括号配对抽出一个完整的顶层函数（这几个函数体内没有会干扰计数的字符串/正则花括号）。
function extractFunction(src, signature) {
  const i = src.indexOf(signature);
  assert.ok(i >= 0, '应能定位 ' + signature);
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

const fmtSrc = extractFunction(coreJs, 'function formatGameDay(day) {');
const formatGameDay = new Function(fmtSrc + '\nreturn formatGameDay;')();

// ---------------------------------------------------------------------------
// 1. formatGameDay（core.js 纯函数）
// ---------------------------------------------------------------------------

test('formatGameDay：1 / 365 / 366 / 730 / 731 与非法值按第 1 日', () => {
  assert.equal(formatGameDay(1), '第1日');
  assert.equal(formatGameDay(365), '第365日');
  assert.equal(formatGameDay(366), '第2年 第1日');
  assert.equal(formatGameDay(730), '第2年 第365日');
  assert.equal(formatGameDay(731), '第3年 第1日');
  assert.equal(formatGameDay('10'), '第10日'); // 数字字符串按值处理
  for (const bad of [0, -5, NaN, undefined, null, 'abc', 1.5, Infinity, -Infinity, {}]) {
    assert.equal(formatGameDay(bad), '第1日', '非法值应回退：' + String(bad));
  }
});

// ---------------------------------------------------------------------------
// 2. 入口（index.html / main.js）
// ---------------------------------------------------------------------------

test('index.html 有弹层容器、菜单项、桌面标签；main.js 分发 timeskip', () => {
  assert.match(html, /id="timeskip-pop"/, '应有 #timeskip-pop');
  assert.match(html, /class="timeskip-pop" role="dialog" aria-modal="true" aria-labelledby="timeskip-title"/,
    '弹层应带 dialog / aria 属性');
  assert.match(html, /id="menu-timeskip"[^>]*data-menu="timeskip"/, '⋯ 菜单应有时光推进项');
  assert.match(html, /id="g-timeskip" class="genre-tag"/, '桌面地点行应有 #g-timeskip');
  assert.match(mainJs, /act === 'timeskip'\)\s*openTimeSkip\(\)/, '菜单分发应调用 openTimeSkip()');
  assert.match(mainJs, /\$\('g-timeskip'\)\.addEventListener\('click'/, '桌面标签应绑定点击');
});

// ---------------------------------------------------------------------------
// 3. 发送（game.js）
// ---------------------------------------------------------------------------

test('streamTurn 接收请求体对象，sendAction 发送 { action }', () => {
  assert.match(gameJs, /function streamTurn\(body, block\)/, 'streamTurn 参数改为 body');
  assert.match(gameJs, /JSON\.stringify\(body\)/, 'streamTurn 直接序列化请求体对象');
  const body = section(gameJs, 'async function sendAction() {', '// ---- 时光推进');
  assert.match(body, /streamTurn\(\{ action: action \}, block\)/, 'sendAction 传 { action }');
  assert.match(body, /JSON\.stringify\(\{ action: action \}\)/, '普通 /turn 回退同样传对象');
});

test('sendTimeSkip 发送 timeSkip 且 span 取自四个值', () => {
  for (const v of ['month', 'season', 'half', 'year']) {
    assert.ok(gameJs.includes("value: '" + v + "'"), '应含 span 值 ' + v);
  }
  const body = section(gameJs, 'async function sendTimeSkip(span, plan) {', '// ---- 宽屏插图镜像');
  assert.match(body, /timeSkip:\s*\{\s*span:\s*span,\s*plan:\s*plan\s*\}/, '请求体带 timeSkip');
  assert.match(body, /streamTurn\(body, block\)/, '流式请求用该对象');
  assert.match(body, /JSON\.stringify\(body\)/, '普通 /turn 回退用同一对象');
  assert.match(body, /appendActionLine\('【时光推进·' \+ label/, '先写行动行');
  assert.match(body, /closeTimeSkip\(\)/, '关闭弹层');
  assert.match(body, /timeSkipPlanInput\.value = ''/, '成功才清空文本框');
  assert.match(body, /setBusy\(false\)/, 'finally 复位 busy');
  assert.match(body, /refreshUsage\(\)/, 'finally 刷新用量');
});

// ---------------------------------------------------------------------------
// 4. 渲染（分隔线）
// ---------------------------------------------------------------------------

test('renderResult 与 appendLogRecord 在有 timeSkip 时插入——label 后——分隔', () => {
  const resultBody = section(gameJs, 'function renderResult(res) {', 'async function sendAction() {');
  assert.match(resultBody, /res\.timeSkip && typeof res\.timeSkip\.label === 'string'/, 'renderResult 校验 label');
  assert.match(resultBody, /appendDivider\('—— ' \+ res\.timeSkip\.label \+ '后 ——'\)/, 'renderResult 插分隔');
  const logBody = section(gameJs, 'function appendLogRecord(rec) {', 'function renderEventBanner(ev) {');
  assert.match(logBody, /rec\.timeSkip && typeof rec\.timeSkip\.label === 'string'/, 'appendLogRecord 校验 label');
  assert.match(logBody, /appendDivider\('—— ' \+ rec\.timeSkip\.label \+ '后 ——'\)/, 'appendLogRecord 插分隔');
  assert.match(gameJs, /function appendDivider\(text\)[\s\S]*?'divider'/, '分隔线复用现有 .divider');
});

// ---------------------------------------------------------------------------
// 5. 弹层细节
// ---------------------------------------------------------------------------

test('弹层：maxlength 200、默认选中 year、守卫 / Escape / 焦点 / 滚动锁 / anyOverlayOpen', () => {
  assert.match(gameJs, /setAttribute\('maxlength', '200'\)/, '文本框最多 200 字');
  assert.match(gameJs, /TIME_SKIP_DEFAULT\s*=\s*'year'/, '默认值为 year');
  assert.match(gameJs, /input\.checked\s*=\s*\(s\.value === TIME_SKIP_DEFAULT\)/, '单选默认选中 year');
  assert.match(gameJs, /本世已终，请先重生/, '死亡/重生守卫 toast');
  assert.match(gameJs, /世界还在回应，稍等/, 'busy 守卫 toast');
  assert.match(gameJs, /e\.key === 'Escape'/, 'Escape 关闭');
  assert.match(gameJs, /syncBodyScrollLock\(\)/, '打开/关闭时同步滚动锁');
  assert.match(gameJs, /timeSkipPrevFocus/, '关闭后焦点恢复');
  assert.match(coreJs, /\$\('timeskip-pop'\)/, 'anyOverlayOpen 识别时光推进弹层');
  // Enter 在文本框里换行、不提交：不给 .timeskip-plan 绑 keydown 提交逻辑。
  assert.equal(/timeskip-plan[\s\S]{0,200}keydown/.test(gameJs), false, '文本框不应绑定 keydown 提交');
});

// ---------------------------------------------------------------------------
// 6. 样式（app.css）
// ---------------------------------------------------------------------------

test('app.css：桌面居中卡片 ~420px，选项 ≥40px、文本框 16px，小屏不横向溢出', () => {
  assert.match(css, /\.timeskip-pop\{/, '应有遮罩/弹层样式');
  assert.match(css, /\.timeskip-card\{[^}]*max-width:420px/, '桌面卡片宽约 420px');
  assert.match(css, /\.timeskip-card\{[^}]*max-height:/, '卡片限高，整体可见');
  assert.match(css, /\.timeskip-card\{[^}]*overflow-y:auto/, '内容超高可滚动');
  assert.match(css, /\.timeskip-pop\{[^}]*padding:12px/, '遮罩留 12px，卡片宽 ≤ 100vw - 24px');
  assert.match(css, /\.timeskip-option\{[^}]*min-height:44px/, '选项点击区域 ≥ 40px');
  assert.match(css, /\.timeskip-plan\{[^}]*font-size:16px/, '文本框字号 16px');
  assert.match(css, /@media\(max-width:600px\)\{[\s\S]*?\.timeskip-pop\{align-items:flex-end\}/,
    '小屏用底部抽屉');
});

// ---------------------------------------------------------------------------
// 7. npcs.js 人物经历使用新日期格式（静态 + Node 集成）
// ---------------------------------------------------------------------------

test('npcs.js 人物经历「第N日」改用新日期格式，day>365 显示第N年 第M日', () => {
  assert.match(npcsJs, /formatGameDay\(/, 'npcs.js 应调用 formatGameDay');
  assert.equal(/bits\.push\('第' \+ day \+ '日'\)/.test(npcsJs), false, '不再用旧的「第N日」拼法');
  // 把 core.js 的 formatGameDay 与 npcs.js 的三个纯函数一起在 Node 里跑，验证集成结果。
  const src = [
    fmtSrc,
    extractFunction(npcsJs, 'function npcText(v) {'),
    extractFunction(npcsJs, 'function npcRecorded(v) {'),
    extractFunction(npcsJs, 'function npcAtLine(at) {'),
  ].join('\n');
  const api = new Function(src + '\nreturn { npcAtLine: npcAtLine };')();
  assert.equal(api.npcAtLine({ clock: { day: 45, period: '黄昏' } }).time, '第45日 · 黄昏');
  assert.equal(api.npcAtLine({ clock: { day: 366, period: '黄昏' } }).time, '第2年 第1日 · 黄昏');
  assert.equal(api.npcAtLine({ clock: { day: 731, period: '' } }).time, '第3年 第1日');
  assert.equal(api.npcAtLine({ clock: { day: 0, period: '' } }).time.indexOf('第0日'), -1, 'day=0 不显示');
});
