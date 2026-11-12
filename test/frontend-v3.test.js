'use strict';

// 叙事 v3 前端配套：静态检查源文件文本 + vm/最小假 DOM 真实执行抽出的函数。
// 做法与 frontend-panel.test.js 一致：加载 core.js + images.js + game.js，覆盖 api/toast 观测。
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
const imagesJs = read('js/images.js');
const gameJs = read('js/game.js');
const mainJs = read('js/main.js');

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

// ---------------------------------------------------------------- 静态检查
test('index.html：g-chapter / menu-writing / menu-writing-name / g-writing 都在且默认 hidden', () => {
  assert.match(html, /<span id="g-chapter" class="g-chapter" hidden>/, 'g-chapter 默认 hidden');
  assert.match(html, /id="menu-writing"[^>]*data-menu="writing"[^>]*hidden>/, 'menu-writing 默认 hidden');
  assert.match(html, /id="menu-writing-name"/, '应有可更新的写作名元素');
  assert.match(html, /id="g-writing"[^>]*hidden>/, 'g-writing 默认 hidden');
  assert.match(html, /id="pending-label"/, '#pending 提示文字应有独立元素');
});

test('main.js：writing 菜单分发与 #g-writing 点击绑定', () => {
  assert.match(mainJs, /act === 'writing'/, '⋯ 菜单应分发 writing');
  assert.match(mainJs, /\$\('g-writing'\)\.addEventListener\('click'/, '应绑定 #g-writing');
  assert.match(mainJs, /cycleWriting\(\)/, '两处都调用 cycleWriting');
});

test('game.js：thinking 事件、正在构思这一节、世界在回应复位、三种 toast 文案', () => {
  assert.match(gameJs, /event === 'thinking'/, 'streamTurn 应处理 thinking 事件');
  assert.match(gameJs, /正在构思这一节/, 'thinking 时提示「正在构思这一节…」');
  assert.match(gameJs, /setPendingLabel\('世界在回应…'\)/, '第一个 delta / 回合开始复位「世界在回应…」');
  assert.match(gameJs, /精写：强模型简单构思再写，第一句约 10~30 秒/);
  assert.match(gameJs, /深度精写：强模型深思后再写，第一句可能要一分钟/);
  assert.match(gameJs, /快写：不构思直接写，第一句几秒就出/);
});

test('game.js：章节分隔 / 顶栏章名 / 章节回顾 / v3 隐藏编年史 的关键结构', () => {
  assert.match(gameJs, /var lastChapterShown = 0/, '模块变量 lastChapterShown');
  assert.match(gameJs, /function appendChapterDivider/, '章名分隔构建函数');
  assert.match(gameJs, /showChapterFromRecord\(rec\)/, '回放记录按 chapter 插分隔');
  assert.match(gameJs, /showChapterForTurn\(\)/, '新回合按 currentState 插分隔');
  assert.match(gameJs, /\$\('g-chapter'\)/, 'renderHeader 切换顶栏章名');
  assert.match(gameJs, /章节回顾/, '线索页章节回顾');
  assert.match(gameJs, /if \(!s\.chapter\)/, 'v3 世界隐藏原编年史折叠段');
});

test('app.css：.chapter-divider / .g-chapter / .chapter-recap，手机隐藏 #g-writing', () => {
  assert.match(css, /\.chapter-divider\{/, '章名分隔样式');
  assert.match(css, /\.chapter-divider::before/, '两侧细线');
  assert.match(css, /rgba\(var\(--g-accent-rgb,192,57,43\),\.4\)/, '细线用 g-accent 变量');
  assert.match(css, /body\[data-genre\] \.g-chapter/, '顶栏章名胶囊');
  assert.match(css, /\.chapter-recap\{/, '章节回顾样式');
  assert.match(mb, /#g-writing\s*\{\s*display:none/, '手机隐藏 #g-writing');
  assert.match(mb, /\.chapter-name\s*\{\s*font-size:16px/, '手机章名 16px');
});

// ---------------------------------------------------------------- 假 DOM
function matches(node, sel) {
  sel = sel.trim();
  if (!sel) return false;
  var attr = null;
  var am = sel.match(/\[([A-Za-z-]+)(?:="?([^"\]]*)"?)?\]$/);
  if (am) {
    attr = { key: am[1], val: am[2] };
    sel = sel.slice(0, am.index).trim();
  }
  var ok = true;
  if (sel) {
    if (sel.charAt(0) === '#') ok = node.id === sel.slice(1);
    else if (sel.charAt(0) === '.') {
      ok = sel.slice(1).split('.').every(function (c) {
        return c && node.classList && node.classList.contains(c);
      });
    } else {
      var tm = sel.match(/^([A-Za-z0-9]+)(?:\.(.+))?$/);
      ok = !!tm && node.tagName === tm[1].toUpperCase()
        && (!tm[2] || (node.classList && node.classList.contains(tm[2])));
    }
  }
  if (!ok) return false;
  if (attr) {
    var av = node.getAttribute ? node.getAttribute(attr.key) : null;
    if (av === null) return false;
    if (attr.val !== undefined && av !== attr.val) return false;
  }
  return true;
}
function findAll(rootNode, sel) {
  const out = [];
  const sels = sel.split(',').map(function (s) { return s.trim(); });
  (function walk(n) {
    for (var i = 0; i < n.childNodes.length; i++) {
      var c = n.childNodes[i];
      if (sels.some(function (s) { return matches(c, s); })) out.push(c);
      walk(c);
    }
  })(rootNode);
  return out;
}
function findOne(rootNode, sel) { return findAll(rootNode, sel)[0] || null; }

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = '';
    this.id = '';
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this._text = '';
    this.hidden = false;
    this.value = '';
    this.type = '';
    this.disabled = false;
    this.__rootConnected = false;
    this.__doc = null;
  }
  get isConnected() {
    let n = this;
    while (n) { if (n.__rootConnected) return true; n = n.parentNode; }
    return false;
  }
  get children() { return this.childNodes.slice(); }
  get firstChild() { return this.childNodes[0] || null; }
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
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'id') this.id = String(v);
    else if (k === 'class') this.className = String(v);
    else if (k.indexOf('data-') === 0) {
      const key = k.slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
      this.dataset[key] = String(v);
    }
  }
  getAttribute(k) {
    if (k === 'id' && this.id) return this.id;
    if (k === 'class' && this.className) return this.className;
    return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
  }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  contains(node) {
    if (node === this) return true;
    for (const c of this.childNodes) if (c.contains(node)) return true;
    return false;
  }
  get classList() {
    const self = this;
    const parts = function () { return self.className.split(/\s+/).filter(Boolean); };
    return {
      add(c) { if (!parts().includes(c)) self.className = parts().concat(c).join(' '); },
      remove(c) { self.className = parts().filter(function (x) { return x !== c; }).join(' '); },
      contains(c) { return parts().includes(c); },
    };
  }
  querySelector(sel) { return findOne(this, sel); }
  querySelectorAll(sel) { return findAll(this, sel); }
  getClientRects() { return [{ width: 1, height: 1 }]; }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.stopPropagation = ev.stopPropagation || function () { ev.__stopped = true; };
    ev.preventDefault = ev.preventDefault || function () {};
    const chain = [];
    let node = this;
    while (node) { chain.push(node); node = node.parentNode; }
    for (var i = 0; i < chain.length; i++) {
      const fns = (chain[i].listeners && chain[i].listeners[ev.type])
        ? chain[i].listeners[ev.type].slice() : [];
      for (var j = 0; j < fns.length; j++) fns[j](ev);
      if (ev.__stopped) break;
    }
  }
  click() { this.dispatchEvent({ type: 'click' }); }
}

