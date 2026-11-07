'use strict';
  // ---- 用量面板：GET /api/usage/today；打开时每 10 秒刷新，关闭不轮询；每回合结束刷新一次 ----
  var USAGE_POLL_MS = 10000;
  var PROVIDER_ZH = { siliconflow: '硅基流动', modelscope: '魔搭', cloudflare: 'Cloudflare', zhipu: '智谱', local: '本地', gateway: '网关' };
  var usageTimer = null;
  var usageData = null;
  var usageBeforeTurn = null; // 回合开始前的今日 token 总数，用来算「本回合」
  var usageLastTurn = null;

  function fmtWan(n) {
    n = Number(n) || 0;
    if (n < 10000) return String(n);
    return (Math.round(n / 1000) / 10).toFixed(1).replace(/\.0$/, '') + '万';
  }

  // 复制失败时选中文本，方便手动复制。
  function selectUsageText(node) {
    if (!node) return;
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) { /* 选中失败时静默忽略 */ }
  }

  function usageCopyButton(getText, sourceNode) {
    var b = el('button', 'btn tiny usage-copy', '复制');
    b.addEventListener('click', function () {
      var text = getText() || '';
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        selectUsageText(sourceNode);
        return;
      }
      try {
        var p = navigator.clipboard.writeText(text);
        if (p && typeof p.catch === 'function') {
          p.catch(function () { selectUsageText(sourceNode); });
        } else {
          selectUsageText(sourceNode);
        }
      } catch (_) {
        selectUsageText(sourceNode);
      }
    });
    return b;
  }

  function renderUsage() {
    var box = $('usage-pop');
    box.textContent = '';
    box.appendChild(sheetCloseButton(function () { setUsageOpen(false); })); // 手机 bottom sheet 关闭 ×
    var d = usageData;
    if (!d) { box.appendChild(el('div', 'usage-sub', '读取中…')); return; }
    var isHost = !!d.access; // access 是 host 专属字段，来客响应里没有

    // ---- 朋友访问（仅主人，放在面板最上面）----
    if (isHost) {
      var friend = el('div', 'usage-sec');
      friend.appendChild(el('h4', null, '朋友访问'));
      var pw = (d.access && d.access.password) || '';
      var pwRow = el('div', 'usage-friend-row');
      pwRow.appendChild(el('span', 'usage-friend-label', '访问密码'));
      var pwVal = el('span', 'usage-mono', pw);
      pwRow.appendChild(pwVal);
      pwRow.appendChild(usageCopyButton(function () { return pw; }, pwVal));
      friend.appendChild(pwRow);

      var linkRow = el('div', 'usage-friend-row');
      linkRow.appendChild(el('span', 'usage-friend-label', '朋友链接'));
      var url = d.tunnel && d.tunnel.url;
      if (url) {
        var urlVal = el('span', 'usage-mono', url);
        linkRow.appendChild(urlVal);
        linkRow.appendChild(usageCopyButton(function () { return url; }, urlVal));
      } else {
        linkRow.appendChild(el('span', 'usage-sub', '隧道未启动'));
      }
      friend.appendChild(linkRow);

      // 主人口令：等宽、默认 •••• 遮住、点「显示」才露出，带复制按钮；仅主人可见。
      var hp = (d.access && d.access.hostPassword) || '';
      var HP_MASK = '••••••••';
      var hpRow = el('div', 'usage-friend-row');
      hpRow.appendChild(el('span', 'usage-friend-label', '主人口令'));
      var hpVal = el('span', 'usage-mono', HP_MASK);
      hpRow.appendChild(hpVal);
      var hpShown = false;
      var hpToggle = el('button', 'btn tiny', '显示');
      hpToggle.addEventListener('click', function () {
        hpShown = !hpShown;
        hpVal.textContent = hpShown ? hp : HP_MASK;
        hpToggle.textContent = hpShown ? '隐藏' : '显示';
      });
      hpRow.appendChild(hpToggle);
      hpRow.appendChild(usageCopyButton(function () { return hp; }, hpVal));
      friend.appendChild(hpRow);
      friend.appendChild(el('div', 'usage-note', '用于在手机等设备通过朋友链接以主人身份登录，不要发给朋友'));

      friend.appendChild(el('div', 'usage-note', '把链接和访问密码发给朋友；链接每次重启服务都会变'));
      box.appendChild(friend);
    }

    // ---- 场景插图开关（主人和来客都显示）----
    var sceneSec = el('div', 'usage-sec');
    sceneSec.appendChild(el('h4', null, '场景插图'));
    var sceneRow = el('label', 'usage-friend-row');
    var sceneCb = el('input');
    sceneCb.type = 'checkbox';
    sceneCb.checked = !!myPrefs.scenes;
    sceneRow.appendChild(sceneCb);
    sceneRow.appendChild(el('span', '', '关键回合配插图'));
    sceneCb.addEventListener('change', function () {
      var wanted = sceneCb.checked;
      api('/api/prefs', {
        method: 'POST',
        body: JSON.stringify({ scenes: wanted }),
      }).then(function (r) {
        var on = (r && r.prefs && typeof r.prefs.scenes === 'boolean') ? r.prefs.scenes : wanted;
        myPrefs.scenes = on;
        sceneCb.checked = on;
        toast(on ? '已开启场景插图' : '已关闭场景插图');
      }).catch(function (err) {
        sceneCb.checked = !wanted; // 失败还原
        toast(err.message || '设置失败');
      });
    });
    sceneSec.appendChild(sceneRow);
    box.appendChild(sceneSec);

    // ---- 成人内容（18+）：主人看两项，来客只看「我自己开启」----
    var adultSec = el('div', 'usage-sec');
    adultSec.appendChild(el('h4', null, '成人内容（18+）'));
    if (isHost) {
      var globalRow = el('label', 'usage-friend-row');
      var globalCb = el('input');
      globalCb.type = 'checkbox';
      globalCb.checked = !!myPrefs.adultAllowed;
      globalRow.appendChild(globalCb);
      globalRow.appendChild(el('span', '', '允许成人内容（总开关）'));
      globalCb.addEventListener('change', function () {
        var wanted = globalCb.checked;
        api('/api/prefs', {
          method: 'POST',
          body: JSON.stringify({ adultAllowed: wanted }),
        }).then(function (r) {
          var on = (r && r.prefs && typeof r.prefs.adultAllowed === 'boolean') ? r.prefs.adultAllowed : wanted;
          myPrefs.adultAllowed = on;
          globalCb.checked = on;
          toast(on ? '已开放成人内容（总开关）' : '已关闭成人内容（总开关）');
        }).catch(function (err) {
          globalCb.checked = !wanted;
          toast(err.message || '设置失败');
        });
      });
      adultSec.appendChild(globalRow);
    }
    var selfRow = el('label', 'usage-friend-row');
    var selfCb = el('input');
    selfCb.type = 'checkbox';
    selfRow.appendChild(selfCb);
    selfRow.appendChild(el('span', '', '我自己开启'));
    // 来客在主人总开关关闭时不可用，并注明原因。
    var adultBlocked = !isHost && !myPrefs.adultAllowed;
    if (adultBlocked) {
      selfCb.checked = false;
      selfCb.disabled = true;
      selfRow.appendChild(el('span', 'usage-sub', '主人未开放'));
    } else {
      selfCb.checked = !!myPrefs.adult;
    }
    selfCb.addEventListener('change', function () {
      var wanted = selfCb.checked;
      if (wanted && !window.confirm('我已年满 18 岁，同意查看成人内容')) {
        selfCb.checked = false;
        return;
      }
      api('/api/prefs', {
        method: 'POST',
        body: JSON.stringify({ adult: wanted, confirm18: true }),
      }).then(function (r) {
        var on = (r && r.prefs && typeof r.prefs.adult === 'boolean') ? r.prefs.adult : wanted;
        myPrefs.adult = on;
        selfCb.checked = on;
        toast(on ? '已开启成人内容' : '已关闭成人内容');
      }).catch(function (err) {
        selfCb.checked = !wanted;
        toast(err.message || '设置失败');
      });
    });
    adultSec.appendChild(selfRow);
    box.appendChild(adultSec);

    // ---- 朗读设置（主人和来客都显示）：音色列表取自 /api/tts/voices ----
    if (typeof Tts !== 'undefined') Tts.renderSettings(box, d);

    // ---- 今日对话 token ----
    var t = d.tokens || {};
    var sec1 = el('div', 'usage-sec');
    sec1.appendChild(el('h4', null, '今日对话 token'));
    if (t.limit > 0) {
      var pct = Math.min(100, (t.total / t.limit) * 100);
      sec1.appendChild(el('div', 'usage-main', fmtWan(t.total) + ' / ' + fmtWan(t.limit) + '，剩 ' + fmtWan(t.remaining)));
      var bar = el('div', 'usage-bar');
      var fill = el('i', pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '');
      fill.style.width = pct.toFixed(1) + '%';
      bar.appendChild(fill);
      sec1.appendChild(bar);
    } else {
      sec1.appendChild(el('div', 'usage-main', fmtWan(t.total) + '（不限）'));
    }
    sec1.appendChild(el('div', 'usage-sub', '输入 ' + fmtWan(t.prompt) + ' · 输出 ' + fmtWan(t.completion)
      + (usageLastTurn != null ? ' · 本回合约 ' + fmtWan(usageLastTurn) : '')));
    box.appendChild(sec1);

    // ---- 今日出图 ----
    var im = d.images || {};
    var by = im.byProvider || {};
    // 当前出图链里的提供方都列出（0 也显示），再补上今天用过但已不在链里的。
    var names = (im.chain || []).slice();
    Object.keys(by).forEach(function (p) {
      if (names.indexOf(p) < 0 && p.indexOf(',') < 0 && by[p].ok > 0) names.push(p);
    });
    var parts = names.map(function (p) {
      return (PROVIDER_ZH[p] || p) + ' ' + ((by[p] && by[p].ok) || 0) + ' 张';
    });
    parts.push('失败 ' + ((im.total && im.total.fail) || 0));
    var sec2 = el('div', 'usage-sec');
    sec2.appendChild(el('h4', null, '今日出图'));
    sec2.appendChild(el('div', 'usage-main', parts.join(' · ')));
    var cf = im.cloudflare;
    if (cf) {
      var cfLine = cf.remaining <= 0
        ? 'Cloudflare 今日额度已用完，明早 8 点重置'
        : 'Cloudflare 今日约剩 ' + cf.remaining + ' / ' + cf.limit + '（超过 ' + cf.reserveFrom + ' 后只留给场景图）';
      sec2.appendChild(el('div', 'usage-sub', cfLine));
    }
    Object.keys(im.cooling || {}).forEach(function (p) {
      var min = Math.max(1, Math.ceil(im.cooling[p] / 60000));
      sec2.appendChild(el('div', 'usage-cool', (PROVIDER_ZH[p] || p) + ' 冷却中 约 ' + min + ' 分钟'));
    });
    sec2.appendChild(el('div', 'usage-note', '硅基流动、Cloudflare、魔搭、智谱均为免费额度，接口不返回剩余额度，只会临时限速。'));
    box.appendChild(sec2);

    // ---- 今日各玩家 / 全局 token（仅主人）----
    if (isHost) {
      var plSec = el('div', 'usage-sec');
      plSec.appendChild(el('h4', null, '今日各玩家'));
      var players = d.players || [];
      if (players.length) {
        players.forEach(function (p) {
          var row = el('div', 'usage-player-row');
          row.appendChild(el('span', '', p.name));
          row.appendChild(el('span', 'usage-mono', fmtWan(p.total)));
          plSec.appendChild(row);
        });
      } else {
        plSec.appendChild(el('div', 'usage-sub', '（暂无）'));
      }

      // 把某个玩家的世界并到主人名下（下拉来自主人专属字段 playerNames）。
      var claimRow = el('div', 'usage-friend-row');
      var claimSel = el('select');
      claimSel.style.cssText = 'font-size:12px;flex:1 1 120px;min-width:110px;padding:4px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px';
      var pnames = d.playerNames || {};
      Object.keys(pnames).forEach(function (id) {
        if (id === 'host') return;
        var opt = el('option', null, pnames[id]);
        opt.value = id;
        claimSel.appendChild(opt);
      });
      claimRow.appendChild(claimSel);
      var claimBtn = el('button', 'btn tiny', '把某个玩家的世界并到我名下');
      claimBtn.addEventListener('click', async function () {
        var playerId = claimSel.value;
        if (!playerId) { toast('没有可收回的玩家'); return; }
        if (!window.confirm('确定把「' + (pnames[playerId] || playerId) + '」的世界并到你名下吗？')) return;
        claimBtn.disabled = true;
        try {
          var r = await api('/api/admin/claim-worlds', {
            method: 'POST',
            body: JSON.stringify({ playerId: playerId }),
          });
          toast('已收回 ' + ((r.moved || []).length) + ' 个世界');
          refreshUsage();
        } catch (e) {
          toast((e && e.message) || '收回失败');
        } finally {
          claimBtn.disabled = false;
        }
      });
      claimRow.appendChild(claimBtn);
      plSec.appendChild(claimRow);
      plSec.appendChild(el('div', 'usage-note', '选择来客，确认后把他创建的世界全部并到主人名下'));
      box.appendChild(plSec);

      var g = d.global || {};
      var gSec = el('div', 'usage-sec');
      gSec.appendChild(el('h4', null, '全局 token'));
      var gLine = g.limit > 0
        ? fmtWan(g.total) + ' / ' + fmtWan(g.limit) + '，剩 ' + fmtWan(g.remaining)
        : fmtWan(g.total) + '（不限）';
      gSec.appendChild(el('div', 'usage-main', gLine));
      box.appendChild(gSec);
    }
  }

  async function refreshUsage() {
    try {
      usageData = await api('/api/usage/today');
      if (usageBeforeTurn != null && usageData.tokens) {
        usageLastTurn = Math.max(0, usageData.tokens.total - usageBeforeTurn);
        usageBeforeTurn = null;
      }
    } catch (_) { /* 读取失败保留上次数据 */ }
    if (!$('usage-pop').hidden) renderUsage();
  }

  function setUsageOpen(open) {
    var box = $('usage-pop');
    box.hidden = !open;
    $('btn-usage').setAttribute('aria-expanded', open ? 'true' : 'false');
    clearInterval(usageTimer);
    usageTimer = null;
    if (open) {
      renderUsage();
      refreshUsage();
      usageTimer = setInterval(refreshUsage, USAGE_POLL_MS);
    }
    syncBodyScrollLock(); // 手机：用量弹层开关时锁定 / 恢复背景滚动
  }

  // ---- 当前玩家：启动时取一次 /api/me，显示名字；来客给一个退出入口 ----
  function renderPlayerInfo(me) {
    if (!me) return;
    if (me.prefs && typeof me.prefs.scenes === 'boolean') myPrefs.scenes = me.prefs.scenes;
    if (me.prefs && me.prefs.tts && typeof me.prefs.tts === 'object') myPrefs.tts = me.prefs.tts;
    if (me.prefs && typeof me.prefs.adult === 'boolean') myPrefs.adult = me.prefs.adult;
    if (me.prefs && typeof me.prefs.adultAllowed === 'boolean') myPrefs.adultAllowed = me.prefs.adultAllowed;
    var label = me.host ? '主人' : ('玩家：' + me.name);
    $('home-player-name').textContent = label;
    $('g-player-name').textContent = label;
    $('home-logout').hidden = !!me.host;
    $('g-logout').hidden = !!me.host;
    if ($('menu-logout')) $('menu-logout').hidden = !!me.host;
  }

  function doLogout() {
    fetch('/api/logout', { method: 'POST' }).then(function () {
      location.href = '/login.html';
    }).catch(function () {
      location.href = '/login.html';
    });
  }

