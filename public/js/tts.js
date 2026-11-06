'use strict';
// 朗读（第 2 步前端）：每段叙事的小喇叭、播放 / 浏览器兜底、自动朗读、用量面板里的朗读设置。
// 只用 createElement + textContent 构建 DOM，绝不拼接 HTML 字符串。

var FRONT_TTS_DEFAULT = {
  narrator: 'zh-CN-YunxiNeural',
  npcDefault: { m: 'zh-CN-YunjianNeural', f: 'zh-CN-XiaoxiaoNeural', old: 'zh-CN-YunyeNeural', young: 'zh-CN-YunxiNeural' },
  npcVoices: {}, speed: 1, auto: false,
};

var Tts = (function () {
  var gen = 0;
  var currentAudio = null;
  var currentBtn = null;
  var autoQueue = null;
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

  function resetBtn() {
    if (currentBtn) {
      currentBtn.textContent = '▶';
      currentBtn.setAttribute('aria-label', '朗读这一段');
      currentBtn.className = currentBtn.className.replace(/\s*tts-playing\b/, '');
      currentBtn = null;
    }
  }

  // 停止当前声音（保留 autoQueue，供自动朗读逐段推进）。
  function stopPlayback() {
    gen++;
    if (currentAudio) { try { currentAudio.pause(); } catch (_) {} currentAudio = null; }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
    resetBtn();
  }

  // 整体停止：点「■」、发送新行动、切换世界、离开页面时调用。
  function stop() {
    stopPlayback();
    autoQueue = null;
  }

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

  function browserSpeak(text, params, myGen) {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) { resolve(); return; }
      try {
        var u = new window.SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = clampSpeed(params.speed);
        var finished = false;
        function fin() {
          if (finished) return;
          finished = true;
          resolve();
          if (myGen === gen) done();
        }
        u.onend = fin;
        u.onerror = fin;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch (_) { resolve(); if (myGen === gen) done(); }
    });
  }

  function runFallback(text, params, myGen, reason) {
    if (myGen !== gen) return Promise.resolve();
    notifyFallback(reason);
    return browserSpeak(text, params, myGen);
  }

  function done() {
    currentAudio = null;
    resetBtn();
    if (autoQueue) {
      var q = autoQueue;
      q.index += 1;
      if (q.index < q.paras.length) playAutoNext(q);
      else autoQueue = null;
    }
  }

  // 播放一段：POST /api/tts 拿 audio/mpeg；503 / 429 / 网络错误时退回浏览器 speechSynthesis。
  async function speak(text, params, btn) {
    stopPlayback();
    var myGen = gen;
    if (btn) {
      currentBtn = btn;
      btn.textContent = '■';
      btn.setAttribute('aria-label', '停止朗读');
      btn.className += ' tts-playing';
    }
    var res;
    try {
      res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text, voice: params.voice, mood: params.mood, pace: params.pace, speed: params.speed,
        }),
      });
    } catch (_) {
      if (myGen === gen) await runFallback(text, params, myGen, '');
      return;
    }
    if (myGen !== gen) return;
    if (!res.ok) {
      var reason = '';
      try { var j = await res.json(); reason = (j && j.error) || ''; } catch (_) {}
      if (myGen === gen) await runFallback(text, params, myGen, reason);
      return;
    }
    var blob;
    try { blob = await res.blob(); } catch (_) {
      if (myGen === gen) await runFallback(text, params, myGen, '');
      return;
    }
    if (myGen !== gen) return;
    var url = URL.createObjectURL(blob);
    var audio;
    try { audio = new Audio(url); } catch (_) {
      URL.revokeObjectURL(url);
      if (myGen === gen) await runFallback(text, params, myGen, '');
      return;
    }
    currentAudio = audio;
    var ended = false;
    audio.onended = function () {
      if (ended) return; ended = true;
      URL.revokeObjectURL(url);
      if (myGen === gen) done();
    };
    audio.onerror = function () {
      if (ended) return; ended = true;
      URL.revokeObjectURL(url);
      if (myGen === gen) runFallback(text, params, myGen, '');
    };
    try { await audio.play(); } catch (_) {
      if (!ended && myGen === gen) {
        ended = true; URL.revokeObjectURL(url);
        await runFallback(text, params, myGen, '');
      }
    }
  }

  function playAutoNext(q) {
    if (!autoQueue || autoQueue !== q) return;
    var i = q.index;
    if (i >= q.paras.length) { autoQueue = null; return; }
    speak(q.paras[i], paramsForParagraph(q.hints, i), q.buttons[i] || null);
  }

  // 自动朗读新回合：从第一段顺序读到最后一段；任意停止 / 新行动都会清空队列。
  function autoRead(narr) {
    if (!narr || !narr.paras || !narr.paras.length) return;
    stop();
    autoQueue = { paras: narr.paras, hints: narr.hints || [], buttons: narr.buttons || [], index: 0 };
    playAutoNext(autoQueue);
  }

  // 每段叙事右侧的小喇叭；播放时变 ■ 可停止。
  function makeReadButton(text, paraIndex, hints) {
    var b = el('button', 'tts-read-btn', '▶');
    b.type = 'button';
    b.setAttribute('aria-label', '朗读这一段');
    b.addEventListener('click', function () {
      if (currentBtn === b) { stop(); return; }
      autoQueue = null; // 手动点某段即退出自动朗读
      speak(text, paramsForParagraph(hints, paraIndex), b);
    });
    return b;
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

  function makeSelect(voices, currentId) {
    var s = el('select', 'tts-select');
    var list = voices && voices.length ? voices : [{ id: currentId, name: '默认' }];
    list.forEach(function (v) {
      var o = el('option', null, (v.name || '') + ' · ' + v.id);
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

  function fillTtsSettings(sec, d) {
    sec.textContent = '';
    var t = getTts();
    var voices = (voicesData && voicesData.voices) || [];
    sec.appendChild(el('h4', null, '朗读'));

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
    sec.appendChild(autoRow);

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
    sec.appendChild(narRow);

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
      sec.appendChild(row);
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
    sec.appendChild(spRow);

    // 试听
    var tryRow = el('div', 'usage-friend-row');
    var tryBtn = el('button', 'btn tiny', '试听');
    tryBtn.type = 'button';
    tryBtn.addEventListener('click', function () {
      stop();
      speak('夜色渐深，远处的钟声又一次响起。', { voice: t.narrator, mood: 'calm', pace: 'normal', speed: t.speed }, null);
    });
    tryRow.appendChild(tryBtn);
    sec.appendChild(tryRow);

    // 本月已用 / 500000
    var month = voicesData && voicesData.month;
    var used = month ? month.used : ((d && d.tts && d.tts.monthUsed) || 0);
    var limit = month ? month.limit : ((d && d.tts && d.tts.monthLimit) || 500000);
    var exhausted = voicesData ? !!voicesData.exhausted : false;
    sec.appendChild(el('div', 'usage-main', '本月已用 ' + Number(used) + ' / ' + Number(limit)));
    if (exhausted) sec.appendChild(el('div', 'usage-sub', '本月 Azure 额度已用完，正在使用浏览器朗读'));
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
    makeReadButton: makeReadButton,
    autoRead: autoRead,
    stop: stop,
    renderSettings: renderSettings,
    npcVoiceFor: npcVoiceFor,
  };
})();

window.Tts = Tts;
