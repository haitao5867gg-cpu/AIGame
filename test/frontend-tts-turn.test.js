'use strict';

// 整回合朗读静态检查：只读源文件文本，不执行 DOM / 不请求 Azure。
// 覆盖：每回合一个按钮、播放条、段落高亮、手动滚动后不跟随、总开关、
// 发送新回合停止、预取下一段、成人回合只走浏览器、无新增 innerHTML。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

// ---- 行动气泡 + 朗读按钮内联：用 vm + 最小假 DOM 真实执行 public/js 里的函数 ----
// 抽出 core.js 的 $ / el 与 game.js 的 appendActionLine / attachTurnButton，
// 在假 DOM 里执行，验证生成的 DOM 结构和按钮挂载位置（不只是读源码字符串）。
function section(src, fromStr, toStr) {
  const i = src.indexOf(fromStr);
  assert.ok(i >= 0, '应能定位 ' + fromStr);
  const j = src.indexOf(toStr, i + fromStr.length);
  assert.ok(j > i, '应能定位 ' + toStr);
  return src.slice(i, j);
}
const coreJs = read('js/core.js');
const coreSrc = section(coreJs, 'function $(id) {', 'function formatGameDay(day) {');
const actionSrc = section(gameJs, 'function appendActionLine(action) {', 'function appendDivider(text) {');
const turnSrc = section(gameJs, 'function attachTurnButton(wrap, paras, hints) {', 'function appendEventCard(ev) {');

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.className = '';
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this._text = '';
  }
  get classList() {
    const self = this;
    const parts = () => self.className.split(/\s+/).filter(Boolean);
    return {
      contains(c) { return parts().includes(c); },
      add(c) { if (!parts().includes(c)) self.className = parts().concat(c).join(' '); },
    };
  }
  get textContent() {
    let s = this._text;
    for (const c of this.childNodes) s += c.textContent;
    return s;
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this._text = (v == null ? '' : String(v));
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, c);
    else this.childNodes.push(c);
    c.parentNode = this;
    return c;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const arr = this.parentNode.childNodes;
    const i = arr.indexOf(this);
    return i > 0 ? arr[i - 1] : null;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }
  querySelector(sel) { return this._find(sel)[0] || null; }
  querySelectorAll(sel) { return this._find(sel); }
  _find(sel) {
    const sels = sel.split(',').map((s) => s.trim());
    const match = (n) => sels.some((s) => {
      if (s[0] === '.') return n.classList.contains(s.slice(1));
      if (s[0] === '#') return n.getAttribute('id') === s.slice(1);
      return n.tagName === s.toUpperCase();
    });
    const out = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (match(c)) out.push(c);
        walk(c);
      }
    })(this);
    return out;
  }
}

