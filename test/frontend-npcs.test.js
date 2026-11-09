'use strict';

// 认识的人列表 / 人物档案：用轻量假 DOM + vm 真实执行 public/js 里的代码，
// 验证点击、搜索焦点、分页原文、XSS、关闭/滚动锁/快捷键、旧请求不串卡等行为。
// 接口由后端下一任务实现，这里只用内存假数据（stub fetch），不访问线上游戏。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
const srcNpcs = read('js/npcs.js');
const srcImages = read('js/images.js');
const srcCore = read('js/core.js');
const srcGame = read('js/game.js');
const srcHome = read('js/home.js');
const html = read('index.html');
const css = read('app.css');

// ---------------------------------------------------------------- 假 DOM
function matches(node, sel) {
  sel = sel.trim();
  if (!sel) return false;
  if (sel[0] === '#') return node.id === sel.slice(1);
  if (sel[0] === '.') return node.classList.contains(sel.slice(1));
  const m = sel.match(/^([a-zA-Z0-9]+)(?:\.(.+))?$/);
  if (!m) return false;
  if (node.tagName !== m[1].toUpperCase()) return false;
  return m[2] ? node.classList.contains(m[2]) : true;
}
function findAll(rootNode, sel) {
  const out = [];
  const sels = sel.split(',').map((s) => s.trim());
  (function walk(n) {
    for (const c of n.childNodes) {
      if (sels.some((s) => matches(c, s))) out.push(c);
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
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 600;
    this.alt = '';
    this.src = '';
    this.__rootConnected = false;
    this.__doc = null;
  }
  get isConnected() {
    let n = this;
    while (n) {
      if (n.__rootConnected) return true;
      n = n.parentNode;
    }
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
      const key = k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
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
  focus() { if (this.__doc) this.__doc.activeElement = this; }
  get classList() {
    const self = this;
    const parts = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(c) { if (!parts().includes(c)) self.className = parts().concat(c).join(' '); },
      remove(c) { self.className = parts().filter((x) => x !== c).join(' '); },
      toggle(c, force) {
        const on = force === undefined ? !parts().includes(c) : !!force;
        if (on) { if (!parts().includes(c)) self.className = parts().concat(c).join(' '); }
        else self.className = parts().filter((x) => x !== c).join(' ');
      },
      contains(c) { return parts().includes(c); },
    };
  }
  querySelector(sel) { return findOne(this, sel); }
  querySelectorAll(sel) { return findAll(this, sel); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 300, height: 600 }; }
  // 有布局盒 = 可见（默认）；测试可把 __clientRects 设为 [] 模拟 display:none / 闭合 details。
  getClientRects() { return this.__clientRects === undefined ? [{ width: 1, height: 1 }] : this.__clientRects; }
  scrollIntoView() {}
  scrollTo() {}
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.stopPropagation = ev.stopPropagation || function () { ev.__stopped = true; };
    ev.preventDefault = ev.preventDefault || function () {};
    // 模拟原生 <details>/<summary> 点击展开（真实浏览器原生处理）。
    if (ev.type === 'click' && this.tagName === 'SUMMARY') {
      let p = this.parentNode;
      while (p && p.tagName !== 'DETAILS') p = p.parentNode;
      if (p) p.open = !p.open;
    }
    const chain = [];
    let node = this;
    while (node) { chain.push(node); node = node.parentNode; }
    for (const n of chain) {
      for (const fn of (n.listeners[ev.type] || []).slice()) fn(ev);
      if (ev.__stopped) break;
    }
    const D = this.__doc;
    if (!ev.__stopped && D && D.listeners[ev.type]) {
      for (const fn of D.listeners[ev.type].slice()) fn(ev);
    }
  }
  click() { this.dispatchEvent({ type: 'click' }); }
}

const TtsStub = {
  voiceLabel(v) { return v.label || v.id || ''; },
  npcVoiceFor() { return 'auto-id'; },
  previewVoice() {},
  withVoices(cb) { cb([{ id: 'v1', label: '男声' }, { id: 'v2', label: '女声' }]); },
};

function makeContext(opts) {
  opts = opts || {};
  const doc = {
    activeElement: null,
    listeners: {},
    createElement(tag) { const n = new FakeNode(tag); n.__doc = doc; return n; },
    getElementById(id) {
      function walk(n) {
        if (n.id === id) return n;
        for (const c of n.childNodes) { const r = walk(c); if (r) return r; }
        return null;
      }
      return walk(doc.documentElement);
    },
    querySelector(sel) { return findOne(doc.documentElement, sel); },
    querySelectorAll(sel) { return findAll(doc.documentElement, sel); },
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    dispatchEvent(ev) {
      ev.target = ev.target || doc;
      ev.stopPropagation = ev.stopPropagation || function () { ev.__stopped = true; };
      ev.preventDefault = ev.preventDefault || function () {};
      for (const fn of (this.listeners[ev.type] || []).slice()) fn(ev);
    },
  };
  const rootNode = new FakeNode('html');
  rootNode.__doc = doc; rootNode.__rootConnected = true;
  const body = new FakeNode('body');
  body.__doc = doc;
  rootNode.appendChild(body);
  doc.documentElement = rootNode;
  doc.body = body;

  function add(id, tag) {
    const n = doc.createElement(tag || 'div');
    n.id = id;
    body.appendChild(n);
    return n;
  }
  add('npc-list');
  add('stream');
  add('action-input', 'textarea');
  add('toast');
  add('image-viewer');
  add('attr-tip');

  const win = {
    innerWidth: opts.width || 1440,
    innerHeight: 900,
    listeners: {},
    Tts: TtsStub,
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    dispatchEvent(ev) { for (const fn of (this.listeners[ev.type] || []).slice()) fn(ev); },
    // 测试可把节点的 __computed 设为 { display:'none' } 等模拟 CSS；默认只给行高。
    getComputedStyle(node) { return (node && node.__computed) || { lineHeight: '28' }; },
    scrollTo() {},
    visualViewport: null,
  };
  const loc = { href: '', hash: '#/w/w1' };
  let fetchImpl = opts.fetch || (() => Promise.resolve(okResponse({})));
  const sandbox = {
    document: doc, window: win, location: loc,
    fetch: (url, o) => fetchImpl(url, o),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem() { return null; }, setItem() {} },
  };
  vm.createContext(sandbox);
  for (const f of ['core.js', 'images.js', 'npcs.js', 'game.js']) {
    vm.runInContext(read('js/' + f), sandbox, { filename: f });
  }
  sandbox.currentWorldId = opts.worldId || 'w1';
  sandbox.currentState = opts.state || {};
  sandbox.imageState = opts.imageState || { items: {}, npcs: {}, scenes: {}, hero: {} };
  sandbox.npcSearchQuery = '';
  return {
    s: sandbox, doc, win, loc, body,
    setFetch(fn) { fetchImpl = fn; },
  };
}

function okResponse(obj) {
  return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(obj)) };
}
// 统一的内存假数据：避免深层内联字面量，也更贴近后端 {profile, history} 契约。
function histResponse(entries, hasMore, nextCursor, total) {
  return {
    profile: {},
    history: {
      entries: entries,
      nextCursor: nextCursor === undefined ? null : nextCursor,
      hasMore: !!hasMore,
      total: total === undefined ? entries.length : total,
    },
  };
}
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function profile(name, extra) {
  return Object.assign({
    name: name, displayName: name, aliases: [], portraitName: name,
    role: '守夜人', description: '', voice: '', publicGoal: '', relationshipSummary: '',
    traits: { appearance: { 衣着: '青布长衫' }, personality: { 性子: '沉静' } },
    initial: { role: '更夫', description: '最初在城门下见到', voice: '', traits: {} },
    firstRecord: { turn: 1, life: 1, heroName: '初代', clock: { day: 1, period: '清晨' } },
    lastRecord: { turn: 9, life: 2, heroName: '旧名', clock: { day: 10, period: '黄昏' } },
    lastInteraction: { turn: 9 },
    latestExcerpt: '他替你挡了一刀', attitude: 4,
  }, extra || {});
}
function entry(i, extra) {
  return Object.assign({
    eventIndex: i, kind: 'interaction',
    at: { turn: i, life: 2, heroName: '旧名' + (i % 4), clock: { day: i + 1, period: '黄昏' } },
    action: '向 ' + i + ' 打听消息', excerpt: '第 ' + i + ' 条摘要',
    narration: '完整原文第 ' + i + ' 条。\n第二段留白也保留。',
    changes: [{ label: '态度', from: '0', to: String(i) }],
  }, extra || {});
}
function mkEntries(hi, lo) {
  const out = [];
  for (let i = hi; i >= lo; i--) out.push(entry(i, { kind: ['interaction', 'mention', 'change'][i % 3] }));
  return out;
}
function pagedFetch(calls) {
  return (url) => {
    calls.push(url);
    const m = url.match(/[?&]before=([^&]*)/);
    const key = m ? decodeURIComponent(m[1]) : 'null';
    const pages = {
      'null': histResponse(mkEntries(44, 25), true, 25, 45),
      '25': histResponse(mkEntries(24, 5), true, 5, 45),
      '5': histResponse(mkEntries(4, 0), false, null, 45),
    };
    return Promise.resolve(okResponse(pages[key] || histResponse([], false, null, 45)));
  };
}

