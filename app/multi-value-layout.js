;(function(global) {
  'use strict';
  var manualColumnWidths = [];
  var MIN_COL_WIDTH = 56;
  var MAX_COL_WIDTH = 1400;

  function clampColWidth(w) {
    var n = Math.round(Number(w) || 0);
    if (n < MIN_COL_WIDTH) return MIN_COL_WIDTH;
    if (n > MAX_COL_WIDTH) return MAX_COL_WIDTH;
    return n;
  }

  function applyColumnWidths(widths, ctx) {
    var labelsWrap = document.getElementById('multi-value-col-labels');
    var feedInner = ctx.feedInner;
    if (!labelsWrap || !feedInner) return;
    var btns = labelsWrap.querySelectorAll('.multi-value-col-label-btn');
    var wraps = Array.from(feedInner.querySelectorAll('.obj[data-id] .obj-values-wrap'));
    wraps.forEach(function(wrap) {
      var cells = wrap.querySelectorAll(':scope > .obj-value-cell');
      for (var i = 0; i < widths.length; i++) {
        var cell = cells[i];
        if (!cell) continue;
        var w = clampColWidth(widths[i]);
        cell.style.flexBasis = w + 'px';
        cell.style.minWidth = w + 'px';
        cell.style.maxWidth = w + 'px';
      }
    });
    btns.forEach(function(btn, i) {
      var w = clampColWidth(widths[i] || 1);
      btn.style.flexBasis = w + 'px';
      btn.style.minWidth = w + 'px';
      btn.style.maxWidth = w + 'px';
    });
  }

  function computeResolvedWidths(ctx, colCount) {
    var labelsWrap = document.getElementById('multi-value-col-labels');
    var feedInner = ctx.feedInner;
    var wraps = Array.from(feedInner.querySelectorAll('.obj[data-id] .obj-values-wrap'));
    var widths = new Array(colCount).fill(1);
    if (wraps.length) {
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
    }
    for (var k = 0; k < colCount; k++) {
      if (manualColumnWidths[k] != null) widths[k] = clampColWidth(manualColumnWidths[k]);
      else widths[k] = clampColWidth(widths[k]);
    }
    return widths;
  }

  function bindColumnResizeHandle(btn, colIdx, ctx) {
    if (!btn || btn.dataset.inoutResizeBound === '1') return;
    btn.dataset.inoutResizeBound = '1';
    var handle = document.createElement('span');
    handle.className = 'multi-value-col-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    btn.appendChild(handle);
    handle.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var startX = Number(e.clientX) || 0;
      var startW = Math.ceil(btn.getBoundingClientRect().width || 0);
      if (!(startW > 0)) startW = manualColumnWidths[colIdx] || 120;
      var active = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      function onMove(ev) {
        if (!active) return;
        var x = Number(ev.clientX) || startX;
        var next = clampColWidth(startW + (x - startX));
        manualColumnWidths[colIdx] = next;
        var labelsWrap = document.getElementById('multi-value-col-labels');
        var count = labelsWrap ? labelsWrap.querySelectorAll('.multi-value-col-label-btn').length : 0;
        if (count > 0) {
          var widths = computeResolvedWidths(ctx, count);
          applyColumnWidths(widths, ctx);
        }
      }
      function onUp() {
        if (!active) return;
        active = false;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (ctx && typeof ctx.onColumnWidthsChanged === 'function') {
          try { ctx.onColumnWidthsChanged(); } catch (_) {}
        }
      }
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
  }

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
    var colCount = btns.length;
    var widths = computeResolvedWidths(ctx, colCount);
    applyColumnWidths(widths, ctx);
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
      btn.setAttribute('draggable', 'true');
      var lab = headerLabs.length > i && String(headerLabs[i] || '').trim() ? headerLabs[i] : ctx.valueColumnHeaderLabel(i);
      var labSpan = document.createElement('span');
      labSpan.className = 'multi-value-col-label-text';
      labSpan.textContent = lab;
      btn.appendChild(labSpan);
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('title', 'Filter by "' + lab + '". Double-click to rename. Click again to clear filter.');
      btn.setAttribute('aria-label', 'Column header: ' + lab + '. Click to filter, double-click to rename.');
      wrap.appendChild(btn);
      bindColumnResizeHandle(btn, i, ctx);
    }
    if (manualColumnWidths.length > n) manualColumnWidths = manualColumnWidths.slice(0, n);
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
  global.InoutMultiValueLayout.getManualColumnWidths = function() {
    return manualColumnWidths.slice();
  };
  global.InoutMultiValueLayout.setManualColumnWidths = function(widths, ctx) {
    if (!Array.isArray(widths)) {
      manualColumnWidths = [];
      return;
    }
    manualColumnWidths = widths.map(function(w) {
      if (w == null || w === '') return null;
      return clampColWidth(w);
    });
    if (ctx && ctx.feedInner) {
      var labelsWrap = document.getElementById('multi-value-col-labels');
      var count = labelsWrap ? labelsWrap.querySelectorAll('.multi-value-col-label-btn').length : 0;
      if (count > 0) {
        var resolved = computeResolvedWidths(ctx, count);
        applyColumnWidths(resolved, ctx);
      }
    }
  };
})(typeof window !== 'undefined' ? window : this);
