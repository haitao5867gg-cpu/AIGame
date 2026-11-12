'use strict';

// 灵感按钮：静态检查源文件 + 用 vm + 最小假 DOM 真实执行 game.js 抽出的
// resetIdeas / fillIdea / nextIdea，验证队列、请求、去重、串世界、busy 等行为。
// 只读 public 源文件，不请求网络、不碰 DOM。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public');
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const html = read('index.html');
const coreJs = read('js/core.js');
const gameJs = read('js/game.js');
const mainJs = read('js/main.js');
const css = read('app.css');

// 抽出 app.css 里所有 @media (max-width:600px) 规则体（大括号配对）。
function mediaBodies(re) {
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
const m600 = mediaBodies(/@media\s*\(\s*max-width:\s*600px\s*\)\s*\{/g);

// ===== 静态 =====

test('index.html：删掉 #suggestions，输入框与发送按钮之间有 #btn-idea 灵感按钮', () => {
  assert.ok(!/id="suggestions"/.test(html), 'index.html 不再有 #suggestions 胶囊容器');
  assert.match(html, /id="btn-idea"/, '应有 #btn-idea');
  const iInput = html.indexOf('id="action-input"');
  const iIdea = html.indexOf('id="btn-idea"');
  const iSend = html.indexOf('id="btn-send"');
  assert.ok(iInput >= 0 && iIdea > iInput && iSend > iIdea,
    '#btn-idea 应夹在 #action-input 与 #btn-send 之间');
  assert.match(html, /class="btn idea-btn"/, '灵感按钮用 .btn.idea-btn');
  assert.match(html, /✦ 灵感/, '按钮文案为 ✦ 灵感');
});

test('core.js 不再有 DEFAULT_SUGGESTIONS；game.js 不再有 renderSuggestions / #suggestions', () => {
  assert.ok(!/DEFAULT_SUGGESTIONS/.test(coreJs), 'core.js 去掉默认建议常量');
  assert.ok(!/renderSuggestions/.test(gameJs), 'game.js 去掉 renderSuggestions');
  assert.ok(!/\$\('suggestions'\)/.test(gameJs), 'game.js 不再取 #suggestions');
});

test('game.js：showGame / 重生 / renderResult 三处改 resetIdeas，setBusy 同步禁用灵感按钮', () => {
  assert.ok((gameJs.match(/resetIdeas\(/g) || []).length >= 4, '定义 + 三处调用');
  assert.match(gameJs, /resetIdeas\(atmosphereLastLog && atmosphereLastLog\.suggestions\)/,
    'showGame 取 log 末条记录的 suggestions');
  assert.match(gameJs, /resetIdeas\(\[\]\)/, '重生清空队列');
  assert.match(gameJs, /resetIdeas\(res\.suggestions\)/, 'renderResult 用回合结果');
  assert.match(gameJs, /\$\('btn-idea'\)\.disabled\s*=\s*b \|\| ideaLoading/, 'setBusy 同步禁用');
  assert.ok(!/renderSuggestions\(/.test(gameJs), '不再调用 renderSuggestions');
});

test('main.js：绑定 #btn-idea click → nextIdea()，Alt+I 快捷键 → nextIdea()', () => {
  assert.match(mainJs, /\$\('btn-idea'\)\.addEventListener\('click',\s*nextIdea\)/, '灵感按钮绑定 click');
  assert.match(mainJs, /e\.altKey\s*&&\s*\(e\.key === 'i' \|\| e\.key === 'I' \|\| e\.code === 'KeyI'\)/,
    'Alt+I 判定条件');
  const seg = mainJs.slice(mainJs.indexOf('e.altKey'), mainJs.indexOf('e.altKey') + 220);
  assert.match(seg, /e\.preventDefault\(\)/, 'Alt+I 阻止默认');
  assert.match(seg, /nextIdea\(\)/, 'Alt+I 调 nextIdea');
});

test('app.css：.idea-btn 默认 / 夜色 / 纸页 / 手机规则齐全，且没有 .suggestion 规则', () => {
  assert.match(css, /\.idea-btn\{/, '默认 .idea-btn 规则');
  assert.match(css, /body\[data-genre\] \.idea-btn\{/, '夜色 .idea-btn');
  assert.match(css, /body\[data-genre\]\[data-read="paper"\] \.idea-btn/, '纸页 .idea-btn');
  assert.match(m600, /\.idea-btn[^{]*\{[^}]*min-height\s*:\s*44px/, '手机 .idea-btn 44px');
  assert.match(m600, /#btn-send[^{]*\{[^}]*flex\s*:\s*none/, '手机 #btn-send 不收缩');
  assert.match(m600, /#action-input\{[^}]*min-width\s*:\s*0/, '手机 textarea min-width:0');
  assert.ok(!/\.suggestion/.test(css), 'app.css 不再有 .suggestion / .suggestions 规则');
});

test('app.css：disabled 双态光标、0.6s 发光动画、reduced-motion 降级', () => {
  assert.match(css, /\.idea-btn:disabled\{[^}]*opacity:\.55[^}]*cursor:not-allowed/, 'disabled 样式');
  assert.match(css, /\.idea-btn\[aria-busy="true"\]\{cursor:wait\}/, '请求中 wait 光标');
  assert.match(css, /@keyframes idea-flash-anim\{/, '闪光关键帧');
  assert.match(css, /\.idea-btn\.idea-flash\{animation:idea-flash-anim \.6s/, '0.6s 动画');
  assert.match(css, /rgba\(var\(--g-accent-rgb,192,57,43\),\.25\)/, '发光用强调色');
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.idea-btn\.idea-flash\{animation:none\}\}/,
    '减少动态效果时不做动画');
});

test('game.js 灵感逻辑关键片段（静态兜底）', () => {
  assert.match(gameJs, /ideaToken\+\+/, 'resetIdeas 自增 token 作废在途响应');
  assert.match(gameJs, /dispatchEvent\(new Event\('input'\)\)/, '派发 input 让手机自动增高生效');
  assert.match(gameJs, /setSelectionRange\(text\.length, text\.length\)/, '光标放到末尾');
  assert.match(gameJs, /encodeURIComponent\(myWorld\) \+ '\/suggest'/, '请求 /suggest');
  assert.match(gameJs, /avoid: ideaShown\.slice\(-12\)/, 'avoid 带上已填建议');
  assert.match(gameJs, /toast\('这次没想出新点子，再点一次试试'\)/, '没新点子的提示');
  assert.match(gameJs, /myToken !== ideaToken \|\| myWorld !== currentWorldId/, '过期响应丢弃判定');
});

// ===== 行为：vm + 最小假 DOM 真实执行 game.js 抽出的三个函数 =====

function section(src, fromStr, toStr) {
  const i = src.indexOf(fromStr);
  assert.ok(i >= 0, '应能定位 ' + fromStr);
  const j = src.indexOf(toStr, i + fromStr.length);
  assert.ok(j > i, '应能定位 ' + toStr);
  return src.slice(i, j);
}
const ideaSrc = section(gameJs, '/* IDEA_HELPERS_START */', '/* IDEA_HELPERS_END */');

test('可抽出 IDEA_HELPERS 段（resetIdeas / fillIdea / nextIdea）', () => {
  assert.match(ideaSrc, /function resetIdeas\(/);
  assert.match(ideaSrc, /function fillIdea\(/);
  assert.match(ideaSrc, /async function nextIdea\(/);
  assert.match(ideaSrc, /var ideaQueue|ideaQueue = \[\]/);
  assert.match(ideaSrc, /var ideaShown|ideaShown = \[\]/);
  assert.match(ideaSrc, /var ideaLoading|ideaLoading = false/);
  assert.match(ideaSrc, /var ideaToken|ideaToken = 0/);
});

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this._classes = [];
    this.attrs = {};
    this.events = [];
    this.focusCount = 0;
    this.selStart = -1;
    this.selEnd = -1;
    this.offsetWidth = 0;
  }
  get classList() {
    const self = this;
    return {
      contains(c) { return self._classes.includes(c); },
      add(c) { if (!self._classes.includes(c)) self._classes.push(c); },
      remove(c) { self._classes = self._classes.filter((x) => x !== c); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { this.focusCount++; }
  setSelectionRange(a, b) { this.selStart = a; this.selEnd = b; }
  dispatchEvent(ev) { this.events.push(ev); }
}

function makeEnv() {
  const byId = { 'action-input': new FakeEl('textarea'), 'btn-idea': new FakeEl('button') };
  const toasts = [];
  const apiCalls = [];
  const timers = [];
  let apiImpl = () => Promise.resolve({ suggestions: [] });

  const sandbox = {
    // core.js 里的共享全局
    busy: false,
    currentWorldId: 'w1',
    // 依赖（host 函数，vm 代码可直接调用）
    $: (id) => byId[id] || null,
    toast: (msg) => { toasts.push(msg); },
    api: (pathname, opts) => {
      const call = { path: pathname, opts };
      apiCalls.push(call);
      return apiImpl(call);
    },
    Event: class FakeEvent { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    // Array / JSON / String / encodeURIComponent 等为 vm 上下文内置，无需注入
  };
  vm.createContext(sandbox);
  vm.runInContext(ideaSrc, sandbox);

  return {
    sandbox, byId,
    input: byId['action-input'], btn: byId['btn-idea'],
    toasts, apiCalls, timers,
    setApi: (fn) => { apiImpl = fn; },
    setBusy: (v) => { sandbox.busy = v; },
    setWorld: (v) => { sandbox.currentWorldId = v; },
    resetIdeas: sandbox.resetIdeas,
    fillIdea: sandbox.fillIdea,
    nextIdea: sandbox.nextIdea,
    get ideaQueue() { return Array.from(sandbox.ideaQueue); },
    get ideaShown() { return Array.from(sandbox.ideaShown); },
    get ideaLoading() { return sandbox.ideaLoading; },
    get ideaToken() { return sandbox.ideaToken; },
  };
}

test('队列有 3 条：连点 3 次依次填入，不发请求', async () => {
  const e = makeEnv();
  e.resetIdeas(['环顾四周', '向人打听', '查看行囊']);
  await e.nextIdea();
  assert.equal(e.input.value, '环顾四周');
  await e.nextIdea();
  assert.equal(e.input.value, '向人打听');
  await e.nextIdea();
  assert.equal(e.input.value, '查看行囊');
  assert.equal(e.apiCalls.length, 0, '队列有内容时不发请求');
  assert.deepEqual(e.ideaShown, ['环顾四周', '向人打听', '查看行囊']);
  assert.deepEqual(e.ideaQueue, []);
});

test('fillIdea：设值 / focus / 光标到末尾 / 派发 input / 按钮加 .idea-flash', () => {
  const e = makeEnv();
  e.resetIdeas([]);
  e.fillIdea('去城门看看');
  assert.equal(e.input.value, '去城门看看');
  assert.equal(e.input.focusCount, 1, 'focus 一次');
  assert.equal(e.input.selStart, '去城门看看'.length, '光标起点在末尾');
  assert.equal(e.input.selEnd, '去城门看看'.length, '光标终点在末尾');
  assert.equal(e.input.events.length, 1, '派发一次 input 事件');
  assert.equal(e.input.events[0].type, 'input');
  assert.ok(e.btn.classList.contains('idea-flash'), '按钮加 .idea-flash');
  assert.deepEqual(e.ideaShown, ['去城门看看']);
});

test('ideaShown 最多留 12 条（超过删最早）', () => {
  const e = makeEnv();
  e.resetIdeas([]);
  for (let i = 0; i < 15; i++) e.fillIdea('第' + i + '条');
  assert.equal(e.ideaShown.length, 12);
  assert.equal(e.ideaShown[0], '第3条');
  assert.equal(e.ideaShown[11], '第14条');
});

test('队列用尽后点第 4 次：POST /suggest 带 avoid=前 3 条，返回后填入第一条', async () => {
  const e = makeEnv();
  e.resetIdeas(['A', 'B', 'C']);
  await e.nextIdea(); await e.nextIdea(); await e.nextIdea();
  e.setApi(() => Promise.resolve({ suggestions: ['D', 'E'] }));
  await e.nextIdea();
  assert.equal(e.apiCalls.length, 1, '只发一次请求');
  assert.equal(e.apiCalls[0].path, '/api/worlds/w1/suggest', '请求路径含当前世界 id');
  assert.equal(e.apiCalls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(e.apiCalls[0].opts.body).avoid, ['A', 'B', 'C'], 'avoid 是前 3 条');
  assert.equal(e.input.value, 'D', '填入返回的第一条');
  assert.deepEqual(e.ideaQueue, ['E'], '剩下一条留队列');
  assert.deepEqual(e.ideaShown, ['A', 'B', 'C', 'D']);
});

test('请求进行中：按钮 disabled / 文案「构思中…」/ aria-busy；再点不发第二个请求', async () => {
  const e = makeEnv();
  let resolve;
  e.setApi(() => new Promise((r) => { resolve = r; }));
  e.resetIdeas([]);
  const p = e.nextIdea();
  assert.equal(e.btn.disabled, true, '请求中禁用');
  assert.equal(e.btn.textContent, '构思中…');
  assert.equal(e.btn.attrs['aria-busy'], 'true');
  await e.nextIdea(); // 进行中再点
  assert.equal(e.apiCalls.length, 1, '进行中再点不发第二个请求');
  resolve({ suggestions: ['X'] });
  await p;
  assert.equal(e.input.value, 'X', '首个请求返回后填入');
  assert.equal(e.btn.textContent, '✦ 灵感', '恢复文案');
  assert.equal(e.btn.attrs['aria-busy'], undefined, '去掉 aria-busy');
  assert.equal(e.btn.disabled, false, '恢复可点');
  assert.equal(e.ideaLoading, false, '复位 loading');
});

test('请求返回时 currentWorldId 已变：丢弃响应、不填入', async () => {
  const e = makeEnv();
  let resolve;
  e.setApi(() => new Promise((r) => { resolve = r; }));
  e.resetIdeas(['A']);
  await e.nextIdea();
  assert.equal(e.input.value, 'A');
  const p = e.nextIdea();      // queue 空 → 发请求
  e.setWorld('w2');            // 返回前换了世界
  resolve({ suggestions: ['B'] });
  await p;
  assert.equal(e.input.value, 'A', '过期响应不覆盖输入框');
  assert.deepEqual(e.ideaQueue, [], '过期响应不进队列');
  assert.equal(e.ideaLoading, false);
});

test('请求返回前 resetIdeas（换场景/回合结果）：token 变化使旧响应作废', async () => {
  const e = makeEnv();
  let resolve;
  e.setApi(() => new Promise((r) => { resolve = r; }));
  e.resetIdeas([]);
  const t0 = e.ideaToken;
  const p = e.nextIdea();
  e.resetIdeas(['新场景建议']);
  assert.equal(e.ideaToken, t0 + 1, 'resetIdeas 自增 token');
  resolve({ suggestions: ['旧世界的点子'] });
  await p;
  assert.equal(e.input.value, '', '旧响应被丢弃，不填入');
  assert.deepEqual(e.ideaQueue, ['新场景建议'], '队列保持新场景的建议');
});

test('resetIdeas 后 ideaShown / 队列清空或换成新场景建议，复位 loading', () => {
  const e = makeEnv();
  e.resetIdeas(['A']);
  e.fillIdea('A');
  assert.deepEqual(e.ideaShown, ['A']);
  e.resetIdeas(['B', 'C']);
  assert.deepEqual(e.ideaShown, [], 'ideaShown 清空');
  assert.deepEqual(e.ideaQueue, ['B', 'C'], '队列换成新场景建议');
  assert.equal(e.ideaLoading, false, '复位 loading');
  assert.equal(e.btn.textContent, '✦ 灵感');
});

test('resetIdeas(list)：只留字符串、trim 非空、最多 3 条', () => {
  const e = makeEnv();
  e.resetIdeas([' 甲 ', '', '  ', 123, null, '乙', '丙', '丁']);
  assert.deepEqual(e.ideaQueue, ['甲', '乙', '丙']);
});

test('busy（回合进行中）时点击灵感无效', async () => {
  const e = makeEnv();
  e.setBusy(true);
  e.resetIdeas(['A']);
  await e.nextIdea();
  assert.equal(e.input.value, '', 'busy 时不填入');
  assert.equal(e.apiCalls.length, 0, 'busy 时不发请求');
});

test('没有 currentWorldId 时点击灵感不发请求', async () => {
  const e = makeEnv();
  e.setWorld(null);
  e.resetIdeas([]);
  await e.nextIdea();
  assert.equal(e.apiCalls.length, 0);
});

test('后端返回条目与已填重复：过滤；全被过滤时 toast 且不填入', async () => {
  const e = makeEnv();
  e.resetIdeas(['A', 'B', 'C']);
  await e.nextIdea(); await e.nextIdea(); await e.nextIdea();
  e.setApi(() => Promise.resolve({ suggestions: ['A', 'B', 'C'] }));
  await e.nextIdea();
  assert.equal(e.input.value, 'C', '没有新点子，输入框保持上一条');
  assert.deepEqual(e.ideaQueue, []);
  assert.ok(e.toasts.some((t) => /没想出新点子/.test(t)), '提示再点一次试试');
});

test('后端返回只有部分重复：跳过重复，只填新的', async () => {
  const e = makeEnv();
  e.resetIdeas(['A']);
  await e.nextIdea();
  e.setApi(() => Promise.resolve({ suggestions: ['A', 'B', 'C'] }));
  await e.nextIdea();
  assert.equal(e.input.value, 'B', '跳过重复的 A，填 B');
  assert.deepEqual(e.ideaQueue, ['C']);
});

test('请求出错：toast(err.message)，按钮恢复', async () => {
  const e = makeEnv();
  e.setApi(() => Promise.reject(new Error('灵感接口挂了')));
  e.resetIdeas([]);
  await e.nextIdea();
  assert.deepEqual(e.toasts, ['灵感接口挂了']);
  assert.equal(e.btn.textContent, '✦ 灵感');
  assert.equal(e.btn.attrs['aria-busy'], undefined);
  assert.equal(e.ideaLoading, false);
  assert.equal(e.btn.disabled, false);
});

test('输入框已有内容：点灵感直接替换、不提示', async () => {
  const e = makeEnv();
  e.input.value = '我自己写的行动';
  e.resetIdeas(['AI 给的灵感']);
  await e.nextIdea();
  assert.equal(e.input.value, 'AI 给的灵感', '直接替换');
  assert.equal(e.toasts.length, 0, '不弹任何提示');
});

test('串世界竞态：A 在途→切到 B 发新请求→A 旧请求（成功/失败）返回都不复位 B；B 返回后正常填入复位', async () => {
  for (const aOutcome of ['success', 'failure']) {
    const e = makeEnv();
    const pending = [];
    e.setApi(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }));
    e.resetIdeas([]);                          // 世界 A，队列空
    const pA = e.nextIdea();                   // A 请求在途
    e.setWorld('w2');                          // 玩家切到世界 B
    e.resetIdeas([]);                         // resetIdeas：token+1，作废 A、复位按钮
    const pB = e.nextIdea();                   // B 里点灵感 → 新请求，loading/按钮再次置位
    assert.equal(e.apiCalls.length, 2, aOutcome + '：只发了 A、B 两个请求');
    assert.equal(e.ideaLoading, true, aOutcome + '：B 请求进行中');
    assert.equal(e.btn.textContent, '构思中…', aOutcome + '：按钮「构思中…」');
    assert.equal(e.btn.disabled, true, aOutcome + '：按钮 disabled');

    // A 的旧请求这时返回：成功与失败各测一次
    if (aOutcome === 'success') pending[0].resolve({ suggestions: ['A的点子'] });
    else pending[0].reject(new Error('A 接口报错'));
    await pA;

    // 过期请求什么都不碰：B 的在途状态不被复位，玩家不能重复点击
    assert.equal(e.ideaLoading, true, aOutcome + '：A 返回后 ideaLoading 仍 true');
    assert.equal(e.btn.textContent, '构思中…', aOutcome + '：A 返回后按钮仍「构思中…」');
    assert.equal(e.btn.disabled, true, aOutcome + '：A 返回后按钮仍 disabled');
    assert.equal(e.input.value, '', aOutcome + '：A 的响应不填入');
    assert.deepEqual(e.ideaQueue, [], aOutcome + '：A 的响应不进队列');
    assert.equal(e.toasts.length, 0, aOutcome + '：旧世界失败也不给新世界弹 toast');
    await e.nextIdea();                        // 玩家此时再点
    assert.equal(e.apiCalls.length, 2, aOutcome + '：B 在途，再点不发第三个请求');

    // B 正常返回：填入并复位
    pending[1].resolve({ suggestions: ['B的点子'] });
    await pB;
    assert.equal(e.input.value, 'B的点子', aOutcome + '：B 返回后填入');
    assert.equal(e.ideaLoading, false, aOutcome + '：B 返回后复位 loading');
    assert.equal(e.btn.textContent, '✦ 灵感', aOutcome + '：B 返回后按钮复位');
    assert.equal(e.btn.disabled, false, aOutcome + '：B 返回后可点');
    assert.equal(e.btn.attrs['aria-busy'], undefined, aOutcome + '：B 返回后去掉 aria-busy');
  }
});
