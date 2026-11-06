'use strict';
  // ---- 图片：随身物品卡片 / NPC 头像 / 请求与轮询 ----
  function firstChar(name) {
    var s = String(name == null ? '' : name);
    return s.length ? s.charAt(0) : '?';
  }

  // 依据 {status,url} 生成图位元素：ready→<img>、pending→柔和闪烁占位、
  // failed / none→首字圆角色块。shapeClass 决定是 64px 方图还是 40px 圆头像。
  function makeImageVisual(name, info, shapeClass, noViewer) {
    var st = info && info.status;
    if (st === 'ready' && info.url) {
      var img = el('img', shapeClass);
      img.src = info.url;
      img.alt = name;
      if (!noViewer) img.addEventListener('click', function () { openImageViewer(info.url); });
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
      // 物品卡片点击打开介绍卡；缩略图不再单独看大图（大图在卡片里点仍可看原图）。
      card.appendChild(makeImageVisual(name, imageState.items[name], 'item-thumb', true));
      card.appendChild(el('div', 'item-card-name', name));
      card.addEventListener('click', function () { showItemCard(name); });
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

    // 追加：行下方音色下拉的构建（只追加，不改动 NPC 行现有结构与类名）。
    function buildVoiceSelect(voiceRow, name, voices) {
      voiceRow.textContent = '';
      var sel = el('select', 'npc-voice-select');
      var auto = el('option', null, '自动（按名字分配）');
      auto.value = '';
      sel.appendChild(auto);
      (voices || []).forEach(function (v) {
        var o = el('option', null, window.Tts.voiceLabel(v));
        o.value = v.id;
        sel.appendChild(o);
      });
      var cur = (typeof myPrefs !== 'undefined' && myPrefs.tts && myPrefs.tts.npcVoices) || {};
      sel.value = cur[name] || '';
      sel.addEventListener('change', function () {
        var val = sel.value;
        var tts = myPrefs.tts || (myPrefs.tts = {});
        if (!tts.npcVoices) tts.npcVoices = {};
        var map = tts.npcVoices;
        var old = map[name];
        if (val) map[name] = val; else delete map[name];
        api('/api/prefs', { method: 'POST', body: JSON.stringify({ tts: tts }) })
          .catch(function (err) {
            if (old === undefined) delete map[name]; else map[name] = old;
            sel.value = old || '';
            if (typeof toast === 'function') toast((err && err.message) || '朗读设置保存失败');
          });
        var voiceId = val || window.Tts.npcVoiceFor(name);
        window.Tts.previewVoice('（' + name + '）：这是我的声音。', voiceId);
      });
      voiceRow.appendChild(sel);
    }

    names.forEach(function (name) {
      var v = Math.max(-10, Math.min(10, Number(npc[name]) || 0));
      var filled = Math.round(((v + 10) / 20) * 5);
      var row = el('div', 'npc-row');
      row.appendChild(makeImageVisual(name, imageState.npcs[name], 'npc-avatar'));
      row.appendChild(el('span', 'npc-name', name));
      row.appendChild(el('span', 'npc-attitude', '♥'.repeat(filled) + '♡'.repeat(5 - filled)));
      // 追加：小喇叭按钮（小号、flex:none 不挤压名字）。
      var voiceBtn = el('button', 'npc-voice-btn', '🔊');
      voiceBtn.type = 'button';
      voiceBtn.setAttribute('aria-label', '设置 ' + name + ' 的音色');
      row.appendChild(voiceBtn);
      box.appendChild(row);
      // 追加：行下方的下拉容器，默认收起；再次点喇叭收起。
      var voiceRow = el('div', 'npc-voice-row');
      voiceRow.hidden = true;
      box.appendChild(voiceRow);
      voiceBtn.addEventListener('click', function () {
        if (!voiceRow.hidden) { voiceRow.hidden = true; return; }
        voiceRow.hidden = false;
        if (!window.Tts) return;
        window.Tts.withVoices(function (voices) { buildVoiceSelect(voiceRow, name, voices); });
      });
    });
  }

  // 主角形象图：与 NPC 头像同款 40px 圆形，放在「认识的人」上方。
  // 状态规则沿用 makeImageVisual：ready 显示图（点击看大图）、pending 闪烁、否则首字色块。
  function renderHero() {
    var box = $('hero-row');
    if (!box) return;
    box.textContent = '';
    box.appendChild(makeImageVisual('你', imageState.hero, 'npc-avatar'));
    box.appendChild(el('span', 'npc-name', '你'));
  }

  // 场景插图：遍历 .scene-frame，按 data-scene 查 imageState.scenes 填图 / 占位 / 隐藏。
  function renderScenes() {
    var scenes = imageState.scenes || {};
    var frames = document.querySelectorAll('.scene-frame');
    Array.prototype.forEach.call(frames, function (frame) {
      var key = frame.getAttribute('data-scene');
      var info = scenes[key];
      frame.hidden = false;
      if (!info || info.status === 'pending') return; // 后端刚排队 / 还在生成：保持占位
      if (info.status !== 'ready' || !info.url) {     // failed / none：整框隐藏不占位
        frame.hidden = true;
        return;
      }
      var existing = frame.querySelector('img.scene-img');
      if (existing && existing.getAttribute('data-scene-url') === info.url) return; // 同一 url 不重建
      frame.classList.remove('img-pending');
      frame.textContent = '';
      var img = el('img', 'scene-img');
      img.alt = '';
      img.setAttribute('data-scene-url', info.url);
      img.addEventListener('load', function () { img.classList.add('loaded'); });
      img.addEventListener('click', function () { openImageViewer(info.url); });
      img.src = info.url;
      frame.appendChild(img);
    });
  }

  function renderImages() {
    renderItemGrid();
    renderHero();
    renderNpcList();
    renderScenes();
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
    var it = st.items || {}, np = st.npcs || {}, sc = st.scenes || {};
    Object.keys(it).forEach(function (k) { vals.push(it[k]); });
    Object.keys(np).forEach(function (k) { vals.push(np[k]); });
    Object.keys(sc).forEach(function (k) { vals.push(sc[k]); });
    if (st.hero) vals.push(st.hero);
    if (vals.some(function (v) { return v && v.status === 'pending'; })) return true;
    // 页面上有 .scene-frame 但 scenes 里还没有对应项（刚出完回合，后端刚排队）也算 pending。
    var frames = document.querySelectorAll('.scene-frame');
    for (var i = 0; i < frames.length; i++) {
      var key = frames[i].getAttribute('data-scene');
      if (key && !Object.prototype.hasOwnProperty.call(sc, key)) return true;
    }
    return false;
  }

  // 请求一次 /images；若仍有 pending，则每 4 秒轮询，最多 150 秒（150000ms）。
  // 旧上限 90000ms（90 秒）不够：场景图可能排在物品图后面才排队生成。
  // 离开世界或全部就绪即停止。图片请求失败不影响游戏，静默忽略。
  async function fetchImages(id) {
    try {
      var data = await api('/api/worlds/' + encodeURIComponent(id) + '/images');
      if (id !== currentWorldId) return; // 已离开该世界：丢弃过期响应
      imageState = {
        items: data.items || {}, npcs: data.npcs || {}, scenes: data.scenes || {},
        hero: data.hero || {},
      };
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
      imageState = { items: {}, npcs: {}, scenes: {}, hero: {} };
      imageWorldId = id;
      renderImages();
    }
    imagePollStart = Date.now();
    fetchImages(id);
    imagePollTimer = setInterval(function () {
      if (id !== currentWorldId || Date.now() - imagePollStart >= 150000) {
        stopImagePoll(); // 离开世界 / 超过 150 秒
        return;
      }
      fetchImages(id);
    }, 4000);
  }

