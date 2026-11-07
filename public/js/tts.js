'use strict';
// 朗读：每回合一个「▶ 朗读」按钮，点一下整回合按段落顺序排队播放；
// 底部播放条（暂停/继续、停止、下一段、第 x/y 段）、段落高亮、轻柔跟随滚动、
// 预取下一段、Azure / 浏览器 speechSynthesis 兜底、自动朗读新回合、朗读功能总开关。
// 只用 createElement + textContent 构建 DOM，绝不拼接 HTML 字符串。

var FRONT_TTS_DEFAULT = {
  narrator: 'zh-CN-YunxiNeural',
  npcDefault: { m: 'zh-CN-YunjianNeural', f: 'zh-CN-XiaoxiaoNeural', old: 'zh-CN-YunyeNeural', young: 'zh-CN-YunxiNeural' },
  npcVoices: {}, speed: 1, auto: false, enabled: true,
};

var Tts = (function () {
  var gen = 0;               // 每次停止 / 换段 / 换回合自增，作废旧异步回调
  var currentAudio = null;   // 当前 Azure audio/mpeg 的 <audio>
  var S = null;              // 当前播放会话 { turn, index, paused, prefetch, follow, preview }
  var barEl = null;          // 底部播放条 DOM
  var settingsBody = null;   // 朗读设置里「其余项」容器（总开关关闭时隐藏）
  var lastManualScroll = 0;  // 最近一次手动滚动时间
  var programmaticUntil = 0; // 程序触发滚动的忽略窗口
  var fallbackToasted = false;
  var voicesData = null;
  var voicesLoading = false;
  var voicesCallbacks = [];

  function clampSpeed(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 1;
    return Math.max(0.5, Math.min(2, n));
  }

  function getTts() {
    return (typeof myPrefs !== 'undefined' && myPrefs && myPrefs.tts) ? myPrefs.tts : FRONT_TTS_DEFAULT;
  }

  // 朗读功能总开关：默认 true（enabled 未定义或非法值都视为开），仅显式 false 关闭。
  function ttsEnabled() { return getTts().enabled !== false; }

  // 当前回合是否成人内容：公开状态带 adult 标记，由 renderResult 写入全局 currentState。
  function adultTurnActive() {
    return typeof currentState !== 'undefined' && currentState !== null && currentState.adult === true;
  }

  // 关掉总开关时隐藏所有朗读按钮 / 播放条；用 body 上的类，重开即恢复（无需重渲染）。
  function syncVisibility() {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.classList.toggle('tts-disabled', !ttsEnabled());
  }

  // 记录一次程序触发的滚动：随后一小段时间内的 scroll 事件不算「用户手动滚动」。
  function noteProgrammaticScroll(ms) {
    programmaticUntil = Date.now() + (ms || 900);
  }

  function markUserScroll(ev) {
    if (ev && ev.type === 'scroll' && Date.now() < programmaticUntil) return;
    lastManualScroll = Date.now();
    if (S) S.follow = false;   // 用户一滚动，本回合不再跟随，直到下一回合
  }
  ['scroll', 'wheel', 'touchmove'].forEach(function (ev) {
    window.addEventListener(ev, markUserScroll, { passive: true });
  });

  function hashName(s) {
    var h = 0;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  // speaker 的 NPC 音色：优先点名指定，否则按名字 hash 在「男女老少」四个默认音色里固定挑一个。
  function npcVoiceFor(name) {
    var t = getTts();
    if (t.npcVoices && t.npcVoices[name]) return t.npcVoices[name];
    var keys = ['m', 'f', 'old', 'young'];
    var key = keys[hashName(name) % keys.length];
    return (t.npcDefault && t.npcDefault[key]) || t.narrator;
  }

  function paramsForParagraph(hints, i) {
    var t = getTts();
    var hint = null;
    if (hints && hints.length) {
      for (var k = 0; k < hints.length; k++) {
        if (hints[k] && hints[k].para === i) { hint = hints[k]; break; }
      }
    }
    var voice = t.narrator;
    if (hint && hint.speaker) voice = npcVoiceFor(hint.speaker);
    return {
      voice: voice,
      mood: (hint && hint.mood) || 'calm',
      pace: (hint && hint.pace) || 'normal',
      speed: t.speed,
    };
  }

  function notifyFallback(reason) {
    if (fallbackToasted) return;
    fallbackToasted = true;
    if (typeof toast === 'function') toast(reason || '朗读服务不可用，已改用浏览器朗读');
  }

  function paraEls(turn) {
    return (turn && turn.wrap) ? turn.wrap.querySelectorAll('p.narration') : [];
  }

  // 高亮当前段：淡底色 + 左侧细竖线，其余段取消高亮。
  function setHighlight(sess) {
    var prev = document.querySelectorAll('p.narration.tts-speaking');
    for (var j = 0; j < prev.length; j++) prev[j].classList.remove('tts-speaking');
    if (!sess) return;
    var ps = paraEls(sess.turn);
    if (ps[sess.index]) ps[sess.index].classList.add('tts-speaking');
  }

  function inViewport(node) {
    var r = node.getBoundingClientRect();
    var h = window.innerHeight || document.documentElement.clientHeight;
    return r.top >= 0 && r.bottom <= h;
  }

  // 不强行滚动：仅当本回合允许跟随、最近 5 秒无手动滚动、当前段不在视区内时，
  // 才用 scrollIntoView({block:'nearest',behavior:'smooth'}) 轻柔跟随。
  function followTo(node) {
    if (!S || !S.follow) return;
    if (Date.now() - lastManualScroll < 5000) return;
    if (!node || inViewport(node)) return;
    noteProgrammaticScroll(1000);
    try { node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
  }

  // ---- 底部播放条：暂停/继续、停止、下一段、第 x/y 段 ----
  function ensureBar() {
    if (barEl) return barEl;
    var bar = el('div', 'tts-player-bar');
    bar.id = 'tts-player-bar';
    bar.hidden = true;
    function mk(label, act, aria) {
      var b = el('button', 'tts-bar-btn', label);
      b.type = 'button';
      b.setAttribute('data-act', act);
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', function () {
        if (act === 'toggle') togglePause();
        else if (act === 'stop') stop();
        else if (act === 'next') playNext();
      });
      return b;
    }
    bar.appendChild(mk('暂停', 'toggle', '暂停或继续'));
    bar.appendChild(mk('停止', 'stop', '停止朗读'));
    bar.appendChild(mk('下一段', 'next', '下一段'));
    bar.appendChild(el('span', 'tts-bar-count', '第 1/1 段'));
    var composer = document.querySelector('.composer');
    if (composer) composer.insertBefore(bar, composer.firstChild);
    else document.body.appendChild(bar);
    barEl = bar;
    return bar;
  }

  function updateBar() {
    if (!barEl) return;
    if (!S || S.preview) { barEl.hidden = true; return; }
    barEl.hidden = false;
    var cnt = barEl.querySelector('.tts-bar-count');
    if (cnt) cnt.textContent = '第 ' + (S.index + 1) + '/' + S.turn.paras.length + ' 段';
    var tg = barEl.querySelector('[data-act="toggle"]');
    if (tg) tg.textContent = S.paused ? '继续' : '暂停';
  }

  function updateTurnButtons() {
    var all = document.querySelectorAll('.tts-read-btn');
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      var active = !!(S && S.turn.btn === b);
      if (active) {
        b.textContent = S.paused ? '▶ 继续' : '❚❚ 暂停';
        b.setAttribute('aria-label', S.paused ? '继续朗读' : '暂停朗读');
      } else {
        b.textContent = '▶ 朗读';
        b.setAttribute('aria-label', '朗读这一回合');
      }
      b.classList.toggle('tts-playing', active && !S.paused);
    }
  }

  function refreshUI() { updateTurnButtons(); updateBar(); }

  // 播放一段：成人（18+）回合只走浏览器 speechSynthesis，绝不把成人内容发到 /api/tts；
  // 其余走 Azure（命中预取或请求 /api/tts）。成人判定分支在服务端朗读请求之前。
  function speak(sess, text, params) {
    var adult = sess.turn.adult;
    if (adult === undefined ? adultTurnActive() : adult === true) {
      browserSpeak(sess, text, params, null);
      return;
    }
    azurePlay(sess, text, params, sess.index);
  }

  // 取一段 Azure 音频：成功返回 blob URL；失败返回 null（调用方改走浏览器兜底）；
  // gen 已变返回 'ABORT'（作废旧回合的异步请求，关闭总开关后不请求音频）。
  async function fetchAudioBlob(text, params, myGen, silent) {
    var res;
    try {
      res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text, voice: params.voice, mood: params.mood, pace: params.pace, speed: params.speed,
        }),
      });
    } catch (_) { return null; }
    if (myGen !== gen) return 'ABORT';
    if (!res.ok) {
      var reason = '';
      try { var j = await res.json(); reason = (j && j.error) || ''; } catch (_) {}
      if (myGen !== gen) return 'ABORT';
      if (!silent) notifyFallback(reason);
      return null;
    }
    var blob;
    try { blob = await res.blob(); } catch (_) { return null; }
    if (myGen !== gen) return 'ABORT';
    try { return URL.createObjectURL(blob); } catch (_) { return null; }
  }

  function revoke(url) {
    if (typeof url === 'string' && url !== 'ABORT') { try { URL.revokeObjectURL(url); } catch (_) {} }
  }

  // 浏览器兜底 / 成人回合：逐段 speak，onend 接下一段（onParagraphEnd → playCurrent）。
  function browserSpeak(sess, text, params, reason) {
    if (reason !== undefined && reason !== null) notifyFallback(reason);
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      if (sess && S === sess) onParagraphEnd(sess);
      return;
    }
    try {
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = clampSpeed(params.speed);
      var fired = false;
      function fin() {
        if (fired) return; fired = true;
        if (sess && S === sess) onParagraphEnd(sess);
      }
      u.onend = fin;
      u.onerror = fin;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (_) {
      if (sess && S === sess) onParagraphEnd(sess);
    }
  }

  function startAudio(sess, url, text, params) {
    var audio;
    try { audio = new Audio(url); } catch (_) {
      revoke(url); browserSpeak(sess, text, params, ''); return;
    }
    currentAudio = audio;
    var ended = false;
    function cleanup() { if (ended) return; ended = true; revoke(url); }
    audio.onended = function () {
      cleanup();
      if (S === sess) { currentAudio = null; onParagraphEnd(sess); }
    };
    audio.onerror = function () {
      cleanup();
      if (S === sess) { currentAudio = null; browserSpeak(sess, text, params, ''); }
    };
    if (!sess.paused) {
      try {
        var p = audio.play();
        if (p && p.catch) p.catch(function () {
          if (!ended && S === sess) { cleanup(); currentAudio = null; browserSpeak(sess, text, params, ''); }
        });
      } catch (_) {
        if (!ended && S === sess) { cleanup(); currentAudio = null; browserSpeak(sess, text, params, ''); }
      }
    }
  }

  // 播放当前段：命中预取则直接用，否则请求 /api/tts；失败退回浏览器。
  function azurePlay(sess, text, params, i) {
    if (sess.prefetch && sess.prefetch.index === i && sess.prefetch.url) {
      var u = sess.prefetch.url;
      sess.prefetch = null;
      startAudio(sess, u, text, params);
      return;
    }
    var myGen = gen;
    fetchAudioBlob(text, params, myGen, false).then(function (url) {
      if (S !== sess || myGen !== gen) { revoke(url); return; }
      if (!url || url === 'ABORT') {
        if (url === null) browserSpeak(sess, text, params, '');
        return;
      }
      startAudio(sess, url, text, params);
    });
  }

  // 播放当前段的同时预取下一段音频（仅 Azure、非成人、总开关开启）。
  function prefetchNext(sess) {
    if (!ttsEnabled() || sess.turn.adult) return;
    var next = sess.index + 1;
    if (next >= sess.turn.paras.length) return;
    if (sess.prefetch && sess.prefetch.index === next) return;
    var myGen = gen;
    fetchAudioBlob(sess.turn.paras[next], paramsForParagraph(sess.turn.hints, next), myGen, true)
      .then(function (url) {
        if (S !== sess || myGen !== gen || !url || url === 'ABORT') { revoke(url); return; }
        sess.prefetch = { index: next, url: url };
      });
  }

  function playCurrent(sess) {
    if (S !== sess || sess.paused) return;
    var i = sess.index;
    var text = sess.turn.paras[i];
    setHighlight(sess);
    followTo(paraEls(sess.turn)[i]);
    refreshUI();
    if (text == null) { onParagraphEnd(sess); return; }
    var params = sess.turn.previewParams || paramsForParagraph(sess.turn.hints, i);
    speak(sess, text, params);
    prefetchNext(sess); // 预取下一段，减少段间停顿
  }

  function onParagraphEnd(sess) {
    if (S !== sess) return;
    if (sess.index + 1 < sess.turn.paras.length) {
      sess.index += 1;
      playCurrent(sess);
    } else {
      stop(); // 播完自动收起播放条
    }
  }

  // 整回合开始：从第一段读到最后一段，按段落顺序排队；再点变暂停 / 继续。
  function startTurn(turn) {
    if (!ttsEnabled()) return;             // 总开关关闭：不播放、不预取、不请求音频
    if (!turn || !turn.paras || !turn.paras.length) return;
    stop();
    gen++;
    S = { turn: turn, index: 0, paused: false, prefetch: null, follow: true, preview: !!turn.preview };
    ensureBar();
    playCurrent(S);
  }

  function togglePause() {
    if (!S) return;
    if (S.paused) {
      S.paused = false;
      if (currentAudio) { try { var p = currentAudio.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {} }
      else { try { if (window.speechSynthesis) window.speechSynthesis.resume(); } catch (_) {} }
    } else {
      S.paused = true;
      if (currentAudio) { try { currentAudio.pause(); } catch (_) {} }
      try { if (window.speechSynthesis) window.speechSynthesis.pause(); } catch (_) {}
    }
    refreshUI();
  }

  function playNext() {
    if (!S) return;
    gen++;                                  // 作废当前段 / 旧预取的异步回调
    if (currentAudio) { try { currentAudio.pause(); } catch (_) {} currentAudio = null; }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
    if (S.prefetch) { revoke(S.prefetch.url); S.prefetch = null; }
    S.paused = false;
    if (S.index + 1 < S.turn.paras.length) {
      S.index += 1;
      playCurrent(S);
    } else {
      stop();
    }
  }

  // 整体停止：点「停止」、发送新行动、切换世界、离开页面、关闭总开关时调用。
  function stop() {
    gen++;
    if (currentAudio) { try { currentAudio.pause(); } catch (_) {} currentAudio = null; }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
    if (S && S.prefetch) revoke(S.prefetch.url);
    S = null;
    setHighlight(null);
    refreshUI();                            // 收起播放条、复位所有朗读按钮
  }

  // 自动朗读新回合：开启时整回合播放；发送下一回合时由 game.js 的 Tts.stop() 停掉上一回合。
  function autoRead(narr) {
    if (!ttsEnabled() || !narr || !narr.turn) return;
    startTurn(narr.turn);
  }

  // 每回合叙事块顶部的一个「▶ 朗读」按钮；再点暂停 / 继续。
  function makeTurnButton(turn) {
    turn.adult = adultTurnActive(); // 创建时记住本回合是否成人内容（规则不变）
    var b = el('button', 'tts-read-btn', '▶ 朗读');
    b.type = 'button';
    b.setAttribute('aria-label', '朗读这一回合');
    b.addEventListener('click', function () {
      if (S && S.turn === turn) togglePause();
      else startTurn(turn);
    });
    syncVisibility();
    return b;
  }

  // 一次性试读（设置里的「试听」/ NPC 音色预览）：不走整回合，不显示播放条。
  function previewVoice(text, voice) {
    startTurn({
      wrap: null, paras: [text], hints: [], adult: false, btn: null, preview: true,
      previewParams: { voice: voice, mood: 'calm', pace: 'normal', speed: getTts().speed },
    });
  }

  // ---- 用量面板里的朗读设置 ----
  function ensureVoices(cb) {
    if (voicesData) { cb(voicesData); return; }
    voicesCallbacks.push(cb);
    if (voicesLoading) return;
    voicesLoading = true;
    fetch('/api/tts/voices').then(function (r) { return r.json(); }).catch(function () { return {}; }).then(function (j) {
      voicesData = j || {};
      voicesLoading = false;
      var cbs = voicesCallbacks.slice(); voicesCallbacks = [];
      cbs.forEach(function (f) { f(voicesData); });
    });
  }

  // 音色显示名：友好中文，附性别 / 年龄；缺失的字段省略对应部分。
  var GENDER_LABEL = { m: '男', f: '女' };
  var AGE_LABEL = { child: '童声', young: '青年', adult: '成年', old: '老年' };
  function voiceLabel(v) {
    var parts = [];
    if (v) {
      if (GENDER_LABEL[v.gender]) parts.push(GENDER_LABEL[v.gender]);
      if (AGE_LABEL[v.age]) parts.push(AGE_LABEL[v.age]);
    }
    var name = (v && v.name) || '';
    return parts.length ? name + '（' + parts.join('·') + '）' : name;
  }

  // 供角色面板复用：拿到 /api/tts/voices 的音色数组（内部已缓存）。
  function withVoices(cb) {
    ensureVoices(function (d) { cb((d && d.voices) || []); });
  }

  function makeSelect(voices, currentId) {
    var s = el('select', 'tts-select');
    var list = voices && voices.length ? voices : [{ id: currentId, name: '默认' }];
    list.forEach(function (v) {
      var o = el('option', null, voiceLabel(v));
      o.value = v.id;
      s.appendChild(o);
    });
    s.value = currentId;
    return s;
  }

  function saveTts(partial, revertFn) {
    var merged = Object.assign({}, getTts(), partial);
    api('/api/prefs', { method: 'POST', body: JSON.stringify({ tts: merged }) })
      .then(function (r) {
        var saved = (r && r.prefs && r.prefs.tts) || merged;
        if (!myPrefs.tts) myPrefs.tts = {};
        var cur = myPrefs.tts;
        Object.keys(cur).forEach(function (k) { delete cur[k]; });
        Object.assign(cur, saved);
      })
      .catch(function (err) {
        if (revertFn) revertFn();
        if (typeof toast === 'function') toast((err && err.message) || '朗读设置保存失败');
      });
  }

  function applyEnabledVisibility() {
    if (settingsBody) settingsBody.hidden = !ttsEnabled();
    syncVisibility();
  }

  function fillTtsSettings(sec, d) {
    sec.textContent = '';
    var t = getTts();
    var voices = (voicesData && voicesData.voices) || [];
    sec.appendChild(el('h4', null, '朗读'));

    // 朗读功能总开关（最上面）：每人保存在 prefs.tts.enabled，默认 true。
    var masterRow = el('label', 'usage-friend-row tts-master-row');
    var masterCb = el('input');
    masterCb.type = 'checkbox';
    masterCb.checked = t.enabled !== false;
    masterRow.appendChild(masterCb);
    masterRow.appendChild(el('span', '', '朗读功能'));
    masterCb.addEventListener('change', function () {
      var wanted = masterCb.checked;
      t.enabled = wanted;
      if (!wanted) stop();          // 关闭：停止朗读、收起播放条、不预取不请求
      applyEnabledVisibility();
      saveTts({ enabled: wanted }, function () {
        t.enabled = !wanted; masterCb.checked = !wanted;
        applyEnabledVisibility();
      });
    });
    sec.appendChild(masterRow);

    // 其余设置项：总开关关闭时整体隐藏。
    var body = el('div', 'tts-settings-body');
    settingsBody = body;

    // 自动朗读开关
    var autoRow = el('label', 'usage-friend-row');
    var autoCb = el('input');
    autoCb.type = 'checkbox';
    autoCb.checked = !!t.auto;
    autoRow.appendChild(autoCb);
    autoRow.appendChild(el('span', '', '自动朗读新回合'));
    autoCb.addEventListener('change', function () {
      var wanted = autoCb.checked;
      t.auto = wanted;
      saveTts({ auto: wanted }, function () { t.auto = !wanted; autoCb.checked = !wanted; });
    });
    body.appendChild(autoRow);

    // 旁白音色
    var narRow = el('div', 'usage-friend-row');
    narRow.appendChild(el('span', 'usage-friend-label', '旁白音色'));
    var narSel = makeSelect(voices, t.narrator);
    narRow.appendChild(narSel);
    narSel.addEventListener('change', function () {
      var old = t.narrator, wanted = narSel.value;
      t.narrator = wanted;
      saveTts({ narrator: wanted }, function () { t.narrator = old; narSel.value = old; });
    });
    body.appendChild(narRow);

    // NPC 默认音色：男 / 女 / 老人 / 少年
    [['m', '男'], ['f', '女'], ['old', '老人'], ['young', '少年']].forEach(function (pair) {
      var key = pair[0];
      var row = el('div', 'usage-friend-row');
      row.appendChild(el('span', 'usage-friend-label', 'NPC·' + pair[1]));
      var s = makeSelect(voices, (t.npcDefault && t.npcDefault[key]) || t.narrator);
      row.appendChild(s);
      s.addEventListener('change', function () {
        var old = (t.npcDefault && t.npcDefault[key]) || t.narrator;
        var wanted = s.value;
        var patch = { npcDefault: Object.assign({}, t.npcDefault) };
        patch.npcDefault[key] = wanted;
        t.npcDefault = patch.npcDefault;
        saveTts(patch, function () {
          var rev = Object.assign({}, t.npcDefault); rev[key] = old;
          t.npcDefault = rev; s.value = old;
        });
      });
      body.appendChild(row);
    });

    // 语速滑块 0.5~2.0
    var spRow = el('div', 'usage-friend-row');
    spRow.appendChild(el('span', 'usage-friend-label', '语速'));
    var slider = el('input', 'tts-slider');
    slider.type = 'range';
    slider.min = '0.5'; slider.max = '2'; slider.step = '0.1';
    slider.value = String(clampSpeed(t.speed));
    var spVal = el('span', 'tts-speed-val', clampSpeed(t.speed).toFixed(1));
    spRow.appendChild(slider);
    spRow.appendChild(spVal);
    slider.addEventListener('input', function () { spVal.textContent = Number(slider.value).toFixed(1); });
    slider.addEventListener('change', function () {
      var old = t.speed, wanted = clampSpeed(slider.value);
      t.speed = wanted;
      saveTts({ speed: wanted }, function () {
        t.speed = old; slider.value = String(clampSpeed(old)); spVal.textContent = clampSpeed(old).toFixed(1);
      });
    });
    body.appendChild(spRow);

    // 试听
    var tryRow = el('div', 'usage-friend-row');
    var tryBtn = el('button', 'btn tiny', '试听');
    tryBtn.type = 'button';
    tryBtn.addEventListener('click', function () {
      previewVoice('夜色渐深，远处的钟声又一次响起。', t.narrator);
    });
    tryRow.appendChild(tryBtn);
    body.appendChild(tryRow);

    // 本月已用 / 500000
    var month = voicesData && voicesData.month;
    var used = month ? month.used : ((d && d.tts && d.tts.monthUsed) || 0);
    var limit = month ? month.limit : ((d && d.tts && d.tts.monthLimit) || 500000);
    var exhausted = voicesData ? !!voicesData.exhausted : false;
    body.appendChild(el('div', 'usage-main', '本月已用 ' + Number(used) + ' / ' + Number(limit)));
    if (exhausted) body.appendChild(el('div', 'usage-sub', '本月 Azure 额度已用完，正在使用浏览器朗读'));

    sec.appendChild(body);
    applyEnabledVisibility();
  }

  function renderSettings(box, d) {
    var sec = el('div', 'usage-sec tts-sec');
    box.appendChild(sec);
    fillTtsSettings(sec, d);
    if (!voicesData) ensureVoices(function () { fillTtsSettings(sec, d); });
  }

  // 切换世界 / 离开页面停止朗读。
  window.addEventListener('pagehide', stop);
  window.addEventListener('beforeunload', stop);
  window.addEventListener('hashchange', stop);

  return {
    makeTurnButton: makeTurnButton,
    autoRead: autoRead,
    stop: stop,
    renderSettings: renderSettings,
    npcVoiceFor: npcVoiceFor,
    voiceLabel: voiceLabel,
    withVoices: withVoices,
    previewVoice: previewVoice,
    enabled: ttsEnabled,
    syncVisibility: syncVisibility,
    noteProgrammaticScroll: noteProgrammaticScroll,
  };
})();

window.Tts = Tts;
