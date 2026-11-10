'use strict';
  // ---- 认识的人 / 人物档案 ----
  // 只读公共 profile 契约字段：{ id, name, displayName, aliases, portraitName,
  //   role, description, voice, publicGoal, relationshipSummary, traits,
  //   initial, firstRecord, lastRecord, lastInteraction, latestExcerpt, attitude }
  // 绝不读取 internal / original / want 等私有资料，也不把未知字段整体 JSON 化展示。
  // 资料一律走 el()/textContent；经历原文来自 GET 历史接口，前端不调用模型 / 出图 / 朗读。

  var npcSearchQuery = '';       // 搜索词：跨 renderPanel 重建、轮询重画保留
  var npcCardSeq = 0;            // 卡片世代：切世界 / 关闭 / 换人后让在途请求失效
  var currentNpcCardId = null;
  var currentNpcCardProfile = null;
  var npcCardPrevFocus = null;
  var npcSearchWorldId;          // 查询所属世界：真正换世界才清，轮询 / 重画不动

  // 只接受字符串 / 数字；对象、数组、undefined 一律当空，避免把结构 JSON 化显示。
  function npcText(v) {
    return (typeof v === 'string' || typeof v === 'number') ? String(v) : '';
  }
  // 真正换世界才清旧查询，避免新世界名单被上个世界的过滤词全部隐藏；
  // 同一世界的图片轮询 / 面板重画都保留查询。返回是否清过。
  function npcSyncSearchWorld() {
    var wid = currentWorldId;
    if (npcSearchWorldId === undefined) { npcSearchWorldId = wid; return false; }
    if (npcSearchWorldId !== wid) {
      npcSearchWorldId = wid;
      npcSearchQuery = '';
      return true;
    }
    return false;
  }
  // 0 / '0' / 缺项都当「未记载」；不拿现实时间或当前主角姓名去补旧时间。
  function npcRecorded(v) {
    var t = npcText(v);
    return !!t && Number(t) !== 0;
  }
  function npcDisplayName(p) {
    return npcText(p && p.displayName) || npcText(p && p.name) || '（无名）';
  }
  // 音色设置沿用现有 myPrefs.tts.npcVoices 的 name 键（兼容旧档）。
  function npcVoiceKey(p) { return npcText(p && p.name) || npcDisplayName(p); }
  // 头像身份：portraitName 稳定映射 imageState.npcs；旧档按 name 兜底。
  function npcPortraitKey(p) { return npcText(p && p.portraitName) || npcText(p && p.name) || npcDisplayName(p); }
  function npcClue(p) { return npcText(p && p.role) || npcText(p && p.latestExcerpt); }
  function npcLastTurn(p) {
    var r = (p && (p.lastRecord || p.lastInteraction)) || {};
    var t = Number(r.turn);
    return Number.isFinite(t) ? t : -1;
  }
  function npcHearts(a) {
    var v = Math.max(-10, Math.min(10, Number(a) || 0));
    var filled = Math.round(((v + 10) / 20) * 5);
    return '♥'.repeat(filled) + '♡'.repeat(5 - filled);
  }

  // 公共 profile 字典（按稳定 id 索引）；旧档没有时回退 npcAttitude，且不造 id。
  function npcProfilesDict() {
    var raw = currentState && currentState.npcProfiles;
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  }
  function npcListEntries() {
    var d = npcProfilesDict();
    if (d) {
      return Object.keys(d).map(function (id) {
        return { id: id, p: d[id] || {}, compat: false };
      });
    }
    var att = (currentState && currentState.npcAttitude) || {};
    return Object.keys(att).map(function (name) {
      return { id: null, p: { name: name, displayName: name, attitude: att[name] }, compat: true };
    });
  }
  // 只搜当前公共资料里的已知线索（姓名 / 身份 / 别名 / 描述 / 最近原文 / 公开关系线索），
  // 不读私有字段，也不声称历史全文检索。
  function npcSearchText(p) {
    var aliases = (p && p.aliases) || [];
    if (!Array.isArray(aliases)) aliases = [aliases];
    return [
      npcText(p && p.name), npcText(p && p.displayName), npcText(p && p.role),
      npcText(p && p.description), npcText(p && p.latestExcerpt),
      npcText(p && p.relationshipSummary), npcText(p && p.publicGoal),
    ].concat(aliases.map(npcText)).join(' ').toLowerCase();
  }
  function npcMatches(p, q) {
    if (!q) return true;
    return npcSearchText(p).indexOf(String(q).toLowerCase()) >= 0;
  }
  // 稳定排序：最近有记录的优先（回合降序），同回合按名字，轮询重画不跳动。
  function npcSortEntries(list) {
    return list.slice().sort(function (a, b) {
      var ta = npcLastTurn(a.p), tb = npcLastTurn(b.p);
      if (ta !== tb) return tb - ta;
      var na = npcDisplayName(a.p), nb = npcDisplayName(b.p);
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  }

  // ---- 搜索框：document 级委托，搜索框被重建后仍生效；只重画行，不重建输入框本身 ----
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'npc-search') {
      npcSearchQuery = e.target.value || '';
      if (typeof renderNpcList === 'function') renderNpcList();
    }
  });
  // 放大图是否是最上层：hidden=false 且已放入图片才算开着（关闭只置 hidden、不清图）。
  function npcImageViewerOpen() {
    var v = document.getElementById('image-viewer');
    return !!(v && !v.hidden && v.firstChild);
  }
  // 模态框键盘：Escape 只关最上层；Tab 约束在人物卡内；不动游戏输入 / 空格翻页。
  // 放大图（z-index 90）盖在人物卡上时，先收放大图 / 让出最上层、留住人物卡，再按一次才关卡。
  document.addEventListener('keydown', function (e) {
    var mask = document.getElementById('npc-card-modal');
    var viewerTop = npcImageViewerOpen();
    if (e.key === 'Escape' || e.key === 'Esc') {
      if (viewerTop) {
        if (typeof closeImageViewer === 'function') closeImageViewer();
        return;                                   // 本次留住人物卡
      }
      if (mask) closeNpcCard();
      return;
    }
    if (e.key === 'Tab' && mask && !viewerTop) npcCardTrapTab(mask, e);
  });
  // 焦点候选是否 CSS 可见：只排除「CSS 不可见 / 无布局盒」的元素，绝不用「在视口外」判定
  // （长卡可滚动，当前不在视口里的按钮仍应纳入循环）。真实浏览器里 display:none /
  // visibility:hidden / 闭合 details 下未渲染的控件，要么 getClientRects 为空、要么
  // computed display/visibility 为 none/hidden；测试用 fake DOM 缺少这些能力时一律视为可见，
  // 既有键盘测试照常运行。
  function npcCardVisible(n) {
    if (typeof n.getClientRects === 'function' && n.getClientRects().length === 0) return false;
    var view = document.defaultView || (typeof window !== 'undefined' ? window : null);
    if (view && typeof view.getComputedStyle === 'function') {
      var cs = view.getComputedStyle(n);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
    }
    return true;
  }
  // Tab 边界：焦点只在人物卡「实际可见」的可聚焦元素间循环，不退回背景页面。
  function npcCardTrapTab(mask, e) {
    var card = mask.querySelector('.npc-card');
    if (!card) return;
    var nodes = card.querySelectorAll('button, summary, input, select, textarea');
    var f = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.disabled && !n.hidden && npcCardVisible(n)) f.push(n);
    }
    if (!f.length) return;
    var active = document.activeElement, idx = -1;
    for (var j = 0; j < f.length; j++) if (f[j] === active) idx = j;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey) {
      if (idx <= 0) { e.preventDefault(); last.focus(); }
    } else if (idx === -1 || idx === f.length - 1) {
      e.preventDefault(); first.focus();
    }
  }

  // ---- 资料分区：缺项只给一句提示，不堆一屏空标签，不编造简介 ----
  function npcField(label, value) {
    var v = npcText(value);
    if (!v) return null;
    var row = el('div', 'npc-field');
    row.appendChild(el('span', 'npc-field-k', label));
    row.appendChild(el('span', 'npc-field-v', v));
    return row;
  }
  function npcSection(title) {
    var sec = el('section', 'npc-sec');
    sec.appendChild(el('h4', 'npc-sec-h', title));
    return sec;
  }
  function npcHint(sec, text) { sec.appendChild(el('div', 'npc-hint', text)); }

  var NPC_TRAIT_LABELS = {
    identity: '身份', appearance: '外貌', personality: '性格',
    abilities: '能力', circumstances: '处境', relationships: '关系',
  };
  // 疑似私有字段名，绝不展示（即便后端误把它放进公开变化里）。
  function npcSecretKey(k) { return /internal|original|want|secret|private|hidden/i.test(String(k)); }

  // 概况描述只比对公共 initial/current（不读私有原始字段）：和初见一致标「初见描述」，
  // 后来更新过、不同于初见标「最近描述」；模型正文一律原样保留、不改写。
  function npcDescriptionLabel(p) {
    var desc = npcText(p && p.description);
    if (!desc) return '描述';
    var ini = (p && p.initial && typeof p.initial === 'object') ? p.initial : {};
    return desc === npcText(ini.description) ? '初见描述' : '最近描述';
  }
  function npcOverviewSection(p) {
    var sec = npcSection('已知人物概况');
    var rows = [
      npcField('身份', p.role),
      npcField(npcDescriptionLabel(p), p.description),
      npcField('公开目标', p.publicGoal),
      npcField('关系', p.relationshipSummary),
      npcField('口吻', p.voice),
    ];
    var aliases = (p.aliases && Array.isArray(p.aliases)) ? p.aliases.map(npcText).filter(Boolean) : [];
    if (aliases.length) rows.unshift(npcField('别名', aliases.join('、')));
    var dn = npcText(p.displayName), nm = npcText(p.name);
    if (dn && nm && dn !== nm) rows.unshift(npcField('又称', dn));
    var added = 0;
    rows.forEach(function (r) { if (r) { sec.appendChild(r); added++; } });
    if (!added) npcHint(sec, '更多资料尚未透露，可从下方原文回看。');
    return sec;
  }

  function npcTraitsSection(p) {
    var sec = npcSection('已知特征');
    // 后续单项变化以本区当前特征与下方经历为准；初见形象完整留存在「最初记录」。
    npcHint(sec, '后续单项变化以本区的当前特征与下方经历为准；初见时的完整形象留存在「最初记录」里。');
    var traits = (p && p.traits && typeof p.traits === 'object') ? p.traits : {};
    var added = 0;
    Object.keys(NPC_TRAIT_LABELS).forEach(function (key) {
      var map = traits[key];
      if (!map || typeof map !== 'object' || Array.isArray(map)) return;
      var pairs = [];
      Object.keys(map).forEach(function (k) {
        var v = npcText(map[k]);
        if (v) pairs.push([k, v]);
      });
      if (!pairs.length) return;
      var group = el('div', 'npc-trait-group');
      group.appendChild(el('div', 'npc-trait-cat', NPC_TRAIT_LABELS[key]));
      pairs.forEach(function (kv) {
        var r = el('div', 'npc-trait');
        r.appendChild(el('span', 'npc-trait-k', kv[0]));
        r.appendChild(el('span', 'npc-trait-v', kv[1])); // 值完整可读，不在存储层裁剪
        group.appendChild(r);
      });
      sec.appendChild(group);
      added++;
    });
    if (!added) npcHint(sec, '特征尚未逐一透露，可从下方原文回看。');
    return sec;
  }

  // 经历时间：只用事件里记下的游戏日/时段/回合/当时主角世数/姓名；缺就「未记载」，
  // 绝不拿现实时间或「当前」主角姓名去猜旧时间。
  function npcAtLine(at) {
    at = (at && typeof at === 'object') ? at : {};
    var clock = (at.clock && typeof at.clock === 'object') ? at.clock : {};
    var period = npcText(clock.period);
    var bits = [];
    if (npcRecorded(clock.day)) bits.push(formatGameDay(clock.day)); // day=0 / 缺项 → 不显示第0日
    if (period) bits.push(period);
    var time = bits.length ? bits.join(' · ') : '时间未记载';
    var turn = npcText(at.turn) ? ('第' + npcText(at.turn) + '回合') : '回合未记载'; // turn=0 作为开场回合保留
    var life = npcRecorded(at.life) ? ('第' + npcText(at.life) + '世') : '世数未记载';
    var hero = npcText(at.heroName) || '姓名未记载';
    return { time: time, turn: turn, hero: life + ' · ' + hero };
  }

  function npcInitialSection(p) {
    // 默认折叠的原生 details/summary：完整资料仍留在 DOM、点标题才展开，
    // 首屏先让玩家认人，下方共同经历更容易到达。
    var sec = el('details', 'npc-sec npc-initial');
    sec.appendChild(el('summary', 'npc-sec-h npc-initial-sum', '最初记录 · 最初公开形象'));
    var ini = (p && p.initial && typeof p.initial === 'object') ? p.initial : {};
    var added = 0;
    [['身份', ini.role], ['描述', ini.description], ['口吻', ini.voice]].forEach(function (kv) {
      var r = npcField(kv[0], kv[1]);
      if (r) { sec.appendChild(r); added++; }
    });
    var it = ini.traits;
    if (it && typeof it === 'object') {
      Object.keys(NPC_TRAIT_LABELS).forEach(function (key) {
        var map = it[key];
        if (!map || typeof map !== 'object' || Array.isArray(map)) return;
        Object.keys(map).forEach(function (k) {
          var v = npcText(map[k]);
          if (!v) return;
          sec.appendChild(npcField(NPC_TRAIT_LABELS[key] + '·' + k, v));
          added++;
        });
      });
    }
    var fr = p && p.firstRecord;
    if (fr && typeof fr === 'object') {
      var line = npcAtLine(fr);
      sec.appendChild(el('div', 'npc-hint', '最初记载：' + line.time + ' · ' + line.turn + ' · ' + line.hero));
      added++;
    }
    if (!added) npcHint(sec, '最初的形象尚未透露，可从下方原文回看。');
    return sec;
  }

  // 只渲染公开变化的可读文本；数组 / 对象都取认识的字段，绝不整体序列化未知内容。
  // 数组分支同样忽略私有 scope / 路径（字段名命中 internal / original / want 等即整条跳过），
  // 与对象分支一致；后端已过滤，这里与模块注释对齐做前端防御。
  function npcChangeVisible(c) {
    var keys = [c.label, c.field, c.name, c.key, c.scope, c.path];
    for (var i = 0; i < keys.length; i++) {
      var t = npcText(keys[i]);
      if (t && npcSecretKey(t)) return false;
    }
    return true;
  }
  function renderNpcChanges(changes) {
    // 已知公共字段（traits 分类见 NPC_TRAIT_LABELS）→ 中文标签；
    // 玩家界面绝不暴露 traits.appearance / relationshipSummary 等代码路径。
    var FIELD_LABELS = {
      name: '姓名', displayName: '称号', aliases: '别名',
      role: '身份', description: '描述', voice: '口吻',
      publicGoal: '公开目标', relationshipSummary: '关系', attitude: '好感',
    };
    function label(raw) {
      var s = npcText(raw).trim();
      if (!s) return '';
      if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, s)) return FIELD_LABELS[s];
      if (s.indexOf('.') < 0) return /[\u4e00-\u9fff]/.test(s) ? s : '';
      var parts = s.split('.'), out = [];
      for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (!seg) continue;
        if (NPC_TRAIT_LABELS[seg]) { out.push(NPC_TRAIT_LABELS[seg]); continue; }
        if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, seg)) { out.push(FIELD_LABELS[seg]); continue; }
        if (/[\u4e00-\u9fff]/.test(seg)) out.push(seg); // 中文自定义标签 / 原值保留
        // traits / initial / current 等容器前缀、未知英文代码段：丢弃，不外露
      }
      return out.join('·');
    }
    // 变化值：字符串 / 有限数字（含 0）原值显示；对象 / 数组 / 空白 / 非有限数当无效。
    function value(v) {
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
      if (typeof v === 'string') return v.trim() ? v : '';
      return '';
    }
    // delta 必须是有限数或非空数值字符串；非有限 / 空白 / 其它形状返回 null。
    function finiteDelta(d) {
      if (typeof d === 'number') return Number.isFinite(d) ? d : null;
      if (typeof d === 'string' && d.trim()) {
        var n = Number(d);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    }
    var rows = [];
    function addRow(txt) {
      if (typeof txt !== 'string' || !txt.trim()) return;
      var row = el('div', 'npc-change');
      row.textContent = txt;
      rows.push(row);
    }
    function fromTo(raw, from, to) {
      var l = label(raw);
      var f = value(from), t = value(to);
      var val = (f && t) ? (f + ' → ' + t) : (t || f || '');
      if (!val) return null;            // 没有任何有效值 → 不渲染空壳
      return (l ? l + '：' : '') + val;
    }
    function delta(raw, d) {
      return (label(raw) || '好感') + ' ' + (d >= 0 ? '+' : '') + String(d);
    }
    // 对象形状：先按 from/to 显示；没有有效值再按旧格式 delta 显示，不捏造旧绝对好感值。
    function objectChange(raw, c) {
      var to = (c.to != null ? c.to : (c.value != null ? c.value : c.new));
      var txt = fromTo(raw, c.from, to);
      if (txt) { addRow(txt); return; }
      if (Object.prototype.hasOwnProperty.call(c, 'delta')) {
        var d = finiteDelta(c.delta);
        if (d !== null) addRow(delta(raw, d));
      }
      // 无有效值 / 非有限 delta / 未认识形状：不出空壳。
    }
    if (Array.isArray(changes)) {
      changes.forEach(function (c) {
        if (typeof c === 'string') {
          if (npcSecretKey(c)) return;       // 私有路径文本也不展示
          addRow(value(c));
          return;
        }
        if (c && typeof c === 'object') {
          if (!npcChangeVisible(c)) return;  // 私密过滤先执行
          objectChange(c.label || c.field || c.name || c.key, c);
        }
      });
    } else if (changes && typeof changes === 'object') {
      Object.keys(changes).forEach(function (k) {
        if (npcSecretKey(k)) return;
        var v = changes[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) objectChange(k, v);
        else addRow(fromTo(k, '', v));
      });
    } else if (npcText(changes)) {
      addRow(value(changes));
    }
    if (!rows.length) return null;
    var wrap = el('div', 'npc-hist-changes');
    wrap.appendChild(el('div', 'npc-changes-h', '公开变化'));
    rows.forEach(function (r) { wrap.appendChild(r); });
    return wrap;
  }

  // 旧记录 fallback 可能把实际在场互动也保守归进 mention，无法推断「仅」，
  // 故用中性的「相关记载」；真 interaction 仍叫相处、change 仍叫资料变化。
  var NPC_KIND = {
    interaction: { label: '相处', cls: 'interaction' },
    mention: { label: '相关记载', cls: 'mention' },
    change: { label: '资料变化', cls: 'change' },
  };
  function buildNpcHistoryItem(en) {
    en = en || {};
    var kind = NPC_KIND[en.kind] || { label: '记载', cls: 'other' };
    var item = el('details', 'npc-hist-item');
    var sum = el('summary', 'npc-hist-summary');
    sum.appendChild(el('span', 'npc-kind ' + kind.cls, kind.label));
    var at = npcAtLine(en.at);
    sum.appendChild(el('span', 'npc-hist-meta', at.time + ' · ' + at.turn));
    sum.appendChild(el('span', 'npc-hist-hero', at.hero));
    var excerpt = npcText(en.excerpt);
    if (excerpt) sum.appendChild(el('div', 'npc-hist-excerpt', excerpt));
    var action = npcText(en.action);
    if (action) sum.appendChild(el('div', 'npc-hist-action', '你：' + action));
    sum.appendChild(el('span', 'npc-hist-toggle', '展开原文 / 变化'));
    item.appendChild(sum);
    var body = el('div', 'npc-hist-body');
    var narration = npcText(en.narration);
    if (narration) body.appendChild(el('div', 'npc-hist-narration', narration)); // 完整原文
    else npcHint(body, '这一条没有留下完整原文。');
    var changes = renderNpcChanges(en.changes);
    if (changes) body.appendChild(changes);
    item.appendChild(body);
    return item;
  }

  // ---- 卡片世代校验：切世界 / 关闭 / 快速开另一人物后，旧请求不得写入新卡片 ----
  function npcCardIsCurrent(mask, id, seq, worldId) {
    return seq === npcCardSeq
      && id === currentNpcCardId
      && worldId === currentWorldId
      && !!mask && !!mask.parentNode
      && document.getElementById('npc-card-modal') === mask;
  }
  function loadNpcHistory(mask, id, before, seq, worldId) {
    var url = '/api/worlds/' + encodeURIComponent(worldId) + '/npcs/' + encodeURIComponent(id)
      + '?limit=20' + (before != null ? ('&before=' + encodeURIComponent(before)) : '');
    return api(url).then(function (data) {
      if (!npcCardIsCurrent(mask, id, seq, worldId)) return null;
      return (data && typeof data === 'object') ? data : { history: {} };
    });
  }

  // ---- 首屏 HTTP 资料：以同 id 的公共 profile 为准，缺项回退打开时的 hint，不编造 ----
  var NPC_PUBLIC_FIELDS = [
    'name', 'displayName', 'aliases', 'portraitName', 'role', 'description', 'voice',
    'publicGoal', 'relationshipSummary', 'traits', 'initial', 'firstRecord', 'lastRecord',
    'lastInteraction', 'latestExcerpt', 'attitude',
  ];
  // 返回资料必须是当前同 id 的公共 profile；没有任何认识字段时返回 null（不重画、不抖动）。
  function npcProfileFromHttp(hint, prof, id) {
    if (!prof || typeof prof !== 'object' || Array.isArray(prof)) return null;
    var pid = npcText(prof.id);
    if (pid && pid !== npcText(id)) return null;          // 非同 id 资料不采用
    var out = {}, used = 0;
    NPC_PUBLIC_FIELDS.forEach(function (f) {
      if (Object.prototype.hasOwnProperty.call(prof, f) && prof[f] !== undefined) {
        out[f] = prof[f]; used++;
      } else if (hint && hint[f] !== undefined) out[f] = hint[f];
    });
    return used ? out : null;
  }

  function openNpcCard(id, profileHint) {
    var old = document.getElementById('npc-card-modal');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    npcCardSeq++;
    var seq = npcCardSeq;
    var worldId = currentWorldId;
    currentNpcCardId = id;
    var d = npcProfilesDict();
    var p = profileHint || (d && d[id]) || null;
    if (!p) p = { name: npcText(id) || '（无名）', displayName: npcText(id) || '（无名）' };
    currentNpcCardProfile = p;
    npcCardPrevFocus = document.activeElement;

    var mask = el('div', 'npc-card-mask');
    mask.id = 'npc-card-modal';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-labelledby', 'npc-card-title'); // 可访问名称跟随标题
    mask.setAttribute('tabindex', '-1');                  // 初始焦点落容器，不误触发按钮
    var card = el('div', 'npc-card');

    var head = el('div', 'npc-card-head');
    var heroSlot = el('div', 'npc-card-hero-slot');
    head.appendChild(heroSlot);
    var headMeta = el('div', 'npc-card-head-meta');
    var titleEl = el('div', 'npc-card-title', npcDisplayName(p));
    titleEl.id = 'npc-card-title';
    headMeta.appendChild(titleEl);
    var roleEl = el('div', 'npc-card-role');
    var role0 = npcText(p.role);
    if (role0) roleEl.textContent = role0; else roleEl.hidden = true;
    headMeta.appendChild(roleEl);
    var attitudeEl = el('div', 'npc-card-attitude', npcHearts(p.attitude));
    headMeta.appendChild(attitudeEl);
    head.appendChild(headMeta);
    card.appendChild(head);

    var overviewSec = npcOverviewSection(p);
    var traitsSec = npcTraitsSection(p);
    var initialSec = npcInitialSection(p);
    card.appendChild(overviewSec);
    card.appendChild(traitsSec);
    card.appendChild(initialSec);

    // 首屏 HTTP 同 id 资料到位：只原位换三块资料 + 标题文字 + 头像引用，
    // 不重建卡片、不碰已展开历史 / 滚动 / 焦点；后续翻页不再重画资料区。
    function applyHttpProfile(prof) {
      if (!npcCardIsCurrent(mask, id, seq, worldId)) return;
      var eff = npcProfileFromHttp(p, prof, id);
      if (!eff) return;
      currentNpcCardProfile = eff;
      titleEl.textContent = npcDisplayName(eff);
      var r = npcText(eff.role);
      if (r) { roleEl.textContent = r; roleEl.hidden = false; }
      else { roleEl.textContent = ''; roleEl.hidden = true; }
      attitudeEl.textContent = npcHearts(eff.attitude);
      var initialWasOpen = !!initialSec.open;          // 沿用最初记录既有展开状态
      var focusInInitial = initialSec.contains(document.activeElement);
      var builds = [npcOverviewSection, npcTraitsSection, npcInitialSection];
      var olds = [overviewSec, traitsSec, initialSec];
      var fresh = [];
      for (var i = 0; i < olds.length; i++) {
        var node = builds[i](eff);
        if (i === 2) node.open = initialWasOpen;        // 不重置已展开的最初记录
        card.insertBefore(node, olds[i]);
        card.removeChild(olds[i]);
        fresh.push(node);
      }
      overviewSec = fresh[0]; traitsSec = fresh[1]; initialSec = fresh[2];
      if (focusInInitial) {                             // 焦点原本在最初记录 → 落到新标题
        var sum = fresh[2].querySelector('summary');
        if (sum && sum.focus) sum.focus();
      }
      refreshNpcCardPortrait(); // 按 eff.portraitName 刷新头像引用
    }

    var histSec = el('section', 'npc-sec');
    histSec.appendChild(el('h4', 'npc-sec-h', '出场与共同经历'));
    var histWrap = el('div', 'npc-history');
    histWrap.appendChild(el('div', 'npc-hint', '读取中…'));
    histSec.appendChild(histWrap);
    var moreBtn = el('button', 'btn npc-more-btn', '加载更多');
    moreBtn.type = 'button';
    moreBtn.hidden = true;
    histSec.appendChild(moreBtn);
    card.appendChild(histSec);

    var state = { before: null, loading: false };
    function loadPage(before) {
      if (state.loading) return;
      state.loading = true;
      moreBtn.disabled = true;
      loadNpcHistory(mask, id, before, seq, worldId).then(function (data) {
        state.loading = false;
        if (!data || !npcCardIsCurrent(mask, id, seq, worldId)) return;
        if (before == null) applyHttpProfile(data.profile); // 仅首屏用 HTTP 资料，避免后续翻页抖动
        var hist = (data && data.history) || {};
        var entries = Array.isArray(hist.entries) ? hist.entries : [];
        if (before == null) histWrap.textContent = ''; // 首屏清掉「读取中…」
        entries.forEach(function (en) { histWrap.appendChild(buildNpcHistoryItem(en)); });
        if (!histWrap.childNodes.length) npcHint(histWrap, '还没有可回看的共同经历。');
        var more = !!hist.hasMore && hist.nextCursor != null && Number(hist.nextCursor) >= 0;
        moreBtn.hidden = !more;
        moreBtn.disabled = false;
        state.before = more ? hist.nextCursor : null;
      }).catch(function () {
        state.loading = false;
        if (!npcCardIsCurrent(mask, id, seq, worldId)) return;
        moreBtn.disabled = false;
        if (before == null) {
          histWrap.textContent = '';
          npcHint(histWrap, '经历暂时读不到，可以稍后再试。');
        }
      });
    }
    moreBtn.addEventListener('click', function () {
      if (!moreBtn.hidden && state.before != null && !state.loading) loadPage(state.before);
    });

    var closeBtn = el('button', 'btn npc-card-close', '关闭');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', function () { closeNpcCard(); });
    card.appendChild(closeBtn);
    card.appendChild(sheetCloseButton(function () { closeNpcCard(); })); // 手机右上 ×
    mask.addEventListener('click', function (e) { if (e.target === mask) closeNpcCard(); });
    mask.appendChild(card);
    document.body.appendChild(mask);

    refreshNpcCardPortrait(); // pending / 失败用首字占位，ready 后可再刷新
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    mask.focus();             // 初始焦点移入模态框，Tab 不再留在背景

    // 旧档只有 npcAttitude：没有稳定 id，不造 id 去请求接口。
    if (!id || !worldId) {
      histWrap.textContent = '';
      npcHint(histWrap, '这人的更多经历尚未被记录下来。');
      return mask;
    }
    loadPage(null);
    return mask;
  }

  // 关闭后恢复有效焦点：行被轮询 / 重画重建时，找当前同 NPC 的打开按钮，再退到搜索框。
  function npcCardRestoreTarget(id) {
    if (id) {
      var btns = document.querySelectorAll('.npc-open');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('data-npc-id') === npcText(id)) return btns[i];
      }
    }
    var search = document.getElementById('npc-search');
    if (search && search.isConnected) return search;
    return null;
  }
  function closeNpcCard() {
    var mask = document.getElementById('npc-card-modal');
    if (!mask) return;
    var hadFocusInside = mask.contains(document.activeElement);
    var id = currentNpcCardId;
    if (mask.parentNode) mask.parentNode.removeChild(mask);
    currentNpcCardId = null;
    currentNpcCardProfile = null;
    npcCardSeq++; // 让在途请求失效
    if (typeof syncBodyScrollLock === 'function') syncBodyScrollLock();
    var prev = npcCardPrevFocus;
    var target = (prev && prev.focus && prev.isConnected) ? prev : npcCardRestoreTarget(id);
    if ((hadFocusInside || prev) && target && target.focus && target.isConnected) {
      try { target.focus(); } catch (_) { /* 焦点恢复失败可忽略 */ }
    }
    npcCardPrevFocus = null;
  }

  // 图片就绪后只替换卡片里的头像节点：不重置已展开历史 / 滚动 / 焦点，不重画列表。
  // 状态键含 portraitKey：首屏资料改了 portraitName / 名字时，占位首字也按新资料刷新。
  function npcPortraitStateKey(p, info) {
    var st = info && info.status;
    return npcPortraitKey(p) + '|' + (st || 'none') + '|' + ((info && info.url) || '');
  }
  function refreshNpcCardPortrait() {
    var mask = document.getElementById('npc-card-modal');
    if (!mask || !currentNpcCardProfile) return;
    var slot = mask.querySelector('.npc-card-hero-slot');
    if (!slot) return;
    var p = currentNpcCardProfile;
    var info = imageState.npcs[npcPortraitKey(p)];
    var key = npcPortraitStateKey(p, info);
    if (slot.getAttribute('data-portrait-state') === key) return; // 无变化就不碰 DOM
    slot.setAttribute('data-portrait-state', key);
    slot.textContent = '';
    slot.appendChild(makeImageVisual(npcDisplayName(p), info, 'npc-card-hero'));
  }
