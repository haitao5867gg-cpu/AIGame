'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('前端：内联脚本语法合法（仅编译，不执行 DOM）', () => {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '应存在内联 <script>');
  assert.doesNotThrow(() => new vm.Script(m[1]));
});

test('前端：无外部 http(s) 脚本/样式引用（单文件、无 CDN）', () => {
  assert.equal(/<script[^>]*\bsrc\s*=\s*["']\s*https?:\/\//i.test(html), false, '不应引用外部脚本');
  assert.equal(/<link[^>]*\bhref\s*=\s*["']\s*https?:\/\//i.test(html), false, '不应引用外部样式');
  assert.equal(/@import[^;]*https?:\/\//i.test(html), false, '不应 @import 外部样式');
  assert.equal(/url\(\s*["']?\s*https?:\/\//i.test(html), false, 'CSS 不应引用外部 URL');
  // 兜底：任何 src/href 属性都不得指向外部地址
  const refs = html.match(/\b(?:src|href)\s*=\s*["'][^"']*["']/gi) || [];
  for (const ref of refs) {
    assert.equal(/https?:\/\//i.test(ref), false, `引用不得为外部地址：${ref}`);
  }
  // 内联 <script>/<style> 都在，只调用自家 /api/*
  assert.ok(/<script>/.test(html));
  assert.ok(/<style>/.test(html));
  assert.ok(/\/api\/worlds/.test(html));
});

test('前端：不用 innerHTML 拼接用户内容（仅允许静态模板）', () => {
  // 找出所有 .innerHTML = ... 赋值：静态字符串模板允许，
  // 但凡出现 + 拼接或 ${} 模板插值（会混入用户内容）一律判失败。
  const assigns = html.match(/\.innerHTML\s*=\s*[^;]+/g) || [];
  for (const a of assigns) {
    assert.equal(/\+/.test(a), false, `innerHTML 不得用 + 拼接：${a.slice(0, 70)}`);
    assert.equal(/\$\{/.test(a), false, `innerHTML 不得用模板插值：${a.slice(0, 70)}`);
  }
  // 防御注入：用户内容一律走 textContent
  assert.equal(/\.textContent\s*=/.test(html), true, '应使用 textContent 渲染用户内容');
  assert.ok(/createElement\(/.test(html));
});

test('前端：包含三个视图与 /rebirth 调用', () => {
  assert.equal(/id=["']view-home["']/.test(html), true, '应有首页视图');
  assert.equal(/id=["']view-new["']/.test(html), true, '应有新世界视图');
  assert.equal(/id=["']view-game["']/.test(html), true, '应有游戏页视图');
  // hash 路由三个入口
  assert.ok(/#\/new/.test(html));
  assert.ok(/#\/w\//.test(html));
  assert.ok(/#\//.test(html));
  // 进入游戏页恢复叙事：GET log
  assert.ok(/\/log\?limit=50/.test(html), '应请求 /log 恢复叙事');
  // 重生接口调用
  assert.ok(/\/rebirth/.test(html), '应调用 /rebirth');
  // 只调用自家 /api/*，不得出现 Key 字样
  assert.equal(/LLM_API_KEY|API_KEY/.test(html), false, '前端不得出现 Key');
});

test('前端：风声渐紧预兆标签', () => {
  assert.ok(/id=["']g-omen["']/.test(html), '应有预兆标签元素');
  assert.ok(/风声渐紧/.test(html), '应显示「风声渐紧」文案');
  assert.ok(/omen-tag/.test(html), '应有预兆标签样式');
});

test('前端：坊间传闻区（最新在上）', () => {
  assert.ok(/坊间传闻/.test(html), '应有坊间传闻区');
  assert.ok(/rumor-item/.test(html), '应有传闻条目样式');
  assert.ok(/rumors\.slice\(\)\.reverse\(\)/.test(html), '传闻应最新在上');
});

test('前端：顶部显示「地点 · 第N日 时段」', () => {
  assert.ok(/id=["']g-place["']/.test(html), '应有一处显示地点与时间');
  assert.ok(/· 第/.test(html), '应拼出「地点 · 第N日 时段」');
  assert.ok(/s\.clock/.test(html), '应读取 clock 渲染');
});

test('前端：死亡遮罩显示墓志铭、侧面板「前世」区', () => {
  assert.ok(/前世/.test(html), '侧面板应有前世区');
  assert.ok(/pastLives/.test(html), '应读取 pastLives');
  assert.ok(/last\.epitaph/.test(html), '死亡遮罩应显示墓志铭');
  assert.ok(/past-life-item/.test(html), '应有前世条目样式');
});
