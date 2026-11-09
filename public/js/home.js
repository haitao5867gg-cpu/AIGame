'use strict';
  // ---- 路由 ----
  function hideAllViews() {
    ['view-home', 'view-new', 'view-game'].forEach(function (id) { $(id).hidden = true; });
    $('panel').dataset.open = 'false';
    syncBodyScrollLock(); // 路由切换收起抽屉时恢复背景滚动
    hideAttrTip(); // 切换视图时收起可能还开着的属性说明卡
    if (typeof closeNpcCard === 'function') closeNpcCard(); // 切世界 / 离开世界关闭人物卡
    setUndoVisible(false); // 复位撤回按钮二次确认态，重新进入世界时按后端状态再显隐
    clearInterval(pendingTimer);
    pendingTimer = null;
    stopImagePoll();     // 离开世界：停止 /images 轮询
    closeImageViewer();  // 收起可能还开着的大图
  }

  function route() {
    var h = location.hash || '#/';
    hideAllViews();
    if (h === '#/new') showNew();
    else if (h.indexOf('#/w/') === 0) showGame(decodeURIComponent(h.slice(4)));
    else showHome();
  }

  // ---- 首页 ----
  async function showHome() {
    $('view-home').hidden = false;
    var list = await api('/api/worlds').catch(function (err) { toast(err.message); return []; });
    renderWorldList(list);
  }

  function renderWorldList(list) {
    var box = $('world-list');
    box.textContent = '';
    $('world-empty').hidden = list.length > 0;
    // 玩法简介：没有世界时用大字醒目介绍，有世界时在列表下方用小字带一句。
    var intro = $('home-intro');
    intro.textContent = HOME_INTRO;
    intro.className = list.length ? 'home-intro small' : 'home-intro big';
    intro.hidden = false;
    list.forEach(function (w) {
      var card = el('div', 'world-card');
      card.appendChild(el('h3', '', w.title || '未命名世界'));
      var meta = el('div', 'meta');
      meta.appendChild(el('span', '', '第 ' + w.life + ' 世'));
      meta.appendChild(el('span', '', '第 ' + w.turn + ' 回合'));
      meta.appendChild(el('span', '', w.alive ? '在世' : '已终'));
      meta.appendChild(el('span', '', w.updatedAt ? new Date(w.updatedAt).toLocaleString() : ''));
      card.appendChild(meta);

      var footer = el('div', 'card-footer');
      footer.appendChild(el('span', 'go', '进入世界 ›'));
      var exp = el('button', 'btn tiny', '导出');
      exp.addEventListener('click', function (e) {
        e.stopPropagation();
        exportWorld(w.id);
      });
      footer.appendChild(exp);
      var del = el('button', 'btn danger tiny', '删除');
      var armed = false;
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          del.textContent = '确认删除？';
          setTimeout(function () { armed = false; del.textContent = '删除'; }, 4000);
          return;
        }
        api('/api/worlds/' + encodeURIComponent(w.id), { method: 'DELETE' })
          .then(function () { showHome(); })
          .catch(function (err) { toast(err.message); });
      });
      footer.appendChild(del);
      card.appendChild(footer);

      card.addEventListener('click', function () { location.hash = '#/w/' + w.id; });
      box.appendChild(card);
    });
  }

  // ---- 新世界 ----
  function showNew() {
    $('view-new').hidden = false;
    if (!$('presets').childElementCount) renderPresets();
    if (!$('genre-row').childElementCount) renderGenres();
    if (!$('alloc').childElementCount) initAlloc();
    updatePoints();
  }

  function renderPresets() {
    var box = $('presets');
    PRESETS.forEach(function (p) {
      var b = el('button', 'preset', p);
      b.addEventListener('click', function () { $('seed').value = p; $('seed').focus(); });
      box.appendChild(b);
    });
  }

  // 文风单选胶囊：默认 'auto'（交给模型判断），点击重绘以更新选中态。
  var selectedGenre = 'auto';

  function renderGenres() {
    var box = $('genre-row');
    box.textContent = '';
    GENRE_OPTIONS.forEach(function (g) {
      var b = el('button', 'genre-pill' + (g.value === selectedGenre ? ' selected' : ''), g.label);
      b.type = 'button';
      b.setAttribute('data-genre', g.value);
      b.addEventListener('click', function () {
        selectedGenre = g.value;
        renderGenres();
      });
      box.appendChild(b);
    });
  }

  function remaining() {
    return 6 - ATTRS.reduce(function (s, a) { return s + (alloc[a] || 0); }, 0);
  }

  function initAlloc() {
    var box = $('alloc');
    box.textContent = '';
    ATTRS.forEach(function (a) {
      alloc[a] = 1; // 默认平均分配，剩余 0 点
      var row = el('div', 'alloc-row');
      row.appendChild(el('span', 'alloc-name', a));
      var minus = el('button', 'btn tiny', '−');
      var val = el('span', 'alloc-val', '1');
      var plus = el('button', 'btn tiny', '+');
      minus.addEventListener('click', function () { changeAlloc(a, -1, val); });
      plus.addEventListener('click', function () { changeAlloc(a, 1, val); });
      row.appendChild(minus);
      row.appendChild(val);
      row.appendChild(plus);
      box.appendChild(row);
    });
  }

  function changeAlloc(a, d, valEl) {
    var next = (alloc[a] || 0) + d;
    if (next < 0 || next > 3) return;
    if (d > 0 && remaining() <= 0) return;
    alloc[a] = next;
    valEl.textContent = String(next);
    updatePoints();
  }

  function randomAlloc() {
    ATTRS.forEach(function (a) { alloc[a] = 0; });
    var left = 6;
    while (left > 0) {
      var candidates = ATTRS.filter(function (a) { return alloc[a] < 3; });
      var a = candidates[Math.floor(Math.random() * candidates.length)];
      alloc[a] += 1;
      left -= 1;
    }
    var rows = $('alloc').children;
    ATTRS.forEach(function (a, i) { rows[i].querySelector('.alloc-val').textContent = String(alloc[a]); });
    updatePoints();
  }

  function updatePoints() {
    var r = remaining();
    $('points-left').textContent = '剩余 ' + r + ' 点';
    $('points-left').style.color = r === 0 ? 'var(--muted)' : 'var(--accent-2)';
    $('btn-create').disabled = r !== 0;
  }

  function setCreating(b) {
    $('creating').hidden = !b;
    $('btn-create').disabled = b;
  }

  async function createWorld() {
    var seed = $('seed').value.trim();
    if (!seed) { toast('请先写一句世界观'); return; }
    if (remaining() !== 0) { toast('请分配完 6 点属性'); return; }
    var name = $('char-name').value.trim() || '无名旅人';
    var appearance = $('char-appearance').value.trim() || '一袭布衣';
    setCreating(true);
    try {
      var w = await api('/api/worlds', {
        method: 'POST',
        body: JSON.stringify({ seed: seed, name: name, appearance: appearance, alloc: alloc, genre: selectedGenre }),
      });
      location.hash = '#/w/' + w.id;
    } catch (err) {
      toast(err.message);
    } finally {
      setCreating(false);
    }
  }