// ---------------------------------------------------------------- 行为测试

test('列表：公共 profile 渲染两行（名字+好感 / 认人线索+最近回合），最近记录优先且轮询排序稳定', () => {
  const ctx = makeContext({
    state: { npcProfiles: {
      a: profile('阿青', { lastRecord: { turn: 3 } }),
      b: profile('白露', { role: '', latestExcerpt: '雨夜里递来一把伞', lastRecord: { turn: 12 } }),
      c: profile('陈伯', { lastRecord: { turn: 7 } }),
    } },
  });
  ctx.s.renderNpcList();
  const rows = ctx.doc.querySelectorAll('.npc-row');
  assert.equal(rows.length, 3, '三个人三行');
  // 稳定排序：最近记录（12）最前，轮询重画顺序不变。
  assert.match(rows[0].textContent, /白露/);
  assert.match(rows[1].textContent, /陈伯/);
  assert.match(rows[2].textContent, /阿青/);
  // 两行内容：好感心 + 认人线索 + 回合
  assert.equal(rows[0].querySelectorAll('.npc-line1').length, 1);
  assert.equal(rows[0].querySelectorAll('.npc-line2').length, 1);
  assert.match(rows[0].querySelector('.npc-attitude').textContent, /[♥♡]/);
  assert.match(rows[0].querySelector('.npc-clue').textContent, /雨夜里递来一把伞/);
  assert.match(rows[0].querySelector('.npc-turn').textContent, /第12回合/);
  // 数据不裁：线索用 role / latestExcerpt 原文，不受 CSS 影响
  assert.equal(ctx.s.currentState.npcProfiles.b.latestExcerpt, '雨夜里递来一把伞');
  // 轮询反复 renderNpcList 顺序稳定、行数稳定
  const before = ctx.doc.querySelectorAll('.npc-row').map((r) => r.textContent);
  for (let k = 0; k < 3; k++) ctx.s.renderNpcList();
  assert.deepEqual(ctx.doc.querySelectorAll('.npc-row').map((r) => r.textContent), before);
});

test('兼容旧档：只有 npcAttitude 也能显示好感，不造 id、不请求接口', () => {
  const ctx = makeContext({ state: { npcAttitude: { 张三: 3, 李四: -2 } } });
  let fetched = 0;
  ctx.setFetch(() => { fetched++; return Promise.resolve(okResponse({})); });
  ctx.s.renderNpcList();
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 2);
  assert.match(ctx.doc.getElementById('npc-list').textContent, /张三/);
  assert.match(ctx.doc.getElementById('npc-list').textContent, /李四/);
  // 点名字：卡片可开，但历史不发请求（没有稳定 id）
  ctx.doc.querySelectorAll('.npc-row')[0].querySelector('.npc-open').click();
  const mask = ctx.doc.getElementById('npc-card-modal');
  assert.ok(mask, '兼容档也能打开档案');
  assert.match(mask.textContent, /更多经历尚未被记录/);
  assert.equal(fetched, 0, '绝不造 id 去请求接口');
});

test('搜索保留 / 图片轮询不抢焦点、不丢查询；结果 0 仍可清查询', () => {
  const ctx = makeContext({
    state: { npcProfiles: { a: profile('阿青'), b: profile('白露'), c: profile('陈伯') } },
  });
  ctx.s.renderNpcList();
  const search = ctx.doc.getElementById('npc-search');
  assert.ok(search, '应有持久搜索框');
  search.focus();
  search.value = '白';
  search.dispatchEvent({ type: 'input' }); // document 级委托更新查询并重画行
  assert.equal(ctx.s.npcSearchQuery, '白');
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 1, '按姓名过滤');
  assert.equal(ctx.doc.activeElement, search, '输入后焦点仍在搜索框');

  // 模拟图片轮询：renderImages 反复 renderNpcList，不得重建搜索框 / 抢焦点 / 丢查询
  ctx.s.renderImages();
  assert.equal(ctx.doc.getElementById('npc-search'), search, '搜索框节点不被重建');
  assert.equal(search.value, '白', '查询不丢');
  assert.equal(ctx.doc.activeElement, search, '焦点不被抢走');

  // 结果 0 时搜索框仍在，可清空恢复全部
  search.value = '查无此人';
  search.dispatchEvent({ type: 'input' });
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 0);
  assert.equal(ctx.doc.getElementById('npc-search'), search, '0 结果时搜索框仍可清查询');
  search.value = '';
  search.dispatchEvent({ type: 'input' });
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 3, '清空后恢复全部');
  // 身份 / 别名也可搜
  search.value = '守夜人';
  search.dispatchEvent({ type: 'input' });
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 3, '身份匹配');
  const ali = makeContext({ state: { npcProfiles: { x: profile('木', { role: '', latestExcerpt: '', aliases: ['木头'] }) } } });
  ali.s.renderNpcList();
  const s2 = ali.doc.getElementById('npc-search');
  s2.value = '木头';
  s2.dispatchEvent({ type: 'input' });
  assert.equal(ali.doc.querySelectorAll('.npc-row').length, 1, '别名匹配');
});

test('点击：名字按钮打开档案；头像放大、🔊音色各自独立，不一击弹两层', () => {
  const ctx = makeContext({
    state: { npcProfiles: { a: profile('阿青') } },
    imageState: { items: {}, npcs: { 阿青: { status: 'ready', url: '/img/a.png' } }, scenes: {}, hero: {} },
  });
  ctx.s.renderNpcList();
  const row = ctx.doc.querySelector('.npc-row');
  const avatar = row.querySelector('.npc-avatar');
  const voiceBtn = row.querySelector('.npc-voice-btn');
  const openBtn = row.querySelector('.npc-open');

  avatar.click(); // 头像：放大图
  assert.equal(ctx.doc.getElementById('image-viewer').hidden, false, '头像点击看大图');
  assert.equal(ctx.doc.getElementById('npc-card-modal'), null, '头像点击不打开档案');
  ctx.s.closeImageViewer();

  voiceBtn.click(); // 🔊：音色下拉
  const voiceRow = ctx.doc.querySelector('.npc-voice-row');
  assert.equal(voiceRow.hidden, false, '音色下拉展开');
  assert.equal(ctx.doc.getElementById('npc-card-modal'), null, '🔊 不打开档案');
  // 音色沿用 name 键
  const sel = voiceRow.querySelector('select.npc-voice-select');
  sel.value = 'v1';
  sel.dispatchEvent({ type: 'change' });
  assert.equal(ctx.s.myPrefs.tts.npcVoices['阿青'], 'v1', 'npcVoices 用 name 键保存');

  openBtn.click(); // 名字：打开档案，且只开一张
  const masks = ctx.doc.querySelectorAll('#npc-card-modal');
  assert.equal(masks.length, 1, '只开一张档案卡');
  const mask = masks[0];
  assert.match(mask.textContent, /阿青/);
  assert.match(mask.textContent, /守夜人/);
  assert.match(mask.textContent, /已知人物概况/);
  assert.match(mask.textContent, /已知特征/);
  assert.match(mask.textContent, /最初记录/);
  assert.match(mask.textContent, /出场与共同经历/);
  // 大头像 + 姓名/身份/好感
  assert.equal(mask.querySelectorAll('.npc-card-hero-slot').length, 1);
  assert.match(mask.querySelector('.npc-card-attitude').textContent, /[♥♡]/);
});

test('档案资料：traits 值完整可读、缺项只给一句提示、不编造简介', () => {
  const ctx = makeContext();
  const p = profile('阿青', {
    role: '', description: '', publicGoal: '', relationshipSummary: '', voice: '',
    traits: { appearance: { 衣着: '很长的原文：'.concat('甲'.repeat(120)) }, personality: {} },
  });
  ctx.s.currentState = { npcProfiles: { a: p } };
  ctx.s.openNpcCard('a', p);
  const mask = ctx.doc.getElementById('npc-card-modal');
  const text = mask.textContent;
  // 值完整（不裁存储）
  assert.match(text, /甲{120}/, 'traits 值完整可读');
  assert.match(text, /衣着/, 'traits 分类标签可读');
  assert.match(text, /最初在城门下见到/, '最初形象来自 initial');
  assert.match(text, /最初记载：第1日 · 清晨/, '最初记录用游戏日/时段');
  // 全空的概况区不堆一屏空标签：只有一句提示
  assert.ok(!/公开目标：/.test(text), '空字段不生成空标签');
  assert.match(text, /更多资料尚未透露，可从下方原文回看/);
});

test('经历：游戏日/时段/回合/当时主角取自 at，缺项标未记载，不用现实时间或当前姓名猜', () => {
  const ctx = makeContext();
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p }, character: { name: '现在的我' } };
  const e = entry(5, { at: { turn: 5 }, excerpt: '只留一句', action: '静立', narration: '当回合原文', changes: [] });
  ctx.setFetch(() => Promise.resolve(okResponse(histResponse([e], false, null, 1))));
  ctx.s.openNpcCard('a', p);
  return flush().then(() => {
    const mask = ctx.doc.getElementById('npc-card-modal');
    const text = mask.textContent;
    assert.match(text, /第5回合/, '回合来自 at.turn');
    assert.match(text, /时间未记载/, '缺 clock 不拿现实时间填');
    assert.match(text, /世数未记载/, '缺 life 标未记载');
    assert.match(text, /姓名未记载/, '缺 heroName 标未记载');
    assert.equal(text.indexOf('现在的我'), -1, '不用当前主角姓名猜旧时间');
    assert.equal(text.indexOf('2026'), -1, '不出现现实年份');
  });
});

