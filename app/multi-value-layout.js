;(function(global) {
  'use strict';
  var manualColumnWidths = [];
  var autoHugColumns = [];
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

  /** True width of value text: scrollWidth lies when cells are max-width constrained + ellipsis. */
  function measureIntrinsicObjValueCellWidth(cell) {
    if (!cell) return MIN_COL_WIDTH;
    var inner = cell.querySelector('.obj-value-render');
    var prev = {
      flexBasis: cell.style.flexBasis,
      minWidth: cell.style.minWidth,
      maxWidth: cell.style.maxWidth,
      overflow: cell.style.overflow,
      textOverflow: cell.style.textOverflow,
      innerMax: inner ? inner.style.maxWidth : '',
      innerOv: inner ? inner.style.overflow : '',
    };
    try {
      cell.style.flexBasis = 'auto';
      cell.style.minWidth = 'min-content';
      cell.style.maxWidth = 'none';
      cell.style.overflow = 'visible';
      cell.style.textOverflow = 'clip';
      if (inner) {
        inner.style.maxWidth = 'none';
        inner.style.overflow = 'visible';
      }
      void cell.offsetWidth;
      var sw = cell.scrollWidth;
      if (!(sw > 0) || !Number.isFinite(sw)) sw = cell.getBoundingClientRect().width || 0;
      return Math.max(MIN_COL_WIDTH, Math.ceil(sw));
    } finally {
      cell.style.flexBasis = prev.flexBasis;
      cell.style.minWidth = prev.minWidth;
      cell.style.maxWidth = prev.maxWidth;
      cell.style.overflow = prev.overflow;
      cell.style.textOverflow = prev.textOverflow;
      if (inner) {
        inner.style.maxWidth = prev.innerMax;
        inner.style.overflow = prev.innerOv;
      }
    }
  }

  /** Header label width when not squeezed by applied column widths. */
  function measureIntrinsicHeaderButtonWidth(btn) {
    if (!btn) return MIN_COL_WIDTH;
    var span = btn.querySelector('.multi-value-col-label-text');
    var prev = {
      flexBasis: btn.style.flexBasis,
      minWidth: btn.style.minWidth,
      maxWidth: btn.style.maxWidth,
      overflow: btn.style.overflow,
      spanMax: span ? span.style.maxWidth : '',
      spanOv: span ? span.style.overflow : '',
    };
    try {
      btn.style.flexBasis = 'auto';
      btn.style.minWidth = 'min-content';
      btn.style.maxWidth = 'none';
      btn.style.overflow = 'visible';
      if (span) {
        span.style.maxWidth = 'none';
        span.style.overflow = 'visible';
      }
      void btn.offsetWidth;
      var sw = btn.scrollWidth;
      if (!(sw > 0) || !Number.isFinite(sw)) sw = btn.getBoundingClientRect().width || 0;
      return Math.max(MIN_COL_WIDTH, Math.ceil(sw));
    } finally {
      btn.style.flexBasis = prev.flexBasis;
      btn.style.minWidth = prev.minWidth;
      btn.style.maxWidth = prev.maxWidth;
      btn.style.overflow = prev.overflow;
      if (span) {
        span.style.maxWidth = prev.spanMax;
        span.style.overflow = prev.spanOv;
      }
    }
  }

  function measureValueCellContentWidth(cell) {
    if (!cell) return MIN_COL_WIDTH;
    var sw = cell.scrollWidth;
    if (!(sw > 0) || !Number.isFinite(sw)) sw = cell.getBoundingClientRect().width || 0;
    return Math.max(MIN_COL_WIDTH, Math.ceil(sw));
  }

  function measureHeaderButtonContentWidth(btn) {
    if (!btn) return MIN_COL_WIDTH;
    var sw = btn.scrollWidth;
    if (!(sw > 0) || !Number.isFinite(sw)) sw = btn.getBoundingClientRect().width || 0;
    return Math.max(MIN_COL_WIDTH, Math.ceil(sw));
  }

  function computeResolvedWidths(ctx, colCount) {
    var labelsWrap = document.getElementById('multi-value-col-labels');
    var feedInner = ctx.feedInner;
    var widths = new Array(colCount).fill(MIN_COL_WIDTH);
    var wraps = Array.from(feedInner.querySelectorAll('.obj[data-id] .obj-values-wrap'));
    wraps.forEach(function(wrap) {
      var cells = wrap.querySelectorAll(':scope > .obj-value-cell');
      for (var i = 0; i < colCount; i++) {
        var cell = cells[i];
        if (!cell) continue;
        var cw = measureValueCellContentWidth(cell);
        if (cw > widths[i]) widths[i] = cw;
      }
    });
    if (labelsWrap) {
      var btns = labelsWrap.querySelectorAll('.multi-value-col-label-btn');
      for (var b = 0; b < btns.length && b < colCount; b++) {
        var bw = measureHeaderButtonContentWidth(btns[b]);
        if (bw > widths[b]) widths[b] = bw;
      }
      // Auto-hug columns keep tracking intrinsic (untruncated) content width.
      for (var ai = 0; ai < colCount; ai++) {
        if (!autoHugColumns[ai]) continue;
        var want = 0;
        var hdrBtn = btns[ai];
        if (hdrBtn) want = Math.max(want, measureIntrinsicHeaderButtonWidth(hdrBtn));
        wraps.forEach(function(wrap) {
          var cells = wrap.querySelectorAll(':scope > .obj-value-cell');
          var cell = cells[ai];
          if (!cell) return;
          var cw = measureIntrinsicObjValueCellWidth(cell);
          if (cw > want) want = cw;
        });
        widths[ai] = Math.max(widths[ai], clampColWidth(want));
      }
    }
    for (var k = 0; k < colCount; k++) {
      if (autoHugColumns[k]) widths[k] = clampColWidth(widths[k]);
      else if (manualColumnWidths[k] != null) widths[k] = clampColWidth(manualColumnWidths[k]);
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
    function applyAutoFitForColumn() {
      var width = measureIntrinsicHeaderButtonWidth(btn);
      var feedInner = ctx && ctx.feedInner;
      if (feedInner) {
        var wraps = Array.from(feedInner.querySelectorAll('.obj[data-id] .obj-values-wrap'));
        wraps.forEach(function(wrap) {
          var cells = wrap.querySelectorAll(':scope > .obj-value-cell');
          var cell = cells[colIdx];
          if (!cell) return;
          var cw = measureIntrinsicObjValueCellWidth(cell);
          if (cw > width) width = cw;
        });
      }
      manualColumnWidths[colIdx] = clampColWidth(width);
      autoHugColumns[colIdx] = true;
      var labelsWrap = document.getElementById('multi-value-col-labels');
      var count = labelsWrap ? labelsWrap.querySelectorAll('.multi-value-col-label-btn').length : 0;
      if (count > 0) {
        var resolved = computeResolvedWidths(ctx, count);
        applyColumnWidths(resolved, ctx);
      }
      if (ctx && typeof ctx.onColumnWidthsChanged === 'function') {
        try { ctx.onColumnWidthsChanged(); } catch (_) {}
      }
    }
    handle.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener('dblclick', function(e) {
      e.preventDefault();
      e.stopPropagation();
      applyAutoFitForColumn();
    });
    handle.addEventListener('pointerdown', function(e) {
      e.preventDefault();
      e.stopPropagation();
      // Manual drag-resize disables auto-hug for this column.
      autoHugColumns[colIdx] = false;
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
      autoHugColumns = [];
      return;
    }
    manualColumnWidths = widths.map(function(w) {
      if (w == null || w === '') return null;
      return clampColWidth(w);
    });
    autoHugColumns = manualColumnWidths.map(function() { return false; });
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
