;(function(global) {
  'use strict';

  function syncValueWrapsToHeaderScroll(scrollLeft, sourceWrap, ctx) {
    var feedInner = ctx.feedInner;
    if (!feedInner) return;
    var rows = feedInner.querySelectorAll('.obj .obj-values-wrap');
    rows.forEach(function(w) {
      if (!w || w === sourceWrap) return;
      if (Math.abs((w.scrollLeft || 0) - scrollLeft) < 1) return;
      w.scrollLeft = scrollLeft;
    });
  }

  function syncHeaderScrollToValueWrap(scrollLeft) {
    var colWrap = document.getElementById('multi-value-col-labels');
    if (!colWrap) return;
    if (Math.abs((colWrap.scrollLeft || 0) - scrollLeft) < 1) return;
    colWrap.scrollLeft = scrollLeft;
  }

  function bindValueWrapScrollSync(wrap, ctx) {
    if (!wrap || wrap.dataset.inoutColSyncBound === '1') return;
    wrap.dataset.inoutColSyncBound = '1';
    if (typeof ctx.bindVerticalWheelToHorizontalScroll === 'function') {
      ctx.bindVerticalWheelToHorizontalScroll(wrap);
    }
    wrap.addEventListener('scroll', function() {
      if (ctx.state.getInoutColScrollSyncing()) return;
      ctx.state.setInoutColScrollSyncing(true);
      var left = wrap.scrollLeft || 0;
      syncHeaderScrollToValueWrap(left);
      syncValueWrapsToHeaderScroll(left, wrap, ctx);
      ctx.state.setInoutColScrollSyncing(false);
    }, { passive: true });
  }

  function syncHeaderScrollFromPrimaryFeed(ctx) {
    var feedInner = ctx.feedInner;
    if (!feedInner) return;
    var firstWrap = feedInner.querySelector('.obj .obj-values-wrap');
    if (!firstWrap) {
      syncHeaderScrollToValueWrap(0);
      return;
    }
    bindValueWrapScrollSync(firstWrap, ctx);
    syncHeaderScrollToValueWrap(firstWrap.scrollLeft || 0);
  }

  function syncManageBarLabelButtonWidthsFromFeed(ctx) {
    var labelsWrap = document.getElementById('multi-value-col-labels');
    var feedInner = ctx.feedInner;
    if (!labelsWrap || !feedInner) return;
    var btns = labelsWrap.querySelectorAll('.multi-value-col-label-btn');
    if (!btns.length) return;
    var wraps = Array.from(feedInner.querySelectorAll('.obj[data-id] .obj-values-wrap'));
    if (!wraps.length) {
      btns.forEach(function(btn) {
        btn.style.removeProperty('flex-basis');
        btn.style.removeProperty('min-width');
        btn.style.removeProperty('max-width');
      });
      return;
    }
    var colCount = btns.length;
    var widths = new Array(colCount).fill(1);
    wraps.forEach(function(wrap) {
      var cells = wrap.querySelectorAll(':scope > .obj-value-cell');
      for (var i = 0; i < colCount; i++) {
        var cell = cells[i];
        if (!cell) continue;
        var cw = Math.max(1, Math.ceil(cell.getBoundingClientRect().width));
        if (cw > widths[i]) widths[i] = cw;
      }
    });
    var cs = null;
    try { cs = window.getComputedStyle(labelsWrap); } catch (_) {}
    var gapPx = 0;
    if (cs) {
      var g = parseFloat(cs.columnGap || cs.gap || '0');
      if (Number.isFinite(g)) gapPx = Math.max(0, g);
    }
    var total = widths.reduce(function(a, b) { return a + b; }, 0) + Math.max(0, colCount - 1) * gapPx;
    var avail = Math.max(0, Math.floor(labelsWrap.clientWidth || 0));
    if (avail > total && colCount > 0) {
      var extra = avail - total;
      var add = extra / colCount;
      for (var j = 0; j < colCount; j++) widths[j] += add;
    }
    wraps.forEach(function(wrap) {
      var cells = wrap.querySelectorAll(':scope > .obj-value-cell');
      for (var i = 0; i < colCount; i++) {
        var cell = cells[i];
        if (!cell) continue;
        var w = Math.max(1, Math.round(widths[i]));
        cell.style.flexBasis = w + 'px';
        cell.style.minWidth = w + 'px';
        cell.style.maxWidth = w + 'px';
      }
    });
    btns.forEach(function(btn, i) {
      var w = Math.max(1, Math.round(widths[i] || 1));
      btn.style.flexBasis = w + 'px';
      btn.style.minWidth = w + 'px';
      btn.style.maxWidth = w + 'px';
    });
  }

  function updateMultiValueColumnLabelButtonsActive(ctx) {
    var wrap = document.getElementById('multi-value-col-labels');
    if (!wrap) return;
    var idx = ctx.state.getInoutMultiValueColumnFilterIndex();
    wrap.querySelectorAll('.multi-value-col-label-btn').forEach(function(b) {
      var i = parseInt(b.getAttribute('data-value-index'), 10);
      var on = Number.isFinite(i) && i === idx;
      b.classList.toggle('multi-value-col-label-btn-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function rebuildMultiValueColumnLabelButtons(ctx) {
    var wrap = document.getElementById('multi-value-col-labels');
    var feedInner = ctx.feedInner;
    if (!wrap || !feedInner) return;
    var n = parseInt(feedInner.dataset.inoutValueCols, 10) || 1;
    if (ctx.state.getInoutMultiValueColumnFilterIndex() != null && ctx.state.getInoutMultiValueColumnFilterIndex() >= n) {
      ctx.state.setInoutMultiValueColumnFilterIndex(null);
    }
    wrap.replaceChildren();
    if (n < 2) return;
    var headerLabs = ctx.getColumnHeaderLabelsForFeed(feedInner);
    for (var i = 0; i < n; i++) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'manage-btn multi-value-col-label-btn multi-value-col-header-btn';
      btn.setAttribute('data-value-index', String(i));
      var lab = headerLabs.length > i && String(headerLabs[i] || '').trim() ? headerLabs[i] : ctx.valueColumnHeaderLabel(i);
      btn.textContent = lab;
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('title', 'Filter by "' + lab + '". Double-click to rename. Click again to clear filter.');
      btn.setAttribute('aria-label', 'Column header: ' + lab + '. Click to filter, double-click to rename.');
      wrap.appendChild(btn);
    }
    updateMultiValueColumnLabelButtonsActive(ctx);
    syncManageBarLabelButtonWidthsFromFeed(ctx);
  }

  global.InoutMultiValueLayout = global.InoutMultiValueLayout || {};
  global.InoutMultiValueLayout.syncValueWrapsToHeaderScroll = syncValueWrapsToHeaderScroll;
  global.InoutMultiValueLayout.syncHeaderScrollToValueWrap = syncHeaderScrollToValueWrap;
  global.InoutMultiValueLayout.bindValueWrapScrollSync = bindValueWrapScrollSync;
  global.InoutMultiValueLayout.syncHeaderScrollFromPrimaryFeed = syncHeaderScrollFromPrimaryFeed;
  global.InoutMultiValueLayout.syncManageBarLabelButtonWidthsFromFeed = syncManageBarLabelButtonWidthsFromFeed;
  global.InoutMultiValueLayout.updateMultiValueColumnLabelButtonsActive = updateMultiValueColumnLabelButtonsActive;
  global.InoutMultiValueLayout.rebuildMultiValueColumnLabelButtons = rebuildMultiValueColumnLabelButtons;
})(typeof window !== 'undefined' ? window : this);