test('经历：interaction/mention/change 标签有别，mention 用保守「相关记载」不推断仅被提及 / 当面相识', () => {
  const ctx = makeContext();
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p } };
  const entries = [
    entry(3, { kind: 'interaction', excerpt: '当面递刀', action: '拱手', narration: 'A原文', changes: [] }),
    entry(2, { kind: 'mention', excerpt: '听人说起', action: '旁听', narration: 'B原文', changes: [] }),
    entry(1, { kind: 'change', excerpt: '换了装束', action: '观察', narration: 'C原文', changes: [{ label: '衣着', to: '红衣' }] }),
  ];
  ctx.setFetch(() => Promise.resolve(okResponse(histResponse(entries, false, null, 3))));
  ctx.s.openNpcCard('a', p);
  return flush().then(() => {
    const mask = ctx.doc.getElementById('npc-card-modal');
    const kinds = mask.querySelectorAll('.npc-kind').map((k) => k.textContent);
    assert.deepEqual(kinds, ['相处', '相关记载', '资料变化']);
    const mentionItem = mask.querySelectorAll('.npc-hist-item')[1];
    assert.equal(/相处|相识|见面|当面|共同经历|仅被提及/.test(mentionItem.textContent), false,
      'mention 不得写成当面相识，也不再断言仅被提及');
    assert.match(mentionItem.textContent, /相关记载/);
    // 摘要 + 玩家当时行动在列表里直接可见
    assert.match(mask.textContent, /听人说起/);
    assert.match(mask.textContent, /你：旁听/);
  });
});

test('经历：点开看完整原文与公开变化，分页可加载全部（>20 条），不固定只给 20 条', () => {
  const ctx = makeContext();
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p } };
  const calls = [];
  ctx.setFetch(pagedFetch(calls));
  ctx.s.openNpcCard('a', p);
  return flush().then(() => {
    const mask = ctx.doc.getElementById('npc-card-modal');
    assert.equal(mask.querySelectorAll('.npc-hist-item').length, 20, '首屏 20 条');
    // 点开一条看完整原文（含换行）与公开变化
    const first = mask.querySelector('.npc-hist-item');
    first.querySelector('.npc-hist-summary').click();
    assert.equal(first.open, true, '详情可展开');
    assert.match(first.querySelector('.npc-hist-narration').textContent, /完整原文第 44 条/);
    assert.match(first.querySelector('.npc-hist-narration').textContent, /第二段留白也保留/, '原文完整不裁');
    assert.match(first.querySelector('.npc-hist-changes').textContent, /态度：0 → 44/);
    // 时间用 at
    assert.match(first.querySelector('.npc-hist-meta').textContent, /第45日 · 黄昏 · 第44回合/);
    assert.match(first.querySelector('.npc-hist-hero').textContent, /第2世 · 旧名0/);
    // 更多按钮分页
    const more = mask.querySelector('.npc-more-btn');
    assert.equal(more.hidden, false);
    more.click();
    return flush();
  }).then(() => {
    const mask = ctx.doc.getElementById('npc-card-modal');
    assert.equal(mask.querySelectorAll('.npc-hist-item').length, 40, '第二页再 20 条');
    mask.querySelector('.npc-more-btn').click();
    return flush();
  }).then(() => {
    const mask = ctx.doc.getElementById('npc-card-modal');
    assert.equal(mask.querySelectorAll('.npc-hist-item').length, 45, '全部 45 条可读');
    assert.equal(mask.querySelector('.npc-more-btn').hidden, true, '没有更多时收起按钮');
    // URL：首屏无 before，之后用排他 nextCursor
    assert.ok(calls[0].indexOf('/api/worlds/w1/npcs/') >= 0 && /limit=20/.test(calls[0]));
    assert.equal(/before=/.test(calls[0]), false, '首屏不带 before');
    assert.ok(calls.some((u) => /before=25/.test(u)), '第二页 before=25');
    assert.ok(calls.some((u) => /before=5/.test(u)), '第三页 before=5');
  });
});

test('XSS：名字/资料/原文均走 textContent，恶意 HTML 不创建元素、不执行', () => {
  const xss = '<img src=x onerror=alert(1)><script>bad()</script>';
  const ctx = makeContext();
  const p = profile(xss, { role: xss, latestExcerpt: xss });
  ctx.s.currentState = { npcProfiles: { a: p } };
  const badNarration = '<b>原文</b>' + xss;
  const histEntries = [entry(1, { narration: badNarration, changes: [] })];
  ctx.setFetch(() => Promise.resolve(okResponse(histResponse(histEntries, false, null, 1))));
  ctx.s.renderNpcList();
  const nameEl = ctx.doc.querySelector('.npc-name');
  assert.equal(nameEl.textContent, xss, '名字按文本原样显示');
  assert.equal(nameEl.childNodes.length, 0, '名字不生成任何子元素');
  assert.equal(ctx.doc.querySelectorAll('img, script, b').length, 0, '列表不创建恶意元素');
  ctx.s.openNpcCard('a', p);
  return flush().then(() => {
    const mask = ctx.doc.getElementById('npc-card-modal');
    assert.equal(mask.querySelectorAll('img, script, b').length, 0, '卡片不创建恶意元素');
    assert.match(mask.textContent, /onerror=alert\(1\)/, '资料按文本显示');
    assert.match(mask.querySelector('.npc-hist-narration').textContent, /<b>原文<\/b>/, '原文按文本显示');
    // 未自动 JSON 展示未知字段：卡片文本不含 JSON 结构痕迹
    assert.equal(mask.textContent.indexOf('{"'), -1, '不 JSON dump 未知字段');
  });
});

test('关闭：按钮 / 右上 × / 背景点击 / Escape；点卡片内部不关；滚动锁同步；关闭恢复焦点', () => {
  function open(width) {
    const ctx = makeContext({ width: width });
    const p = profile('阿青');
    ctx.s.currentState = { npcProfiles: { a: p } };
    ctx.s.renderNpcList();
    const openBtn = ctx.doc.querySelector('.npc-open');
    openBtn.focus();
    openBtn.click();
    return ctx;
  }
  // 手机：打开锁背景滚动，anyOverlayOpen 识别
  {
    const ctx = open(375);
    assert.equal(ctx.doc.body.style.overflow, 'hidden', '打开锁背景滚动');
    assert.equal(ctx.s.anyOverlayOpen(), true, 'anyOverlayOpen 识别 NPC 卡');
    ctx.s.closeNpcCard();
    assert.equal(ctx.doc.body.style.overflow, '', '关闭恢复背景滚动');
    assert.equal(ctx.s.anyOverlayOpen(), false);
  }
  // 关闭按钮
  {
    const ctx = open(1440);
    ctx.doc.querySelector('.npc-card-close').click();
    assert.equal(ctx.doc.getElementById('npc-card-modal'), null);
  }
  // 右上 ×（sheetCloseButton）
  {
    const ctx = open(375);
    ctx.doc.getElementById('npc-card-modal').querySelector('.sheet-close').click();
    assert.equal(ctx.doc.getElementById('npc-card-modal'), null);
  }
  // 背景点击关闭；点卡片内部不关
  {
    const ctx = open(1440);
    const mask = ctx.doc.getElementById('npc-card-modal');
    mask.querySelector('.npc-card-title').click();
    assert.equal(ctx.doc.getElementById('npc-card-modal'), mask, '点内部不关');
    mask.click(); // e.target === mask
    assert.equal(ctx.doc.getElementById('npc-card-modal'), null, '背景点击关闭');
  }
  // Escape 关闭 + 关闭恢复焦点
  {
    const ctx = open(1440);
    const trigger = ctx.doc.querySelector('.npc-open');
    ctx.doc.getElementById('npc-card-modal').querySelector('.npc-more-btn').focus();
    ctx.doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(ctx.doc.getElementById('npc-card-modal'), null, 'Escape 关闭');
    assert.equal(ctx.doc.activeElement, trigger, '关闭后焦点回到打开按钮');
  }
});

test('快捷键：NPC 卡打开时空格不翻动背后正文，关闭后可翻', () => {
  const ctx = makeContext({ width: 1440 });
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p } };
  const stream = ctx.doc.getElementById('stream');
  stream.scrollTop = 0;
  const space = () => ctx.doc.dispatchEvent({
    type: 'keydown', key: ' ', code: 'Space', shiftKey: false, target: ctx.doc,
  });
  ctx.s.openNpcCard('a', p);
  space();
  assert.equal(stream.scrollTop, 0, '卡片打开时空格不翻正文');
  ctx.s.closeNpcCard();
  space();
  assert.ok(stream.scrollTop > 0, '关闭后空格恢复翻页');
});

