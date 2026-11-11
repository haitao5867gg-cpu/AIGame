'use strict';
  var homeDraft = null;          // 首页输入 / 点门时暂存，供新世界页预填
  var heroTypeTimer = null;
  var heroTyper = { samples: [], index: 0, char: 0, deleting: false, running: false };
  var doorsRendered = false;
  var homeScrollTicking = false;
  // ---- 路由 ----
  function hideAllViews() {
    if (typeof Atmosphere !== 'undefined') Atmosphere.leaveWorld();
    ['view-home', 'view-new', 'view-game'].forEach(function (id) { $(id).hidden = true; });
    $('panel').dataset.open = 'false';
    syncBodyScrollLock(); // 路由切换收起抽屉时恢复背景滚动
    hideAttrTip(); // 切换视图时收起可能还开着的属性说明卡
    if (typeof closeNpcCard === 'function') closeNpcCard(); // 切世界 / 离开世界关闭人物卡
    setUndoVisible(false); // 复位撤回按钮二次确认态，重新进入世界时按后端状态再显隐
    clearInterval(pendingTimer);
    pendingTimer = null;
    stopImagePoll();     // 离开世界：停止 /images 轮询
    closeImageViewer();  // 收起可能还开着的大图
    if (typeof Sky !== 'undefined') Sky.stop();
    $('home-backdrop').hidden = true;
    clearTimeout(heroTypeTimer);
    heroTypeTimer = null;
    heroTyper.running = false;
    window.removeEventListener('scroll', onHomeScroll);
  }

  function route() {
    var h = location.hash || '#/';
    hideAllViews();
    if (h === '#/new') showNew();
    else if (h.indexOf('#/w/') === 0) showGame(decodeURIComponent(h.slice(4)));
    else showHome();
  }

  // ---- 首页 ----
  async function showHome() {
    $('view-home').hidden = false;
    var bd = $('home-backdrop');
    bd.hidden = false;
    bd.classList.remove('dim');
    if (typeof Sky !== 'undefined') Sky.start($('home-sky'));
    if (!doorsRendered) { renderDoors(); doorsRendered = true; } // 门只渲染一次
    startHeroTyper();
    window.addEventListener('scroll', onHomeScroll, { passive: true });
    onHomeScroll();
    startReveal();
    var list = await api('/api/worlds').catch(function (err) { toast(err.message); return []; });
    list = list.slice().sort(function (a, b) {
      return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
    });
    var shelf = $('home-shelf');
    shelf.hidden = list.length === 0;
    $('shelf-count').textContent = list.length ? '共 ' + list.length + ' 个' : '';
    if (list.length) renderWorldList(list);
    else $('world-list').textContent = '';
    var resume = $('hero-resume');
    if (list.length) {
      var w = list[0];
      var title = w.title || '未命名世界';
      if (title.length > 14) title = title.slice(0, 14) + '…';
      resume.href = '#/w/' + encodeURIComponent(w.id);
      resume.textContent = '继续「' + title + '」 · 第 ' + w.turn + ' 回合';
      resume.hidden = false;
    } else {
      resume.hidden = true;
      resume.removeAttribute('href');
    }
  }

  // ---- 首屏：灵感打字机 ----
  function heroReduced() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function heroSamples() {
    var seen = {}, out = [];
    function push(s) { if (s && !seen[s]) { seen[s] = 1; out.push(s); } }
    PRESETS.forEach(push);
    HOME_DOORS.forEach(function (d) { push(d.seed); });
    return out;
  }

  function startHeroTyper() {
    clearTimeout(heroTypeTimer);
    heroTypeTimer = null;
    heroTyper.samples = heroSamples();
    heroTyper.index = 0;
    heroTyper.char = 0;
    heroTyper.deleting = false;
    var seed = $('home-seed');
    if (heroReduced()) {
      heroTyper.running = false;
      seed.placeholder = heroTyper.samples[0] || '';
      return;
    }
    heroTyper.running = true;
    seed.placeholder = '';
    typeStep();
  }

  function typeStep() {
    var seed = $('home-seed');
    if (!heroTyper.running || !seed) return;
    if (document.activeElement === seed || seed.value) return; // 有焦点或已有内容时停住
    var s = heroTyper.samples[heroTyper.index] || '';
    if (!heroTyper.deleting) {
      heroTyper.char += 1;
      seed.placeholder = s.slice(0, heroTyper.char);
      if (heroTyper.char >= s.length) {
        heroTyper.deleting = true;
        heroTypeTimer = setTimeout(typeStep, 2200);
        return;
      }
      heroTypeTimer = setTimeout(typeStep, 70);
    } else {
      heroTyper.char -= 1;
      seed.placeholder = s.slice(0, Math.max(0, heroTyper.char));
      if (heroTyper.char <= 0) {
        heroTyper.deleting = false;
        heroTyper.index = (heroTyper.index + 1) % heroTyper.samples.length;
        heroTypeTimer = setTimeout(typeStep, 70);
        return;
      }
      heroTypeTimer = setTimeout(typeStep, 25);
    }
  }

  function pauseHeroTyper() {
    clearTimeout(heroTypeTimer);
    heroTypeTimer = null;
    heroTyper.running = false;
    $('home-seed').placeholder = '写下任何设定，比如：' + (heroTyper.samples[heroTyper.index] || '');
  }

  function resumeHeroTyper() {
    var seed = $('home-seed');
    if (seed.value || document.activeElement === seed) return;
    if (heroReduced()) { seed.placeholder = heroTyper.samples[0] || ''; return; }
    heroTyper.running = true;
    typeStep();
  }

  function goNewFromSeed() {
    homeDraft = { seed: $('home-seed').value.trim(), genre: null };
    location.hash = '#/new';
  }

  function onHeroDice() {
    var samples = heroSamples();
    var cur = $('home-seed').value.trim();
    var pool = samples.filter(function (s) { return s !== cur; });
    if (!pool.length) pool = samples;
    var pick = pool[Math.floor(Math.random() * pool.length)];
    $('home-seed').value = pick;
    homeDraft = homeDraft || { seed: null, genre: null };
    homeDraft.genre = null;
    pauseHeroTyper();
    $('home-seed').focus();
  }

  function onHeroMore() {
    var target = $('home-shelf').hidden ? $('home-doors') : $('home-shelf');
    target.scrollIntoView({ behavior: heroReduced() ? 'auto' : 'smooth', block: 'start' });
  }

  function initHome() {
    var form = $('hero-form');
    var seed = $('home-seed');
    form.addEventListener('submit', function (e) { e.preventDefault(); goNewFromSeed(); });
    seed.addEventListener('keydown', function (e) {
      // 避开中文输入法选词时的误提交
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        goNewFromSeed();
      }
    });
    seed.addEventListener('focus', pauseHeroTyper);
    seed.addEventListener('blur', resumeHeroTyper);
    seed.addEventListener('input', function () { if (seed.value) pauseHeroTyper(); });
    $('hero-dice').addEventListener('click', onHeroDice);
    $('hero-more').addEventListener('click', onHeroMore);
  }

  // ---- 题材之门 ----
  function renderDoors() {
    var row = $('door-row');
    row.textContent = '';
    HOME_DOORS.forEach(function (door) {
      var b = el('button', 'door');
      b.type = 'button';
      b.style.setProperty('--door-img', 'url(' + door.img + ')');
      b.style.setProperty('--door-accent', door.accent);
      b.appendChild(el('span', 'door-seal', door.glyph));
      b.appendChild(el('span', 'door-genre', door.label));
      b.appendChild(el('span', 'door-seed', door.seed));
      b.appendChild(el('span', 'door-go', '用这个开头 ›'));
      b.addEventListener('click', function () {
        homeDraft = { seed: door.seed, genre: door.genre };
        location.hash = '#/new';
      });
      row.appendChild(b);
    });
  }

  // ---- 滚动渐隐 / 区块入场 ----
  function onHomeScroll() {
    if (homeScrollTicking) return;
    homeScrollTicking = true;
    window.requestAnimationFrame(function () {
      homeScrollTicking = false;
      var fade = Math.max(0, 1 - window.scrollY / (0.9 * window.innerHeight));
      $('home-backdrop').style.setProperty('--art-fade', fade.toFixed(2));
    });
  }

  function startReveal() {
    var nodes = document.querySelectorAll('#view-home .reveal');
    if (!('IntersectionObserver' in window) || heroReduced()) {
      nodes.forEach(function (n) { n.classList.add('in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    nodes.forEach(function (n) { if (!n.classList.contains('in')) io.observe(n); });
  }

  function renderWorldList(list) {
    var box = $('world-list');
    box.textContent = '';
    list.forEach(function (w) {
      var card = el('div', 'world-card');
      card.appendChild(el('h3', '', w.title || '未命名世界'));
      var meta = el('div', 'meta');
      meta.appendChild(el('span', '', '第 ' + w.life + ' 世'));
      meta.appendChild(el('span', '', '第 ' + w.turn + ' 回合'));
      meta.appendChild(el('span', '', w.alive ? '在世' : '已终'));
      meta.appendChild(el('span', '', w.updatedAt ? new Date(w.updatedAt).toLocaleString() : ''));
      card.appendChild(meta);

      var footer = el('div', 'card-footer');
      footer.appendChild(el('span', 'go', '进入世界 ›'));
      var exp = el('button', 'btn tiny', '导出');
      exp.addEventListener('click', function (e) {
        e.stopPropagation();
        exportWorld(w.id);
      });
      footer.appendChild(exp);
      var del = el('button', 'btn danger tiny', '删除');
      var armed = false;
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!armed) {
          armed = true;
          del.textContent = '确认删除？';
          setTimeout(function () { armed = false; del.textContent = '删除'; }, 4000);
          return;
        }
        api('/api/worlds/' + encodeURIComponent(w.id), { method: 'DELETE' })
          .then(function () { showHome(); })
          .catch(function (err) { toast(err.message); });
      });
      footer.appendChild(del);
      card.appendChild(footer);

      card.addEventListener('click', function () { location.hash = '#/w/' + w.id; });
      box.appendChild(card);
    });
  }

  // ---- 新世界 ----
  function showNew() {
    $('view-new').hidden = false;
    var bd = $('home-backdrop');
    bd.hidden = false;
    bd.classList.add('dim');
    if (typeof Sky !== 'undefined') Sky.start($('home-sky'));
    if (!$('presets').childElementCount) renderPresets();
    if (!$('genre-row').childElementCount) renderGenres();
    if (!$('alloc').childElementCount) initAlloc();
    if (homeDraft) {
      if (homeDraft.seed) $('seed').value = homeDraft.seed;
      if (homeDraft.genre) {
        for (var i = 0; i < GENRE_OPTIONS.length; i++) {
          if (GENRE_OPTIONS[i].value === homeDraft.genre) {
            selectedGenre = homeDraft.genre;
            renderGenres();
            break;
          }
        }
      }
    }
    homeDraft = null;
    updatePoints();
  }

  function renderPresets() {
    var box = $('presets');
    PRESETS.forEach(function (p) {
      var b = el('button', 'preset', p);
      b.addEventListener('click', function () { $('seed').value = p; $('seed').focus(); });
      box.appendChild(b);
    });
  }

  // 文风单选胶囊：默认 'auto'（交给模型判断），点击重绘以更新选中态。
  var selectedGenre = 'auto';

  function renderGenres() {
    var box = $('genre-row');
    box.textContent = '';
    GENRE_OPTIONS.forEach(function (g) {
      var b = el('button', 'genre-pill' + (g.value === selectedGenre ? ' selected' : ''), g.label);
      b.type = 'button';
      b.setAttribute('data-genre', g.value);
      b.addEventListener('click', function () {
        selectedGenre = g.value;
        renderGenres();
      });
      box.appendChild(b);
    });
  }

  function remaining() {
    return 6 - ATTRS.reduce(function (s, a) { return s + (alloc[a] || 0); }, 0);
  }

  function initAlloc() {
    var box = $('alloc');
    box.textContent = '';
    ATTRS.forEach(function (a) {
      alloc[a] = 1; // 默认平均分配，剩余 0 点
      var row = el('div', 'alloc-row');
      row.appendChild(el('span', 'alloc-name', a));
      var minus = el('button', 'btn tiny', '−');
      var val = el('span', 'alloc-val', '1');
      var plus = el('button', 'btn tiny', '+');
      minus.addEventListener('click', function () { changeAlloc(a, -1, val); });
      plus.addEventListener('click', function () { changeAlloc(a, 1, val); });
      row.appendChild(minus);
      row.appendChild(val);
      row.appendChild(plus);
      box.appendChild(row);
    });
  }

  function changeAlloc(a, d, valEl) {
    var next = (alloc[a] || 0) + d;
    if (next < 0 || next > 3) return;
    if (d > 0 && remaining() <= 0) return;
    alloc[a] = next;
    valEl.textContent = String(next);
    updatePoints();
  }

  function randomAlloc() {
    ATTRS.forEach(function (a) { alloc[a] = 0; });
    var left = 6;
    while (left > 0) {
      var candidates = ATTRS.filter(function (a) { return alloc[a] < 3; });
      var a = candidates[Math.floor(Math.random() * candidates.length)];
      alloc[a] += 1;
      left -= 1;
    }
    var rows = $('alloc').children;
    ATTRS.forEach(function (a, i) { rows[i].querySelector('.alloc-val').textContent = String(alloc[a]); });
    updatePoints();
  }

  function updatePoints() {
    var r = remaining();
    $('points-left').textContent = '剩余 ' + r + ' 点';
    $('points-left').style.color = r === 0 ? 'var(--muted)' : 'var(--accent-2)';
    $('btn-create').disabled = r !== 0;
  }

  function setCreating(b) {
    $('creating').hidden = !b;
    $('btn-create').disabled = b;
  }

  async function createWorld() {
    var seed = $('seed').value.trim();
    if (!seed) { toast('请先写一句世界观'); return; }
    if (remaining() !== 0) { toast('请分配完 6 点属性'); return; }
    var name = $('char-name').value.trim() || '无名旅人';
    var appearance = $('char-appearance').value.trim() || '一袭布衣';
    setCreating(true);
    try {
      var w = await api('/api/worlds', {
        method: 'POST',
        body: JSON.stringify({ seed: seed, name: name, appearance: appearance, alloc: alloc, genre: selectedGenre }),
      });
      location.hash = '#/w/' + w.id;
    } catch (err) {
      toast(err.message);
    } finally {
      setCreating(false);
    }
  }
