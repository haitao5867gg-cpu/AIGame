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
      syncBodyScrollLock();
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
      if (window.innerWidth < 860) { $('panel').dataset.open = 'false'; syncBodyScrollLock(); }
    });
    $('action-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAction(); }
    });
    window.addEventListener('hashchange', route);

    // ---- 手机端 ⋯ 菜单：收起「用量 / 角色面板 / 导出 / 退出」 ----
    var moreBtn = $('btn-more');
    var moreMenu = $('more-menu');
    moreBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      moreMenu.hidden = !moreMenu.hidden;
      moreBtn.setAttribute('aria-expanded', moreMenu.hidden ? 'false' : 'true');
    });
    // 点菜单外面关闭
    document.addEventListener('click', function (e) {
      if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreBtn) {
        moreMenu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
      }
    });
    moreMenu.querySelectorAll('[data-menu]').forEach(function (item) {
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        moreMenu.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
        var act = item.getAttribute('data-menu');
        if (act === 'usage') setUsageOpen(true);
        else if (act === 'panel') { $('panel').dataset.open = 'true'; syncBodyScrollLock(); }
        else if (act === 'export') { if (currentWorldId) exportWorld(currentWorldId); }
        else if (act === 'logout') doLogout();
      });
    });

    // 软键盘弹出 / 收起（visualViewport 尺寸变化）：保持输入框可见并把叙事滚到底。
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        if (window.innerWidth > 600) return;
        scrollBottom();
        var ai = $('action-input');
        if (ai && document.activeElement === ai) ai.scrollIntoView({ block: 'end' });
      });
    }
    // 输入框最多约 4 行自动增高（手机），避免挡住叙事；CSS 里另有 max-height 上限。
    $('action-input').addEventListener('input', function () {
      if (window.innerWidth > 600) return;
      this.style.height = 'auto';
      this.style.height = this.scrollHeight + 'px';
    });

    // 启动时取一次当前玩家，显示名字 / 来客退出入口。
    $('home-logout').addEventListener('click', function (e) { e.preventDefault(); doLogout(); });
    $('g-logout').addEventListener('click', function (e) { e.preventDefault(); doLogout(); });
    api('/api/me').then(renderPlayerInfo).catch(function () {});
    route();
  }

  boot();