test('图片就绪：刷新卡片头像但保留已展开历史 / 滚动 / 焦点，不重建搜索框', () => {
  const ctx = makeContext({
    state: { npcProfiles: { a: profile('阿青') } },
    imageState: { items: {}, npcs: { 阿青: { status: 'pending' } }, scenes: {}, hero: {} },
  });
  ctx.s.renderNpcList();
  const search = ctx.doc.getElementById('npc-search');
  const p = ctx.s.currentState.npcProfiles.a;
  // 首屏请求在 openNpcCard 内同步发出，须在打开前设好假数据。
  ctx.setFetch(() => Promise.resolve(okResponse(histResponse([entry(1)], false, null, 1))));
  ctx.s.openNpcCard('a', p);
  const mask = ctx.doc.getElementById('npc-card-modal');
  const slot = mask.querySelector('.npc-card-hero-slot');
  assert.ok(slot.querySelector('.img-pending') || slot.querySelector('.img-fallback'), 'pending 用占位');
  // 展开一条历史、设置滚动与焦点
  return flush().then(() => {
    const item = mask.querySelector('.npc-hist-item');
    item.open = true;
    mask.scrollTop = 123;
    const more = mask.querySelector('.npc-more-btn');
    more.focus();
    // 图片就绪
    ctx.s.imageState = { items: {}, npcs: { 阿青: { status: 'ready', url: '/img/a.png' } }, scenes: {}, hero: {} };
    ctx.s.renderImages();
    assert.ok(slot.querySelector('img.npc-card-hero'), '头像刷成 img');
    assert.equal(item.open, true, '已展开历史不重置');
    assert.equal(mask.scrollTop, 123, '滚动位置不重置');
    assert.equal(ctx.doc.activeElement, more, '焦点不重置');
    assert.equal(ctx.doc.getElementById('npc-search'), search, '不重画列表搜索框');
    assert.equal(ctx.doc.getElementById('npc-card-modal'), mask, '不重建卡片');
  });
});

test('防串卡：关闭 / 快速开另一人物 / 切世界后，旧请求不把资料写进新卡片', async () => {
  // 关闭后旧响应
  {
    const ctx = makeContext();
    const d = deferred();
    ctx.setFetch(() => d.promise);
    const p = profile('阿青');
    ctx.s.currentState = { npcProfiles: { a: p } };
    ctx.s.openNpcCard('a', p);
    ctx.s.closeNpcCard();
    const e = entry(1, { narration: '【迟到的原文】' });
    d.resolve(okResponse(histResponse([e], false, null, 1)));
    await flush();
    assert.equal(ctx.doc.getElementById('npc-card-modal'), null, '关闭后卡片不存在');
  }
  // 快速开另一人物：旧人物响应不串进新卡片
  {
    const ctx = makeContext();
    const dA = deferred(), dB = deferred();
    ctx.setFetch((url) => (url.indexOf('n1') >= 0 ? dA.promise : dB.promise));
    const p1 = profile('阿青'), p2 = profile('白露');
    ctx.s.currentState = { npcProfiles: { n1: p1, n2: p2 } };
    ctx.s.openNpcCard('n1', p1);
    ctx.s.openNpcCard('n2', p2);
    dA.resolve(okResponse(histResponse([entry(1, { narration: '【阿青的旧原文】' })], false, null, 1)));
    await flush();
    const mask = ctx.doc.getElementById('npc-card-modal');
    assert.ok(mask, '新卡片在');
    assert.equal(mask.textContent.indexOf('【阿青的旧原文】'), -1, '旧人物响应不写入新卡片');
    dB.resolve(okResponse(histResponse([entry(2, { narration: '【白露的原文】' })], false, null, 1)));
    await flush();
    assert.match(mask.textContent, /【白露的原文】/, '新人物历史正常写入');
  }
  // 切世界：旧 worldId 的响应被丢弃
  {
    const ctx = makeContext();
    const d = deferred();
    ctx.setFetch(() => d.promise);
    const p = profile('阿青');
    ctx.s.currentState = { npcProfiles: { a: p } };
    ctx.s.openNpcCard('a', p);
    ctx.s.currentWorldId = 'w2';
    d.resolve(okResponse(histResponse([entry(1, { narration: '【旧世界原文】' })], false, null, 1)));
    await flush();
    const mask = ctx.doc.getElementById('npc-card-modal');
    assert.equal(mask.textContent.indexOf('【旧世界原文】'), -1, '跨世界旧请求被丢弃');
  }
});

// ---------------------------------------------------------------- 第 1 轮返工：实际边界

test('首屏 HTTP profile：hint 为空也显示完整资料，原位更新标题 / 头像引用，不重置历史 / 滚动 / 焦点', () => {
  const ctx = makeContext({
    imageState: { items: {}, npcs: { 阿青: { status: 'ready', url: '/img/http.png' } }, scenes: {}, hero: {} },
  });
  const full = profile('阿青', {
    id: 'a', description: 'HTTP 返回的完整描述', role: '巡夜人',
    traits: { appearance: { 披风: '玄色' } },
    initial: { description: 'HTTP 最初形象', traits: {} },
  });
  const d = deferred();
  ctx.setFetch(() => d.promise);
  ctx.s.openNpcCard('a', {});   // hint 空
  const mask = ctx.doc.getElementById('npc-card-modal');
  const closeBtn = mask.querySelector('.npc-card-close');
  closeBtn.focus();
  mask.scrollTop = 77;
  assert.match(mask.textContent, /更多资料尚未透露/, '首屏到位前 hint 为空只给提示');
  d.resolve(okResponse({
    profile: full,
    history: { entries: [entry(1)], hasMore: false, nextCursor: null, total: 1 },
  }));
  return flush().then(() => {
    const text = mask.textContent;
    assert.match(text, /HTTP 返回的完整描述/, '概况来自 HTTP profile');
    assert.match(text, /玄色/, 'traits 来自 HTTP profile');
    assert.match(text, /HTTP 最初形象/, 'initial 来自 HTTP profile');
    assert.match(mask.querySelector('.npc-card-title').textContent, /阿青/, '标题更新');
    assert.match(mask.querySelector('.npc-card-role').textContent, /巡夜人/, '身份更新');
    const slot = mask.querySelector('.npc-card-hero-slot');
    const heroImg = slot.querySelector('img.npc-card-hero');
    assert.ok(heroImg, '头像引用按新 portraitName 刷新成 ready 图');
    assert.equal(heroImg.src, '/img/http.png', '头像 src 指向 HTTP 资料对应的图');
    assert.equal(ctx.doc.activeElement, closeBtn, '焦点不重置');
    assert.equal(mask.scrollTop, 77, '滚动不重置');
    assert.equal(mask.querySelectorAll('.npc-hist-item').length, 1, '历史条目正常写入');
  });
});

test('首屏 profile 只应用一次：后续翻页不重画资料区、不重置已展开历史 / 滚动 / 焦点', async () => {
  const ctx = makeContext();
  const full = profile('阿青', { id: 'a', description: 'HTTP 描述' });
  const calls = [];
  ctx.setFetch((url) => {
    calls.push(url);
    const m = url.match(/[?&]before=([^&]*)/);
    const key = m ? decodeURIComponent(m[1]) : 'null';
    if (key === 'null') return Promise.resolve(okResponse({
      profile: full,
      history: { entries: mkEntries(24, 20), hasMore: true, nextCursor: 20, total: 25 },
    }));
    return Promise.resolve(okResponse({   // 后续页也带 profile，但不应再应用
      profile: full,
      history: { entries: mkEntries(19, 0), hasMore: false, nextCursor: null, total: 25 },
    }));
  });
  ctx.s.openNpcCard('a', {});
  await flush();
  const mask = ctx.doc.getElementById('npc-card-modal');
  const overview = mask.querySelector('.npc-sec');   // 资料区首块
  const item = mask.querySelector('.npc-hist-item');
  item.open = true;
  mask.scrollTop = 55;
  const more = mask.querySelector('.npc-more-btn');
  more.focus();
  more.click();
  await flush();
  assert.ok(calls.length >= 2, '确实翻了页');
  assert.match(mask.textContent, /HTTP 描述/, '资料仍在');
  assert.equal(mask.querySelector('.npc-sec'), overview, '资料区节点不重画、不抖动');
  assert.equal(item.open, true, '已展开历史不重置');
  assert.equal(mask.scrollTop, 55, '滚动不重置');
  assert.equal(ctx.doc.activeElement, more, '焦点不重置');
});

test('首屏 profile：非同 id / 空资料不覆盖当前人物', async () => {
  {
    const ctx = makeContext();
    const p = profile('阿青', { id: 'a' });
    ctx.s.currentState = { npcProfiles: { a: p } };
    ctx.setFetch(() => Promise.resolve(okResponse({
      profile: profile('白露', { id: 'b', description: '别人家的描述' }),
      history: { entries: [], hasMore: false, nextCursor: null, total: 0 },
    })));
    ctx.s.openNpcCard('a', p);
    await flush();
    const mask = ctx.doc.getElementById('npc-card-modal');
    assert.match(mask.querySelector('.npc-card-title').textContent, /阿青/, '标题仍属当前人物');
    assert.equal(mask.textContent.indexOf('别人家的描述'), -1, '非同 id 资料不采用');
  }
  {
    const ctx = makeContext();
    const p = profile('阿青', { id: 'a', description: '来自 hint 的资料' });
    ctx.s.currentState = { npcProfiles: { a: p } };
    ctx.setFetch(() => Promise.resolve(okResponse({
      profile: {},  // 空资料：不重画、不擦掉 hint
      history: { entries: [], hasMore: false, nextCursor: null, total: 0 },
    })));
    ctx.s.openNpcCard('a', p);
    await flush();
    assert.match(ctx.doc.getElementById('npc-card-modal').textContent, /来自 hint 的资料/, '空 profile 保留 hint 资料');
  }
});

