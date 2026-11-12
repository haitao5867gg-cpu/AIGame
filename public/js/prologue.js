'use strict';

// 序章卡片：全屏遮罩 + 居中可滚动卡片。
// 只用 el()/textContent 构建 DOM；onStart 为函数时是首次进入（按钮「开始」），
// 为 null 时是重看（按钮「继续」）。点遮罩空白处等同点按钮。
// 第 4 个参数 opts 可选：{ origins, chosen, recommend, onChoose }。
//   origins 非空且未选出身时，在「你是谁」之后插入一张张出身卡，
//   选一个才能开始；选中后点按钮先 await onChoose(index)，失败则 toast 且不关闭。
function showPrologue(title, prologue, onStart, opts) {
  var old = document.getElementById('prologue-mask');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  opts = opts || {};
  var origins = Array.isArray(opts.origins) ? opts.origins : [];
  var chosen = !!opts.chosen;
  var recommend = Number.isFinite(opts.recommend) ? opts.recommend : -1;
  var showOrigins = origins.length > 0 && !chosen;

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
  var originCards = [];
  var selectedIndex = -1;
  var startBtn = null;
  sections.forEach(function (sec) {
    var block = el('section', 'prologue-section');
    block.appendChild(el('h3', 'prologue-sub', sec[0]));
    block.appendChild(el('p', 'prologue-text', sec[1] == null ? '' : String(sec[1])));
    card.appendChild(block);
    if (sec[0] === '你是谁' && showOrigins) {
      card.appendChild(buildOriginsSection());
    }
  });

  function buildOriginsSection() {
    var wrap = el('section', 'prologue-origins');
    wrap.appendChild(el('h3', 'prologue-sub', '选一个出身'));
    origins.forEach(function (o, i) {
      var c = el('button', 'origin-card');
      c.type = 'button';
      c.setAttribute('data-index', String(i));
      c.setAttribute('aria-pressed', 'false');
      c.appendChild(el('span', 'origin-title', (o && o.title) || ''));
      if (o && o.custom) c.appendChild(el('span', 'origin-tag', '按你写的'));
      if (i === recommend) c.appendChild(el('span', 'origin-tag recommend', '最像你'));
      c.appendChild(el('span', 'origin-blurb', (o && o.blurb) || ''));
      var attrsWrap = el('span', 'origin-attrs');
      var extra = (o && o.alloc) || {};
      ATTRS.forEach(function (a) {
        var v = Number(extra[a]) || 0;
        if (v > 0) attrsWrap.appendChild(el('span', 'origin-attr', a + ' +' + v));
      });
      c.appendChild(attrsWrap);
      if (o && o.item && o.item.name) {
        c.appendChild(el('span', 'origin-item', '带着：' + o.item.name));
      }
      c.addEventListener('click', function () { selectOrigin(i); });
      originCards.push(c);
      wrap.appendChild(c);
    });
    return wrap;
  }

  function selectOrigin(i) {
    selectedIndex = i;
    originCards.forEach(function (c, j) {
      var on = j === i;
      if (on) c.classList.add('selected');
      else c.classList.remove('selected');
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = '以「' + ((origins[i] && origins[i].title) || '') + '」开始';
    }
  }

  var closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    syncBodyScrollLock(); // 关闭后恢复背景滚动
    if (typeof onStart === 'function') onStart();
  }

  var choosing = false;
  async function onStartClick() {
    if (choosing || closed) return;
    if (showOrigins) {
      if (selectedIndex < 0) return; // 未选出身，按钮本就禁用
      if (typeof opts.onChoose === 'function') {
        choosing = true;
        try {
          await opts.onChoose(selectedIndex);
        } catch (err) {
          toast((err && err.message) || '选择出身失败，请重试');
          choosing = false;
          return; // 失败不关闭卡片
        }
        choosing = false;
      }
    }
    close();
  }

  var startText = showOrigins ? '先选一个出身' : (onStart ? '开始' : '继续');
  startBtn = el('button', 'btn primary prologue-start', startText);
  if (showOrigins) startBtn.disabled = true;
  startBtn.addEventListener('click', onStartClick);
  card.appendChild(startBtn);
  card.appendChild(sheetCloseButton(close)); // 手机 bottom sheet 右上角关闭 ×

  // 点遮罩空白处（非卡片内）关闭，等同点按钮；关闭等于暂不选择出身。
  mask.addEventListener('click', function (e) {
    if (e.target === mask) close();
  });

  mask.appendChild(card);
  document.body.appendChild(mask);
  syncBodyScrollLock(); // 手机：打开弹层锁定背景滚动
  return mask;
}
