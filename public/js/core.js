'use strict';
  var ATTRS = ['体魄', '心智', '魅力', '气运', '声望', '资源'];
  var PERSONA = ['冒险', '审慎', '共情', '权谋', '坚韧', '秩序'];
  var PRESETS = [
    '蒸汽朋克长安：机关兽与占星术并存，皇城地下埋着永不停歇的锅炉',
    '末日尸潮下的江南水乡：乌篷船穿行在被淹没的古镇，尸潮随潮水涨落',
    '修仙宗门外门杂役：灵田、丹房与藏经阁，一步踏错便是百年苦役',
    '深海殖民站：万米海沟下的玻璃穹顶，氧气与秘密都要省着用',
    '民国上海滩谍影：百乐门的舞曲盖过电报声，人人都有三个名字',
    '被诅咒的中世纪王国：每当钟敲十三下，就有一个人忘记自己的名字',
  ];
  // 文风预设：与后端 src/genres.js 的 GENRES / GENRE_NAMES 对应。首项 'auto' 交给模型判断，
  // 新世界页默认选中；其余 6 项为游戏页可切换的文风。全站共用这一份数据，避免两处文案漂移。
  var GENRE_OPTIONS = [
    { value: 'auto', label: '自动' },
    { value: 'xuanhuan', label: '玄幻修仙' },
    { value: 'urban', label: '都市' },
    { value: 'game', label: '游戏系统' },
    { value: 'horror', label: '恐怖悬疑' },
    { value: 'cozy', label: '休闲日常' },
    { value: 'general', label: '通用' },
  ];
  // 值 → 中文名；未识别 / 缺失返回 null，调用方回退显示「识别中」。
  function genreName(v) {
    for (var i = 0; i < GENRE_OPTIONS.length; i++) {
      if (GENRE_OPTIONS[i].value === v) return GENRE_OPTIONS[i].label;
    }
    return null;
  }
  // 属性说明卡文案：点击（或手机上轻点）顶部属性条 / 侧面板任一属性弹出。
  var ATTR_INFO = {
    '体魄': '身体与伤势，归零即本世终结',
    '心智': '洞察、学识、识破谎言',
    '魅力': '说服、结交、让人信任',
    '气运': '巧合与机缘，影响事件结算的运气',
    '声望': '世人眼中的你，影响 NPC 态度和隐藏机会',
    '资源': '钱财物资与人脉可调动的东西',
  };
  var ATTR_TIP_FOOTER = '属性上限 40，越高越难提升';
  var attrTipOpen = null; // 当前打开的属性名，null 表示未打开
  // 题材之门：首页六扇门，点击即用对应开头与文风预填新世界页。
  var HOME_DOORS = [
    { genre: 'xuanhuan', label: '玄幻修仙', glyph: '仙', img: '/assets/home/door-xuanhuan-v1.jpg', accent: '#e2c77e', seed: '修仙宗门外门杂役：灵田、丹房与藏经阁，一步踏错便是百年苦役' },
    { genre: 'urban', label: '都市', glyph: '城', img: '/assets/home/door-urban-v1.jpg', accent: '#ff8cc0', seed: '霓虹深处的超一线城市，你是刚被裁员的程序员，却在天台捡到一部能打通十年后的手机' },
    { genre: 'game', label: '游戏系统', glyph: '界', img: '/assets/home/door-game-v1.jpg', accent: '#63e3ea', seed: '末日降临那天，你眼前弹出一行字：【新手礼包已发放，请选择你的职业】' },
    { genre: 'horror', label: '恐怖悬疑', glyph: '诡', img: '/assets/home/door-horror-v1.jpg', accent: '#ff7360', seed: '被诅咒的中世纪王国：每当钟敲十三下，就有一个人忘记自己的名字' },
    { genre: 'cozy', label: '休闲日常', glyph: '闲', img: '/assets/home/door-cozy-v1.jpg', accent: '#ffc685', seed: '海边小镇的旧书店，猫比客人多，每本书里都夹着前一位读者的秘密' },
    { genre: 'general', label: '奇想', glyph: '奇', img: '/assets/home/door-general-v1.jpg', accent: '#c0aaff', seed: '深海殖民站：万米海沟下的玻璃穹顶，氧气与秘密都要省着用' },
  ];
  function homeDoorFor(genre) {
    for (var i = 0; i < HOME_DOORS.length; i++) {
      if (HOME_DOORS[i].genre === genre) return HOME_DOORS[i];
    }
    for (var j = 0; j < HOME_DOORS.length; j++) {
      if (HOME_DOORS[j].genre === 'general') return HOME_DOORS[j];
    }
    return HOME_DOORS[0];
  }

  function $(id) { return document.getElementById(id); }

  // 只用 createElement + textContent 构建 DOM，绝不把用户内容拼进 innerHTML。
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  // 游戏日显示：每 365 日算一「年」。正整数 day ≤ 365 显示「第N日」，
  // 否则换算成「第N年 第M日」；非正整数 / 非法值一律按第 1 日。
  function formatGameDay(day) {
    var d = Number(day);
    if (!Number.isFinite(d) || d < 1 || Math.floor(d) !== d) d = 1;
  if (d <= 365) return '第' + d + '日';
  return '第' + (Math.floor((d - 1) / 365) + 1) + '年 第' + ((d - 1) % 365 + 1) + '日';
}