test('模态框：可访问名称 / 初始焦点 / Tab 边界；空格翻页既有行为不变', async () => {
  const ctx = makeContext({ width: 1440 });
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p } };
  ctx.setFetch(() => Promise.resolve(okResponse({
    profile: {}, history: { entries: [entry(1)], hasMore: false, nextCursor: null, total: 1 },
  })));
  ctx.s.openNpcCard('a', p);
  await flush();
  const mask = ctx.doc.getElementById('npc-card-modal');
  assert.equal(mask.getAttribute('role'), 'dialog');
  assert.equal(mask.getAttribute('aria-modal'), 'true');
  assert.equal(mask.getAttribute('aria-labelledby'), 'npc-card-title', '有可访问名称');
  assert.ok(mask.querySelector('#npc-card-title'), '名称指向标题');
  assert.equal(mask.getAttribute('tabindex'), '-1');
  assert.ok(mask.contains(ctx.doc.activeElement), '打开后焦点移入卡片');
  for (let i = 0; i < 6; i++) ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab' });
  assert.ok(mask.contains(ctx.doc.activeElement), 'Tab 焦点不出背景');
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
  assert.ok(mask.contains(ctx.doc.activeElement), 'Shift+Tab 焦点不出背景');
  const stream = ctx.doc.getElementById('stream');
  stream.scrollTop = 0;
  const space = () => ctx.doc.dispatchEvent({
    type: 'keydown', key: ' ', code: 'Space', shiftKey: false, target: ctx.doc,
  });
  space();
  assert.equal(stream.scrollTop, 0, '卡片开着空格不翻正文');
  ctx.s.closeNpcCard();
  space();
  assert.ok(stream.scrollTop > 0, '关闭后空格恢复翻页');
});

test('关闭恢复焦点：行被重画后回到当前同 NPC 按钮，名单移除后退到搜索框', () => {
  {
    const ctx = makeContext({ state: { npcProfiles: { a: profile('阿青') } } });
    ctx.s.renderNpcList();
    const btn = ctx.doc.querySelector('.npc-open');
    btn.focus();
    btn.click();
    assert.ok(ctx.doc.getElementById('npc-card-modal'), '卡片已开');
    ctx.s.currentState = { npcProfiles: { a: profile('阿青', { role: '巡夜人' }) } }; // 资料真变化 → 重画
    ctx.s.renderNpcList();
    const newBtn = ctx.doc.querySelector('.npc-open');
    assert.notEqual(newBtn, btn, '行已重建');
    assert.equal(btn.isConnected, false, '旧触发按钮已断开');
    ctx.s.closeNpcCard();
    assert.equal(ctx.doc.activeElement, newBtn, '焦点回到当前同 NPC 按钮');
  }
  {
    const ctx = makeContext({ state: { npcProfiles: { a: profile('阿青') } } });
    ctx.s.renderNpcList();
    const search = ctx.doc.getElementById('npc-search');
    const btn = ctx.doc.querySelector('.npc-open');
    btn.focus();
    btn.click();
    ctx.s.currentState = { npcProfiles: {} };  // 名单清空
    ctx.s.renderNpcList();
    ctx.s.closeNpcCard();
    assert.equal(ctx.doc.activeElement, search, '同 NPC 按钮不存在时退到搜索框');
  }
});

test('图片轮询：资料 / 查询未变只刷头像，音色下拉不收起、行内焦点不丢', () => {
  const ctx = makeContext({
    state: { npcProfiles: { a: profile('阿青') } },
    imageState: { items: {}, npcs: { 阿青: { status: 'pending' } }, scenes: {}, hero: {} },
  });
  ctx.s.renderNpcList();
  const row = ctx.doc.querySelector('.npc-row');
  const voiceRow = ctx.doc.querySelector('.npc-voice-row');
  row.querySelector('.npc-voice-btn').click();   // 展开音色下拉
  assert.equal(voiceRow.hidden, false, '音色下拉已展开');
  const sel = voiceRow.querySelector('select.npc-voice-select');
  assert.ok(sel, '下拉里有 select');
  sel.focus();
  ctx.s.imageState = { items: {}, npcs: { 阿青: { status: 'ready', url: '/img/a.png' } }, scenes: {}, hero: {} };
  ctx.s.renderImages();                          // 图片轮询
  assert.equal(ctx.doc.querySelector('.npc-row'), row, '行节点不被重建');
  assert.equal(ctx.doc.querySelector('.npc-voice-row'), voiceRow, '下拉节点不被重建');
  assert.equal(voiceRow.hidden, false, '下拉不收起');
  assert.equal(ctx.doc.querySelector('select.npc-voice-select'), sel, 'select 不被重建');
  assert.equal(ctx.doc.activeElement, sel, '行内焦点不丢');
  assert.ok(row.querySelector('img.npc-avatar'), '头像刷成 ready 图');
});

test('Esc 只关最上层：大图开着先收大图留住人物卡，再按才关卡；普通 Esc 仍直接关卡', async () => {
  {
    const ctx = makeContext();
    const p = profile('阿青');
    ctx.s.currentState = { npcProfiles: { a: p } };
    ctx.setFetch(() => Promise.resolve(okResponse(histResponse([entry(1)], false, null, 1))));
    ctx.s.openNpcCard('a', p);
    await flush();
    const mask = ctx.doc.getElementById('npc-card-modal');
    const viewer = ctx.doc.getElementById('image-viewer');
    ctx.s.openImageViewer('/img/a.png');   // 大图盖在人物卡上
    assert.equal(viewer.hidden, false);
    assert.ok(mask, '人物卡还在底下');
    ctx.doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(viewer.hidden, true, '先收最上层大图');
    assert.equal(ctx.doc.getElementById('npc-card-modal'), mask, '留住人物卡');
    ctx.doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(ctx.doc.getElementById('npc-card-modal'), null, '再按才关卡');
  }
  {
    const ctx = makeContext();
    const p = profile('阿青');
    ctx.s.currentState = { npcProfiles: { a: p } };
    ctx.setFetch(() => Promise.resolve(okResponse(histResponse([entry(1)], false, null, 1))));
    ctx.s.openNpcCard('a', p);
    await flush();
    ctx.doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(ctx.doc.getElementById('npc-card-modal'), null, '普通 Esc（无大图）直接关卡');
  }
});

test('未知时间：day=0 / life=0 标未记载，turn=0 保留第0回合，不拿现实时间 / 当前姓名补', async () => {
  const ctx = makeContext();
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p }, character: { name: '现在的我' } };
  const e = entry(1, { at: { turn: 0, life: 0, clock: { day: 0, period: '' } }, changes: [] });
  ctx.setFetch(() => Promise.resolve(okResponse({
    profile: {}, history: { entries: [e], hasMore: false, nextCursor: null, total: 1 },
  })));
  ctx.s.openNpcCard('a', p);
  await flush();
  const text = ctx.doc.getElementById('npc-card-modal').textContent;
  assert.match(text, /第0回合/, 'turn=0 作为开场回合保留');
  assert.equal(text.indexOf('第0日'), -1, 'day=0 不显示第0日');
  assert.equal(text.indexOf('第0世'), -1, 'life=0 不显示第0世');
  assert.match(text, /时间未记载/, '缺游戏日标未记载');
  assert.match(text, /世数未记载/, '世数 0 标未记载');
  assert.equal(text.indexOf('现在的我'), -1, '不用当前主角姓名补');
  assert.equal(text.indexOf('2026'), -1, '不出现现实年份');
});

test('公开变化数组：私有 scope / 路径与未知字段整体被忽略，合法变化仍显示', async () => {
  const ctx = makeContext();
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p } };
  const evil = [
    { field: 'internal.motivation', to: '暗中复仇' },
    { label: 'original.want', from: 'a', to: 'b' },
    { scope: 'internal', field: '态度', to: '敌意' },
    { path: 'secret.note', label: '笔记', to: '不该看的内容' },
    'internal.motivation → 私密文本',
    { weird: { nested: '不该整体显示' }, to: { private: '对象值' } },
    { field: '态度', from: '0', to: '4' },
    '一句公开变化文本',
  ];
  ctx.setFetch(() => Promise.resolve(okResponse({
    profile: {},
    history: { entries: [entry(1, { changes: evil })], hasMore: false, nextCursor: null, total: 1 },
  })));
  ctx.s.openNpcCard('a', p);
  await flush();
  const wrap = ctx.doc.querySelector('.npc-hist-changes');
  assert.ok(wrap, '仍有公开变化可显示');
  const txt = wrap.textContent;
  assert.equal(txt.indexOf('internal.motivation'), -1, '私有路径不显示');
  assert.equal(txt.indexOf('original.want'), -1, '私有路径不显示');
  assert.equal(txt.indexOf('暗中复仇'), -1, '私有值不显示');
  assert.equal(txt.indexOf('敌意'), -1, '私有 scope 整条忽略');
  assert.equal(txt.indexOf('不该看的内容'), -1, '私有 path 整条忽略');
  assert.equal(txt.indexOf('私密文本'), -1, '私有字符串不显示');
  assert.equal(txt.indexOf('不该整体显示'), -1, '未知字段对象值不整体显示');
  assert.equal(txt.indexOf('{'), -1, '不整体 JSON 化未知字段');
  assert.match(txt, /态度：0 → 4/, '合法公开变化仍显示');
  assert.match(txt, /一句公开变化文本/, '普通公开文本仍显示');
});

