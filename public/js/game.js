'use strict';
  // 当前正在渲染回合的朗读提示（voice_hints），供整回合朗读按段落取音色 / 情绪 / 节奏。
  var currentVoiceHints = [];
  // ---- 角色卡 / 玩家画像（共享全局作用域）----
  var PANEL_TABS = [
    { key: 'char', label: '角色' },
    { key: 'people', label: '人物' },
    { key: 'clues', label: '线索' },
    { key: 'profile', label: '画像' },
  ];
  var panelTabButtons = [];   // 当前 renderPanel 生成的四个标签按钮
  var panelPanes = {};        // key -> .panel-pane 节点
  var profileData = null;     // /api/profile 返回的 profile
  var profileResetArmed = false;   // 重置画像二次确认态
  var profileResetTimer = null;
  var profileResetBtn = null;
  // 导出世界：GET 附件接口，用临时 <a download> 触发下载，不跳转页面。
  function exportWorld(id) {
    var a = document.createElement('a');
    a.href = '/api/worlds/' + encodeURIComponent(id) + '/export';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---- 撤回上一步 ----
  function resetUndoText() {
    undoArmed = false;
    $('btn-undo').textContent = '↶ 撤回这一步';
  }

  // 按后端 undoAvailable 显隐按钮；隐藏时顺带复位二次确认态。
  function setUndoVisible(v) {
    $('btn-undo').hidden = !v;
    if (!v) {
      clearTimeout(undoArmTimer);
      resetUndoText();
    }
  }

  function onUndoClick() {
    if (undoBusy) return;
    var r = undoClickAction(undoArmed);
    undoArmed = r.nextArmed;
    if (!r.fire) {
      // 第一次点击：进入二次确认态，4 秒后自动复原。
      $('btn-undo').textContent = '确认撤回这一步？';
      clearTimeout(undoArmTimer);
      undoArmTimer = setTimeout(resetUndoText, 4000);
      return;
    }
    clearTimeout(undoArmTimer);
    $('btn-undo').textContent = '↶ 撤回这一步';
    doUndo();
  }

  async function doUndo() {
    if (undoBusy || busy || !currentWorldId) return;
    undoBusy = true;
    try {
      var res = await api('/api/worlds/' + encodeURIComponent(currentWorldId) + '/undo', {
        method: 'POST',
      });
      // 成功后重新加载该世界的叙事与状态（/log 会跳过被撤回的那一回合）。
      await showGame(currentWorldId);
      scrollBottom(); // 撤回后的定位保持现状：仍滚到页面底部
      // 把被撤回的行动文字放回输入框。
      $('action-input').value = res.undoneAction || '';
      $('action-input').focus();
      toast('已撤回上一步');
    } catch (err) {
      toast(err.message);
    } finally {
      undoBusy = false;
    }
  }

  // ---- 游戏页 ----
  // 叙事 v3：已显示的章号，用于去重插章名分隔；clearStream 时复位为 0。
  var lastChapterShown = 0;
  function clearStream() {
    $('stream').textContent = '';
    lastChapterShown = 0;
  }

  function scrollBottom() {
    if (typeof Tts !== 'undefined' && Tts.noteProgrammaticScroll) Tts.noteProgrammaticScroll();
    if (window.innerWidth <= 600) {
      // 手机：叙事区不再内嵌滚动、整页自然滚动 → 滚到文档底部（输入区固定在底部仍可见）
      window.scrollTo(0, document.documentElement.scrollHeight);
    } else {
      var s = $('stream');
      s.scrollTop = s.scrollHeight;
    }
  }

  // 当前回合的起点元素（行动行 / 插图框 / 首段叙事），用于把阅读位置停在本回合开头。
  var turnStartEl = null;
  var turnAlignObs = null;

  // 把 el 滚到可视区顶部、sticky 顶栏正下方：
  // 手机整页滚动，靠 app.css 的 scroll-margin-top 抵掉顶栏高度并留 8px；
  // 电脑在 #stream 内滚动，让 el 顶部对齐 #stream 可视区顶部。
  function scrollToTurnStart(node) {
    if (!node) return;
    if (typeof Tts !== 'undefined' && Tts.noteProgrammaticScroll) Tts.noteProgrammaticScroll();
    if (window.innerWidth <= 600) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      var s = $('stream');
      s.scrollTo({
        top: node.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop,
        behavior: 'smooth',
      });
    }
  }

  // 本回合起点：优先行动行；无行动行（如重生开场）时用插图框或首段叙事兜底。
  function turnStartOr(fallbackWrap) {
    if (turnStartEl && turnStartEl.isConnected) return turnStartEl;
    if (!fallbackWrap) return null;
    return fallbackWrap.querySelector('.scene-frame') ||
           fallbackWrap.querySelector('p.narration') || fallbackWrap;
  }

  // 进入世界时定位到最新一回合开头：最后一条行动行，没有则最后一段叙事的开头。
  function lastTurnStart() {
    var s = $('stream');
    var lines = s.querySelectorAll('.action-line');
    if (lines.length) return lines[lines.length - 1];
    var blocks = s.querySelectorAll('.narration-block, .opening');
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  // 回合结束后 2 秒内，若上方有异步插入（插图/物品卡/徽章）把起点推离，重新对齐一次；
  // 窗口过后（或已重对齐过）不再干预玩家滚动。
  function armTurnAlign(start) {
    if (turnAlignObs) turnAlignObs.disconnect();
    turnAlignObs = null;
    if (typeof MutationObserver === 'undefined' || !start) return;
    var until = Date.now() + 2000;
    var base = start.offsetTop;   // 布局坐标，不受滚动影响
    var done = false;
    var obs = new MutationObserver(function () {
      var stop = done || Date.now() > until || !start.isConnected;
      if (!stop && Math.abs(start.offsetTop - base) > 4) {
        done = true;                // 只重新对齐一次
        scrollToTurnStart(start);
      }
      if (stop || done) {
        obs.disconnect();
        if (turnAlignObs === obs) turnAlignObs = null;
      }
    });
    turnAlignObs = obs;
    obs.observe($('stream'), { childList: true, subtree: true });
    setTimeout(function () {
      obs.disconnect();
      if (turnAlignObs === obs) turnAlignObs = null;
    }, 2100);
  }

  async function showGame(id) {
    currentWorldId = id;
    $('view-game').hidden = false;
    clearStream();
    try {
      var results = await Promise.all([
        api('/api/worlds/' + encodeURIComponent(id)),
        api('/api/worlds/' + encodeURIComponent(id) + '/log?limit=50'),
      ]);
      var state = results[0];
      var log = results[1];
      currentState = state;
      var atmosphereLastLog = Array.isArray(log) && log.length ? log[log.length - 1] : null;
      renderHeader(state, atmosphereLastLog ? { scene: atmosphereLastLog.scene, narration: atmosphereLastLog.narration } : null);
      var sit = state.bible && state.bible.start && state.bible.start.situation;
      if (sit) appendOpening(sit);
      (log || []).forEach(appendLogRecord);
      renderPanel(state);
      // 老世界 state.stats 为空：后台补设计，回来后写回并重画（先显示占位文案）。
      if (!Array.isArray(state.stats) || state.stats.length === 0) {
        api('/api/worlds/' + encodeURIComponent(id) + '/stats')
          .then(function (data) {
            if (id !== currentWorldId || !currentState) return; // 已切走别世界，丢弃过期响应
            if (data && Array.isArray(data.stats)) {
              currentState.stats = data.stats;
              renderPanel(currentState);
              renderTopAttrs(currentState);
            }
          })
          .catch(function () {});
      }
      fetchProfile(); // 跨世界玩家画像（失败静默）
      renderEventBanner(state.activeEvent);
      resetIdeas(atmosphereLastLog && atmosphereLastLog.suggestions);
      setUndoVisible(!!state.undoAvailable);
      if (state.awaitingRebirth || !state.character.alive) showDeath(state, null);
      else hideDeath();
      scrollToTurnStart(lastTurnStart());
      requestImages();

      // 序章：首次进入（turn 0、未看过、四段齐全）弹出；缺失则后台补生成，
      // 供面板入口使用。老世界（turn > 0）不自动弹出，卡片也不阻塞上面的回放。
      var pr = state.bible && state.bible.prologue;
      var wtitle = (state.bible && state.bible.title) || '无限世界';
      var seen = false;
      try { seen = !!localStorage.getItem('prologueSeen:' + id); } catch (_) {}
      if (state.turn === 0 && !seen && pr && pr.world && pr.me && pr.goal && pr.now) {
        showPrologue(wtitle, pr, function () {
          try { localStorage.setItem('prologueSeen:' + id, '1'); } catch (_) {}
        });
      }
      if (!pr) {
        api('/api/worlds/' + encodeURIComponent(id) + '/prologue')
          .then(function (data) {
            if (data && data.prologue && currentState) {
              currentState.bible = currentState.bible || {};
              currentState.bible.prologue = data.prologue;
            }
          })
          .catch(function () {});
      }
    } catch (err) {
      toast(err.message);
    }
  }

  function renderHeader(s) {
    var atmosphereOptions = arguments[1];
    $('g-title').textContent = (s.bible && s.bible.title) || '无限世界';
    $('g-life').textContent = '第 ' + s.life + ' 世';
    $('g-turn').textContent = '第 ' + s.turn + ' 回合';
    $('g-subtitle').textContent = '第 ' + s.life + ' 世 · 第 ' + s.turn + ' 回合';
    var loc = s.location || (s.bible && s.bible.start && s.bible.start.place) || '—';
    var c = s.clock || {};
    $('g-place').textContent = loc + ' · ' + formatGameDay(c.day) + ' ' + (c.period || '清晨');
    $('g-omen').hidden = !s.omen;
    $('g-danger').hidden = !s.danger; // 体魄 ≤ 2：顶部提示「伤势沉重」
    // 叙事 v3：顶栏章名 + 写作模式入口（仅 v3 世界显示）。
    var gc = $('g-chapter');
    if (gc) {
      gc.hidden = !s.chapter;
      if (s.chapter) gc.textContent = '第 ' + s.chapter.index + ' 章' + (s.chapterTitle ? ' · ' + s.chapterTitle : '');
    }
    var isV3 = !!s.chapter;
    if ($('menu-writing')) $('menu-writing').hidden = !isV3;
    if ($('g-writing')) $('g-writing').hidden = !isV3;
    renderWritingLabels(); // 按 myPrefs.writing 刷新两处文字
    renderGenreLabels(); // 每次拉取状态（含每回合 result 后）都刷新文风标签
    if (typeof Atmosphere !== 'undefined') Atmosphere.enterWorld(s, atmosphereOptions);
  }

  // ---- 文风切换：⋯ 菜单项与桌面地点行标签共用一个选择列表 ----
  // 菜单文字 / 桌面标签统一由 currentState.genre 渲染；缺 genre 时显示「识别中」。
  function renderGenreLabels() {
    var name = (currentState && genreName(currentState.genre)) || '识别中';
    $('menu-genre-name').textContent = name;
    $('g-genre').textContent = '文风·' + name;
  }

  function openGenrePop() {
    var pop = $('genre-pop');
    if (!pop.hidden) { pop.hidden = true; return; }
    pop.textContent = '';
    pop.appendChild(el('div', 'genre-pop-title', '选择文风'));
    var cur = currentState && currentState.genre;
    GENRE_OPTIONS.slice(1).forEach(function (g) {
      var on = g.value === cur; // 当前项打勾
      var b = el('button', 'genre-option' + (on ? ' selected' : ''), (on ? '✓ ' : '') + g.label);
      b.type = 'button';
      b.addEventListener('click', function () { setGenre(g.value); });
      pop.appendChild(b);
    });
    pop.hidden = false;
  }

  async function setGenre(value) {
    if (!currentWorldId) return;
    try {
      var r = await api('/api/worlds/' + encodeURIComponent(currentWorldId) + '/genre', {
        method: 'POST', body: JSON.stringify({ genre: value }),
      });
      currentState = currentState || {};
      currentState.genre = r.genre;
      renderGenreLabels();
      $('genre-pop').hidden = true;
      toast('文风已切换为' + (genreName(r.genre) || r.genre) + '，下一回合生效');
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- 叙事 v3：写作模式（⋯ 菜单 + 桌面标签共用，仅 v3 世界显示）----
  var WRITING_MODES = ['fine', 'deep', 'fast'];
  var WRITING_NAMES = { fine: '精写', deep: '深度精写', fast: '快写' };
  var WRITING_TOASTS = {
    fine: '精写：强模型简单构思再写，第一句约 10~30 秒',
    deep: '深度精写：强模型深思后再写，第一句可能要一分钟',
    fast: '快写：不构思直接写，第一句几秒就出',
  };

  function writingName(w) { return WRITING_NAMES[w] || WRITING_NAMES.fine; }

  function renderWritingLabels() {
    var name = writingName(myPrefs.writing);
    if ($('menu-writing-name')) $('menu-writing-name').textContent = name;
    if ($('g-writing')) $('g-writing').textContent = '写作·' + name;
  }

  function nextWritingMode(cur) {
    var i = WRITING_MODES.indexOf(cur);
    if (i < 0) i = 0; // 缺省按精写处理
    return WRITING_MODES[(i + 1) % WRITING_MODES.length];
  }

  async function cycleWriting() {
    var next = nextWritingMode(myPrefs.writing);
    try {
      var r = await api('/api/prefs', {
        method: 'POST', body: JSON.stringify({ writing: next }),
      });
      myPrefs.writing = (r && r.prefs && typeof r.prefs.writing === 'string') ? r.prefs.writing : next;
      renderWritingLabels();
      toast(WRITING_TOASTS[myPrefs.writing] || WRITING_TOASTS.fine);
    } catch (err) {
      toast(err.message || '设置失败'); // 失败：文字不变
    }
  }

  function appendOpening(text) {
    $('stream').appendChild(el('p', 'opening', text));
  }

  function appendActionLine(action) {
    var line = el('p', 'action-line');
    var bubble = el('span', 'action-bubble');
    bubble.appendChild(el('span', 'action-who', '你'));
    bubble.appendChild(el('span', 'action-text', action));
    line.appendChild(bubble);
    $('stream').appendChild(line);
    turnStartEl = line;             // 记住本回合起点
    scrollToTurnStart(line);        // 停在这条行动行，露出下面的「世界在回应…」
  }

  function appendDivider(text) {
    $('stream').appendChild(el('div', 'divider', text));
  }

  // 叙事 v3：正文流里的章名分隔，章名为空时只显示「第 N 章」。
  function appendChapterDivider(index, title) {
    var box = el('div', 'chapter-divider');
    box.appendChild(el('span', 'chapter-no', '第 ' + index + ' 章'));
    if (title) box.appendChild(el('span', 'chapter-name', title));
    $('stream').appendChild(box);
  }

  // 历史回放：/log 记录自带 chapter: { index, title }。
  function showChapterFromRecord(rec) {
    if (rec.chapter && rec.chapter.index && rec.chapter.index !== lastChapterShown) {
      appendChapterDivider(rec.chapter.index, rec.chapter.title);
      lastChapterShown = rec.chapter.index;
    }
  }

  // 新回合：用当前状态（上一回合的 state）判断；收章后的新章留到下一回合再插。
  function showChapterForTurn() {
    if (currentState && currentState.chapter && currentState.chapter.index
        && currentState.chapter.index !== lastChapterShown) {
      appendChapterDivider(currentState.chapter.index, currentState.chapterTitle);
      lastChapterShown = currentState.chapter.index;
    }
  }

  // 客户端徽章：与后端 /log 的 badges 同一种结构。statsDrains 为 res.stats_drains。
  function badgesFromApplied(applied, statsDrains) {
    var a = applied || {};
    var out = [];
    var diff = a.state_diff || {};
    Object.keys(diff).forEach(function (k) {
      var d = Number(diff[k]);
      if (d) out.push({ type: 'attr', name: k, delta: d });
    });
    // 世界专属状态：本回合直接造成的变化（自然变化 drift 太碎，不出徽章）。
    var sd = a.stats_diff || {};
    Object.keys(sd).forEach(function (k) {
      var d = Number(sd[k]);
      if (d) out.push({ type: 'stat', name: k, delta: d });
    });
    (a.items_add || []).forEach(function (n) { out.push({ type: 'item-add', name: n }); });
    (a.items_remove || []).forEach(function (n) { out.push({ type: 'item-remove', name: n }); });
    var npc = a.npc_attitude || {};
    Object.keys(npc).forEach(function (n) {
      var d = Number(npc[n]);
      if (d) out.push({ type: 'npc', name: n, delta: d });
    });
    // 生效警戒的后果：每回合扣 1 点基础属性（name 为属性名、label 为警戒名）。
    (Array.isArray(statsDrains) ? statsDrains : []).forEach(function (dr) {
      if (!dr || typeof dr !== 'object') return;
      out.push({ type: 'drain', name: dr.attr, delta: -1, label: dr.label || '' });
    });
    return out;
  }

  function makeBadge(b) {
    var s = el('span', 'badge');
    if (b.type === 'attr') {
      var up = b.delta > 0;
      s.className = 'badge ' + (up ? 'up' : 'down');
      s.textContent = b.name + ' ' + (up ? '+' + b.delta : '−' + Math.abs(b.delta));
    } else if (b.type === 'stat') {
      var stUp = b.delta > 0;
      s.className = 'badge stat ' + (stUp ? 'up' : 'down');
      s.textContent = b.name + ' ' + (stUp ? '+' + b.delta : '−' + Math.abs(b.delta));
    } else if (b.type === 'drain') {
      s.className = 'badge down drain';
      s.textContent = b.name + ' −' + Math.abs(b.delta || 1) + ' · ' + (b.label || '');
    } else if (b.type === 'item-add') {
      s.className = 'badge up';
      s.textContent = '获得 · ' + b.name;
    } else if (b.type === 'item-remove') {
      s.className = 'badge down';
      s.textContent = '失去 · ' + b.name;
    } else if (b.type === 'npc') {
      s.className = 'badge ' + (b.delta > 0 ? 'up' : 'down');
      s.textContent = b.name + ' 态度' + (b.delta > 0 ? '↑' : '↓');
    } else {
      s.textContent = b.name || '';
    }
    return s;
  }

  // 流式叙事：先建一个空叙事块，delta 到来时边到边按 \n\n 实时拆成多个 <p>。
  function beginStreamNarration() {
    var wrap = el('div', 'narration-block');
    wrap.appendChild(el('p', 'narration'));
    $('stream').appendChild(wrap);
    return { wrap: wrap, text: '' };
  }

  function appendStreamDelta(block, text) {
    block.text += text;
    var paras = splitByBlankLines(block.text);
    renderParagraphs(block.wrap, paras.length ? paras : ['']);
    // 流式期间不自动滚动：读者已从行动行开头往下读，跟随到底只会把旧内容顶上去。
  }

  // 一次性渲染完整叙事（历史回放 / result 最终补齐）：按 \n\n 拆成多个 <p>，
  // 旧存档没有分段的长段落按句末标点每约 80 字自动切段。
  // sceneId 为 "<life>-<turn>" 时，块最上面放一个插图框（初始闪烁占位，由 renderScenes 填图）。
  function appendNarration(text, badges, sceneId) {
    var wrap = el('div', 'narration-block');
    if (sceneId) {
      var frame = el('div', 'scene-frame img-pending');
      frame.setAttribute('data-scene', sceneId);
      wrap.appendChild(frame);
    }
    var paras = [];
    splitNarration(text).forEach(function (para) {
      paras.push(para);
      wrap.appendChild(el('p', 'narration', para));
    });
    if (badges && badges.length) {
      var bd = el('div', 'badges');
      badges.forEach(function (b) { bd.appendChild(makeBadge(b)); });
      wrap.appendChild(bd);
    }
    $('stream').appendChild(wrap);
    var turn = attachTurnButton(wrap, paras, currentVoiceHints);
    return { paras: paras, hints: currentVoiceHints, wrap: wrap, turn: turn };
  }

  // 整回合朗读：只放一个「▶ 朗读」按钮，优先放进本回合行动行（气泡右侧、同一行），
  // 找不到行动行时（重生开场 / 序章后的第一段 / 行动行已有按钮）仍放在叙事块最前面。
  // 返回的 turn 交给 Tts.autoRead / 播放队列，按段落顺序读完整回合。
  function attachTurnButton(wrap, paras, hints) {
    if (typeof Tts === 'undefined') return null;
    var turn = { wrap: wrap, paras: paras, hints: hints || [], btn: null };
    var b = Tts.makeTurnButton(turn);
    var head = el('div', 'tts-turn-head');
    head.appendChild(b);

    // 从 wrap 往前找本回合行动行：跳过事件卡 / 分隔，遇行动行即目标，其余元素或到头就停止。
    var inline = false;
    var node = wrap.previousElementSibling;
    while (node) {
      if (node.classList.contains('event-card') || node.classList.contains('divider')) {
        node = node.previousElementSibling;
        continue;
      }
      if (node.classList.contains('action-line') && !node.querySelector('.tts-turn-head')) {
        node.appendChild(head);                    // 追加到 .action-bubble 之后
        wrap.setAttribute('data-tts-inline', '1');
        inline = true;
      }
      break;                                       // 非跳过元素一律停止搜索
    }
    if (!inline) wrap.insertBefore(head, wrap.firstChild);

    turn.btn = b;
    return turn;
  }

  function appendEventCard(ev) {
    var c = el('div', 'event-card');
    c.appendChild(el('div', 'event-card-label', '⚠ 世界性事件'));
    c.appendChild(el('div', 'event-card-title', ev.title || ev.theme || '事件'));
    if (ev.desc) c.appendChild(el('div', 'event-card-desc', ev.desc));
    $('stream').appendChild(c);
  }

  function appendSettlementCard(st) {
    var c = el('div', 'settlement-card');
    c.appendChild(el('div', 'settlement-tier', '结算 · ' + (st.tier || '')));
    c.appendChild(el('div', 'settlement-title', st.title || st.theme || ''));
    var parts = [];
    var effects = st.effects || {};
    Object.keys(effects).forEach(function (k) {
      var v = Number(effects[k]);
      if (v) parts.push(k + (v > 0 ? ' +' + v : ' −' + Math.abs(v)));
    });
    if (parts.length) c.appendChild(el('div', 'settlement-effects', parts.join('　')));
    $('stream').appendChild(c);
  }

  function appendLogRecord(rec) {
    showChapterFromRecord(rec); // 叙事 v3：换章时在行动行之前插章名分隔
    // 重生生成的「新一世开场」是该世第一条叙事，回放时用开场样式显示。
    if (rec.rebirthOpening && rec.narration) { appendOpening(rec.narration); return; }
    if (rec.action) appendActionLine(rec.action);
    if (rec.event) appendEventCard(rec.event);
    // 时光推进：在行动行之后、叙事之前插一条分隔，label 非字符串时不插。
    if (rec.timeSkip && typeof rec.timeSkip.label === 'string') {
      appendDivider('—— ' + rec.timeSkip.label + '后 ——');
    }
    if (rec.narration) {
      var logSceneId = (rec.scene && rec.scene.draw) ? (rec.life + '-' + rec.turn) : null;
      currentVoiceHints = rec.voice_hints || [];
      appendNarration(rec.narration, rec.badges || [], logSceneId);
    }
    if (rec.settlement) appendSettlementCard(rec.settlement);
    if (rec.death) appendDivider('第 ' + rec.life + ' 世 · 终');
  }

  function renderEventBanner(ev) {
    var b = $('event-banner');
    b.textContent = '';
    if (!ev) { b.hidden = true; return; }
    // 手机：叙事流里已有对应事件卡片时不再用横幅重复占屏（内容重复）。
    if (window.innerWidth <= 600) {
      var title = ev.title || ev.theme || '';
      var cards = $('stream').querySelectorAll('.event-card');
      for (var k = 0; k < cards.length; k++) {
        if (title && cards[k].textContent.indexOf(title) >= 0) { b.hidden = true; return; }
      }
    }
    b.hidden = false;
    b.appendChild(el('span', 'event-banner-icon', '⚠'));
    var body = el('div', 'event-banner-body');
    body.appendChild(el('div', 'event-banner-title', ev.title || ev.theme || '事件'));
    if (ev.desc) body.appendChild(el('div', 'event-banner-desc', ev.desc));
    b.appendChild(body);
  }

  /* IDEA_HELPERS_START */
  // ---- 灵感按钮：点一下把一条「下一步可以做什么」填进输入框，再点换下一条 ----
  var ideaQueue = [];        // 还没填过的建议
  var ideaShown = [];        // 本场景已填过的建议（最多留 12 条，供 avoid 去重）
  var ideaLoading = false;   // /suggest 请求进行中
  var ideaToken = 0;         // 防串世界的过期响应

  // 换场景 / 重生 / 回合结果：重置队列与已填记录，作废在途请求，刷新按钮状态。
  function resetIdeas(list) {
    ideaToken++;
    ideaLoading = false;
    ideaQueue = [];
    var arr = Array.isArray(list) ? list : [];
    for (var i = 0; i < arr.length && ideaQueue.length < 3; i++) {
      if (typeof arr[i] !== 'string') continue;
      var t = arr[i].trim();
      if (t) ideaQueue.push(t);
    }
    ideaShown = [];
    var btn = $('btn-idea');
    if (btn) {
      btn.textContent = '✦ 灵感';
      if (btn.removeAttribute) btn.removeAttribute('aria-busy');
      btn.disabled = !!(busy || ideaLoading);
    }
  }

  function fillIdea(text) {
    var input = $('action-input');
    if (!input) return;
    input.value = text;
    ideaShown.push(text);
    if (ideaShown.length > 12) ideaShown.shift();
    if (input.focus) input.focus();
    if (input.setSelectionRange) {
      try { input.setSelectionRange(text.length, text.length); } catch (_) {}
    }
    if (input.dispatchEvent && typeof Event !== 'undefined') {
      input.dispatchEvent(new Event('input'));
    }
    // 0.6 秒轻微发光反馈：remove → 强制重排 → add，连续点击也能重播动画。
    var btn = $('btn-idea');
    if (btn && btn.classList) {
      btn.classList.remove('idea-flash');
      if (btn.offsetWidth !== undefined) void btn.offsetWidth;
      btn.classList.add('idea-flash');
      clearTimeout(btn._ideaFlashTimer);
      btn._ideaFlashTimer = setTimeout(function () {
        if (btn.classList) btn.classList.remove('idea-flash');
      }, 600);
    }
  }

  async function nextIdea() {
    if (busy || !currentWorldId || ideaLoading) return;
    var btn = $('btn-idea');
    if (ideaQueue.length) { fillIdea(ideaQueue.shift()); return; }
    ideaLoading = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '构思中…';
      if (btn.setAttribute) btn.setAttribute('aria-busy', 'true');
    }
    var myToken = ideaToken;
    var myWorld = currentWorldId;
    try {
      var res = await api('/api/worlds/' + encodeURIComponent(myWorld) + '/suggest', {
        method: 'POST',
        body: JSON.stringify({ avoid: ideaShown.slice(-12) }),
      });
      if (myToken !== ideaToken || myWorld !== currentWorldId) return; // 过期响应，丢弃
      var list = (res && Array.isArray(res.suggestions)) ? res.suggestions : [];
      for (var i = 0; i < list.length && ideaQueue.length < 3; i++) {
        if (typeof list[i] !== 'string') continue;
        var t = list[i].trim();
        if (!t || ideaShown.indexOf(t) !== -1 || ideaQueue.indexOf(t) !== -1) continue;
        ideaQueue.push(t);
      }
      if (ideaQueue.length) fillIdea(ideaQueue.shift());
      else toast('这次没想出新点子，再点一次试试');
    } catch (err) {
      // 切走后旧世界的报错不要弹给新世界：token 与世界都未变才提示。
      if (myToken === ideaToken && myWorld === currentWorldId) {
        toast(err && err.message ? err.message : String(err));
      }
    } finally {
      // 过期请求（resetIdeas 已自增 token）什么都不碰：否则会把新世界
      // 在途请求的 ideaLoading / 按钮复位，玩家可重复点击发出重复请求。
      if (myToken === ideaToken) {
        ideaLoading = false;
        if (btn) {
          btn.textContent = '✦ 灵感';
          if (btn.removeAttribute) btn.removeAttribute('aria-busy');
          btn.disabled = !!(busy || ideaLoading);
        }
      }
    }
  }
  /* IDEA_HELPERS_END */

  // ---- 六边形雷达：角色卡基础属性 / 玩家画像共用 ----
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgNode(tag, cls) {
    var n = document.createElementNS(SVG_NS, tag);
    if (cls) n.setAttribute('class', cls);
    return n;
  }
  // axes 六轴名、values 对应数值、scale 满值半径对应的数值（下限 15）。
  // opts: { withValue, dangerIndex, dataAttr }
  function radarSvg(axes, values, scale, opts) {
    opts = opts || {};
    var sc = Math.max(15, Number(scale) || 0);
    var cx = 100, cy = 92, R = 70;
    var svg = svgNode('svg');
    // 左右各多留 34 的边距放顶点外侧的「属性名 值」标签，避免右侧标签被裁掉。
    svg.setAttribute('viewBox', '-34 0 268 184');
    function point(i, radius) {
      var ang = -Math.PI / 2 + i * (Math.PI / 3); // 第一轴正上方，顺时针
      return [cx + radius * Math.cos(ang), cy + radius * Math.sin(ang)];
    }
    function polyPoints(radiusFn) {
      var pts = [];
      for (var i = 0; i < 6; i++) {
        var p = point(i, radiusFn(i));
        pts.push(p[0].toFixed(2) + ',' + p[1].toFixed(2));
      }
      return pts.join(' ');
    }
    // 三层同心六边形网格：33% / 66% / 100%
    [0.33, 0.66, 1].forEach(function (lv) {
      var g = svgNode('polygon', 'radar-grid');
      g.setAttribute('points', polyPoints(function () { return R * lv; }));
      svg.appendChild(g);
    });
    // 六条轴线
    for (var a = 0; a < 6; a++) {
      var ep = point(a, R);
      var line = svgNode('line', 'radar-axis');
      line.setAttribute('x1', String(cx));
      line.setAttribute('y1', String(cy));
      line.setAttribute('x2', ep[0].toFixed(2));
      line.setAttribute('y2', ep[1].toFixed(2));
      svg.appendChild(line);
    }
    // 数值多边形：每轴半径 = 70 * min(1, v / scale)
    var radii = [];
    for (var k = 0; k < 6; k++) {
      var v = Number(values[k]) || 0;
      radii.push(R * Math.min(1, Math.max(0, v) / sc));
    }
    var shape = svgNode('polygon', 'radar-shape');
    shape.setAttribute('points', polyPoints(function (i) { return radii[i]; }));
    svg.appendChild(shape);
    // 顶点外侧标签（字号由 CSS 控制）
    for (var t = 0; t < 6; t++) {
      var lp = point(t, R + 14);
      var text = svgNode('text', 'radar-label');
      text.setAttribute('x', lp[0].toFixed(2));
      text.setAttribute('y', lp[1].toFixed(2));
      text.setAttribute('text-anchor', lp[0] < cx - 4 ? 'end' : (lp[0] > cx + 4 ? 'start' : 'middle'));
      if (opts.dataAttr) text.setAttribute('data-attr', axes[t]);
      text.textContent = opts.withValue ? (axes[t] + ' ' + values[t]) : axes[t];
      svg.appendChild(text);
    }
    // 体魄 danger 顶点小圆
    if (opts.dangerIndex != null && opts.dangerIndex >= 0 && opts.dangerIndex < 6) {
      var dp = point(opts.dangerIndex, radii[opts.dangerIndex]);
      var dot = svgNode('circle', 'radar-dot danger');
      dot.setAttribute('cx', dp[0].toFixed(2));
      dot.setAttribute('cy', dp[1].toFixed(2));
      dot.setAttribute('r', '3');
      svg.appendChild(dot);
    }
    return svg;
  }

  // ---- 世界专属状态：gauge / rank 两种 .stat ----
  function makeStatNode(st) {
    if (!st || typeof st !== 'object') return el('div', 'stat');
    var desc = typeof st.desc === 'string' ? st.desc : '';
    var icon = typeof st.icon === 'string' ? st.icon : '';
    var name = typeof st.name === 'string' ? st.name : '';
    if (st.kind === 'rank') {
      var rankWrap = el('div', 'stat stat-rank');
      rankWrap.setAttribute('title', desc);
      var rankTop = el('div', 'stat-top');
      rankTop.appendChild(el('span', 'stat-icon', icon));
      rankTop.appendChild(el('span', 'stat-name', name));
      rankTop.appendChild(el('span', 'stat-val', typeof st.rankName === 'string' ? st.rankName : ''));
      rankWrap.appendChild(rankTop);
      var ranks = Array.isArray(st.ranks) ? st.ranks : [];
      var vi = Math.max(0, Math.min(ranks.length - 1, Math.round(Number(st.value) || 0)));
      var steps = el('div', 'rank-steps');
      ranks.forEach(function (r, i) {
        var cls = 'rank-step';
        if (i < vi) cls += ' done';
        if (i === vi) cls += ' current';
        var step = el('span', cls);
        step.setAttribute('title', r);
        steps.appendChild(step);
      });
      rankWrap.appendChild(steps);
      return rankWrap;
    }
    // gauge
    var max = Number(st.max) > 0 ? Number(st.max) : 100;
    var value = Math.max(0, Math.min(max, Number(st.value) || 0));
    var alerts = Array.isArray(st.alerts) ? st.alerts : [];
    var severe = alerts.some(function (a) { return a && a.severe; });
    var cls = 'stat stat-gauge' + (alerts.length ? ' alert' : '') + (severe ? ' severe' : '');
    var node = el('div', cls);
    node.setAttribute('title', desc);
    var top = el('div', 'stat-top');
    top.appendChild(el('span', 'stat-icon', icon));
    top.appendChild(el('span', 'stat-name', name));
    var valSpan = el('span', 'stat-val', String(value));
    valSpan.appendChild(el('small', '', '/' + max));
    top.appendChild(valSpan);
    node.appendChild(top);
    var bar = el('div', 'stat-bar');
    var fill = el('i');
    fill.style.width = (value / max * 100) + '%';
    bar.appendChild(fill);
    // 「非 drain 警戒线」：每条不带 drain 的 warn，在其 below/above 值处画一个刻度。
    (Array.isArray(st.warn) ? st.warn : []).forEach(function (w) {
      if (!w || typeof w !== 'object' || w.drain) return;
      var th = w.below != null ? w.below : w.above;
      var n = Number(th);
      if (!isFinite(n)) return;
      var pct = Math.max(0, Math.min(100, (n / max) * 100));
      var tick = el('b', 'stat-tick');
      tick.style.left = pct + '%';
      bar.appendChild(tick);
    });
    node.appendChild(bar);
    alerts.forEach(function (a) {
      if (!a) return;
      node.appendChild(el('div', 'stat-alert', '⚠ ' + (a.label || '') + '：' + (a.effect || '')));
    });
    return node;
  }

  function renderStatList(box, stats) {
    if (!box) return;
    box.textContent = '';
    var list = Array.isArray(stats) ? stats : [];
    if (!list.length) {
      box.appendChild(el('div', 'muted', '正在为这个世界设计专属状态…'));
      return;
    }
    list.forEach(function (st) { box.appendChild(makeStatNode(st)); });
  }

  // ---- 角色卡头像：契约与 images.js 的 renderHero 一致，从 imageState.hero 取图 ----
  function renderCharAvatar() {
    var box = null;
    if (document.querySelector) box = document.querySelector('.char-avatar');
    if (!box) box = $('hero-row-avatar');
    if (!box) return;
    box.textContent = '';
    box.appendChild(makeImageVisual('你', imageState.hero, 'char-avatar-img', false));
  }

  // ---- 标签切换：只改显示、不重画；当前标签记在 localStorage 'panelTab' ----
  function readPanelTab() {
    try {
      var v = localStorage.getItem('panelTab');
      for (var i = 0; i < PANEL_TABS.length; i++) {
        if (PANEL_TABS[i].key === v) return v;
      }
    } catch (_) {}
    return 'char';
  }

  function activatePanelTab(key) {
    if (!panelPanes[key]) key = 'char';
    for (var i = 0; i < panelTabButtons.length; i++) {
      var b = panelTabButtons[i];
      b.setAttribute('aria-selected', b.getAttribute('data-tab') === key ? 'true' : 'false');
    }
    Object.keys(panelPanes).forEach(function (k) {
      if (panelPanes[k] && panelPanes[k].classList) {
        panelPanes[k].classList.toggle('active', k === key);
      }
    });
    try { localStorage.setItem('panelTab', key); } catch (_) {}
  }

  // ---- 跨世界玩家画像 ----
  function fetchProfile() {
    api('/api/profile')
      .then(function (data) {
        if (data && data.profile) {
          profileData = data.profile;
          renderProfilePane();
        }
      })
      .catch(function () {});
  }

  function renderProfilePane() {
    var pane = panelPanes.profile;
    if (!pane) return;
    pane.textContent = '';
    var p = profileData || {};
    var turns = Number(p.turns) || 0;
    var dims = (p.dims && typeof p.dims === 'object') ? p.dims : {};
    var traits = Array.isArray(p.traits) ? p.traits : [];
    var head = el('div', 'profile-head');
    head.appendChild(el('div', 'profile-title', '你的玩家画像'));
    head.appendChild(el('div', 'profile-sub', '跨所有世界 · 已玩 ' + turns + ' 回合'));
    pane.appendChild(head);
    if (!p.ready) {
      pane.appendChild(el('div', 'profile-hint',
        '再玩 ' + Math.max(0, 10 - turns) + ' 回合，画像会更准'));
    }
    var values = PERSONA.map(function (d) { return Number(dims[d]) || 0; });
    var radarWrap = el('div', 'profile-radar persona-radar');
    radarWrap.appendChild(radarSvg(PERSONA, values, 100, { withValue: false, dataAttr: false }));
    pane.appendChild(radarWrap);
    if (traits.length) {
      var tw = el('div', 'profile-traits');
      traits.forEach(function (t) { tw.appendChild(el('span', 'trait-chip', t)); });
      pane.appendChild(tw);
    }
    pane.appendChild(el('p', 'profile-summary',
      p.summary || '再多玩几回合，AI 会总结你是什么样的玩家。'));
    if (p.wants) pane.appendChild(el('p', 'profile-wants', '你偏爱的剧情：' + p.wants));
    pane.appendChild(el('p', 'profile-note muted',
      '画像只根据你亲手写下的行动生成，开新世界会自带；「灵感」会参考它。'));
    var btn = el('button', 'btn tiny profile-reset', profileResetArmed ? '确认重置？' : '重置画像');
    btn.type = 'button';
    btn.addEventListener('click', onProfileResetClick);
    pane.appendChild(btn);
    profileResetBtn = btn;
  }

  // 两步确认：第一次点变「确认重置？」4 秒内再点才 DELETE；4 秒不点恢复原文字。
  function onProfileResetClick() {
    if (!profileResetArmed) {
      profileResetArmed = true;
      if (profileResetBtn) profileResetBtn.textContent = '确认重置？';
      clearTimeout(profileResetTimer);
      profileResetTimer = setTimeout(function () {
        profileResetArmed = false;
        if (profileResetBtn) profileResetBtn.textContent = '重置画像';
      }, 4000);
      return;
    }
    clearTimeout(profileResetTimer);
    profileResetArmed = false;
    if (profileResetBtn) profileResetBtn.textContent = '重置画像';
    api('/api/profile', { method: 'DELETE' })
      .then(function (data) {
        profileData = (data && data.profile) ? data.profile : null;
        toast('画像已重置');
        renderProfilePane();
      })
      .catch(function () {});
  }

  function collapsible(title, children) {
    var d = el('details', 'panel-section');
    var sum = el('summary', 'panel-h', title);
    d.appendChild(sum);
    children.forEach(function (c) { d.appendChild(c); });
    return d;
  }

  function renderTopAttrs(s) {
    var box = $('top-attrs');
    box.textContent = '';
    // 专属状态小标签排在属性小标签前面
    var stats = (s && Array.isArray(s.stats)) ? s.stats : [];
    stats.forEach(function (st) {
      if (!st) return;
      var alerts = Array.isArray(st.alerts) ? st.alerts : [];
      var severe = alerts.some(function (a) { return a && a.severe; });
      var cls = 'top-chip stat-chip' + (alerts.length ? ' alert' : '') + (severe ? ' severe' : '');
      var text = (st.icon || '') + ' ' + (st.kind === 'rank'
        ? (st.rankName || '') : (st.value != null ? st.value : ''));
      var chip = el('span', cls, text);
      chip.setAttribute('title', st.name || '');
      box.appendChild(chip);
    });
    var attrs = (s.character && s.character.attrs) || {};
    var danger = isDanger(s);
    ATTRS.forEach(function (a) {
      var cls = a === '体魄' && danger ? 'top-chip danger-chip' : 'top-chip';
      var chip = el('span', cls, a + ' ' + (attrs[a] || 0));
      chip.setAttribute('data-attr', a); // 顶部属性条：点击弹说明卡
      box.appendChild(chip);
    });
  }

  function renderPanel(s) {
    var panel = $('panel');
    panel.textContent = '';
    // 手机抽屉顶部关闭 ×（桌面隐藏，见 .sheet-close 默认 display:none）
    panel.appendChild(sheetCloseButton(function () {
      panel.dataset.open = 'false';
      syncBodyScrollLock();
    }));

    panelTabButtons = [];
    panelPanes = {};
    var attrs = (s.character && s.character.attrs) || {};
    var danger = isDanger(s);
    var stats = Array.isArray(s.stats) ? s.stats : [];

    // ---- 角色卡 ----
    var card = el('div', 'char-card');
    var avatar = el('div', 'char-avatar');
    avatar.id = 'hero-row-avatar';
    card.appendChild(avatar);
    var meta = el('div', 'char-meta');
    meta.appendChild(el('div', 'char-name', (s.character && s.character.name) || '无名旅人'));
    meta.appendChild(el('div', 'char-sub', '第 ' + (s.life || 0) + ' 世 · 第 ' + (s.turn || 0) + ' 回合'));
    var badges = el('div', 'char-badges');
    stats.forEach(function (st) {
      if (st && st.kind === 'rank') {
        badges.appendChild(el('span', 'char-rank', (st.icon || '') + ' ' + (st.rankName || '')));
      }
    });
    if (danger) badges.appendChild(el('span', 'char-danger', '伤势沉重'));
    meta.appendChild(badges);
    card.appendChild(meta);
    panel.appendChild(card);

    // ---- 四个标签 ----
    var tabsNav = el('nav', 'panel-tabs');
    tabsNav.setAttribute('role', 'tablist');
    PANEL_TABS.forEach(function (t) {
      var b = el('button', 'panel-tab', t.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', 'false');
      b.setAttribute('data-tab', t.key);
      b.addEventListener('click', function () { activatePanelTab(t.key); });
      tabsNav.appendChild(b);
      panelTabButtons.push(b);
    });
    panel.appendChild(tabsNav);

    // ---- 角色页 ----
    var charPane = el('section', 'panel-pane');
    charPane.setAttribute('data-pane', 'char');
    panelPanes.char = charPane;
    charPane.appendChild(el('div', 'pane-h', '状态'));
    var statList = el('div', 'stat-list');
    statList.id = 'stat-list';
    renderStatList(statList, stats);
    charPane.appendChild(statList);
    charPane.appendChild(el('div', 'pane-h', '基础属性'));
    var attrVals = ATTRS.map(function (a) { return Number(attrs[a]) || 0; });
    var attrScale = Math.max(15, Math.max.apply(null, attrVals) + 2);
    var attrRadar = el('div', 'attr-radar');
    attrRadar.appendChild(radarSvg(ATTRS, attrVals, attrScale, {
      withValue: true, dataAttr: true, dangerIndex: danger ? 0 : null,
    }));
    charPane.appendChild(attrRadar);
    var attrGrid = el('div', 'attr-grid');
    ATTRS.forEach(function (a) {
      var row = el('div', a === '体魄' && danger ? 'attr-cell danger' : 'attr-cell');
      row.setAttribute('data-attr', a); // 保留点击弹说明卡
      row.appendChild(el('span', 'attr-cell-name', a));
      row.appendChild(el('span', 'attr-cell-val', String(Number(attrs[a]) || 0)));
      attrGrid.appendChild(row);
    });
    charPane.appendChild(attrGrid);
    charPane.appendChild(el('div', 'pane-h', '背包'));
    var itemGrid = el('div', 'item-grid');
    itemGrid.id = 'item-grid';
    charPane.appendChild(itemGrid);
    charPane.appendChild(el('div', 'pane-h', '身上的印记'));
    var marks = (s.character && s.character.marks) || [];
    if (marks.length) marks.forEach(function (m) { charPane.appendChild(el('span', 'mark-chip', m)); });
    else charPane.appendChild(el('span', 'muted', '（尚无印记）'));
    panel.appendChild(charPane);

    // ---- 人物页 ----
    var peoplePane = el('section', 'panel-pane');
    peoplePane.setAttribute('data-pane', 'people');
    panelPanes.people = peoplePane;
    var heroRow = el('div', 'npc-row');
    heroRow.id = 'hero-row';
    peoplePane.appendChild(heroRow);
    peoplePane.appendChild(el('div', 'pane-h', '认识的人'));
    var npcList = el('div', 'npc-list');
    npcList.id = 'npc-list';
    peoplePane.appendChild(npcList);
    panel.appendChild(peoplePane);

    // ---- 线索页 ----
    var cluesPane = el('section', 'panel-pane');
    cluesPane.setAttribute('data-pane', 'clues');
    panelPanes.clues = cluesPane;
    // 叙事 v3：已写完的章，放在线索页最上面。
    var chapters = s.chapters || [];
    if (chapters.length) {
      cluesPane.appendChild(el('div', 'pane-h', '章节回顾'));
      chapters.forEach(function (ch) {
        var box = el('div', 'chapter-recap');
        var rh = el('div', 'chapter-recap-h',
          '第 ' + ch.index + ' 章' + (ch.title ? ' · ' + ch.title : ''));
        rh.appendChild(el('small', '', '第 ' + ch.fromTurn + '~' + ch.toTurn + ' 回合'));
        box.appendChild(rh);
        if (ch.summary) box.appendChild(el('p', '', ch.summary));
        cluesPane.appendChild(box);
      });
    }
    var threads = s.threads || [];
    cluesPane.appendChild(el('div', 'pane-h', '未解之谜'));
    if (threads.length) {
      threads.forEach(function (t) { cluesPane.appendChild(el('div', 'thread-item', '· ' + t)); });
    } else cluesPane.appendChild(el('div', 'muted', '（尚无未解之谜）'));
    var rumors = s.rumors || [];
    cluesPane.appendChild(el('div', 'pane-h', '坊间传闻'));
    if (rumors.length) {
      rumors.slice().reverse().forEach(function (r) {
        cluesPane.appendChild(el('div', 'rumor-item', '· ' + (r.text || '')));
      });
    } else cluesPane.appendChild(el('div', 'muted', '（尚无传闻）'));
    var facts = s.facts || [];
    var factChildren = facts.length
      ? facts.map(function (f) { return el('div', 'fact-item', '· ' + (f.text || '')); })
      : [el('div', 'muted', '（尚无已确立的事实）')];
    cluesPane.appendChild(collapsible('已知的事', factChildren));
    var past = s.pastLives || [];
    cluesPane.appendChild(el('div', 'pane-h', '前世'));
    if (past.length) {
      past.slice().reverse().forEach(function (pl) {
        var item = el('div', 'past-life-item');
        item.appendChild(el('div', 'past-life-head',
          '第' + pl.life + '世 · ' + (pl.name || '无名') + ' · ' + (pl.turns || 0) + ' 回合'));
        item.appendChild(el('div', 'past-life-epitaph', pl.epitaph || ''));
        cluesPane.appendChild(item);
      });
    } else cluesPane.appendChild(el('div', 'muted', '（尚无前世）'));
    // 叙事 v3 用「章节回顾」代替编年史：v3 世界隐藏原编年史折叠段。
    if (!s.chapter) {
      var chronicle = s.chronicle || [];
      var chChildren = chronicle.length
        ? chronicle.map(function (c) {
            return el('div', 'chronicle-item',
              '第' + c.chapter + '章（' + c.fromTurn + '-' + c.toTurn + '）：' + c.summary);
          })
        : [el('div', 'muted', '（尚无编年史）')];
      cluesPane.appendChild(collapsible('编年史', chChildren));
    }
    var bible = s.bible || {};
    var wsChildren = [];
    wsChildren.push(el('div', 'world-setting', '基调：' + (bible.tone || '—')));
    (bible.places || []).forEach(function (p) {
      wsChildren.push(el('div', 'world-setting', '地点 · ' + p.name + '：' + (p.desc || '')));
    });
    (bible.factions || []).forEach(function (f) {
      wsChildren.push(el('div', 'world-setting', '势力 · ' + f.name + '（' + (f.stance || '') + '）'));
    });
    (bible.rules || []).forEach(function (r) { wsChildren.push(el('div', 'world-setting', '规则 · ' + r)); });
    // 序章入口：有则直接重看（按钮显示「继续」），无则补生成后再弹出。
    var prologueBtn = el('button', 'btn tiny', '序章');
    prologueBtn.addEventListener('click', async function () {
      var p = (currentState && currentState.bible && currentState.bible.prologue)
        || (s.bible && s.bible.prologue);
      var wt = (s.bible && s.bible.title) || '无限世界';
      if (p) {
        showPrologue(wt, p, null);
        prologueBtn.textContent = '继续';
        return;
      }
      prologueBtn.textContent = '生成中…';
      prologueBtn.disabled = true;
      try {
        var data = await api('/api/worlds/' + encodeURIComponent(currentWorldId) + '/prologue');
        var gen = data && data.prologue;
        if (gen) {
          currentState.bible = currentState.bible || {};
          currentState.bible.prologue = gen;
          prologueBtn.textContent = '继续';
          prologueBtn.disabled = false;
          showPrologue(wt, gen, null);
        } else {
          prologueBtn.textContent = '序章';
          prologueBtn.disabled = false;
          toast('序章暂时生成不了，稍后再试');
        }
      } catch (_) {
        prologueBtn.textContent = '序章';
        prologueBtn.disabled = false;
        toast('序章暂时生成不了，稍后再试');
      }
    });
    cluesPane.appendChild(prologueBtn);
    cluesPane.appendChild(collapsible('世界设定', wsChildren));
    panel.appendChild(cluesPane);

    // ---- 画像页 ----
    var profilePane = el('section', 'panel-pane');
    profilePane.setAttribute('data-pane', 'profile');
    panelPanes.profile = profilePane;
    panel.appendChild(profilePane);

    renderProfilePane();
    renderTopAttrs(s);
    renderImages(); // 用当前 /images 状态填充物品卡片与 NPC 头像
    syncSceneRail(); // 宽屏：把当前回合插图镜像到右侧栏顶部（见 app.css ≥1200px）
    renderCharAvatar();
    activatePanelTab(readPanelTab());
  }

  function showDeath(state, death) {
    var m = $('death-mask');
    m.textContent = '';
    m.hidden = false;
    var card = el('div', 'death-card');
    var past = state.pastLives || [];
    var last = past.length ? past[past.length - 1] : null;
    var lifeNo = death ? death.life : (last ? last.life : state.life);
    card.appendChild(el('div', 'death-kicker', '第 ' + lifeNo + ' 世 · 终'));
    // 体魄归零 / 事件殒命：死亡遮罩写明死因（重进页面时从前世记录取回）。
    var cause = (death && death.reason) || (last && last.cause) || '';
    if (cause) card.appendChild(el('div', 'death-cause', '死因 · ' + cause));
    var summary = '本世走过 ' + state.turn + ' 回合。';
    if (death && death.inheritedReputation != null) {
      summary += '声望余响 ' + death.inheritedReputation + ' 将随你进入下一世，认识过你的人也还记得你。';
    } else {
      summary += '声名会留下淡淡的余响，随你进入下一世。';
    }
    card.appendChild(el('p', 'death-summary', summary));
    if (last && last.epitaph) {
      card.appendChild(el('p', 'epitaph', last.epitaph)); // 前世墓志铭
    }

    var form = el('div', 'rebirth-form');
    form.appendChild(el('label', '', '新的名字'));
    var name = el('input');
    name.id = 'rb-name';
    name.placeholder = '这一世，你叫什么';
    form.appendChild(name);
    form.appendChild(el('label', '', '新的形象'));
    var app = el('input');
    app.id = 'rb-appearance';
    app.placeholder = '一袭布衣';
    form.appendChild(app);
    var btn = el('button', 'btn primary', '重生');
    btn.addEventListener('click', doRebirth);
    form.appendChild(btn);
    card.appendChild(form);
    m.appendChild(card);
  }

  function hideDeath() { $('death-mask').hidden = true; }

  async function doRebirth() {
    var name = $('rb-name').value.trim();
    var appearance = $('rb-appearance').value.trim();
    if (!name || !appearance) { toast('请填写新的名字与形象'); return; }
    try {
      var s = await api('/api/worlds/' + encodeURIComponent(currentWorldId) + '/rebirth', {
        method: 'POST',
        body: JSON.stringify({ name: name, appearance: appearance }),
      });
      currentState = s;
      hideDeath();
      clearStream();
      // 用后端 LLM 生成（失败时模板兜底）的「新一世开场」作为该世第一条叙事。
      appendOpening(s.rebirthOpening ||
        ('第 ' + s.life + ' 世，你在陌生的晨光里醒来。名字与面孔都已不同，世界却还是那个世界。'));
      renderHeader(s);
      renderPanel(s);
      renderEventBanner(s.activeEvent);
      resetIdeas([]);
    } catch (err) {
      toast(err.message);
    }
  }

  function updatePendingSecs() {
    var secs = Math.floor((Date.now() - pendingStart) / 1000);
    $('pending-secs').textContent = '已等待 ' + secs + ' 秒';
  }

  // 叙事 v3：只换 #pending 前面的提示文字，秒数仍由原计时器更新。
  function setPendingLabel(text) {
    var n = $('pending-label');
    if (n) n.textContent = text;
  }

  function setBusy(b) {
    busy = b;
    $('btn-send').disabled = b;
    $('btn-idea').disabled = b || ideaLoading;
    $('pending').hidden = !b;
    clearInterval(pendingTimer);
    pendingTimer = null;
    if (b) {
      setPendingLabel('世界在回应…'); // 每回合开始重置提示文字
      pendingStart = Date.now();
      updatePendingSecs(); // 立刻显示 0 秒
      pendingTimer = setInterval(updatePendingSecs, 1000);
    } else {
      $('pending-secs').textContent = '';
    }
  }

  // POST 不能用 EventSource，只能自己解析 fetch 返回的 text/event-stream。
  async function readEventStream(res, onEvent) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var cur = { event: 'message', data: '' };
    function dispatch() {
      if (cur.data === '' && cur.event === 'message') return;
      onEvent(cur.event, cur.data);
    }
    function line(lineText) {
      if (lineText === '') { dispatch(); cur = { event: 'message', data: '' }; return; }
      if (lineText.charAt(0) === ':') return; // 注释行
      var colon = lineText.indexOf(':');
      var field = colon < 0 ? lineText : lineText.slice(0, colon);
      var value = colon < 0 ? '' : lineText.slice(colon + 1);
      if (value.charAt(0) === ' ') value = value.slice(1);
      if (field === 'event') cur.event = value;
      else if (field === 'data') cur.data += (cur.data ? '\n' : '') + value;
    }
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      var idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        line(buf.slice(0, idx).replace(/\r$/, ''));
        buf = buf.slice(idx + 1);
      }
    }
    buf += decoder.decode(); // flush 未完成的多字节序列
    if (buf) line(buf.replace(/\r$/, ''));
    dispatch();
  }

  // 发起流式回合：body 为完整请求体对象（{action} 或 {timeSkip}），
  // delta 边到边显示，返回最后的 result（与普通 /turn 响应体相同）。
  async function streamTurn(body, block) {
    var res = await fetch('/api/worlds/' + encodeURIComponent(currentWorldId) + '/turn/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 未登录 / 会话失效：跳到登录页。
    if (res.status === 401) {
      location.href = '/login.html';
      throw new Error('需要先输入访问密码');
    }
    if (!res.ok || !res.body) throw new Error('流式请求失败（' + res.status + '）');
    var result = null;
    var streamError = null;
    var gotFirstDelta = false;
    await readEventStream(res, function (event, data) {
      try {
        if (event === 'thinking') {
          setPendingLabel('正在构思这一节…'); // 动笔前构思：只有累计字数、无内容
        } else if (event === 'delta') {
          if (!gotFirstDelta) { gotFirstDelta = true; setPendingLabel('世界在回应…'); }
          var d = JSON.parse(data);
          if (typeof d.text === 'string') appendStreamDelta(block, d.text);
        } else if (event === 'result') {
          result = JSON.parse(data);
        } else if (event === 'error') {
          var e = JSON.parse(data);
          streamError = new Error(e.error || '流式回合失败');
        }
      } catch (_) { /* 忽略单条解析错误，继续读流 */ }
    });
    if (streamError) throw streamError;
    if (!result) throw new Error('流式响应缺少 result');
    return result;
  }

  // result 到来（或普通 /turn 返回）后的统一渲染：叙事、徽章、事件/结算卡片、头部/面板/建议/死亡。
  function renderResult(res) {
    currentState = res.state;
    renderHeader(res.state, { scene: res.scene, narration: res.narration });
    if (res.event) appendEventCard(res.event);
    var sceneId = (res.scene && res.scene.draw && res.sceneKey)
      ? (res.state.life + '-' + res.state.turn) : null;
    currentVoiceHints = res.voice_hints || [];
    // 时光推进：在事件卡片之后、叙事之前插一条分隔，label 非字符串时不插。
    if (res.timeSkip && typeof res.timeSkip.label === 'string') {
      appendDivider('—— ' + res.timeSkip.label + '后 ——');
    }
    var narr = appendNarration(res.narration, badgesFromApplied(res.applied, res.stats_drains), sceneId);
    if (res.settlement) appendSettlementCard(res.settlement);
    renderPanel(res.state);
    fetchProfile(); // 每回合刷新跨世界玩家画像（失败静默）
    renderEventBanner(res.state.activeEvent);
    resetIdeas(res.suggestions);
    setUndoVisible(!!res.state.undoAvailable);
    if (res.death) showDeath(res.state, res.death);
    requestImages();
    if (typeof Tts !== 'undefined' && Tts.enabled() && myPrefs.tts && myPrefs.tts.auto) Tts.autoRead(narr);
    // 最终结果渲染完成：停在回合开头（行动行；无行动行则插图框/首段叙事），自动朗读时同样如此。
    var start = turnStartOr(narr.wrap);
    if (start) {
      turnStartEl = start;
      scrollToTurnStart(start);
      armTurnAlign(start);
    }
  }

  async function sendAction() {
    if (busy || !currentWorldId) return;
    if (typeof Tts !== 'undefined') Tts.stop();
    var input = $('action-input');
    var action = input.value.trim();
    if (!action) { toast('写点什么再发送吧'); return; }
    setBusy(true);
    // 撤回按钮保持原状：请求进行中由 busy 守卫拦住点击，result 到来后 renderResult 再按
    // 后端 undoAvailable 显隐；回合失败时不至于把按钮错误地卡在隐藏状态。
    showChapterForTurn(); // 叙事 v3：本回合换章时先插章名分隔
    appendActionLine(action);
    usageBeforeTurn = usageData && usageData.tokens ? usageData.tokens.total : null;
    var block = beginStreamNarration();
    try {
      var res = await streamTurn({ action: action }, block);
      input.value = ''; // 成功后才清空，失败时保留输入
      if (block.wrap.parentNode) block.wrap.parentNode.removeChild(block.wrap);
      renderResult(res);
    } catch (err) {
      // 流式失败：移除半成品叙事块，自动回退普通 /turn。
      if (block.wrap.parentNode) block.wrap.parentNode.removeChild(block.wrap);
      try {
        var fb = await api('/api/worlds/' + encodeURIComponent(currentWorldId) + '/turn', {
          method: 'POST',
          body: JSON.stringify({ action: action }),
        });
        input.value = '';
        renderResult(fb);
      } catch (err2) {
        toast(err2.message); // 输入内容不丢
      }
    } finally {
      setBusy(false);
      refreshUsage();
    }
  }

  // ---- 时光推进 ----
  // span → 中文标签，与后端 normalizeTimeSkip 的 label 一致。
  var TIME_SKIP_SPANS = [
    { value: 'month', label: '一个月' },
    { value: 'season', label: '三个月' },
    { value: 'half', label: '半年' },
    { value: 'year', label: '一年' },
  ];
  var TIME_SKIP_DEFAULT = 'year';
  var timeSkipPrevFocus = null;
  var timeSkipRadios = [];
  var timeSkipPlanInput = null;

  function timeSkipLabel(span) {
    for (var i = 0; i < TIME_SKIP_SPANS.length; i++) {
      if (TIME_SKIP_SPANS[i].value === span) return TIME_SKIP_SPANS[i].label;
    }
    return TIME_SKIP_SPANS[TIME_SKIP_SPANS.length - 1].label;
  }

  // 弹层内容只构建一次：关闭（含失败重试）后保留文本框里已写的打算。
  function renderTimeSkipPop() {
    var pop = $('timeskip-pop');
    if (pop.firstChild) return;
    pop.tabIndex = -1;
    var card = el('div', 'timeskip-card');

    var title = el('h3', '', '时光推进');
    title.id = 'timeskip-title';
    card.appendChild(title);
    card.appendChild(el('p', 'timeskip-desc',
      '一次写完这段时间里发生的事，落到之后的新场景。不满意可以撤回。'));

    var opts = el('div', 'timeskip-options');
    TIME_SKIP_SPANS.forEach(function (s) {
      var label = el('label', 'timeskip-option');
      var input = el('input');
      input.type = 'radio';
      input.name = 'timeskip-span';
      input.value = s.value;
      input.checked = (s.value === TIME_SKIP_DEFAULT);
      label.appendChild(input);
      label.appendChild(document.createTextNode(s.label));
      opts.appendChild(label);
      timeSkipRadios.push(input);
    });
    card.appendChild(opts);

    var plan = el('textarea', 'timeskip-plan');
    plan.rows = 3;
    plan.setAttribute('placeholder',
      '这段时间打算做什么？可不填，比如：闭关修炼、经营铺子、四处打听师父的下落');
    plan.setAttribute('maxlength', '200');
    card.appendChild(plan);
    timeSkipPlanInput = plan;

    var buttons = el('div', 'timeskip-buttons');
    var cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', closeTimeSkip);
    var start = el('button', 'btn primary', '开始推进');
    start.type = 'button';
    start.addEventListener('click', function () {
      var span = TIME_SKIP_DEFAULT;
      for (var i = 0; i < timeSkipRadios.length; i++) {
        if (timeSkipRadios[i].checked) { span = timeSkipRadios[i].value; break; }
      }
      sendTimeSkip(span, timeSkipPlanInput.value.trim());
    });
    buttons.appendChild(cancel);
    buttons.appendChild(start);
    card.appendChild(buttons);

    pop.appendChild(card);
    pop.addEventListener('click', function (e) { if (e.target === pop) closeTimeSkip(); });
  }

  function openTimeSkip() {
    // 主角已终 / 等待重生：只提示，不打开弹层。
    if (currentState && (currentState.awaitingRebirth
        || (currentState.character && currentState.character.alive === false))) {
      toast('本世已终，请先重生'); return;
    }
    if (busy || !currentWorldId) { toast('世界还在回应，稍等'); return; }
    var pop = $('timeskip-pop');
    if (!pop.hidden) return;
    renderTimeSkipPop();
    timeSkipPrevFocus = document.activeElement;
    pop.hidden = false;
    syncBodyScrollLock();
    pop.focus();
  }

  function closeTimeSkip() {
    var pop = $('timeskip-pop');
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    syncBodyScrollLock();
    var focusTarget = timeSkipPrevFocus && timeSkipPrevFocus.isConnected
      && timeSkipPrevFocus.getClientRects && timeSkipPrevFocus.getClientRects().length
      ? timeSkipPrevFocus : ($('g-timeskip') || $('menu-timeskip'));
    if (focusTarget && focusTarget.getClientRects && focusTarget.getClientRects().length) focusTarget.focus();
  }

  // Escape 关闭、Tab 约束在弹层内（照氛围设置弹层的做法）。
  document.addEventListener('keydown', function (e) {
    var pop = $('timeskip-pop');
    if (!pop || pop.hidden) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault(); e.stopImmediatePropagation();
      closeTimeSkip();
      return;
    }
    if (e.key !== 'Tab') return;
    var list = Array.prototype.filter.call(
      pop.querySelectorAll('button,input,textarea,select,summary'),
      function (n) { return !n.disabled && !n.hidden && (!n.getClientRects || n.getClientRects().length); }
    );
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || active === pop)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || active === pop)) { e.preventDefault(); first.focus(); }
  });

  async function sendTimeSkip(span, plan) {
    if (busy || !currentWorldId) return;
    if (typeof Tts !== 'undefined') Tts.stop();
    setBusy(true);
    // 关闭弹层露出流式叙事：失败时弹层保持关闭、文本框内容保留以便重试。
    closeTimeSkip();
    var label = timeSkipLabel(span);
    showChapterForTurn(); // 叙事 v3：本回合换章时先插章名分隔
    appendActionLine('【时光推进·' + label + '】' + (plan || '按眼下的日子过下去'));
    usageBeforeTurn = usageData && usageData.tokens ? usageData.tokens.total : null;
    var block = beginStreamNarration();
    var body = { timeSkip: { span: span, plan: plan } };
    var ok = false;
    try {
      var res = await streamTurn(body, block);
      if (block.wrap.parentNode) block.wrap.parentNode.removeChild(block.wrap);
      renderResult(res);
      ok = true;
    } catch (err) {
      // 流式失败：移除半成品叙事块，自动回退普通 /turn。
      if (block.wrap.parentNode) block.wrap.parentNode.removeChild(block.wrap);
      try {
        var fb = await api('/api/worlds/' + encodeURIComponent(currentWorldId) + '/turn', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        renderResult(fb);
        ok = true;
      } catch (err2) {
        toast(err2.message); // 失败不清空弹层文本框，重试时内容还在
      }
    } finally {
      setBusy(false);
      refreshUsage();
      if (ok && timeSkipPlanInput) timeSkipPlanInput.value = ''; // 成功才清空，失败保留以便重试
    }
    // 不动 #action-input 的内容。
  }

  // ---- 宽屏插图镜像：当前回合插图放到右侧栏最上方，历史回合在正文里留小缩略图 ----
  // DOM 归类在 JS 完成，视觉（sticky / 80px 缩略图 / 隐藏当前框）由 app.css ≥1200px 控制。
  // 镜像复用 data-scene，renderScenes 会一并填图并挂「点击放大」监听。
  function syncSceneRail() {
    var panel = $('panel');
    var rail = $('scene-rail');
    if (!rail) {
      rail = el('div', 'scene-rail');
      rail.id = 'scene-rail';
      panel.insertBefore(rail, panel.firstChild);   // 右侧栏最上方
    }
    var frames = $('stream').querySelectorAll('.scene-frame');
    for (var i = 0; i < frames.length; i++) {
      var last = (i === frames.length - 1);
      frames[i].classList.toggle('scene-current', last);
      frames[i].classList.toggle('scene-history', !last);
    }
    if (!frames.length) { rail.textContent = ''; return; }
    var key = frames[frames.length - 1].getAttribute('data-scene');
    rail.textContent = '';
    var mirror = el('div', 'scene-frame img-pending');
    mirror.setAttribute('data-scene', key);
    rail.appendChild(mirror);
    if (typeof renderScenes === 'function') renderScenes();
  }

  // ---- 电脑端翻页：输入框未聚焦时，空格 / PageDown 翻一屏（留 2 行重叠），Shift+空格 / PageUp 上翻 ----
  document.addEventListener('keydown', function (e) {
    if (window.innerWidth < 860) return;
    // 弹层（含人物档案）打开时，空格 / PageDown 不翻动背后正文。
    if (typeof anyOverlayOpen === 'function' && anyOverlayOpen()) return;
    var ai = $('action-input');
    if (ai && document.activeElement === ai) return;              // 输入框聚焦时不触发
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName))) return;
    var isSpace = (e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space');
    var dir = 0;
    if (e.key === 'PageDown' || (isSpace && !e.shiftKey)) dir = 1;
    else if (e.key === 'PageUp' || (isSpace && e.shiftKey)) dir = -1;
    else return;
    var s = $('stream');
    if (!s) return;
    var para = s.querySelector('.narration');
    var line = 28;
    if (para) {
      var lh = parseFloat(window.getComputedStyle(para).lineHeight);
      if (lh > 0) line = lh;
    }
    var delta = (s.clientHeight - line * 2) * dir;               // 留 2 行重叠
    e.preventDefault();
    s.scrollTop += delta;
  });

