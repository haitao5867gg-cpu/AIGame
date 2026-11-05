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

test('前端：侧面板「身上的印记」「未解之谜」「已知的事」三区', () => {
  assert.ok(/身上的印记/.test(html), '应有印记区');
  assert.ok(/未解之谜/.test(html), '应有未解之谜区');
  assert.ok(/已知的事/.test(html), '应有已知的事区');
  assert.ok(/character && s\.character\.marks/.test(html), '应读取 character.marks');
  assert.ok(/s\.threads/.test(html), '应读取 threads');
  assert.ok(/s\.facts/.test(html), '应读取 facts');
  assert.ok(/mark-chip/.test(html), '应有印记条目样式');
  assert.ok(/thread-item/.test(html), '应有线索条目样式');
  assert.ok(/fact-item/.test(html), '应有事实条目样式');
  assert.ok(/collapsible\('已知的事'/.test(html), '「已知的事」应为默认折叠的 details');
});

test('前端：等待回应时显示已等待秒数', () => {
  assert.ok(/id=["']pending-secs["']/.test(html), '应有秒数占位元素');
  assert.ok(/世界在回应…/.test(html));
  assert.ok(/已等待/.test(html));
  assert.ok(/Date\.now\(\) - pendingStart/.test(html), '应按起始时间计算秒数');
  assert.ok(/setInterval\(updatePendingSecs, 1000\)/.test(html), '应每秒刷新');
  assert.ok(/clearInterval\(pendingTimer\)/.test(html), '结束时应清理计时器');
});

test('前端：首页玩法简介（无世界醒目 / 有世界在列表下方小字）', () => {
  assert.ok(/id=["']home-intro["']/.test(html), '应有玩法简介元素');
  // 简介文案覆盖玩法要点
  assert.ok(/一句话/.test(html), '一句话开世界');
  assert.ok(/自由输入/.test(html), '自由输入行动');
  assert.ok(/没有任务/.test(html) && /没有结局/.test(html), '没有任务没有结局');
  assert.ok(/死亡只是一世/.test(html), '死亡只是一世结束');
  assert.ok(/记得你/.test(html), '世界会记得你');
  // 未在列表下方用小字，无世界时用大字
  assert.ok(/HOME_INTRO/.test(html));
  assert.ok(/home-intro small/.test(html) && /home-intro big/.test(html));
  assert.ok(/\.home-intro\.small\{[^}]*font-size:12px/.test(html), '有世界时用小字');
  assert.ok(/intro\.className = list\.length \? 'home-intro small' : 'home-intro big'/.test(html),
    '按是否有世界切换小字/大字');
  // 简介元素位于 world-list 之后（列表下方）
  assert.ok(html.indexOf('id="home-intro"') > html.indexOf('id="world-list"'));
});
