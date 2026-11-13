'use strict';

// ---- 建世界等待弹窗 ----
// 全屏遮罩挡住页面（防乱点），卡片里：世界一句话、进度条、百分比、预计剩余时间、
// 步骤清单（读懂设定 → 构思世界 → 规划大纲 → 落笔）、当前步骤的动静（已写多少字）和卡住提示。
// 进度来自 GET /api/build-progress?cid=…（每秒一次），两次轮询之间按时间在本地平滑推进。
// 纯展示：建世界请求本身由 home.js 的 createWorld 发，弹窗只读进度。

// 算进度：snap 是服务器快照，localMs 是拿到快照后本地又过了多久。
// 返回 { frac(0~1), etaMs(null 表示说不准), stageFrac, idleMs, elapsedMs, totalExpectMs, overrun }。
function buildProgressMath(snap, localMs) {
  var stages = (snap && Array.isArray(snap.stages)) ? snap.stages : [];
  if (!stages.length) return { frac: 0, etaMs: null, stageFrac: 0, idleMs: 0, elapsedMs: 0, totalExpectMs: 0, overrun: false };
  var extra = Math.max(0, Number(localMs) || 0);
  var idx = Math.max(0, Math.min(stages.length - 1, Number(snap.stageIndex) || 0));
  var total = 0;
  var before = 0;
  stages.forEach(function (st, i) {
    var ms = Math.max(300, Number(st.expectMs) || 0);
    total += ms;
    if (i < idx) before += ms;
  });
  var cur = stages[idx];
  var expect = Math.max(300, Number(cur.expectMs) || 0);
  var elapsedStage = Math.max(0, (Number(snap.now) - Number(snap.stageStartedAt)) || 0) + extra;
  // 按时间：前 80% 线性，之后越来越慢，最多到 95%（不会在没写完时显示 100%）。
  var t = elapsedStage / expect;
  var timeFrac = t < 0.8 ? t : 0.8 + 0.15 * (1 - Math.exp(-(t - 0.8) * 2));
  // 按字数：模型在往外写时，已写字数 / 通常字数更准。
  var expectChars = Number(cur.expectChars) || 0;
  var charFrac = expectChars > 0 ? Math.min(0.97, (Number(snap.chars) || 0) / expectChars) : 0;
  var stageFrac = Math.min(0.97, Math.max(timeFrac, charFrac));
  if (snap.done) stageFrac = 1;
  var frac = snap.done ? 1 : Math.min(0.99, (before + stageFrac * expect) / total);
  var after = 0;
  for (var j = idx + 1; j < stages.length; j++) after += Math.max(300, Number(stages[j].expectMs) || 0);
  var overrun = elapsedStage > expect * 1.6;
  var curLeft = expect * (1 - stageFrac);
  // 已经写了不少字：按写字速度估这一步还要多久。
  if (charFrac > 0.15 && charFrac < 0.97 && elapsedStage > 0) {
    curLeft = Math.min(curLeft * 2, elapsedStage * (1 - charFrac) / charFrac);
  }
  var etaMs = snap.done ? 0 : (overrun && charFrac <= 0.15 ? null : Math.max(2000, curLeft) + after);
  var idleMs = Math.max(0, (Number(snap.now) - Number(snap.activityAt)) || 0) + extra;
  var elapsedMs = Math.max(0, (Number(snap.now) - Number(snap.startedAt)) || 0) + extra;
  return { frac: frac, etaMs: etaMs, stageFrac: stageFrac, idleMs: idleMs, elapsedMs: elapsedMs, totalExpectMs: total, overrun: overrun };
}

function formatEta(ms) {
  if (ms == null) return '比平时久一些，马上就好';
  var s = Math.ceil(ms / 1000);
  if (s <= 5) return '马上就好';
  if (s < 20) return '预计还要约 ' + s + ' 秒';
  if (s < 60) return '预计还要约 ' + (Math.round(s / 5) * 5) + ' 秒';
  var m = Math.floor(s / 60);
  var r = Math.round((s - m * 60) / 10) * 10;
  return '预计还要约 ' + m + ' 分' + (r ? ' ' + r + ' 秒' : '钟');
}

