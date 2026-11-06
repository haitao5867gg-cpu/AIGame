'use strict';
  // ---- 事件绑定 ----
  function boot() {
    $('btn-new').addEventListener('click', function () { location.hash = '#/new'; });
    document.querySelectorAll('[data-nav]').forEach(function (n) {
      n.addEventListener('click', function () { location.hash = n.getAttribute('data-nav'); });
    });
    // 属性说明卡：全局点击（含手机轻点）统一处理弹卡 / 切换 / 点空白关闭。
    document.addEventListener('click', onDocumentClick);
    // 点击大图查看器（再点）关闭
    $('image-viewer').addEventListener('click', closeImageViewer);
    $('btn-random').addEventListener('click', randomAlloc);
    $('btn-create').addEventListener('click', createWorld);
    $('btn-send').addEventListener('click', sendAction);
    $('btn-undo').addEventListener('click', onUndoClick);
    $('btn-panel').addEventListener('click', function () {
      var p = $('panel');
      p.dataset.open = p.dataset.open === 'true' ? 'false' : 'true';
    });
    $('btn-usage').addEventListener('click', function (e) {
      e.stopPropagation();
      setUsageOpen($('usage-pop').hidden);
    });
    document.addEventListener('click', function (e) {
      if (!$('usage-pop').hidden && !$('usage-pop').contains(e.target) && e.target !== $('btn-usage')) setUsageOpen(false);
    });
    window.addEventListener('hashchange', function () { setUsageOpen(false); });
    $('btn-export').addEventListener('click', function () {
      if (currentWorldId) exportWorld(currentWorldId);
    });
    document.querySelector('.stage').addEventListener('click', function () {
      if (window.innerWidth < 860) $('panel').dataset.open = 'false';
    });
    $('action-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
    });
    window.addEventListener('hashchange', route);
    // 启动时取一次当前玩家，显示名字 / 来客退出入口。
    $('home-logout').addEventListener('click', function (e) { e.preventDefault(); doLogout(); });
    $('g-logout').addEventListener('click', function (e) { e.preventDefault(); doLogout(); });
    api('/api/me').then(renderPlayerInfo).catch(function () {});
    route();
  }

  boot();
