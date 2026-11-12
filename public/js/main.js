'use strict';
  // ---- 事件绑定 ----
  function boot() {
    initHome();
    document.querySelectorAll('[data-nav]').forEach(function (n) {
      n.addEventListener('click', function () { location.hash = n.getAttribute('data-nav'); });
    });
    // 属性说明卡：全局点击（含手机轻点）统一处理弹卡 / 切换 / 点空白关闭。
    document.addEventListener('click', onDocumentClick);
    // 印记 / 线索 / 传闻说明卡：点条目弹卡、点卡片外 / Escape 关闭、Enter / 空格触发。
    document.addEventListener('click', onClueDocumentClick);
    document.addEventListener('keydown', onClueKeyDown);
    // 点击大图查看器（再点）关闭
    $('image-viewer').addEventListener('click', closeImageViewer);
    $('identity-dice').addEventListener('click', onIdentityDice);
    $('btn-create').addEventListener('click', createWorld);
    if ($('adult-mode')) $('adult-mode').addEventListener('change', onAdultModeToggle);
    $('btn-send').addEventListener('click', sendAction);
    $('btn-idea').addEventListener('click', nextIdea);
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
      // 电脑端快捷键：Alt+I 换一条灵感（手机键盘不会触发 Alt 组合）。
      if (e.altKey && (e.key === 'i' || e.key === 'I' || e.code === 'KeyI')) {
        e.preventDefault();
        nextIdea();
        return;
      }
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
        else if (act === 'timeskip') openTimeSkip();
        else if (act === 'genre') openGenrePop();
        else if (act === 'logout') doLogout();
        else if (act === 'atmosphere' && typeof Atmosphere !== 'undefined') Atmosphere.openSettings();
        else if (act === 'read' && typeof Atmosphere !== 'undefined') Atmosphere.cycleReading();
        else if (act === 'writing') cycleWriting();
        else if (act === 'adult-llm') openAdultLlmPop();
      });
    });

    // ---- 时光推进：桌面地点行标签点击打开弹层 ----
    $('g-timeskip').addEventListener('click', function (e) {
      e.stopPropagation();
      openTimeSkip();
    });

    // ---- 成人模式模型设置：桌面标签点开弹层；点弹层 / 标签 / 菜单项之外收起 ----
    if ($('g-adult-llm')) {
      $('g-adult-llm').addEventListener('click', function (e) {
        e.stopPropagation();
        openAdultLlmPop();
      });
      document.addEventListener('click', function (e) {
        var pop = $('adult-llm-pop');
        if (pop && !pop.hidden && !pop.contains(e.target)
            && e.target !== $('g-adult-llm') && !$('menu-adult-llm').contains(e.target)) {
          pop.hidden = true;
        }
      });
    }

    // ---- 文风：桌面地点行标签点击弹出选择列表；点列表 / 标签 / 菜单项之外收起 ----
    $('g-genre').addEventListener('click', function (e) {
      e.stopPropagation();
      openGenrePop();
    });
    document.addEventListener('click', function (e) {
      var pop = $('genre-pop');
      if (!pop.hidden && !pop.contains(e.target)
          && e.target !== $('g-genre') && !$('menu-genre').contains(e.target)) {
        pop.hidden = true;
      }
    });

    // 软键盘弹出 / 收起（visualViewport 尺寸变化）：只保证输入框可见，不把叙事滚到底。
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        if (window.innerWidth > 600) return;
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
    if ($('btn-atmosphere')) $('btn-atmosphere').addEventListener('click', function () { Atmosphere.toggle(); });
    if ($('g-atmosphere-settings')) $('g-atmosphere-settings').addEventListener('click', function () { Atmosphere.openSettings(); });
    if ($('g-read')) $('g-read').addEventListener('click', function () { Atmosphere.cycleReading(); });
    if ($('g-writing')) $('g-writing').addEventListener('click', function () { cycleWriting(); });
    api('/api/me').then(renderPlayerInfo).catch(function () {});
    route();
  }

  boot();
