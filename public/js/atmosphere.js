'use strict';
var Atmosphere = (function () {
  var prefs = AtmosphereState.normalizePrefs(null), controller = null, catalog = null, catalogPromise = null;
  var world = null, turnOptions = {}, playerId = null, playerEpoch = 0, editVersion = 0;
  var pending = {}, saveTimer = null, inFlight = null, modal = null, previousFocus = null;
  var backdrop = null, catalogFailed = false;
  var sceneArt = null, shownSrc = null, sceneToken = 0;
  var localEdits = {}, voiceState = { active: false, paused: false };
  var tracks = null, tracksToken = 0, trackQueue = [], trackTimer = null;
  var READING_LABELS = { auto: '跟随时辰', paper: '纸页', night: '夜色' };
  var READING_CYCLE = { auto: 'paper', paper: 'night', night: 'auto' };
  var READING_HINT = { auto: '（白天亮、夜里暗）', paper: '（始终亮色）', night: '（始终暗色）' };
  function renderReadingLabels() {
    var label = READING_LABELS[prefs.reading] || READING_LABELS.auto;
    var menu = document.getElementById('menu-read-name'); if (menu) menu.textContent = label;
    var g = document.getElementById('g-read'); if (g) g.textContent = '底色·' + label;
  }
  function cycleReading() {
    if (!world) return;
    var next = READING_CYCLE[prefs.reading] || 'auto';
    change({ reading: next }, true);
    toast('阅读底色：' + READING_LABELS[next] + READING_HINT[next]);
  }
  function audio() {
    if (!controller && typeof window.Audio === 'function') {
      controller = AtmosphereAudio.create({ Audio: window.Audio, AudioContext: window.AudioContext || window.webkitAudioContext || null });
      if (catalog) controller.setCatalog(catalog);
      controller.setPrefs(prefs); controller.setHidden(document.hidden === true);
      controller.setVoiceState(voiceState);
      if (tracks && controller.setTracks) controller.setTracks(tracks);
      if (controller.onTrack) controller.onTrack(queueTrackEvent);
      controller.onStatus(refreshStatus);
    }
    return controller;
  }
  function status() { return controller ? controller.getStatus() : { enabled: prefs.enabled, unlocked: false, playing: false, blocked: false, error: false, track: null, trackCount: 0 }; }
  // ---- 配乐曲目单与播放统计 ----
  // 每次进世界重新取一次曲目单：主人往服务器放了新的音频文件，下次进世界就能听到。
  function loadTracks() {
    var token = ++tracksToken;
    return fetch('/api/bgm/catalog', { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw Error(); return r.json(); })
      .then(function (d) {
        if (token !== tracksToken || !d || !Array.isArray(d.tracks)) return;
        tracks = d.tracks; if (controller && controller.setTracks) controller.setTracks(tracks); refreshStatus();
      }).catch(function () { /* 取不到就用自带的每档一首 */ });
  }
  function flushTrackEvents() {
    clearTimeout(trackTimer); trackTimer = null;
    if (!trackQueue.length) return;
    var batch = trackQueue.splice(0, 50);
    // 统计丢一条不要紧，失败不重试、不打扰玩家。
    try {
      fetch('/api/bgm/events', { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: batch }) }).catch(function () {});
    } catch (_) {}
    if (trackQueue.length) trackTimer = setTimeout(flushTrackEvents, 500);
  }
  function queueTrackEvent(ev) {
    if (!ev || typeof ev.id !== 'string') return;
    trackQueue.push({ id: ev.id, seconds: ev.seconds, reason: ev.reason, first: ev.first === true });
    if (!trackTimer) trackTimer = setTimeout(flushTrackEvents, 1500);
  }
  function trackLabel(t) { return t ? t.title + (t.artist ? ' · ' + t.artist : '') : ''; }
  function stepTrack(step) {
    var c = audio(); if (!c || !c.next) return;
    var moved = step > 0 ? c.next() : c.prev();
    if (!moved) { toast('这个场景目前只有这一首'); return; }
    var s = status();
    // 切歌本身是一次点击：声音被浏览器拦着时顺便恢复。
    if (prefs.enabled && (s.blocked || !s.unlocked)) c.enableFromGesture().then(refreshStatus);
    refreshStatus();
  }
  function renderTrack() {
    var s = status(), t = s.track, many = s.trackCount > 1;
    var show = !!(world && prefs.enabled && t && prefs.musicVolume > 0);
    var bar = document.getElementById('bgm-bar');
    if (bar) {
      bar.hidden = !show;
      var name = document.getElementById('bgm-name'); if (name) name.textContent = show ? '♫ ' + trackLabel(t) : '';
      ['bgm-prev', 'bgm-next'].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = !many; });
    }
    var line = document.getElementById('atmosphere-track-name');
    if (line) {
      line.textContent = t ? t.title : '当前没有配乐';
      var small = el('small', '', t ? (t.artist || '') + (many ? (t.artist ? ' · ' : '') + '本场景共 ' + s.trackCount + ' 首' : '') : '');
      line.appendChild(small);
      ['atmosphere-track-prev', 'atmosphere-track-next'].forEach(function (id) { var b = document.getElementById(id); if (b) b.disabled = !many; });
    }
    syncMediaSession(show ? t : null, many);
  }
  // 手机锁屏 / 耳机线控上的曲名和上一首、下一首。
  var mediaTrackId = null;
  function syncMediaSession(t, many) {
    var ms = typeof navigator !== 'undefined' && navigator.mediaSession;
    if (!ms || typeof window.MediaMetadata !== 'function') return;
    try {
      if (!t) { if (mediaTrackId !== null) { ms.metadata = null; mediaTrackId = null; } return; }
      if (mediaTrackId !== t.id) {
        ms.metadata = new window.MediaMetadata({ title: t.title, artist: t.artist || '', album: '无限世界' });
        mediaTrackId = t.id;
      }
      ms.setActionHandler('nexttrack', many ? function () { stepTrack(1); } : null);
      ms.setActionHandler('previoustrack', many ? function () { stepTrack(-1); } : null);
    } catch (_) {}
  }
  function themeReady() { return world && catalog && catalog.themes && catalog.themes[AtmosphereState.resolve(world).theme]; }
  function message() {
    var s = status();
    if (!prefs.enabled) return '声音已关闭';
    if (!window.Audio) return '当前设备暂不支持背景声音';
    if (catalogFailed) return '声音素材暂时不可用，可稍后重试';
    if (!catalog) return '正在准备声音素材…';
    if (!themeReady()) return '当前世界暂无配乐';
    if (prefs.musicVolume === 0 && prefs.ambienceVolume === 0) return '音乐和环境音量均为零';
    if (s.blocked || !s.unlocked) return '点一下恢复声音';
    if (s.error) return s.playing ? '部分音源暂时不可用' : '声音暂时不可用，可重试';
    return s.playing ? '氛围声音播放中' : '正在载入声音…';
  }
  function refreshStatus() {
    var b = document.getElementById('btn-atmosphere'), s = status();
    if (b) {
      b.textContent = prefs.enabled ? '♫' : '♩'; b.setAttribute('aria-pressed', String(prefs.enabled));
      b.setAttribute('aria-label', prefs.enabled && s.unlocked && !s.blocked ? '关闭氛围声音' : '开启或恢复氛围声音');
      b.title = message(); b.classList.toggle('atmosphere-playing', !!s.playing);
    }
    var line = document.getElementById('atmosphere-status'); if (line) line.textContent = message();
    renderTrack();
  }
  function safeImage(src) {
    return typeof src === 'string' && (
      (/^\/assets\/atmosphere\/[a-z0-9_./-]+\.(jpg|jpeg|png|webp)$/i.test(src) && src.split('/').indexOf('..') < 0 && src.indexOf('//') < 0) ||
      /^\/assets\/home\/door-(xuanhuan|urban|game|horror|cozy|general)-v1\.jpg$/.test(src) ||
      /^\/api\/images\/scene-[0-9a-f]{12}\.(jpg|png)$/.test(src)
    );
  }
  function genreKey(theme) {
    if (theme === 'lingtian') return 'xuanhuan';
    if (theme === 'urban' || theme === 'game' || theme === 'horror' ||
        theme === 'cozy' || theme === 'general') return theme;
    return 'general';
  }
  function setSceneArt(url) {
    var next = (typeof url === 'string' && /^\/api\/images\/scene-[0-9a-f]{12}\.(jpg|png)$/.test(url)) ? url : null;
    if (next === sceneArt) return;
    sceneArt = next;
    applyScene();
  }
  function applyScene() {
    var token = ++sceneToken;
    var scene = world ? AtmosphereState.resolve(world, Object.assign({}, turnOptions, { prefs: prefs })) : null;
    if (scene) {
      document.body.setAttribute('data-genre', genreKey(scene.theme));
      document.body.setAttribute('data-period', scene.period);
      document.body.setAttribute('data-read', AtmosphereState.resolveReading(prefs.reading, scene.period));
    } else {
      document.body.removeAttribute('data-genre');
      document.body.removeAttribute('data-period');
      document.body.removeAttribute('data-read');
    }
    if (!backdrop) backdrop = document.getElementById('world-backdrop');
    var src = null, artKind = null;
    if (scene) {
      var theme = catalog && catalog.themes && catalog.themes[scene.theme];
      var entry = theme && theme.backgrounds && theme.backgrounds[scene.background];
      if (entry && safeImage(entry.src)) { src = entry.src; artKind = 'catalog'; }
      else if (sceneArt && safeImage(sceneArt)) { src = sceneArt; artKind = 'scene'; }
      else { src = '/assets/home/door-' + genreKey(scene.theme) + '-v1.jpg'; artKind = 'genre'; }
    }
    var visible = !!(prefs.background && world && src && safeImage(src));
    document.body.classList.toggle('atmosphere-background', visible);
    if (backdrop) {
      backdrop.hidden = !visible; backdrop.dataset.period = scene ? scene.period : 'day';
      backdrop.dataset.art = visible ? artKind : '';
      if (!visible) {
        backdrop.style.backgroundImage = ''; shownSrc = null;
      } else if (src !== shownSrc) {
        if (typeof Image === 'function') {
          var wanted = src, kind = artKind;
          var pre = new Image();
          pre.onload = function () {
            if (token !== sceneToken) return;
            backdrop.style.backgroundImage = 'url("' + wanted + '")'; shownSrc = wanted;
          };
          pre.onerror = function () {
            if (token !== sceneToken) return;
            if (kind === 'scene') { sceneArt = null; applyScene(); }
          };
          pre.src = wanted;
        } else {
          backdrop.style.backgroundImage = 'url("' + src + '")'; shownSrc = src;
        }
      }
    }
    if (scene) scene.musicThemes = AtmosphereState.musicThemes(world);
    var c = audio(); if (c) { c.setPrefs(prefs); c.setScene(scene); }
    refreshStatus();
    renderReadingLabels();
  }
  function loadCatalog(retry) {
    if (catalogPromise && !retry) return catalogPromise;
    catalogFailed = false;
    catalogPromise = fetch('/assets/atmosphere/catalog.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw Error(); return r.json(); })
      .then(function (c) {
        if (!c || !c.themes || !Array.isArray(c.credits)) throw Error();
        catalog = c; if (controller) controller.setCatalog(c); applyScene(); renderCredits(); return c;
      }).catch(function () { catalogFailed = true; refreshStatus(); return null; });
    return catalogPromise;
  }
  function applyPrefs(all, id) {
    if (id && playerId && id !== playerId) {
      playerEpoch++; pending = {}; inFlight = null; clearTimeout(saveTimer); saveTimer = null;
      localEdits = {}; editVersion = 0;
      if (typeof Tts !== 'undefined' && Tts.stop) Tts.stop();
      leaveWorld(); closeSettings(); if (controller) { controller.destroy(); controller = null; }
    }
    if (id) playerId = id;
    prefs = AtmosphereState.normalizePrefs(localEdits, AtmosphereState.normalizePrefs(all && all.atmosphere));
    myPrefs.atmosphere = Object.assign({}, prefs);
    applyScene(); syncFields();
  }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (inFlight || !Object.keys(pending).length) return;
    var patch = pending; pending = {};
    var job = { epoch: playerEpoch, version: editVersion, id: playerId }; inFlight = job;
    api('/api/prefs', { method: 'POST', body: JSON.stringify({ atmosphere: patch }), keepalive: true })
      .then(function (result) {
        if (inFlight !== job || job.epoch !== playerEpoch || job.id !== playerId || job.version !== editVersion) return;
        if (result && result.prefs && result.prefs.atmosphere) {
          prefs = AtmosphereState.normalizePrefs(result.prefs.atmosphere);
          myPrefs.atmosphere = Object.assign({}, prefs); applyScene(); syncFields();
        }
      }).catch(function () { if (job.epoch === playerEpoch) toast('氛围设置未保存，可稍后再试'); })
      .finally(function () { if (inFlight === job) { inFlight = null; if (Object.keys(pending).length) flushSave(); } });
  }
  function change(patch, immediate) {
    prefs = AtmosphereState.normalizePrefs(patch, prefs); myPrefs.atmosphere = Object.assign({}, prefs);
    Object.assign(pending, patch); Object.assign(localEdits, patch); editVersion++; applyScene(); syncFields();
    clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, immediate ? 0 : 350);
  }
  function toggle() {
    var s = status();
    if (prefs.enabled && s.unlocked && !s.blocked) change({ enabled: false }, true);
    else { change({ enabled: true }, true); var c = audio(); if (c) c.enableFromGesture().then(refreshStatus); }
  }
  function enterWorld(s, opts) {
    if (!s || !s.id || (typeof currentWorldId !== 'undefined' && currentWorldId !== s.id)) return;
    var entering = !world || world.id !== s.id;
    world = s; turnOptions = opts || {}; applyScene(); loadCatalog(false);
    if (entering || !tracks) loadTracks();
  }
  function leaveWorld() {
    world = null; turnOptions = {}; if (controller) controller.stop();
    flushTrackEvents();
    sceneArt = null; shownSrc = null; sceneToken++;
    document.body.removeAttribute('data-genre');
    document.body.removeAttribute('data-period');
    document.body.removeAttribute('data-read');
    if (backdrop) { backdrop.hidden = true; backdrop.style.backgroundImage = ''; }
    document.body.classList.remove('atmosphere-background'); closeSettings(); refreshStatus();
  }
  function setVoiceState(s) { voiceState = { active: !!(s && s.active), paused: !!(s && s.paused) }; var c = audio(); if (c) c.setVoiceState(voiceState); }
  function syncFields() {
    if (!modal) return;
    ['enabled', 'background', 'musicVolume', 'ambienceVolume', 'mode', 'reading'].forEach(function (key) {
      var node = document.getElementById('atmosphere-' + key); if (!node) return;
      if (node.type === 'checkbox') node.checked = prefs[key]; else node.value = String(prefs[key]);
      var out = document.getElementById('atmosphere-' + key + '-value'); if (out) out.textContent = Math.round(prefs[key] * 100) + '%';
    });
    refreshStatus();
  }
  function link(text, url) {
    if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) return el('span', '', text);
    var a = el('a', '', text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  function renderCredits() {
    var box = document.getElementById('atmosphere-credits'); if (!box) return;
    box.textContent = '';
    if (!catalog) { box.appendChild(el('p', 'muted', '素材信息暂未载入')); return; }
    catalog.credits.forEach(function (credit) {
      var row = el('p', 'atmosphere-credit'); row.appendChild(link(String(credit.title || ''), credit.source));
      row.appendChild(document.createTextNode(' · ' + String(credit.author || '') + ' · '));
      row.appendChild(link(String(credit.license || ''), credit.licenseUrl));
      if (credit.changes) row.appendChild(el('small', '', String(credit.changes)));
      box.appendChild(row);
    });
  }
  function openSettings() {
    if (modal || !world) return;
    previousFocus = document.activeElement;
    modal = el('div', 'atmosphere-mask'); modal.id = 'atmosphere-modal'; modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'atmosphere-title'); modal.tabIndex = -1;
    var card = el('div', 'atmosphere-card'), title = el('h3', '', '世界氛围'); title.id = 'atmosphere-title'; card.appendChild(title);
    [['enabled', '开启氛围声音'], ['background', '显示世界背景']].forEach(function (pair) {
      var row = el('label', 'atmosphere-switch'), input = el('input'); input.type = 'checkbox'; input.id = 'atmosphere-' + pair[0];
      input.addEventListener('change', function () {
        var patch = {}; patch[pair[0]] = input.checked; change(patch, true);
        if (pair[0] === 'enabled' && input.checked) { var c = audio(); if (c) c.enableFromGesture().then(refreshStatus); }
      }); row.appendChild(input); row.appendChild(document.createTextNode(pair[1])); card.appendChild(row);
    });
    var readLabel = el('label', 'atmosphere-mode', '阅读底色'); readLabel.htmlFor = 'atmosphere-reading';
    var readSelect = el('select'); readSelect.id = 'atmosphere-reading';
    [['auto', '跟随时辰（白天亮、夜里暗）'], ['paper', '纸页（始终亮色）'], ['night', '夜色（始终暗色）']].forEach(function (p) {
      var option = el('option', '', p[1]); option.value = p[0]; readSelect.appendChild(option);
    });
    readSelect.addEventListener('change', function () { change({ reading: readSelect.value }, true); });
    readLabel.appendChild(readSelect); card.appendChild(readLabel);
    [['musicVolume', '音乐音量'], ['ambienceVolume', '环境音量']].forEach(function (pair) {
      var row = el('label', 'atmosphere-volume', pair[1]); row.htmlFor = 'atmosphere-' + pair[0];
      var out = el('span'); out.id = row.htmlFor + '-value'; row.appendChild(out);
      var input = el('input'); input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.01'; input.id = row.htmlFor;
      input.addEventListener('input', function () { var patch = {}; patch[pair[0]] = Number(input.value); change(patch, false); });
      row.appendChild(input); card.appendChild(row);
    });
    var modeLabel = el('label', 'atmosphere-mode', '音乐氛围'); modeLabel.htmlFor = 'atmosphere-mode';
    var select = el('select'); select.id = 'atmosphere-mode';
    [['auto', '跟随场景'], ['calm', '田间日常'], ['explore', '外出探索'], ['tense', '遇险']].forEach(function (p) { var option = el('option', '', p[1]); option.value = p[0]; select.appendChild(option); });
    select.addEventListener('change', function () { change({ mode: select.value }, true); }); modeLabel.appendChild(select); card.appendChild(modeLabel);
    var trackRow = el('div', 'atmosphere-track');
    var prevBtn = el('button', 'btn', '⏮\uFE0E'); prevBtn.type = 'button'; prevBtn.id = 'atmosphere-track-prev'; prevBtn.setAttribute('aria-label', '上一首');
    prevBtn.addEventListener('click', function () { stepTrack(-1); });
    var trackName = el('span'); trackName.id = 'atmosphere-track-name'; trackName.setAttribute('role', 'status');
    var nextBtn = el('button', 'btn', '⏭\uFE0E'); nextBtn.type = 'button'; nextBtn.id = 'atmosphere-track-next'; nextBtn.setAttribute('aria-label', '下一首');
    nextBtn.addEventListener('click', function () { stepTrack(1); });
    trackRow.appendChild(prevBtn); trackRow.appendChild(trackName); trackRow.appendChild(nextBtn); card.appendChild(trackRow);
    var statusLine = el('p', 'muted'); statusLine.id = 'atmosphere-status'; statusLine.setAttribute('role', 'status'); card.appendChild(statusLine);
    card.appendChild(el('p', 'muted', '朗读时背景声音会自动降低。切到后台会暂停，返回后可点♫恢复。'));
    var retry = el('button', 'btn', '重新载入声音'); retry.type = 'button';
    retry.addEventListener('click', function () {
      if (controller) { controller.destroy(); controller = null; }
      applyScene(); var c = audio(); if (prefs.enabled && c) c.enableFromGesture().then(refreshStatus);
      loadCatalog(true); loadTracks();
    }); card.appendChild(retry);
    var credits = el('details', 'atmosphere-credit-list'); credits.appendChild(el('summary', '', '素材致谢'));
    var list = el('div'); list.id = 'atmosphere-credits'; credits.appendChild(list); card.appendChild(credits);
    var close = el('button', 'btn', '关闭'); close.type = 'button'; close.addEventListener('click', closeSettings); card.appendChild(close);
    card.appendChild(sheetCloseButton(closeSettings)); modal.appendChild(card);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeSettings(); });
    document.body.appendChild(modal); syncFields(); renderCredits(); syncBodyScrollLock(); modal.focus();
  }
  function closeSettings() {
    if (!modal) return; var old = modal; modal = null; if (old.parentNode) old.parentNode.removeChild(old);
    syncBodyScrollLock();
    var focusTarget = previousFocus && previousFocus.isConnected && previousFocus.getClientRects().length
      ? previousFocus : document.getElementById('btn-atmosphere');
    if (focusTarget && focusTarget.getClientRects().length) focusTarget.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (!modal) return;
    if (e.key === 'Escape') {
      var viewer = document.getElementById('image-viewer');
      if (viewer && !viewer.hidden && typeof closeImageViewer === 'function') closeImageViewer(); else closeSettings();
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (e.key !== 'Tab') return;
    var list = Array.prototype.filter.call(modal.querySelectorAll('button,input,select,summary'), function (n) {
      return !n.disabled && !n.hidden && (!n.getClientRects || n.getClientRects().length);
    });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1], active = document.activeElement;
    if (e.shiftKey && (active === first || active === modal)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || active === modal)) { e.preventDefault(); first.focus(); }
  });
  function reportListening() { if (controller && controller.reportListen) controller.reportListen(); flushTrackEvents(); }
  document.addEventListener('visibilitychange', function () {
    if (controller) controller.setHidden(document.hidden === true);
    if (document.hidden === true) reportListening(); // 手机切后台常常不再回来，先把已听的时长报上去
  });
  window.addEventListener('pagehide', function () { flushSave(); if (controller) controller.setHidden(true); reportListening(); });
  ['bgm-prev', 'bgm-next', 'bgm-name'].forEach(function (id) {
    var node = document.getElementById(id); if (!node) return;
    node.addEventListener('click', function () {
      if (id === 'bgm-name') openSettings(); else stepTrack(id === 'bgm-next' ? 1 : -1);
    });
  });
  window.addEventListener('pageshow', function () { if (controller) controller.setHidden(document.hidden === true); });
  return { applyPrefs: applyPrefs, enterWorld: enterWorld, leaveWorld: leaveWorld,
    openSettings: openSettings, closeSettings: closeSettings, setVoiceState: setVoiceState, toggle: toggle,
    setSceneArt: setSceneArt, cycleReading: cycleReading };
})();