var BuildModal = (function () {
  var mask = null;
  var els = {};
  var snap = null;
  var snapAt = 0;
  var shown = 0;          // 已显示的进度（只增不减）
  var tick = null;
  var note = '';          // 额外提示（网络断了等），优先显示
  var finished = false;

  function stepRow(st, i) {
    var row = el('li', 'build-step');
    row.setAttribute('data-step', st.key);
    row.appendChild(el('span', 'build-step-dot'));
    row.appendChild(el('span', 'build-step-label', st.label));
    row.appendChild(el('span', 'build-step-detail', ''));
    return row;
  }

  function open(seed) {
    close();
    finished = false;
    snap = null;
    snapAt = Date.now();
    shown = 0;
    note = '';
    mask = el('div', 'build-mask');
    mask.id = 'build-mask';
    var card = el('div', 'build-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'build-title');
    var orb = el('div', 'build-orb');
    orb.setAttribute('aria-hidden', 'true');
    orb.appendChild(el('i'));
    orb.appendChild(el('i'));
    card.appendChild(orb);
    var title = el('h2', 'build-title', '正在创造世界');
    title.id = 'build-title';
    card.appendChild(title);
    if (seed) card.appendChild(el('p', 'build-seed', '「' + seed + '」'));
    var bar = el('div', 'build-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    var fill = el('div', 'build-bar-fill');
    bar.appendChild(fill);
    card.appendChild(bar);
    var meta = el('div', 'build-meta');
    var pct = el('span', 'build-pct', '0%');
    var eta = el('span', 'build-eta', '正在连接…');
    meta.appendChild(pct);
    meta.appendChild(eta);
    card.appendChild(meta);
    var steps = el('ol', 'build-steps');
    card.appendChild(steps);
    var status = el('p', 'build-status', '');
    status.setAttribute('aria-live', 'polite');
    card.appendChild(status);
    var actions = el('div', 'build-actions');
    actions.hidden = true;
    card.appendChild(actions);
    mask.appendChild(card);
    // 遮罩吞掉所有点击（防乱点），不提供点空白关闭。
    mask.addEventListener('click', function (e) { e.stopPropagation(); });
    document.body.appendChild(mask);
    document.body.classList.add('build-open');
    els = { card: card, bar: bar, fill: fill, pct: pct, eta: eta, steps: steps, status: status, actions: actions, title: title };
    // 还没拿到服务器进度时先按默认步骤画出来。
    update({ stages: [
      { key: 'prepare', label: '读懂你的设定', expectMs: 600 },
      { key: 'world', label: '构思世界、人物和出身', expectMs: 14000 },
      { key: 'outline', label: '规划故事大纲', expectMs: 27000 },
      { key: 'save', label: '落笔，整理成书', expectMs: 600 },
    ], stageIndex: 0, now: Date.now(), startedAt: Date.now(), stageStartedAt: Date.now(), activityAt: Date.now(), chars: 0, think: 0, placeholder: true });
    tick = setInterval(render, 250);
    render();
  }

  function update(s) {
    if (!mask || !s || !Array.isArray(s.stages)) return;
    var keys = s.stages.map(function (x) { return x.key; }).join(',');
    if (els.steps.getAttribute('data-keys') !== keys) {
      els.steps.textContent = '';
      s.stages.forEach(function (st, i) { els.steps.appendChild(stepRow(st, i)); });
      els.steps.setAttribute('data-keys', keys);
    }
    snap = s;
    snapAt = Date.now();
    render();
  }

  function setNote(text) {
    note = text || '';
    render();
  }

  function render() {
    if (!mask || !snap || finished) return;
    var m = buildProgressMath(snap, Date.now() - snapAt);
    shown = Math.max(shown, m.frac);
    var p = Math.round(shown * 100);
    els.fill.style.width = (shown * 100).toFixed(1) + '%';
    els.bar.setAttribute('aria-valuenow', String(p));
    els.pct.textContent = p + '%';
    els.eta.textContent = snap.placeholder ? '正在连接…' : formatEta(m.etaMs);
    var idx = Number(snap.stageIndex) || 0;
    var rows = els.steps.children;
    for (var i = 0; i < rows.length; i++) {
      var state = i < idx ? 'done' : (i === idx ? 'active' : 'todo');
      rows[i].setAttribute('data-state', state);
      var detail = '';
      if (i === idx && !snap.placeholder) {
        var key = rows[i].getAttribute('data-step');
        var chars = Number(snap.chars) || 0;
        var think = Number(snap.think) || 0;
        if (key === 'world' || key === 'outline') {
          if (chars > 0) detail = '已写 ' + chars.toLocaleString('zh-CN') + ' 字';
          else if (think > 0) detail = '构思中（已想 ' + think.toLocaleString('zh-CN') + ' 字）';
          else detail = '等模型开口…';
        }
      }
      var d = rows[i].querySelector('.build-step-detail');
      if (d && d.textContent !== detail) d.textContent = detail;
    }
    // 状态行：网络提示 > 很久没动静 > 比平时慢很多 > 一切正常。
    var text;
    var warn = false;
    if (note) { text = note; warn = true; }
    else if (snap.placeholder) text = '世界马上开始成形…';
    else if (m.idleMs > 25000 && !snap.done) {
      text = '模型已经 ' + Math.round(m.idleMs / 1000) + ' 秒没有新动静了，可能网关有点堵，再等等。';
      warn = true;
    } else if (m.elapsedMs > Math.max(90000, m.totalExpectMs * 3)) {
      text = '比平时慢很多。可以先去做别的，建好后会出现在首页「我的世界」里。';
      warn = true;
    } else {
      text = '一切正常，已用 ' + Math.round(m.elapsedMs / 1000) + ' 秒。';
    }
    if (els.status.textContent !== text) els.status.textContent = text;
    els.status.classList.toggle('warn', warn);
  }

  // 建好了：进度条走满，稍停一下再跳转。
  function done() {
    if (!mask) return;
    finished = true;
    els.fill.style.width = '100%';
    els.pct.textContent = '100%';
    els.eta.textContent = '完成';
    els.title.textContent = '世界成形了';
    var rows = els.steps.children;
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('data-state', 'done');
      var d = rows[i].querySelector('.build-step-detail');
      if (d) d.textContent = '';
    }
    els.status.classList.remove('warn');
    els.status.textContent = '正在进入…';
  }

  // 失败：显示原因，给「重试」和「关闭」（关闭后表单内容都还在）。
  function fail(message, onRetry) {
    if (!mask) return;
    finished = true;
    els.title.textContent = '这次没建成';
    els.eta.textContent = '';
    els.status.textContent = message || '建世界失败，请重试';
    els.status.classList.add('warn');
    els.card.classList.add('failed');
    els.actions.textContent = '';
    var closeBtn = el('button', 'btn', '关闭');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', close);
    els.actions.appendChild(closeBtn);
    if (typeof onRetry === 'function') {
      var retry = el('button', 'btn primary', '重试');
      retry.type = 'button';
      retry.addEventListener('click', function () { close(); onRetry(); });
      els.actions.appendChild(retry);
    }
    els.actions.hidden = false;
    var first = typeof onRetry === 'function' ? els.actions.lastChild : closeBtn;
    if (first && typeof first.focus === 'function') first.focus();
  }

  function close() {
    clearInterval(tick);
    tick = null;
    if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    mask = null;
    els = {};
    document.body.classList.remove('build-open');
  }

  function isOpen() { return !!mask; }

  return { open: open, update: update, setNote: setNote, done: done, fail: fail, close: close, isOpen: isOpen };
})();
