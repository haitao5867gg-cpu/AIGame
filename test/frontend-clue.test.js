'use strict';

// 印记 / 线索 / 传闻说明卡 + 行动行 data-turn 的前端测试。
// 做法：CSS / 源码静态检查 + vm + 最小假 DOM 真实执行 core.js / game.js 抽出的函数。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
const css = read('app.css');
const indexHtml = read('index.html');
const coreJs = read('js/core.js');
const gameJs = read('js/game.js');
const mainJs = read('js/main.js');
const jsFiles = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort();
const jsAll = jsFiles.map((f) => read('js/' + f)).join('\n');

function section(src, fromStr, toStr) {
  const i = src.indexOf(fromStr);
  assert.ok(i >= 0, '应能定位 ' + fromStr);
  const j = src.indexOf(toStr, i + fromStr.length);
  assert.ok(j > i, '应能定位 ' + toStr);
  return src.slice(i, j);
}
// 抽出 @media(min-width:1200px){...} 规则体（大括号配对）。
function mediaBody(re) {
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
const m1200 = mediaBody(/@media\s*\(\s*min-width:\s*1200px\s*\)\s*\{/g);
const m600 = mediaBody(/@media\s*\(\s*max-width:\s*600px\s*\)\s*\{/g);

// ---------------------------------------------------------------- CSS 静态检查
test('问题1：app.css 里 #scene-rail 不再是 sticky（跟着面板一起滚）', () => {
  assert.doesNotMatch(css, /#scene-rail\{[^}]*position:\s*sticky/, '任何 #scene-rail 规则都不得 sticky');
  assert.ok(m1200.length > 0, '应能抽出 ≥1200px 规则体');
  assert.match(m1200, /#scene-rail\{[^}]*display:\s*block/, '仍在右栏顶部显示');
  assert.match(m1200, /#scene-rail\{[^}]*margin:\s*0 0 12px/, '保留 12px 下间距');
  assert.match(m1200, /#scene-rail:empty\{[^}]*display:\s*none/, '空时隐藏仍保留');
  assert.match(m1200, /#scene-rail \.scene-frame\{[^}]*max-height:\s*220px/, '尺寸仍保留');
  assert.doesNotMatch(m1200, /#scene-rail\{[^}]*top:\s*0/, '不再有 top:0');
  assert.doesNotMatch(m1200, /#scene-rail\{[^}]*z-index/, '不再有 z-index');
});

test('#clue-tip 卡片样式与 #attr-tip 一致（fixed / z-index / left / top / transform / width）', () => {
  assert.match(css, /\.clue-tip\{[^}]*position:\s*fixed/, '同样固定定位');
  assert.match(css, /\.clue-tip\{[^}]*z-index:\s*70/, '同样层级');
  assert.match(css, /\.clue-tip\{[^}]*left:\s*50%/, '同样水平居中');
  assert.match(css, /\.clue-tip\{[^}]*top:\s*64px/, '同样顶部位置');
  assert.match(css, /\.clue-tip\{[^}]*transform:\s*translateX\(-50%\)/, '同样偏移');
  assert.match(css, /\.clue-tip\{[^}]*width:\s*320px/, '同样宽度');
  assert.match(indexHtml, /id=["']clue-tip["']/, 'index.html 有 #clue-tip 容器');
});

test('可点条目：cursor:pointer + hover/focus-visible 用 var(--accent-2) 高亮', () => {
  assert.match(css, /\.mark-chip\[data-clue\],\.thread-item\[data-clue\],\.rumor-item\[data-clue\]\{[^}]*cursor:\s*pointer/,
    '三类条目都有 cursor:pointer');
  assert.match(css, /\.mark-chip\[data-clue\]:hover[^{]*\{[^}]*var\(--accent-2\)/, 'hover 用 accent-2');
  assert.match(css, /\.mark-chip\[data-clue\]:focus-visible[^{]*\{[^}]*var\(--accent-2\)/, 'focus-visible 用 accent-2');
});

test('.flash-turn 静态高亮 + 尊重 prefers-reduced-motion', () => {
  assert.match(css, /\.flash-turn\{[^}]*outline:\s*2px solid var\(--accent-2\)/, 'outline 高亮');
  assert.match(css, /\.flash-turn\{[^}]*background:/, '背景高亮');
  assert.match(css, /@media\(prefers-reduced-motion:\s*reduce\)\{\.flash-turn\{[^}]*transition:\s*none[^}]*animation:\s*none/,
    'reduced-motion 下不做动画/过渡，只留静态高亮');
});

test('手机端（≤600px）可点条目 ≥40px 高', () => {
  assert.match(m600, /\.mark-chip\[data-clue\],\.thread-item\[data-clue\],\.rumor-item\[data-clue\]\{[^}]*min-height:\s*40px/,
    '手机点击区域 ≥40px');
});

// ---------------------------------------------------------------- 源码静态检查
test('.action-line 带 data-turn：回放路径用 rec.turn', () => {
  const logBody = section(gameJs, 'function appendLogRecord(rec) {', 'function renderEventBanner(ev) {');
  assert.match(gameJs, /appendActionLine\(rec\.action\)/, '回放仍走 appendActionLine');
  assert.match(logBody, /rec\.turn\s*!=\s*null/, '回放读取 /log 记录的 turn');
  assert.match(logBody, /setAttribute\('data-turn',\s*String\(rec\.turn\)\)/, '把 rec.turn 写到本回合行动行');
});

test('.action-line 带 data-turn：新回合路径在 renderResult 用 res.state.turn 补上', () => {
  const resultBody = section(gameJs, 'function renderResult(res) {', 'async function sendAction() {');
  assert.match(resultBody, /res\.state\.turn\s*!=\s*null/, '用结果的 state.turn');
  assert.match(resultBody, /classList\.contains\('action-line'\)/, '只标在本回合那条 .action-line 上');
  assert.match(resultBody, /setAttribute\('data-turn',\s*String\(res\.state\.turn\)\)/, '补上 data-turn');
  assert.match(gameJs, /appendActionLine\(action\)/, '新回合仍走 appendActionLine');
});

test('时光推进行动行同样走 renderResult 补 data-turn', () => {
  assert.match(gameJs, /appendActionLine\('【时光推进·' \+ label/, '时光推进先写行动行');
  const skipBody = section(gameJs, 'async function sendTimeSkip(span, plan) {', '// ---- 宽屏插图镜像');
  assert.match(skipBody, /renderResult\(res\)/, '流式结果走 renderResult');
  assert.match(skipBody, /renderResult\(fb\)/, '回退结果也走 renderResult');
});

test('renderPanel 三类条目可点，turn 取自 clueMeta / r.turn', () => {
  assert.match(gameJs, /var clueMeta = s\.clueMeta \|\| \{\}/, '读取公开状态 clueMeta');
  assert.match(gameJs, /var markTurns = clueMeta\.marks \|\| \{\}/, '印记回合来自 clueMeta.marks');
  assert.match(gameJs, /var threadTurns = clueMeta\.threads \|\| \{\}/, '线索回合来自 clueMeta.threads');
  assert.match(gameJs, /clueChip\('span', 'mark-chip'/, '印记用 clueChip');
  assert.match(gameJs, /clueChip\('div', 'thread-item'/, '线索用 clueChip');
  assert.match(gameJs, /clueChip\('div', 'rumor-item'/, '传闻用 clueChip');
  assert.match(gameJs, /'rumor', r\.text \|\| '', r\.turn\)/, '传闻用自带 r.turn');
  assert.match(gameJs, /setAttribute\('role', 'button'\)/, 'role=button');
  assert.match(gameJs, /setAttribute\('tabindex', '0'\)/, 'tabindex=0 可聚焦');
  assert.match(gameJs, /setAttribute\('data-clue-text'/, '带完整文字');
  assert.match(gameJs, /setAttribute\('data-clue-turn'/, '有回合号才带 turn');
  assert.match(gameJs, /rumors\.slice\(\)\.reverse\(\)/, '传闻仍最新在上');
});

test('main.js 接线：全局 click / keydown，且 public/js 无 innerHTML', () => {
  assert.match(mainJs, /addEventListener\('click',\s*onClueDocumentClick\)/, '绑定点条目/点卡片外');
  assert.match(mainJs, /addEventListener\('keydown',\s*onClueKeyDown\)/, '绑定 Enter/空格/Escape');
  assert.match(coreJs, /function showClueTip\s*\(/, 'core.js 定义弹卡');
  assert.match(coreJs, /function jumpToClueTurn\s*\(/, 'core.js 定义跳转');
  assert.match(coreJs, /function hideClueTip\s*\(/, 'core.js 定义关闭');
  for (const f of jsFiles) {
    assert.ok(!/\.innerHTML/.test(read('js/' + f)), f + ' 不得出现 .innerHTML');
  }
});

// ---------------------------------------------------------------- vm + 最小假 DOM
const corePre = section(coreJs, 'function $(id) {', 'function formatGameDay(day) {');
const clueSrc = (function () {
  const start = '/* CLUE_TIP_HELPERS_START */';
  const end = '/* CLUE_TIP_HELPERS_END */';
  const i = coreJs.indexOf(start);
  const j = coreJs.indexOf(end);
  assert.ok(i >= 0 && j > i, '应存在 CLUE_TIP_HELPERS 标记');
  return coreJs.slice(i + start.length, j);
})();
const chipSrc = section(gameJs, 'function clueChip(tag, cls, display, kind, text, turn) {', 'function renderPanel(s) {');

function matchesSel(node, sel) {
  sel = sel.trim();
  if (!sel) return false;
  const tok = /(\.[A-Za-z0-9_-]+)|(\[[^\]]+\])/g;
  const classes = [], attrs = [];
  let m;
  while ((m = tok.exec(sel)) !== null) {
    if (m[1]) classes.push(m[1].slice(1));
    else {
      const a = m[2].slice(1, -1);
      const eq = a.indexOf('=');
      if (eq < 0) attrs.push([a, null]);
      else attrs.push([a.slice(0, eq), a.slice(eq + 1).replace(/^["']|["']$/g, '')]);
    }
  }
  for (const c of classes) if (!node.classList.contains(c)) return false;
  for (const [k, v] of attrs) {
    const got = node.getAttribute(k);
    if (got === null) return false;
    if (v !== null && got !== v) return false;
  }
  return true;
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.className = '';
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this._text = '';
    this.hidden = false;
    this.id = '';
    this.dataset = {};
    this.listeners = {};
  }
  get classList() {
    const self = this;
    const parts = () => self.className.split(/\s+/).filter(Boolean);
    return {
      contains(c) { return parts().indexOf(c) >= 0; },
      add(c) { if (parts().indexOf(c) < 0) self.className = parts().concat(c).join(' '); },
      remove(c) { self.className = parts().filter((p) => p !== c).join(' '); },
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
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  replaceChild(nc, oc) {
    const i = this.childNodes.indexOf(oc);
    if (i < 0) return oc;
    oc.parentNode = null;
    nc.parentNode = this;
    this.childNodes[i] = nc;
    return oc;
  }
  contains(n) {
    if (n === this) return true;
    for (const c of this.childNodes) if (c.contains(n)) return true;
    return false;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (matchesSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { const a = this.querySelectorAll(sel); return a.length ? a[0] : null; }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  fire(type, ev) { (this.listeners[type] || []).slice().forEach((fn) => fn(ev)); }
}

function makeEnv() {
  const byId = {};
  const body = new FakeNode('body');
  const doc = {
    body: body,
    createElement(tag) { return new FakeNode(tag); },
    getElementById(id) { return byId[id] || null; },
    addEventListener() {},
  };
  function addId(id, tag) {
    const n = new FakeNode(tag || 'div');
    n.id = id;
    byId[id] = n;
    body.appendChild(n);
    return n;
  }
  const tip = addId('clue-tip');
  const stream = addId('stream');
  const panel = addId('panel');
  addId('attr-tip');
  const scrollCalls = [], timers = [], lockCalls = [];
  const win = { innerWidth: 1440, innerHeight: 900 };
  const sandbox = {
    document: doc, window: win,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    scrollToTurnStart(n) { scrollCalls.push(n); },
    syncBodyScrollLock() { lockCalls.push(true); },
  };
  vm.createContext(sandbox);
  vm.runInContext(corePre + '\n' + clueSrc + '\n' + chipSrc, sandbox);
  function chip(kind, text, turn) {
    const cls = kind === 'mark' ? 'mark-chip' : (kind === 'thread' ? 'thread-item' : 'rumor-item');
    return sandbox.clueChip(kind === 'mark' ? 'span' : 'div', cls, text, kind, text, turn);
  }
  function parts() {
    return {
      name: tip.querySelector('.clue-tip-name'),
      desc: tip.querySelector('.clue-tip-desc'),
      note: tip.querySelector('.clue-tip-note'),
      turn: tip.querySelector('.clue-tip-turn'),
      jump: tip.querySelector('.clue-tip-jump'),
      hint: tip.querySelector('.clue-tip-hint'),
    };
  }
  function actionLine(turn) {
    const n = doc.createElement('p');
    n.className = 'action-line';
    n.setAttribute('data-turn', String(turn));
    stream.appendChild(n);
    return n;
  }
  return { s: sandbox, doc, tip, stream, panel, win, byId, scrollCalls, timers, lockCalls, chip, parts, actionLine };
}

test('clueChip 真实函数：条目带 data-clue / kind / text / turn / role / tabindex', () => {
  const env = makeEnv();
  const n = env.chip('mark', '左臂刀伤', 2);
  assert.equal(n.getAttribute('data-clue'), '1');
  assert.equal(n.getAttribute('data-clue-kind'), 'mark');
  assert.equal(n.getAttribute('data-clue-text'), '左臂刀伤', '存完整文字');
  assert.equal(n.getAttribute('data-clue-turn'), '2');
  assert.equal(n.getAttribute('role'), 'button');
  assert.equal(n.getAttribute('tabindex'), '0');
  const old = env.chip('thread', '密信', undefined);
  assert.equal(old.getAttribute('data-clue-turn'), null, '老数据无回合号当未知，不标 data-clue-turn');
});

test('clueTipContent 纯逻辑：三种 kind 的标题/说明、有/无回合号', () => {
  const env = makeEnv();
  const c = env.s.clueTipContent;
  assert.equal(c('mark', '印记', 2).title, '身上的印记');
  assert.equal(c('mark', '印记', 2).note, '会一直影响后面的剧情，直到了结');
  assert.equal(c('mark', '印记', 2).body, '印记');
  assert.equal(c('mark', '印记', 2).turnText, '第 2 回合出现');
  assert.equal(c('thread', '线索', null).title, '未解之谜');
  assert.equal(c('thread', '线索', null).note, '还没解开，后面会有进展');
  assert.equal(c('thread', '线索', null).hasTurn, false);
  assert.equal(c('thread', '线索', null).turnText, '');
  assert.equal(c('rumor', '传闻', 7).title, '坊间传闻');
  assert.equal(c('rumor', '传闻', 7).note, '真假难辨的风声');
  assert.equal(c('rumor', '传闻', 7).turnText, '第 7 回合出现');
  assert.equal(c('rumor', '传闻', 7).jumpLabel, '跳到那一回合');
});

test('clueJumpAction 纯逻辑：找到 / 找不到两种动作', () => {
  const env = makeEnv();
  assert.equal(env.s.clueJumpAction(true).found, true);
  const miss = env.s.clueJumpAction(false);
  assert.equal(miss.found, false);
  assert.equal(miss.hint, '这一回合较早，往上翻翻能找到');
});

test('点印记打开卡片：标题「身上的印记」/ 完整文字 / 说明 / 回合 / 跳转按钮', () => {
  const env = makeEnv();
  env.s.onClueDocumentClick({ target: env.chip('mark', '左臂刀伤', 2) });
  const p = env.parts();
  assert.equal(env.tip.hidden, false, '卡片打开');
  assert.equal(p.name.textContent, '身上的印记');
  assert.equal(p.desc.textContent, '左臂刀伤', '正文是这条的完整文字');
  assert.equal(p.note.textContent, '会一直影响后面的剧情，直到了结');
  assert.equal(p.turn.textContent, '第 2 回合出现');
  assert.ok(p.jump, '有回合号时有「跳到那一回合」按钮');
  assert.equal(p.jump.textContent, '跳到那一回合');
  assert.equal(p.jump.getAttribute('data-clue-turn'), '2');
});

test('点线索（无回合号）：标题「未解之谜」/ 说明正确 / 没有跳转按钮', () => {
  const env = makeEnv();
  env.s.onClueDocumentClick({ target: env.chip('thread', '那封密信是谁写的', undefined) });
  const p = env.parts();
  assert.equal(p.name.textContent, '未解之谜');
  assert.equal(p.desc.textContent, '那封密信是谁写的');
  assert.equal(p.note.textContent, '还没解开，后面会有进展');
  assert.equal(p.turn, null, '没有「第 N 回合出现」');
  assert.equal(p.jump, null, '没有「跳到那一回合」按钮');
});

test('点传闻（有回合号）：标题「坊间传闻」/ 说明 / 跳转按钮', () => {
  const env = makeEnv();
  env.s.onClueDocumentClick({ target: env.chip('rumor', '城外夜里有人影', 7) });
  const p = env.parts();
  assert.equal(p.name.textContent, '坊间传闻');
  assert.equal(p.desc.textContent, '城外夜里有人影');
  assert.equal(p.note.textContent, '真假难辨的风声');
  assert.equal(p.turn.textContent, '第 7 回合出现');
  assert.ok(p.jump);
});

test('Enter / 空格 也能触发打开卡片（role=button 键盘可达）', () => {
  const env = makeEnv();
  const chip = env.chip('mark', '旧伤', 1);
  env.s.onClueKeyDown({ key: 'Enter', target: chip, preventDefault() {} });
  assert.equal(env.tip.hidden, false, 'Enter 打开');
  assert.equal(env.parts().name.textContent, '身上的印记');
  env.s.hideClueTip();
  env.s.onClueKeyDown({ key: ' ', target: chip, preventDefault() {} });
  assert.equal(env.tip.hidden, false, '空格打开');
  env.s.hideClueTip();
  env.s.onClueKeyDown({ key: 'a', target: chip, preventDefault() {} });
  assert.equal(env.tip.hidden, true, '其他键不打开');
});

test('Escape 关闭 / 点卡片外关闭 / 点卡片内保持打开', () => {
  const env = makeEnv();
  const chip = env.chip('thread', '密信', 4);
  env.s.onClueDocumentClick({ target: chip });
  const inside = env.parts().name;
  env.s.onClueDocumentClick({ target: inside });
  assert.equal(env.tip.hidden, false, '点卡片内部保持打开');
  const outside = env.doc.createElement('div');
  env.s.onClueDocumentClick({ target: outside });
  assert.equal(env.tip.hidden, true, '点卡片外关闭');
  env.s.onClueDocumentClick({ target: chip });
  env.s.onClueKeyDown({ key: 'Escape', target: outside });
  assert.equal(env.tip.hidden, true, 'Escape 关闭');
});

test('跳转找到：滚到目标行动行、加 .flash-turn 1.5 秒、关卡片', () => {
  const env = makeEnv();
  const line = env.actionLine(3);
  const other = env.actionLine(5);
  env.s.onClueDocumentClick({ target: env.chip('mark', '印记', 3) });
  env.tip.querySelector('.clue-tip-jump').fire('click', { stopPropagation() {} });
  assert.equal(env.tip.hidden, true, '跳转后关闭卡片');
  assert.ok(line.classList.contains('flash-turn'), '目标行动行加 flash-turn');
  assert.ok(!other.classList.contains('flash-turn'), '其它回合不高亮');
  assert.equal(env.scrollCalls.length, 1, '滚动一次（复用 scrollToTurnStart）');
  assert.equal(env.scrollCalls[0], line, '滚到 data-turn=3 的那条');
  assert.equal(env.timers.length, 1, '设了 1.5 秒移除高亮');
  assert.equal(env.timers[0].ms, 1500);
  env.timers[0].fn();
  assert.ok(!line.classList.contains('flash-turn'), '1.5 秒后移除高亮');
});

test('跳转找到（手机）：同时关闭角色面板抽屉', () => {
  const env = makeEnv();
  env.win.innerWidth = 500;
  env.panel.dataset.open = 'true';
  env.actionLine(3);
  env.s.onClueDocumentClick({ target: env.chip('rumor', '风声', 3) });
  env.tip.querySelector('.clue-tip-jump').fire('click', { stopPropagation() {} });
  assert.equal(env.panel.dataset.open, 'false', '手机收起角色面板抽屉');
  assert.ok(env.lockCalls.length > 0, '恢复背景滚动');
});

test('跳转找不到：按钮换成「这一回合较早，往上翻翻能找到」、卡片仍开、不滚动', () => {
  const env = makeEnv();
  env.actionLine(1); // 只有较早加载的回合，没有 99
  env.s.onClueDocumentClick({ target: env.chip('thread', '密信', 99) });
  env.tip.querySelector('.clue-tip-jump').fire('click', { stopPropagation() {} });
  assert.equal(env.tip.hidden, false, '卡片仍开着');
  assert.equal(env.tip.querySelector('.clue-tip-jump'), null, '按钮被换掉');
  const hint = env.tip.querySelector('.clue-tip-hint');
  assert.ok(hint, '换成提示');
  assert.equal(hint.textContent, '这一回合较早，往上翻翻能找到');
  assert.equal(env.scrollCalls.length, 0, '找不到就不滚动');
});
