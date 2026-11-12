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

  // 每个世界一张「有封面的小说」卡片；全程 el()/textContent/setAttribute 构建，不拼接 HTML 字符串。
  function renderWorldList(list) {
    var box = $('world-list');
    box.textContent = '';
    list.forEach(function (w, idx) {
      var door = homeDoorFor(w.genre);
      var title = w.title || '未命名世界';
      var card = el('article', 'world-card');
      if (idx === 0) card.classList.add('featured');
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'link');
      card.setAttribute('aria-label', '进入世界：' + title);

      // ---- 封面 ----
      var cover = el('div', 'wc-cover');
      cover.style.setProperty('--door-img', 'url(' + door.img + ')');
      cover.style.setProperty('--door-accent', door.accent);
      var seal = el('span', 'door-seal wc-seal', door.glyph); // 无封面 / 图片加载失败时补上
      var hasCover = !!(w.cover && w.cover.url);
      if (hasCover) {
        var img = el('img', 'wc-img' + (w.cover.kind === 'hero' ? ' hero' : ''));
        img.setAttribute('alt', '');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('src', w.cover.url);
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.removeChild(img);
          cover.classList.add('no-img');
          if (!seal.parentNode) cover.appendChild(seal);
        });
        cover.appendChild(img);
      } else {
        cover.classList.add('no-img');
      }

      var tags = el('div', 'wc-tags');
      var gname = genreName(w.genre);
      if (gname) tags.appendChild(el('span', 'wc-genre', gname));
      var statusParts = [];
      if (!w.alive) statusParts.push('已终');
      if (w.awaitingRebirth) statusParts.push('待重生');
      if (statusParts.length) tags.appendChild(el('span', 'wc-status', statusParts.join(' · ')));
      cover.appendChild(tags);
      if (idx === 0) cover.appendChild(el('span', 'wc-recent', '最近在玩'));
      if (!hasCover) cover.appendChild(seal);
      cover.appendChild(el('h3', 'wc-title', title));

      // ---- 正文 ----
      var body = el('div', 'wc-body');
      var metaParts = [];
      if (w.charName) metaParts.push(w.charName);
      if (w.place) metaParts.push(w.place);
      if (w.day) metaParts.push(formatGameDay(w.day) + (w.period ? ' ' + w.period : ''));
      if (metaParts.length) body.appendChild(el('div', 'wc-meta', metaParts.join(' · ')));
      if (w.excerpt) body.appendChild(el('p', 'wc-excerpt', '…' + w.excerpt));

      var foot = el('div', 'wc-foot');
      var stats = '第 ' + w.life + ' 世 · 第 ' + w.turn + ' 回合';
      if (w.updatedAt) stats += ' · ' + relTime(w.updatedAt);
      foot.appendChild(el('span', 'wc-stats', stats));
      var actions = el('span', 'wc-actions');
      var exp = el('button', 'btn tiny', '导出');
      exp.addEventListener('click', function (e) { e.stopPropagation(); exportWorld(w.id); });
      actions.appendChild(exp);
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
      actions.appendChild(del);
      foot.appendChild(actions);
      body.appendChild(foot);

      card.appendChild(cover);
      card.appendChild(body);

      function go() { location.hash = '#/w/' + encodeURIComponent(w.id); }
      card.addEventListener('click', go);
      card.addEventListener('keydown', function (e) {
        if (e.target !== card || e.key !== 'Enter') return; // 导出/删除按钮自身处理，不重复跳转
        e.preventDefault();
        go();
      });
      box.appendChild(card);
    });
  }

  // ---- 新世界 ----
  // 「换一个」示例身份：与题材无关的通用身份，随机填一条。
  var IDENTITY_SAMPLES = [
    '刚被退婚的穷书生',
    '会修机器的失业工程师',
    '被师门赶出来的小道士',
    '欠了一屁股债的退伍兵，枪法准',
    '在码头扛包的孤儿',
    '丢了官职的小捕快',
    '带着一封密信的信使',
    '被同行排挤的年轻大夫',
    '守着祖传铺子的手艺人',
    '从戏班跑出来的武生',
    '记不清自己是谁的旅人',
    '总在换名字的江湖骗子',
  ];

  function onIdentityDice() {
    var cur = $('char-identity').value.trim();
    var pool = IDENTITY_SAMPLES.filter(function (s) { return s !== cur; });
    var pick = pool[Math.floor(Math.random() * pool.length)];
    $('char-identity').value = pick;
  }

  function showNew() {
    $('view-new').hidden = false;
    window.scrollTo(0, 0); // 进入新世界页时回到顶部，避免停在首页的滚动位置
    var bd = $('home-backdrop');
    bd.hidden = false;
    bd.classList.add('dim');
    if (typeof Sky !== 'undefined') Sky.start($('home-sky'));
    if (!$('presets').childElementCount) renderPresets();
    if (!$('genre-row').childElementCount) renderGenres();
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
      } else {
        // 首屏表单 /「换个灵感」：genre 为 null，重置为「自动」，避免沿用上次点门选的文风。
        selectedGenre = 'auto';
        renderGenres();
      }
    }
    homeDraft = null;
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

  // 建世界要几十秒：显示已等秒数，手机上不至于以为卡死；等待期间保持亮屏（锁屏会掐断请求）。
  var creatingTimer = null;
  var creatingWake = null;
  function setCreating(b, label) {
    $('creating').hidden = !b;
    $('btn-create').disabled = b;
    clearInterval(creatingTimer);
    creatingTimer = null;
    if (creatingWake) { try { creatingWake.release().catch(function () {}); } catch (_) {} creatingWake = null; }
    if (!b) return;
    var box = $('creating');
    var start = Date.now();
    var text = label || '世界正在成形';
    function tick() {
      var secs = Math.floor((Date.now() - start) / 1000);
      box.textContent = text + '… 已等 ' + secs + ' 秒' + (secs >= 8 ? '（通常要半分钟到一分钟，可以先去做别的）' : '');
    }
    tick();
    creatingTimer = setInterval(tick, 1000);
    try {
      if (navigator.wakeLock && !document.hidden) {
        navigator.wakeLock.request('screen').then(function (s) {
          if (!creatingTimer) { s.release().catch(function () {}); return; }
          creatingWake = s;
        }).catch(function () {});
      }
    } catch (_) {}
  }

  // 建世界时网络断了（切后台 / 锁屏 / 换网络）：世界多半还在服务器上照常生成。
  // 隔几秒查一次世界列表，出现建之前没有的新世界就直接进去，最多找 3 分钟。
  async function findNewWorld(beforeIds) {
    var known = {};
    beforeIds.forEach(function (id) { known[id] = true; });
    var deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 5000); });
      if (location.hash !== '#/new') return null; // 玩家已经离开新世界页
      try {
        var list = await api('/api/worlds');
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id && !known[list[i].id]) return list[i].id;
        }
      } catch (_) { /* 网络还没恢复，继续等 */ }
    }
    return null;
  }

  async function createWorld() {
    var seed = $('seed').value.trim();
    if (!seed) { toast('请先写一句世界观'); return; }
    var name = $('char-name').value.trim();
    var appearance = $('char-appearance').value.trim();
    var identity = $('char-identity').value.trim();
    var body = { seed: seed, genre: selectedGenre };
    if (name) body.name = name;
    if (appearance) body.appearance = appearance;
    if (identity) body.identity = identity;
    setCreating(true);
    var beforeIds = null;
    try {
      beforeIds = (await api('/api/worlds')).map(function (w) { return w.id; });
    } catch (_) { beforeIds = null; }
    try {
      var w = await api('/api/worlds', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      location.hash = '#/w/' + w.id;
    } catch (err) {
      var found = null;
      if (err && err.network && beforeIds) {
        setCreating(true, '连接断了，世界可能还在成形，正在找回');
        found = await findNewWorld(beforeIds);
      }
      if (found) location.hash = '#/w/' + found;
      else toast(err.message);
    } finally {
      setCreating(false);
    }
  }
