'use strict';

// 整回合朗读静态检查：只读源文件文本，不执行 DOM / 不请求 Azure。
// 覆盖：每回合一个按钮、播放条、段落高亮、手动滚动后不跟随、总开关、
// 发送新回合停止、预取下一段、成人回合只走浏览器、无新增 innerHTML。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const ttsJs = read('js/tts.js');
const gameJs = read('js/game.js');
const css = read('app.css');
const prefsJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'prefs.js'), 'utf8');

test('每回合一个「▶ 朗读」按钮，不再给每段叙事创建按钮', () => {
  assert.ok(gameJs.includes('attachTurnButton'), 'game.js 用整回合按钮');
  assert.ok(/Tts\.makeTurnButton\(turn\)/.test(gameJs), '每回合只创建一个按钮');
  assert.ok(!gameJs.includes('makeReadButton') && !ttsJs.includes('makeReadButton'), '已移除每段按钮 makeReadButton');
  assert.ok(!gameJs.includes('has-tts-btn'), '不再给每段 p 挂 has-tts-btn');
  const aStart = gameJs.indexOf('function attachTurnButton');
  const aEnd = gameJs.indexOf('\n  function ', aStart + 10);
  const body = gameJs.slice(aStart, aEnd > aStart ? aEnd : gameJs.length);
  assert.ok(!/for\s*\(/.test(body) && !/\.forEach/.test(body), '不再循环遍历每段挂按钮');
  assert.ok(gameJs.includes('attachTurnButton(wrap, paras, currentVoiceHints)'), '历史回放 / 新回合叙事块都挂');
  assert.ok(ttsJs.includes('function makeTurnButton') && ttsJs.includes('▶ 朗读'), '按钮文案 ▶ 朗读');
});

test('整回合按段落顺序排队，可暂停 / 继续 / 停止 / 下一段', () => {
  assert.ok(ttsJs.includes('function startTurn') && ttsJs.includes('onParagraphEnd'), '整回合队列');
  assert.ok(ttsJs.includes('sess.index += 1') && ttsJs.includes('playCurrent(sess)'), '逐段推进');
  assert.ok(ttsJs.includes('togglePause') && ttsJs.includes('playNext') && ttsJs.includes('function stop'), '暂停/继续/下一段/停止');
  assert.ok(ttsJs.includes("'继续'") && ttsJs.includes("'暂停'"), '暂停 / 继续文案');
});

test('底部播放条：暂停/继续、停止、下一段、第 x/y 段', () => {
  assert.ok(ttsJs.includes('tts-player-bar') && css.includes('.tts-player-bar'), '播放条 DOM / 样式');
  assert.ok(ttsJs.includes("'暂停'") && ttsJs.includes("'继续'")
    && ttsJs.includes("'停止'") && ttsJs.includes("'下一段'"), '四个控件文案');
  assert.ok(ttsJs.includes("'toggle'") && ttsJs.includes("'stop'") && ttsJs.includes("'next'"), '按钮动作');
  assert.ok(ttsJs.includes('tts-bar-count') && ttsJs.includes('第 ') && ttsJs.includes(' 段'), '第 x/y 段');
  assert.ok(/composer\.insertBefore\(bar/.test(ttsJs), '插在底部输入框（.composer）上方');
  assert.ok(/bar\.hidden = true/.test(ttsJs) && /barEl\.hidden = true/.test(ttsJs), '播完 / 停止自动收起');
});

test('正在读的段落高亮', () => {
  assert.ok(ttsJs.includes('tts-speaking') && css.includes('tts-speaking'), '有段落高亮类');
  assert.ok(/classList\.add\('tts-speaking'\)/.test(ttsJs), '当前段加高亮');
  assert.ok(/classList\.remove\('tts-speaking'\)/.test(ttsJs), '切换段时取消旧高亮');
});

test('用户手动滚动后不跟随（监听 scroll/wheel/touchmove 记录时间）', () => {
  assert.ok(ttsJs.includes("'scroll'") && ttsJs.includes("'wheel'") && ttsJs.includes("'touchmove'"), '监听三种滚动事件');
  assert.ok(ttsJs.includes('markUserScroll') && ttsJs.includes('lastManualScroll = Date.now()'), '记录手动滚动时间');
  assert.ok(ttsJs.includes('S.follow = false'), '用户一滚动停止跟随');
  assert.ok(/Date\.now\(\)\s*-\s*lastManualScroll\s*<\s*5000/.test(ttsJs), '最近 5 秒有手动滚动不跟随');
  assert.ok(/scrollIntoView\(\{\s*block:\s*'nearest',\s*behavior:\s*'smooth'\s*\}\)/.test(ttsJs), '轻柔跟随 nearest + smooth');
  assert.ok(/follow: true/.test(ttsJs), '下一回合恢复跟随');
});

test('prefs.tts.enabled 总开关；关闭时不预取、不请求 /api/tts', () => {
  assert.ok(ttsJs.includes('enabled: true') && ttsJs.includes('ttsEnabled'), '默认 true 的总开关');
  assert.ok(ttsJs.includes("'朗读功能'") && /masterCb/.test(ttsJs), '朗读设置最上面的开关');
  assert.ok(/typeof t\.enabled === 'boolean'/.test(prefsJs) && prefsJs.includes('enabled: true'), '服务端校验为布尔、默认 true');
  assert.ok(ttsJs.includes("if (!ttsEnabled()) return;"), 'startTurn 关闭时直接返回');
  assert.ok(/prefetchNext[\s\S]{0,120}ttsEnabled/.test(ttsJs), '预取受总开关约束');
  assert.ok(/autoRead[\s\S]{0,120}ttsEnabled/.test(ttsJs), '自动朗读受总开关约束');
  assert.ok(/if \(!wanted\) stop\(\)/.test(ttsJs), '关闭时停止朗读并作废旧请求');
  assert.ok(ttsJs.includes("'/api/tts'") && /myGen !== gen/.test(ttsJs), '关闭后旧请求作废，不发新请求');
  assert.ok(css.includes('.tts-disabled'), '关闭时隐藏所有按钮 / 播放条');
  assert.ok(/settingsBody\.hidden = !ttsEnabled\(\)/.test(ttsJs), '关闭时隐藏其余朗读设置项');
});

test('发送下一回合时停止上一回合朗读', () => {
  const s = gameJs.indexOf('function sendAction');
  const body = gameJs.slice(s, s + 260);
  assert.ok(/Tts\.stop\(\)/.test(body), 'sendAction 开头 Tts.stop()');
});

test('播放当前段时预取下一段；浏览器逐段排队；成人回合只走浏览器', () => {
  assert.ok(ttsJs.includes('prefetchNext') && /sess\.index \+ 1/.test(ttsJs), '预取下一段');
  assert.ok(/prefetchNext\(sess\)/.test(ttsJs), 'playCurrent 播放当前段同时预取');
  assert.ok(ttsJs.includes("'/api/tts'") && ttsJs.includes('new Audio'), 'Azure 请求 + Audio 播放');
  assert.ok(ttsJs.includes('speechSynthesis') && /u\.onend = fin/.test(ttsJs)
    && ttsJs.includes('onParagraphEnd(sess)'), '浏览器逐段 speak，onend 接下一段');
  assert.ok(/adult === undefined \? adultTurnActive\(\) : adult === true/.test(ttsJs), '成人回合判定分支');
  assert.ok(/browserSpeak\(sess, text, params, null\)/.test(ttsJs), '成人回合只走浏览器朗读');
});

test('public/js 无新增 innerHTML 赋值', () => {
  const files = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    assert.ok(!/\.innerHTML/.test(read('js/' + f)), f + ' 不得出现 .innerHTML');
  }
  assert.ok(!/innerHTML/.test(ttsJs), 'tts.js 完全不出现 innerHTML');
});
