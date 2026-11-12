'use strict';

// 角色卡 / 专属状态 / 雷达 / 玩家画像 / 徽章 / 标签切换 的前端测试。
// 做法：vm + 最小假 DOM 真实执行 core.js + images.js + game.js 抽出的函数；
// 抽不出（showGame 的 /stats 请求、CSS）的用静态检查兜底。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
const coreJs = read('js/core.js');
const imagesJs = read('js/images.js');
const gameJs = read('js/game.js');
const css = read('app.css');

// 截出函数体做「在某函数内」的静态判断。
function bodyOf(src, startSig, endSig) {
  const i = src.indexOf(startSig);
  assert.ok(i >= 0, '应存在 ' + startSig);
  const j = endSig ? src.indexOf(endSig, i + startSig.length) : src.length;
  return src.slice(i, j < 0 ? src.length : j);
}

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
    this.alt = '';
    this.src = '';
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
    const D = this.__doc;
    if (!ev.__stopped && D && D.listeners && D.listeners[ev.type]) {
      for (var k = 0; k < D.listeners[ev.type].length; k++) D.listeners[ev.type][k](ev);
    }
  }
  click() { this.dispatchEvent({ type: 'click' }); }
}

function makeDoc() {
  const doc = {
    activeElement: null,
    listeners: {},
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

function setup(opts) {
  opts = opts || {};
  const made = makeDoc();
  const doc = made.doc, body = made.body;
  function addId(id, tag) {
    const n = doc.createElement(tag || 'div');
    n.id = id;
    body.appendChild(n);
    return n;
  }
  addId('panel');
  addId('top-attrs');
  addId('stream');
  addId('toast');
  addId('image-viewer');
  addId('attr-tip');
  addId('action-input', 'textarea');

  const lsCalls = { get: [], set: [] };
  const throwLS = !!opts.throwLS;
  const ls = {
    _v: opts.panelTab ? { panelTab: opts.panelTab } : {},
    getItem(k) {
      if (throwLS) throw new Error('localStorage disabled');
      lsCalls.get.push(k);
      return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null;
    },
    setItem(k, v) {
      if (throwLS) throw new Error('localStorage disabled');
      lsCalls.set.push([k, String(v)]);
      this._v[k] = String(v);
    },
  };
  const timers = [];
  let tid = 0;
  const apiCalls = [];
  const toasts = [];
  let apiImpl = opts.api || function () { return Promise.resolve({}); };
  const win = { innerWidth: opts.width || 1440, innerHeight: 900, addEventListener() {} };
  const sandbox = {
    document: doc, window: win, location: { href: '', hash: '#/w/w1' },
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
  vm.runInContext(coreJs, sandbox, { filename: 'core.js' });
  vm.runInContext(imagesJs, sandbox, { filename: 'images.js' });
  vm.runInContext(gameJs, sandbox, { filename: 'game.js' });
  // 覆盖网络 / toast 依赖，便于观测（函数声明在载入后覆盖，调用时按全局解析）。
  sandbox.api = function (p, o) {
    apiCalls.push({ path: p, opts: o || {} });
    return Promise.resolve(apiImpl(p, o));
  };
  sandbox.toast = function (m) { toasts.push(m); };
  return {
    s: sandbox, doc, body, win, ls, lsCalls, timers, apiCalls, toasts, addId,
    setApi(fn) { apiImpl = fn; },
    fireTimers() { timers.slice().forEach(function (t) { if (!t.cleared) t.fn(); }); },
  };
}

function makeState(overrides) {
  return Object.assign({
    life: 3, turn: 7,
    character: {
      name: '阿岚',
      attrs: { 体魄: 6, 心智: 8, 魅力: 5, 气运: 4, 声望: 7, 资源: 9 },
      items: ['长剑', '干粮'],
      marks: ['旧伤'],
    },
    stats: [
      { name: '精力', kind: 'gauge', icon: '⚡', desc: '体力值', max: 100, start: 80, value: 40, drift: -2,
        warn: [{ below: 25, label: '疲惫', effect: '反应变慢' }, { below: 8, label: '透支', effect: '随时倒下' }],
        alerts: [{ label: '疲惫', effect: '反应变慢', severe: false }] },
      { name: '境界', kind: 'rank', icon: '☯', desc: '修为', ranks: ['凡人', '炼气', '筑基', '金丹', '元婴'],
        start: 2, value: 2, rankName: '筑基', alerts: [] },
    ],
    rumors: [{ text: '山中有人' }],
    threads: ['失踪的师父'],
    facts: [{ text: '城门已关' }],
    pastLives: [{ life: 2, name: '旧名', turns: 12, epitaph: '一生漂泊' }],
    chronicle: [{ chapter: 1, fromTurn: 1, toTurn: 5, summary: '初入' }],
    bible: {
      title: '测试世界', tone: '苍凉',
      places: [{ name: '城', desc: '旧城' }],
      factions: [{ name: '宗门', stance: '中立' }],
      rules: ['不可杀人'],
      prologue: { world: 'w', me: 'm', goal: 'g', now: 'n' },
    },
  }, overrides || {});
}

// 解析 radar-shape 的 points，返回各顶点到中心 (100,92) 的距离。
function shapeRadii(svg) {
  const shape = svg.querySelector('.radar-shape');
  assert.ok(shape, '应有 .radar-shape');
  const pts = shape.getAttribute('points').trim().split(/\s+/);
  return pts.map(function (pair) {
    const xy = pair.split(',').map(Number);
    return Math.sqrt(Math.pow(xy[0] - 100, 2) + Math.pow(xy[1] - 92, 2));
  });
}

// ---------------------------------------------------------------- 测试
test('radarSvg：6 轴 / 6 顶点 / 超过 scale 夹在半径内 / scale 下限 15 / 三层网格', () => {
  const h = setup();
  const svg = h.s.radarSvg(['a', 'b', 'c', 'd', 'e', 'f'], [10, 20, 30, 40, 50, 60], 100, {});
  assert.equal(svg.querySelectorAll('.radar-axis').length, 6, '六条轴线');
  assert.equal(svg.querySelectorAll('.radar-grid').length, 3, '三层网格');
  assert.equal(svg.querySelectorAll('.radar-label').length, 6, '六个顶点标签');
  assert.equal(shapeRadii(svg).length, 6, '数值多边形 6 个顶点');

  // 值远超 scale：半径夹到 70
  const big = h.s.radarSvg(['a', 'b', 'c', 'd', 'e', 'f'], [999, 0, 0, 0, 0, 0], 100, {});
  const r = shapeRadii(big);
  assert.ok(r[0] <= 70.01 && r[0] >= 69.99, '超过 scale 的点夹在半径内');
  assert.ok(r.every(function (x) { return x <= 70.01; }), '所有顶点都不超过半径');

  // scale 下限 15：传 5 时按 15 计，10/15 => 半径约 46.67 而非 70
  const floor = h.s.radarSvg(['a', 'b', 'c', 'd', 'e', 'f'], [10, 0, 0, 0, 0, 0], 5, {});
  const rf = shapeRadii(floor);
  assert.ok(Math.abs(rf[0] - (70 * 10 / 15)) < 0.1, 'scale 低于 15 时按下限 15 计算');
});

test('专属状态 gauge：宽度百分比、alert/severe 类、刻度位置、stat-alert、空占位', () => {
  const h = setup();
  const box = h.doc.createElement('div');
  const stat = {
    name: '精力', kind: 'gauge', icon: '⚡', desc: '体力值', max: 100, value: 40,
    warn: [{ below: 25, label: '疲惫', effect: '反应变慢' }, { below: 8, label: '透支', effect: '随时倒下' }],
    alerts: [{ label: '疲惫', effect: '反应变慢', severe: false },
             { label: '透支', effect: '随时倒下', severe: true }],
  };
  h.s.renderStatList(box, [stat]);
  assert.equal(box.querySelectorAll('.stat-gauge').length, 1);
  const node = box.querySelector('.stat');
  assert.ok(node.classList.contains('alert'), '有生效警戒应加 alert');
  assert.ok(node.classList.contains('severe'), '有 severe 警戒应加 severe');
  assert.equal(node.getAttribute('title'), '体力值');
  const fill = node.querySelector('.stat-bar').querySelector('i');
  assert.equal(fill.style.width, '40%', 'value/max 宽度百分比');
  const ticks = node.querySelectorAll('.stat-tick');
  assert.equal(ticks.length, 2, '每条非 drain 警戒线一个刻度');
  assert.deepEqual(ticks.map(function (t) { return t.style.left; }), ['25%', '8%'], '刻度位置按 below/max');
  assert.match(node.querySelector('.stat-alert').textContent, /⚠ 疲惫：反应变慢/);
  assert.match(node.querySelector('.stat-val').textContent, /^40\/100$/);

  // 空 stats 占位
  h.s.renderStatList(box, []);
  assert.equal(box.querySelectorAll('.stat').length, 0);
  assert.match(box.textContent, /正在为这个世界设计专属状态/);
});

test('专属状态 rank：done / current 数量与阶名', () => {
  const h = setup();
  const box = h.doc.createElement('div');
  h.s.renderStatList(box, [{
    name: '境界', kind: 'rank', icon: '☯', desc: '修为',
    ranks: ['凡人', '炼气', '筑基', '金丹', '元婴'], value: 2, rankName: '筑基', alerts: [],
  }]);
  assert.equal(box.querySelectorAll('.stat-rank').length, 1);
  assert.equal(box.querySelectorAll('.rank-step').length, 5);
  assert.equal(box.querySelectorAll('.rank-step.done').length, 2, 'value 之前 2 阶 done');
  assert.equal(box.querySelectorAll('.rank-step.current').length, 1, 'value 处 1 阶 current');
  assert.match(box.querySelector('.stat-val').textContent, /筑基/);
  assert.equal(box.querySelectorAll('.stat-bar').length, 0, 'rank 不画 gauge 条');
});

test('标签：四个 pane 都在 DOM、默认 char、保留 id、切换只改 active 不重画', () => {
  const h = setup();
  h.s.renderPanel(makeState());
  const panes = h.doc.querySelectorAll('.panel-pane');
  assert.equal(panes.length, 4, '四个 pane 始终在 DOM');
  assert.deepEqual(panes.map(function (p) { return p.getAttribute('data-pane'); }),
    ['char', 'people', 'clues', 'profile']);

  // 必须保留的 id
  for (const id of ['item-grid', 'hero-row', 'npc-list']) {
    assert.ok(h.doc.getElementById(id), '应保留 #' + id);
  }

  // 角色卡
  assert.match(h.doc.querySelector('.char-name').textContent, /阿岚/);
  assert.match(h.doc.querySelector('.char-sub').textContent, /第 3 世 · 第 7 回合/);
  assert.equal(h.doc.querySelectorAll('.char-rank').length, 1, 'rank 状态一个 char-rank 徽章');
  assert.equal(h.doc.querySelectorAll('.attr-cell').length, 6, '六个基础属性格子');
  assert.equal(h.doc.querySelectorAll('.attr-cell[data-attr]').length, 6, '每个格子带 data-attr');

  // 默认 char
  assert.ok(h.s.panelPanes.char.classList.contains('active'), '默认 char');
  assert.equal(h.doc.querySelectorAll('.panel-pane.active').length, 1);
  assert.equal(h.doc.querySelector('.panel-tab[data-tab="char"]').getAttribute('aria-selected'), 'true');

  // 切换只改 active / aria-selected，不重画
  const gridBefore = h.doc.getElementById('item-grid');
  const charPaneBefore = h.s.panelPanes.char;
  h.doc.querySelector('.panel-tab[data-tab="people"]').click();
  assert.ok(h.s.panelPanes.people.classList.contains('active'), 'people 变为 active');
  assert.ok(!h.s.panelPanes.char.classList.contains('active'), 'char 去掉 active');
  assert.equal(h.doc.querySelectorAll('.panel-pane.active').length, 1);
  assert.equal(h.doc.querySelector('.panel-tab[data-tab="people"]').getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.querySelector('.panel-tab[data-tab="char"]').getAttribute('aria-selected'), 'false');
  assert.equal(h.doc.getElementById('item-grid'), gridBefore, '未重画：#item-grid 还是同一节点');
  assert.equal(h.s.panelPanes.char, charPaneBefore, '未重画：pane 映射未变');
  assert.equal(h.doc.querySelectorAll('.panel-pane').length, 4, 'pane 数量不变');
});

test('标签：localStorage 记忆与抛错不崩', () => {
  const h = setup({ panelTab: 'clues' });
  h.s.renderPanel(makeState());
  assert.ok(h.s.panelPanes.clues.classList.contains('active'), '恢复 localStorage 里的标签');
  // 切换后写回
  h.doc.querySelector('.panel-tab[data-tab="people"]').click();
  const last = h.lsCalls.set[h.lsCalls.set.length - 1];
  assert.deepEqual(last, ['panelTab', 'people'], '切换应记忆到 localStorage');

  // localStorage 抛错：读取/写入被 try/catch 包住，不崩
  const h2 = setup({ throwLS: true });
  assert.doesNotThrow(function () { h2.s.renderPanel(makeState()); });
  assert.ok(h2.s.panelPanes.char.classList.contains('active'), '抛错时回退默认 char');
  assert.equal(h2.s.readPanelTab(), 'char');
  assert.doesNotThrow(function () { h2.s.activatePanelTab('people'); });
});

test('徽章：badgesFromApplied 的 stat / drain 与 makeBadge 文字类名', () => {
  const h = setup();
  const badges = h.s.badgesFromApplied(
    { state_diff: { 体魄: 1 }, stats_diff: { 精力: 3, 理智: -5 } },
    [{ stat: '精力', label: '透支', attr: '体魄' }],
  );
  // vm 里的对象来自另一 realm，逐字段断言避免 deepStrictEqual 的原型差异。
  const stats = badges.filter(function (b) { return b.type === 'stat'; });
  assert.equal(stats.length, 2);
  const energy = stats.find(function (b) { return b.name === '精力'; });
  assert.equal(energy.type, 'stat');
  assert.equal(energy.name, '精力');
  assert.equal(energy.delta, 3);
  const drains = badges.filter(function (b) { return b.type === 'drain'; });
  assert.equal(drains.length, 1);
  assert.equal(drains[0].type, 'drain');
  assert.equal(drains[0].name, '体魄');
  assert.equal(drains[0].delta, -1);
  assert.equal(drains[0].label, '透支');
  assert.ok(!badges.some(function (b) { return b.type === 'drift'; }), '自然变化不出徽章');

  const up = h.s.makeBadge({ type: 'stat', name: '精力', delta: 3 });
  assert.equal(up.className, 'badge stat up');
  assert.equal(up.textContent, '精力 +3');
  const down = h.s.makeBadge({ type: 'stat', name: '理智', delta: -5 });
  assert.equal(down.className, 'badge stat down');
  assert.equal(down.textContent, '理智 −5');
  const drain = h.s.makeBadge({ type: 'drain', name: '体魄', delta: -1, label: '透支' });
  assert.equal(drain.className, 'badge down drain');
  assert.equal(drain.textContent, '体魄 −1 · 透支');
});

test('画像页：未 ready 提示、traits、summary、wants、note、画像雷达 6 轴', () => {
  const h = setup();
  h.s.renderPanel(makeState()); // 先建立 pane 映射
  h.s.profileData = {
    turns: 3, dims: { 冒险: 70, 审慎: 20, 共情: 40, 权谋: 10, 坚韧: 60, 秩序: 30 },
    traits: ['好奇', '果断'], summary: '你偏爱冒险。', wants: '探索与解谜', ready: false,
  };
  h.s.renderProfilePane();
  const pane = h.s.panelPanes.profile;
  assert.match(pane.querySelector('.profile-title').textContent, /你的玩家画像/);
  assert.match(pane.querySelector('.profile-sub').textContent, /已玩 3 回合/);
  assert.match(pane.querySelector('.profile-hint').textContent, /再玩 7 回合/);
  assert.equal(pane.querySelectorAll('.trait-chip').length, 2);
  assert.match(pane.textContent, /好奇/);
  assert.match(pane.querySelector('.profile-summary').textContent, /你偏爱冒险/);
  assert.match(pane.querySelector('.profile-wants').textContent, /你偏爱的剧情：探索与解谜/);
  assert.match(pane.querySelector('.profile-note').textContent, /开新世界会自带/);
  const radar = pane.querySelector('.profile-radar.persona-radar');
  assert.ok(radar, '画像雷达整体带 persona-radar 类');
  assert.equal(radar.querySelectorAll('.radar-axis').length, 6);
  assert.equal(radar.querySelectorAll('.radar-label').length, 6);
  assert.ok(radar.querySelector('.radar-label[data-attr]') === null, '画像雷达标签不带 data-attr');
});

test('画像页：ready 时不显示提示、无 traits 不渲染容器、summary 兜底', () => {
  const h = setup();
  h.s.renderPanel(makeState());
  h.s.profileData = {
    turns: 20, dims: { 冒险: 50 }, traits: [], summary: '', wants: '', ready: true,
  };
  h.s.renderProfilePane();
  const pane = h.s.panelPanes.profile;
  assert.equal(pane.querySelector('.profile-hint'), null, 'ready 不显示提示');
  assert.equal(pane.querySelector('.profile-wants'), null, 'wants 为空不渲染');
  assert.equal(pane.querySelector('.profile-traits'), null, 'traits 为空不渲染容器');
  assert.match(pane.querySelector('.profile-summary').textContent, /再多玩几回合/);
});

test('画像页：重置两步确认（第一次不发请求、4 秒内第二次才 DELETE、4 秒不点恢复）', async () => {
  const h = setup();
  h.s.renderPanel(makeState());
  const btn = h.s.panelPanes.profile.querySelector('.profile-reset');
  assert.equal(btn.textContent, '重置画像');

  // 第一次点击：只进入确认态，不发请求
  btn.click();
  assert.equal(btn.textContent, '确认重置？');
  assert.equal(h.apiCalls.length, 0, '第一次点击不发请求');
  assert.equal(h.s.profileResetArmed, true);

  // 4 秒内第二次点击：才 DELETE
  btn.click();
  assert.equal(h.apiCalls.length, 1, '第二次点击才发请求');
  assert.equal(h.apiCalls[0].path, '/api/profile');
  assert.equal(h.apiCalls[0].opts.method, 'DELETE');
  assert.equal(h.s.profileResetArmed, false);
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  assert.ok(h.toasts.indexOf('画像已重置') >= 0, '成功后 toast');

  // 4 秒不点恢复原文字
  const h2 = setup();
  h2.s.renderPanel(makeState());
  const btn2 = h2.s.panelPanes.profile.querySelector('.profile-reset');
  btn2.click();
  assert.equal(btn2.textContent, '确认重置？');
  h2.fireTimers(); // 触发 4000ms 复原
  assert.equal(btn2.textContent, '重置画像');
  assert.equal(h2.s.profileResetArmed, false);
  assert.equal(h2.apiCalls.length, 0, '超时复原不发请求');
});

test('renderTopAttrs：专属状态小标签排在属性前、rank 显示阶名、带 title', () => {
  const h = setup();
  h.s.renderTopAttrs(makeState());
  const chips = h.doc.getElementById('top-attrs').querySelectorAll('span');
  assert.equal(chips.length, 8, '2 个状态 + 6 个属性');
  assert.ok(chips[0].classList.contains('top-chip') && chips[0].classList.contains('stat-chip'),
    '状态小标签在最前');
  assert.ok(chips[0].classList.contains('alert'), '有生效警戒时加 alert');
  assert.equal(chips[0].getAttribute('title'), '精力');
  assert.match(chips[0].textContent, /⚡ 40/);
  assert.match(chips[1].textContent, /☯/, 'rank 小标签显示 icon');
  assert.match(chips[1].textContent, /筑基/, 'rank 小标签显示阶名');
  assert.equal(chips[2].getAttribute('data-attr'), '体魄', '其后才是属性小标签');
});

test('背包空格子：物品不足 6 个时补到 6、0 个时仍显示（无）', () => {
  const h = setup();
  const grid = h.addId('item-grid');
  h.s.currentState = { character: { items: ['剑', '书'] } };
  h.s.renderItemGrid();
  assert.equal(grid.querySelectorAll('.item-card').length, 2);
  assert.equal(grid.querySelectorAll('.item-slot-empty').length, 4, '补 4 个空格子');
  assert.equal(grid.querySelector('.item-slot-empty').getAttribute('aria-hidden'), 'true');

  h.s.currentState = { character: { items: [] } };
  h.s.renderItemGrid();
  assert.equal(grid.querySelectorAll('.item-slot-empty').length, 6, '0 个物品补 6 个空格子');
  assert.match(grid.textContent, /（无）/, '仍保留「（无）」提示');
});

test('静态：showGame 空 stats 请求 /stats、进世界/每回合刷新画像、images.js 接头像与空格子', () => {
  const sg = bodyOf(gameJs, 'async function showGame', 'function renderHeader');
  assert.match(sg, /state\.stats\.length === 0|!Array\.isArray\(state\.stats\)/, '判断 stats 为空');
  assert.match(sg, /\/api\/worlds\/' \+ encodeURIComponent\(id\) \+ '\/stats'/, '请求 /stats');
  assert.match(sg, /currentWorldId/, '回来后校验未切世界');
  assert.match(sg, /renderPanel\(currentState\)/, '回来后重画面板');
  assert.match(sg, /fetchProfile\(\)/, '进世界时拉画像');

  const rr = bodyOf(gameJs, 'function renderResult', 'async function sendAction');
  assert.match(rr, /badgesFromApplied\(res\.applied, res\.stats_drains\)/, '徽章传 stats_drains');
  assert.match(rr, /fetchProfile\(\)/, '每回合后拉画像');

  assert.match(gameJs, /function renderCharAvatar\(/, 'game.js 新增 renderCharAvatar');
  assert.match(imagesJs, /if \(typeof renderCharAvatar === 'function'\) renderCharAvatar\(\);/,
    'renderImages 在 renderHero 之后调用 renderCharAvatar');
  assert.match(imagesJs, /item-slot-empty/, 'renderItemGrid 补空格子');

  assert.match(gameJs, /api\('\/api\/profile'/, 'GET /api/profile');
  assert.match(gameJs, /api\('\/api\/profile', \{ method: 'DELETE' \}\)/, 'DELETE /api/profile');
});

test('静态：app.css 末尾「角色卡」基础样式段', () => {
  assert.match(css, /角色卡（结构基础样式，视觉稿待定）/, '新段注释');
  assert.match(css, /\.panel-tabs\{[^}]*display:flex/, '标签一行');
  assert.match(css, /\.panel-tab\{[^}]*flex:1 1 0/, '标签四等分');
  assert.match(css, /\.panel-pane\{display:none\}/, 'pane 默认隐藏');
  assert.match(css, /\.panel-pane\.active\{display:block\}/, 'active 显示');
  assert.match(css, /\.char-card\{[^}]*display:flex/, '角色卡 flex');
  assert.match(css, /\.char-avatar,\.char-avatar-img\{[^}]*width:64px/, '头像 64px 圆形');
  assert.match(css, /\.stat-bar\{[^}]*height:8px/, '状态条 8px');
  assert.match(css, /\.rank-steps\{display:flex/, '阶梯 flex');
  assert.match(css, /\.attr-grid\{[^}]*repeat\(3,1fr\)/, '属性三列');
  assert.match(css, /\.item-slot-empty\{[^}]*dashed/, '空格子虚线框');
  assert.match(css, /\.radar-shape\{[^}]*fill:currentColor/, '雷达用 currentColor 系');
  assert.match(css, /\.trait-chip\{[^}]*border-radius:999px/, '胶囊');
  assert.match(css, /@media\(max-width:600px\)\{[^}]*\.panel-tab\{min-height:40px\}/, '手机标签 ≥40px');
  assert.match(css, /\.attr-cell\{min-height:40px\}/, '手机属性格 ≥40px');
});

// ---- 补充断言：说明里上面用例未覆盖的结构细节 ----
test('角色卡补充：默认名字、头像 id、伤势沉重徽章与体魄 danger 格子', () => {
  const h = setup();
  const st = makeState();
  st.character.name = '';
  h.s.renderPanel(st);
  assert.match(h.doc.querySelector('.char-name').textContent, /无名旅人/, '名字空时兜底');
  assert.equal(h.doc.querySelector('.char-avatar').id, 'hero-row-avatar');

  const h2 = setup();
  h2.s.renderPanel(makeState({ danger: true }));
  assert.equal(h2.doc.querySelectorAll('.char-danger').length, 1, '伤势沉重徽章');
  assert.match(h2.doc.querySelector('.char-danger').textContent, /伤势沉重/);
  assert.equal(h2.doc.querySelectorAll('.attr-cell.danger').length, 1, '体魄格子加 danger');
});

test('角色页雷达补充：顶点标签带 data-attr 写「属性名 值」、danger 顶点圆点', () => {
  const h = setup();
  h.s.renderPanel(makeState({ danger: true }));
  const svg = h.doc.querySelector('.attr-radar').querySelector('svg');
  const labels = svg.querySelectorAll('.radar-label');
  assert.equal(labels.length, 6);
  assert.equal(svg.querySelectorAll('.radar-label[data-attr]').length, 6, '每个标签带 data-attr');
  assert.match(labels[0].textContent, /体魄 6/, '标签写「属性名 值」');
  assert.equal(svg.querySelectorAll('.radar-dot.danger').length, 1, 'danger 顶点小圆');
  assert.equal(svg.querySelectorAll('.radar-grid').length, 3);
  assert.equal(svg.querySelectorAll('.radar-axis').length, 6);
});

test('人物页 / 线索页 / 印记：保留的容器类名、三个折叠段、序章按钮', () => {
  const h = setup();
  h.s.renderPanel(makeState());
  assert.ok(h.doc.getElementById('hero-row').classList.contains('npc-row'));
  assert.ok(h.doc.getElementById('npc-list').classList.contains('npc-list'));
  assert.equal(h.s.panelPanes.char.querySelectorAll('.mark-chip').length, 1);
  const clues = h.s.panelPanes.clues;
  for (const word of ['未解之谜', '坊间传闻', '前世', '已知的事', '编年史', '世界设定']) {
    assert.match(clues.textContent, new RegExp(word), '线索页应含「' + word + '」');
  }
  assert.equal(clues.querySelectorAll('details').length, 3, '已知的事 / 编年史 / 世界设定折叠');
  assert.equal(clues.querySelectorAll('button').length, 1, '序章按钮');
});

test('画像雷达补充：六轴顺序为 PERSONA、标签只有维度名、note 文案', () => {
  const h = setup();
  h.s.renderPanel(makeState());
  h.s.profileData = {
    turns: 12, dims: { 冒险: 50, 审慎: 40, 共情: 30, 权谋: 20, 坚韧: 10, 秩序: 5 },
    traits: [], summary: 's', wants: '', ready: true,
  };
  h.s.renderProfilePane();
  const pane = h.s.panelPanes.profile;
  const svg = pane.querySelector('.profile-radar').querySelector('svg');
  assert.deepEqual(svg.querySelectorAll('.radar-label').map(function (t) { return t.textContent; }),
    ['冒险', '审慎', '共情', '权谋', '坚韧', '秩序']);
  assert.equal(svg.querySelectorAll('.radar-label[data-attr]').length, 0, '画像标签不带 data-attr');
  assert.match(pane.querySelector('.profile-note').textContent, /开新世界会自带/);
  assert.equal(pane.querySelector('.profile-hint'), null, 'ready 不显示提示');
});

test('renderTopAttrs 补充：生效警戒带 alert/severe、rank 小标签 title 为状态名', () => {
  const h = setup();
  const st = makeState();
  st.stats[0].alerts = [{ label: '透支', effect: '随时倒下', severe: true }];
  h.s.renderTopAttrs(st);
  const chips = h.doc.getElementById('top-attrs').querySelectorAll('.stat-chip');
  assert.equal(chips.length, 2);
  assert.ok(chips[0].classList.contains('alert'));
  assert.ok(chips[0].classList.contains('severe'));
  assert.equal(chips[1].getAttribute('title'), '境界');
  assert.match(chips[1].textContent, /筑基/, 'rank 显示阶名');
});
