'use strict';
  // ---- 图片：随身物品卡片 / NPC 头像 / 请求与轮询 ----
  function firstChar(name) {
    var s = String(name == null ? '' : name);
    return s.length ? s.charAt(0) : '?';
  }

  // 依据 {status,url} 生成图位元素：ready→<img>、pending→柔和闪烁占位、
  // failed / none→首字圆角色块。shapeClass 决定是 64px 方图还是 40px 圆头像。
  function makeImageVisual(name, info, shapeClass) {
    var st = info && info.status;
    if (st === 'ready' && info.url) {
      var img = el('img', shapeClass);
      img.src = info.url;
      img.alt = name;
      img.addEventListener('click', function () { openImageViewer(info.url); });
      return img;
    }
    if (st === 'pending') return el('div', shapeClass + ' img-pending');
    var fb = el('div', shapeClass + ' img-fallback');
    fb.textContent = firstChar(name);
    return fb;
  }

  function renderItemGrid() {
    var box = $('item-grid');
    if (!box) return;
    box.textContent = '';
    var items = (currentState && currentState.character && currentState.character.items) || [];
    if (!items.length) { box.appendChild(el('span', 'muted', '（无）')); return; }
    items.forEach(function (name) {
      var card = el('div', 'item-card');
      card.appendChild(makeImageVisual(name, imageState.items[name], 'item-thumb'));
      card.appendChild(el('div', 'item-card-name', name));
      box.appendChild(card);
    });
  }

  function renderNpcList() {
    var box = $('npc-list');
    if (!box) return;
    box.textContent = '';
    var npc = (currentState && currentState.npcAttitude) || {};
    var names = Object.keys(npc);
    if (!names.length) { box.appendChild(el('span', 'muted', '（尚无）')); return; }
    names.forEach(function (name) {
      var v = Math.max(-10, Math.min(10, Number(npc[name]) || 0));
      var filled = Math.round(((v + 10) / 20) * 5);
      var row = el('div', 'npc-row');
      row.appendChild(makeImageVisual(name, imageState.npcs[name], 'npc-avatar'));
      row.appendChild(el('span', 'npc-name', name));
      row.appendChild(el('span', 'npc-attitude', '♥'.repeat(filled) + '♡'.repeat(5 - filled)));
      box.appendChild(row);
    });
  }

  function renderImages() {
    renderItemGrid();
    renderNpcList();
  }

  function openImageViewer(url) {
    var v = $('image-viewer');
    v.textContent = '';
    var img = el('img');
    img.src = url;
    img.alt = '';
    v.appendChild(img);
    v.hidden = false;
  }

  function closeImageViewer() {
    $('image-viewer').hidden = true;
  }

  function stopImagePoll() {
    if (imagePollTimer) { clearInterval(imagePollTimer); imagePollTimer = null; }
  }

  function hasPendingImage(st) {
    var vals = [];
    var it = st.items || {}, np = st.npcs || {};
    Object.keys(it).forEach(function (k) { vals.push(it[k]); });
    Object.keys(np).forEach(function (k) { vals.push(np[k]); });
    return vals.some(function (v) { return v && v.status === 'pending'; });
  }

  // 请求一次 /images；若仍有 pending，则每 4 秒轮询，最多 90 秒。
  // 离开世界或全部就绪即停止。图片请求失败不影响游戏，静默忽略。
  async function fetchImages(id) {
    try {
      var data = await api('/api/worlds/' + encodeURIComponent(id) + '/images');
      if (id !== currentWorldId) return; // 已离开该世界：丢弃过期响应
      imageState = { items: data.items || {}, npcs: data.npcs || {} };
      renderImages();
      if (!hasPendingImage(imageState)) stopImagePoll();
    } catch (err) {
      // 忽略：图片是附加信息，绝不影响回合
    }
  }

  // 进入世界 / 每回合 result 后调用：立即请求一次，并开启（或重置）本轮轮询。
  function requestImages() {
    stopImagePoll();
    if (!currentWorldId) return;
    var id = currentWorldId;
    if (imageWorldId !== id) { // 换了世界：清空旧图，避免串图
      imageState = { items: {}, npcs: {} };
      imageWorldId = id;
      renderImages();
    }
    imagePollStart = Date.now();
    fetchImages(id);
    imagePollTimer = setInterval(function () {
      if (id !== currentWorldId || Date.now() - imagePollStart >= 90000) {
        stopImagePoll(); // 离开世界 / 超过 90 秒
        return;
      }
      fetchImages(id);
    }, 4000);
  }