test('搜索：按已知描述 / 最近原文 / 公开关系线索找人，只搜当前公共资料', () => {
  const ctx = makeContext({
    state: { npcProfiles: {
      a: profile('阿青', { description: '总在城门下替人挡刀', latestExcerpt: '', relationshipSummary: '' }),
      b: profile('白露', { description: '', latestExcerpt: '雨夜里递来一把伞', relationshipSummary: '' }),
      c: profile('陈伯', { description: '', latestExcerpt: '', relationshipSummary: '与你师父是旧识' }),
    } },
  });
  ctx.s.renderNpcList();
  const search = ctx.doc.getElementById('npc-search');
  function rowsFor(q) {
    search.value = q;
    search.dispatchEvent({ type: 'input' });
    return ctx.doc.querySelectorAll('.npc-row').length;
  }
  assert.equal(rowsFor('挡刀'), 1, '按 description 找人');
  assert.equal(rowsFor('递来一把伞'), 1, '按 latestExcerpt 找人');
  assert.equal(rowsFor('旧识'), 1, '按公开关系线索找人');
  assert.equal(rowsFor('查无此线索'), 0, '未知线索不匹配');
  assert.equal(rowsFor(''), 3, '清空恢复全部');
  assert.ok(!/全文|全史/.test(search.getAttribute('placeholder')), '不声称历史全文检索');
});

test('切世界：同一世界轮询 / 重画保留查询，真正换世界清旧查询', () => {
  const ctx = makeContext({ state: { npcProfiles: { a: profile('阿青'), b: profile('白露') } } });
  ctx.s.renderNpcList();
  const search = ctx.doc.getElementById('npc-search');
  search.value = '白';
  search.dispatchEvent({ type: 'input' });
  assert.equal(ctx.s.npcSearchQuery, '白');
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 1, '按旧词过滤');
  ctx.s.renderImages();      // 图片轮询
  ctx.s.renderNpcList();     // 面板重画
  assert.equal(ctx.s.npcSearchQuery, '白', '同一世界保留查询');
  assert.equal(search.value, '白', '搜索框值保留');
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 1, '仍按查询过滤');
  ctx.s.currentWorldId = 'w2';
  ctx.s.currentState = { npcProfiles: { x: profile('新人甲'), y: profile('新人乙') } };
  ctx.s.renderNpcList();
  assert.equal(ctx.s.npcSearchQuery, '', '换世界清旧查询');
  assert.equal(ctx.doc.getElementById('npc-search').value, '', '可见过滤词也清掉');
  assert.equal(ctx.doc.querySelectorAll('.npc-row').length, 2, '新世界名单不被旧词隐藏');
});

// ---------------------------------------------------------------- 静态检查（项目习惯）
test('接线：npcs.js 在 main.js 之前引入；弹层 / 翻页 / 切世界都识别 NPC 卡', () => {
  const p = html.indexOf('<script src="/js/npcs.js"></script>');
  const m = html.indexOf('<script src="/js/main.js"></script>');
  assert.ok(p >= 0 && m > p, 'npcs.js 应在 main.js 之前');
  assert.match(srcCore, /getElementById\('npc-card-modal'\)/, 'anyOverlayOpen 识别 NPC 卡');
  assert.match(srcGame, /anyOverlayOpen\(\)\) return/, '翻页 keydown 加弹层守卫');
  assert.match(srcHome, /closeNpcCard\(\)/, 'hideAllViews 切世界关闭卡片');
  assert.match(srcImages, /refreshNpcCardPortrait/, 'renderImages 刷新卡片头像');
});

test('安全：npcs.js 无 innerHTML / 外链 / JSON dump / 私有字段读取；CSS 16px 输入与 ≥40px 触点', () => {
  assert.equal(/\.innerHTML/.test(srcNpcs), false, '不得用 innerHTML');
  assert.equal(/https?:\/\//.test(srcNpcs), false, '不得引用外部地址');
  assert.equal(/JSON\.stringify/.test(srcNpcs), false, '不得整体 JSON 展示未知字段');
  assert.equal(/\.(internal|original|want)\b/.test(srcNpcs), false, '不得读取私有字段');
  assert.match(srcNpcs, /textContent/, '资料走 textContent');
  assert.match(srcNpcs, /\.portraitName/, '头像用 portraitName 稳定映射');
  assert.match(srcNpcs, /npcProfiles/, '读取公共 npcProfiles');
  // CSS：16px 输入、≥40px 触点、卡片内滚动、ellipsis、手机 85vh
  assert.match(css, /\.npc-search\{[^}]*font-size:16px/, '搜索输入 16px');
  assert.match(css, /\.npc-open\{[^}]*min-height:40px/, '档案按钮 ≥40px');
  assert.match(css, /\.npc-card\{[^}]*overflow-y:auto/, '卡片内滚动');
  assert.match(css, /\.npc-clue\{[^}]*text-overflow:ellipsis/, '线索 CSS 截断、不裁存储');
  assert.match(css, /@media \(max-width:600px\)\{[\s\S]*?\.npc-card\{[^}]*max-height:85vh/, '手机 bottom sheet 85vh');
});

test('npcs.js 语法合法、可被浏览器解析', () => {
  assert.doesNotThrow(() => new vm.Script(srcNpcs));
});

// ---------------------------------------------------------------- 第 2 轮：本地界面验收修正

test('概况描述区分初见/最近：灰布旧衣初见与一袭青衫当前各有清楚标识，模型正文不改写', () => {
  const ctx = makeContext();
  const firstDesc = '头发花白，常穿一件洗得发白的灰布旧衣，右手裹着绷带';
  const p = profile('林伯', {
    description: firstDesc,                       // 与 initial.description 相同：仍是初见正文
    initial: {
      role: '听雨药铺的坐堂药师', description: firstDesc, voice: '',
      traits: { appearance: { 衣着: '灰布旧衣' } },
    },
    traits: { appearance: { 衣着: '一袭青衫' } }, // 第25回合单项变化后的当前特征
  });
  ctx.s.currentState = { npcProfiles: { lin: p } };
  ctx.s.openNpcCard('lin', p);
  const mask = ctx.doc.getElementById('npc-card-modal');
  const secs = mask.querySelectorAll('.npc-sec');
  const overview = secs.find((s) => /已知人物概况/.test(s.textContent));
  const traits = secs.find((s) => /已知特征/.test(s.textContent));

  // 概况明确标「初见描述」，灰布旧衣正文原样保留、不自动改写
  assert.match(overview.textContent, /初见描述/, '与初见一致标为初见描述');
  assert.equal(/最近描述/.test(overview.textContent), false, '初见时不得标成最近描述');
  assert.match(overview.textContent, /灰布旧衣/, '初见正文原样保留');
  assert.equal(/一袭青衫/.test(overview.textContent), false, '初见描述区不混入当前青衫');

  // 当前特征清楚展示青衫，并有小提示说明以当前特征/经历为准、初始形象留存最初记录
  assert.match(traits.textContent, /一袭青衫/, '当前特征清楚显示青衫');
  assert.match(traits.textContent, /单项变化/, '提示点明后续单项变化');
  assert.match(traits.textContent, /当前特征/, '提示点明以当前特征为准');
  assert.match(traits.textContent, /经历/, '提示点明以经历为准');
  assert.match(traits.textContent, /最初记录/, '提示点明初始形象留存在最初记录');

  // 资料不丢：初见的灰布旧衣完整留存在最初记录（即便默认折叠，仍在 DOM）
  const ini = mask.querySelector('details.npc-initial');
  assert.match(ini.textContent, /灰布旧衣/, '最初记录里灰布旧衣资料不丢');
  assert.equal(ctx.s.currentState.npcProfiles.lin.description, firstDesc, '公共资料正文不被改写');
});

test('概况描述更新后标为「最近描述」，新描述正文照常展示、不被吞', () => {
  const ctx = makeContext();
  const firstDesc = '头发花白，常穿一件洗得发白的灰布旧衣，右手裹着绷带';
  const p = profile('林伯', {
    description: '如今换上一袭青衫，神清气爽',
    initial: { description: firstDesc },         // 已不同于初见 → 最近描述
  });
  ctx.s.currentState = { npcProfiles: { lin: p } };
  ctx.s.openNpcCard('lin', p);
  const overview = ctx.doc.querySelector('.npc-sec');
  assert.match(overview.textContent, /最近描述/, '更新过的描述标为最近描述');
  assert.equal(/初见描述/.test(overview.textContent), false, '不再是初见描述');
  assert.match(overview.textContent, /如今换上一袭青衫，神清气爽/, '新描述正文照常展示');
});

test('最初记录默认折叠、原生 details/summary 可展开，完整资料仍在 DOM', () => {
  const ctx = makeContext();
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p } };
  ctx.s.openNpcCard('a', p);
  const mask = ctx.doc.getElementById('npc-card-modal');
  const ini = mask.querySelector('details.npc-initial');
  assert.ok(ini, '最初记录是原生 details');
  assert.equal(ini.open, false, '默认折叠，前半部分先让玩家认人');
  const sum = ini.querySelector('summary');
  assert.ok(sum, '有原生 summary 可点');
  assert.match(sum.textContent, /最初记录 · 最初公开形象/);
  // 折叠也在 DOM：完整资料 textContent 可读，点开即可见
  assert.match(ini.textContent, /最初在城门下见到/, '初见形象完整留在 DOM');
  assert.match(ini.textContent, /最初记载：第1日/, '最初记载完整留在 DOM');
  sum.click();
  assert.equal(ini.open, true, '点标题可展开');
  // 新增的可聚焦 summary 不破坏 Tab 约束 / 背景关闭
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab' });
  assert.ok(mask.contains(ctx.doc.activeElement), 'Tab 焦点仍约束在卡片内');
  mask.click();                                  // e.target === mask → 关闭
  assert.equal(ctx.doc.getElementById('npc-card-modal'), null, '背景点击仍直接关卡');
});