// 相对时间：ts 为毫秒时间戳。非有限数字返回空串；越界 / 时钟误差按「刚刚」。
// now 缺省用 Date.now()；超过 30 天返回本地日期 YYYY-M-D。纯函数，便于单测。
function relTime(ts, now) {
  if (typeof ts !== 'number' || !isFinite(ts)) return '';
  var base = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var diff = base - ts;
  if (diff < 60000) return '刚刚'; // 含负数：ts 比 now 还晚（时钟误差）
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 2592000000) return Math.floor(diff / 86400000) + ' 天前';
  var d = new Date(ts);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

/* NARRATION_HELPERS_START */
  // 按空行（\n\n，中间可含空白）把叙事切成段落；纯函数，供流式实时分段。
  function splitByBlankLines(text) {
    return String(text == null ? '' : text)
      .split(/\n\s*\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  // 完整叙事分段：
  //  - 新叙事：按 \n\n 分成多个短段落；
  //  - 旧存档（没有分段的一整段长文本）：按句号/问号/叹号分句，每约 80 字合并成一段显示。
  function splitNarration(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t) return [];
    var parts = splitByBlankLines(t);
    if (parts.length >= 2) return parts;
    if (t.length <= 80) return [t];
    var sentences = t.match(/[^。？！!?\.]+[。？！!?\.]*/g) || [t];
    var out = [];
    var buf = '';
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      // 单句过长且没有句末标点：按约 80 字硬切，避免整段仍不分。
      while (s.length > 90) {
        if (buf) { out.push(buf); buf = ''; }
        out.push(s.slice(0, 80));
        s = s.slice(80);
      }
      if (buf && buf.length + s.length > 80) { out.push(buf); buf = ''; }
      buf += s;
    }
    if (buf) out.push(buf);
    return out.length ? out : [t];
  }
  /* NARRATION_HELPERS_END */

  // 把段落数组渲染进叙事块：复用已有 <p>，只改文本与增删末尾，流式追加时不闪烁。
  function renderParagraphs(wrap, paras) {
    var nodes = wrap.querySelectorAll('p.narration');
    var i;
    for (i = 0; i < paras.length; i++) {
      var node = nodes[i];
      if (!node) { node = el('p', 'narration'); wrap.appendChild(node); }
      if (node.textContent !== paras[i]) node.textContent = paras[i];
    }
    for (i = nodes.length - 1; i >= paras.length; i--) {
      wrap.removeChild(nodes[i]);
    }
  }

  // 濒死：后端公开状态带 danger:true；老数据缺该字段时按体魄 ≤ 2 兜底。
  function isDanger(s) {
    if (s && s.danger === true) return true;
    var attrs = (s && s.character && s.character.attrs) || {};
    var v = Number(attrs['体魄']);
    return Number.isFinite(v) && v <= 2;
  }

  var currentWorldId = null;
  var currentState = null;
  var busy = false;
  var toastTimer = null;
  var pendingTimer = null;
  var pendingStart = 0;
  var undoBusy = false;       // 撤回请求进行中
  var undoArmed = false;      // 撤回按钮是否处于二次确认态
  var undoArmTimer = null;
  // 当前玩家偏好：/api/me 的 prefs.scenes（默认开），用量面板据此初始化开关。
  var myPrefs = { scenes: true };
  // 朗读偏好（缺省值，/api/me 返回后由 renderPlayerInfo 覆盖）。
  myPrefs.tts = {
    narrator: 'zh-CN-Xiaoxiao:DragonHDFlashLatestNeural',
    npcDefault: { m: 'zh-CN-YunjianNeural', f: 'zh-CN-XiaoxiaoNeural', old: 'zh-CN-YunyeNeural', young: 'zh-CN-YunxiNeural' },
    npcVoices: {}, speed: 1, auto: false, enabled: true,
  };
  // 图片：/images 状态、当前世界、轮询
  var imageState = { items: {}, npcs: {}, scenes: {}, hero: {} };
  var imageWorldId = null;
  var imagePollTimer = null;
  var imagePollStart = 0;

  // ---- 网络 ----
  async function api(pathname, opts) {
    var res;
    try {
      res = await fetch(pathname, Object.assign(
        { headers: { 'Content-Type': 'application/json' } }, opts || {},
      ));
    } catch (e) {
      // 手机切后台 / 换网络时 fetch 直接抛 TypeError（Safari「Load failed」），换成看得懂的中文。
      var ne = new Error('网络断了，请检查网络后再试');
      ne.network = true;
      throw ne;
    }
    var text = await res.text();
    var data = null;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    // 未登录 / 会话失效：跳到登录页。
    if (res.status === 401 && data && data.login === true) {
      location.href = '/login.html';
      throw new Error('需要先输入访问密码');
    }
    if (!res.ok) {
      var err = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4200);
  }

  // ---- 属性说明卡 ----
  /* ATTR_TIP_HELPERS_START */
  // 纯逻辑（不依赖 DOM）：给定「当前打开的属性名」与「本次点到的属性名」，决定下一步动作。
  //   clickedName 为空（点在空白/非属性处）→ 已打开则关闭、否则不动；
  //   clickedName === openName（再点同一属性）→ 关闭；
  //   否则 → 打开/切换到该属性。
  // 返回 'hide' | 'show' | null（null 表示无需改动）。
  function attrTipAction(openName, clickedName) {
    if (!clickedName) return openName ? 'hide' : null;
    if (openName === clickedName) return 'hide';
    return 'show';
  }
  /* ATTR_TIP_HELPERS_END */

  // 从点击目标向上找带 data-attr 的元素（顶部属性条 / 侧面板属性行）。
  function closestAttr(node) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-attr')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function hideAttrTip() {
    $('attr-tip').hidden = true;
    attrTipOpen = null;
  }

  function showAttrTip(name) {
    var tip = $('attr-tip');
    tip.textContent = '';
    tip.appendChild(el('div', 'attr-tip-name', name));
    tip.appendChild(el('div', 'attr-tip-desc', ATTR_INFO[name] || ''));
    tip.appendChild(el('div', 'attr-tip-foot', ATTR_TIP_FOOTER));
    tip.hidden = false;
    attrTipOpen = name;
  }

  function onAttrClick(name) {
    if (!ATTR_INFO[name]) return;
    var action = attrTipAction(attrTipOpen, name);
    if (action === 'hide') hideAttrTip();  // 再点同一属性 → 关闭
    else if (action === 'show') showAttrTip(name);
  }

  // 全局点击：点属性 → 弹出/切换/关闭说明卡；点说明卡内部 → 保持打开；点空白 → 关闭。
  // 手机轻点同样会触发 click，故 click 与 tap 一并覆盖。
  function onDocumentClick(e) {
    var tip = $('attr-tip');
    if (tip.contains(e.target)) return; // 卡片内部（便于阅读/复制）不关闭
    var attrEl = closestAttr(e.target);
    if (attrEl) { onAttrClick(attrEl.getAttribute('data-attr')); return; }
    var action = attrTipAction(attrTipOpen, null); // 点空白 / 非属性处
    if (action === 'hide') hideAttrTip();
  }

  /* CLUE_TIP_HELPERS_START */
  // 印记 / 线索 / 传闻说明卡：新建 #clue-tip，定位与关闭方式照 #attr-tip。
  // kind: 'mark' | 'thread' | 'rumor'；turn 为出现的回合号，老数据没有时传 null（当未知）。
  var CLUE_TIP_META = {
    mark:   { title: '身上的印记', note: '会一直影响后面的剧情，直到了结' },
    thread: { title: '未解之谜',   note: '还没解开，后面会有进展' },
    rumor:  { title: '坊间传闻',   note: '真假难辨的风声' },
  };
  var CLUE_TIP_NO_TURN_HINT = '这一回合较早，往上翻翻能找到';
  var clueTipOpen = false; // 卡片是否开着（点卡片外 / Escape 关闭）

  // 纯逻辑：拼出卡片该显示的文案，不碰 DOM，便于单测。
  function clueTipContent(kind, text, turn) {
    var meta = CLUE_TIP_META[kind] || CLUE_TIP_META.thread;
    var n = (turn != null && turn !== '' && Number.isFinite(Number(turn))) ? Number(turn) : null;
    var hasTurn = n !== null;
    return {
      title: meta.title,
      body: String(text == null ? '' : text),
      note: meta.note,
      hasTurn: hasTurn,
      turn: n,
      turnText: hasTurn ? '第 ' + n + ' 回合出现' : '',
      jumpLabel: '跳到那一回合',
    };
  }

  // 纯逻辑：按是否找到目标行动行决定跳转动作。
  function clueJumpAction(foundLine) {
    return foundLine ? { found: true } : { found: false, hint: CLUE_TIP_NO_TURN_HINT };
  }

  function hideClueTip() {
    var tip = $('clue-tip');
    if (tip) tip.hidden = true;
    clueTipOpen = false;
  }

  function showClueTip(kind, text, turn) {
    var tip = $('clue-tip');
    if (!tip) return;
    var c = clueTipContent(kind, text, turn);
    tip.textContent = '';
    tip.appendChild(el('div', 'clue-tip-name', c.title));
    tip.appendChild(el('div', 'clue-tip-desc', c.body));
    tip.appendChild(el('div', 'clue-tip-note', c.note));
    if (c.hasTurn) {
      tip.appendChild(el('div', 'clue-tip-turn', c.turnText));
      var jump = el('button', 'clue-tip-jump', c.jumpLabel);
      jump.type = 'button';
      jump.setAttribute('data-clue-turn', String(c.turn));
      jump.addEventListener('click', function (e) {
        if (e.stopPropagation) e.stopPropagation();
        jumpToClueTurn(c.turn);
      });
      tip.appendChild(jump);
    }
    tip.hidden = false;
    clueTipOpen = true;
  }

  // 跳到某回合：在 #stream 里找 data-turn=N 的 .action-line，找到就滚过去并短暂高亮。
  function jumpToClueTurn(turn) {
    var tip = $('clue-tip');
    var stream = $('stream');
    var lines = stream ? stream.querySelectorAll('.action-line') : [];
    var target = null;
    for (var i = 0; i < lines.length; i++) {
      if (String(lines[i].getAttribute('data-turn')) === String(turn)) { target = lines[i]; break; }
    }
    var act = clueJumpAction(!!target);
    if (!act.found) {
      var jump = tip && tip.querySelector('.clue-tip-jump');
      if (jump && jump.parentNode) {
        jump.parentNode.replaceChild(el('div', 'clue-tip-hint', act.hint), jump);
      }
      return;
    }
    // 按回合分页：先翻到那一回合所在的页，再对齐到行动行。
    if (typeof showPageOf === 'function') showPageOf(target);
    // 电脑在 #stream 内滚、手机整页滚，复用 scrollToTurnStart。
    if (typeof scrollToTurnStart === 'function') scrollToTurnStart(target);
    target.classList.add('flash-turn');
    setTimeout(function () { target.classList.remove('flash-turn'); }, 1500);
    hideClueTip();
    // 手机：跳过去后顺手收起角色面板抽屉，别挡着正文。
    if (window.innerWidth <= 600) {
      var panel = $('panel');
      if (panel) panel.dataset.open = 'false';
      syncBodyScrollLock();
    }
  }

  // 从点击目标向上找带 data-clue 的可点条目。
  function closestClue(node) {
    while (node && node !== document) {
      if (node.getAttribute && node.getAttribute('data-clue')) return node;
      node = node.parentNode;
    }
    return null;
  }

  // 全局点击：点印记/线索/传闻 → 弹卡；点卡内 → 保持；点卡片外 → 关闭。
  function onClueDocumentClick(e) {
    var tip = $('clue-tip');
    if (tip && tip.contains(e.target)) return;
    var chip = closestClue(e.target);
    if (chip) {
      showClueTip(chip.getAttribute('data-clue-kind'),
                  chip.getAttribute('data-clue-text'),
                  chip.getAttribute('data-clue-turn'));
      return;
    }
    if (clueTipOpen) hideClueTip();
  }

  // Enter / 空格 触发（role=button 元素），Escape 关闭。
  function onClueKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') { hideClueTip(); return; }
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var chip = closestClue(e.target);
    if (!chip) return;
    if (e.preventDefault) e.preventDefault();
    showClueTip(chip.getAttribute('data-clue-kind'),
                chip.getAttribute('data-clue-text'),
                chip.getAttribute('data-clue-turn'));
  }
  /* CLUE_TIP_HELPERS_END */

  /* UNDO_HELPERS_START */
  // 纯逻辑：撤回按钮「二次确认」状态机。
  // armed=false（未确认）→ 进入确认态、不发请求；armed=true（已确认）→ 真正发起 /undo。
  function undoClickAction(armed) {
    return armed
      ? { nextArmed: false, fire: true }
      : { nextArmed: true, fire: false };
  }
  /* UNDO_HELPERS_END */

  // 手机端弹层：从实际 DOM 状态推导是否需要锁定背景滚动（各入口无需配对计数）。
  function anyOverlayOpen() {
    return ($('panel') && $('panel').dataset.open === 'true')
      || ($('usage-pop') && !$('usage-pop').hidden)
      || ($('timeskip-pop') && !$('timeskip-pop').hidden)
      || !!document.getElementById('prologue-mask')
      || !!document.getElementById('item-card-modal')
      || !!document.getElementById('turn-list-modal')
      || !!document.getElementById('npc-card-modal')
      || !!document.getElementById('atmosphere-modal')
      || !!document.getElementById('bgm-stats-modal');
  }
  function syncBodyScrollLock() {
    var locked = window.innerWidth <= 600 && anyOverlayOpen();
    document.body.style.overflow = locked ? 'hidden' : '';
  }
  // 底部弹层通用「关闭 ×」按钮：桌面隐藏，≤600px 媒体查询里显示为右上角关闭键。
  function sheetCloseButton(onClose) {
    var b = el('button', 'sheet-close', '×');
    b.type = 'button';
    b.setAttribute('aria-label', '关闭');
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      onClose();
    });
    return b;
  }

