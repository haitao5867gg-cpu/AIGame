'use strict';
var BgmStats = (function () {
  var MOOD_LABELS = { calm: '平静', explore: '探索', tense: '遇险' };
  var MOOD_RANK = { calm: 0, explore: 1, tense: 2 };
  var SORTS = [
    ['theme', '按题材'],
    ['plays', '播放最多'],
    ['seconds', '收听最久'],
    ['skiprate', '切走率最高'],
  ];
  var modal = null, previousFocus = null, data = null, keydownHandler = null;

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function formatSeconds(seconds) {
    var s = num(seconds);
    if (s < 0) s = 0;
    if (s < 60) return Math.round(s) + ' 秒';
    return Math.round(s / 60) + ' 分钟';
  }

  function skipRate(track) {
    var plays = num(track && track.plays);
    if (plays <= 0) return -1;
    return num(track.skips) / plays;
  }

  function sortTracks(tracks, mode) {
    var indexed = (tracks || []).map(function (t, i) { return { t: t, i: i }; });
    if (mode === 'plays' || mode === 'seconds' || mode === 'skiprate') {
      var value = function (t) {
        if (mode === 'plays') return num(t.plays);
        if (mode === 'seconds') return num(t.seconds);
        return skipRate(t);
      };
      indexed.sort(function (a, b) { return value(b.t) - value(a.t) || a.i - b.i; });
    } else {
      // 按题材：组顺序按各题材在 tracks 里第一次出现的顺序；组内档位 平静→探索→遇险；再按原数组顺序。
      var themeRank = {}, nextRank = 0;
      indexed.forEach(function (x) {
        var key = String(x.t && x.t.themeName);
        if (!(key in themeRank)) themeRank[key] = nextRank++;
      });
      var rankOf = function (t) { return themeRank[String(t && t.themeName)]; };
      var moodOf = function (t) {
        var m = t && t.mood;
        return m in MOOD_RANK ? MOOD_RANK[m] : 99;
      };
      indexed.sort(function (a, b) {
        return rankOf(a.t) - rankOf(b.t) || moodOf(a.t) - moodOf(b.t) || a.i - b.i;
      });
    }
    return indexed.map(function (x) { return x.t; });
  }

  function rowText(track) {
    if (!track || !track.hasFile) return '还没有音频文件';
    var plays = num(track.plays), skips = num(track.skips);
    var parts = ['播放 ' + plays + ' 次', '收听 ' + formatSeconds(track.seconds)];
    var skip = '切走 ' + skips + ' 次';
    if (plays > 0) skip += '（' + Math.round(skips / plays * 100) + '%）';
    parts.push(skip);
    parts.push('播完 ' + num(track.ends) + ' 次');
    parts.push(num(track.listeners) + ' 人听过');
    if (num(track.fails) > 0) parts.push('出错 ' + num(track.fails) + ' 次');
    return parts.join(' · ');
  }

  function metaText(track, grouped) {
    var text = String((track && track.artist) || '') + ' · ' + (MOOD_LABELS[track && track.mood] || '');
    if (!grouped) text += ' · ' + String((track && track.themeName) || '');
    if (track && track.builtin) text += ' · 自带';
    return text;
  }

  function makeRow(track, grouped) {
    var cls = 'bgm-stats-row' + (track && track.hasFile ? '' : ' bgm-stats-missing');
    var row = el('div', cls);
    var head = el('div');
    head.appendChild(el('span', 'bgm-stats-title', track && track.title));
    head.appendChild(el('span', 'bgm-stats-meta', metaText(track, grouped)));
    row.appendChild(head);
    row.appendChild(el('div', 'bgm-stats-nums', rowText(track)));
    return row;
  }

  function currentMode() {
    var sel = document.getElementById('bgm-stats-sort');
    return sel ? sel.value : 'theme';
  }

  function setSummary(text) {
    var line = document.getElementById('bgm-stats-summary');
    if (line) line.textContent = text;
  }

  function renderList() {
    var box = document.getElementById('bgm-stats-list');
    if (!box) return;
    box.textContent = '';
    if (!data || !Array.isArray(data.tracks)) return;
    var mode = currentMode();
    var grouped = mode === 'theme';
    var sorted = sortTracks(data.tracks, mode);
    var lastTheme = null;
    sorted.forEach(function (track) {
      if (grouped && track.themeName !== lastTheme) {
        box.appendChild(el('h4', 'bgm-stats-group', track.themeName));
        lastTheme = track.themeName;
      }
      box.appendChild(makeRow(track, grouped));
    });
  }

  function onData(d) {
    if (!modal) return;
    data = d || {};
    var total = num(data.total), ready = num(data.ready);
    setSummary('共 ' + total + ' 首，' + ready + ' 首已有音频，' + (total - ready) + ' 首还缺文件');
    renderList();
  }

  function onError(err) {
    if (!modal) return;
    var msg = (err && err.message) ? err.message : String(err || '');
    setSummary('读取失败：' + msg);
    var box = document.getElementById('bgm-stats-list');
    if (box) box.textContent = '';
    toast(msg);
  }

  function open() {
    if (modal) return;
    previousFocus = document.activeElement;
    modal = el('div', 'atmosphere-mask');
    modal.id = 'bgm-stats-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'bgm-stats-title');
    modal.tabIndex = -1;

    var card = el('div', 'atmosphere-card bgm-stats-card');
    var title = el('h3', '', '配乐统计');
    title.id = 'bgm-stats-title';
    card.appendChild(title);

    var summary = el('p', 'muted', '读取中…');
    summary.id = 'bgm-stats-summary';
    card.appendChild(summary);

    card.appendChild(el('p', 'muted', '切走率 = 被切走次数 ÷ 播放次数；播放不到 5 次的先别下结论。'));

    var sort = el('select');
    sort.id = 'bgm-stats-sort';
    SORTS.forEach(function (p) {
      var opt = el('option', '', p[1]);
      opt.value = p[0];
      sort.appendChild(opt);
    });
    sort.value = 'theme';
    sort.addEventListener('change', renderList);
    card.appendChild(sort);

    var list = el('div');
    list.id = 'bgm-stats-list';
    card.appendChild(list);

    var closeBtn = el('button', 'btn', '关闭');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', close);
    card.appendChild(closeBtn);
    card.appendChild(sheetCloseButton(close));

    modal.appendChild(card);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    document.body.appendChild(modal);

    keydownHandler = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', keydownHandler);

    syncBodyScrollLock();
    modal.focus();

    api('/api/bgm/stats').then(onData).catch(onError);
  }

  function close() {
    if (!modal) return;
    var old = modal;
    modal = null;
    if (old.parentNode) old.parentNode.removeChild(old);
    if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
    syncBodyScrollLock();
    var focus = previousFocus;
    previousFocus = null;
    if (focus && focus.isConnected && typeof focus.focus === 'function') focus.focus();
  }

  return {
    open: open, close: close,
    formatSeconds: formatSeconds, skipRate: skipRate, sortTracks: sortTracks, rowText: rowText,
  };
})();
if (typeof module === 'object' && module.exports) module.exports = BgmStats;
