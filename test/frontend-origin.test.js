'use strict';

// 开新世界不再手动分点 / 序章卡选出身 / 角色卡补选 的前端测试。
// 做法：vm + 最小假 DOM 真实执行抽出得到的函数；抽不出的用静态检查兜底。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
const coreJs = read('js/core.js');
const homeJs = read('js/home.js');
const prologueJs = read('js/prologue.js');
const gameJs = read('js/game.js');
const imagesJs = read('js/images.js');
const mainJs = read('js/main.js');
const html = read('index.html');
const css = read('app.css');
const jsAll = [coreJs, homeJs, prologueJs, gameJs, imagesJs, mainJs].join('\n');

// ---------------------------------------------------------------- 最小假 DOM
function matches(node, sel) {
  sel = sel.trim();
  if (!sel) return false;
  var attr = null;
  var am = sel.match(/\[([A-Za-z-]+)(?:="?([^"\]]*)"?)?\]$/);
  if (am) { attr = { key: am[1], val: am[2] }; sel = sel.slice(0, am.index).trim(); }
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
    this.alt = '';
    this.src = '';
    this.disabled = false;
    this.__rootConnected = false;
    this.__doc = null;
  }
  get children() { return this.childNodes.slice(); }
  get firstChild() { return this.childNodes[0] || null; }
  get childElementCount() { return this.childNodes.length; }
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
      toggle(c, force) {
        const on = force === undefined ? !parts().includes(c) : !!force;
        if (on) { if (!parts().includes(c)) self.className = parts().concat(c).join(' '); }
        else self.className = parts().filter(function (x) { return x !== c; }).join(' ');
      },
      contains(c) { return parts().includes(c); },
    };
  }
  querySelector(sel) { return findOne(this, sel); }
  querySelectorAll(sel) { return findAll(this, sel); }
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
    const D = this.__doc;
    if (!ev.__stopped && D && D.listeners && D.listeners[ev.type]) {
      for (var k = 0; k < D.listeners[ev.type].length; k++) D.listeners[ev.type][k](ev);
    }
  }
  click() { this.dispatchEvent({ type: 'click' }); }
}

function makeDoc() {
  const doc = {
    activeElement: null, listeners: {},
    createElement(tag) { const n = new FakeNode(tag); n.__doc = doc; return n; },
    createElementNS(ns, tag) { const n = new FakeNode(tag); n.__doc = doc; return n; },
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

const BASE_IDS = [
  'panel', 'top-attrs', 'stream', 'toast', 'image-viewer', 'attr-tip', 'action-input',
  'seed', 'char-name', 'char-appearance', 'char-identity', 'identity-dice',
  'creating', 'btn-create', 'presets', 'genre-row',
];

function setup(files) {
  const made = makeDoc();
  const doc = made.doc, body = made.body;
  function addId(id, tag) {
    const n = doc.createElement(tag || 'div');
    n.id = id;
    body.appendChild(n);
    return n;
  }
  BASE_IDS.forEach(function (id) { addId(id); });

  const ls = {
    _v: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = String(v); },
  };
  const timers = [];
  let tid = 0;
  const apiCalls = [];
  const toasts = [];
  let apiImpl = function () { return Promise.resolve({ id: 'w1' }); };
  const win = {
    innerWidth: 1440, innerHeight: 900,
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 0; },
    matchMedia() { return { matches: false }; }, scrollTo() {},
  };
  const sandbox = {
    document: doc, window: win, location: { href: '', hash: '#/' },
    localStorage: ls,
    fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }),
    Event: function (t) { this.type = t; },
    console: console,
    setTimeout(fn, ms) { const t = { fn, ms, id: ++tid, cleared: false }; timers.push(t); return t.id; },
    clearTimeout(id) { for (const t of timers) if (t.id === id) t.cleared = true; },
    setInterval() { return 0; },
    clearInterval() {},
  };
  vm.createContext(sandbox);
  files.forEach(function (f) {
    vm.runInContext(read('js/' + f), sandbox, { filename: f });
  });
  sandbox.api = function (p, o) {
    apiCalls.push({ path: p, opts: o || {} });
    return Promise.resolve(apiImpl(p, o));
  };
  sandbox.toast = function (m) { toasts.push(m); };
  sandbox.syncBodyScrollLock = function () {};
  return {
    s: sandbox, doc, body, win, ls, timers, apiCalls, toasts, addId,
    setApi(fn) { apiImpl = fn; },
  };
}

