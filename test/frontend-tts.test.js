'use strict';

// 朗读（第 2 步前端）静态检查：只读取源文件文本，不执行 DOM / 不请求 Azure。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const html = read('index.html');
const ttsJs = read('js/tts.js');
const gameJs = read('js/game.js');
const panelsJs = read('js/panels.js');
const coreJs = read('js/core.js');
const css = read('app.css');

test('index.html 引入 /js/tts.js 且在 game.js 之前', () => {
  assert.ok(html.includes('<script src="/js/tts.js"></script>'));
  assert.ok(html.indexOf('/js/tts.js') < html.indexOf('/js/game.js'), 'tts.js 必须在 game.js 之前');
});

test('tts.js：朗读按钮、speechSynthesis 兜底、试听', () => {
  assert.ok(ttsJs.includes('▶'), '有 ▶ 朗读按钮');
  assert.ok(ttsJs.includes('makeTurnButton') && !ttsJs.includes('makeReadButton'), '每回合一个朗读按钮（不再每段挂）');
  assert.ok(/new Audio/.test(ttsJs), '用 Audio 播放 audio/mpeg');
  assert.ok(ttsJs.includes('speechSynthesis') && ttsJs.includes('SpeechSynthesisUtterance'), '浏览器语音兜底');
  assert.ok(ttsJs.includes("u.lang = 'zh-CN'"), '兜底语音 zh-CN');
  assert.ok(/u\.rate\s*=\s*clampSpeed/.test(ttsJs), 'rate 取 speed');
  assert.ok(ttsJs.includes('试听'), '有试听按钮');
});

test('tts.js：自动朗读开关、语速 0.5~2 滑块、本月已用', () => {
  assert.ok(ttsJs.includes('自动朗读新回合'), '有自动朗读开关');
  assert.ok(/slider\.min\s*=\s*'0\.5'/.test(ttsJs), '滑块下限 0.5');
  assert.ok(/slider\.max\s*=\s*'2'/.test(ttsJs), '滑块上限 2');
  assert.ok(ttsJs.includes('本月已用'), '显示本月已用');
  assert.ok(ttsJs.includes('本月 Azure 额度已用完'), '额度用完提示');
  assert.ok(ttsJs.includes('autoRead') && ttsJs.includes('hashchange'), '自动朗读 + 切换世界停止');
});

test('game.js：整回合朗读按钮、renderResult 自动朗读、发送新行动停止', () => {
  assert.ok(gameJs.includes('makeTurnButton'));
  assert.ok(gameJs.includes('autoRead'));
  assert.ok(/Tts\.stop\(\)/.test(gameJs), '发送新行动停止');
  assert.ok(gameJs.includes('currentVoiceHints'), 'voice_hints 传给每段');
});

test('panels.js 用量面板挂朗读设置；core.js 预置 myPrefs.tts；app.css 有样式', () => {
  assert.ok(panelsJs.includes('renderSettings'), '用量面板挂朗读设置');
  assert.ok(coreJs.includes('myPrefs.tts'), 'core 共享变量 myPrefs.tts');
  assert.ok(css.includes('.tts-read-btn') && css.includes('.tts-turn-head')
    && css.includes('.tts-player-bar') && css.includes('tts-speaking'), '整回合按钮 / 播放条 / 段落高亮样式');
});

test('public/js 无新增 innerHTML 赋值', () => {
  const files = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = read('js/' + f);
    assert.ok(!/\.innerHTML/.test(src), f + ' 不得出现 .innerHTML');
  }
  assert.ok(!/innerHTML/.test(ttsJs), 'tts.js 完全不出现 innerHTML');
});