function makeDoc() {
  const doc = {
    activeElement: null, listeners: {},
    createElement(tag) { const n = new FakeNode(tag); n.__doc = doc; return n; },
    createElementNS(ns, tag) { const n = new FakeNode(tag); n.__doc = doc; n.__ns = ns; return n; },
    getElementById(id) { return findOne(doc.documentElement, '#' + id); },
    querySelector(sel) { return findOne(doc.documentElement, sel); },
    querySelectorAll(sel) { return findAll(doc.documentElement, sel); },
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
  };
  const rootNode = new FakeNode('html');
  rootNode.__doc = doc; rootNode.__rootConnected = true;
  const body = new FakeNode('body');
  body.__doc = doc;
  rootNode.appendChild(body);
  doc.documentElement = rootNode;
  doc.body = body;
  return { doc, body };
}

function setup() {
  const made = makeDoc();
  const doc = made.doc, body = made.body;
  function addId(id, tag) {
    const n = doc.createElement(tag || 'div');
    n.id = id;
    body.appendChild(n);
    return n;
  }
  ['panel', 'top-attrs', 'stream', 'toast', 'image-viewer', 'attr-tip',
    'pending', 'pending-label', 'pending-secs', 'g-chapter', 'g-place',
    'g-title', 'g-life', 'g-turn', 'g-subtitle', 'g-omen', 'g-danger',
    'menu-genre-name', 'g-genre', 'menu-writing', 'menu-writing-name', 'g-writing']
    .forEach(function (id) { addId(id); });
  addId('action-input', 'textarea');

  const apiCalls = [];
  const toasts = [];
  let apiImpl = function () { return {}; };
  const win = { innerWidth: 1440, innerHeight: 900, addEventListener() {} };
  const sandbox = {
    document: doc, window: win, location: { href: '', hash: '#/w/w1' },
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
    },
    fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }),
    Event: function (t) { this.type = t; },
    console: console,
    setTimeout() { return 0; }, clearTimeout() {},
    setInterval() { return 0; }, clearInterval() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(coreJs, sandbox, { filename: 'core.js' });
  vm.runInContext(imagesJs, sandbox, { filename: 'images.js' });
  vm.runInContext(gameJs, sandbox, { filename: 'game.js' });
  sandbox.api = function (p, o) {
    apiCalls.push({ path: p, opts: o || {} });
    return Promise.resolve(apiImpl(p, o));
  };
  sandbox.toast = function (m) { toasts.push(m); };
  return {
    s: sandbox, doc, body, apiCalls, toasts,
    stream: doc.getElementById('stream'),
    setApi(fn) { apiImpl = fn; },
  };
}