// 序章四段齐全的假序章
const PROLOGUE = { world: '世界', me: '你', goal: '愿望', now: '此刻' };
// 与后端 normalizeOrigins 后的结构一致：alloc 合计 6、单项 0..3
const ORIGINS = [
  { title: '镖局少主', blurb: '走南闯北，刀口舔血', style: '冒险', custom: true,
    alloc: { 体魄: 2, 心智: 1, 魅力: 3, 气运: 0, 声望: 0, 资源: 0 },
    item: { name: '镖旗', desc: '一面旧镖旗', type: '信物' } },
  { title: '账房先生', blurb: '精打细算，账本不离手', style: '审慎', custom: false,
    alloc: { 体魄: 0, 心智: 3, 魅力: 0, 气运: 0, 声望: 1, 资源: 2 }, item: null },
  { title: '云游道士', blurb: '看淡世事，一蓑烟雨', style: '秩序', custom: false,
    alloc: { 体魄: 0, 心智: 0, 魅力: 0, 气运: 3, 声望: 3, 资源: 0 },
    item: { name: '旧符', desc: '', type: '' } },
];

// ---------------------------------------------------------------- 静态检查
test('新世界页：删除属性分配整块，新增「你是谁」与换一个按钮', () => {
  for (const s of ['id="alloc"', 'id="btn-random"', 'id="points-left"', 'alloc-head', 'class="hint"']) {
    assert.equal(html.includes(s), false, 'index.html 不应再有 ' + s);
  }
  assert.match(html, /id="char-identity"[^>]*maxlength="80"/, '应有 char-identity 且限长 80');
  assert.match(html, /id="identity-dice"/, '应有换一个按钮');
  assert.match(html, /placeholder="不填由 AI 起名"/, '名字占位应改为不填由 AI 起名');
  assert.match(html, /placeholder="可不填"/, '形象占位应改为可不填');
  for (const s of ['initAlloc', 'randomAlloc', 'updatePoints', 'btn-random', 'points-left', '请分配完', 'alloc: alloc']) {
    assert.equal(homeJs.includes(s), false, 'home.js 不应再有 ' + s);
  }
  assert.match(homeJs, /identity/, 'createWorld 应带 identity');
  assert.match(homeJs, /genre:\s*selectedGenre/, 'body 仍应带 genre');
  assert.match(homeJs, /IDENTITY_SAMPLES/, '应有一组示例身份');
  assert.match(homeJs, /onIdentityDice/, '应有换一个处理函数');
  assert.match(mainJs, /\$\('identity-dice'\)\.addEventListener/, 'main.js 应绑定换一个按钮');
  assert.equal(/btn-random|randomAlloc/.test(mainJs), false, 'main.js 不应再绑定随机分配');
  assert.equal(/\.alloc|#points-left|#btn-random|\.hint\{/.test(css), false, 'app.css 不应再有 alloc 规则');
});

test('出身选择 CSS：卡片网格、三列宽屏、角色卡徽章/补选按钮', () => {
  assert.match(css, /\.prologue-origins\{/, '应有 .prologue-origins');
  assert.match(css, /\.origin-card\{/, '应有 .origin-card');
  assert.match(css, /\.origin-tag\.recommend/, '应有推荐标签样式');
  assert.match(css, /\.char-origin\{/, '应有出身徽章样式');
  assert.match(css, /\.char-origin-pick\{/, '应有补选按钮样式');
  assert.match(css, /grid-template-columns:repeat\(3,1fr\)/, '宽屏三列网格');
  assert.match(css, /\.char-origin-pick\{min-height:40px\}/, '手机补选按钮 ≥40px');
});

test('序章卡 / game.js：选出身接线', () => {
  assert.match(prologueJs, /function showPrologue\(title, prologue, onStart, opts\)/, '应有第 4 个参数 opts');
  assert.match(prologueJs, /opts\.onChoose/, '应调用 onChoose');
  assert.match(prologueJs, /先选一个出身/, '未选时按钮禁用文案');
  assert.match(prologueJs, /以「/, '选中后按钮文案');
  assert.match(prologueJs, /aria-pressed/, '应有 aria-pressed 选中态');
  assert.equal(/\.innerHTML/.test(jsAll), false, 'public/js 不得出现 innerHTML');
  assert.match(gameJs, /\/origin'/, '应有 POST /origin');
  assert.match(gameJs, /originRecommend/, '应有推荐下标计算');
  assert.match(gameJs, /buildPrologueOpts/, '应有构造 opts 的函数');
  assert.match(gameJs, /!seen \|\| needPick/, '看过序章但未选出身也要弹');
  assert.match(gameJs, /char-origin-pick/, '角色卡应有补选按钮');
});

// ---------------------------------------------------------------- createWorld 请求体
test('createWorld：请求体不含 alloc，空名字/形象/身份不传，带 identity', async () => {
  const h = setup(['core.js', 'home.js', 'build-modal.js']);
  h.doc.getElementById('seed').value = '蒸汽朋克长安';
  // 建世界请求先挂着，看弹窗和进度轮询。
  let release;
  h.setApi(function (p, o) {
    if (o && o.method === 'POST') return new Promise((r) => { release = () => r({ id: 'w1' }); });
    return { stages: [] };
  });
  const run = h.s.createWorld();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(findOne(h.body, '#build-mask'), '开了等待弹窗');
  // 弹窗每秒 GET 一次进度（先等 700ms：服务器还没开始记进度时查会是 404），建世界本身只 POST 一次。
  const posts = () => h.apiCalls.filter((c) => c.opts.method === 'POST');
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].path, '/api/worlds');
  const body = JSON.parse(posts()[0].opts.body);
  const firstPoll = h.timers.find((x) => x.ms === 700);
  assert.ok(firstPoll, '排了首次轮询');
  firstPoll.fn();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.ok(h.apiCalls.some((c) => c.path === '/api/build-progress?cid=' + body.clientRequestId), '轮询进度');
  release();
  await run;
  h.setApi(function () { return { id: 'w1' }; });
  assert.equal(body.seed, '蒸汽朋克长安');
  assert.match(body.clientRequestId, /^w[a-z0-9]{8,40}$/, '带建世界请求 ID');
  assert.ok('genre' in body);
  assert.equal('alloc' in body, false, '请求体不得含 alloc');
  assert.equal('name' in body, false, '空名字不传');
  assert.equal('appearance' in body, false, '空形象不传');
  assert.equal('identity' in body, false, '空身份不传');
  assert.equal(h.doc.getElementById('btn-create').disabled, false, '按钮不再因点数禁用');

  // 三个都填：都带上，仍无 alloc
  h.doc.getElementById('char-name').value = '  阿岚  ';
  h.doc.getElementById('char-appearance').value = ' 灰袍 ';
  h.doc.getElementById('char-identity').value = ' 欠债的退伍兵 ';
  await h.s.createWorld();
  const body2 = JSON.parse(posts()[1].opts.body);
  assert.notEqual(body2.clientRequestId, body.clientRequestId, '每次建世界换新 ID');
  assert.equal(body2.name, '阿岚', '名字 trim');
  assert.equal(body2.appearance, '灰袍', '形象 trim');
  assert.equal(body2.identity, '欠债的退伍兵', '身份 trim');
  assert.equal('alloc' in body2, false);
});

test('createWorld：断网后带同一个 ID 重发，建好后进世界；失败时弹窗给「重试」「关闭」', async () => {
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  const fire = (ms) => {
    const t = h.timers.find((x) => x.ms === ms && !x.cleared && !x.fired);
    assert.ok(t, '应排了 ' + ms + 'ms 的定时器');
    t.fired = true;
    t.fn();
  };
  const h = setup(['core.js', 'home.js', 'build-modal.js']);
  h.s.location.hash = '#/new';
  h.doc.getElementById('seed').value = '雨夜旧港';
  let n = 0;
  h.setApi(function (p, o) {
    if (o && o.method === 'POST') {
      n++;
      if (n === 1) return Promise.reject(Object.assign(new Error('网络断了'), { network: true }));
      if (n === 2) return Promise.reject(Object.assign(new Error('网关超时'), { status: 524 }));
      return { id: 'w9' };
    }
    return Promise.reject(Object.assign(new Error('没有找到'), { status: 404 }));
  });
  const run = h.s.createWorld();
  await flush();
  fire(3000);
  await flush();
  fire(3000);
  await run;
  const posts = h.apiCalls.filter((c) => c.opts.method === 'POST').map((c) => JSON.parse(c.opts.body).clientRequestId);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts).size, 1, '三次都是同一个 ID');
  assert.equal(findOne(h.body, '.build-title').textContent, '世界成形了');
  fire(500);
  assert.equal(h.s.location.hash, '#/w/w9');
  assert.equal(findOne(h.body, '#build-mask'), null, '进世界前收起弹窗');

  // 服务器明确报错（不是断网 / 网关超时）：不重发，弹窗显示原因和按钮
  h.setApi(function (p, o) {
    if (o && o.method === 'POST') return Promise.reject(Object.assign(new Error('模型挂了'), { status: 502 }));
    return Promise.reject(Object.assign(new Error('没有找到'), { status: 404 }));
  });
  h.s.location.hash = '#/new';
  const before = h.apiCalls.filter((c) => c.opts.method === 'POST').length;
  await h.s.createWorld();
  assert.equal(h.apiCalls.filter((c) => c.opts.method === 'POST').length - before, 1, '不重发');
  assert.equal(findOne(h.body, '.build-title').textContent, '这次没建成');
  assert.equal(findOne(h.body, '.build-status').textContent, '模型挂了');
  const btns = findAll(findOne(h.body, '.build-actions'), '.btn');
  assert.deepEqual(btns.map((b) => b.textContent), ['关闭', '重试']);
  assert.equal(h.doc.getElementById('btn-create').disabled, false);
});

test('createWorld：seed 为空只 toast、不发请求', async () => {
  const h = setup(['core.js', 'home.js']);
  h.doc.getElementById('seed').value = '   ';
  await h.s.createWorld();
  assert.equal(h.apiCalls.length, 0);
  assert.ok(h.toasts.some(function (m) { return /世界观/.test(m); }));
});

// ---------------------------------------------------------------- 序章卡选出身
test('showPrologue：有 origins 时渲染出身卡（数量、custom、recommend、属性只列 >0、物品）', () => {
  const h = setup(['core.js', 'prologue.js']);
  const mask = h.s.showPrologue('世界名', PROLOGUE, null, {
    origins: ORIGINS, chosen: false, recommend: 2, onChoose: function () { return Promise.resolve(); },
  });
  assert.ok(mask, '应返回遮罩');
  const sec = mask.querySelector('.prologue-origins');
  assert.ok(sec, '应有 .prologue-origins');
  assert.match(sec.querySelector('.prologue-sub').textContent, /选一个出身/);
  // 「你是谁」之后：DOM 顺序上出身段在「你想要的」之前
  const sections = mask.querySelectorAll('.prologue-section');
  assert.equal(sections.length, 4, '四段小标题仍在');

  const cards = mask.querySelectorAll('.origin-card');
  assert.equal(cards.length, 3, '三张出身卡');
  assert.deepEqual(cards.map(function (c) { return c.querySelector('.origin-title').textContent; }),
    ['镖局少主', '账房先生', '云游道士']);
  assert.ok(cards[0].querySelector('.origin-blurb').textContent.includes('走南闯北'));
  assert.equal(cards[0].getAttribute('data-index'), '0');
  assert.equal(cards[2].getAttribute('data-index'), '2');

  // custom 标签只出现在第 0 张；recommend 标签只出现在第 2 张
  assert.match(mask.querySelectorAll('.origin-tag')[0].textContent, /按你写的/);
  const recs = mask.querySelectorAll('.origin-tag.recommend');
  assert.equal(recs.length, 1, '只有一个最像你');
  assert.match(recs[0].textContent, /最像你/);
  assert.equal(cards[2].querySelectorAll('.origin-tag.recommend').length, 1);

  // 属性小标签只列 >0 的
  const a0 = cards[0].querySelector('.origin-attrs').querySelectorAll('span');
  assert.equal(a0.length, 3, '第 0 张只列 3 个 >0 属性');
  const a0text = a0.map(function (n) { return n.textContent; });
  assert.ok(a0text.includes('体魄 +2') && a0text.includes('心智 +1') && a0text.includes('魅力 +3'));
  assert.equal(a0text.some(function (t) { return /气运|声望|资源/.test(t); }), false, '0 点属性不显示');
  const a1 = cards[1].querySelector('.origin-attrs').querySelectorAll('span');
  assert.equal(a1.length, 3);

  // 物品
  assert.match(cards[0].querySelector('.origin-item').textContent, /带着：镖旗/);
  assert.equal(cards[1].querySelector('.origin-item'), null, '无 item 不渲染');
  assert.match(cards[2].querySelector('.origin-item').textContent, /带着：旧符/);
});

test('showPrologue：未选时开始按钮禁用；选中后文案变化、选中态正确', () => {
  const h = setup(['core.js', 'prologue.js']);
  const mask = h.s.showPrologue('T', PROLOGUE, null, {
    origins: ORIGINS, chosen: false, recommend: -1, onChoose: function () { return Promise.resolve(); },
  });
  const btn = mask.querySelector('.prologue-start');
  assert.equal(btn.disabled, true, '未选时按钮禁用');
  assert.match(btn.textContent, /先选一个出身/);

  const cards = mask.querySelectorAll('.origin-card');
  cards[0].click();
  assert.equal(btn.disabled, false, '选中后按钮可用');
  assert.match(btn.textContent, /以「镖局少主」开始/);
  assert.equal(cards[0].getAttribute('aria-pressed'), 'true');
  assert.ok(cards[0].classList.contains('selected'));
  assert.equal(cards[1].getAttribute('aria-pressed'), 'false');
  assert.ok(!cards[1].classList.contains('selected'));

  // 改选另一张，其余取消
  cards[2].click();
  assert.match(btn.textContent, /以「云游道士」开始/);
  assert.equal(cards[0].getAttribute('aria-pressed'), 'false');
  assert.ok(!cards[0].classList.contains('selected'));
  assert.equal(cards[2].getAttribute('aria-pressed'), 'true');
});

test('showPrologue：选中后点开始 await onChoose，成功才关闭并 onStart', async () => {
  const h = setup(['core.js', 'prologue.js']);
  let chosen = -1, started = 0;
  const mask = h.s.showPrologue('T', PROLOGUE, function () { started++; }, {
    origins: ORIGINS, chosen: false, recommend: -1,
    onChoose: function (i) { chosen = i; return Promise.resolve(); },
  });
  mask.querySelectorAll('.origin-card')[1].click();
  const btn = mask.querySelector('.prologue-start');
  await btn.listeners.click[0]({});
  assert.equal(chosen, 1, 'onChoose 收到下标');
  assert.equal(started, 1, '成功后 onStart');
  assert.equal(h.doc.getElementById('prologue-mask'), null, '成功后遮罩关闭');
});

test('showPrologue：onChoose 失败 toast 错误且不关闭卡片', async () => {
  const h = setup(['core.js', 'prologue.js']);
  let started = 0;
  const mask = h.s.showPrologue('T', PROLOGUE, function () { started++; }, {
    origins: ORIGINS, chosen: false, recommend: -1,
    onChoose: function () { return Promise.reject(new Error('出身选不了')); },
  });
  mask.querySelectorAll('.origin-card')[0].click();
  const btn = mask.querySelector('.prologue-start');
  await btn.listeners.click[0]({});
  assert.equal(started, 0, '失败不 onStart');
  assert.equal(h.doc.getElementById('prologue-mask'), mask, '失败不关闭卡片');
  assert.ok(h.toasts.some(function (m) { return /出身选不了/.test(m); }), '应 toast 错误');
  // 失败后按钮仍可用，可重试
  assert.equal(btn.disabled, false);
});

test('showPrologue：× 关闭与点遮罩仍可关闭（等于暂不选择）', () => {
  const h = setup(['core.js', 'prologue.js']);
  const mask = h.s.showPrologue('T', PROLOGUE, function () {}, {
    origins: ORIGINS, chosen: false, recommend: -1, onChoose: function () { return Promise.resolve(); },
  });
  const closeBtn = mask.querySelector('.sheet-close');
  closeBtn.click();
  assert.equal(h.doc.getElementById('prologue-mask'), null, '× 关闭');

  const mask2 = h.s.showPrologue('T', PROLOGUE, function () {}, {
    origins: ORIGINS, chosen: false, recommend: -1, onChoose: function () { return Promise.resolve(); },
  });
  // 直接派发到遮罩、target 指向遮罩自身，模拟点空白处
  mask2.listeners.click[0]({ target: mask2, stopPropagation: function () {}, preventDefault: function () {} });
  assert.equal(h.doc.getElementById('prologue-mask'), null, '点遮罩关闭');
});

test('showPrologue：chosen 为真 / origins 为空时和原来一样', () => {
  const h = setup(['core.js', 'prologue.js']);
  let started = 0;
  // chosen 为真：即使有 origins 也不渲染出身卡，按钮「开始」
  const m1 = h.s.showPrologue('T', PROLOGUE, function () { started++; }, {
    origins: ORIGINS, chosen: true, recommend: 1, onChoose: function () { return Promise.resolve(); },
  });
  assert.equal(m1.querySelectorAll('.origin-card').length, 0);
  assert.equal(m1.querySelector('.prologue-start').disabled, false);
  assert.match(m1.querySelector('.prologue-start').textContent, /开始/);
  m1.querySelector('.prologue-start').click();
  assert.equal(started, 1);

  // origins 为空：按钮「继续」
  const m2 = h.s.showPrologue('T', PROLOGUE, null, {
    origins: [], chosen: false, recommend: -1, onChoose: function () { return Promise.resolve(); },
  });
  assert.equal(m2.querySelectorAll('.origin-card').length, 0);
  assert.match(m2.querySelector('.prologue-start').textContent, /继续/);

  // 完全不传第 4 参数：依旧「继续」
  const m3 = h.s.showPrologue('T', PROLOGUE, null);
  assert.equal(m3.querySelectorAll('.origin-card').length, 0);
  assert.match(m3.querySelector('.prologue-start').textContent, /继续/);
});

// ---------------------------------------------------------------- 推荐下标
test('originRecommend：dims 最高维度 → style 匹配的第一个出身；无则 -1', () => {
  const h = setup(['core.js', 'images.js', 'prologue.js', 'game.js']);
  const origins = [
    { title: 'A', style: '审慎' },
    { title: 'B', style: '冒险' },
    { title: 'C', style: '冒险' },
  ];
  const hiAdventure = { ready: true, dims: { 冒险: 80, 审慎: 30, 共情: 20, 权谋: 10, 坚韧: 5, 秩序: 0 } };
  assert.equal(h.s.originRecommend(origins, hiAdventure), 1, '冒险最高 → 第一个冒险是下标 1');
  const hiPrudence = { ready: true, dims: { 冒险: 30, 审慎: 90, 共情: 20, 权谋: 10, 坚韧: 5, 秩序: 0 } };
  assert.equal(h.s.originRecommend(origins, hiPrudence), 0, '审慎最高 → 下标 0');
  assert.equal(h.s.originRecommend(origins, { ready: false, dims: hiAdventure.dims }), -1, '未 ready');
  assert.equal(h.s.originRecommend(origins, null), -1, '无画像');
  assert.equal(h.s.originRecommend(origins, { ready: true, dims: { 坚韧: 90 } }), -1, '无匹配 style');
});

test('buildPrologueOpts：recommend 取 profileData，onChoose 正确 POST /origin 并刷新', async () => {
  const h = setup(['core.js', 'images.js', 'prologue.js', 'game.js']);
  const headerCalls = [], panelCalls = [];
  h.s.renderHeader = function (w) { headerCalls.push(w); };
  h.s.renderPanel = function (w) { panelCalls.push(w); };
  h.s.currentWorldId = 'w1';
  h.s.profileData = { ready: true, dims: { 冒险: 10, 审慎: 20, 共情: 5, 权谋: 5, 坚韧: 5, 秩序: 90 } };
  const updated = { character: { origin: { title: '云游道士', blurb: '看淡世事', style: '秩序' } } };
  h.setApi(function () { return Promise.resolve(updated); });

  const opts = h.s.buildPrologueOpts({ origins: ORIGINS, character: {} });
  assert.equal(opts.origins.length, 3);
  assert.equal(opts.chosen, false);
  assert.equal(opts.recommend, 2, '秩序最高 → 第 2 个出身');
  assert.equal(typeof opts.onChoose, 'function');

  await opts.onChoose(2);
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.apiCalls[0].path, '/api/worlds/w1/origin');
  assert.equal(h.apiCalls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(h.apiCalls[0].opts.body), { index: 2 });
  assert.equal(h.s.currentState, updated, '用返回世界更新 currentState');
  assert.equal(headerCalls[0], updated, '重画 header');
  assert.equal(panelCalls[0], updated, '重画面板');
  assert.ok(h.toasts.some(function (m) { return /你的出身：云游道士/.test(m); }));
});

// ---------------------------------------------------------------- 角色卡
function stateFor() {
  return {
    life: 3, turn: 7,
    character: {
      name: '阿岚', attrs: { 体魄: 6, 心智: 8, 魅力: 5, 气运: 4, 声望: 7, 资源: 9 },
      items: ['长剑', '干粮'], marks: ['旧伤'],
    },
    stats: [], rumors: [], threads: [], facts: [], pastLives: [], chronicle: [], chapters: [],
    bible: { title: '测试世界', tone: '苍凉', places: [], factions: [], rules: [], prologue: PROLOGUE },
  };
}

test('renderPanel：第 0 回合未选出身有「选出身」按钮，可重新打开序章；非第 0 回合没有', () => {
  const h = setup(['core.js', 'images.js', 'prologue.js', 'game.js']);
  const st = stateFor();
  st.turn = 0;
  st.origins = ORIGINS;
  h.s.renderPanel(st);
  const pick = h.doc.querySelector('.char-origin-pick');
  assert.ok(pick, '应有补选按钮');
  assert.match(pick.textContent, /选出身/);
  assert.equal(h.doc.querySelector('.char-origin'), null, '未选不应有出身徽章');

  pick.click();
  const mask = h.doc.getElementById('prologue-mask');
  assert.ok(mask, '点击应重新打开序章卡');
  assert.equal(mask.querySelectorAll('.origin-card').length, 3, '带上 origins');

  const h2 = setup(['core.js', 'images.js', 'prologue.js', 'game.js']);
  const st2 = stateFor();
  st2.turn = 5;
  st2.origins = ORIGINS;
  h2.s.renderPanel(st2);
  assert.equal(h2.doc.querySelector('.char-origin-pick'), null, '非第 0 回合不显示补选');
});

test('renderPanel：已选出身显示「出身：title」徽章且 blurb 作 tooltip', () => {
  const h = setup(['core.js', 'images.js', 'prologue.js', 'game.js']);
  const st = stateFor();
  st.turn = 0;
  st.origins = ORIGINS;
  st.character.origin = { title: '镖局少主', blurb: '走南闯北，刀口舔血', style: '冒险' };
  h.s.renderPanel(st);
  assert.equal(h.doc.querySelector('.char-origin-pick'), null, '已选不再显示补选');
  const badge = h.doc.querySelector('.char-origin');
  assert.ok(badge, '应有出身徽章');
  assert.match(badge.textContent, /出身：镖局少主/);
  assert.equal(badge.getAttribute('title'), '走南闯北，刀口舔血', 'blurb 作 tooltip');
  assert.ok(h.doc.querySelector('.char-badges').contains(badge), '徽章在 .char-badges 里');
});
