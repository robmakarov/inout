;(function(global) {
  'use strict';

  function updateTabsUI(ctx) {
    var tabsEl = ctx.tabsEl;
    if (!tabsEl) return;
    var buttons = tabsEl.querySelectorAll('.tab[data-channel]');
    buttons.forEach(function(btn) {
      var ch = btn.getAttribute('data-channel') || 'main';
      if (ch === ctx.currentView()) btn.classList.add('tab-active');
      else btn.classList.remove('tab-active');
    });
  }

  function setTabChannelLoading(channelKey, on, ctx) {
    var tabsEl = ctx.tabsEl;
    if (!tabsEl) return;
    var want = channelKey != null ? String(channelKey) : '';
    tabsEl.querySelectorAll('.tab.tab-channel-loading').forEach(function(b) {
      b.classList.remove('tab-channel-loading');
    });
    if (!on || !want) return;
    var list = tabsEl.querySelectorAll('.tab[data-channel]');
    for (var i = 0; i < list.length; i++) {
      var btn = list[i];
      var ch = btn.getAttribute('data-channel') || 'main';
      if (ch === want) {
        btn.classList.add('tab-channel-loading');
        break;
      }
    }
  }

  function updateTabBadge(ch, ctx) {
    var tabsEl = ctx.tabsEl;
    if (!tabsEl) return;
    var btn = tabsEl.querySelector('.tab[data-channel="' + CSS.escape(ch) + '"]');
    if (!btn) return;
    var badge = btn.querySelector('.tab-badge');
    if (!badge) return;
    var n = ctx.unreadCounts.get(ch) || 0;
    if (n > 0) {
      badge.textContent = String(n);
      badge.classList.add('show');
    } else {
      badge.textContent = '';
      badge.classList.remove('show');
    }
  }

  function updateAllTabBadges(ctx) {
    ctx.viewNames().forEach(function(ch) { updateTabBadge(ch, ctx); });
  }

  function renderTabs(ctx) {
    var tabsEl = ctx.tabsEl;
    if (!tabsEl) return;
    tabsEl.innerHTML = '';

    ctx.viewNames().forEach(function(ch) {
      var btn = document.createElement('button');
      btn.className = 'tab';
      btn.setAttribute('data-channel', ch);
      if (ch !== 'main') btn.setAttribute('draggable', 'true');
      var label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = ctx.getViewDisplayName(ch);
      btn.appendChild(label);

      if (ctx.sharedChannels.has(ch) && ch !== 'main') {
        var shared = document.createElement('span');
        shared.className = 'tab-shared';
        shared.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M16 11c1.657 0 3-1.567 3-3.5S17.657 4 16 4s-3 1.567-3 3.5S14.343 11 16 11Z" stroke="currentColor" stroke-width="1.6"/><path d="M8 11c1.657 0 3-1.567 3-3.5S9.657 4 8 4 5 5.567 5 7.5 6.343 11 8 11Z" stroke="currentColor" stroke-width="1.6"/><path d="M4 20c0-3.314 2.686-6 6-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M14 14c3.314 0 6 2.686 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 14c1.7 0 3.24.71 4.33 1.85" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
        btn.appendChild(shared);
      }

      var badge = document.createElement('span');
      badge.className = 'tab-badge';
      btn.appendChild(badge);

      if (ch !== 'main') {
        var close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '×';
        close.addEventListener('click', function(e) {
          e.stopPropagation();
          ctx.deleteChannel(ch);
        });
        btn.appendChild(close);
      }

      btn.addEventListener('dblclick', function(e) {
        e.preventDefault();
        e.stopPropagation();
        ctx.clearPendingViewSwitchClick();
        if (!ctx.inoutHydratingWorkspace()) setTabChannelLoading(ch, false, ctx);
        try {
          if (typeof ctx.renameView === 'function') ctx.renameView(ch, btn);
        } catch (_) {}
      });

      btn.addEventListener('click', function() {
        var viewAtClick = ctx.currentView();
        var channelAtClick = ctx.currentChannel();
        ctx.clearPendingViewSwitchClick();
        if (!ctx.inoutHydratingWorkspace()) {
          var sameTabAtClick = ch === viewAtClick && ch === channelAtClick;
          var slot0AtClick = ctx.inputSlots && ctx.inputSlots[0];
          var slotMismatchAtClick =
            ctx.primarySlotAutoTarget() && slot0AtClick && String(slot0AtClick.channel || '') !== String(ch);
          if (!sameTabAtClick || slotMismatchAtClick) setTabChannelLoading(ch, true, ctx);
        }
        var tabBtn =
          tabsEl && tabsEl.querySelector
            ? tabsEl.querySelector('.tab[data-channel="' + CSS.escape(String(ch)) + '"]')
            : null;
        if (tabBtn && tabBtn.querySelector('.tab-rename-input')) {
          if (!ctx.inoutHydratingWorkspace()) setTabChannelLoading(ch, false, ctx);
          return;
        }
        ctx.switchChannel(ch);
      });

      btn.addEventListener('dragenter', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        tabsEl.querySelectorAll('.tab.tab-drop-target').forEach(function(t) { t.classList.remove('tab-drop-target'); });
        btn.classList.add('tab-drop-target');
      });
      btn.addEventListener('dragstart', function(e) {
        if (ch === 'main') return;
        btn.classList.add('tab-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('application/x-inout-tab-channel', String(ch)); } catch (_) {}
        }
      });
      btn.addEventListener('dragend', function() {
        btn.classList.remove('tab-dragging');
        tabsEl.querySelectorAll('.tab.tab-drop-target').forEach(function(t) { t.classList.remove('tab-drop-target'); });
      });
      btn.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        btn.classList.add('tab-drop-target');
      });
      btn.addEventListener('dragleave', function(e) {
        if (!btn.contains(e.relatedTarget)) btn.classList.remove('tab-drop-target');
      });
      btn.addEventListener('drop', function(e) {
        e.preventDefault();
        ctx.setDragDropHandled(true);
        btn.classList.remove('tab-drop-target');
        var tabFrom = e.dataTransfer.getData('application/x-inout-tab-channel');
        if (tabFrom) {
          if (typeof ctx.reorderTabChannels === 'function') ctx.reorderTabChannels(tabFrom, ch);
          return;
        }
        var id = e.dataTransfer.getData('application/x-inout-obj-id') || e.dataTransfer.getData('text/plain');
        if (!id || ch === ctx.currentChannel()) return;
        var numId = Number(id);
        if (!Number.isFinite(numId)) return;
        var rowEl = ctx.feedInner.querySelector('.obj[data-id="' + CSS.escape(String(numId)) + '"]');
        if (rowEl) {
          ctx.animateObjectToTab(rowEl, btn, async function() {
            var ok = await ctx.moveSingleObject(numId, ch);
            if (!ok) rowEl.style.visibility = '';
          });
        } else {
          ctx.moveSingleObject(numId, ch);
        }
      });
      tabsEl.appendChild(btn);
    });

    var addBtn = document.createElement('button');
    addBtn.className = 'tab tab-new';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', ctx.openChannelModal);
    tabsEl.appendChild(addBtn);

    updateTabsUI(ctx);
    updateAllTabBadges(ctx);
    ctx.refreshMoveTargets();
    ctx.syncComposerTargetSelects();
  }

  function setupTabs(ctx) {
    renderTabs(ctx);
    if (ctx.tabsEl) ctx.bindVerticalWheelToHorizontalScroll(ctx.tabsEl);
    if (!document.body.dataset.inoutGlobalWheelFallbackBound) {
      document.body.dataset.inoutGlobalWheelFallbackBound = '1';
      document.addEventListener('wheel', function(e) {
        if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
        var dy = Number(e.deltaY) || 0;
        if (Math.abs(dy) < 0.01) return;
        var targetEl = e.target && e.target.nodeType === 1
          ? e.target
          : (e.target && e.target.parentElement ? e.target.parentElement : null);
        var horizZone = targetEl && targetEl.closest
          ? targetEl.closest('[data-inout-wheel-horiz-bound="1"]')
          : null;
        if (horizZone) return;
        var nowAt = Date.now();
        ctx.wheelState.setLastWheelAt(nowAt);
        var verticalTarget = ctx.nearestVerticalScrollableAncestor(targetEl || e.target);
        if (verticalTarget) {
          var prevTop = verticalTarget.scrollTop || 0;
          var maxTop = Math.max(0, (verticalTarget.scrollHeight || 0) - (verticalTarget.clientHeight || 0));
          var nextTop = Math.max(0, Math.min(maxTop, prevTop + dy));
          if (Math.abs(nextTop - prevTop) > 0.01) {
            verticalTarget.scrollTop = nextTop;
            e.preventDefault();
          }
          return;
        }
        if (ctx.routeWheelDeltaToPrimaryView(dy)) e.preventDefault();
      }, { passive: false, capture: true });
    }
    var manageBar = document.getElementById('manage-bar');
    var manageBarTrigger = document.getElementById('manage-bar-trigger');
    if (manageBar && manageBarTrigger) {
      function closeManageBarDropdown() {
        if (typeof ctx.clearManageBarDropdownPosition === 'function') ctx.clearManageBarDropdownPosition();
        manageBar.classList.remove('manage-bar-open');
        manageBarTrigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('click', closeManageBarDropdown);
        if (typeof ctx.closeLogDropup === 'function') ctx.closeLogDropup();
        if (typeof ctx.notifyWorkspaceChromeChanged === 'function') ctx.notifyWorkspaceChromeChanged();
      }
      manageBarTrigger.addEventListener('click', function(e) {
        e.stopPropagation();
        ctx.closeInoutMultiValueFilterMenu();
        var isOpen = manageBar.classList.toggle('manage-bar-open');
        manageBarTrigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
          document.addEventListener('click', closeManageBarDropdown);
          if (typeof ctx.positionManageBarDropdownClamp === 'function') ctx.positionManageBarDropdownClamp();
        } else {
          document.removeEventListener('click', closeManageBarDropdown);
          if (typeof ctx.clearManageBarDropdownPosition === 'function') ctx.clearManageBarDropdownPosition();
        }
        if (typeof ctx.notifyWorkspaceChromeChanged === 'function') ctx.notifyWorkspaceChromeChanged();
      });
    }
    try {
      var rs = document.querySelector('.manage-bar-start');
      if (rs && typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function() { ctx.syncInoutManageRailWidthVar(); });
        ro.observe(rs);
      }
      var fi = document.getElementById('feed-inner');
      if (fi && typeof ResizeObserver !== 'undefined') {
        var roFeed = new ResizeObserver(function() {
          if (typeof ctx.syncInoutObjLeadingWidthVar === 'function') ctx.syncInoutObjLeadingWidthVar();
        });
        roFeed.observe(fi);
      }
    } catch (_) {}
    ctx.syncInoutManageRailWidthVar();
    try {
      ctx.setupMultiValueChromeBar();
      if (typeof ctx.updateMultiValueChromeBar === 'function') ctx.updateMultiValueChromeBar();
    } catch (_) {}
    var dropdownResizeTimer = 0;
    function onDropdownViewportResize() {
      clearTimeout(dropdownResizeTimer);
      dropdownResizeTimer = setTimeout(function() {
        if (typeof ctx.repositionOpenDropdownsToViewport === 'function') ctx.repositionOpenDropdownsToViewport();
      }, 50);
    }
    window.addEventListener('resize', onDropdownViewportResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onDropdownViewportResize);
  }

  global.InoutTabsUi = global.InoutTabsUi || {};
  global.InoutTabsUi.setupTabs = setupTabs;
  global.InoutTabsUi.renderTabs = renderTabs;
  global.InoutTabsUi.updateTabsUI = updateTabsUI;
  global.InoutTabsUi.setTabChannelLoading = setTabChannelLoading;
  global.InoutTabsUi.updateTabBadge = updateTabBadge;
  global.InoutTabsUi.updateAllTabBadges = updateAllTabBadges;
})(typeof window !== 'undefined' ? window : this);