// ---------------------------------------------------------------- 行为测试
test('章分隔：连续两条同章记录只插一次，换章再插；章名为空只显示「第 N 章」', () => {
  const h = setup();
  h.s.appendLogRecord({ chapter: { index: 1, title: '初入' } });
  h.s.appendLogRecord({ chapter: { index: 1, title: '初入' } });
  assert.equal(h.stream.querySelectorAll('.chapter-divider').length, 1, '同章只插一次');

  const d1 = h.stream.querySelector('.chapter-divider');
  assert.match(d1.querySelector('.chapter-no').textContent, /第 1 章/);
  assert.match(d1.querySelector('.chapter-name').textContent, /初入/);

  h.s.appendLogRecord({ chapter: { index: 2, title: '风起' } });
  assert.equal(h.stream.querySelectorAll('.chapter-divider').length, 2, '换章再插一条');

  h.s.appendLogRecord({ chapter: { index: 3, title: '' } });
  const divs = h.stream.querySelectorAll('.chapter-divider');
  assert.equal(divs.length, 3);
  assert.equal(divs[2].querySelector('.chapter-name'), null, '章名为空不显示 .chapter-name');
  assert.match(divs[2].querySelector('.chapter-no').textContent, /第 3 章/);
  assert.equal(h.s.lastChapterShown, 3);
});

