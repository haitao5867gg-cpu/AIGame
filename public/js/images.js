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

  // ---- 认识的人列表：资料 / 查询签名 ----
  // 资料或查询没变（图片轮询）时只刷必要头像节点；真正变化 / 搜索才整表重画，
  // 这样打开的音色下拉、名字按钮焦点不会被轮询销毁。
  var npcListRenderSig = null;

  function npcAvatarState(info) {
    return ((info && info.status) || 'none') + '|' + ((info && info.url) || '');
  }
  // 行签名只取会影响「显示哪些行 / 每行显示什么 / 头像身份 / 音色键」的公开字段 + 查询；
  // 不含 imageState：图片就绪属轮询，应只换头像而不重画整行。
  function npcRowSig(e) {
    var p = e.p || {};
    return [
      e.id == null ? '' : String(e.id),
      npcDisplayName(p), npcClue(p), npcText(p.attitude), npcLastTurn(p),
      npcPortraitKey(p), npcVoiceKey(p),
      (typeof npcSearchText === 'function' ? npcSearchText(p) : ''),
    ].join('\u0001');
  }
  function npcListSig(entries, q) {
    var parts = [String(q)];
    for (var i = 0; i < entries.length; i++) parts.push(npcRowSig(entries[i]));
    return parts.join('\u0002');
  }
  // 资料 / 查询未变：按状态只替换有变化的头像节点，保持当前行 / 下拉 / 焦点。
  function refreshNpcListAvatars(rowsWrap, entries, q) {
    var filtered = entries.filter(function (e) { return npcMatches(e.p, q); });
    filtered = (typeof npcSortEntries === 'function') ? npcSortEntries(filtered) : filtered;
    var rows = rowsWrap.querySelectorAll('.npc-row');
    if (rows.length !== filtered.length) {   // 防御：DOM 与资料不符则交给整表重画
      npcListRenderSig = null;
      renderNpcList();
      return;
    }
    for (var i = 0; i < rows.length; i++) {
      var info = imageState.npcs[npcPortraitKey(filtered[i].p)];
      var st = npcAvatarState(info);
      var old = rows[i].querySelector('.npc-avatar');
      if (!old || old.getAttribute('data-portrait-state') === st) continue;
      var avatar = makeImageVisual(npcDisplayName(filtered[i].p), info, 'npc-avatar');
      avatar.setAttribute('data-portrait-state', st);
      rows[i].insertBefore(avatar, old);
      rows[i].removeChild(old);
    }
  }

  function renderItemGrid() {
    var box = $('item-grid');
    if (!box) return;
    box.textContent = '';
    var items = (currentState && currentState.character && currentState.character.items) || [];
    if (!items.length) box.appendChild(el('span', 'muted', '（无）'));
    items.forEach(function (name) {
      var card = el('div', 'item-card');
      // 物品卡片点击打开介绍卡；缩略图不再单独看大图（大图在卡片里点仍可看原图）。
      card.appendChild(makeImageVisual(name, imageState.items[name], 'item-thumb', true));
      card.appendChild(el('div', 'item-card-name', name));
      card.addEventListener('click', function () { showItemCard(name); });
      box.appendChild(card);
    });
    // 背包空格子：物品不足 6 个时补到 6 格，让背包看起来像格子。
    for (var i = items.length; i < 6; i++) {
      var slot = el('div', 'item-slot-empty');
      slot.setAttribute('aria-hidden', 'true');
      box.appendChild(slot);
    }
  }

  function renderNpcList() {
    var box = $('npc-list');
    if (!box) return;
    // 真正换世界才清旧查询；同一世界轮询 / 重画保留（npcSyncSearchWorld 在 npcs.js）。
    var worldChanged = (typeof npcSyncSearchWorld === 'function') ? npcSyncSearchWorld() : false;
    if (worldChanged) npcListRenderSig = null;
    // 骨架：搜索框 + 行容器。搜索框常驻，输入由 npcs.js 的 document 级委托处理。
    var search = document.getElementById('npc-search');
    var rowsWrap = document.getElementById('npc-rows');
    if (!search || search.parentNode !== box || !rowsWrap || rowsWrap.parentNode !== box) {
      box.textContent = '';
      search = el('input', 'npc-search');
      search.id = 'npc-search';
      search.type = 'search';
      search.setAttribute('placeholder', '搜索姓名 / 身份 / 别名 / 已知线索');
      search.setAttribute('aria-label', '搜索认识的人');
      search.value = (typeof npcSearchQuery !== 'undefined') ? npcSearchQuery : '';
      box.appendChild(search);
      rowsWrap = el('div', 'npc-rows');
      rowsWrap.id = 'npc-rows';
      box.appendChild(rowsWrap);
      npcListRenderSig = null;
    } else if (worldChanged) {
      search.value = '';   // 换世界：同步清掉可见的旧过滤词
    }
    var entries = (typeof npcListEntries === 'function') ? npcListEntries() : [];
    var q = (typeof npcSearchQuery !== 'undefined') ? npcSearchQuery : '';
    var sig = npcListSig(entries, q);
    // 过滤到 0 条时搜索框仍在，可随时清空查询；只有整个名单为空才隐藏。
    search.hidden = entries.length === 0;
    // 资料 / 查询未变（图片轮询）：只刷必要头像，保持行 / 下拉 / 焦点。
    if (sig === npcListRenderSig && rowsWrap.childNodes.length) {
      refreshNpcListAvatars(rowsWrap, entries, q);
      return;
    }
    npcListRenderSig = sig;
    rowsWrap.textContent = ''; // 只清行，不动上面的搜索框

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

    if (!entries.length) { rowsWrap.appendChild(el('span', 'muted', '（尚无）')); return; }
    var filtered = entries.filter(function (e) { return npcMatches(e.p, q); });
    // 最近有记录的人优先、稳定排序，避免图片轮询重画时行位置跳动。
    filtered = (typeof npcSortEntries === 'function') ? npcSortEntries(filtered) : filtered;
    if (!filtered.length) { rowsWrap.appendChild(el('span', 'muted', '没有匹配的人')); return; }

    filtered.forEach(function (e) {
      var p = e.p;
      var display = npcDisplayName(p);
      var nameKey = npcVoiceKey(p);          // 音色设置沿用 name 键（兼容旧档）
      var portraitKey = npcPortraitKey(p);   // 头像身份按 portraitName 稳定映射
      var v = Math.max(-10, Math.min(10, Number(p.attitude) || 0));
      var filled = Math.round(((v + 10) / 20) * 5);
      var hearts = '♥'.repeat(filled) + '♡'.repeat(5 - filled);
      var clue = npcClue(p);
      var lastTurn = npcLastTurn(p);

      var row = el('div', 'npc-row');
      // 头像：仍按 portraitName 取图、点击看大图；点击不打开档案。
      var avatarInfo = imageState.npcs[portraitKey];
      var avatar = makeImageVisual(display, avatarInfo, 'npc-avatar');
      avatar.setAttribute('data-portrait-state', npcAvatarState(avatarInfo));
      row.appendChild(avatar);

      // 名字 / 简介区域：一个 ≥40px 的按钮打开人物档案（不与头像、🔊 点击事件叠加）。
      var openBtn = el('button', 'npc-open');
      openBtn.type = 'button';
      openBtn.setAttribute('aria-label', '查看 ' + display + ' 的档案');
      openBtn.setAttribute('data-npc-id', e.id == null ? '' : String(e.id)); // 关闭后按当前同 NPC 恢复焦点
      var line1 = el('span', 'npc-line1');
      line1.appendChild(el('span', 'npc-name', display));
      line1.appendChild(el('span', 'npc-attitude', hearts));
      openBtn.appendChild(line1);
      var line2 = el('span', 'npc-line2');
      line2.appendChild(el('span', 'npc-clue', clue || '（尚无认人线索）'));
      if (lastTurn >= 0) line2.appendChild(el('span', 'npc-turn', '第' + lastTurn + '回合'));
      openBtn.appendChild(line2);
      openBtn.addEventListener('click', function () {
        if (typeof openNpcCard === 'function') openNpcCard(e.id, p);
      });
      row.appendChild(openBtn);

      // 追加：小喇叭按钮（小号、flex:none 不挤压名字）。
      var voiceBtn = el('button', 'npc-voice-btn', '🔊');
      voiceBtn.type = 'button';
      voiceBtn.setAttribute('aria-label', '设置 ' + nameKey + ' 的音色');
      row.appendChild(voiceBtn);
      rowsWrap.appendChild(row);
      // 追加：行下方的下拉容器，默认收起；再次点喇叭收起。
      var voiceRow = el('div', 'npc-voice-row');
      voiceRow.hidden = true;
      rowsWrap.appendChild(voiceRow);
      voiceBtn.addEventListener('click', function () {
        if (!voiceRow.hidden) { voiceRow.hidden = true; return; }
        voiceRow.hidden = false;
        if (!window.Tts) return;
        window.Tts.withVoices(function (voices) { buildVoiceSelect(voiceRow, nameKey, voices); });
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
    if (typeof renderCharAvatar === 'function') renderCharAvatar();
    renderNpcList();
    renderScenes();
    // 图片就绪（含轮询）只刷新已打开档案卡的头像，不重建卡片 / 列表 / 历史。
    if (typeof refreshNpcCardPortrait === 'function') refreshNpcCardPortrait();
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

  function latestSceneArt(scenes, life) {
    var lifeFilter = typeof life === 'number' && isFinite(life);
    var best = null, bestLife = -Infinity, bestTurn = -Infinity;
    var obj = scenes || {}, keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var item = obj[keys[i]];
      if (!item || item.status !== 'ready' || typeof item.url !== 'string') continue;
      if (lifeFilter && item.life !== life) continue;
      var l = Number(item.life); if (!isFinite(l)) l = 0;
      var t = Number(item.turn); if (!isFinite(t)) t = 0;
      if (l > bestLife || (l === bestLife && t > bestTurn)) {
        best = item.url; bestLife = l; bestTurn = t;
      }
    }
    return best;
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
      if (typeof Atmosphere !== 'undefined' && Atmosphere.setSceneArt) Atmosphere.setSceneArt(latestSceneArt(imageState.scenes, currentState && currentState.life));
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
      if (typeof Atmosphere !== 'undefined' && Atmosphere.setSceneArt) Atmosphere.setSceneArt(null);
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

