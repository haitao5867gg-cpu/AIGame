'use strict';

// 序章卡片：全屏遮罩 + 居中可滚动卡片。
// 只用 el()/textContent 构建 DOM；onStart 为函数时是首次进入（按钮「开始」），
// 为 null 时是重看（按钮「继续」）。点遮罩空白处等同点按钮。
function showPrologue(title, prologue, onStart) {
  var old = document.getElementById('prologue-mask');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var mask = el('div', 'prologue-mask');
  mask.id = 'prologue-mask';
  var card = el('div', 'prologue-card');
  card.appendChild(el('h2', 'prologue-title', title || '序章'));

  var sections = [
    ['这个世界', prologue && prologue.world],
    ['你是谁', prologue && prologue.me],
    ['你想要的', prologue && prologue.goal],
    ['此刻', prologue && prologue.now],
  ];
  sections.forEach(function (sec) {
    var block = el('section', 'prologue-section');
    block.appendChild(el('h3', 'prologue-sub', sec[0]));
    block.appendChild(el('p', 'prologue-text', sec[1] == null ? '' : String(sec[1])));
    card.appendChild(block);
  });

  var closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    syncBodyScrollLock(); // 关闭后恢复背景滚动
    if (typeof onStart === 'function') onStart();
  }

  var btn = el('button', 'btn primary prologue-start', onStart ? '开始' : '继续');
  btn.addEventListener('click', close);
  card.appendChild(btn);
  card.appendChild(sheetCloseButton(close)); // 手机 bottom sheet 右上角关闭 ×

  // 点遮罩空白处（非卡片内）关闭，等同点按钮。
  mask.addEventListener('click', function (e) {
    if (e.target === mask) close();
  });

  mask.appendChild(card);
  document.body.appendChild(mask);
  syncBodyScrollLock(); // 手机：打开弹层锁定背景滚动
  return mask;
}
