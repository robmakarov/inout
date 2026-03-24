;(function(global) {
  'use strict';

  function advanceScrollEdgeThenWrap(el, axis, delta, _interactionId, stateMap) {
    if (!el) return false;
    var d = Number(delta) || 0;
    if (Math.abs(d) < 0.01) return false;
    var max = axis === 'x'
      ? (el.scrollWidth - el.clientWidth)
      : (el.scrollHeight - el.clientHeight);
    if (!(max > 1)) return false;
    var prev = axis === 'x' ? (el.scrollLeft || 0) : (el.scrollTop || 0);
    var dir = d > 0 ? 1 : -1;
    var edgeKey = axis + ':' + String(dir);
    var state = stateMap.get(el) || null;
    var stateKey = state && typeof state === 'object' ? state.key : state;
    var now = Date.now();
    var atMin = prev <= 1;
    var atMax = prev >= max - 1;

    if (dir > 0) {
      if (!atMax) {
        var toMax = Math.min(max, prev + d);
        if (axis === 'x') el.scrollLeft = toMax;
        else el.scrollTop = toMax;
        if (toMax >= max - 1) stateMap.set(el, { key: edgeKey, armedAt: now });
        else stateMap.delete(el);
        return Math.abs(toMax - prev) > 0.01;
      }
      if (stateKey === edgeKey) {
        if (axis === 'x') el.scrollLeft = 0;
        else el.scrollTop = 0;
        stateMap.delete(el);
        return true;
      }
      stateMap.set(el, { key: edgeKey, armedAt: now });
      return false;
    }

    if (!atMin) {
      var toMin = Math.max(0, prev + d);
      if (axis === 'x') el.scrollLeft = toMin;
      else el.scrollTop = toMin;
      if (toMin <= 1) stateMap.set(el, { key: edgeKey, armedAt: now });
      else stateMap.delete(el);
      return Math.abs(toMin - prev) > 0.01;
    }
    if (stateKey === edgeKey) {
      if (axis === 'x') el.scrollLeft = max;
      else el.scrollTop = max;
      stateMap.delete(el);
      return true;
    }
    stateMap.set(el, { key: edgeKey, armedAt: now });
    return false;
  }

  function nearestVerticalScrollableAncestor(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement ? node.parentElement : null);
    while (el && el !== document.body && el !== document.documentElement) {
      try {
        var cs = window.getComputedStyle(el);
        var oy = String(cs.overflowY || cs.overflow || '');
        var verticalByStyle = /(auto|scroll|overlay)/.test(oy);
        if (verticalByStyle) {
          var max = el.scrollHeight - el.clientHeight;
          if (max > 1) return el;
        }
      } catch (_) {}
      el = el.parentElement;
    }
    return null;
  }

  function bindVerticalWheelToHorizontalScroll(el, ctx) {
    if (!el || el.dataset.inoutWheelHorizBound === '1') return;
    el.dataset.inoutWheelHorizBound = '1';
    var disableWrap = el.id === 'tabs';
    var wheelState = ctx && ctx.wheelState ? ctx.wheelState : null;
    var getFeedScrollSurfaceForElement = ctx && ctx.getFeedScrollSurfaceForElement
      ? ctx.getFeedScrollSurfaceForElement
      : function() { return null; };

    function routeWheelToFeed(deltaY) {
      if (Math.abs(Number(deltaY) || 0) < 0.01) return false;
      var surf = getFeedScrollSurfaceForElement(el);
      if (!surf || surf.scrollHeight - surf.clientHeight <= 1) return false;
      var prev = surf.scrollTop || 0;
      surf.scrollTop = prev + deltaY;
      return Math.abs((surf.scrollTop || 0) - prev) > 0.01;
    }

    el.addEventListener(
      'wheel',
      function(e) {
        var nowAt = Date.now();
        if (wheelState) {
          if (nowAt - wheelState.lastWheelAt > wheelState.gapMs) wheelState.interactionId++;
          wheelState.lastWheelAt = nowAt;
        }
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        var isColStrip =
          (el.classList && el.classList.contains('obj-values-wrap')) || el.id === 'multi-value-col-labels';
        if (isColStrip && !e.shiftKey) {
          if (routeWheelToFeed(e.deltaY)) e.preventDefault();
          return;
        }
        var cs = null;
        try { cs = window.getComputedStyle(el); } catch (_) {}
        var oy = cs ? String(cs.overflowY || cs.overflow || '') : '';
        var ox = cs ? String(cs.overflowX || cs.overflow || '') : '';
        var yScrollableByStyle = /(auto|scroll|overlay)/.test(oy);
        var xScrollableByStyle = /(auto|scroll|overlay)/.test(ox);
        var canY = yScrollableByStyle && (el.scrollHeight - el.clientHeight > 1);
        if (canY) return;
        var canX = xScrollableByStyle && (el.scrollWidth - el.clientWidth > 1);
        if (!canX) {
          if (routeWheelToFeed(e.deltaY)) e.preventDefault();
          return;
        }
        if (Math.abs(e.deltaY) < 0.01) return;
        if (disableWrap) {
          var prevLeft = el.scrollLeft || 0;
          var maxLeft = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));
          var nextLeft = Math.max(0, Math.min(maxLeft, prevLeft + e.deltaY));
          if (Math.abs(nextLeft - prevLeft) > 0.01) {
            el.scrollLeft = nextLeft;
            e.preventDefault();
            return;
          }
          if (routeWheelToFeed(e.deltaY)) e.preventDefault();
          return;
        }
        var prevLeft2 = el.scrollLeft || 0;
        var maxLeft2 = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));
        var nextLeft2 = Math.max(0, Math.min(maxLeft2, prevLeft2 + e.deltaY));
        if (Math.abs(nextLeft2 - prevLeft2) > 0.01) {
          el.scrollLeft = nextLeft2;
          e.preventDefault();
          return;
        }
        if (routeWheelToFeed(e.deltaY)) e.preventDefault();
      },
      { passive: false }
    );
  }

  function bindMultiviewWheelScrollCapture(ctx) {
    var mv = document.getElementById('multiview');
    if (!mv || mv.dataset.inoutWheelCapture === '1') return;
    mv.dataset.inoutWheelCapture = '1';
    var getFeedScrollSurface = ctx && ctx.getFeedScrollSurface
      ? ctx.getFeedScrollSurface
      : function(feed) { return feed; };

    function wheelDeltaY(e, refSize) {
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= Math.max(100, (refSize || 400) * 0.92);
      return dy;
    }
    mv.addEventListener(
      'wheel',
      function(e) {
        if (e.defaultPrevented) return;
        if (e.ctrlKey || e.metaKey) return;
        var t = e.target;
        if (t && t.nodeType === 3) t = t.parentElement;
        if (!t || !t.closest) return;
        if (t.closest('#user-modal-backdrop, #user-modal, #channel-modal-backdrop, #qr-modal-backdrop')) return;
        if (t.closest('.manage-bar-dropdown, #log-dropup-panel.open, .multi-value-filter-menu')) return;
        if (t.closest('[data-inout-wheel-horiz-bound="1"]')) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        var view = t.closest('#multiview .view');
        if (!view || !mv.contains(view)) return;
        var feed = view.querySelector('#feed') || view.querySelector('.feed');
        if (!feed) return;
        var surf = getFeedScrollSurface(feed);
        if (surf === feed && feed.contains(t)) return;
        var max = surf.scrollHeight - surf.clientHeight;
        if (max <= 0) return;
        var dy = wheelDeltaY(e, surf.clientHeight);
        e.preventDefault();
        surf.scrollTop = Math.max(0, Math.min(max, surf.scrollTop + dy));
      },
      { capture: true, passive: false }
    );
  }

  global.InoutScroll = global.InoutScroll || {};
  global.InoutScroll.advanceScrollEdgeThenWrap = advanceScrollEdgeThenWrap;
  global.InoutScroll.nearestVerticalScrollableAncestor = nearestVerticalScrollableAncestor;
  global.InoutScroll.bindVerticalWheelToHorizontalScroll = bindVerticalWheelToHorizontalScroll;
  global.InoutScroll.bindMultiviewWheelScrollCapture = bindMultiviewWheelScrollCapture;
})(typeof window !== 'undefined' ? window : this);
