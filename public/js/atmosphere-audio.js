'use strict';
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AtmosphereAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  function safeSrc(v) {
    if (typeof v !== 'string') return false;
    if (/^\/api\/bgm\/file\/[a-z0-9][a-z0-9-]{0,39}\.mp3$/.test(v)) return true; // 候选配乐（文件在仓库外）
    return /^\/assets\/atmosphere\/[a-z0-9_./-]+\.(mp3|ogg|wav)$/i.test(v)
      && v.split('/').indexOf('..') < 0 && v.indexOf('//') < 0;
  }
  var MOOD_SET = { calm: true, explore: true, tense: true };
  // 曲目单只收形状合法、音源路径安全的条目；曲名 / 作者只当文本显示。
  function cleanTracks(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (t) {
      if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(t.id)) return;
      if (seen[t.id] || !safeSrc(t.src) || typeof t.theme !== 'string' || MOOD_SET[t.mood] !== true) return;
      seen[t.id] = true;
      out.push({ id: t.id, title: String(t.title || t.id).slice(0, 80), artist: String(t.artist || '').slice(0, 80),
        theme: t.theme, mood: t.mood, src: t.src });
    });
    return out;
  }
  function volume(v, fallback) { return typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback; }
  function create(options) {
    var o = options || {}, AudioCtor = o.Audio || root.Audio;
    var ContextCtor = o.AudioContext !== undefined ? o.AudioContext : (root.AudioContext || root.webkitAudioContext);
    var delay = o.setTimeout || root.setTimeout.bind(root), cancel = o.clearTimeout || root.clearTimeout.bind(root);
    var clock = o.now || Date.now, random = o.random || Math.random;
    // 多曲目：tracks 是服务端给的曲目单；picks 记每个「题材组 + 档位」当前选中的曲目；bad 是本次会话里放不出来的。
    var tracks = [], picks = {}, bad = {}, trackListeners = [], listen = null, closeReason = null;
    var prefs = { enabled: false, musicVolume: 0.16, ambienceVolume: 0.10 };
    var scene = null, catalog = null, context = null, unlocked = false, blocked = false, hidden = false;
    var voice = false, destroyed = false, epoch = 0, listeners = [], lastStatus = '', emitting = false;
    var holder = null;
    if (root.document && root.document.createElement) {
      holder = root.document.createElement('div'); holder.hidden = true;
      holder.setAttribute('aria-hidden', 'true'); holder.id = 'atmosphere-audio-bus';
      root.document.body.appendChild(holder);
    }
    var slots = ['music', 'ambient-0', 'ambient-1'].map(function (role) {
      var audio = new AudioCtor(); audio.preload = 'none'; audio.loop = true;
      if (audio.setAttribute) { audio.setAttribute('data-atmosphere-role', role); audio.setAttribute('playsinline', ''); }
      if (holder && audio.nodeType) holder.appendChild(audio);
      return { role: role, audio: audio, src: '', wanted: '', node: null, gain: null,
        token: 0, timer: null, pending: false, started: false, failed: false, graphBroken: false, fading: false, lastGain: 0 };
    });
    function base(s) {
      var v = s.role === 'music' ? prefs.musicVolume : prefs.ambienceVolume / Math.max(1, (scene && scene.ambience || []).slice(0, 2).length);
      return v * (voice ? 0.2 : 1);
    }
    function eligible(s) { return !destroyed && !hidden && !s.graphBroken && prefs.enabled && unlocked && scene && s.wanted && base(s) > 0; }
    function getStatus() {
      return { enabled: prefs.enabled, unlocked: unlocked,
        playing: slots.some(function (s) { return eligible(s) && s.started && !s.audio.paused && !s.audio.muted && (!context || context.state === 'running'); }),
        mood: scene && scene.mood || null,
        track: trackInfo(), trackCount: playlist().length,
        blocked: blocked || !!(unlocked && context && !hidden && context.state !== 'running'),
        error: slots.some(function (s) { return s.failed; }) };
    }
    function emit() {
      if (emitting || destroyed) return;
      var state = getStatus(), signature = JSON.stringify(state);
      if (signature === lastStatus) return;
      lastStatus = signature; emitting = true;
      listeners.slice().forEach(function (fn) { try { fn(state); } catch (_) {} });
      emitting = false;
    }
    function clearTimer(s) { if (s.timer !== null) { cancel(s.timer); s.timer = null; } s.fading = false; }
    function mix(s, value, seconds) {
      s.lastGain = value;
      if (s.gain) {
        var p = s.gain.gain, now = context.currentTime;
        p.cancelScheduledValues(now); p.setValueAtTime(p.value, now);
        if (seconds) p.linearRampToValueAtTime(value, now + seconds); else p.setValueAtTime(value, now);
        s.audio.volume = 1;
      } else {
        try { s.audio.volume = value; if (Math.abs(s.audio.volume - value) > 0.02) { s.audio.muted = true; s.failed = true; } } catch (_) { s.failed = true; }
      }
      if (s.audio.setAttribute) {
        s.audio.setAttribute('data-mix-mode', s.gain ? 'webaudio' : 'element');
        s.audio.setAttribute('data-mix-target', String(value));
      }
    }
    // ---- 曲目单 ----
    function themesOf() {
      if (!scene) return [];
      var list = Array.isArray(scene.musicThemes) && scene.musicThemes.length ? scene.musicThemes : [scene.theme];
      return list.filter(function (t, i) { return typeof t === 'string' && list.indexOf(t) === i; });
    }
    function pickKey() { return themesOf().join('+') + '/' + (scene && scene.mood); }
    // 当前场景可播的曲目：按题材组的先后、再按曲目单原顺序；本次会话放不出来的不算。
    function playlist() {
      if (!scene || !tracks.length) return [];
      var out = [];
      themesOf().forEach(function (theme) {
        tracks.forEach(function (t) { if (t.theme === theme && t.mood === scene.mood && !bad[t.id]) out.push(t); });
      });
      return out;
    }
    // 第一次进某个档位随机挑一首起播（让每首歌都有被听到的机会），之后记住选择。
    function currentTrack(list) {
      if (!list.length) return null;
      var key = pickKey(), id = picks[key];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      var chosen = list[Math.min(list.length - 1, Math.floor(random() * list.length))];
      picks[key] = chosen.id; return chosen;
    }
    function trackInfo() {
      var t = currentTrack(playlist());
      return t ? { id: t.id, title: t.title, artist: t.artist } : null;
    }
    // ---- 收听记录：一次「播放」从换上这首歌开始，到被换下结束；只在真正出声时计时 ----
    function fire(ev) { trackListeners.slice().forEach(function (fn) { try { fn(ev); } catch (_) {} }); }
    function listenHold() { if (listen && listen.since !== null) { listen.acc += Math.max(0, clock() - listen.since); listen.since = null; } }
    function listenRun() { if (listen && listen.since === null) listen.since = clock(); }
    // keep=true 是中途补报（页面要关了），这次播放还没结束。
    function listenFlush(reason, keep) {
      if (!listen) return;
      var running = listen.since !== null; listenHold();
      var seconds = Math.round(listen.acc / 100) / 10;
      // 一晃而过（不到 1 秒）的场景切换不算一次播放；玩家手动切走和自然播完始终记。
      if (seconds >= 1 || reason === 'skip' || reason === 'end') {
        fire({ id: listen.id, seconds: seconds, reason: reason, first: listen.first });
        listen.first = false; listen.acc = 0;
      }
      if (!keep) listen = null; else if (running) listen.since = clock();
    }
    function pause(s, release) {
      clearTimer(s); s.token++; s.pending = false; s.started = false;
      try { s.audio.pause(); } catch (_) {}
      mix(s, 0, 0);
      if (s.role === 'music') {
        if (release) { listenFlush(closeReason || 'stop', false); closeReason = null; } else listenHold();
      }
      if (release) {
        s.audio.onplaying = s.audio.onerror = s.audio.onpause = s.audio.onended = null;
        try { if (s.audio.removeAttribute) s.audio.removeAttribute('src'); else s.audio.src = ''; if (s.audio.load) s.audio.load(); } catch (_) {}
        s.src = '';
      }
    }
    function ensureContext() {
      if (context || !ContextCtor) return;
      try { context = new ContextCtor(); }
      catch (_) { ContextCtor = null; return; }
      if (typeof context.createGain !== 'function' || typeof context.createMediaElementSource !== 'function') {
        if (context.close) Promise.resolve(context.close()).catch(function () {});
        context = null; ContextCtor = null; return;
      }
      context.onstatechange = emit;
      slots.forEach(function (s) {
        try {
          s.gain = context.createGain(); s.gain.gain.setValueAtTime(0, context.currentTime);
          s.node = context.createMediaElementSource(s.audio); s.node.connect(s.gain); s.gain.connect(context.destination);
          s.audio.volume = 1;
        } catch (_) { s.failed = true; s.graphBroken = true; try { s.audio.pause(); s.audio.muted = true; } catch (_) {} }
      });
    }
    function play(s) {
      if (!eligible(s) || s.failed || s.pending || (s.started && !s.audio.paused)) return Promise.resolve(false);
      var ticket = s.token, worldTicket = epoch;
      s.pending = true;
      function current() { return ticket === s.token && worldTicket === epoch && eligible(s); }
      function stale() { if (!eligible(s)) { try { s.audio.pause(); } catch (_) {} } return false; }
      var promise;
      try { promise = s.audio.play(); } catch (e) { promise = Promise.reject(e); }
      return Promise.resolve(promise).then(function () {
        if (!current()) return stale();
        s.pending = false; s.started = true; blocked = false; mix(s, base(s), 0.4);
        if (s.role === 'music') listenRun();
        emit(); return true;
      }, function (error) {
        if (!current()) return stale();
        s.pending = false; s.started = false;
        if (error && error.name === 'NotAllowedError') {
          blocked = true; unlocked = false; slots.forEach(function (x) { pause(x, false); });
        } else if (!skipBroken(s)) { s.failed = true; pause(s, false); }
        emit(); return false;
      });
    }
    // 这首放不出来（文件坏了 / 刚被移走）：本次会话不再选它，换下一首；没有别的可换时返回 false。
    function skipBroken(s) {
      if (s.role !== 'music') return false;
      var list = playlist(), cur = currentTrack(list);
      if (!cur || cur.src !== s.src || list.length < 2) return false;
      var next = list[(list.indexOf(cur) + 1) % list.length];
      bad[cur.id] = true; listen = null; picks[pickKey()] = next.id;
      fire({ id: cur.id, seconds: 0, reason: 'fail', first: false });
      sync(true); return true;
    }
    // 换到同档位的上一首 / 下一首。reason: skip=玩家手动切，end=自然播完。
    function advance(step, reason) {
      var list = playlist();
      if (list.length < 2) return false;
      var i = list.indexOf(currentTrack(list));
      picks[pickKey()] = list[(i + step + list.length) % list.length].id;
      closeReason = reason; sync(true); closeReason = null; emit();
      return true;
    }
    function assign(s, src) {
      if (s.role === 'music' && !closeReason) closeReason = 'switch';
      pause(s, true); closeReason = null; s.failed = false; s.wanted = src; s.src = src;
      var ticket = s.token;
      if (s.role === 'music') {
        var list = playlist(), cur = currentTrack(list);
        // 有多首就不单曲循环：播完自动接下一首；只有一首（或没有曲目单）时照旧循环。
        s.audio.loop = !(cur && cur.src === src && list.length > 1);
        listen = cur && cur.src === src ? { id: cur.id, first: true, acc: 0, since: null } : null;
        s.audio.onended = function () {
          if (ticket !== s.token || destroyed) return;
          if (!advance(1, 'end')) { s.started = false; play(s); }
        };
      }
      s.audio.onerror = function () {
        if (ticket !== s.token || destroyed) return;
        if (skipBroken(s)) return;
        s.failed = true; pause(s, false); emit();
      };
      s.audio.onpause = function () { emit(); };
      s.audio.preload = 'none'; s.audio.muted = false; s.audio.src = src;
      mix(s, 0, 0); return play(s);
    }
    function desired() {
      var theme = scene && catalog && catalog.themes && catalog.themes[scene.theme];
      function src(entry) { return entry && safeSrc(entry.src) ? entry.src : ''; }
      var track = currentTrack(playlist());
      return [track ? track.src : src(theme && theme.music && theme.music[scene.mood])].concat([0, 1].map(function (i) {
        var id = scene && scene.ambience && scene.ambience[i];
        return src(id && theme && theme.ambience && theme.ambience[id]);
      }));
    }
    function sync(immediate) {
      var wants = desired(), pending = [];
      slots.forEach(function (s, i) {
        var next = wants[i];
        if (s.wanted !== next) { clearTimer(s); s.failed = false; }
        s.wanted = next;
        if (!eligible(s)) { pause(s, !hidden); return; }
        if (s.src === next) { if (!s.fading) mix(s, base(s), 0.3); pending.push(play(s)); return; }
        if (s.role === 'music' && s.src && s.started && !immediate) {
          if (s.timer !== null) return;
          s.fading = true; mix(s, 0, 0.8);
          var ticket = epoch, wanted = next;
          s.timer = delay(function () {
            s.timer = null; s.fading = false;
            if (ticket === epoch && s.wanted === wanted && eligible(s)) assign(s, wanted);
          }, 800);
        } else pending.push(assign(s, next));
      });
      emit(); return pending;
    }
    function setCatalog(c) { catalog = c && typeof c === 'object' ? c : null; if (!destroyed) sync(false); }
    function setTracks(list) { if (destroyed) return; tracks = cleanTracks(list); sync(false); }
    function next() { return !destroyed && advance(1, 'skip'); }
    function prev() { return !destroyed && advance(-1, 'skip'); }
    // 页面要关 / 切后台时把已经听的秒数先报上去，这次播放不算结束。
    function reportListen() { if (!destroyed) listenFlush('stop', true); }
    function onTrack(fn) { if (destroyed) return function () {}; trackListeners.push(fn); return function () { trackListeners = trackListeners.filter(function (x) { return x !== fn; }); }; }
    function setPrefs(p) {
      if (destroyed) return;
      p = p || {};
      var enabled = typeof p.enabled === 'boolean' ? p.enabled : prefs.enabled;
      if (enabled !== prefs.enabled && !enabled) epoch++;
      prefs = { enabled: enabled, musicVolume: volume(p.musicVolume, prefs.musicVolume), ambienceVolume: volume(p.ambienceVolume, prefs.ambienceVolume) };
      sync(false);
    }
    function setScene(s) {
      if (destroyed) return;
      if (!scene || !s || scene.worldId !== s.worldId) { epoch++; slots.forEach(function (x) { pause(x, true); }); }
      scene = s && s.worldId ? s : null; blocked = false; sync(false);
    }
    function enableFromGesture() {
      if (destroyed || hidden || !prefs.enabled || !scene) return Promise.resolve(false);
      ensureContext(); unlocked = true; blocked = false;
      slots.forEach(function (s) { if (s.failed && !s.graphBroken) { pause(s, true); s.failed = false; } });
      bad = {};
      var resumed;
      try { resumed = context && context.resume ? context.resume() : Promise.resolve(); } catch (e) { resumed = Promise.reject(e); }
      // 两者均在点击调用栈同步发起，等待Promise不会推迟首次play到异步回调里。
      var plays = sync(true), ticket = epoch;
      return Promise.all([Promise.resolve(resumed)].concat(plays)).then(function () {
        if (ticket !== epoch || destroyed || hidden || !prefs.enabled) return false;
        if (context && context.state !== 'running') { unlocked = false; blocked = true; }
        emit(); return getStatus().playing;
      }, function () { if (ticket === epoch) { unlocked = false; blocked = true; slots.forEach(function (s) { pause(s, false); }); emit(); } return false; });
    }
    function setVoiceState(v) { var next = !!(v && v.active && !v.paused); if (voice === next || destroyed) return; voice = next; slots.forEach(function (s) { if (eligible(s) && !s.fading) mix(s, base(s), 0.3); }); emit(); }
    function setHidden(v) {
      if (hidden === !!v || destroyed) return;
      hidden = !!v; epoch++;
      if (hidden) { slots.forEach(function (s) { pause(s, false); }); if (context && context.suspend) Promise.resolve(context.suspend()).catch(function () {}); }
      else if (unlocked && prefs.enabled) {
        var res; try { res = context && context.resume ? context.resume() : null; } catch (_) { res = Promise.reject(); }
        Promise.resolve(res).then(function () { if (!hidden && !destroyed) sync(false); }, function () { unlocked = false; blocked = true; emit(); });
      }
      emit();
    }
    function stop() { if (destroyed) return; epoch++; scene = null; slots.forEach(function (s) { s.wanted = ''; pause(s, true); }); emit(); }
    function destroy() {
      if (destroyed) return; stop(); destroyed = true; listeners = []; trackListeners = [];
      slots.forEach(function (s) { try { if (s.node) s.node.disconnect(); if (s.gain) s.gain.disconnect(); } catch (_) {} });
      if (context && context.close) Promise.resolve(context.close()).catch(function () {});
      if (holder && holder.parentNode) holder.parentNode.removeChild(holder);
    }
    function onStatus(fn) { if (destroyed) return function () {}; listeners.push(fn); try { fn(getStatus()); } catch (_) {} return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; }
    return { setCatalog: setCatalog, setPrefs: setPrefs, setScene: setScene, enableFromGesture: enableFromGesture,
      setVoiceState: setVoiceState, setHidden: setHidden, stop: stop, destroy: destroy, getStatus: getStatus, onStatus: onStatus,
      setTracks: setTracks, next: next, prev: prev, reportListen: reportListen, onTrack: onTrack };
  }
  return { create: create };
});