test('首屏 HTTP 更新资料：沿用最初记录展开状态、保持焦点/滚动，未展开时也不强制展开', async () => {
  const ctx = makeContext();
  const full = profile('阿青', { id: 'a', description: 'HTTP 描述' });
  const d = deferred();
  ctx.setFetch(() => d.promise);
  ctx.s.openNpcCard('a', {});                    // hint 空 → 首屏套用 HTTP 资料
  const mask = ctx.doc.getElementById('npc-card-modal');
  const ini = mask.querySelector('details.npc-initial');
  const sum = ini.querySelector('summary');
  sum.click();                                  // HTTP 到位前玩家已展开
  sum.focus();
  assert.equal(ini.open, true, '先展开最初记录');
  mask.scrollTop = 88;
  d.resolve(okResponse({
    profile: full,
    history: { entries: [entry(1)], hasMore: false, nextCursor: null, total: 1 },
  }));
  await flush();
  assert.match(mask.textContent, /HTTP 描述/, '首屏资料照常套用');
  const ini2 = mask.querySelector('details.npc-initial');
  assert.equal(ini2.open, true, '沿用既有展开状态，不重置成折叠');
  assert.equal(mask.scrollTop, 88, '滚动不重置');
  assert.ok(mask.contains(ctx.doc.activeElement), '焦点仍在卡片内');
  assert.equal(ctx.doc.activeElement, ini2.querySelector('summary'), '焦点落到新的最初记录标题');
  assert.equal(mask.querySelectorAll('.npc-hist-item').length, 1, '历史条目正常写入、不受影响');
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab' });
  assert.ok(mask.contains(ctx.doc.activeElement), 'Tab 焦点不出卡片');
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(ctx.doc.getElementById('npc-card-modal'), null, 'Esc 仍直接关卡');

  // 未展开时：HTTP 更新后仍保持折叠，不强制展开
  const ctx2 = makeContext();
  const full2 = profile('阿青', { id: 'a', description: 'HTTP 描述2' });
  const d2 = deferred();
  ctx2.setFetch(() => d2.promise);
  ctx2.s.openNpcCard('a', {});
  assert.equal(ctx2.doc.querySelector('details.npc-initial').open, false, '默认折叠');
  d2.resolve(okResponse({
    profile: full2,
    history: { entries: [], hasMore: false, nextCursor: null, total: 0 },
  }));
  await flush();
  assert.equal(ctx2.doc.querySelector('details.npc-initial').open, false, '未展开时 HTTP 更新后仍折叠');
});

test('旧记录 fallback 的 mention 用保守「相关记载」，不推断仅被提及 / 已见面；interaction/change 不变', () => {
  const ctx = makeContext();
  const p = profile('林伯');
  ctx.s.currentState = { npcProfiles: { a: p } };
  const entries = [
    entry(3, { kind: 'interaction', excerpt: '当面递刀', action: '拱手', narration: 'A原文', changes: [] }),
    // 实际在场互动（林伯替你续茶）被旧记录保守归入 mention：不能推断「仅被提及」
    entry(2, { kind: 'mention', excerpt: '林伯替你续了半盏温茶', action: '在药铺帮忙',
      narration: 'B原文：老人在柜台后替你续茶', changes: [] }),
    entry(1, { kind: 'change', excerpt: '换了装束', action: '观察', narration: 'C原文',
      changes: [{ label: '衣着', to: '一袭青衫' }] }),
  ];
  ctx.setFetch(() => Promise.resolve(okResponse(histResponse(entries, false, null, 3))));
  ctx.s.openNpcCard('a', p);
  return flush().then(() => {
    const mask = ctx.doc.getElementById('npc-card-modal');
    const kinds = mask.querySelectorAll('.npc-kind').map((k) => k.textContent);
    assert.deepEqual(kinds, ['相处', '相关记载', '资料变化'], 'interaction/change 名称不变');
    const item = mask.querySelectorAll('.npc-hist-item')[1];
    assert.match(item.textContent, /相关记载/, 'mention 标为相关记载');
    assert.equal(/仅被提及|已见面|相识|当面/.test(item.textContent), false,
      '不把旧日志写成仅被提及或已见面');
    assert.match(item.textContent, /林伯替你续了半盏温茶/, '在场互动原文仍可回看');
  });
});

// ---------------------------------------------------------------- 第 3 轮：公开变化真实形状回归
// 直接调用 renderNpcChanges（真实 vm 执行的代码），逐条看 .npc-change 文本。
function changeRows(changes) {
  const ctx = makeContext();
  const wrap = ctx.s.renderNpcChanges(changes);
  if (!wrap) return [];
  return wrap.querySelectorAll('.npc-change').map((r) => r.textContent);
}

test('第3轮：衣着技术路径变中文，已知标量字段映射中文，私密字段先过滤', () => {
  const rows = changeRows([
    { field: 'traits.appearance.衣着', from: '灰布旧衣', to: '一袭青衫' }, // 第25回合真实例
    { field: 'role', from: '更夫', to: '坐堂药师' },
    { field: 'description', to: '换了个精神头' },
    { field: 'voice', to: '温和' },
    { field: 'publicGoal', to: '守好药铺' },
    { field: 'relationshipSummary', to: '与你师父是旧识' },
    { label: '衣着', to: '红衣' },                       // 合法自定义中文标签 / 原值保留
    { field: 'internal.motivation', to: '暗中复仇' },    // 私密字段整条忽略
  ]);
  const text = rows.join('\n');
  // 技术路径不再暴露，映射成人类可读标签 + 原值
  assert.match(text, /外貌·衣着：灰布旧衣 → 一袭青衫/, '衣着路径映射为「外貌·衣着」');
  assert.match(text, /身份：更夫 → 坐堂药师/, 'role → 身份');
  assert.match(text, /描述：换了个精神头/, 'description → 描述');
  assert.match(text, /口吻：温和/, 'voice → 口吻');
  assert.match(text, /公开目标：守好药铺/, 'publicGoal → 公开目标');
  assert.match(text, /关系：与你师父是旧识/, 'relationshipSummary → 关系');
  // 产品流程绝不出现代码字段 / 技术路径
  assert.equal(text.indexOf('traits.appearance'), -1, '不出现 traits.appearance');
  assert.equal(text.indexOf('relationshipSummary'), -1, '不出现 relationshipSummary');
  assert.equal(text.indexOf('publicGoal'), -1, '不出现 publicGoal');
  assert.equal(text.indexOf('role：'), -1, '不出现代码字段名 role');
  // 合法自定义中文标签与原值保留
  assert.match(text, /衣着：红衣/, '自定义中文标签保留');
  assert.match(text, /灰布旧衣/, '原值 from 保留');
  assert.match(text, /一袭青衫/, '原值 to 保留');
  // 私密过滤仍先执行
  assert.equal(text.indexOf('internal.motivation'), -1, '私有路径不显示');
  assert.equal(text.indexOf('暗中复仇'), -1, '私有值不显示');
});

test('第3轮：旧格式好感 delta 显示「好感 +1 / -1」，不捏造旧绝对值、不空壳', () => {
  const rows = changeRows([
    { field: 'attitude', delta: 1 },
    { field: 'attitude', delta: -1 },
    { label: 'attitude', delta: 3 },
    { field: '好感', delta: -2 },
  ]);
  const text = rows.join('\n');
  assert.match(text, /好感 \+1/, 'delta +1');
  assert.match(text, /好感 -1/, 'delta -1');
  assert.match(text, /好感 \+3/, 'label 形式的 delta +3');
  assert.match(text, /好感 -2/, '中文标签的 delta -2');
  // 不暴露代码字段、不出现空壳、不捏造 from → to 绝对好感值
  assert.equal(text.indexOf('attitude'), -1, '不暴露代码字段 attitude');
  assert.equal(text.indexOf('attitude：'), -1, '不出现 attitude：空壳');
  assert.equal(/：/.test(text), false, 'delta 不用冒号拼空壳');
  assert.equal(/→/.test(text), false, 'delta 不捏造旧绝对好感值（无 from → to）');
});