test('章分隔：clearStream 重置 lastChapterShown，回放后重新插', () => {
  const h = setup();
  h.s.appendLogRecord({ chapter: { index: 2, title: '风起' } });
  assert.equal(h.stream.querySelectorAll('.chapter-divider').length, 1);
  assert.equal(h.s.lastChapterShown, 2);

  h.s.clearStream();
  assert.equal(h.s.lastChapterShown, 0, 'clearStream 复位为 0');
  assert.equal(h.stream.querySelectorAll('.chapter-divider').length, 0, '正文已清空');

  h.s.appendLogRecord({ chapter: { index: 2, title: '风起' } });
  assert.equal(h.stream.querySelectorAll('.chapter-divider').length, 1, '重画后重新插');
  assert.equal(h.s.lastChapterShown, 2);
});

test('章分隔：chapter 为空的 v2 记录不插', () => {
  const h = setup();
  h.s.appendLogRecord({});
  h.s.appendLogRecord({ chapter: null });
  h.s.appendLogRecord({ action: '', narration: null, timeSkip: null });
  assert.equal(h.stream.querySelectorAll('.chapter-divider').length, 0, 'v2 记录不插分隔');
  assert.equal(h.s.lastChapterShown, 0);
});

test('写作模式循环 fine→deep→fast→fine：POST /api/prefs、更新标签与三种 toast', async () => {
  const h = setup();
  h.setApi(function (p, o) {
    const body = JSON.parse(o.body);
    return { prefs: { writing: body.writing } };
  });

  // 纯函数：循环顺序（含缺省按 fine 处理）
  assert.equal(h.s.nextWritingMode('fine'), 'deep');
  assert.equal(h.s.nextWritingMode('deep'), 'fast');
  assert.equal(h.s.nextWritingMode('fast'), 'fine');
  assert.equal(h.s.nextWritingMode(undefined), 'deep');

  await h.s.cycleWriting(); // 精写（缺省）→ 深度精写
  assert.equal(JSON.parse(h.apiCalls[0].opts.body).writing, 'deep');
  assert.equal(h.s.myPrefs.writing, 'deep');
  assert.match(h.doc.getElementById('g-writing').textContent, /写作·深度精写/);
  assert.match(h.doc.getElementById('menu-writing-name').textContent, /深度精写/);

  await h.s.cycleWriting(); // 深度精写 → 快写
  assert.equal(JSON.parse(h.apiCalls[1].opts.body).writing, 'fast');
  assert.equal(h.s.myPrefs.writing, 'fast');

  await h.s.cycleWriting(); // 快写 → 精写
  assert.equal(JSON.parse(h.apiCalls[2].opts.body).writing, 'fine');
  assert.equal(h.s.myPrefs.writing, 'fine');

  assert.equal(h.apiCalls[0].path, '/api/prefs');
  assert.equal(h.apiCalls[0].opts.method, 'POST');
  assert.equal(h.apiCalls.length, 3);
  assert.ok(h.toasts.some(function (t) { return /深度精写：强模型深思后再写/.test(t); }));
  assert.ok(h.toasts.some(function (t) { return /快写：不构思直接写/.test(t); }));
  assert.ok(h.toasts.some(function (t) { return /精写：强模型简单构思再写/.test(t); }));
});

test('写作模式：保存失败时 toast 错误、文字不变', async () => {
  const h = setup();
  h.s.myPrefs.writing = 'fine';
  h.s.renderWritingLabels();
  h.setApi(function () { throw new Error('网络错误'); });
  await h.s.cycleWriting();
  assert.equal(h.s.myPrefs.writing, 'fine', '失败不改动 myPrefs.writing');
  assert.match(h.doc.getElementById('g-writing').textContent, /写作·精写/, '文字不变');
  assert.ok(h.toasts.indexOf('网络错误') >= 0, 'toast 错误信息');
});