function makeEnv() {
  const byId = {};
  const doc = {
    createElement(tag) { return new FakeNode(tag); },
    getElementById(id) { return byId[id] || null; },
  };
  const stream = new FakeNode('div');
  byId['stream'] = stream;
  const sandbox = {
    document: doc,
    turnStartEl: null,
    scrollToTurnStart() {},
    pageTarget() { return stream; },   // 分页后正文加到当前页；测试里直接用 #stream
    lastPage() { return null; },
    Tts: {
      makeTurnButton() {
        const b = doc.createElement('button');
        b.className = 'tts-read-btn';
        return b;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(coreSrc + '\n' + actionSrc + '\n' + turnSrc, sandbox);
  return {
    doc, stream,
    api: {
      el: sandbox.el,
      appendActionLine: sandbox.appendActionLine,
      attachTurnButton: sandbox.attachTurnButton,
    },
  };
}
function mk(env, tag, cls, text) { return env.api.el(tag, cls, text); }
function headCount(node) { return node.querySelectorAll('.tts-turn-head').length; }

test('行动行：action-line > action-bubble > action-who「你」+ action-text（真实 DOM）', () => {
  const env = makeEnv();
  env.api.appendActionLine('我走向城门');
  const lines = env.stream.querySelectorAll('.action-line');
  assert.equal(lines.length, 1, '每回合恰好一个 .action-line');
  const line = lines[0];
  assert.equal(line.tagName, 'P', '行动行仍是 p.action-line（回合起点类名不变）');
  const bubble = line.querySelector('.action-bubble');
  assert.ok(bubble, '有 .action-bubble');
  assert.equal(bubble.parentNode, line, '.action-bubble 是行动行直接子节点');
  const who = bubble.querySelector('.action-who');
  const text = bubble.querySelector('.action-text');
  assert.ok(who && text, '气泡含 action-who 与 action-text');
  assert.equal(who.textContent, '你');
  assert.equal(text.textContent, '我走向城门');
  assert.equal(line.textContent, '你我走向城门', '文字只剩「你」+ 行动，不再有「› 你：」前缀');
  assert.ok(!/›/.test(line.textContent) && !line.textContent.includes('你：'), '无旧前缀');
});

test('时光推进行动文字原样放进 action-text', () => {
  const env = makeEnv();
  const s = '【时光推进·一年】按眼下的日子过下去';
  env.api.appendActionLine(s);
  assert.equal(env.stream.querySelector('.action-text').textContent, s);
});

test('game.js 源码不再有「› 你：」，改用 el/textContent 构建气泡', () => {
  assert.ok(!gameJs.includes('› 你：'), '源码去掉前缀文字');
  assert.ok(gameJs.includes("el('span', 'action-who', '你')"), 'action-who 文案');
  assert.ok(gameJs.includes("el('span', 'action-text', action)"), 'action-text 用 el/textContent');
  assert.ok(!/\.innerHTML/.test(gameJs), '不拼 innerHTML');
});

test('attachTurnButton 源码：往前找行动行并内联按钮，保留找不到时的回退', () => {
  const body = section(gameJs, 'function attachTurnButton(wrap, paras, hints) {', 'function appendEventCard(ev) {');
  assert.ok(/previousElementSibling/.test(body), '从 wrap 往前找');
  assert.ok(/event-card/.test(body) && /divider/.test(body), '跳过事件卡 / 分隔');
  assert.ok(/action-line/.test(body), '以 .action-line 为目标');
  assert.ok(/tts-turn-head/.test(body), '判断行动行是否已有按钮');
  assert.ok(/data-tts-inline/.test(body), '内联时打标记');
  assert.ok(/insertBefore\(head, wrap\.firstChild\)/.test(body), '没找到时仍插到 wrap 最前面');
  assert.ok(!/\.innerHTML/.test(body), '不拼 innerHTML');
});

test('attachTurnButton：前一个兄弟是 .action-line → 按钮进行动行、wrap 标 data-tts-inline', () => {
  const env = makeEnv();
  env.api.appendActionLine('走向城门');
  const wrap = mk(env, 'div', 'narration-block');
  wrap.appendChild(mk(env, 'p', 'narration', '段一'));
  env.stream.appendChild(wrap);
  const turn = env.api.attachTurnButton(wrap, ['段一'], []);
  const line = env.stream.querySelector('.action-line');
  assert.equal(headCount(line), 1, '按钮进行动行');
  assert.equal(headCount(wrap), 0, 'wrap 内不再放按钮');
  assert.equal(wrap.getAttribute('data-tts-inline'), '1', 'wrap 标记内联');
  assert.ok(wrap.firstChild && !wrap.firstChild.classList.contains('tts-turn-head'), 'wrap 首子元素不是按钮');
  assert.ok(line.childNodes[line.childNodes.length - 1].classList.contains('tts-turn-head'), '按钮在 .action-bubble 之后追加');
  assert.ok(line.querySelector('.action-bubble'), '气泡仍在');
  assert.equal(turn.btn.className, 'tts-read-btn', 'turn.btn 仍是新建按钮');
  assert.equal(turn.wrap, wrap, 'turn.wrap 不变');
});

test('attachTurnButton：隔着 .event-card / .divider 也能找到行动行', () => {
  const env = makeEnv();
  env.api.appendActionLine('走向城门');
  env.stream.appendChild(mk(env, 'div', 'event-card'));
  env.stream.appendChild(mk(env, 'div', 'divider'));
  const wrap = mk(env, 'div', 'narration-block');
  wrap.appendChild(mk(env, 'p', 'narration', '段一'));
  env.stream.appendChild(wrap);
  env.api.attachTurnButton(wrap, ['段一'], []);
  const line = env.stream.querySelector('.action-line');
  assert.equal(headCount(line), 1, '跳过卡片/分隔后按钮仍进行动行');
  assert.equal(wrap.getAttribute('data-tts-inline'), '1');
  assert.equal(headCount(wrap), 0);
});

test('attachTurnButton：前面是 .narration-block → 按钮在 wrap 第一个子元素', () => {
  const env = makeEnv();
  env.stream.appendChild(mk(env, 'div', 'narration-block'));
  const wrap = mk(env, 'div', 'narration-block');
  wrap.appendChild(mk(env, 'p', 'narration', '段一'));
  env.stream.appendChild(wrap);
  env.api.attachTurnButton(wrap, ['段一'], []);
  assert.equal(headCount(wrap), 1, '按钮回到 wrap');
  assert.ok(wrap.firstChild.classList.contains('tts-turn-head'), '是 wrap 第一个子元素');
  assert.equal(wrap.getAttribute('data-tts-inline'), null, '不打内联标记');
});

test('attachTurnButton：没有前置兄弟（重生开场/序章后第一段）→ 按钮在 wrap 第一个子元素', () => {
  const env = makeEnv();
  const wrap = mk(env, 'div', 'narration-block');
  wrap.appendChild(mk(env, 'p', 'narration', '开场'));
  env.stream.appendChild(wrap);
  env.api.attachTurnButton(wrap, ['开场'], []);
  assert.equal(headCount(wrap), 1);
  assert.ok(wrap.firstChild.classList.contains('tts-turn-head'));
  assert.equal(wrap.getAttribute('data-tts-inline'), null);
});

test('attachTurnButton：行动行已有按钮时不重复放（行动行仍只有一个）', () => {
  const env = makeEnv();
  env.api.appendActionLine('走向城门');
  const line = env.stream.querySelector('.action-line');
  const existing = mk(env, 'div', 'tts-turn-head');
  existing.appendChild(mk(env, 'button', 'tts-read-btn'));
  line.appendChild(existing);
  const wrap = mk(env, 'div', 'narration-block');
  wrap.appendChild(mk(env, 'p', 'narration', '段一'));
  env.stream.appendChild(wrap);
  env.api.attachTurnButton(wrap, ['段一'], []);
  assert.equal(headCount(line), 1, '行动行按钮数不变，不重复放');
  assert.equal(headCount(wrap), 1, '回退到 wrap 第一个子元素');
  assert.ok(wrap.firstChild.classList.contains('tts-turn-head'));
  assert.equal(wrap.getAttribute('data-tts-inline'), null);
});