test('第3轮：无有效值 / 非有限 delta / 空白 / 未认识形状不渲染空壳', () => {
  const rows = changeRows([
    { field: 'attitude' },                        // 无 delta、无 from/to
    { field: 'attitude', delta: NaN },           // 非有限 delta
    { field: 'attitude', delta: Infinity },
    { field: 'attitude', delta: 'abc' },         // 非数值 delta
    { field: 'attitude', delta: '' },            // 空白 delta
    { field: 'attitude', delta: null },
    { field: 'identity' },                       // 已知字段但无值
    { field: 'role', to: '' },                   // 空白 to
    { field: 'internal.x' },                     // 私密且无值
    { weird: { nested: '不该整体显示' }, to: { private: '对象值' } }, // 未知对象不整体序列化
    '   ',                                       // 空白字符串
    {},                                          // 空对象
  ]);
  assert.equal(rows.length, 0, '全部不渲染，绝不出「字段：」空壳');
});

test('第3轮：数字 0 作为明确 from/to 正常显示，私密字段仍过滤', () => {
  const rows = changeRows([
    { field: 'attitude', from: 0, to: 0 },                    // 合法 0，不因真值判定丢失
    { label: '好感', from: 0, to: 4 },
    { field: 'traits.personality.性子', from: 0, to: 1 },
    { field: 'internal.motivation', to: '暗中复仇' },          // 私密过滤
    { scope: 'internal', field: 'role', to: '间谍' },          // 私密 scope 整条忽略
    { field: 'role', to: '' },                                // 空白 to 不出空壳
  ]);
  const text = rows.join('\n');
  assert.match(text, /好感：0 → 0/, '数字 0 作为 from/to 不丢');
  assert.match(text, /好感：0 → 4/, '数字 0 作为 from 不丢');
  assert.match(text, /性格·性子：0 → 1/, 'traits 分类路径 + 0 正常显示');
  assert.equal(text.indexOf('internal.motivation'), -1, '私有字段仍过滤');
  assert.equal(text.indexOf('暗中复仇'), -1, '私有值不显示');
  assert.equal(text.indexOf('间谍'), -1, '私密 scope 整条忽略');
  assert.equal(text.indexOf('身份'), -1, '空白 to 不出「身份：」空壳');
});

test('第3轮：卡片展开第25回合与旧格式第20回合，变化按可读中文呈现、无技术路径与空壳', async () => {
  const ctx = makeContext();
  const p = profile('林伯');
  ctx.s.currentState = { npcProfiles: { a: p } };
  const turn25 = entry(25, {
    narration: '他换下灰布旧衣，着一袭青衫。',
    changes: [{ field: 'traits.appearance.衣着', from: '灰布旧衣', to: '一袭青衫' }],
  });
  const turn20 = entry(20, {
    narration: '好感略有变化。',
    changes: [{ field: 'attitude', delta: 1 }],
  });
  ctx.setFetch(() => Promise.resolve(okResponse(histResponse([turn25, turn20], false, null, 2))));
  ctx.s.openNpcCard('a', p);
  await flush();
  const mask = ctx.doc.getElementById('npc-card-modal');
  const items = mask.querySelectorAll('.npc-hist-item');
  const t25 = items[0].querySelector('.npc-hist-changes').textContent;
  const t20 = items[1].querySelector('.npc-hist-changes').textContent;
  assert.match(t25, /外貌·衣着：灰布旧衣 → 一袭青衫/, '第25回合衣着变化可读');
  assert.equal(t25.indexOf('traits.appearance'), -1, '第25回合不暴露技术路径');
  assert.match(t20, /好感 \+1/, '旧格式第20回合好感 +1');
  assert.equal(t20.indexOf('attitude'), -1, '旧格式不暴露 attitude');
  assert.equal(/：|空壳/.test(t20), false, '旧格式不出现 attitude：空壳');
});

// ---------------------------------------------------------------- 第 3 轮：跨 CSS/DOM 键盘边界
// 桌面 CSS 把 .sheet-close 设为 display:none（仅手机 media query 显示）。旧 npcCardTrapTab
// 只过滤 .hidden，把这个无布局盒的按钮当成最后一个焦点，导致从可见的底部关闭键按 Tab
// 时焦点落到 body。这里用 fake DOM 的 getClientRects / getComputedStyle 能力模拟真实 CSS 可见性。
async function openModalCard(width) {
  const ctx = makeContext({ width: width });
  const p = profile('阿青');
  ctx.s.currentState = { npcProfiles: { a: p } };
  ctx.setFetch(() => Promise.resolve(okResponse({
    profile: {}, history: { entries: [entry(1)], hasMore: false, nextCursor: null, total: 1 },
  })));
  ctx.s.openNpcCard('a', p);
  await flush();
  return ctx;
}

test('Tab 边界：桌面 CSS 隐藏的末尾 .sheet-close 不进焦点循环（无布局盒 / computed display:none）', async () => {
  for (const mode of ['rects', 'computed']) {
    const ctx = await openModalCard(1440);
    const mask = ctx.doc.getElementById('npc-card-modal');
    const first = mask.querySelector('summary');            // 最初记录 summary = 首个可聚焦元素
    const bottomClose = mask.querySelector('.npc-card-close');
    const sheetClose = mask.querySelector('.sheet-close');
    assert.ok(first && bottomClose && sheetClose, '两个关闭键与首个 summary 都在 DOM');

    // 模拟桌面 CSS：末尾的右上 × 不可见（display:none / 无布局盒）
    if (mode === 'rects') sheetClose.__clientRects = [];
    else sheetClose.__computed = { display: 'none' };

    // 焦点在「可见的底部关闭键」按 Tab：应回绕到首个可见元素，不被隐藏的右上 × 占住末位
    bottomClose.focus();
    ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab' });
    assert.equal(ctx.doc.activeElement, first, `${mode}: Tab 从可见末尾回绕到首个可见元素`);
    assert.notEqual(ctx.doc.activeElement, sheetClose, `${mode}: 不跳到 CSS 隐藏的右上 ×`);
    assert.ok(mask.contains(ctx.doc.activeElement), `${mode}: 焦点始终留在卡片内`);

    // 反向：Shift+Tab 从首个元素应回到最后一个「可见」元素（底部关闭键）
    first.focus();
    ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
    assert.equal(ctx.doc.activeElement, bottomClose, `${mode}: Shift+Tab 回到可见的底部关闭键`);
    assert.notEqual(ctx.doc.activeElement, sheetClose, `${mode}: Shift+Tab 也不落到隐藏的右上 ×`);
  }
});

test('Tab 边界：手机 .sheet-close 可见时纳入循环；闭合 details 下隐藏控件排除、视口外可滚动按钮仍纳入', async () => {
  const ctx = await openModalCard(375);
  const mask = ctx.doc.getElementById('npc-card-modal');
  const first = mask.querySelector('summary');
  const bottomClose = mask.querySelector('.npc-card-close');
  const sheetClose = mask.querySelector('.sheet-close');
  const details = mask.querySelector('details');

  // 手机：右上 × 可见，是最后一个可聚焦元素；正向 / 反向循环都经过它
  first.focus();
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
  assert.equal(ctx.doc.activeElement, sheetClose, '手机 Shift+Tab 回到可见的右上 ×');
  sheetClose.focus();
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab' });
  assert.equal(ctx.doc.activeElement, first, '手机 Tab 从右上 × 回绕到首个元素');

  // 闭合 details 下的不可见控件（无布局盒）不进焦点列表
  const hidden = ctx.doc.createElement('button');
  hidden.className = 'details-hidden-btn';
  hidden.__clientRects = [];
  details.appendChild(hidden);

  // 桌面化：右上 × 隐藏；底部关闭键虽「在视口外」（长卡滚动才可见），但有布局盒 → 仍纳入。
  sheetClose.__clientRects = [];
  bottomClose.getBoundingClientRect = () => ({ top: 99999, left: 0, width: 300, height: 600 });
  first.focus();
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
  assert.equal(ctx.doc.activeElement, bottomClose, '视口外但可见的底部关闭键仍是循环末位');
  assert.notEqual(ctx.doc.activeElement, hidden, '闭合 details 下无布局盒的控件不进循环');
  assert.notEqual(ctx.doc.activeElement, sheetClose, 'CSS 隐藏的右上 × 不进循环');
  bottomClose.focus();
  ctx.doc.dispatchEvent({ type: 'keydown', key: 'Tab' });
  assert.equal(ctx.doc.activeElement, first, 'Tab 从可见末位正常回绕');
});

test('接线：Tab 边界按 CSS 可见性 / 布局盒过滤，不用「视口外」判定', () => {
  assert.match(srcNpcs, /getClientRects/, '用布局盒判定可见性');
  assert.match(srcNpcs, /getComputedStyle/, '用 computed display/visibility 判定');
  assert.equal(/innerHeight|innerWidth|getBoundingClientRect/.test(srcNpcs), false,
    '不以视口外 / innerWidth 判定排除按钮（长卡可滚动按钮仍应纳入）');
});
