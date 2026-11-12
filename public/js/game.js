'use strict';
  // 当前正在渲染回合的朗读提示（voice_hints），供整回合朗读按段落取音色 / 情绪 / 节奏。
  var currentVoiceHints = [];
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
  function clearStream() {
    $('stream').textContent = '';
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
      renderEventBanner(state.activeEvent);
      renderSuggestions(null);
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

  // 客户端徽章：与后端 /log 的 badges 同一种结构。
  function badgesFromApplied(applied) {
    var a = applied || {};
    var out = [];
    var diff = a.state_diff || {};
    Object.keys(diff).forEach(function (k) {
      var d = Number(diff[k]);
      if (d) out.push({ type: 'attr', name: k, delta: d });
    });
    (a.items_add || []).forEach(function (n) { out.push({ type: 'item-add', name: n }); });
    (a.items_remove || []).forEach(function (n) { out.push({ type: 'item-remove', name: n }); });
    var npc = a.npc_attitude || {};
    Object.keys(npc).forEach(function (n) {
      var d = Number(npc[n]);
      if (d) out.push({ type: 'npc', name: n, delta: d });
    });
    return out;
  }

  function makeBadge(b) {
    var s = el('span', 'badge');
    if (b.type === 'attr') {
      var up = b.delta > 0;
      s.className = 'badge ' + (up ? 'up' : 'down');
      s.textContent = b.name + ' ' + (up ? '+' + b.delta : '−' + Math.abs(b.delta));
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

  function renderSuggestions(list) {
    var box = $('suggestions');
    box.textContent = '';
    var items = (list && list.length) ? list : DEFAULT_SUGGESTIONS;
    items.slice(0, 3).forEach(function (text) {
      var b = el('button', 'suggestion', text);
      b.addEventListener('click', function () {
        $('action-input').value = text;
        $('action-input').focus();
      });
      box.appendChild(b);
    });
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
    panel.appendChild(el('h3', 'panel-title', '角色面板'));
    // 手机抽屉顶部关闭 ×（桌面隐藏，见 .sheet-close 默认 display:none）
    panel.appendChild(sheetCloseButton(function () {
      panel.dataset.open = 'false';
      syncBodyScrollLock();
    }));

    var attrs = (s.character && s.character.attrs) || {};
    var danger = isDanger(s);
    var attrSec = el('div', 'panel-section');
    attrSec.appendChild(el('h4', 'panel-h', '属性'));
    ATTRS.forEach(function (a) {
      var v = Number(attrs[a]) || 0;
      var row = el('div', 'attr-row');
      row.setAttribute('data-attr', a); // 侧面板属性行：点击弹说明卡
      row.appendChild(el('span', 'attr-name', a));
      var bar = el('div', 'attr-bar');
      var fill = el('div', 'attr-fill');
      if (a === '体魄' && danger) fill.className = 'attr-fill danger'; // 变红并闪烁
      fill.style.width = Math.min(100, (v / 40) * 100) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(el('span', 'attr-val', String(v)));
      attrSec.appendChild(row);
    });
    panel.appendChild(attrSec);

    // 随身物品：小卡片网格（64px 方图在上，物品名在下）。
    var itemsSec = el('div', 'panel-section');
    itemsSec.appendChild(el('h4', 'panel-h', '随身物品'));
    var itemGrid = el('div', 'item-grid');
    itemGrid.id = 'item-grid';
    itemsSec.appendChild(itemGrid);
    panel.appendChild(itemsSec);

    var rumors = s.rumors || [];
    var rumorSec = el('div', 'panel-section');
    rumorSec.appendChild(el('h4', 'panel-h', '坊间传闻'));
    if (rumors.length) {
      rumors.slice().reverse().forEach(function (r) {
        rumorSec.appendChild(el('div', 'rumor-item', '· ' + (r.text || '')));
      });
    } else rumorSec.appendChild(el('div', 'muted', '（尚无传闻）'));
    panel.appendChild(rumorSec);

    var marks = (s.character && s.character.marks) || [];
    var markSec = el('div', 'panel-section');
    markSec.appendChild(el('h4', 'panel-h', '身上的印记'));
    if (marks.length) marks.forEach(function (m) { markSec.appendChild(el('span', 'mark-chip', m)); });
    else markSec.appendChild(el('span', 'muted', '（尚无印记）'));
    panel.appendChild(markSec);

    var threads = s.threads || [];
    var threadSec = el('div', 'panel-section');
    threadSec.appendChild(el('h4', 'panel-h', '未解之谜'));
    if (threads.length) {
      threads.forEach(function (t) { threadSec.appendChild(el('div', 'thread-item', '· ' + t)); });
    } else threadSec.appendChild(el('div', 'muted', '（尚无未解之谜）'));
    panel.appendChild(threadSec);

    var facts = s.facts || [];
    var factChildren = facts.length
      ? facts.map(function (f) { return el('div', 'fact-item', '· ' + (f.text || '')); })
      : [el('div', 'muted', '（尚无已确立的事实）')];
    panel.appendChild(collapsible('已知的事', factChildren));

    // 主角形象：40px 圆形头像 + 「你」，放在「认识的人」上方（图由 public/js/images.js 填）。
    var heroSec = el('div', 'panel-section');
    var heroRow = el('div', 'npc-row');
    heroRow.id = 'hero-row';
    heroSec.appendChild(heroRow);
    panel.appendChild(heroSec);

    // 认识的人：每行前 40px 圆形头像 + 名字 + 态度。
    var npcSec = el('div', 'panel-section');
    npcSec.appendChild(el('h4', 'panel-h', '认识的人'));
    var npcList = el('div', 'npc-list');
    npcList.id = 'npc-list';
    npcSec.appendChild(npcList);
    panel.appendChild(npcSec);

    var persona = s.persona || {};
    var personaSec = el('div', 'panel-section');
    personaSec.appendChild(el('h4', 'panel-h', '性格画像'));
    PERSONA.forEach(function (d) {
      var v = Math.max(0, Math.min(100, Number(persona[d]) || 0));
      var row = el('div', 'persona-row');
      row.appendChild(el('span', 'persona-name', d));
      var bar = el('div', 'persona-bar');
      var fill = el('div', 'persona-fill');
      fill.style.width = v + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      personaSec.appendChild(row);
    });
    panel.appendChild(personaSec);

    var past = s.pastLives || [];
    var pastSec = el('div', 'panel-section');
    pastSec.appendChild(el('h4', 'panel-h', '前世'));
    if (past.length) {
      past.slice().reverse().forEach(function (pl) {
        var item = el('div', 'past-life-item');
        item.appendChild(el('div', 'past-life-head',
          '第' + pl.life + '世 · ' + (pl.name || '无名') + ' · ' + (pl.turns || 0) + ' 回合'));
        item.appendChild(el('div', 'past-life-epitaph', pl.epitaph || ''));
        pastSec.appendChild(item);
      });
    } else pastSec.appendChild(el('div', 'muted', '（尚无前世）'));
    panel.appendChild(pastSec);

    var chronicle = s.chronicle || [];
    var chChildren = chronicle.length
      ? chronicle.map(function (c) {
          return el('div', 'chronicle-item',
            '第' + c.chapter + '章（' + c.fromTurn + '-' + c.toTurn + '）：' + c.summary);
        })
      : [el('div', 'muted', '（尚无编年史）')];
    panel.appendChild(collapsible('编年史', chChildren));

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
    panel.appendChild(prologueBtn);

    panel.appendChild(collapsible('世界设定', wsChildren));

    renderTopAttrs(s);
    renderImages(); // 用当前 /images 状态填充物品卡片与 NPC 头像
    syncSceneRail(); // 宽屏：把当前回合插图镜像到右侧栏顶部（见 app.css ≥1200px）
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
      renderSuggestions(null);
    } catch (err) {
      toast(err.message);
    }
  }

  function updatePendingSecs() {
    var secs = Math.floor((Date.now() - pendingStart) / 1000);
    $('pending-secs').textContent = '已等待 ' + secs + ' 秒';
  }

  function setBusy(b) {
    busy = b;
    $('btn-send').disabled = b;
    $('pending').hidden = !b;
    clearInterval(pendingTimer);
    pendingTimer = null;
    if (b) {
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
    await readEventStream(res, function (event, data) {
      try {
        if (event === 'delta') {
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
    var narr = appendNarration(res.narration, badgesFromApplied(res.applied), sceneId);
    if (res.settlement) appendSettlementCard(res.settlement);
    renderPanel(res.state);
    renderEventBanner(res.state.activeEvent);
    renderSuggestions(res.suggestions);
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

