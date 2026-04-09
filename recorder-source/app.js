(function () {
  if (location.protocol === "file:") {
    return;
  }

  const snipeBtn = document.getElementById("snipe");
  const statusEl = document.getElementById("status");
  const recordPanel = document.getElementById("record-panel");
  const recordStopBtn = document.getElementById("record-stop");
  const scadaCluster = document.getElementById("scada-cluster");
  const scadaColumnMass = document.getElementById("scada-column-mass");
  const captureStudio = document.getElementById("capture-studio");
  const hubSnipeSlot = document.getElementById("hub-snipe-slot");
  const hubInputRow = document.getElementById("hub-input-row");
  const studioAwaitPlaceholder = document.getElementById("studio-await-placeholder");
  const hubRecordCancel = document.getElementById("hub-record-cancel");
  const hubRecordSave = document.getElementById("hub-record-save");
  const studioVideo = document.getElementById("studio-video");
  const studioVideoWrap = document.getElementById("studio-video-wrap");
  const studioVideoFrame = document.getElementById("studio-video-frame");
  const studioOverlay = document.getElementById("studio-overlay");
  const studioRegionEl = document.getElementById("studio-region");
  const recordElapsedEl = document.getElementById("record-elapsed");
  const recordBytesEl = document.getElementById("record-bytes");
  const recordMetricsEl = document.getElementById("record-metrics");
  const studioReview = document.getElementById("studio-review");
  const previewFilename = document.getElementById("preview-filename");
  const previewDiscardBtn = document.getElementById("preview-discard");
  const previewSaveBtn = document.getElementById("preview-save");
  const previewTrimTrack = document.getElementById("preview-trim-track");
  const previewTrimRange = document.getElementById("preview-trim-range");
  const previewTrimIn = document.getElementById("preview-trim-in");
  const previewTrimOut = document.getElementById("preview-trim-out");
  const previewTrimSplits = document.getElementById("preview-trim-splits");
  const studioResizeHandle = document.getElementById("studio-resize-handle");

  (function initBgGridPointerTilt() {
    const root = document.documentElement;
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    /** Smaller motion than before; slightly snappier lerp so bg keeps up while studio width animates. */
    const BG_LERP = 0.11;
    const BG_SHIFT_MAX_PX = 10;
    let curX = 0;
    let curY = 0;
    let tgtX = 0;
    let tgtY = 0;
    let rafId = 0;

    function clearBgVars() {
      root.style.removeProperty("--bg-tilt-x");
      root.style.removeProperty("--bg-tilt-y");
      root.style.removeProperty("--bg-shift-x");
      root.style.removeProperty("--bg-shift-y");
    }

    function tick() {
      rafId = 0;
      curX += (tgtX - curX) * BG_LERP;
      curY += (tgtY - curY) * BG_LERP;
      root.style.setProperty("--bg-tilt-x", curX.toFixed(5));
      root.style.setProperty("--bg-tilt-y", curY.toFixed(5));
      root.style.setProperty("--bg-shift-x", `${(curX * BG_SHIFT_MAX_PX).toFixed(2)}px`);
      root.style.setProperty("--bg-shift-y", `${(curY * BG_SHIFT_MAX_PX).toFixed(2)}px`);
      if (
        Math.abs(tgtX - curX) > 0.0008 ||
        Math.abs(tgtY - curY) > 0.0008
      ) {
        rafId = requestAnimationFrame(tick);
      }
    }

    function schedule() {
      if (mqReduce.matches) return;
      if (!rafId) rafId = requestAnimationFrame(tick);
    }

    document.addEventListener(
      "mousemove",
      (e) => {
        if (mqReduce.matches) return;
        const cx = window.innerWidth * 0.5;
        const cy = window.innerHeight * 0.5;
        tgtX = Math.max(-1, Math.min(1, (e.clientX - cx) / Math.max(cx, 1)));
        tgtY = Math.max(-1, Math.min(1, (e.clientY - cy) / Math.max(cy, 1)));
        schedule();
      },
      { passive: true }
    );

    function onReduceChange() {
      if (mqReduce.matches) {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        clearBgVars();
      }
    }

    if (mqReduce.addEventListener) {
      mqReduce.addEventListener("change", onReduceChange);
    } else {
      mqReduce.addListener(onReduceChange);
    }
    onReduceChange();
  })();

  if (
    !snipeBtn ||
    !statusEl ||
    !recordPanel ||
    !recordStopBtn ||
    !scadaCluster ||
    !captureStudio ||
    !hubInputRow ||
    !hubSnipeSlot ||
    !studioVideo ||
    !studioVideoWrap ||
    !studioVideoFrame ||
    !studioOverlay ||
    !studioRegionEl ||
    !recordElapsedEl ||
    !recordBytesEl ||
    !recordMetricsEl ||
    !studioReview ||
    !previewFilename ||
    !previewDiscardBtn ||
    !previewSaveBtn ||
    !previewTrimTrack ||
    !previewTrimRange ||
    !previewTrimIn ||
    !previewTrimOut ||
    !previewTrimSplits ||
    !studioResizeHandle
  ) {
    return;
  }

  const MIN_TRIM_SEC = 0.12;
  const FULL_TRIM_EPS = 0.07;
  const QUALITY_STORAGE_KEY = "screen-recorder-quality";
  const INPUT_INTENT_STORAGE_KEY = "screen-recorder-input-intent";
  const DEVICE_DISPLAY_NAMES_KEY = "screen-recorder-device-display-names";
  const DEFAULT_CUSTOM_VIDEO = "Screen";
  const DEFAULT_CUSTOM_SYS = "Sound";

  let recordSession = null;
  let studioCapture = null;
  let pendingPreview = null;
  /** @type {null | 'in' | 'out'} */
  let trimDragKind = null;
  let studioDisplayEndedHandler = null;
  /** Normalized crop in video pixel space: 0–1 relative to videoWidth/Height */
  let studioRegionNorm = null;
  /** @type {null | { x0: number; y0: number; x1: number; y1: number }} */
  let regionDragClient = null;
  /** Prior wired display capture — stream id alone can repeat across picks in some builds; also track surface + size. */
  let lastWiredDisplayWireMeta = null;
  /** Last intrinsic size of #studio-video preview — when it changes, region norm from the previous share is invalid. */
  let lastStudioPreviewIntrinsic = null;
  /** Prevents overlapping snipe flows; button stays clickable (not disabled) during picker. */
  let snipeArming = false;
  /** @type {number | null} */
  let studioMeterRafId = null;
  let studioVoiceToggleBusy = false;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let statusRevealTimer = null;

  const STUDIO_USER_W_KEY = "screen-recorder-studio-width-px";
  /** Must match `syncDeviceUiScale` — UI multiplier range (narrow studio / wide studio) */
  const DEVICE_UI_SCALE_MIN = 1.06;
  const DEVICE_UI_SCALE_MAX = 1.58;
  /** Ctrl+pinch wheel, pixel deltas (trackpad / Mac): higher = faster resize */
  const STUDIO_PINCH_WHEEL_GAIN_PIXEL = 1.08;
  /** Line-mode mouse wheel: lower gain + blend below = finer, smoother steps */
  const STUDIO_PINCH_WHEEL_GAIN_LINE = 0.36;
  /** Page-mode wheel (rare): between line and pixel feel */
  const STUDIO_PINCH_WHEEL_GAIN_PAGE = 0.92;
  /** Low-pass on line-mode dw (0–1): higher = smoother, more inertia between notches */
  const STUDIO_PINCH_WHEEL_LINE_SMOOTH = 0.44;
  /** WebKit trackpad pinch (Safari): exaggerate scale vs width (1 = native mapping) */
  const STUDIO_PINCH_GESTURE_BOOST = 2.12;
  let studioResizePtr = null;
  let studioResizeStartX = 0;
  let studioResizeStartY = 0;
  let studioResizeStartW = 0;
  /** @type {number | null} */
  let studioResizeRafId = null;
  /** @type {number | null} */
  let studioResizePendingW = null;
  /** @type {number | null} */
  let studioWidthAnimRaf = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let studioPinchSaveTimer = null;
  /** @type {boolean} */
  let studioWebkitPinchActive = false;
  /** @type {number} */
  let studioWebkitPinchBaseW = 0;
  /** Line-mode wheel delta smoothing (mouse) — reset when not using line mode */
  let studioPinchLineDwSmooth = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let studioPinchLineSmoothResetTimer = null;
  /** Coalesced rAF chain for shrinking studio when device settings + preview overflow the viewport */
  let studioSettingsViewportFitRaf1 = null;
  let studioSettingsViewportFitRaf2 = null;
  /** Debounce ResizeObserver → scheduleStudioFit bursts (one smooth pass) */
  let studioDeviceSettingsFitDebounceTimer = null;
  /** Fallback if opening cleanup doesn’t remove `scada-cluster--menu-nudge` first */
  let captureStudioMenuNudgeRemovalTimer = null;
  /** requestAnimationFrame id for #scada-column-mass menu lift (inline transform — reliable vs CSS animation) */
  let scadaColumnMenuLiftRafId = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let studioDeviceSettingsCloseFallbackTimer = null;
  /** Coalesce transitionend (max-height, margin, padding, gap) so finalize runs once after all close props finish */
  /** @type {ReturnType<typeof setTimeout> | null} */
  let studioDeviceSettingsCloseDebounceTimer = null;
  /** @type {((ev: TransitionEvent) => void) | null} */
  let studioDeviceSettingsCloseTransitionEndHandler = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let studioDeviceSettingsOpeningFallbackTimer = null;

  const STUDIO_MENU_STAGGER_STEP_MS = 24;
  /** Default matches `--studio-menu-slot-ms` fallback in styles.css */
  const STUDIO_MENU_SLOT_TRANSITION_MS = 700;
  /** Shorter slot when prefers-reduced-motion (still visible) */
  const STUDIO_MENU_SLOT_TRANSITION_REDUCE_MS = 320;
  const STUDIO_MENU_STAGGER_KEYFRAME_MS = STUDIO_MENU_SLOT_TRANSITION_MS;
  /** Must match `.studio-device-settings--closing` transition duration in styles.css */
  const STUDIO_MENU_CLOSE_TRANSITION_MS = 560;
  /** Window/visualViewport clamp & non-menu shrink — keep in family with slot animation */
  const STUDIO_VIEWPORT_WIDTH_ANIM_MS = 480;
  /** After last transitionend — let padding/gap/margin all settle before finalize */
  const STUDIO_MENU_CLOSE_TRANSITION_END_DEBOUNCE_MS = 36;
  /** Must match `transition` easing on `.studio-device-settings--closing` in styles.css */
  const STUDIO_MENU_CLOSE_WIDTH_EASE_X1 = 0.33;
  const STUDIO_MENU_CLOSE_WIDTH_EASE_Y1 = 1;
  const STUDIO_MENU_CLOSE_WIDTH_EASE_X2 = 0.32;
  const STUDIO_MENU_CLOSE_WIDTH_EASE_Y2 = 1;
  const CAPTURE_STUDIO_MENU_NUDGE_MS = 780;
  /** Extra horizontal budget subtracted from `studioMaxW()` while device settings is open (rings, shadows, nudge). */
  const STUDIO_MENU_OPEN_MAX_WIDTH_PAD_PX = 28;

  function clearCaptureStudioMenuNudgeTimer() {
    if (captureStudioMenuNudgeRemovalTimer != null) {
      clearTimeout(captureStudioMenuNudgeRemovalTimer);
      captureStudioMenuNudgeRemovalTimer = null;
    }
  }

  function stopScadaClusterMenuLift() {
    if (scadaColumnMenuLiftRafId != null) {
      cancelAnimationFrame(scadaColumnMenuLiftRafId);
      scadaColumnMenuLiftRafId = null;
    }
    scadaColumnMass?.classList.remove("scada-column-mass--menu-lift-active");
    scadaColumnMass?.style.removeProperty("transform");
    scadaColumnMass?.style.removeProperty("will-change");
    scadaCluster?.style.removeProperty("transition");
    scadaCluster?.style.removeProperty("transform");
  }

  /**
   * Live preview: ease #scada-column-mass up with the menu slot (rAF + inline transform).
   * CSS @keyframes/animationend were not reliably visible across engines and reflow from scheduleStudioFit.
   */
  function playScadaClusterMenuLiftIfLivePreview(slotMs) {
    stopScadaClusterMenuLift();
    if (!scadaColumnMass || !captureStudio) return;
    if (captureStudio.classList.contains("hidden")) return;
    if (!captureStudio.classList.contains("capture-studio--live-preview")) return;
    const duration = Math.max(280, Math.round(slotMs));
    const h = window.innerHeight || 800;
    const liftMax = Math.round(Math.min(100, Math.max(60, h * 0.092)));
    const ease = (u) => 1 - (1 - u) ** 3;
    const t0 = performance.now();
    scadaColumnMass.style.willChange = "transform";
    scadaColumnMass.style.transform = `translate3d(0, ${liftMax}px, 0)`;
    function frame(now) {
      const u = Math.min(1, (now - t0) / duration);
      const y = liftMax * (1 - ease(u));
      scadaColumnMass.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
      if (u < 1) {
        scadaColumnMenuLiftRafId = requestAnimationFrame(frame);
      } else {
        scadaColumnMenuLiftRafId = null;
        scadaColumnMass.style.removeProperty("transform");
        scadaColumnMass.style.removeProperty("will-change");
      }
    }
    scadaColumnMenuLiftRafId = requestAnimationFrame(frame);
  }

  function scheduleCaptureStudioMenuNudgeRemoval(durationMs) {
    clearCaptureStudioMenuNudgeTimer();
    const ms =
      typeof durationMs === "number" && durationMs > 0
        ? Math.min(12000, Math.round(durationMs + 80))
        : CAPTURE_STUDIO_MENU_NUDGE_MS;
    captureStudioMenuNudgeRemovalTimer = window.setTimeout(() => {
      captureStudioMenuNudgeRemovalTimer = null;
      stopScadaClusterMenuLift();
      scadaCluster?.classList.remove("scada-cluster--menu-nudge");
    }, ms);
  }

  function collectStudioDeviceMenuStaggerNodes(panel) {
    const list = [];
    const sections = panel.querySelectorAll(":scope > .studio-device-settings__section");
    for (const sec of sections) {
      const cs = getComputedStyle(sec);
      if (cs.display === "none") continue;
      const inner = sec.querySelector(":scope > .studio-deck__sig-menu-inner");
      if (!inner) continue;
      for (const colSel of [".studio-deck__sig-menu-col--left", ".studio-deck__sig-menu-col--right"]) {
        const col = inner.querySelector(`:scope > ${colSel}`);
        if (!col) continue;
        for (const child of col.children) {
          if (!(child instanceof HTMLElement)) continue;
          if (child.classList.contains("sr-only")) continue;
          list.push(child);
        }
      }
    }
    return list;
  }

  function applyStudioMenuStagger(panel) {
    const nodes = collectStudioDeviceMenuStaggerNodes(panel);
    nodes.forEach((el, i) => {
      el.classList.add("studio-menu-stagger");
      el.style.setProperty("--menu-stagger", String(i));
    });
    return nodes.length;
  }

  function cleanupStudioMenuStagger(panel) {
    if (!panel) return;
    panel.querySelectorAll(".studio-menu-stagger").forEach((el) => {
      el.classList.remove("studio-menu-stagger");
      el.style.removeProperty("--menu-stagger");
    });
    panel.classList.remove(
      "studio-device-settings--slot-expand",
      "studio-device-settings--stagger-run"
    );
    panel.style.removeProperty("--menu-slot-h");
    panel.style.removeProperty("max-height");
  }
  /** Snapshot of studio width when device settings opens; restored on close if user did not resize manually */
  let studioWidthBeforeDeviceMenuPx = null;
  let studioUserResizedWhileDeviceMenuOpen = false;
  /** Last studio width — used to smooth-scroll device strip to the left when width changes */
  let deviceBarStudioWidthAnchor = null;

  function studioCompactMaxPx() {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return Math.round(22 * rem);
  }

  function scrollStudioDeviceSignalsToLeft(smooth) {
    const el = document.getElementById("studio-device-signals-scroll");
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (smooth && !reduce) {
      el.scrollTo({ left: 0, behavior: "smooth" });
    } else {
      el.scrollLeft = 0;
    }
  }

  /** When gears collapse, scrollWidth shrinks and the browser clamps scrollLeft in one frame — feels like a teleport. */
  function smoothClampStudioDeviceBarScroll() {
    const el = document.getElementById("studio-device-signals-scroll");
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    if (el.scrollLeft <= max + 1) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      el.scrollLeft = max;
      return;
    }
    el.scrollTo({ left: max, behavior: "smooth" });
  }

  /** Keep the active chip in view while the strip width animates (gears collapsing). */
  function scrollStudioDeviceBarMenuFocusIntoView() {
    const scrollEl = document.getElementById("studio-device-signals-scroll");
    if (!scrollEl) return;
    const focus =
      scrollEl.querySelector(".studio-deck__sig-wrap--menu-focus") ||
      scrollEl.querySelector(".studio-deck__sig-group--menu-focus");
    if (!focus) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    focus.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      inline: "center",
      block: "nearest",
    });
  }

  function scheduleStudioDeviceBarScrollAssist() {
    const run = () => {
      smoothClampStudioDeviceBarScroll();
      scrollStudioDeviceBarMenuFocusIntoView();
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(run);
    });
    window.setTimeout(run, 120);
    window.setTimeout(run, 320);
    window.setTimeout(run, 620);
  }

  function syncScadaClusterStudioWide() {
    const live =
      !captureStudio.classList.contains("hidden") &&
      captureStudio.classList.contains("capture-studio--live-preview");
    if (!live) {
      scadaCluster.classList.remove("scada-cluster--studio-wide");
      deviceBarStudioWidthAnchor = null;
      document.documentElement.style.removeProperty("--studio-hub-width");
    } else {
      const compact = studioCompactMaxPx();
      let w = NaN;
      if (captureStudio.style.width && String(captureStudio.style.width).trim() !== "") {
        w = parseFloat(captureStudio.style.width);
      }
      if (!Number.isFinite(w) || w <= 0) {
        w = captureStudio.getBoundingClientRect().width;
      }
      scadaCluster.classList.toggle("scada-cluster--studio-wide", Number.isFinite(w) && w > compact + 0.5);
      /* Smooth scroll fights every width keyframe during animateStudioWidthTo — defer until rAF idle */
      if (
        studioWidthAnimRaf == null &&
        deviceBarStudioWidthAnchor !== null &&
        Number.isFinite(w) &&
        Math.abs(w - deviceBarStudioWidthAnchor) > 1
      ) {
        requestAnimationFrame(() => scrollStudioDeviceSignalsToLeft(true));
      }
      if (Number.isFinite(w)) deviceBarStudioWidthAnchor = w;
      if (Number.isFinite(w) && w > 0) {
        document.documentElement.style.setProperty("--studio-hub-width", `${Math.round(w)}px`);
      }
    }
    syncDeviceUiScale();
  }

  /**
   * Scale capture input chips (toolbar, hub, record strip) with studio width — clamped so UI stays readable.
   */
  function syncDeviceUiScale() {
    const live =
      !captureStudio.classList.contains("hidden") &&
      captureStudio.classList.contains("capture-studio--live-preview");
    let w;
    if (live) {
      if (captureStudio.style.width && String(captureStudio.style.width).trim() !== "") {
        const n = parseFloat(captureStudio.style.width);
        if (Number.isFinite(n) && n > 0) w = n;
      }
      if (w === undefined) w = captureStudio.getBoundingClientRect().width;
    } else {
      w = scadaCluster.getBoundingClientRect().width;
    }
    const wMin = studioMinW();
    const wMax = studioMaxW();
    const span = Math.max(1, wMax - wMin);
    let t = (w - wMin) / span;
    t = Math.max(0, Math.min(1, t));
    const scale = DEVICE_UI_SCALE_MIN + t * (DEVICE_UI_SCALE_MAX - DEVICE_UI_SCALE_MIN);
    document.documentElement.style.setProperty("--device-ui-scale", scale.toFixed(4));
  }

  /**
   * Max studio width: same horizontal bounds as `studioScadaClusterFitsViewport` (wrap padding ∩
   * visual viewport) plus a small inset so the card does not spill past screen edges on mobile /
   * pinch-zoom / split view.
   */
  function studioMaxW() {
    const wrap = document.querySelector("main.wrap");
    const SAFETY = 8;
    if (wrap) {
      const cs = getComputedStyle(wrap);
      const wr = wrap.getBoundingClientRect();
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      let innerLeft = wr.left + pl;
      let innerRight = wr.right - pr;
      const vv = window.visualViewport;
      if (vv && vv.width > 0) {
        const vl = vv.offsetLeft;
        const vr = vl + vv.width;
        innerLeft = Math.max(innerLeft, vl);
        innerRight = Math.min(innerRight, vr);
      }
      let span = Math.max(0, innerRight - innerLeft - SAFETY);
      if (captureStudio.classList.contains("capture-studio--device-settings-open")) {
        span = Math.max(0, span - STUDIO_MENU_OPEN_MAX_WIDTH_PAD_PX);
      }
      return Math.max(240, Math.min(Math.floor(span), 1200));
    }
    let span = Math.max(0, window.innerWidth - 48);
    const vv = window.visualViewport;
    if (vv && vv.width > 0) {
      span = Math.min(span, Math.max(0, vv.width - SAFETY));
    }
    if (captureStudio.classList.contains("capture-studio--device-settings-open")) {
      span = Math.max(0, span - STUDIO_MENU_OPEN_MAX_WIDTH_PAD_PX);
    }
    return Math.max(240, Math.min(Math.floor(span), 1200));
  }

  /** Floor for resize/pinch/stored width: compact hub (22rem) so HUD matches default; capped by viewport */
  function studioMinW() {
    return Math.min(studioCompactMaxPx(), studioMaxW());
  }

  function syncStudioAspectFromCapture() {
    if (captureStudio.classList.contains("capture-studio--pump-only")) return;
    const v = studioVideo;
    let w = v.videoWidth;
    let h = v.videoHeight;
    if (!w || !h) {
      const stream = v.srcObject;
      const tr = stream && stream.getVideoTracks && stream.getVideoTracks()[0];
      if (tr && typeof tr.getSettings === "function") {
        const s = tr.getSettings();
        if (s.width && s.height) {
          w = s.width;
          h = s.height;
        }
      }
    }
    if (!w || !h) {
      w = 16;
      h = 9;
    }
    captureStudio.style.setProperty("--st-ar-w", String(w));
    captureStudio.style.setProperty("--st-ar-h", String(h));
  }

  /** First-run / reset default: center of the allowed resize span (same idea as dbl-click midpoint toggle). */
  function studioDefaultWidthPx() {
    return Math.round((studioMinW() + studioMaxW()) / 2);
  }

  function applyStoredStudioWidth() {
    const cap = studioMaxW();
    const lo = studioMinW();
    const mid = studioDefaultWidthPx();
    function afterWidthRestored() {
      if (
        !captureStudio.classList.contains("capture-studio--live-preview") ||
        captureStudio.classList.contains("hidden") ||
        !captureStudio.style.width ||
        String(captureStudio.style.width).trim() === ""
      ) {
        return;
      }
      syncScadaClusterStudioWide();
      shrinkStudioWidthUntilClusterFits();
    }
    try {
      const raw = localStorage.getItem(STUDIO_USER_W_KEY);
      if (raw == null || raw === "") {
        captureStudio.style.width = `${mid}px`;
        try {
          localStorage.setItem(STUDIO_USER_W_KEY, String(mid));
        } catch (_) {
          /* ignore */
        }
        afterWidthRestored();
        return;
      }
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) {
        captureStudio.style.width = `${mid}px`;
        try {
          localStorage.setItem(STUDIO_USER_W_KEY, String(mid));
        } catch (_) {
          /* ignore */
        }
        afterWidthRestored();
        return;
      }
      const clamped = Math.max(lo, Math.min(cap, n));
      captureStudio.style.width = `${clamped}px`;
      if (clamped !== n) {
        try {
          localStorage.setItem(STUDIO_USER_W_KEY, String(clamped));
        } catch (_) {
          /* ignore */
        }
      }
      afterWidthRestored();
    } catch (_) {
      captureStudio.style.width = `${mid}px`;
      try {
        localStorage.setItem(STUDIO_USER_W_KEY, String(mid));
      } catch {
        /* ignore */
      }
      afterWidthRestored();
    }
  }

  function updateStudioResizeHandleVisibility() {
    const show =
      !captureStudio.classList.contains("hidden") &&
      captureStudio.classList.contains("capture-studio--live-preview") &&
      !captureStudio.classList.contains("capture-studio--pump-only");
    studioResizeHandle.hidden = !show;
    syncScadaClusterStudioWide();
  }

  function resetStudioPanelGeometry() {
    cancelStudioWidthAnimation();
    studioWidthBeforeDeviceMenuPx = null;
    studioUserResizedWhileDeviceMenuOpen = false;
    clearCaptureStudioMenuNudgeTimer();
    cancelPendingStudioViewportFit();
    if (studioPinchSaveTimer != null) {
      clearTimeout(studioPinchSaveTimer);
      studioPinchSaveTimer = null;
    }
    studioWebkitPinchActive = false;
    captureStudio.style.width = "";
    captureStudio.style.removeProperty("--st-ar-w");
    captureStudio.style.removeProperty("--st-ar-h");
    studioResizeHandle.hidden = true;
  }

  /** If cluster still overflows (usually vertically as video grows with width), shrink width until it fits. */
  function shrinkStudioWidthUntilClusterFits() {
    if (!scadaCluster || !captureStudio.classList.contains("capture-studio--live-preview")) return false;
    void scadaCluster.offsetHeight;
    if (studioScadaClusterFitsViewport()) return false;
    const cur = measureStudioInlineWidthPx();
    const target = computeMaxStudioWidthFittingViewport(cur);
    if (target >= cur - 0.5) return false;
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const menuOpen = captureStudio.classList.contains("capture-studio--device-settings-open");
    if (!mqReduce && menuOpen && studioWidthAnimRaf == null) {
      animateStudioWidthTo(target, {
        allowClusterGapTransition: true,
        durationMs: STUDIO_MENU_SLOT_TRANSITION_MS,
      });
      return true;
    }
    if (menuOpen && studioWidthAnimRaf != null) {
      return false;
    }
    captureStudio.style.width = `${target}px`;
    syncScadaClusterStudioWide();
    try {
      localStorage.setItem(STUDIO_USER_W_KEY, String(Math.round(target)));
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  function clampStudioWidthToViewport() {
    if (!captureStudio.classList.contains("capture-studio--live-preview")) {
      syncDeviceUiScale();
      return;
    }
    if (!captureStudio.style.width || String(captureStudio.style.width).trim() === "") {
      syncScadaClusterStudioWide();
      shrinkStudioWidthUntilClusterFits();
      return;
    }
    const w = captureStudio.getBoundingClientRect().width;
    const cap = studioMaxW();
    const next = Math.max(studioMinW(), Math.floor(cap));
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (w > cap) {
      if (!mqReduce && Math.abs(next - w) > 0.75) {
        animateStudioWidthTo(next, {
          allowClusterGapTransition: true,
          durationMs: STUDIO_VIEWPORT_WIDTH_ANIM_MS,
        });
      } else {
        cancelStudioWidthAnimation();
        captureStudio.style.width = `${next}px`;
      }
    }
    syncScadaClusterStudioWide();
    shrinkStudioWidthUntilClusterFits();
  }

  function studioPinchEligible() {
    return (
      !captureStudio.classList.contains("hidden") &&
      captureStudio.classList.contains("capture-studio--live-preview") &&
      !captureStudio.classList.contains("capture-studio--pump-only")
    );
  }

  function getStudioWidthPxForPinch() {
    if (captureStudio.style.width && String(captureStudio.style.width).trim() !== "") {
      const n = parseFloat(captureStudio.style.width);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return captureStudio.getBoundingClientRect().width;
  }

  /**
   * Block pinch-resize only for real form fields — not <video controls> shadow inputs (preview
   * uses controls; live preview does not). Uses composedPath so shadow targets are recognized.
   */
  function studioPinchIgnoreTarget(el, ev) {
    const path =
      ev && typeof ev.composedPath === "function"
        ? ev.composedPath().filter((n) => n instanceof Element)
        : [];
    const nodes = path.length ? path : el instanceof Element ? [el] : [];
    if (!nodes.length) return true;
    for (const node of nodes) {
      if (node.id === "preview-filename") return true;
      if (node.closest && node.closest(".studio-deck__sig-menu")) return true;
      if (node.matches && node.matches("textarea")) return true;
      if (node.matches && node.matches("select")) return true;
      const ce = node.getAttribute && node.getAttribute("contenteditable");
      if (ce === "true" || ce === "") return true;
    }
    return false;
  }

  /** Match hub `normWheelDelta` so pinch feels consistent with elastic scroll tuning. */
  function studioPinchNormDelta(d, mode) {
    if (mode === 1) return d * 16;
    if (mode === 2) return d * Math.min(900, window.innerHeight * 0.85);
    return d * 1.65;
  }

  function noteStudioUserControlledWidthChange() {
    if (captureStudio.classList.contains("capture-studio--device-settings-open")) {
      studioUserResizedWhileDeviceMenuOpen = true;
    }
  }

  function applyStudioWidthFromPinch(nextW) {
    cancelStudioWidthAnimation();
    noteStudioUserControlledWidthChange();
    const cap = studioMaxW();
    const w = Math.round(Math.max(studioMinW(), Math.min(cap, nextW)));
    captureStudio.style.width = `${w}px`;
    syncScadaClusterStudioWide();
    shrinkStudioWidthUntilClusterFits();
    if (studioPinchSaveTimer != null) clearTimeout(studioPinchSaveTimer);
    studioPinchSaveTimer = window.setTimeout(() => {
      studioPinchSaveTimer = null;
      try {
        localStorage.setItem(STUDIO_USER_W_KEY, String(Math.round(captureStudio.getBoundingClientRect().width)));
      } catch (_) {
        /* ignore */
      }
      scheduleStudioFitForDeviceSettingsPanel();
    }, 320);
  }

  function cancelStudioWidthAnimation() {
    if (studioWidthAnimRaf != null) {
      cancelAnimationFrame(studioWidthAnimRaf);
      studioWidthAnimRaf = null;
    }
    if (scadaCluster) {
      scadaCluster.classList.remove("scada-cluster--studio-width-animating");
    }
  }

  /** Y(t) on the CSS cubic-bezier (x1,y1,x2,y2) curve for a given linear time u in [0,1] (matches transition easing). */
  function easeStudioMenuCloseWidth(linearU) {
    const x1 = STUDIO_MENU_CLOSE_WIDTH_EASE_X1;
    const y1 = STUDIO_MENU_CLOSE_WIDTH_EASE_Y1;
    const x2 = STUDIO_MENU_CLOSE_WIDTH_EASE_X2;
    const y2 = STUDIO_MENU_CLOSE_WIDTH_EASE_Y2;
    if (linearU <= 0) return 0;
    if (linearU >= 1) return 1;
    let tLo = 0;
    let tHi = 1;
    for (let i = 0; i < 14; i++) {
      const tMid = (tLo + tHi) * 0.5;
      const x =
        (1 - tMid) ** 3 * 0 +
        3 * (1 - tMid) ** 2 * tMid * x1 +
        3 * (1 - tMid) * tMid ** 2 * x2 +
        tMid ** 3;
      if (x < linearU) tLo = tMid;
      else tHi = tMid;
    }
    const t = (tLo + tHi) * 0.5;
    return (
      (1 - t) ** 3 * 0 + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3
    );
  }

  /** Smooth width change (e.g. resize-handle double-click). Canceled by drag, pinch, or viewport clamp. */
  function animateStudioWidthTo(targetPx, options) {
    const opts = options && typeof options === "object" ? options : null;
    const instant = opts && opts.instant === true;
    const menuCloseRestore = opts && opts.menuCloseRestore === true;
    const allowClusterGapTransition = opts && opts.allowClusterGapTransition === true;
    let durationMs = 420;
    if (opts && typeof opts.durationMs === "number" && opts.durationMs > 0 && opts.durationMs <= 30000) {
      durationMs = opts.durationMs;
    }
    cancelStudioWidthAnimation();
    let target = Math.round(targetPx);
    target = Math.max(studioMinW(), Math.min(studioMaxW(), target));
    /* Menu close: restore the saved width only (min/max studio bounds). Viewport clamp here shrinks at max
       width when the bar reflows after close — visible as a bump. Other paths still clamp to viewport. */
    if (!menuCloseRestore) {
      target = computeMaxStudioWidthFittingViewport(target);
    }
    const start = captureStudio.getBoundingClientRect().width;
    if (Math.abs(target - start) < 0.5) {
      captureStudio.style.width = `${target}px`;
      syncScadaClusterStudioWide();
      try {
        localStorage.setItem(STUDIO_USER_W_KEY, String(target));
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mqReduce.matches || instant) {
      captureStudio.style.width = `${target}px`;
      syncScadaClusterStudioWide();
      try {
        localStorage.setItem(STUDIO_USER_W_KEY, String(target));
      } catch (_) {
        /* ignore */
      }
      return;
    }
    /* Resize handle + menu close: freeze cluster gap so its 0.42s transition doesn’t fight the width tween
       (felt as a bump at max width when the slot animation ends). Device menu open fit still uses allowClusterGapTransition. */
    if (scadaCluster && !allowClusterGapTransition) {
      scadaCluster.classList.add("scada-cluster--studio-width-animating");
    }
    const t0 = performance.now();
    function easeOutQuint(t) {
      return 1 - (1 - t) ** 5;
    }
    function tick(now) {
      const u = Math.min(1, (now - t0) / durationMs);
      const w =
        start +
        (target - start) * (menuCloseRestore ? easeStudioMenuCloseWidth(u) : easeOutQuint(u));
      captureStudio.style.width = `${Math.round(w)}px`;
      syncScadaClusterStudioWide();
      if (u < 1) {
        studioWidthAnimRaf = requestAnimationFrame(tick);
      } else {
        studioWidthAnimRaf = null;
        captureStudio.style.width = `${target}px`;
        syncScadaClusterStudioWide();
        if (scadaCluster) {
          scadaCluster.classList.remove("scada-cluster--studio-width-animating");
        }
        try {
          localStorage.setItem(STUDIO_USER_W_KEY, String(target));
        } catch (_) {
          /* ignore */
        }
      }
    }
    studioWidthAnimRaf = requestAnimationFrame(tick);
  }

  function studioScadaClusterFitsViewport() {
    if (!scadaCluster) return true;
    const wrap = document.querySelector("main.wrap");
    if (!wrap) return true;
    const cs = getComputedStyle(wrap);
    const wr = wrap.getBoundingClientRect();
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    let innerTop = wr.top + pt;
    let innerLeft = wr.left + pl;
    let innerRight = wr.right - pr;
    let innerBottom = wr.bottom - pb;
    const vv = window.visualViewport;
    if (vv) {
      const vt = vv.offsetTop;
      const vl = vv.offsetLeft;
      const vb = vt + vv.height;
      const vr = vl + vv.width;
      innerTop = Math.max(innerTop, vt);
      innerLeft = Math.max(innerLeft, vl);
      innerRight = Math.min(innerRight, vr);
      innerBottom = Math.min(innerBottom, vb);
    }
    const r = scadaCluster.getBoundingClientRect();
    const eps = 0.75;
    /* Menu open: focus ring + shadow on the device strip and gear collapse translate extend past the cluster
       layout box — at max studio width the bar can paint a few px past the visual viewport unless we inset. */
    const edgeSlack =
      captureStudio.classList.contains("capture-studio--device-settings-open") &&
      scadaCluster.classList.contains("scada-cluster--studio-wide")
        ? 18
        : captureStudio.classList.contains("capture-studio--device-settings-open")
          ? 10
          : 0;
    return (
      r.top >= innerTop - eps &&
      r.left >= innerLeft - eps + edgeSlack &&
      r.right <= innerRight + eps - edgeSlack &&
      r.bottom <= innerBottom + eps
    );
  }

  function measureStudioInlineWidthPx() {
    if (captureStudio.style.width && String(captureStudio.style.width).trim() !== "") {
      const n = parseFloat(captureStudio.style.width);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return captureStudio.getBoundingClientRect().width;
  }

  function clusterFitsAtStudioWidthPx(wPx) {
    if (!scadaCluster) return true;
    const prev = captureStudio.style.width;
    const w = Math.round(Math.max(studioMinW(), Math.min(studioMaxW(), wPx)));
    captureStudio.style.width = `${w}px`;
    syncScadaClusterStudioWide();
    void scadaCluster.offsetHeight;
    const ok = studioScadaClusterFitsViewport();
    captureStudio.style.width = prev;
    syncScadaClusterStudioWide();
    return ok;
  }

  /** Largest width ≤ maxW for which the whole cluster (studio + hub bar) fits the visual viewport. */
  function computeMaxStudioWidthFittingViewport(maxW) {
    const minW = studioMinW();
    const cap = Math.min(Math.floor(maxW), studioMaxW());
    if (cap < minW) return minW;
    if (clusterFitsAtStudioWidthPx(cap)) return cap;
    if (!clusterFitsAtStudioWidthPx(minW)) return minW;
    let lo = minW;
    let hi = cap;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (clusterFitsAtStudioWidthPx(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function cancelPendingStudioViewportFit() {
    if (studioSettingsViewportFitRaf1 != null) {
      cancelAnimationFrame(studioSettingsViewportFitRaf1);
      studioSettingsViewportFitRaf1 = null;
    }
    if (studioSettingsViewportFitRaf2 != null) {
      cancelAnimationFrame(studioSettingsViewportFitRaf2);
      studioSettingsViewportFitRaf2 = null;
    }
    if (studioDeviceSettingsFitDebounceTimer != null) {
      clearTimeout(studioDeviceSettingsFitDebounceTimer);
      studioDeviceSettingsFitDebounceTimer = null;
    }
  }

  /**
   * @param {{ animatedWidth?: boolean, skipTryRestore?: boolean }} [opts] - Viewport clamp + optional restore.
   *   Defaults to **animated** width whenever the device menu is open and reduced-motion is off. Pass
   *   `animatedWidth: false` only when an immediate snap is required (rare).
   *   `skipTryRestore`: omit restore-to-snapshot (e.g. right after opening reveal cleanup).
   */
  function scheduleStudioFitForDeviceSettingsPanel(opts) {
    const panel = document.getElementById("studio-device-settings");
    if (!panel || panel.hidden) return;
    if (!captureStudio.classList.contains("capture-studio--device-settings-open")) return;
    cancelPendingStudioViewportFit();
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const skipTryRestore = opts && opts.skipTryRestore === true;
    let useAnimatedWidth;
    if (opts && opts.animatedWidth === false) {
      useAnimatedWidth = false;
    } else if (opts && opts.animatedWidth === true) {
      useAnimatedWidth = true;
    } else {
      useAnimatedWidth = !mqReduce;
    }
    const instantW = mqReduce || !useAnimatedWidth;
    function shrinkThenMaybeRestorePreMenuWidth() {
      ensureStudioFitsViewportWithDeviceSettingsOpen({ instant: instantW });
      if (!skipTryRestore) {
        tryRestoreStudioWidthBeforeMenuIfViewportAllows({ instant: instantW });
      }
    }
    /* Same-frame clamp avoids a visible frame where the cluster sits outside the visual viewport. */
    shrinkThenMaybeRestorePreMenuWidth();
    if (useAnimatedWidth) {
      return;
    }
    studioSettingsViewportFitRaf1 = requestAnimationFrame(() => {
      studioSettingsViewportFitRaf1 = null;
      studioSettingsViewportFitRaf2 = requestAnimationFrame(() => {
        studioSettingsViewportFitRaf2 = null;
        shrinkThenMaybeRestorePreMenuWidth();
      });
    });
  }

  function ensureStudioFitsViewportWithDeviceSettingsOpen(options = {}) {
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const instant = mqReduce || options.instant === true;
    const panel = document.getElementById("studio-device-settings");
    if (!panel || panel.hidden) return;
    if (!scadaCluster) return;
    if (captureStudio.classList.contains("hidden")) return;
    if (!captureStudio.classList.contains("capture-studio--live-preview")) return;
    if (!captureStudio.classList.contains("capture-studio--device-settings-open")) return;

    if (studioScadaClusterFitsViewport()) return;

    if (!instant && studioWidthAnimRaf != null) {
      return;
    }

    const cur = measureStudioInlineWidthPx();
    const target = computeMaxStudioWidthFittingViewport(cur);
    /* Ignore sub‑px drift so we don’t start another width tween at the end of the menu slot animation. */
    if (target >= cur - 2) return;

    animateStudioWidthTo(target, {
      instant,
      allowClusterGapTransition: !instant,
      durationMs: instant ? undefined : STUDIO_MENU_SLOT_TRANSITION_MS,
    });
  }

  /**
   * After viewport clamp shrinks the studio for a tall menu, grow back toward the width from when
   * the menu was first opened once the cluster fits again (e.g. switching to a shorter section).
   * Skipped if the user resized manually (handle/pinch) while the menu is open.
   */
  function tryRestoreStudioWidthBeforeMenuIfViewportAllows(options = {}) {
    const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const instant = mqReduce || options.instant === true;
    if (studioUserResizedWhileDeviceMenuOpen) return;
    if (studioWidthBeforeDeviceMenuPx == null) return;
    if (!captureStudio.classList.contains("capture-studio--device-settings-open")) return;
    if (!instant && studioWidthAnimRaf != null) return;
    const saved = Math.round(
      Math.max(studioMinW(), Math.min(studioMaxW(), studioWidthBeforeDeviceMenuPx))
    );
    const cur = Math.round(measureStudioInlineWidthPx());
    if (Math.abs(cur - saved) <= 6) return;
    if (!clusterFitsAtStudioWidthPx(saved)) return;
    animateStudioWidthTo(saved, {
      instant,
      allowClusterGapTransition: !instant,
      durationMs: instant ? undefined : STUDIO_MENU_SLOT_TRANSITION_MS,
    });
  }

  (function initStudioDeviceSettingsViewportFitObserver() {
    const panel = document.getElementById("studio-device-settings");
    if (!panel || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (panel.hidden) return;
      if (!captureStudio.classList.contains("capture-studio--device-settings-open")) return;
      if (studioDeviceSettingsFitDebounceTimer != null) {
        clearTimeout(studioDeviceSettingsFitDebounceTimer);
      }
      studioDeviceSettingsFitDebounceTimer = window.setTimeout(() => {
        studioDeviceSettingsFitDebounceTimer = null;
        scheduleStudioFitForDeviceSettingsPanel({ animatedWidth: true });
      }, 56);
    });
    ro.observe(panel);
  })();

  function hasLiveMicInMix() {
    const ms = recordSession?.micStream ?? studioCapture?.micStream ?? null;
    return !!(ms && ms.getAudioTracks().some((t) => t.readyState !== "ended"));
  }

  function getQualityPreset() {
    try {
      const v = localStorage.getItem(QUALITY_STORAGE_KEY);
      if (v === "high" || v === "balanced" || v === "data") return v;
    } catch (_) {
      /* ignore */
    }
    return "balanced";
  }

  function setQualityPreset(v) {
    if (v !== "high" && v !== "balanced" && v !== "data") return;
    try {
      localStorage.setItem(QUALITY_STORAGE_KEY, v);
    } catch (_) {
      /* ignore */
    }
    syncStudioQualitySelects();
  }

  function syncStudioQualitySelects() {
    const q = getQualityPreset();
    captureStudio.querySelectorAll(".js-studio-quality").forEach((sel) => {
      if (sel.value !== q) sel.value = q;
    });
  }

  /** iPhone / iPad / Continuity — never auto-selected; user must enable that mic explicitly. */
  function isContinuityOrPhoneMicLabel(label) {
    if (!label || typeof label !== "string") return false;
    const s = label.toLowerCase();
    if (/\biphone\b|\bipad\b|\bipod\b/.test(s)) return true;
    if (/continuity/.test(s)) return true;
    if (/\bphone\b/.test(s) && /mic|audio|input|microphone/.test(s)) return true;
    return false;
  }

  function pickDefaultMicDeviceInfo(audioInputs) {
    const list = audioInputs.filter((d) => d.kind === "audioinput" && d.deviceId);
    if (!list.length) return null;
    const scored = list.map((d) => {
      const label = (d.label || "").toLowerCase();
      let score = 0;
      if (isContinuityOrPhoneMicLabel(d.label)) score -= 100;
      if (/built-in|internal|macbook|imac|microphone \(built|default/.test(label)) score += 50;
      return { d, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].d;
  }

  async function getAudioInputDevices() {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return [];
    const read = () =>
      md.enumerateDevices().then((list) => list.filter((d) => d.kind === "audioinput"));
    let devices = await read();
    /* Chrome can briefly report zero audio inputs during capture / picker flows; retry before clearing UI. */
    for (let attempt = 0; attempt < 3 && devices.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 40 : 100 * attempt));
      devices = await read();
    }
    return devices;
  }

  async function acquireCombinedMicStreamFromDeviceIds(deviceIds) {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      throw new DOMException("Microphone not supported.", "NotSupportedError");
    }
    const ids = [...new Set(deviceIds)].filter(Boolean);
    if (!ids.length) {
      throw new Error("Choose at least one microphone.");
    }
    const tracks = [];
    const streams = [];
    try {
      for (const deviceId of ids) {
        let s;
        try {
          s = await md.getUserMedia({
            audio: {
              deviceId: { exact: deviceId },
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
        } catch (_) {
          s = await md.getUserMedia({ audio: { deviceId: { exact: deviceId } }, video: false });
        }
        streams.push(s);
        tracks.push(...s.getAudioTracks().filter((t) => t.readyState === "live"));
      }
    } catch (e) {
      streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
      throw e;
    }
    if (!tracks.length) {
      streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
      throw new Error("No live microphone track.");
    }
    return new MediaStream(tracks);
  }

  function trackDeviceId(track) {
    try {
      const s = typeof track.getSettings === "function" ? track.getSettings() : null;
      return s && s.deviceId ? s.deviceId : "";
    } catch (_) {
      return "";
    }
  }

  function micStreamHasLiveDevice(micStream, deviceId) {
    if (!micStream || !deviceId) return false;
    return micStream.getAudioTracks().some((t) => {
      if (t.readyState === "ended") return false;
      return trackDeviceId(t) === deviceId;
    });
  }

  function micStreamMatchesIntent(micStream, intent) {
    const want = getEnabledMicDeviceIds(intent)
      .slice()
      .sort()
      .join("\0");
    if (!micStream) return want === "";
    const have = micStream
      .getAudioTracks()
      .filter((t) => t.readyState !== "ended")
      .map((t) => trackDeviceId(t))
      .filter(Boolean)
      .slice()
      .sort()
      .join("\0");
    return want === have;
  }

  function micIntentEffective(intent) {
    const d = intent?.micDevices;
    if (!d || typeof d !== "object") return false;
    return Object.keys(d).some((id) => d[id]);
  }

  function getEnabledMicDeviceIds(intent) {
    const d = intent?.micDevices;
    if (!d || typeof d !== "object") return [];
    return Object.keys(d).filter((id) => d[id]);
  }

  function getDeviceDisplayPrefs() {
    try {
      const raw = localStorage.getItem(DEVICE_DISPLAY_NAMES_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        return {
          customVideo:
            typeof o.customVideo === "string" && o.customVideo.trim()
              ? o.customVideo.trim()
              : DEFAULT_CUSTOM_VIDEO,
          customSys:
            typeof o.customSys === "string" && o.customSys.trim()
              ? o.customSys.trim()
              : DEFAULT_CUSTOM_SYS,
          customMics: o.customMics && typeof o.customMics === "object" ? { ...o.customMics } : {},
        };
      }
    } catch (_) {
      /* ignore */
    }
    return { customVideo: DEFAULT_CUSTOM_VIDEO, customSys: DEFAULT_CUSTOM_SYS, customMics: {} };
  }

  function persistDeviceDisplayPrefs(prefs) {
    try {
      localStorage.setItem(DEVICE_DISPLAY_NAMES_KEY, JSON.stringify(prefs));
    } catch (_) {
      /* ignore */
    }
  }

  function defaultMicCustomName() {
    return "Mic";
  }

  /** @returns {boolean} whether a real system name should show beside the custom label */
  function shouldShowRealSystemName(realSystem) {
    const r = (realSystem || "").trim();
    return Boolean(r && r !== "—");
  }

  function getRealNameVideo() {
    const ds = studioCapture?.displayStream;
    const t = ds?.getVideoTracks?.()?.[0];
    const lab = t?.label;
    if (lab && String(lab).trim()) return String(lab).trim();
    return "—";
  }

  function getRealNameSys() {
    const ds = studioCapture?.displayStream;
    if (!ds) return "—";
    const at = ds.getAudioTracks?.() || [];
    if (at.length) {
      const parts = at.map((x) => x.label).filter(Boolean);
      if (parts.length) return parts.join(", ");
    }
    return "Tab or system audio (from share)";
  }

  /** Split bar label: first token vs remainder (rest styled dimmer in CSS). */
  function splitDeviceBarVisibleFirstWord(visible) {
    const s = String(visible ?? "");
    const m = s.match(/^(\S+)([\s\S]*)$/);
    if (!m) return { first: s, rest: "" };
    return { first: m[1], rest: m[2] };
  }

  /**
   * Bar label: custom only in the left group (first word strong, rest of custom dimmer);
   * system name in a separate span on the right, same rest styling as before.
   */
  function setDeviceBarLabelEl(el, customRaw, realSystem) {
    const custom = (customRaw != null && String(customRaw).trim() !== "")
      ? String(customRaw).trim()
      : "—";
    const showReal = shouldShowRealSystemName(realSystem);
    const realText = (realSystem || "").trim();
    el.replaceChildren();
    const customWrap = document.createElement("span");
    customWrap.className = "studio-deck__device-name-custom-wrap";
    const { first, rest: restCustom } = splitDeviceBarVisibleFirstWord(custom);
    const sp0 = document.createElement("span");
    sp0.className = "studio-deck__device-name-first";
    sp0.textContent = first;
    customWrap.appendChild(sp0);
    if (restCustom) {
      const sp1 = document.createElement("span");
      sp1.className = "studio-deck__device-name-rest";
      sp1.textContent = restCustom;
      customWrap.appendChild(sp1);
    }
    el.appendChild(customWrap);
    if (showReal) {
      const spSys = document.createElement("span");
      spSys.className = "studio-deck__device-name-rest studio-deck__device-name-system";
      spSys.textContent = ` · ${realText}`;
      el.appendChild(spSys);
    }
  }

  /** Mic chip label: custom · system (full custom name; strip scrolls horizontally). */
  function micDisplayParts(systemLabel, deviceId, index, total) {
    const prefs = getDeviceDisplayPrefs();
    const customRaw =
      (prefs.customMics[deviceId] && String(prefs.customMics[deviceId]).trim()) ||
      defaultMicCustomName();
    const real =
      (systemLabel || "").trim() ||
      (deviceId && deviceId.length ? String(deviceId).slice(0, 24) : "") ||
      "Microphone";
    return { customRaw, real, truncated: false };
  }

  function refreshVideoSysBarLabels() {
    const prefs = getDeviceDisplayPrefs();
    const rv = getRealNameVideo();
    const rs = getRealNameSys();
    document
      .querySelectorAll('[data-studio-signal="video"] .studio-deck__sig-name, [data-signal="video"] .studio-deck__sig-name')
      .forEach((el) => {
        setDeviceBarLabelEl(el, prefs.customVideo, rv);
      });
    document
      .querySelectorAll('[data-studio-signal="sys"] .studio-deck__sig-name, [data-signal="sys"] .studio-deck__sig-name')
      .forEach((el) => {
        setDeviceBarLabelEl(el, prefs.customSys, rs);
      });
  }

  async function refreshMicDeviceLabelsOnly() {
    const devices = await getAudioInputDevices();
    const total = devices.length;
    document.querySelectorAll("[data-mic-device-id]").forEach((el) => {
      const id = el.getAttribute("data-mic-device-id");
      if (!id) return;
      const idx = devices.findIndex((d) => d.deviceId === id);
      if (idx < 0) return;
      const d = devices[idx];
      const parts = micDisplayParts(d.label, id, idx, total);
      el.querySelectorAll(".studio-deck__mic-dev-label").forEach((cap) => {
        setDeviceBarLabelEl(cap, parts.customRaw, parts.real);
        delete cap.dataset.truncated;
      });
      const sr = el.querySelector(".sr-only.record-panel__sig-label");
      if (sr) sr.textContent = parts.customRaw;
    });
  }

  function populateMicNameSettingsRows() {
    const wrap = document.getElementById("studio-mic-names-settings");
    if (!wrap) return;
    wrap.replaceChildren();
    void getAudioInputDevices().then((devices) => {
      const prefs = getDeviceDisplayPrefs();
      if (!devices.length) {
        const p = document.createElement("p");
        p.className = "studio-deck__sig-menu-hint";
        p.style.margin = "0";
        p.textContent = "No microphones reported.";
        wrap.appendChild(p);
        return;
      }
      devices.forEach((d, i) => {
        const block = document.createElement("div");
        block.className = "studio-deck__menu-name-block";
        const lab = document.createElement("label");
        lab.className = "studio-deck__menu-label";
        lab.setAttribute("for", `studio-mic-custom-${i}`);
        lab.textContent = "Custom name";
        const inp = document.createElement("input");
        inp.type = "text";
        inp.id = `studio-mic-custom-${i}`;
        inp.className = "studio-deck__menu-input js-mic-custom-name";
        inp.setAttribute("data-device-id", d.deviceId);
        inp.maxLength = 64;
        inp.setAttribute("spellcheck", "false");
        inp.setAttribute("autocomplete", "off");
        inp.value =
          (prefs.customMics[d.deviceId] && String(prefs.customMics[d.deviceId]).trim()) ||
          defaultMicCustomName();
        const row = document.createElement("div");
        row.className = "studio-deck__menu-name-row";
        const meta = document.createElement("div");
        meta.className = "studio-deck__menu-meta studio-deck__menu-meta--beside-input";
        const ml = document.createElement("span");
        ml.className = "studio-deck__menu-meta-label";
        ml.textContent = "System name";
        const real = document.createElement("span");
        real.className = "studio-deck__menu-real";
        real.textContent = (d.label || "").trim() || d.deviceId.slice(0, 48) || "—";
        meta.appendChild(ml);
        meta.appendChild(real);
        row.appendChild(inp);
        row.appendChild(meta);
        block.appendChild(lab);
        block.appendChild(row);
        wrap.appendChild(block);
      });
    });
  }

  function syncStudioDeviceNameMenus() {
    const prefs = getDeviceDisplayPrefs();
    const cv = document.getElementById("studio-custom-name-video");
    const rv = document.getElementById("studio-real-name-video");
    if (cv) cv.value = prefs.customVideo;
    if (rv) rv.textContent = getRealNameVideo();
    const cs = document.getElementById("studio-custom-name-sys");
    const rs = document.getElementById("studio-real-name-sys");
    if (cs) cs.value = prefs.customSys;
    if (rs) rs.textContent = getRealNameSys();
    populateMicNameSettingsRows();
  }

  let deviceNameInputDebounce = null;
  function scheduleDeviceNamePersistAndRefresh() {
    if (deviceNameInputDebounce) clearTimeout(deviceNameInputDebounce);
    deviceNameInputDebounce = window.setTimeout(() => {
      deviceNameInputDebounce = null;
      refreshVideoSysBarLabels();
      void refreshMicDeviceLabelsOnly();
    }, 120);
  }

  const STUDIO_DEVICE_SETTINGS_GEAR_SVG =
    '<svg class="studio-deck__device-settings-btn__icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.488.488 0 00-.6-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.488.488 0 00-.6.22l-1.92 3.32c-.13.22-.07.49.12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.12.22.37.29.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.48 0 .6-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 018.5 12 3.5 3.5 0 0112 8.5a3.5 3.5 0 013.5 3.5 3.5 3.5 0 01-3.5 3.5z"/></svg>';

  function createStudioDeviceSettingsBtn(scrollToId, ariaLabel) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "studio-deck__device-settings-btn";
    b.setAttribute("data-studio-settings-scroll", scrollToId);
    b.setAttribute("aria-label", ariaLabel);
    b.setAttribute("aria-expanded", "false");
    b.setAttribute("aria-controls", "studio-device-settings");
    b.innerHTML = STUDIO_DEVICE_SETTINGS_GEAR_SVG;
    return b;
  }

  function buildMicDeviceButton(deviceId, label, hub, index, total) {
    const wrap = document.createElement("div");
    wrap.className = "studio-deck__sig-wrap studio-deck__sig-wrap--with-settings";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = hub
      ? "studio-deck__sig studio-deck__sig--hub is-off"
      : "studio-deck__sig studio-deck__sig--btn is-off";
    btn.setAttribute("data-mic-device-id", deviceId);
    btn.setAttribute("aria-pressed", "false");
    const led = document.createElement("span");
    led.className = "studio-deck__sig-led";
    led.setAttribute("aria-hidden", "true");
    const ic = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ic.setAttribute("class", "studio-deck__sig-icon");
    ic.setAttribute("viewBox", "0 0 24 24");
    ic.setAttribute("width", "16");
    ic.setAttribute("height", "16");
    ic.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 14a3 3 0 003-3V7a3 3 0 10-6 0v4a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z"
    );
    path.setAttribute("fill", "currentColor");
    ic.appendChild(path);
    const cap = document.createElement("span");
    const parts = micDisplayParts(label, deviceId, index, total);
    cap.className = "studio-deck__mic-dev-label";
    setDeviceBarLabelEl(cap, parts.customRaw, parts.real);
    delete cap.dataset.truncated;
    const sr = document.createElement("span");
    sr.className = "sr-only record-panel__sig-label";
    sr.textContent = parts.customRaw;
    btn.appendChild(led);
    btn.appendChild(ic);
    btn.appendChild(cap);
    btn.appendChild(sr);
    wrap.appendChild(btn);
    const micShort = (label || "").trim() || "Microphone";
    wrap.appendChild(
      createStudioDeviceSettingsBtn(
        `studio-mic-custom-${index}`,
        `Microphone settings (${micShort.length > 40 ? micShort.slice(0, 40) : micShort})`
      )
    );
    wrap.setAttribute("data-device-bar-group", `mic-${index}`);
    return wrap;
  }

  function buildMicDeviceDisplay(deviceId, label, index, total) {
    const wrap = document.createElement("div");
    wrap.className = "studio-deck__sig-wrap";
    const el = document.createElement("div");
    el.className = "studio-deck__sig studio-deck__sig--display is-off";
    el.setAttribute("data-mic-device-id", deviceId);
    el.setAttribute("aria-hidden", "false");
    const led = document.createElement("span");
    led.className = "studio-deck__sig-led";
    led.setAttribute("aria-hidden", "true");
    const ic = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ic.setAttribute("class", "studio-deck__sig-icon");
    ic.setAttribute("viewBox", "0 0 24 24");
    ic.setAttribute("width", "16");
    ic.setAttribute("height", "16");
    ic.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 14a3 3 0 003-3V7a3 3 0 10-6 0v4a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.92V21h2v-3.08A7 7 0 0019 11h-2z"
    );
    path.setAttribute("fill", "currentColor");
    ic.appendChild(path);
    const cap = document.createElement("span");
    const parts = micDisplayParts(label, deviceId, index, total);
    cap.className = "studio-deck__mic-dev-label";
    setDeviceBarLabelEl(cap, parts.customRaw, parts.real);
    delete cap.dataset.truncated;
    const sr = document.createElement("span");
    sr.className = "sr-only record-panel__sig-label";
    sr.textContent = parts.customRaw;
    el.appendChild(led);
    el.appendChild(ic);
    el.appendChild(cap);
    el.appendChild(sr);
    wrap.appendChild(el);
    wrap.setAttribute("data-device-bar-group", `mic-${index}`);
    return wrap;
  }

  let micDeviceListRefreshScheduled = false;
  /** Serializes mic bar DOM updates so parallel refreshMicDeviceList() calls can’t interleave (brief duplicate / clipped chips after cancel). */
  let micDeviceListRefreshChain = Promise.resolve();

  function applyMicDeviceIndicatorState(intent, micStream) {
    const sel = intent?.micDevices || {};
    document.querySelectorAll("[data-mic-device-id]").forEach((el) => {
      const id = el.getAttribute("data-mic-device-id");
      const picked = !!sel[id];
      const live = !!(micStream && micStreamHasLiveDevice(micStream, id));
      el.classList.toggle("is-on", picked && live);
      el.classList.toggle("is-armed", picked && !live);
      el.classList.toggle("is-off", !picked);
      if (el instanceof HTMLButtonElement) {
        el.setAttribute("aria-pressed", picked ? "true" : "false");
      }
    });
  }

  async function renderMicDeviceRows(devices) {
    const intent = getInputIntent();
    const hubMicDeviceRow = document.getElementById("hub-mic-device-row");
    const studioMicDeviceRow = document.getElementById("studio-mic-device-row");
    const recordMicDeviceRow = document.getElementById("record-mic-device-row");
    if (!hubMicDeviceRow && !studioMicDeviceRow && !recordMicDeviceRow) return;

    /* Always rebuild from `devices`. Do not skip when enumerate returns [] while chips exist — after stop/cancel,
       Chrome can briefly report 0 mics; skipping left stale nodes until the next refresh (overlapping chips / clipping). */

    if (hubMicDeviceRow) hubMicDeviceRow.replaceChildren();
    if (studioMicDeviceRow) studioMicDeviceRow.replaceChildren();
    if (recordMicDeviceRow) recordMicDeviceRow.replaceChildren();

    const n = devices.length;
    for (let i = 0; i < n; i++) {
      const d = devices[i];
      if (hubMicDeviceRow) hubMicDeviceRow.appendChild(buildMicDeviceButton(d.deviceId, d.label, true, i, n));
      if (studioMicDeviceRow) {
        studioMicDeviceRow.appendChild(buildMicDeviceButton(d.deviceId, d.label, false, i, n));
      }
      if (recordMicDeviceRow) recordMicDeviceRow.appendChild(buildMicDeviceDisplay(d.deviceId, d.label, i, n));
    }

    const ms = recordSession?.micStream ?? studioCapture?.micStream ?? null;
    applyMicDeviceIndicatorState(intent, ms);

    /* One-time migration: legacy “mic on” with no per-device map → default non–Continuity mic only */
    const sel = intent.micDevices || {};
    const hasPick = Object.keys(sel).some((k) => sel[k]);
    if (intent.mic && !hasPick && devices.length) {
      const def = pickDefaultMicDeviceInfo(devices);
      if (def) {
        const next = {
          ...intent,
          micDevices: { [def.deviceId]: true },
          mic: true,
        };
        persistInputIntent(next);
        refreshInputLeds();
      }
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resetInputBarsScrollLeft();
        refreshVideoSysBarLabels();
      });
    });
  }

  /** Reset horizontal strip scroll (e.g. after mic list refresh). */
  function resetInputBarsScrollLeft() {
    scrollStudioDeviceSignalsToLeft(false);
    const selectors = ["#hub-input-row .hub-input-row__signals", "#record-panel .record-panel__signals"];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) el.scrollLeft = 0;
    }
  }

  function refreshMicDeviceList() {
    micDeviceListRefreshChain = micDeviceListRefreshChain
      .catch(() => {})
      .then(async () => {
        const devices = await getAudioInputDevices();
        await renderMicDeviceRows(devices);
      });
    return micDeviceListRefreshChain;
  }

  /** Same scale as hub `normWheelDelta` — raw deltaY was ~1px per mouse notch (unusably slow). */
  function normInputBarWheelDeltaY(dy, deltaMode) {
    if (deltaMode === 1) return dy * 16;
    if (deltaMode === 2) return dy * Math.min(900, window.innerHeight * 0.85);
    return dy * 1.72;
  }

  /** Map vertical wheel to horizontal scroll on narrow input bars (passive: false for preventDefault). */
  function installInputBarWheelToHorizontalScroll() {
    const selectors = [
      "#studio-device-signals-scroll",
      "#hub-input-row .hub-input-row__signals",
      "#record-panel .record-panel__signals",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el || el.dataset.wheelToHScroll === "1") continue;
      el.dataset.wheelToHScroll = "1";
      el.addEventListener(
        "wheel",
        (e) => {
          if (e.shiftKey) return;
          const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
          if (maxScroll < 1) return;
          const dy = e.deltaY;
          const dx = e.deltaX;
          if (Math.abs(dy) < Math.abs(dx)) return;
          if (dy === 0) return;
          const before = el.scrollLeft;
          const step = normInputBarWheelDeltaY(dy, e.deltaMode);
          const next = Math.max(0, Math.min(maxScroll, before + step));
          const atStart = before <= 0.5;
          const atEnd = before >= maxScroll - 0.5;
          if (next === before && ((dy < 0 && atStart) || (dy > 0 && atEnd))) {
            return;
          }
          e.preventDefault();
          el.scrollLeft = next;
        },
        { passive: false }
      );
    }
  }

  function scheduleMicDeviceListRefresh() {
    if (micDeviceListRefreshScheduled) return;
    micDeviceListRefreshScheduled = true;
    window.setTimeout(() => {
      micDeviceListRefreshScheduled = false;
      void refreshMicDeviceList();
    }, 120);
  }

  function getInputIntent() {
    try {
      const raw = localStorage.getItem(INPUT_INTENT_STORAGE_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        const micDevices =
          o.micDevices && typeof o.micDevices === "object" ? { ...o.micDevices } : {};
        return {
          video: Boolean(o.video),
          mic: Boolean(o.mic),
          sys: Boolean(o.sys),
          micDevices,
        };
      }
    } catch (_) {
      /* ignore */
    }
    return { video: false, mic: false, sys: false, micDevices: {} };
  }

  /** Bounding element for crop / video content (frame excludes stacked audio viz below). */
  function studioCropWrapEl() {
    return studioVideoFrame || studioVideoWrap;
  }

  function persistInputIntent(state) {
    try {
      const micDevices =
        state.micDevices && typeof state.micDevices === "object" ? { ...state.micDevices } : {};
      const micOn = Object.keys(micDevices).some((id) => micDevices[id]);
      localStorage.setItem(
        INPUT_INTENT_STORAGE_KEY,
        JSON.stringify({
          video: !!state.video,
          mic: micOn,
          sys: !!state.sys,
          micDevices,
        })
      );
    } catch (_) {
      /* ignore */
    }
  }

  function mediaTrackActive(t) {
    return !!t && t.readyState !== "ended";
  }

  function applyHubRecordVideoSysVisuals(intent, displayStream) {
    const vWant = !!intent?.video;
    const sWant = !!intent?.sys;
    let vLive = false;
    let sLive = false;
    if (displayStream) {
      const vt = displayStream.getVideoTracks()[0];
      vLive = vWant && mediaTrackActive(vt);
      sLive = sWant && displayStream.getAudioTracks().some((t) => mediaTrackActive(t));
    }
    const prefs = getDeviceDisplayPrefs();
    const customNames = { video: prefs.customVideo, sys: prefs.customSys };
    const syncRoot = (root) => {
      if (!root) return;
      root.querySelectorAll("[data-signal]").forEach((el) => {
        const k = el.getAttribute("data-signal");
        if (k === "mic") return;
        const want = k === "video" ? vWant : k === "sys" ? sWant : false;
        const live = k === "video" ? vLive : k === "sys" ? sLive : false;
        el.classList.toggle("is-on", live);
        el.classList.toggle("is-armed", want && !live);
        el.classList.toggle("is-off", !want);
        const name = customNames[k] || k;
        el.setAttribute("aria-label", `${name}: ${live ? "live" : want ? "pending" : "off"}`);
      });
    };
    syncRoot(recordPanel);
    syncRoot(hubInputRow);
    refreshVideoSysBarLabels();
  }

  function applyStudioVideoSysVisuals(intent, displayStream) {
    const vWant = !!intent?.video;
    const sWant = !!intent?.sys;
    let vLive = false;
    let sLive = false;
    if (displayStream) {
      const vt = displayStream.getVideoTracks()[0];
      vLive = vWant && mediaTrackActive(vt);
      sLive = sWant && displayStream.getAudioTracks().some((t) => mediaTrackActive(t));
    }
    captureStudio.querySelectorAll(".studio-deck__sig--btn[data-studio-signal]").forEach((el) => {
      const k = el.getAttribute("data-studio-signal");
      if (k !== "video" && k !== "sys") return;
      const want = k === "video" ? vWant : sWant;
      const live = k === "video" ? vLive : sLive;
      el.classList.toggle("is-on", live);
      el.classList.toggle("is-armed", want && !live);
      el.classList.toggle("is-off", !want);
    });
  }

  function refreshInputLeds() {
    const intent = getInputIntent();
    const ds = recordSession?.displayStream ?? studioCapture?.displayStream ?? null;
    const ms = recordSession?.micStream ?? studioCapture?.micStream ?? null;
    applyHubRecordVideoSysVisuals(intent, ds);
    applyMicDeviceIndicatorState(intent, ms);
    if (!captureStudio.classList.contains("hidden")) {
      applyStudioVideoSysVisuals(intent, ds);
    }
  }

  function applyIdleInputIndicators() {
    refreshInputLeds();
  }

  function toggleHubInputSignal(key) {
    if (key !== "video" && key !== "sys") return;
    const cur = getInputIntent();
    const next = { ...cur, [key]: !cur[key] };
    const micOn = micIntentEffective(next);
    if (!next.video && !next.sys && !micOn) {
      if (recordSession) {
        setStatus("Keep at least one input on while recording.");
        return;
      }
      persistInputIntent(next);
      refreshInputLeds();
      setStatus("");
      if (studioCapture) disposeStudioCapture();
      return;
    }
    persistInputIntent(next);
    refreshInputLeds();
    setStatus("");
    if (recordSession) {
      void syncRecordingSessionWithIntent(recordSession);
    } else if (studioCapture && (key === "video" || key === "sys")) {
      const sysJustEnabled = key === "sys" && next.sys && !cur.sys;
      void syncStudioCaptureHubVideoSys(studioCapture, { sysJustEnabled });
    } else if (
      !recordSession &&
      !studioCapture &&
      !snipeArming &&
      !pendingPreview &&
      (key === "video" || key === "sys") &&
      next[key]
    ) {
      void startSnipe();
    }
  }

  function toggleMicDevice(deviceId) {
    if (!deviceId) return;
    const cur = getInputIntent();
    const micDevices = { ...(cur.micDevices || {}) };
    micDevices[deviceId] = !micDevices[deviceId];
    const micOn = Object.values(micDevices).some(Boolean);
    const next = { ...cur, micDevices, mic: micOn };
    if (!next.video && !next.sys && !micOn) {
      if (recordSession) {
        setStatus("Keep at least one input on while recording.");
        return;
      }
      persistInputIntent(next);
      refreshInputLeds();
      setStatus("");
      if (studioCapture) disposeStudioCapture();
      return;
    }
    persistInputIntent(next);
    refreshInputLeds();
    setStatus("");
    if (recordSession) {
      void syncRecordingSessionWithIntent(recordSession);
    } else if (studioCapture) {
      void syncStudioCaptureMicDevices(studioCapture);
    } else if (
      !recordSession &&
      !studioCapture &&
      !snipeArming &&
      !pendingPreview &&
      micOn &&
      !next.video &&
      !next.sys
    ) {
      void startSnipe();
    }
  }

  /**
   * Hub toggles for video / system sound must update the live preview bundle (captureMode can be stale
   * if intent changed after getDisplayMedia).
   */
  async function syncStudioCaptureHubVideoSys(bundle, opts) {
    if (!bundle || recordSession || bundle.captureMode === "mic-only") {
      if (bundle && !recordSession) wireLivePreviewSurface(bundle);
      return;
    }
    const intent = getInputIntent();
    /* Tab/system audio requires a display share that includes audio — re-pick share (same as Replace). */
    if (
      opts &&
      opts.sysJustEnabled &&
      intent.sys &&
      bundle.displayStream &&
      !bundle.displayStream.getAudioTracks().some((t) => t.readyState === "live")
    ) {
      bundle.recordIncludeVideo = !!intent.video;
      bundle.recordIncludeDisplayAudio = !!intent.sys;
      bundle.captureMode = intent.video ? "display" : "display-audio-only";
      studioReplaceScreenShare();
      return;
    }
    bundle.recordIncludeVideo = !!intent.video;
    bundle.recordIncludeDisplayAudio = !!intent.sys;
    bundle.captureMode = intent.video ? "display" : "display-audio-only";
    try {
      await studioRebuildRecordStream(bundle);
      wireLivePreviewSurface(bundle);
    } catch (e) {
      setStatus((e && e.message) || "Could not update capture.");
    }
  }

  async function syncStudioCaptureMicDevices(bundle) {
    if (!bundle || recordSession) return;
    const intent = getInputIntent();
    const ids = getEnabledMicDeviceIds(intent);
    if (!ids.length) {
      await studioTeardownVoicePipeline(bundle);
      bundle.micStream = null;
      try {
        await studioRebuildRecordStream(bundle);
      } catch (e) {
        setStatus((e && e.message) || "Could not update capture.");
      }
      wireLivePreviewSurface(bundle);
      applyLiveIndicatorsFromCaptureBundle(bundle);
      return;
    }
    let ms;
    try {
      ms = await acquireCombinedMicStreamFromDeviceIds(ids);
    } catch (e) {
      if (e && e.name === "NotAllowedError") {
        setInputPermissionBlocked({ mic: true });
      } else {
        setStatus((e && e.message) || "Could not open microphone.");
      }
      return;
    }
    await studioTeardownVoicePipeline(bundle);
    bundle.micStream = ms;
    try {
      await studioRebuildRecordStream(bundle);
    } catch (e) {
      ms.getTracks().forEach((t) => t.stop());
      bundle.micStream = null;
      try {
        await studioRebuildRecordStream(bundle);
      } catch (_) {
        /* ignore */
      }
      setStatus((e && e.message) || "Could not mix microphone.");
      return;
    }
    clearInputPermissionBlocked();
    wireLivePreviewSurface(bundle);
    applyLiveIndicatorsFromCaptureBundle(bundle);
  }

  function setStudioAwaitShareVisible(on) {
    if (studioAwaitPlaceholder) studioAwaitPlaceholder.hidden = !on;
  }

  function setStudioScreenVideoPreviewActive(on) {
    captureStudio.classList.toggle("capture-studio--show-screen-video", !!on);
  }

  function clearStudioRegionCrop() {
    studioRegionNorm = null;
    regionDragClient = null;
    if (studioRegionEl) {
      studioRegionEl.hidden = true;
      studioRegionEl.style.cssText = "";
    }
  }

  /**
   * @returns {null | { sig: string; surface: string; settingsW: number; settingsH: number }}
   */
  function displayCaptureWireMeta(ds) {
    if (!ds || typeof ds.getVideoTracks !== "function") return null;
    const vt = ds.getVideoTracks()[0];
    if (!vt) return null;
    let sig = "";
    try {
      sig = `${ds.id || "stream"}:${vt.id || "track"}`;
    } catch (_) {
      sig = String(vt.id || "");
    }
    let surface = "";
    let settingsW = 0;
    let settingsH = 0;
    try {
      const s = typeof vt.getSettings === "function" ? vt.getSettings() : {};
      surface = String(s.displaySurface || "");
      settingsW = Number(s.width) || 0;
      settingsH = Number(s.height) || 0;
    } catch (_) {
      /* ignore */
    }
    return { sig, surface, settingsW, settingsH };
  }

  function shouldInvalidateCropFromWireMeta(prev, next) {
    if (!prev || !next) return false;
    if (prev.sig !== next.sig) return true;
    const ps = prev.surface || "";
    const ns = next.surface || "";
    if (ps !== ns && (ps || ns)) return true;
    if (
      prev.settingsW > 0 &&
      prev.settingsH > 0 &&
      next.settingsW > 0 &&
      next.settingsH > 0 &&
      (Math.abs(next.settingsW - prev.settingsW) / prev.settingsW > 0.08 ||
        Math.abs(next.settingsH - prev.settingsH) / prev.settingsH > 0.08)
    ) {
      return true;
    }
    return false;
  }

  function onStudioVideoIntrinsicChangeForCrop() {
    const w = studioVideo.videoWidth;
    const h = studioVideo.videoHeight;
    if (w < 2 || h < 2) return;
    if (lastStudioPreviewIntrinsic != null) {
      if (w !== lastStudioPreviewIntrinsic.w || h !== lastStudioPreviewIntrinsic.h) {
        clearStudioRegionCrop();
      }
    }
    lastStudioPreviewIntrinsic = { w, h };
  }

  function detachStudioVideoCropListeners() {
    try {
      studioVideo.removeEventListener("loadedmetadata", onStudioVideoIntrinsicChangeForCrop);
      studioVideo.removeEventListener("resize", onStudioVideoIntrinsicChangeForCrop);
    } catch (_) {
      /* ignore */
    }
  }

  function attachStudioVideoCropListeners() {
    detachStudioVideoCropListeners();
    studioVideo.addEventListener("loadedmetadata", onStudioVideoIntrinsicChangeForCrop);
    studioVideo.addEventListener("resize", onStudioVideoIntrinsicChangeForCrop);
  }

  function wireLivePreviewSurface(bundle) {
    captureStudio.classList.remove("capture-studio--empty-preview", "capture-studio--await-share");
    setStudioAwaitShareVisible(false);
    captureStudio.classList.remove("capture-studio--audio-meter-preview");
    setStudioScreenVideoPreviewActive(false);
    if (bundle.captureMode === "mic-only") {
      lastWiredDisplayWireMeta = null;
      lastStudioPreviewIntrinsic = null;
      detachStudioVideoCropListeners();
      captureStudio.classList.add("capture-studio--audio-meter-preview");
      studioVideo.srcObject = null;
      try {
        studioVideo.pause();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const ds = bundle.displayStream;
    if (!ds) {
      lastWiredDisplayWireMeta = null;
      lastStudioPreviewIntrinsic = null;
      detachStudioVideoCropListeners();
      studioVideo.srcObject = null;
      try {
        studioVideo.pause();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const nextWireMeta = displayCaptureWireMeta(ds);
    if (shouldInvalidateCropFromWireMeta(lastWiredDisplayWireMeta, nextWireMeta)) {
      clearStudioRegionCrop();
    }
    lastWiredDisplayWireMeta = nextWireMeta;
    const wantVideoPreview = bundle.recordIncludeVideo !== false;
    if (wantVideoPreview) {
      ds.getVideoTracks().forEach((t) => {
        try {
          t.enabled = true;
        } catch (_) {
          /* ignore */
        }
      });
      studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
      attachStudioVideoCropListeners();
      studioVideo.srcObject = ds;
      setStudioScreenVideoPreviewActive(true);
      try {
        studioVideo.play().catch(() => {});
      } catch (_) {
        /* ignore */
      }
      try {
        onStudioVideoIntrinsicChangeForCrop();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    lastStudioPreviewIntrinsic = null;
    detachStudioVideoCropListeners();
    ds.getVideoTracks().forEach((t) => {
      try {
        t.enabled = false;
      } catch (_) {
        /* ignore */
      }
    });
    captureStudio.classList.add("capture-studio--audio-meter-preview");
    studioVideo.srcObject = null;
    try {
      studioVideo.pause();
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Re-bind the live display stream to the studio <video> while recording (or after resume).
   * Preview can leave capture-studio--audio-meter-preview / await-share; those hide the element via CSS.
   */
  function syncStudioVideoPreviewForRecordingSession(session) {
    if (!session?.displayStream || session.recordIncludeVideo === false) return;
    setStudioAwaitShareVisible(false);
    captureStudio.classList.remove(
      "capture-studio--audio-meter-preview",
      "capture-studio--await-share",
      "capture-studio--starting"
    );
    const ds = session.displayStream;
    ds.getVideoTracks().forEach((t) => {
      try {
        t.enabled = true;
      } catch (_) {
        /* ignore */
      }
    });
    studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
    studioVideo.pause();
    studioVideo.removeAttribute("src");
    studioVideo.removeAttribute("controls");
    studioVideo.muted = true;
    studioVideo.setAttribute("playsinline", "");
    studioVideo.setAttribute("autoplay", "");
    studioVideo.srcObject = ds;
    setStudioScreenVideoPreviewActive(true);
    try {
      studioVideo.play().catch(() => {});
    } catch (_) {
      /* ignore */
    }
    syncStudioAspectFromCapture();
    updateStudioResizeHandleVisibility();
  }

  function applySnipeStudioPickShareUi() {
    if (!snipeBtn) return;
    snipeBtn.classList.add("rec-go--in-studio", "rec-go--studio-start");
    snipeBtn.querySelector(".rec-go__glyph--idle")?.setAttribute("hidden", "");
    snipeBtn.querySelector(".rec-go__glyph--studio")?.removeAttribute("hidden");
    snipeBtn.querySelector(".rec-go__glyph--stop")?.setAttribute("hidden", "");
    snipeBtn.setAttribute("aria-label", "Choose what to share");
    snipeBtn.disabled = false;
  }

  function openStudioForHubSettings(signalKey) {
    closeStudioInputMenus();
    const menuBtnId =
      signalKey === "sys" ? "studio-sig-sys" : signalKey === "video" ? "studio-sig-video" : null;
    const btn = menuBtnId ? document.getElementById(menuBtnId) : null;
    captureStudio.classList.remove("hidden", "capture-studio--empty-preview");
    captureStudio.setAttribute("aria-hidden", "false");
    captureStudio.classList.add("capture-studio--live-preview");
    captureStudio.classList.add("capture-studio--await-share");
    captureStudio.classList.remove(
      "capture-studio--audio-meter-preview",
      "capture-studio--selecting",
      "capture-studio--review"
    );
    studioVideo.srcObject = null;
    try {
      studioVideo.pause();
    } catch (_) {
      /* ignore */
    }
    setStudioAwaitShareVisible(true);
    document.body.classList.remove("is-live-capture", "is-preview");
    applyStoredStudioWidth();
    syncStudioAspectFromCapture();
    updateStudioResizeHandleVisibility();
    showPreviewRecordTimerZero();
    refreshInputLeds();
    syncStudioQualitySelects();
    ensureSnipeInStudio();
    applySnipeStudioPickShareUi();
    if (signalKey === "mic") {
      openStudioMicMenu();
    } else if (btn) {
      openStudioInputMenu(btn);
    }
  }

  function closeStudioAwaitShareShell() {
    closeStudioInputMenus();
    closeStudioUiOnly();
  }

  function getRecordingBitrates() {
    const q = getQualityPreset();
    if (q === "high") return { video: 12000000, audio: 320000 };
    if (q === "data") return { video: 2500000, audio: 96000 };
    return { video: 8000000, audio: 192000 };
  }

  function syncDeviceSettingsChipsAria(scrollToId, openerEl) {
    document.querySelectorAll(".studio-deck__device-settings-btn").forEach((b) => {
      const sid = b.getAttribute("data-studio-settings-scroll") || "";
      const on = openerEl ? b === openerEl : Boolean(scrollToId && sid === scrollToId);
      b.setAttribute("aria-expanded", on ? "true" : "false");
    });
  }

  /** Map scroll target (section id or mic row id) to the top-level settings section to show alone. */
  function getSoloSectionIdFromScrollTarget(scrollToId) {
    if (!scrollToId) return "";
    if (
      scrollToId === "studio-menu-video" ||
      scrollToId === "studio-menu-sys" ||
      scrollToId === "studio-menu-mic"
    ) {
      return scrollToId;
    }
    if (scrollToId.startsWith("studio-mic-custom-")) return "studio-menu-mic";
    return "";
  }

  /**
   * Left-to-right order on the device bar: Screen → Sound → general mic menu → mic chips.
   * Used to slide the settings panel from the correct side when switching menus.
   */
  function getDeviceSettingsBarOrder(scrollToId) {
    if (!scrollToId || typeof scrollToId !== "string") return 0;
    if (scrollToId === "studio-menu-video") return 0;
    if (scrollToId === "studio-menu-sys") return 1;
    if (scrollToId === "studio-menu-mic") return 2;
    const m = /^studio-mic-custom-(\d+)$/.exec(scrollToId);
    if (m) return 3 + parseInt(m[1], 10);
    return 2;
  }

  function clearDeviceSettingsSectionSlideClasses(panel) {
    if (!panel) return;
    panel.querySelectorAll(".studio-device-settings__section").forEach((el) => {
      el.classList.remove(
        "studio-device-settings__section--enter-from-right",
        "studio-device-settings__section--enter-from-left"
      );
    });
  }

  function clearStudioDeviceSettingsOpeningAnimation() {
    const panel = document.getElementById("studio-device-settings");
    if (studioDeviceSettingsOpeningFallbackTimer != null) {
      clearTimeout(studioDeviceSettingsOpeningFallbackTimer);
      studioDeviceSettingsOpeningFallbackTimer = null;
    }
  }

  function syncStudioDeviceBarMenuFocus(scrollToId) {
    const bar = document.getElementById("studio-device-bar");
    if (!bar) return;
    bar.querySelectorAll(".studio-deck__sig-wrap--menu-focus").forEach((el) => {
      el.classList.remove("studio-deck__sig-wrap--menu-focus");
    });
    bar.querySelector(".studio-deck__sig-group--mics")?.classList.remove("studio-deck__sig-group--menu-focus");
    if (!scrollToId) return;
    if (scrollToId === "studio-menu-video") {
      bar.querySelector('[data-device-bar-group="video"]')?.classList.add("studio-deck__sig-wrap--menu-focus");
    } else if (scrollToId === "studio-menu-sys") {
      bar.querySelector('[data-device-bar-group="sys"]')?.classList.add("studio-deck__sig-wrap--menu-focus");
    } else if (scrollToId === "studio-menu-mic") {
      bar.querySelector(".studio-deck__sig-group--mics")?.classList.add("studio-deck__sig-group--menu-focus");
    } else if (scrollToId.startsWith("studio-mic-custom-")) {
      const idx = scrollToId.slice("studio-mic-custom-".length);
      bar.querySelector(`[data-device-bar-group="mic-${idx}"]`)?.classList.add("studio-deck__sig-wrap--menu-focus");
    }
  }

  function clearStudioDeviceBarMenuFocus() {
    const bar = document.getElementById("studio-device-bar");
    if (!bar) return;
    bar.querySelectorAll(".studio-deck__sig-wrap--menu-focus").forEach((el) => {
      el.classList.remove("studio-deck__sig-wrap--menu-focus");
    });
    bar.querySelector(".studio-deck__sig-group--mics")?.classList.remove("studio-deck__sig-group--menu-focus");
  }

  /** Top device bar: collapsed gears + no menu ring — before panel exit animation so chips don’t lag behind. */
  function applyStudioDeviceMenuClosedChipState() {
    clearStudioDeviceBarMenuFocus();
    document.querySelectorAll(".studio-deck__device-settings-btn").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });
    captureStudio.querySelectorAll(".studio-deck__sig--btn").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });
    captureStudio.classList.remove("capture-studio--device-settings-open");
    const bar = document.getElementById("studio-device-bar");
    const panelEl = document.getElementById("studio-device-settings");
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && ((panelEl && panelEl.contains(ae)) || (bar && bar.contains(ae)))) {
      ae.blur();
    }
  }

  function cancelStudioDeviceSettingsCloseAnimation() {
    clearStudioDeviceBarMenuFocus();
    clearStudioDeviceSettingsOpeningAnimation();
    const panel = document.getElementById("studio-device-settings");
    if (studioDeviceSettingsCloseDebounceTimer != null) {
      clearTimeout(studioDeviceSettingsCloseDebounceTimer);
      studioDeviceSettingsCloseDebounceTimer = null;
    }
    if (studioDeviceSettingsCloseFallbackTimer != null) {
      clearTimeout(studioDeviceSettingsCloseFallbackTimer);
      studioDeviceSettingsCloseFallbackTimer = null;
    }
    if (panel && studioDeviceSettingsCloseTransitionEndHandler) {
      panel.removeEventListener("transitionend", studioDeviceSettingsCloseTransitionEndHandler);
    }
    studioDeviceSettingsCloseTransitionEndHandler = null;
    if (panel) {
      panel.classList.remove(
        "studio-device-settings--closing",
        "studio-device-settings--opening",
        "studio-device-settings--opening-ambient",
        "studio-device-settings--opening-visible",
        "studio-device-settings--chip-switch-mode",
        "studio-device-settings--reduced-motion",
        "studio-device-settings--slot-expand",
        "studio-device-settings--stagger-run"
      );
      panel.style.removeProperty("--studio-menu-slot-ms");
      panel.style.removeProperty("clip-path");
      panel.style.removeProperty("opacity");
      panel.style.removeProperty("visibility");
      cleanupStudioMenuStagger(panel);
      clearDeviceSettingsSectionSlideClasses(panel);
    }
    scadaCluster?.style.removeProperty("--studio-menu-slot-ms");
    captureStudio?.style.removeProperty("--studio-menu-slot-ms");
    clearCaptureStudioMenuNudgeTimer();
    stopScadaClusterMenuLift();
    scadaCluster?.classList.remove("scada-cluster--menu-nudge");
  }

  function closeStudioInputMenus() {
    cancelPendingStudioViewportFit();
    const savedMenuW = studioWidthBeforeDeviceMenuPx;
    const userSizedWhileMenu = studioUserResizedWhileDeviceMenuOpen;
    studioWidthBeforeDeviceMenuPx = null;
    studioUserResizedWhileDeviceMenuOpen = false;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const panel = document.getElementById("studio-device-settings");

    const shouldRestoreMenuWidth =
      savedMenuW != null &&
      !userSizedWhileMenu &&
      !captureStudio.classList.contains("hidden") &&
      captureStudio.classList.contains("capture-studio--live-preview");

    function maybeRestorePreMenuStudioInlineWidth() {
      /* menuCloseRestore: no viewport shrink. Animate in sync with menu slot collapse/open so bars + studio scale
         smoothly (instant only when prefers-reduced-motion — handled inside animateStudioWidthTo). */
      if (!shouldRestoreMenuWidth) return;
      const lo = studioMinW();
      const hi = studioMaxW();
      const target = Math.round(Math.max(lo, Math.min(hi, savedMenuW)));
      const cur = Math.round(measureStudioInlineWidthPx());
      if (Math.abs(cur - target) <= 4) return;
      animateStudioWidthTo(target, {
        menuCloseRestore: true,
        allowClusterGapTransition: true,
        durationMs: STUDIO_MENU_CLOSE_TRANSITION_MS,
      });
    }

    /**
     * @param {boolean} [skipWidthRestore] - When true, omit width restore (caller already ran it).
     */
    function finalizeStudioDeviceSettingsClose(skipWidthRestore) {
      /* Hide before cancel: cleanupStudioMenuStagger clears max-height — if still visible, panel flashes open one frame. */
      if (panel) {
        panel.hidden = true;
      }
      cancelStudioDeviceSettingsCloseAnimation();
      if (panel) {
        panel.classList.remove("studio-device-settings--closing");
        delete panel.dataset.openScrollTarget;
        delete panel.dataset.soloSection;
      }

      /* Restore bar + clear device-settings-open *before* width math when needed. Second call is idempotent. */
      applyStudioDeviceMenuClosedChipState();
      void scadaCluster?.offsetHeight;

      if (!skipWidthRestore) {
        maybeRestorePreMenuStudioInlineWidth();
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          smoothClampStudioDeviceBarScroll();
        });
      });
    }

    if (!panel || panel.hidden) {
      finalizeStudioDeviceSettingsClose();
      return;
    }

    if (panel.classList.contains("studio-device-settings--closing")) {
      return;
    }
    if (reduceMotion) {
      finalizeStudioDeviceSettingsClose();
      return;
    }

    applyStudioDeviceMenuClosedChipState();
    void scadaCluster?.offsetHeight;
    /* Width restore runs in finalize after the slot is hidden — parallel width + slot made menu↔deck gap and bar scale “breathe”. */
    cleanupStudioMenuStagger(panel);
    const hClose = Math.max(1, Math.ceil(panel.scrollHeight));
    panel.style.setProperty("--menu-slot-h", `${hClose}px`);
    panel.style.maxHeight = `${hClose}px`;
    void panel.offsetHeight;
    panel.classList.add("studio-device-settings--closing");
    clearCaptureStudioMenuNudgeTimer();
    stopScadaClusterMenuLift();
    scadaCluster?.classList.remove("scada-cluster--menu-nudge");

    const closeAnimProps = new Set([
      "max-height",
      "margin-bottom",
      "margin-block-end",
      "padding-top",
      "padding-bottom",
      "padding-block",
      "padding-block-start",
      "padding-block-end",
      "gap",
      "row-gap",
      "column-gap",
    ]);
    const onCloseTransitionEnd = (ev) => {
      if (ev.target !== panel) return;
      if (!closeAnimProps.has(ev.propertyName)) return;
      if (studioDeviceSettingsCloseDebounceTimer != null) {
        clearTimeout(studioDeviceSettingsCloseDebounceTimer);
      }
      studioDeviceSettingsCloseDebounceTimer = window.setTimeout(() => {
        studioDeviceSettingsCloseDebounceTimer = null;
        if (studioDeviceSettingsCloseFallbackTimer != null) {
          clearTimeout(studioDeviceSettingsCloseFallbackTimer);
          studioDeviceSettingsCloseFallbackTimer = null;
        }
        panel.removeEventListener("transitionend", onCloseTransitionEnd);
        studioDeviceSettingsCloseTransitionEndHandler = null;
        finalizeStudioDeviceSettingsClose(false);
      }, STUDIO_MENU_CLOSE_TRANSITION_END_DEBOUNCE_MS);
    };
    studioDeviceSettingsCloseTransitionEndHandler = onCloseTransitionEnd;
    panel.addEventListener("transitionend", onCloseTransitionEnd);

    studioDeviceSettingsCloseFallbackTimer = window.setTimeout(() => {
      studioDeviceSettingsCloseFallbackTimer = null;
      if (studioDeviceSettingsCloseDebounceTimer != null) {
        clearTimeout(studioDeviceSettingsCloseDebounceTimer);
        studioDeviceSettingsCloseDebounceTimer = null;
      }
      if (studioDeviceSettingsCloseTransitionEndHandler && panel) {
        panel.removeEventListener("transitionend", studioDeviceSettingsCloseTransitionEndHandler);
        studioDeviceSettingsCloseTransitionEndHandler = null;
      }
      if (!panel.classList.contains("studio-device-settings--closing")) return;
      finalizeStudioDeviceSettingsClose(false);
    }, STUDIO_MENU_CLOSE_TRANSITION_MS + 120);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        panel.style.maxHeight = "0px";
      });
    });
  }

  function openStudioDeviceSettingsPanel(scrollToId, openerEl) {
    const panel = document.getElementById("studio-device-settings");
    if (!panel) return;
    cancelStudioDeviceSettingsCloseAnimation();

    const prevScrollTarget = !panel.hidden ? (panel.dataset.openScrollTarget || "") : "";
    const openingFromClosed = panel.hidden;
    /** Height before swapping solo section — used to avoid 0→open replay when switching gears */
    let switchStartHeightPx = 0;
    if (!openingFromClosed) {
      switchStartHeightPx = Math.max(1, Math.round(panel.getBoundingClientRect().height));
    }

    if (panel.hidden) {
      studioWidthBeforeDeviceMenuPx = Math.round(measureStudioInlineWidthPx());
      studioUserResizedWhileDeviceMenuOpen = false;
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const slotMs = reduceMotion ? STUDIO_MENU_SLOT_TRANSITION_REDUCE_MS : STUDIO_MENU_SLOT_TRANSITION_MS;
    if (!reduceMotion && !panel.hidden) {
      panel.style.animation = "none";
      void panel.offsetHeight;
      panel.style.removeProperty("animation");
      panel.style.removeProperty("clip-path");
    }
    syncStudioQualitySelects();
    syncStudioDeviceNameMenus();
    updateStudioMicToggleMenuLabel();

    panel.hidden = false;
    if (scrollToId) panel.dataset.openScrollTarget = scrollToId;
    else delete panel.dataset.openScrollTarget;
    const solo = getSoloSectionIdFromScrollTarget(scrollToId);
    if (solo) panel.dataset.soloSection = solo;
    else delete panel.dataset.soloSection;
    /* Slot duration on cluster + card *before* --device-settings-open so bar gear / focus transitions are already using it (avoids a one-frame jump). */
    panel.style.setProperty("--studio-menu-slot-ms", `${slotMs}ms`);
    if (!reduceMotion) {
      const slotDur = `${slotMs}ms`;
      scadaCluster?.style.setProperty("--studio-menu-slot-ms", slotDur);
      captureStudio?.style.setProperty("--studio-menu-slot-ms", slotDur);
    } else {
      scadaCluster?.style.removeProperty("--studio-menu-slot-ms");
      captureStudio?.style.removeProperty("--studio-menu-slot-ms");
    }
    void captureStudio.offsetHeight;
    captureStudio.classList.add("capture-studio--device-settings-open");
    syncDeviceSettingsChipsAria(scrollToId || null, openerEl || null);
    syncStudioDeviceBarMenuFocus(scrollToId || "");
    scheduleStudioDeviceBarScrollAssist();
    /* Animated width runs in the inner rAF (with menu nudge) so it doesn’t fight the same-frame cluster transform. */

    function scrollPanelToTargetId() {
      if (!scrollToId) return;
      const el = document.getElementById(scrollToId);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "auto" });
      if (scrollToId.startsWith("studio-mic-custom-")) {
        requestAnimationFrame(() => {
          const again = document.getElementById(scrollToId);
          if (again) again.scrollIntoView({ block: "nearest", behavior: "auto" });
        });
      }
    }

    /* Chip switch while reduced-motion: layout-only (no height tween). */
    if (reduceMotion && !openingFromClosed) {
      panel.classList.remove(
        "studio-device-settings--opening",
        "studio-device-settings--chip-switch-mode",
        "studio-device-settings--reduced-motion",
        "studio-device-settings--slot-expand",
        "studio-device-settings--stagger-run"
      );
      panel.style.removeProperty("--studio-menu-slot-ms");
      panel.style.removeProperty("visibility");
      scadaCluster?.style.removeProperty("--studio-menu-slot-ms");
      captureStudio?.style.removeProperty("--studio-menu-slot-ms");
      cleanupStudioMenuStagger(panel);
      const lockedH = Math.max(1, switchStartHeightPx);
      panel.style.setProperty("--menu-slot-h", `${lockedH}px`);
      panel.style.maxHeight = `${lockedH}px`;
      scrollPanelToTargetId();
      scheduleStudioDeviceBarScrollAssist();
      scheduleStudioFitForDeviceSettingsPanel({ animatedWidth: openingFromClosed });
      return;
    }

    panel.classList.add("studio-device-settings--opening");
    if (reduceMotion) {
      panel.classList.add("studio-device-settings--reduced-motion");
    }
    if (!openingFromClosed) {
      panel.classList.add("studio-device-settings--chip-switch-mode");
    }
    if (openingFromClosed) {
      panel.classList.add("studio-device-settings--opening-ambient");
      panel.style.visibility = "hidden";
    }

    let openingDone = false;
    const finishOpeningReveal = () => {
      if (openingDone) return;
      openingDone = true;
      if (studioDeviceSettingsOpeningFallbackTimer != null) {
        clearTimeout(studioDeviceSettingsOpeningFallbackTimer);
        studioDeviceSettingsOpeningFallbackTimer = null;
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          /* End nudge with opening cleanup so a pending 780ms timer doesn’t remove the class one beat later (felt as a second bump). */
          clearCaptureStudioMenuNudgeTimer();
          stopScadaClusterMenuLift();
          scadaCluster?.classList.remove("scada-cluster--menu-nudge");
          cleanupStudioMenuStagger(panel);
          panel.classList.remove(
            "studio-device-settings--opening",
            "studio-device-settings--opening-ambient",
            "studio-device-settings--opening-visible",
            "studio-device-settings--chip-switch-mode",
            "studio-device-settings--reduced-motion",
            "studio-device-settings--slot-expand",
            "studio-device-settings--stagger-run"
          );
          panel.style.removeProperty("--studio-menu-slot-ms");
          scadaCluster?.style.removeProperty("--studio-menu-slot-ms");
          captureStudio?.style.removeProperty("--studio-menu-slot-ms");
          if (!openingFromClosed && switchStartHeightPx > 0) {
            const lockedH = Math.max(1, switchStartHeightPx);
            panel.style.setProperty("--menu-slot-h", `${lockedH}px`);
            panel.style.maxHeight = `${lockedH}px`;
          } else {
            panel.style.removeProperty("max-height");
          }
          panel.style.removeProperty("opacity");
          panel.style.removeProperty("visibility");
          scrollPanelToTargetId();
          /* Defer fit: stagger cleanup + removing --opening changes layout; a second animated shrink/restore here
             read as an end-of-menu “bump”. Instant clamp only; skip try-restore widen until a later RO tick. */
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              /* Instant clamp only — animated width here caused a visible end-of-open “bump”. */
              scheduleStudioFitForDeviceSettingsPanel({
                animatedWidth: false,
                skipTryRestore: true,
              });
            });
          });
        });
      });
    };

    const n = applyStudioMenuStagger(panel);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        panel.style.visibility = "visible";
        if (!reduceMotion) {
          scadaCluster?.classList.add("scada-cluster--menu-nudge");
          scheduleCaptureStudioMenuNudgeRemoval(slotMs + 100);
        }

        if (openingFromClosed) {
          const hOpen = Math.max(1, Math.ceil(panel.scrollHeight));
          panel.style.setProperty("--menu-slot-h", `${hOpen}px`);
          panel.style.maxHeight = "0px";
          void panel.offsetHeight;
          panel.style.maxHeight = "var(--menu-slot-h)";
        } else {
          const lockedH =
            switchStartHeightPx > 0
              ? switchStartHeightPx
              : Math.max(1, Math.round(panel.getBoundingClientRect().height));
          panel.style.setProperty("--menu-slot-h", `${lockedH}px`);
          panel.style.maxHeight = `${lockedH}px`;
          scrollPanelToTargetId();
        }

        panel.classList.add("studio-device-settings--slot-expand", "studio-device-settings--stagger-run");
        if (openingFromClosed) {
          panel.classList.add("studio-device-settings--opening-visible");
        }

        if (
          !reduceMotion &&
          prevScrollTarget &&
          scrollToId &&
          prevScrollTarget !== scrollToId &&
          getDeviceSettingsBarOrder(scrollToId) !== getDeviceSettingsBarOrder(prevScrollTarget)
        ) {
          const soloId = getSoloSectionIdFromScrollTarget(scrollToId);
          const sec = soloId ? document.getElementById(soloId) : null;
          if (sec) {
            clearDeviceSettingsSectionSlideClasses(panel);
            const fromRight =
              getDeviceSettingsBarOrder(scrollToId) > getDeviceSettingsBarOrder(prevScrollTarget);
            void sec.offsetHeight;
            sec.classList.add(
              fromRight
                ? "studio-device-settings__section--enter-from-right"
                : "studio-device-settings__section--enter-from-left"
            );
            let slideCleaned = false;
            let slideFallback = null;
            const onAnimEnd = (ev) => {
              if (ev.target !== sec) return;
              if (
                ev.animationName !== "studioDeviceSettingsEnterFromRight" &&
                ev.animationName !== "studioDeviceSettingsEnterFromLeft"
              ) {
                return;
              }
              cleanupSlide();
            };
            const cleanupSlide = () => {
              if (slideCleaned) return;
              slideCleaned = true;
              sec.removeEventListener("animationend", onAnimEnd);
              if (slideFallback != null) window.clearTimeout(slideFallback);
              sec.classList.remove(
                "studio-device-settings__section--enter-from-right",
                "studio-device-settings__section--enter-from-left"
              );
            };
            sec.addEventListener("animationend", onAnimEnd);
            slideFallback = window.setTimeout(cleanupSlide, slotMs + 120);
          }
        }

        if (panel.classList.contains("studio-device-settings--chip-switch-mode")) {
          scheduleStudioFitForDeviceSettingsPanel({ animatedWidth: openingFromClosed });
        } else if (!reduceMotion) {
          /* One instant clamp during open — deferred animated fit + finishOpeningReveal fit caused bumps */
          scheduleStudioFitForDeviceSettingsPanel({ animatedWidth: false });
        } else {
          scheduleStudioFitForDeviceSettingsPanel({ animatedWidth: openingFromClosed });
        }

        /* Last in this frame so width clamp / layout don’t clear the lift’s starting transform */
        if (
          !reduceMotion &&
          !panel.classList.contains("studio-device-settings--chip-switch-mode") &&
          !captureStudio.classList.contains("hidden") &&
          captureStudio.classList.contains("capture-studio--live-preview")
        ) {
          playScadaClusterMenuLiftIfLivePreview(slotMs);
        }

        const staggerEndMs =
          reduceMotion || n === 0 ? slotMs : (n - 1) * STUDIO_MENU_STAGGER_STEP_MS + slotMs;
        const totalMs = Math.max(slotMs, staggerEndMs) + 32;
        studioDeviceSettingsOpeningFallbackTimer = window.setTimeout(finishOpeningReveal, totalMs);
      });
    });
  }

  function toggleStudioDeviceSettingsChip(scrollToId, openerEl) {
    const panel = document.getElementById("studio-device-settings");
    const wasOpen = panel && !panel.hidden;
    const cur = panel?.dataset.openScrollTarget || "";
    if (wasOpen && cur === scrollToId) {
      closeStudioInputMenus();
      return;
    }
    openStudioDeviceSettingsPanel(scrollToId, openerEl);
  }

  function updateStudioMicToggleMenuLabel() {
    const el = document.getElementById("studio-menu-mic-toggle");
    if (!el) return;
    el.textContent = hasLiveMicInMix()
      ? "Re-apply selected microphones"
      : "Apply selected microphones";
  }

  function openStudioMicMenu() {
    const panel = document.getElementById("studio-device-settings");
    const wasOpen = panel && !panel.hidden;
    closeStudioInputMenus();
    if (wasOpen) return;
    openStudioDeviceSettingsPanel("studio-menu-mic");
  }

  function openStudioInputMenu(btn) {
    const menuMap = {
      "studio-sig-video": "studio-menu-video",
      "studio-sig-sys": "studio-menu-sys",
    };
    const sid = menuMap[btn.id];
    if (!sid) return;
    const panel = document.getElementById("studio-device-settings");
    const wasOpen = panel && !panel.hidden;
    closeStudioInputMenus();
    if (wasOpen) return;
    openStudioDeviceSettingsPanel(sid);
  }

  function stopStudioAudioMeter() {
    if (studioMeterRafId != null) {
      cancelAnimationFrame(studioMeterRafId);
      studioMeterRafId = null;
    }
  }

  function runStudioAudioMeter(stream, fillEl, wrapEl, durationMs, onDone) {
    stopStudioAudioMeter();
    const tracks = stream.getAudioTracks().filter((t) => t.readyState === "live");
    if (!tracks.length) {
      setStatus("No live audio to measure.");
      if (onDone) onDone();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try {
      ctx = new Ctx();
    } catch (_) {
      setStatus("Audio meter unavailable.");
      if (onDone) onDone();
      return;
    }
    const src = ctx.createMediaStreamSource(new MediaStream(tracks));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const fd = new Uint8Array(an.frequencyBinCount);
    const t0 = performance.now();
    wrapEl.classList.add("is-active");
    wrapEl.setAttribute("aria-hidden", "false");
    const finish = () => {
      stopStudioAudioMeter();
      fillEl.style.width = "0%";
      wrapEl.classList.remove("is-active");
      wrapEl.setAttribute("aria-hidden", "true");
      try {
        src.disconnect();
      } catch (_) {
        /* ignore */
      }
      try {
        an.disconnect();
      } catch (_) {
        /* ignore */
      }
      ctx.close().catch(() => {});
      if (onDone) onDone();
    };
    const tick = () => {
      if (performance.now() - t0 >= durationMs) {
        finish();
        return;
      }
      an.getByteFrequencyData(fd);
      let sum = 0;
      for (let i = 0; i < fd.length; i++) sum += fd[i];
      const n = sum / fd.length / 255;
      fillEl.style.width = `${Math.min(100, Math.round(n * 240))}%`;
      studioMeterRafId = requestAnimationFrame(tick);
    };
    studioMeterRafId = requestAnimationFrame(tick);
  }

  function studioShowScreenInfo() {
    closeStudioInputMenus();
    const stream = studioCapture?.displayStream ?? recordSession?.displayStream;
    if (!stream) return;
    const vt = stream.getVideoTracks()[0];
    if (!vt) {
      setStatus("No video track.");
      return;
    }
    const s = (typeof vt.getSettings === "function" && vt.getSettings()) || {};
    const parts = [
      s.displaySurface && `Surface: ${s.displaySurface}`,
      s.width && s.height && `${s.width}×${s.height}`,
      vt.label && `“${vt.label}”`,
    ].filter(Boolean);
    setStatus(parts.length ? parts.join(" · ") : "No extra details from the browser.");
  }

  function studioReplaceScreenShare() {
    if (recordSession) {
      closeStudioInputMenus();
      setStatus("Stop recording before replacing screen share.");
      return;
    }
    closeStudioInputMenus();
    disposeStudioCapture();
    setStatus("Pick what to share — enable “Share tab audio” or “Share system audio” in the dialog if you want sound.");
    /* Must call immediately: a timeout breaks user activation and getDisplayMedia can fail or do nothing. */
    void startSnipe();
  }

  async function studioPrimeMicrophonePermission() {
    closeStudioInputMenus();
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      setStatus("Microphone not supported here.");
      return;
    }
    try {
      const devices = await getAudioInputDevices();
      const def = pickDefaultMicDeviceInfo(devices);
      let s;
      if (def) {
        try {
          s = await md.getUserMedia({
            audio: {
              deviceId: { exact: def.deviceId },
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
        } catch (_) {
          s = await md.getUserMedia({ audio: { deviceId: { exact: def.deviceId } }, video: false });
        }
      } else {
        s = await md.getUserMedia({ audio: true, video: false });
      }
      s.getTracks().forEach((t) => t.stop());
      await refreshMicDeviceList();
      clearInputPermissionBlocked();
      setStatus("Microphone access OK. Use the mic buttons to choose inputs.");
    } catch (e) {
      if (e && e.name === "NotAllowedError") {
        setInputPermissionBlocked({ mic: true });
      } else {
        setStatus("Microphone permission not granted.");
      }
    }
  }

  async function studioRunMicTest() {
    const b = studioCapture;
    const sess = recordSession;
    let ownStream = null;
    /** @type {MediaStream | null} */
    let stream = b?.micStream || sess?.micStream || null;
    if (!stream || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
      try {
        const ids = getEnabledMicDeviceIds(getInputIntent());
        if (ids.length) {
          ownStream = await acquireCombinedMicStreamFromDeviceIds(ids);
        } else {
          await refreshMicDeviceList();
          const devices = await getAudioInputDevices();
          const def = pickDefaultMicDeviceInfo(devices);
          const md = navigator.mediaDevices;
          if (def) {
            try {
              ownStream = await md.getUserMedia({
                audio: {
                  deviceId: { exact: def.deviceId },
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                },
                video: false,
              });
            } catch (_) {
              ownStream = await md.getUserMedia({
                audio: { deviceId: { exact: def.deviceId } },
                video: false,
              });
            }
          } else {
            ownStream = await md.getUserMedia({ audio: true, video: false });
          }
        }
        stream = ownStream;
      } catch (e) {
        closeStudioInputMenus();
        if (e && e.name === "NotAllowedError") {
          setInputPermissionBlocked({ mic: true });
        } else {
          setStatus("Could not open microphone for test.");
        }
        return;
      }
    }
    const fill = document.getElementById("studio-mic-meter-fill");
    const wrap = document.getElementById("studio-mic-meter");
    if (!stream || !fill || !wrap) {
      if (ownStream) ownStream.getTracks().forEach((t) => t.stop());
      closeStudioInputMenus();
      return;
    }
    closeStudioInputMenus();
    setStatus("Microphone test — speak for 3 seconds.");
    runStudioAudioMeter(stream, fill, wrap, 3000, () => {
      if (ownStream) ownStream.getTracks().forEach((t) => t.stop());
      setStatus("Microphone test finished.");
    });
  }

  function studioRunSysTest() {
    closeStudioInputMenus();
    const stream = studioCapture?.displayStream ?? recordSession?.displayStream;
    if (!stream) return;
    const tracks = stream.getAudioTracks().filter((t) => t.readyState === "live");
    if (!tracks.length) {
      setStatus("No shared audio track — enable tab or system audio in the share dialog next time.");
      return;
    }
    const fill = document.getElementById("studio-sys-meter-fill");
    const wrap = document.getElementById("studio-sys-meter");
    if (!fill || !wrap) return;
    setStatus("Shared audio test — play sound on the shared source for 3 seconds.");
    runStudioAudioMeter(stream, fill, wrap, 3000, () => {
      setStatus("Shared audio test finished.");
    });
  }

  function handleStudioMenuAction(action) {
    switch (action) {
      case "screen-replace":
        studioReplaceScreenShare();
        break;
      case "screen-info":
        studioShowScreenInfo();
        break;
      case "region-toggle":
        closeStudioInputMenus();
        {
          const next = !captureStudio.classList.contains("capture-studio--selecting");
          captureStudio.classList.toggle("capture-studio--selecting", next);
        }
        break;
      case "region-clear":
        closeStudioInputMenus();
        studioRegionNorm = null;
        studioRegionEl.hidden = true;
        setStatus("Full screen will be recorded (crop cleared).");
        break;
      case "mic-permission":
        void studioPrimeMicrophonePermission();
        break;
      case "mic-toggle-mix":
        closeStudioInputMenus();
        void onStudioVoiceToggle().catch((err) => {
          setStatus((err && err.message) || "Microphone update failed.");
        });
        break;
      case "mic-test":
        studioRunMicTest();
        break;
      case "sys-test":
        studioRunSysTest();
        break;
      default:
        break;
    }
  }

  function setStudioSigTriggersDisabled(disabled) {
    captureStudio.querySelectorAll(".studio-deck__sig--btn").forEach((b) => {
      b.disabled = disabled;
    });
  }

  function clearSnipeStudioRecordUi() {
    if (!snipeBtn) return;
    snipeBtn.classList.remove("rec-go--in-studio", "rec-go--studio-start", "rec-go--recording-stop");
    snipeBtn.querySelector(".rec-go__glyph--idle")?.removeAttribute("hidden");
    snipeBtn.querySelector(".rec-go__glyph--studio")?.setAttribute("hidden", "");
    snipeBtn.querySelector(".rec-go__glyph--stop")?.setAttribute("hidden", "");
    snipeBtn.setAttribute("aria-label", "Start screen capture");
  }

  function applySnipeStudioStopUi() {
    if (!snipeBtn) return;
    snipeBtn.classList.remove("rec-go--studio-start");
    snipeBtn.classList.add("rec-go--in-studio", "rec-go--recording-stop");
    snipeBtn.querySelector(".rec-go__glyph--idle")?.setAttribute("hidden", "");
    snipeBtn.querySelector(".rec-go__glyph--studio")?.setAttribute("hidden", "");
    snipeBtn.querySelector(".rec-go__glyph--stop")?.removeAttribute("hidden");
    snipeBtn.disabled = false;
    snipeBtn.setAttribute("aria-label", "Stop recording. Elapsed 0:00.");
    setHubCancelVisible(false);
    setHubSaveVisible(false);
  }

  /** Recording paused: record (circle) glyph — aria comes from updateRecordingHud. */
  function applySnipeStudioPausedUi() {
    if (!snipeBtn) return;
    snipeBtn.classList.remove("rec-go--recording-stop");
    snipeBtn.classList.add("rec-go--in-studio", "rec-go--studio-start");
    snipeBtn.querySelector(".rec-go__glyph--idle")?.setAttribute("hidden", "");
    snipeBtn.querySelector(".rec-go__glyph--studio")?.removeAttribute("hidden");
    snipeBtn.querySelector(".rec-go__glyph--stop")?.setAttribute("hidden", "");
    snipeBtn.disabled = false;
    setHubCancelVisible(true);
    setHubSaveVisible(true);
  }

  function applySnipeStudioRecordUi() {
    if (!snipeBtn) return;
    snipeBtn.classList.add("rec-go--in-studio", "rec-go--studio-start");
    snipeBtn.querySelector(".rec-go__glyph--idle")?.setAttribute("hidden", "");
    snipeBtn.querySelector(".rec-go__glyph--studio")?.removeAttribute("hidden");
    snipeBtn.setAttribute("aria-label", "Start recording");
    snipeBtn.disabled = false;
  }

  function ensureSnipeInCluster() {
    if (!snipeBtn || !hubSnipeSlot) return;
    clearSnipeStudioRecordUi();
    if (snipeBtn.parentElement !== hubSnipeSlot) {
      hubSnipeSlot.appendChild(snipeBtn);
    }
  }

  function ensureSnipeInStudio() {
    if (!snipeBtn) return;
    ensureSnipeInCluster();
    applySnipeStudioRecordUi();
  }

  function cancelStatusReveal() {
    if (statusRevealTimer != null) {
      clearTimeout(statusRevealTimer);
      statusRevealTimer = null;
    }
  }

  /** Short labels (1–2 words) for the system status line; unknown strings → first two words. */
  function compactStatusForDisplay(input) {
    const raw = input == null ? "" : String(input).trim();
    if (!raw) return "";

    const foundM = raw.match(/^Found (\d+) scene splits?\./);
    if (foundM) {
      return foundM[1] === "1" ? "One split" : `${foundM[1]} splits`;
    }
    if (/^Saved\s/i.test(raw)) return "Saved";

    const pairs = [
      [/^No live audio/i, "No audio"],
      [/^Audio meter unavailable/i, "No meter"],
      [/^No video track/i, "No video"],
      [/^No extra details/i, "No details"],
      [/^Stop recording before/i, "Stop first"],
      [/^Pick what to share/i, "Pick share"],
      [/^Microphone not supported/i, "No mic API"],
      [/^Microphone is already/i, "Mic ready"],
      [/^Microphone added to recording/i, "Mic added"],
      [/^Could not add microphone/i, "Mic failed"],
      [/^Microphone access OK/i, "Mic OK"],
      [/^Microphone blocked — check site permissions/i, "Mic blocked"],
      [/^Microphone permission not granted/i, "No permission"],
      [/^Microphone blocked — cannot run test/i, "Blocked"],
      [/^Could not open microphone for test/i, "Test failed"],
      [/^Microphone test — speak/i, "Mic test"],
      [/^Microphone test finished/i, "Test done"],
      [/^No shared audio track/i, "No tab audio"],
      [/^Shared audio test — play sound/i, "Sys test"],
      [/^Shared audio test finished/i, "Test done"],
      [/^Full screen will be recorded/i, "Crop cleared"],
      [/^Microphone update failed/i, "Update fail"],
      [/^Scanning video for scene/i, "Scanning"],
      [/^Review, drag trim/i, "Review clip"],
      [/^Share stopped/i, "Share ended"],
      [/^Crop set —/i, "Crop set"],
      [/^Draw a rectangle/i, "Draw crop"],
      [/^Nothing recorded/i, "No data"],
      [/^Turn Voice on before/i, "Mic first"],
      [/^Microphone off/i, "Mic off"],
      [/^Microphone on —/i, "Mic mixed"],
      [/^Microphone on\.?$/i, "Mic on"],
      [/^Microphone removed from capture/i, "Mic out"],
      [/^Could not update capture/i, "Update fail"],
      [/^Could not mix microphone/i, "Mix failed"],
      [/^Microphone cancelled or denied/i, "Mic denied"],
      [/^Crop area too small/i, "Crop small"],
      [/^Capture ended/i, "Share ended"],
      [/^Video not ready/i, "Wait video"],
      [/^Could not start audio for recording/i, "Audio fail"],
      [/^Could not create recorder/i, "No recorder"],
      [/^Recording\.?$/i, "Recording"],
      [/^Recorder failed to start/i, "Start failed"],
      [/^Share cancelled/i, "Cancelled"],
      [/^Display capture timed out/i, "Timed out"],
      [/^Could not start capture/i, "Start failed"],
      [/^Recording cancelled/i, "Cancelled"],
      [/^Exporting/i, "Exporting"],
      [/^Trim not supported/i, "Full save"],
      [/^Save failed/i, "Save failed"],
      [/^Quality:\s*high/i, "High quality"],
      [/^Quality:\s*balanced/i, "Balanced"],
      [/^Quality:\s*smaller/i, "Small files"],
    ];

    for (let i = 0; i < pairs.length; i += 1) {
      const re = pairs[i][0];
      const out = pairs[i][1];
      if (re.test(raw)) return out;
    }

    if (raw.includes("Surface:") || /\d+×\d+/.test(raw)) return "Display info";

    const norm = raw.replace(/\s+/g, " ");
    const words = norm.split(" ");
    let short = words.slice(0, 2).join(" ");
    if (short.length > 28) short = short.slice(0, 28).trim();
    return short || norm.slice(0, 24);
  }

  const STATUS_CHAR_MS = 14;

  function setStatus(msg) {
    cancelStatusReveal();
    if (msg == null || msg === "") {
      statusEl.textContent = "";
      statusEl.removeAttribute("aria-label");
      return;
    }
    const full = compactStatusForDisplay(String(msg));
    if (!full) {
      statusEl.textContent = "";
      statusEl.removeAttribute("aria-label");
      return;
    }
    statusEl.setAttribute("aria-label", full);
    const instant =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (instant) {
      statusEl.textContent = full;
      return;
    }
    statusEl.textContent = "";
    let i = 0;
    const step = () => {
      if (i >= full.length) {
        statusRevealTimer = null;
        return;
      }
      statusEl.textContent += full[i];
      i += 1;
      statusRevealTimer = window.setTimeout(step, STATUS_CHAR_MS);
    };
    statusRevealTimer = window.setTimeout(step, 0);
  }

  const STATUS_PERMISSION_BLOCKED = "Permission denied.";

  function clearInputPermissionBlocked() {
    document.querySelectorAll(".studio-deck__sig--blocked").forEach((el) => {
      el.classList.remove("studio-deck__sig--blocked");
    });
  }

  /** @param {{ video?: boolean; mic?: boolean; sys?: boolean }} which */
  function setInputPermissionBlocked(which) {
    clearInputPermissionBlocked();
    for (const key of ["video", "sys"]) {
      if (!which[key]) continue;
      document
        .querySelectorAll(`[data-studio-signal="${key}"], [data-signal="${key}"]`)
        .forEach((el) => {
          el.classList.add("studio-deck__sig--blocked");
        });
    }
    if (which.mic) {
      document.querySelectorAll("[data-mic-device-id]").forEach((el) => {
        el.classList.add("studio-deck__sig--blocked");
      });
    }
    setStatus(STATUS_PERMISSION_BLOCKED);
  }

  function restoreRecordingPanel() {
    try {
      if (recordPanel.ownerDocument !== document) {
        scadaCluster.appendChild(recordPanel);
      }
    } catch (_) {
      /* ignore */
    }
    recordPanel.classList.remove("record-panel--pip");
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function safeDownloadFilename(input, defaultBase, ext) {
    const raw = (input || "").trim() || defaultBase;
    const cleaned = raw.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, " ");
    const base = cleaned || defaultBase;
    const withExt = /\.[a-z0-9]+$/i.test(base) ? base : `${base}.${ext}`;
    return withExt;
  }

  function formatWallTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function waitMediaEvent(el, name) {
    return new Promise((resolve) => el.addEventListener(name, resolve, { once: true }));
  }

  function isFullTrimRange(t0, t1, duration) {
    return t0 <= FULL_TRIM_EPS && t1 >= duration - FULL_TRIM_EPS;
  }

  async function exportTrimmedBlob(originalBlob, t0, t1) {
    const span = t1 - t0;
    if (span < MIN_TRIM_SEC) throw new Error("Selected range too short.");
    const url = URL.createObjectURL(originalBlob);
    const v = document.createElement("video");
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    await waitMediaEvent(v, "loadedmetadata");
    const dur = v.duration;
    const a = clamp(t0, 0, Math.max(0, dur - MIN_TRIM_SEC));
    const b = clamp(t1, a + MIN_TRIM_SEC, dur);
    if (b - a < MIN_TRIM_SEC) {
      URL.revokeObjectURL(url);
      v.remove();
      throw new Error("Invalid trim range.");
    }
    if (typeof v.captureStream !== "function") {
      URL.revokeObjectURL(url);
      v.remove();
      return null;
    }
    const cap = v.captureStream(30);
    const mime = pickRecorderMime();
    const br = getRecordingBitrates();
    const recOpts = { videoBitsPerSecond: br.video };
    if (mime) recOpts.mimeType = mime;
    if (!mime || mime.includes("opus") || mime.includes("webm")) {
      recOpts.audioBitsPerSecond = br.audio;
    }
    let recorder;
    try {
      recorder = new MediaRecorder(cap, recOpts);
    } catch (_) {
      try {
        recorder = mime ? new MediaRecorder(cap, { mimeType: mime }) : new MediaRecorder(cap);
      } catch (e2) {
        URL.revokeObjectURL(url);
        v.remove();
        throw e2;
      }
    }
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise((res) => {
      recorder.onstop = () => res();
    });
    recorder.start(100);
    v.currentTime = a;
    await waitMediaEvent(v, "seeked");
    await v.play();
    await new Promise((resolve) => {
      const onTime = () => {
        if (v.currentTime >= b - 0.04 || v.ended) {
          v.pause();
          try {
            recorder.stop();
          } catch (_) {
            /* ignore */
          }
          v.removeEventListener("timeupdate", onTime);
          resolve();
        }
      };
      v.addEventListener("timeupdate", onTime);
    });
    await stopped;
    const outMime = mime || recorder.mimeType || originalBlob.type;
    const blob = new Blob(chunks, { type: outMime });
    URL.revokeObjectURL(url);
    v.remove();
    return blob;
  }

  function trimClientXToTime(clientX) {
    const r = previewTrimTrack.getBoundingClientRect();
    if (r.width < 1) return 0;
    const p = clamp((clientX - r.left) / r.width, 0, 1);
    return p * studioVideo.duration;
  }

  function syncTrimVisuals() {
    if (!pendingPreview || !isFinite(studioVideo.duration) || studioVideo.duration <= 0) return;
    const d = studioVideo.duration;
    let i = pendingPreview.trimIn;
    let o = pendingPreview.trimOut;
    i = clamp(i, 0, d - MIN_TRIM_SEC);
    o = clamp(o, i + MIN_TRIM_SEC, d);
    pendingPreview.trimIn = i;
    pendingPreview.trimOut = o;
    previewTrimRange.style.left = `${(i / d) * 100}%`;
    previewTrimRange.style.width = `${((o - i) / d) * 100}%`;
    previewTrimIn.style.left = `${(i / d) * 100}%`;
    previewTrimOut.style.left = `${(o / d) * 100}%`;
    renderTrimSplits();
  }

  function renderTrimSplits() {
    if (!pendingPreview) return;
    previewTrimSplits.innerHTML = "";
    const d = studioVideo.duration;
    if (!isFinite(d) || d <= 0) return;
    const splits = pendingPreview.sceneSplits;
    if (!splits || !splits.length) return;
    for (const t of splits) {
      if (!isFinite(t) || t <= 0 || t >= d) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preview-trim__split";
      btn.style.left = `${(t / d) * 100}%`;
      btn.dataset.time = String(t);
      btn.setAttribute("aria-label", `Scene change at ${formatWallTime(t)}`);
      previewTrimSplits.appendChild(btn);
    }
  }

  async function analyzeSceneSplitsForPreview() {
    const v = studioVideo;
    const pp = pendingPreview;
    if (!pp || !isFinite(v.duration) || v.duration < 0.35) {
      if (pp) {
        pp.sceneSplits = [];
        renderTrimSplits();
      }
      return;
    }
    const d = v.duration;
    const w = 48;
    const h = 27;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      pp.sceneSplits = [];
      renderTrimSplits();
      return;
    }

    const sampleCount = Math.min(72, Math.max(6, Math.ceil(d / 0.3)));
    const savedTime = v.currentTime;
    const wasPaused = v.paused;
    v.pause();

    const diffs = [];
    let prev = null;

    try {
      setStatus("Scanning video for scene changes…");
      for (let k = 0; k < sampleCount; k += 1) {
        if (!pendingPreview || pendingPreview !== pp) return;
        const t = k === sampleCount - 1 ? Math.max(0, d - 0.06) : (k / (sampleCount - 1)) * (d - 0.06);
        v.currentTime = t;
        await waitMediaEvent(v, "seeked");
        ctx.drawImage(v, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        if (prev) {
          let score = 0;
          for (let i = 0; i < data.length; i += 16) {
            score +=
              Math.abs(data[i] - prev[i]) +
              Math.abs(data[i + 1] - prev[i + 1]) +
              Math.abs(data[i + 2] - prev[i + 2]);
          }
          diffs.push({ t, score });
        }
        prev = new Uint8ClampedArray(data);
      }
    } catch (_) {
      pp.sceneSplits = [];
      renderTrimSplits();
      setStatus("Review, drag trim handles if needed, then Save or Discard.");
      return;
    } finally {
      v.currentTime = savedTime;
      try {
        await waitMediaEvent(v, "seeked");
      } catch (_) {
        /* ignore */
      }
      if (!wasPaused) {
        v.play().catch(() => {});
      }
    }

    if (!pendingPreview || pendingPreview !== pp) return;

    if (diffs.length < 3) {
      pp.sceneSplits = [];
      renderTrimSplits();
      setStatus("Review, drag trim handles if needed, then Save or Discard.");
      return;
    }

    const sorted = diffs.map((x) => x.score).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    const thresh = med * 2.35 + w * h * 0.06;
    const raw = diffs.filter((x) => x.score > thresh).map((x) => x.t);
    const MIN_GAP = 0.82;
    const splits = [];
    for (const t of raw.sort((a, b) => a - b)) {
      if (!splits.length || t - splits[splits.length - 1] >= MIN_GAP) {
        splits.push(t);
      }
    }
    pp.sceneSplits = splits;
    renderTrimSplits();
    setStatus(
      splits.length
        ? `Found ${splits.length} scene split${splits.length === 1 ? "" : "s"} on the timeline.`
        : "Review, drag trim handles if needed, then Save or Discard."
    );
    window.setTimeout(() => {
      if (pendingPreview === pp) setStatus("");
    }, 4500);
  }

  function closePreview() {
    document.removeEventListener("pointermove", onTrimDragMove, true);
    document.removeEventListener("pointerup", onTrimDragEnd, true);
    document.removeEventListener("pointercancel", onTrimDragEnd, true);
    trimDragKind = null;
    if (pendingPreview && pendingPreview.objectUrl) {
      try {
        URL.revokeObjectURL(pendingPreview.objectUrl);
      } catch (_) {
        /* ignore */
      }
    }
    pendingPreview = null;
    trimDragKind = null;
    previewTrimSplits.innerHTML = "";
    studioVideo.pause();
    studioVideo.removeAttribute("src");
    studioVideo.removeAttribute("controls");
    studioVideo.muted = true;
    studioVideo.setAttribute("playsinline", "");
    studioVideo.setAttribute("autoplay", "");
    studioVideo.load();
    previewFilename.value = "";
    captureStudio.classList.remove("capture-studio--review", "capture-studio--live-preview");
    resetStudioPanelGeometry();
    updateStudioResizeHandleVisibility();
    studioReview.hidden = true;
    studioReview.setAttribute("aria-hidden", "true");
    studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
    captureStudio.classList.add("hidden");
    captureStudio.setAttribute("aria-hidden", "true");
    document.body.classList.remove("is-preview");
    snipeBtn.disabled = false;
    hideRecordTimer();
    setHubCancelVisible(false);
    setHubSaveVisible(false);
    disposeStudioCaptureSilent();
    document.body.classList.remove("is-live-capture");
    applyIdleInputIndicators();
    setStatus("");
  }

  function openPreview(blob, outMime) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ext = /mp4/i.test(outMime) ? "mp4" : "webm";
    const defaultBase = `snipe-${stamp}`;
    const objectUrl = URL.createObjectURL(blob);
    pendingPreview = {
      blob,
      outMime,
      objectUrl,
      ext,
      defaultBase,
      trimIn: 0,
      trimOut: 0,
      sceneSplits: [],
    };
    captureStudio.classList.add("capture-studio--live-preview", "capture-studio--review");
    applyStoredStudioWidth();
    updateStudioResizeHandleVisibility();
    studioReview.hidden = false;
    studioReview.setAttribute("aria-hidden", "false");
    studioVideo.removeAttribute("autoplay");
    studioVideo.muted = false;
    studioVideo.setAttribute("controls", "");
    studioVideo.src = objectUrl;
    previewFilename.value = `${defaultBase}.${ext}`;
    document.body.classList.add("is-preview");
    snipeBtn.disabled = true;
    setStatus("");
    const revealRecording = () => {
      requestAnimationFrame(() => {
        studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
      });
    };
    const onData = () => {
      studioVideo.removeEventListener("loadeddata", onData);
      studioVideo.removeEventListener("error", onVideoErr);
      if (!pendingPreview) return;
      syncStudioAspectFromCapture();
      updateStudioResizeHandleVisibility();
      const d = studioVideo.duration;
      pendingPreview.trimIn = 0;
      pendingPreview.trimOut = isFinite(d) && d > 0 ? d : 0;
      syncTrimVisuals();
      revealRecording();
      analyzeSceneSplitsForPreview().catch(() => {
        if (pendingPreview) {
          pendingPreview.sceneSplits = [];
          renderTrimSplits();
        }
      });
    };
    const onVideoErr = () => {
      studioVideo.removeEventListener("loadeddata", onData);
      studioVideo.removeEventListener("error", onVideoErr);
      revealRecording();
    };
    studioVideo.addEventListener("loadeddata", onData, { once: true });
    studioVideo.addEventListener("error", onVideoErr, { once: true });
    window.setTimeout(() => {
      try {
        previewFilename.focus();
        previewFilename.select();
      } catch (_) {
        /* ignore */
      }
    }, 120);
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  }

  function isAppleSafari() {
    const ua = navigator.userAgent;
    return /Safari/i.test(ua) && !/Chrome/i.test(ua) && !/Chromium/i.test(ua) && !/Edg/i.test(ua);
  }

  function pickRecorderMime() {
    /* MP4 (H.264 + AAC) first — plays in messengers, iOS, WhatsApp, Telegram, email attachments. */
    const mp4 = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4;codecs=avc1",
      "video/mp4",
    ];
    const webm = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const list = [...mp4, ...webm];
    if (typeof MediaRecorder === "undefined") return "";
    for (const t of list) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  /** Prefer MP4 when supported; video-only streams skip opus-in-webm pairs that confuse some encoders. */
  function pickRecorderMimeForStream(stream) {
    if (!stream || typeof MediaRecorder === "undefined") return pickRecorderMime();
    const hasAud = stream.getAudioTracks().some((t) => t.readyState !== "ended");
    const hasVid = stream.getVideoTracks().some((t) => t.readyState !== "ended");
    if (hasVid && hasAud) {
      const mp4va = [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
      ];
      for (const t of mp4va) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
    }
    if (hasVid && !hasAud) {
      const mp4v = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"];
      for (const t of mp4v) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
      const webmV = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      for (const t of webmV) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
    }
    if (!hasVid && hasAud) {
      const mp4a = ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "video/mp4;codecs=mp4a.40.2", "video/mp4"];
      for (const t of mp4a) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
      const webmA = ["audio/webm;codecs=opus", "audio/webm"];
      for (const t of webmA) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
    }
    return pickRecorderMime();
  }

  async function resumeAudioContextLimited(ctx, capMs) {
    if (!ctx || ctx.state === "closed") return;
    const ms = capMs == null ? 500 : capMs;
    try {
      await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, ms))]);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Chrome needs `audio: true` for “Share tab audio” / “Share system audio” to produce an
   * audio track. Do not pass AbortSignal into getDisplayMedia: when the native picker closes,
   * Chrome may deliver Escape to the page; aborting the same request can leave the promise
   * stuck and the UI frozen (snipeArming never clears).
   *
   * Chromium: call `getDisplayMedia({ video: true, audio: true })` **first**. Top-level
   * `systemAudio` / `suppressLocalAudioPlayback` with the extended shape can succeed but omit
   * audio tracks even when the user enables sound in the picker — minimal constraints match
   * what Chrome’s dialog applies. Fall back to extended hints (macOS system loopback, etc.)
   * only when the minimal call fails with a constraint error.
   */
  async function getDisplayStreamWithAudio() {
    const md = navigator.mediaDevices;
    if (isAppleSafari()) {
      try {
        return await md.getDisplayMedia({ video: true, audio: true });
      } catch (e) {
        if (e.name === "NotAllowedError" || e.name === "AbortError") throw e;
        return await md.getDisplayMedia({ video: true, audio: false });
      }
    }
    /* Chromium: bias toward monitor (full screen) capture. Do not pass surfaceSwitching — it is for tab
     * shares and can leave the Chrome window looking like a single frozen tab when the user picked a display. */
    try {
      return await md.getDisplayMedia({
        video: {
          cursor: "always",
          displaySurface: "monitor",
        },
        audio: true,
      });
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "AbortError") throw e;
      if (
        e.name !== "TypeError" &&
        e.name !== "NotSupportedError" &&
        e.name !== "OverconstrainedError"
      ) {
        throw e;
      }
    }
    try {
      return await md.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "AbortError") throw e;
      if (
        e.name !== "TypeError" &&
        e.name !== "NotSupportedError" &&
        e.name !== "OverconstrainedError"
      ) {
        throw e;
      }
    }
    try {
      return await md.getDisplayMedia({
        video: true,
        audio: {
          suppressLocalAudioPlayback: true,
        },
        systemAudio: "include",
      });
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "AbortError") throw e;
      if (
        e.name !== "TypeError" &&
        e.name !== "NotSupportedError" &&
        e.name !== "OverconstrainedError"
      ) {
        throw e;
      }
      try {
        return await md.getDisplayMedia({ video: true, audio: true });
      } catch (e2) {
        if (e2.name === "NotAllowedError" || e2.name === "AbortError") throw e2;
        if (
          e2.name === "TypeError" ||
          e2.name === "NotSupportedError" ||
          e2.name === "OverconstrainedError"
        ) {
          return await md.getDisplayMedia({ video: true, audio: false });
        }
        throw e2;
      }
    }
  }

  /** Video track for MediaRecorder when we must not use the raw display MediaStream object. */
  function forkVideoTrackForRecorder(displayStream) {
    const t = displayStream.getVideoTracks()[0];
    if (!t) return null;
    try {
      return typeof t.clone === "function" ? t.clone() : t;
    } catch (_) {
      return t;
    }
  }

  /**
   * Build record stream from display (+ optional mic). Options exclude video or tab/system audio from the file.
   * @param {{ includeVideo?: boolean; includeDisplayAudio?: boolean }} [opts]
   */
  async function makeRecordPipeline(displayStream, micStream, opts) {
    const includeVideo = opts?.includeVideo !== false;
    const includeDisplayAudio = opts?.includeDisplayAudio !== false;

    const videoTrack = displayStream.getVideoTracks()[0];
    if (includeVideo && (!videoTrack || videoTrack.readyState === "ended")) {
      throw new Error("No video track from screen share.");
    }

    /* Do not toggle track.enabled here — disabling tab/system audio breaks preview meters and can
     * interfere with pipelines. Recording mix gates shared audio via studioMixer.setDisplayAudible
     * and by which tracks are wired into the mixed output. */

    const displayAudioTracks = includeDisplayAudio
      ? displayStream.getAudioTracks().filter((t) => t.readyState !== "ended")
      : [];

    const micAudioTracks = micStream
      ? micStream.getAudioTracks().filter((t) => t.readyState !== "ended")
      : [];

    let recordStream;
    let audioContext = null;
    const hasSys = displayAudioTracks.length > 0;
    const hasMic = micAudioTracks.length > 0;

    const ensureCtxRunning = async (ctx) => {
      await ctx.resume();
      if (ctx.state === "running") return;
      await Promise.race([
        new Promise((resolve) => {
          const onState = () => {
            if (ctx.state === "running") {
              ctx.removeEventListener("statechange", onState);
              resolve();
            }
          };
          ctx.addEventListener("statechange", onState);
          onState();
        }),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    };

    if (!includeVideo) {
      if (!hasMic && !hasSys) {
        throw new Error("Nothing to record — enable shared audio or microphone.");
      }
      if (!hasMic && hasSys) {
        recordStream = new MediaStream(displayAudioTracks);
      } else if (hasMic && !hasSys) {
        recordStream = new MediaStream(micAudioTracks);
      } else {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        try {
          audioContext = new Ctx();
        } catch (_) {
          audioContext = new Ctx({ sampleRate: 48000 });
        }
        const destination = audioContext.createMediaStreamDestination();
        try {
          destination.channelCount = 2;
          destination.channelInterpretation = "speakers";
        } catch (_) {
          /* ignore */
        }

        const sysOnly = new MediaStream(displayAudioTracks);
        const sysSrc = audioContext.createMediaStreamSource(sysOnly);
        const sysGain = audioContext.createGain();
        sysGain.gain.value = 1.2;
        sysSrc.connect(sysGain).connect(destination);

        const micOnly = new MediaStream(micAudioTracks);
        const micSrc = audioContext.createMediaStreamSource(micOnly);
        const micGain = audioContext.createGain();
        micGain.gain.value = 1.1;
        micSrc.connect(micGain).connect(destination);

        await ensureCtxRunning(audioContext);

        const mixed = destination.stream.getAudioTracks()[0];
        if (mixed) mixed.enabled = true;
        recordStream = mixed ? new MediaStream([mixed]) : new MediaStream([]);
      }
    } else if (!hasMic) {
      recordStream = displayStream;
    } else if (hasSys && hasMic) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      try {
        audioContext = new Ctx();
      } catch (_) {
        audioContext = new Ctx({ sampleRate: 48000 });
      }
      const destination = audioContext.createMediaStreamDestination();
      try {
        destination.channelCount = 2;
        destination.channelInterpretation = "speakers";
      } catch (_) {
        /* ignore */
      }

      const sysOnly = new MediaStream(displayAudioTracks);
      const sysSrc = audioContext.createMediaStreamSource(sysOnly);
      const sysGain = audioContext.createGain();
      sysGain.gain.value = 1.2;
      sysSrc.connect(sysGain).connect(destination);

      const micOnly = new MediaStream(micAudioTracks);
      const micSrc = audioContext.createMediaStreamSource(micOnly);
      const micGain = audioContext.createGain();
      micGain.gain.value = 1.1;
      micSrc.connect(micGain).connect(destination);

      await ensureCtxRunning(audioContext);

      const mixed = destination.stream.getAudioTracks()[0];
      if (mixed) mixed.enabled = true;
      const vtRec = forkVideoTrackForRecorder(displayStream);
      if (!vtRec) {
        throw new Error("No video track from screen share.");
      }
      recordStream = mixed ? new MediaStream([vtRec, mixed]) : new MediaStream([vtRec]);
    } else {
      const vtRec = forkVideoTrackForRecorder(displayStream);
      if (!vtRec) {
        throw new Error("No video track from screen share.");
      }
      recordStream = new MediaStream([vtRec, ...micAudioTracks]);
    }

    return {
      recordStream,
      audioContext,
      videoTrack: includeVideo ? videoTrack : null,
      displayAudioTracks,
      hasSys,
      hasMic,
    };
  }

  async function detachBundleAudioContextOnly(bundle) {
    if (!bundle?.audioContext) return;
    const ac = bundle.audioContext;
    bundle.audioContext = null;
    try {
      if (ac.state !== "closed") {
        const p = ac.close();
        if (p && typeof p.then === "function") await p;
      }
    } catch (_) {
      /* ignore */
    }
  }

  async function acquireMicStreamForMixing() {
    const ids = getEnabledMicDeviceIds(getInputIntent());
    if (!ids.length) {
      throw new Error("Turn on at least one microphone.");
    }
    return acquireCombinedMicStreamFromDeviceIds(ids);
  }

  /**
   * One Web Audio destination for the whole recording so mic can be toggled without swapping MediaRecorder input.
   */
  async function openStudioRecordAudioMixer(displayStream, initialMicStream) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    /* Default sample rate matches the device; forcing 48000 often triggers WebAudio renderer errors on macOS. */
    let ctx;
    try {
      ctx = new Ctx();
    } catch (_) {
      ctx = new Ctx({ sampleRate: 48000 });
    }
    const dest = ctx.createMediaStreamDestination();
    try {
      dest.channelCount = 2;
      dest.channelInterpretation = "speakers";
    } catch (_) {
      /* ignore */
    }

    const liveDisplayAud = () =>
      displayStream.getAudioTracks().filter((t) => t.readyState !== "ended");

    const sysTracks = liveDisplayAud();
    let sysSrc = null;
    let sysGain = null;
    let sysChainConnected = false;
    if (sysTracks.length) {
      const sysOnly = new MediaStream(sysTracks);
      sysSrc = ctx.createMediaStreamSource(sysOnly);
      sysGain = ctx.createGain();
      sysGain.gain.value = 1.2;
      sysSrc.connect(sysGain);
      sysGain.connect(dest);
      sysChainConnected = true;
    }

    let micChain = null;
    let activeMicStream = null;
    let silentOsc = null;
    /** @type {{ kind: string; node: AudioNode; gain: GainNode } | null} */
    let silentCarrier = null;

    function stopSilentOsc() {
      if (!silentOsc) return;
      try {
        silentOsc.stop();
      } catch (_) {
        /* ignore */
      }
      try {
        silentOsc.disconnect();
      } catch (_) {
        /* ignore */
      }
      silentOsc = null;
    }

    function hasRealAudioInput() {
      if (liveDisplayAud().length) return true;
      return !!micChain;
    }

    /* No silent oscillator — it triggers WebAudio renderer errors on some systems; an un-fed
     * MediaStreamDestination still exposes a silent track for MediaRecorder. */
    function refreshSilentCarrier() {
      stopSilentOsc();
    }

    function removeMic() {
      if (micChain) {
        try {
          micChain.micSrc.disconnect();
        } catch (_) {
          /* ignore */
        }
        micChain = null;
      }
      if (activeMicStream) {
        activeMicStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch (_) {
            /* ignore */
          }
        });
        activeMicStream = null;
      }
      refreshSilentCarrier();
    }

    function addMicStream(ms) {
      removeMic();
      if (!ms) return;
      const tracks = ms.getAudioTracks().filter((t) => t.readyState !== "ended");
      if (!tracks.length) return;
      activeMicStream = ms;
      const micOnly = new MediaStream(tracks);
      const micSrc = ctx.createMediaStreamSource(micOnly);
      const micGain = ctx.createGain();
      micGain.gain.value = 1.1;
      micSrc.connect(micGain).connect(dest);
      micChain = { micSrc, micGain };
      refreshSilentCarrier();
    }

    addMicStream(initialMicStream);
    refreshSilentCarrier();

    await resumeAudioContextLimited(ctx, 500);

    /** Some browsers omit a MediaStreamTrack on the destination until the graph is non-empty. */
    let audioTrack = dest.stream.getAudioTracks()[0];
    if (!audioTrack) {
      try {
        const g = ctx.createGain();
        g.gain.value = 0;
        if (typeof ConstantSourceNode !== "undefined") {
          const c = ctx.createConstantSource();
          c.offset.value = 0;
          c.connect(g).connect(dest);
          c.start();
          silentCarrier = { kind: "const", node: c, gain: g };
        } else {
          const osc = ctx.createOscillator();
          osc.frequency.value = 440;
          g.gain.value = 0.0001;
          osc.connect(g).connect(dest);
          osc.start();
          silentCarrier = { kind: "osc", node: osc, gain: g };
        }
        await resumeAudioContextLimited(ctx, 300);
        audioTrack = dest.stream.getAudioTracks()[0];
      } catch (_) {
        /* ignore */
      }
    }
    if (audioTrack) audioTrack.enabled = true;

    return {
      ctx,
      audioTrack,
      addMicStream,
      removeMic,
      setDisplayAudible(audible) {
        const on = !!audible;
        if (!sysSrc || !sysGain) return;
        if (on) {
          try {
            sysGain.gain.value = 1.2;
          } catch (_) {
            /* ignore */
          }
          if (!sysChainConnected) {
            try {
              sysSrc.connect(sysGain);
              sysGain.connect(dest);
            } catch (_) {
              /* ignore */
            }
            sysChainConnected = true;
          }
        } else {
          try {
            sysGain.gain.value = 0;
          } catch (_) {
            /* ignore */
          }
          try {
            sysSrc.disconnect();
          } catch (_) {
            /* ignore */
          }
          try {
            sysGain.disconnect();
          } catch (_) {
            /* ignore */
          }
          sysChainConnected = false;
        }
      },
      close() {
        stopSilentOsc();
        removeMic();
        if (silentCarrier) {
          try {
            if (silentCarrier.kind === "const") silentCarrier.node.stop();
            else silentCarrier.node.stop();
          } catch (_) {
            /* ignore */
          }
          try {
            silentCarrier.node.disconnect();
          } catch (_) {
            /* ignore */
          }
          try {
            silentCarrier.gain.disconnect();
          } catch (_) {
            /* ignore */
          }
          silentCarrier = null;
        }
        try {
          if (sysSrc) sysSrc.disconnect();
        } catch (_) {
          /* ignore */
        }
        try {
          if (sysGain) sysGain.disconnect();
        } catch (_) {
          /* ignore */
        }
        try {
          ctx.close();
        } catch (_) {
          /* ignore */
        }
      },
    };
  }

  function setHubCancelVisible(on) {
    if (hubRecordCancel) hubRecordCancel.hidden = !on;
  }

  function setHubSaveVisible(on) {
    if (hubRecordSave) hubRecordSave.hidden = !on;
  }

  function hideRecordTimer() {
    recordMetricsEl.hidden = true;
    setHubCancelVisible(false);
    setHubSaveVisible(false);
    recordBytesEl.textContent = "0 B";
    recordElapsedEl.textContent = "0:00";
    recordElapsedEl.setAttribute("datetime", "PT0S");
  }

  /** Show 0:00 in the studio HUD while preview is open and recording has not started yet. */
  function showPreviewRecordTimerZero() {
    recordMetricsEl.hidden = false;
    recordBytesEl.textContent = "0 B";
    recordElapsedEl.textContent = formatDuration(0);
    recordElapsedEl.setAttribute("datetime", "PT0S");
  }

  /**
   * Only display-capture *audio* can sit muted until Chrome delivers samples; waiting on *video*
   * muted state can block for 10s+ and feels frozen. Mixed/mic tracks are skipped by id.
   */
  async function waitForDisplayCaptureAudioUnmute(stream, displayStream, timeoutMs) {
    if (!displayStream) return;
    const displayAudioIds = new Set(displayStream.getAudioTracks().map((t) => t.id));
    const tracks = stream.getAudioTracks().filter((t) => displayAudioIds.has(t.id));
    if (!tracks.length) return;
    const deadline = Date.now() + timeoutMs;
    await Promise.all(
      tracks.map(
        (track) =>
          new Promise((resolve) => {
            if (!track.muted || track.readyState === "ended") {
              resolve();
              return;
            }
            let settled = false;
            let tid;
            const finish = () => {
              if (settled) return;
              settled = true;
              track.removeEventListener("unmute", finish);
              track.removeEventListener("ended", finish);
              if (tid != null) clearTimeout(tid);
              resolve();
            };
            track.addEventListener("unmute", finish);
            track.addEventListener("ended", finish);
            tid = setTimeout(finish, Math.max(0, deadline - Date.now()));
          })
      )
    );
  }

  function yieldToMediaPipeline() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  /**
   * Remove only stuck *display-capture* audio (Chrome may leave tab/system audio muted).
   * Do not drop mic tracks or AudioContext-mixed tracks — those often report muted=false late or use new ids.
   */
  function stripMutedStuckDisplayAudio(stream, displayStream) {
    const displayAudioIds = new Set(
      (displayStream && displayStream.getAudioTracks().map((t) => t.id)) || []
    );
    const v = stream.getVideoTracks();
    const aud = stream.getAudioTracks();
    if (!aud.length || displayAudioIds.size === 0) return stream;
    const kept = aud.filter((t) => {
      if (!displayAudioIds.has(t.id)) return true;
      return t.readyState === "live" && !t.muted;
    });
    if (kept.length === aud.length) return stream;
    return kept.length ? new MediaStream([...v, ...kept]) : new MediaStream(v);
  }

  function detachDisplayEndedListener(session) {
    if (!session || !session.onDisplayEndedHandler) return;
    const t = session.endGuardTrack;
    if (t) {
      try {
        t.removeEventListener("ended", session.onDisplayEndedHandler);
      } catch (_) {
        /* ignore */
      }
      session.endGuardTrack = null;
    }
  }

  function hideControlPanelCompletely() {
    recordPanel.classList.add("hidden");
    recordPanel.classList.remove("record-panel--arming", "record-panel--pip");
    recordStopBtn.disabled = false;
    document.body.classList.remove("is-recording", "is-recording-paused", "is-arming");
  }

  function cleanupRecordingPumpAndStudio(sess, opts) {
    const keepReview = opts && opts.keepVisibleForReview;
    if (sess) {
      revokeSessionPausePreviewUrl(sess);
      sess.pumpActive = false;
      if (sess.pumpRafId != null) {
        cancelAnimationFrame(sess.pumpRafId);
        sess.pumpRafId = null;
      }
      if (sess.pumpFeedVideo) {
        try {
          sess.pumpFeedVideo.pause();
          sess.pumpFeedVideo.srcObject = null;
          sess.pumpFeedVideo.remove();
        } catch (_) {
          /* ignore */
        }
        sess.pumpFeedVideo = null;
      }
    }
    captureStudio.classList.remove(
      "capture-studio--pump-only",
      "capture-studio--selecting",
      "capture-studio--paused-playback",
      "capture-studio--show-screen-video",
      "capture-studio--starting",
      "capture-studio--device-settings-open"
    );
    if (!keepReview) {
      /* Keep structural --live-preview (matches initial HTML); mark empty shell, not “no studio”. */
      captureStudio.classList.add("capture-studio--live-preview", "capture-studio--empty-preview");
    }
    document.body.classList.remove("is-live-capture");
    studioVideo.pause();
    studioVideo.srcObject = null;
    studioVideo.removeAttribute("src");
    studioVideo.load();
    if (!keepReview) {
      studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
      captureStudio.classList.add("hidden");
      captureStudio.setAttribute("aria-hidden", "true");
    } else {
      captureStudio.classList.remove("hidden");
      captureStudio.setAttribute("aria-hidden", "false");
      captureStudio.classList.add("capture-studio--live-preview");
    }
    updateStudioResizeHandleVisibility();
  }

  function showArmingPanel() {
    scadaCluster.appendChild(recordPanel);
    recordPanel.classList.remove("record-panel--pip");
    recordPanel.classList.add("hidden", "record-panel--arming");
    recordStopBtn.disabled = true;
    applyIdleInputIndicators();
    document.body.classList.add("is-arming");
    setStatus();
  }

  function handleDisplayTrackEnded() {
    const s = recordSession;
    if (!s) {
      if (studioCapture) {
        disposeStudioCapture();
        setStatus("Share stopped.");
      }
      return;
    }
    if (s.arming) {
      if (s.recorder && s.recorder.state === "recording") {
        s.arming = false;
        try {
          s.recorder.stop();
        } catch (_) {
          finalizeRecordingSession();
        }
        return;
      }
      detachDisplayEndedListener(s);
      if (s.tick) {
        clearInterval(s.tick);
        s.tick = null;
      }
      hideRecordTimer();
      if (s.onKey) {
        document.removeEventListener("keydown", s.onKey, true);
      }
      cleanupRecordingPumpAndStudio(s);
      disposeCapture(s);
      restoreRecordingPanel();
      recordSession = null;
      ensureSnipeInCluster();
      hideControlPanelCompletely();
      snipeBtn.disabled = false;
      setStudioSigTriggersDisabled(false);
      setStatus("");
      return;
    }
    finalizeRecordingSession();
  }

  function teardownRecordUi() {
    if (recordSession) {
      if (recordSession.tick) {
        clearInterval(recordSession.tick);
        recordSession.tick = null;
      }
      cleanupRecordingPumpAndStudio(recordSession);
      ensureSnipeInCluster();
      document.removeEventListener("keydown", recordSession.onKey, true);
      detachDisplayEndedListener(recordSession);
      hideRecordTimer();
      restoreRecordingPanel();
      recordSession = null;
    }
    document.body.classList.remove("is-recording", "is-recording-paused", "is-arming");
    recordPanel.classList.add("hidden");
    recordPanel.classList.remove("record-panel--arming");
    if (!pendingPreview) {
      snipeBtn.disabled = false;
    }
    snipeBtn.setAttribute("aria-label", "Start screen recording");
    recordStopBtn.setAttribute("aria-label", "Stop recording");
    applyIdleInputIndicators();
    void refreshMicDeviceList();
  }

  function revokeSessionPausePreviewUrl(session) {
    if (!session || !session.pauseObjectUrl) return;
    try {
      URL.revokeObjectURL(session.pauseObjectUrl);
    } catch (_) {
      /* ignore */
    }
    session.pauseObjectUrl = null;
  }

  function disposeCapture(session) {
    if (!session) return;
    revokeSessionPausePreviewUrl(session);
    if (session.pumpFeedVideo) {
      try {
        session.pumpFeedVideo.pause();
        session.pumpFeedVideo.srcObject = null;
        session.pumpFeedVideo.remove();
      } catch (_) {
        /* ignore */
      }
      session.pumpFeedVideo = null;
    }
    if (session.studioRecordAudioMixer) {
      try {
        session.studioRecordAudioMixer.close();
      } catch (_) {
        /* ignore */
      }
      session.studioRecordAudioMixer = null;
      session.audioContext = null;
    } else {
      try {
        if (session.audioContext && session.audioContext.state !== "closed") {
          session.audioContext.close();
        }
      } catch (_) {
        /* ignore */
      }
    }
    const recS = session.recordStreamUsed ?? session.recordStream;
    const disp = session.displayStream;
    if (recS && disp && recS !== disp) {
      recS.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch (_) {
          /* ignore */
        }
      });
    }
    if (disp) {
      disp.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch (_) {
          /* ignore */
        }
      });
    }
    if (session.micStream) {
      session.micStream.getTracks().forEach((t) => t.stop());
    }
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function getVideoContentRect(video, wrapEl) {
    const cr = wrapEl.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
      return { left: cr.left, top: cr.top, width: cr.width, height: cr.height, vw: 0, vh: 0 };
    }
    const cw = cr.width;
    const ch = cr.height;
    const scale = Math.min(cw / vw, ch / vh);
    const w0 = vw * scale;
    const h0 = vh * scale;
    const ox = cr.left + (cw - w0) / 2;
    const oy = cr.top + (ch - h0) / 2;
    return { left: ox, top: oy, width: w0, height: h0, vw, vh };
  }

  function clientSelectionToNorm(video, wrapEl, x0, y0, x1, y1) {
    const vc = getVideoContentRect(video, wrapEl);
    if (!vc.vw) return null;
    const selL = Math.min(x0, x1);
    const selT = Math.min(y0, y1);
    const selR = Math.max(x0, x1);
    const selB = Math.max(y0, y1);
    const ix1 = Math.max(selL, vc.left);
    const iy1 = Math.max(selT, vc.top);
    const ix2 = Math.min(selR, vc.left + vc.width);
    const iy2 = Math.min(selB, vc.top + vc.height);
    const iw = ix2 - ix1;
    const ih = iy2 - iy1;
    if (iw < 12 || ih < 12) return null;
    return {
      x: (ix1 - vc.left) / vc.width,
      y: (iy1 - vc.top) / vc.height,
      w: iw / vc.width,
      h: ih / vc.height,
    };
  }

  function updateRegionVisualFromClientDrag() {
    if (!regionDragClient) return;
    const wr = studioCropWrapEl().getBoundingClientRect();
    const x0 = regionDragClient.x0;
    const y0 = regionDragClient.y0;
    const x1 = regionDragClient.x1;
    const y1 = regionDragClient.y1;
    const l = Math.min(x0, x1) - wr.left;
    const t = Math.min(y0, y1) - wr.top;
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    studioRegionEl.hidden = false;
    studioRegionEl.style.left = `${l}px`;
    studioRegionEl.style.top = `${t}px`;
    studioRegionEl.style.width = `${w}px`;
    studioRegionEl.style.height = `${h}px`;
  }

  function updateRegionVisualFromNorm() {
    if (!studioRegionNorm) return;
    const cropWrap = studioCropWrapEl();
    const vc = getVideoContentRect(studioVideo, cropWrap);
    if (!vc.vw) return;
    const wr = cropWrap.getBoundingClientRect();
    const l = vc.left - wr.left + studioRegionNorm.x * vc.width;
    const t = vc.top - wr.top + studioRegionNorm.y * vc.height;
    const w = studioRegionNorm.w * vc.width;
    const h = studioRegionNorm.h * vc.height;
    studioRegionEl.hidden = false;
    studioRegionEl.style.left = `${l}px`;
    studioRegionEl.style.top = `${t}px`;
    studioRegionEl.style.width = `${w}px`;
    studioRegionEl.style.height = `${h}px`;
  }

  function detachStudioDisplayListener() {
    if (!studioCapture || !studioDisplayEndedHandler) return;
    const vt = studioCapture.displayStream && studioCapture.displayStream.getVideoTracks()[0];
    if (vt) {
      try {
        vt.removeEventListener("ended", studioDisplayEndedHandler);
      } catch (_) {
        /* ignore */
      }
    }
    studioDisplayEndedHandler = null;
  }

  /** Hide the studio panel but keep preview srcObject — clearing it can stop capture for full-screen recording. */
  function hideCaptureStudioPanelOnly() {
    ensureSnipeInCluster();
    captureStudio.classList.remove("capture-studio--live-preview");
    document.body.classList.remove("is-live-capture");
    captureStudio.classList.add("hidden");
    captureStudio.setAttribute("aria-hidden", "true");
    updateStudioResizeHandleVisibility();
  }

  function closeStudioUiOnly() {
    ensureSnipeInCluster();
    captureStudio.classList.remove(
      "capture-studio--await-share",
      "capture-studio--audio-meter-preview",
      "capture-studio--selecting",
      "capture-studio--pump-only",
      "capture-studio--review",
      "capture-studio--show-screen-video"
    );
    captureStudio.classList.add("capture-studio--live-preview", "capture-studio--empty-preview");
    captureStudio.classList.remove("hidden");
    captureStudio.setAttribute("aria-hidden", "false");
    document.body.classList.remove("is-live-capture", "is-preview");
    studioReview.hidden = true;
    studioReview.setAttribute("aria-hidden", "true");
    studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
    hideRecordTimer();
    if (studioAwaitPlaceholder) {
      studioAwaitPlaceholder.hidden = false;
    }
    setStudioScreenVideoPreviewActive(false);
    studioVideo.pause();
    studioVideo.srcObject = null;
    studioVideo.removeAttribute("src");
    studioVideo.removeAttribute("controls");
    studioVideo.muted = true;
    studioVideo.setAttribute("playsinline", "");
    studioVideo.setAttribute("autoplay", "");
    studioVideo.load();
    studioRegionEl.hidden = true;
    studioRegionEl.style.cssText = "";
    studioRegionNorm = null;
    regionDragClient = null;
    lastWiredDisplayWireMeta = null;
    lastStudioPreviewIntrinsic = null;
    detachStudioVideoCropListeners();
    resetStudioPanelGeometry();
    applyStoredStudioWidth();
    syncStudioAspectFromCapture();
    updateStudioResizeHandleVisibility();
    ensureSnipeInStudio();
    applySnipeStudioPickShareUi();
  }

  /**
   * Drop live preview capture without opening the studio card (used after record/save when the panel stays hidden).
   */
  function disposeStudioCaptureSilent() {
    stopStudioAudioMeter();
    closeStudioInputMenus();
    detachStudioDisplayListener();
    if (studioCapture) {
      disposeCapture(studioCapture);
      studioCapture = null;
    }
    captureStudio.classList.remove(
      "capture-studio--await-share",
      "capture-studio--audio-meter-preview",
      "capture-studio--selecting",
      "capture-studio--pump-only",
      "capture-studio--review",
      "capture-studio--show-screen-video",
      "capture-studio--starting",
      "capture-studio--paused-playback",
      "capture-studio--device-settings-open"
    );
    captureStudio.classList.add("capture-studio--live-preview", "capture-studio--empty-preview");
    studioReview.hidden = true;
    studioReview.setAttribute("aria-hidden", "true");
    studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
    hideRecordTimer();
    setHubCancelVisible(false);
    setHubSaveVisible(false);
    if (studioAwaitPlaceholder) {
      studioAwaitPlaceholder.hidden = false;
    }
    setStudioScreenVideoPreviewActive(false);
    studioVideo.pause();
    studioVideo.srcObject = null;
    studioVideo.removeAttribute("src");
    studioVideo.removeAttribute("controls");
    studioVideo.muted = true;
    studioVideo.setAttribute("playsinline", "");
    studioVideo.setAttribute("autoplay", "");
    studioVideo.load();
    studioRegionEl.hidden = true;
    studioRegionEl.style.cssText = "";
    studioRegionNorm = null;
    regionDragClient = null;
    lastWiredDisplayWireMeta = null;
    lastStudioPreviewIntrinsic = null;
    detachStudioVideoCropListeners();
    resetStudioPanelGeometry();
    applyStoredStudioWidth();
    syncStudioAspectFromCapture();
    updateStudioResizeHandleVisibility();
    ensureSnipeInCluster();
    snipeBtn.setAttribute("aria-label", "Start screen recording");
    if (!recordSession && !pendingPreview) {
      snipeBtn.disabled = false;
    }
    applyIdleInputIndicators();
  }

  function disposeStudioCapture() {
    stopStudioAudioMeter();
    closeStudioInputMenus();
    detachStudioDisplayListener();
    if (studioCapture) {
      disposeCapture(studioCapture);
      studioCapture = null;
    }
    closeStudioUiOnly();
    if (!recordSession && !pendingPreview) {
      snipeBtn.disabled = false;
    }
    applyIdleInputIndicators();
  }

  function onStudioOverlayDown(e) {
    if (!captureStudio.classList.contains("capture-studio--selecting")) return;
    if (e.button !== 0) return;
    e.preventDefault();
    regionDragClient = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    studioRegionNorm = null;
    updateRegionVisualFromClientDrag();
  }

  function onStudioOverlayMove(e) {
    if (!regionDragClient) return;
    regionDragClient.x1 = e.clientX;
    regionDragClient.y1 = e.clientY;
    updateRegionVisualFromClientDrag();
  }

  function onStudioOverlayUp(e) {
    if (!regionDragClient) return;
    regionDragClient.x1 = e.clientX;
    regionDragClient.y1 = e.clientY;
    const norm = clientSelectionToNorm(
      studioVideo,
      studioCropWrapEl(),
      regionDragClient.x0,
      regionDragClient.y0,
      regionDragClient.x1,
      regionDragClient.y1
    );
    regionDragClient = null;
    if (norm) {
      studioRegionNorm = norm;
      updateRegionVisualFromNorm();
      setStatus("Crop set — only the boxed area will be recorded. Clear crop in Screen menu for full frame.");
    } else {
      studioRegionEl.hidden = true;
      setStatus("Draw a rectangle on the video to choose what to record, or turn off crop mode in Screen menu.");
    }
  }

  function recordingElapsedMs(session) {
    if (!session || session.recStartedAt == null) return 0;
    let inPause = 0;
    if (session.pauseStartedAt != null) {
      inPause = Date.now() - session.pauseStartedAt;
    }
    return Date.now() - session.recStartedAt - (session.totalPausedMs || 0) - inPause;
  }

  function recordingChunksByteTotal(session) {
    const parts = session && session.chunks ? session.chunks : [];
    return parts.reduce((n, b) => n + (b && b.size ? b.size : 0), 0);
  }

  function formatRecordingSize(bytes) {
    const n = Math.max(0, Math.floor(Number(bytes) || 0));
    if (n < 1024) return `${n} B`;
    if (n < 1048576) {
      const kb = n / 1024;
      const s = kb >= 100 ? kb.toFixed(0) : kb.toFixed(1);
      return `${s.replace(/\.0$/, "")} KB`;
    }
    const mb = n / 1048576;
    let s = mb >= 10 ? mb.toFixed(1) : mb.toFixed(2);
    s = s.replace(/\.0+$/, "").replace(/\.$/, "");
    return `${s} MB`;
  }

  function updateRecordingHud(session) {
    if (!session || !recordElapsedEl) return;
    const rawMs = Math.max(0, recordingElapsedMs(session));
    const elapsedMs = Math.floor(rawMs / 1000) * 1000;
    const elapsed = formatDuration(elapsedMs);
    recordElapsedEl.textContent = elapsed;
    recordElapsedEl.setAttribute("datetime", `PT${Math.floor(elapsedMs / 1000)}S`);
    const sizeStr = formatRecordingSize(recordingChunksByteTotal(session));
    recordBytesEl.textContent = sizeStr;
    recordBytesEl.setAttribute("aria-label", `Recording file size ${sizeStr}`);
    const rec = session.recorder;
    const paused = rec && rec.state === "paused";
    const label = paused
      ? `Resume recording. ${sizeStr}. Elapsed ${elapsed}.`
      : `Stop recording. ${sizeStr}. Elapsed ${elapsed}.`;
    snipeBtn.setAttribute("aria-label", label);
    recordStopBtn.setAttribute("aria-label", label);
  }

  function startRecordingTick(session) {
    if (!session) return;
    if (session.tick) {
      clearInterval(session.tick);
      session.tick = null;
    }
    session.tick = window.setInterval(() => updateRecordingHud(session), 1000);
    updateRecordingHud(session);
  }

  function pauseRecordingClock(session) {
    if (!session) return;
    /* Keep the HUD interval running while paused so byte total updates after requestData / late chunks. */
    if (session.pauseStartedAt == null) {
      session.pauseStartedAt = Date.now();
    }
    updateRecordingHud(session);
  }

  function resumeRecordingClock(session) {
    if (!session) return;
    if (session.pauseStartedAt != null) {
      session.totalPausedMs = (session.totalPausedMs || 0) + (Date.now() - session.pauseStartedAt);
      session.pauseStartedAt = null;
    }
    startRecordingTick(session);
  }

  function flushRecorderDataForPreview(recorder) {
    return new Promise((resolve) => {
      if (recorder && typeof recorder.requestData === "function") {
        try {
          recorder.requestData();
        } catch (_) {
          /* ignore */
        }
      }
      window.setTimeout(resolve, 240);
    });
  }

  /** After pause + flush, wait for MediaRecorder to emit at least one non-empty chunk (timeslice can lag). */
  async function waitForPausedRecorderChunks(session, minTotalBytes, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!session || recordSession !== session || !session.recorder || session.recorder.state !== "paused") {
        break;
      }
      const parts = session.chunks || [];
      const total = parts.reduce((n, b) => n + (b && b.size ? b.size : 0), 0);
      if (total >= minTotalBytes) return total;
      if (typeof session.recorder.requestData === "function") {
        try {
          session.recorder.requestData();
        } catch (_) {
          /* ignore */
        }
      }
      await new Promise((r) => setTimeout(r, 90));
    }
    const parts = session.chunks || [];
    return parts.reduce((n, b) => n + (b && b.size ? b.size : 0), 0);
  }

  function detachLiveCaptureFromPauseVideo(session) {
    studioVideo.pause();
    studioVideo.removeAttribute("src");
    studioVideo.removeAttribute("controls");
    studioVideo.muted = true;
    studioVideo.setAttribute("playsinline", "");
    studioVideo.setAttribute("autoplay", "");
    studioVideo.srcObject = null;
    try {
      studioVideo.load();
    } catch (_) {
      /* ignore */
    }
    setStudioScreenVideoPreviewActive(false);
    studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
  }

  function pauseRecordingPumpIfAny(session) {
    if (!session) return;
    session.pumpActive = false;
    if (session.pumpRafId != null) {
      cancelAnimationFrame(session.pumpRafId);
      session.pumpRafId = null;
    }
  }

  function resumeRecordingPumpIfAny(session) {
    if (!session || !session.pumpLoopRef || !session.pumpCanvas) return;
    session.pumpActive = true;
    if (session.pumpRafId != null) return;
    session.pumpRafId = requestAnimationFrame(session.pumpLoopRef);
  }

  function restoreLivePreviewAfterRecordPause(session) {
    if (!session) return;
    captureStudio.classList.remove("capture-studio--paused-playback");
    revokeSessionPausePreviewUrl(session);
    if (session.pauseHadCropOverlay && studioRegionNorm) {
      studioRegionEl.hidden = false;
      updateRegionVisualFromNorm();
    }
    session.pauseHadCropOverlay = false;
    studioVideo.pause();
    studioVideo.removeAttribute("src");
    studioVideo.removeAttribute("controls");
    studioVideo.muted = true;
    studioVideo.setAttribute("playsinline", "");
    studioVideo.setAttribute("autoplay", "");
    if (session.displayStream && session.recordIncludeVideo !== false) {
      syncStudioVideoPreviewForRecordingSession(session);
    } else {
      studioVideo.srcObject = null;
      wireLivePreviewSurface({
        captureMode: session.displayStream ? "display-audio-only" : "mic-only",
        displayStream: session.displayStream,
        micStream: session.micStream,
        recordIncludeVideo: session.recordIncludeVideo,
      });
    }
    resumeRecordingPumpIfAny(session);
    syncStudioAspectFromCapture();
    updateStudioResizeHandleVisibility();
  }

  async function showPauseRecordingPlayback(session) {
    if (!session || recordSession !== session) return;
    pauseRecordingPumpIfAny(session);
    await flushRecorderDataForPreview(session.recorder);
    if (!session || recordSession !== session) return;
    if (!session.recorder || session.recorder.state !== "paused") return;
    const totalBytesAfterWait = await waitForPausedRecorderChunks(session, 1, 1200);
    updateRecordingHud(session);
    /* .capture-studio--audio-meter-preview / --await-share shrink the <video> via CSS; clear so playback + live share show while paused. */
    captureStudio.classList.remove(
      "capture-studio--audio-meter-preview",
      "capture-studio--await-share",
      "capture-studio--starting"
    );
    setStudioAwaitShareVisible(false);
    studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
    let parts = session.chunks || [];
    let totalBytes = totalBytesAfterWait;
    if (totalBytes < 1) {
      totalBytes = parts.reduce((n, b) => n + (b && b.size ? b.size : 0), 0);
    }
    if (totalBytes < 1) {
      detachLiveCaptureFromPauseVideo(session);
      captureStudio.classList.remove("capture-studio--paused-playback");
      syncStudioAspectFromCapture();
      updateStudioResizeHandleVisibility();
      setStatus("Paused — no file data yet; wait a moment and pause again, or resume and record longer.");
      updateRecordingHud(session);
      return;
    }
    revokeSessionPausePreviewUrl(session);
    parts = session.chunks || [];
    let blob;
    try {
      blob = new Blob(parts, { type: session.outMime || "video/webm" });
    } catch (_) {
      detachLiveCaptureFromPauseVideo(session);
      captureStudio.classList.remove("capture-studio--paused-playback");
      syncStudioAspectFromCapture();
      updateStudioResizeHandleVisibility();
      setStatus("Paused — could not build playback preview.");
      updateRecordingHud(session);
      return;
    }
    if (!blob.size) {
      detachLiveCaptureFromPauseVideo(session);
      captureStudio.classList.remove("capture-studio--paused-playback");
      syncStudioAspectFromCapture();
      updateStudioResizeHandleVisibility();
      setStatus("Paused — recording buffer empty; resume briefly then pause again.");
      updateRecordingHud(session);
      return;
    }
    if (!session.recorder || session.recorder.state !== "paused") return;
    session.pauseObjectUrl = URL.createObjectURL(blob);
    captureStudio.classList.add("capture-studio--paused-playback");
    if (session.recordIncludeVideo !== false) {
      setStudioScreenVideoPreviewActive(true);
    }
    session.pauseHadCropOverlay = Boolean(studioRegionNorm && !studioRegionEl.hidden);
    if (session.pauseHadCropOverlay) {
      studioRegionEl.hidden = true;
    }
    studioVideo.pause();
    studioVideo.srcObject = null;
    studioVideo.removeAttribute("autoplay");
    studioVideo.muted = false;
    studioVideo.setAttribute("controls", "");
    studioVideo.setAttribute("playsinline", "");
    studioVideo.src = session.pauseObjectUrl;

    const playable = await new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        studioVideo.removeEventListener("loadeddata", onReady);
        studioVideo.removeEventListener("canplay", onReady);
        studioVideo.removeEventListener("error", onErr);
        window.clearTimeout(tid);
        resolve(ok);
      };
      const onReady = () => done(!studioVideo.error);
      const onErr = () => done(false);
      studioVideo.addEventListener("loadeddata", onReady, { once: true });
      studioVideo.addEventListener("canplay", onReady, { once: true });
      studioVideo.addEventListener("error", onErr, { once: true });
      const tid = window.setTimeout(() => {
        const ok =
          !studioVideo.error &&
          studioVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          (session.recordIncludeVideo === false ||
            (studioVideo.videoWidth > 1 && studioVideo.videoHeight > 1));
        done(ok);
      }, 3800);
      try {
        studioVideo.load();
        void studioVideo.play().catch(() => {});
      } catch (_) {
        done(false);
      }
    });

    if (
      !playable ||
      studioVideo.error ||
      recordSession !== session ||
      !session.recorder ||
      session.recorder.state !== "paused"
    ) {
      captureStudio.classList.remove("capture-studio--paused-playback");
      revokeSessionPausePreviewUrl(session);
      captureStudio.classList.remove("capture-studio--await-share");
      detachLiveCaptureFromPauseVideo(session);
      if (session.pauseHadCropOverlay && studioRegionNorm) {
        studioRegionEl.hidden = false;
        updateRegionVisualFromNorm();
      }
      session.pauseHadCropOverlay = false;
      syncStudioAspectFromCapture();
      if (session.recorder && session.recorder.state === "paused") {
        setStatus("Paused — preview could not load; use Save to keep the recording, or resume.");
      }
      updateRecordingHud(session);
      return;
    }

    if (recordSession !== session || !session.recorder || session.recorder.state !== "paused") {
      revokeSessionPausePreviewUrl(session);
      captureStudio.classList.remove("capture-studio--paused-playback");
      if (recordSession === session && session.recorder && session.recorder.state === "recording") {
        restoreLivePreviewAfterRecordPause(session);
      }
      return;
    }

    syncStudioAspectFromCapture();
    updateStudioResizeHandleVisibility();
    updateRecordingHud(session);
    setStatus("Paused — playback so far; press stop again to resume recording.");
  }

  /** Dedicated panel Stop — always end recording (snipe button still pause/resumes). */
  function stopRecordingFromPanel() {
    if (!recordSession?.recorder) return;
    finalizeRecordingSession();
  }

  /** Pause/resume capture in one file; same control as while recording. */
  function toggleRecordingPause() {
    const session = recordSession;
    if (!session || !session.recorder) return;
    const rec = session.recorder;

    if (rec.state === "paused") {
      restoreLivePreviewAfterRecordPause(session);
      applySnipeStudioStopUi();
      try {
        rec.resume();
        document.body.classList.remove("is-recording-paused");
        document.body.classList.add("is-recording");
        resumeRecordingClock(session);
        setStatus("Recording.");
        return;
      } catch (e) {
        setStatus((e && e.message) || "Could not resume recording.");
        return;
      }
    }

    if (rec.state === "recording") {
      if (typeof rec.pause === "function") {
        try {
          rec.pause();
          document.body.classList.add("is-recording", "is-recording-paused");
          applySnipeStudioPausedUi();
          pauseRecordingClock(session);
          setStatus("Paused — building playback…");
          void showPauseRecordingPlayback(session).catch(() => {
            if (recordSession === session) {
              setStatus("Paused — press stop again to resume.");
            }
          });
          return;
        } catch (_) {
          /* fall through: pause unsupported or failed */
        }
      }
      finalizeRecordingSession();
      return;
    }
  }

  /** End recording, assemble file, and tear down (Escape, share ended, or when pause is unavailable). */
  function finalizeRecordingSession() {
    const session = recordSession;
    if (!session) return;
    /* Hide pause/stop hub chrome immediately — onstop can be late; avoids Cancel/metrics stuck on screen. */
    hideRecordTimer();
    document.body.classList.remove("is-recording-paused");
    captureStudio.classList.remove("capture-studio--paused-playback");
    revokeSessionPausePreviewUrl(session);
    if (session.recorder.state === "inactive") {
      if (session.discard) {
        finishRecordingUi(session.chunks, session.outMime, session);
        return;
      }
      if (session.chunks && session.chunks.length > 0) {
        finishRecordingUi(session.chunks, session.outMime, session);
      } else {
        disposeCapture(session);
        teardownRecordUi();
      }
      return;
    }
    try {
      if (typeof session.recorder.requestData === "function") {
        try {
          session.recorder.requestData();
        } catch (_) {
          /* ignore */
        }
      }
      session.recorder.stop();
    } catch (_) {
      disposeCapture(session);
      teardownRecordUi();
    }
  }

  function finishRecordingUi(chunks, outMime, sessionForUi) {
    const s = sessionForUi ?? recordSession;
    if (!s) return;
    if (s.discard) {
      const teardownDiscard = () => {
        cleanupRecordingPumpAndStudio(s);
        ensureSnipeInCluster();
        document.removeEventListener("keydown", s.onKey, true);
        detachDisplayEndedListener(s);
        if (s.tick) clearInterval(s.tick);
        hideRecordTimer();
        setHubCancelVisible(false);
        setHubSaveVisible(false);
        restoreRecordingPanel();
        disposeCapture(s);
        recordSession = null;
        document.body.classList.remove("is-recording", "is-recording-paused", "is-arming");
        recordPanel.classList.remove("record-panel--arming");
        recordPanel.classList.add("hidden");
        snipeBtn.setAttribute("aria-label", "Start screen recording");
        recordStopBtn.setAttribute("aria-label", "Stop recording");
        studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
        snipeBtn.disabled = false;
        disposeStudioCaptureSilent();
        captureStudio.classList.add("hidden");
        captureStudio.setAttribute("aria-hidden", "true");
        document.body.classList.remove("is-live-capture", "is-preview");
        cancelStatusReveal();
        setStudioSigTriggersDisabled(false);
        recordStopBtn.disabled = false;
        refreshInputLeds();
        if (hubSnipeSlot && snipeBtn && snipeBtn.parentElement !== hubSnipeSlot) {
          hubSnipeSlot.appendChild(snipeBtn);
        }
        snipeBtn.setAttribute("aria-label", "Start screen recording");
        void refreshMicDeviceList();
        clearSnipeStudioRecordUi();
        syncScadaClusterStudioWide();
      };
      teardownDiscard();
      setStatus("");
      return;
    }
    const blobParts = [];
    if (s.segmentBlobs && s.segmentBlobs.length) {
      for (const b of s.segmentBlobs) {
        if (b && b.size) blobParts.push(b);
      }
    }
    const tail = s.chunks && s.chunks.length ? s.chunks : chunks;
    const lastBlob =
      tail && tail.length ? new Blob(tail, { type: s.outMime || outMime || "video/webm" }) : null;
    if (lastBlob && lastBlob.size) blobParts.push(lastBlob);
    const totalBytes = blobParts.reduce((n, b) => n + (b && b.size ? b.size : 0), 0);
    const hasRecording = totalBytes > 0;

    const teardownAfterRecord = (keepStudioForReview) => {
      cleanupRecordingPumpAndStudio(s, keepStudioForReview ? { keepVisibleForReview: true } : undefined);
      ensureSnipeInCluster();
      document.removeEventListener("keydown", s.onKey, true);
      detachDisplayEndedListener(s);
      const tickId = s.tick;
      if (tickId) clearInterval(tickId);
      hideRecordTimer();
      setHubCancelVisible(false);
      setHubSaveVisible(false);
      restoreRecordingPanel();
      disposeCapture(s);
      recordSession = null;
      document.body.classList.remove("is-recording", "is-recording-paused", "is-arming");
      recordPanel.classList.remove("record-panel--arming");
      recordPanel.classList.add("hidden");
      snipeBtn.setAttribute("aria-label", "Start screen recording");
      recordStopBtn.setAttribute("aria-label", "Stop recording");
      if (!keepStudioForReview) {
        /* Empty studio card, not the duplicate hub strip (#hub-input-row). */
        disposeStudioCapture();
      }
      applyIdleInputIndicators();
    };

    if (!hasRecording) {
      teardownAfterRecord(false);
      studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
      snipeBtn.disabled = false;
      setStatus("Nothing recorded.");
      return;
    }

    studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
    teardownAfterRecord(false);
    const blob =
      blobParts.length === 1
        ? blobParts[0]
        : new Blob(blobParts, { type: s.outMime || outMime || "video/webm" });
    const ext = /mp4/i.test(s.outMime || outMime) ? "mp4" : "webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultBase = `snipe-${stamp}`;
    const name = safeDownloadFilename(`${defaultBase}.${ext}`, defaultBase, ext);
    downloadBlob(blob, name);
    document.body.classList.remove("is-recording-paused");
    setStatus(`Saved ${name}`);
    window.setTimeout(() => setStatus(""), 4000);
  }

  function discardRecordingSession() {
    const session = recordSession;
    if (!session || session.rebuildBusy) return;
    session.discard = true;
    session.segmentBlobs = [];
    if (session.chunks) session.chunks.length = 0;
    finalizeRecordingSession();
  }

  async function stopRecorderIntoSegment(session) {
    const rec = session.recorder;
    if (!rec || rec.state === "inactive") return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      rec.onstop = finish;
      try {
        if (typeof rec.requestData === "function") rec.requestData();
        rec.stop();
      } catch (_) {
        finish();
      }
      window.setTimeout(finish, 9000);
    });
    const partMime = session.outMime || rec.mimeType || "video/webm";
    const part = new Blob(session.chunks, { type: partMime });
    if (part.size) {
      if (!session.segmentBlobs) session.segmentBlobs = [];
      session.segmentBlobs.push(part);
    }
    if (session.chunks) session.chunks.length = 0;
  }

  async function startFollowOnRecorder(session, stream) {
    const mime = pickRecorderMimeForStream(stream);
    const brRec = getRecordingBitrates();
    const recOptsFull = {};
    if (mime) recOptsFull.mimeType = mime;
    if (stream.getVideoTracks().length > 0) recOptsFull.videoBitsPerSecond = brRec.video;
    if (
      stream.getAudioTracks().length > 0 &&
      (!mime || mime.includes("opus") || mime.includes("webm") || mime.includes("mp4"))
    ) {
      recOptsFull.audioBitsPerSecond = brRec.audio;
    }
    let recorder;
    try {
      recorder = new MediaRecorder(stream, recOptsFull);
    } catch (_) {
      try {
        const light = {};
        if (mime) light.mimeType = mime;
        if (stream.getVideoTracks().length > 0) light.videoBitsPerSecond = brRec.video;
        if (
          stream.getAudioTracks().length > 0 &&
          mime &&
          (mime.includes("mp4") || mime.includes("webm"))
        ) {
          light.audioBitsPerSecond = brRec.audio;
        }
        recorder = new MediaRecorder(stream, light);
      } catch (_) {
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      }
    }
    session.recorder = recorder;
    session.outMime = mime || recorder.mimeType || session.outMime;
    session.recordStreamUsed = stream;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) session.chunks.push(e.data);
    };
    recorder.onerror = () => {
      try {
        if (recorder.state === "recording" || recorder.state === "paused") recorder.stop();
      } catch (_) {
        /* ignore */
      }
    };
    recorder.onstop = () => {
      finishRecordingUi(session.chunks, session.outMime, session);
    };
    await yieldToMediaPipeline();
    recorder.start(100);
    if (session.studioRecordAudioMixer?.ctx && session.studioRecordAudioMixer.ctx.state !== "closed") {
      void session.studioRecordAudioMixer.ctx.resume();
    }
  }

  async function rebuildRecordingVideoTrack(session, videoOn) {
    if (!session.displayStream || session.discard) return;
    const aud = session.studioRecordAudioMixer?.audioTrack;
    const rs = session.recordStreamUsed;
    const cv = session.cvVideoTrack;
    const canSoftToggle =
      cv &&
      aud &&
      rs &&
      rs.getVideoTracks().length === 1 &&
      rs.getVideoTracks()[0] === cv &&
      rs.getAudioTracks().length > 0;

    if (canSoftToggle) {
      session.recordIncludeVideo = videoOn;
      session.displayStream.getVideoTracks().forEach((t) => {
        try {
          t.enabled = true;
        } catch (_) {
          /* ignore */
        }
      });
      if (session.pumpLoopRef) {
        session.pumpActive = true;
        if (session.pumpRafId == null) {
          session.pumpRafId = requestAnimationFrame(session.pumpLoopRef);
        }
      }
      if (videoOn) {
        captureStudio.classList.remove("capture-studio--audio-meter-preview");
        setStudioScreenVideoPreviewActive(true);
        studioVideo.srcObject = session.displayStream;
        studioVideo.muted = true;
        try {
          studioVideo.play().catch(() => {});
        } catch (_) {
          /* ignore */
        }
      } else {
        studioVideo.srcObject = null;
        try {
          studioVideo.pause();
        } catch (_) {
          /* ignore */
        }
        setStudioScreenVideoPreviewActive(false);
        captureStudio.classList.add("capture-studio--audio-meter-preview");
      }
      syncStudioAspectFromCapture();
      setStatus(
        videoOn
          ? "Screen video added to recording."
          : "Recording black frames — turn screen video on again to show the capture."
      );
      window.setTimeout(() => {
        if (recordSession === session) setStatus("");
      }, 2800);
      return;
    }

    if (videoOn) {
      session.displayStream.getVideoTracks().forEach((t) => {
        try {
          t.enabled = true;
        } catch (_) {
          /* ignore */
        }
      });
      const vt = forkVideoTrackForRecorder(session.displayStream);
      if (!vt) {
        setStatus("Could not attach screen video to recording.");
        return;
      }
      await stopRecorderIntoSegment(session);
      const newStream = aud ? new MediaStream([vt, aud]) : new MediaStream([vt]);
      await startFollowOnRecorder(session, newStream);
    } else {
      if (!aud) {
        setStatus("Enable microphone or tab/system audio to record without video.");
        return;
      }
      session.displayStream.getVideoTracks().forEach((t) => {
        try {
          t.enabled = false;
        } catch (_) {
          /* ignore */
        }
      });
      await stopRecorderIntoSegment(session);
      await startFollowOnRecorder(session, new MediaStream([aud]));
    }
    if (session.pumpLoopRef) {
      if (videoOn) {
        session.pumpActive = true;
        if (session.pumpRafId == null) {
          session.pumpRafId = requestAnimationFrame(session.pumpLoopRef);
        }
      } else {
        session.pumpActive = false;
        if (session.pumpRafId != null) {
          cancelAnimationFrame(session.pumpRafId);
          session.pumpRafId = null;
        }
      }
    }
    if (session.displayStream) {
      if (videoOn) {
        captureStudio.classList.remove("capture-studio--audio-meter-preview");
        setStudioScreenVideoPreviewActive(true);
        studioVideo.srcObject = session.displayStream;
        studioVideo.muted = true;
        try {
          studioVideo.play().catch(() => {});
        } catch (_) {
          /* ignore */
        }
      } else {
        studioVideo.srcObject = null;
        try {
          studioVideo.pause();
        } catch (_) {
          /* ignore */
        }
        setStudioScreenVideoPreviewActive(false);
        captureStudio.classList.add("capture-studio--audio-meter-preview");
      }
      syncStudioAspectFromCapture();
    }
    setStatus(videoOn ? "Screen video added to recording." : "Recording audio only from here.");
    window.setTimeout(() => {
      if (recordSession === session) setStatus("");
    }, 2800);
  }

  async function syncRecordingSessionWithIntent(session) {
    if (!session || session.discard || session.rebuildBusy) return;
    const intent = getInputIntent();
    const prevV = session.recordIncludeVideo !== false;
    const mix = session.studioRecordAudioMixer;
    const wantMic = micIntentEffective(intent);
    const hasMic = !!(
      session.micStream &&
      session.micStream.getAudioTracks().some((t) => t.readyState !== "ended")
    );
    const vOn = !!intent.video;

    if (mix && typeof mix.setDisplayAudible === "function") {
      mix.setDisplayAudible(!!intent.sys);
    }
    session.recordIncludeDisplayAudio = !!intent.sys;

    session.rebuildBusy = true;
    try {
      const mixAfter = session.studioRecordAudioMixer;
      const hasMicNow = !!(
        session.micStream &&
        session.micStream.getAudioTracks().some((t) => t.readyState !== "ended")
      );
      const micNeedsSync =
        mixAfter &&
        (wantMic !== hasMicNow ||
          (wantMic && !micStreamMatchesIntent(session.micStream, intent)));
      if (micNeedsSync && mixAfter) {
        if (wantMic) {
          try {
            const ms = await acquireMicStreamForMixing();
            mixAfter.addMicStream(ms);
            if (session.micStream) session.micStream.getTracks().forEach((t) => t.stop());
            session.micStream = ms;
            clearInputPermissionBlocked();
          } catch (e2) {
            if (e2 && e2.name === "NotAllowedError") {
              setInputPermissionBlocked({ mic: true });
            } else {
              setStatus((e2 && e2.message) || "Microphone not available.");
            }
            const cur = getInputIntent();
            const cleared = { ...cur, micDevices: {}, mic: false };
            persistInputIntent(cleared);
            refreshInputLeds();
          }
        } else {
          mixAfter.removeMic();
          if (session.micStream) {
            session.micStream.getTracks().forEach((t) => t.stop());
            session.micStream = null;
          }
        }
      }

      if (vOn !== prevV && session.displayStream) {
        await rebuildRecordingVideoTrack(session, vOn);
      }

      session.recordIncludeVideo = vOn;
      session.recordIncludeDisplayAudio = !!intent.sys;
      applyLiveIndicatorsFromSession(session);
      updateStudioMicToggleMenuLabel();
      if (!session.displayStream && session.micStream) {
        const live = session.micStream.getAudioTracks().filter((t) => t.readyState === "live");
        if (live.length && micIntentEffective(getInputIntent())) {
          captureStudio.classList.add("capture-studio--audio-meter-preview");
        }
      }
    } finally {
      session.rebuildBusy = false;
    }
  }

  function raceDisplayMedia(promise, ms, onTimeout) {
    let tid = null;
    return new Promise((resolve, reject) => {
      tid = window.setTimeout(() => {
        tid = null;
        try {
          onTimeout();
        } catch {
          /* ignore */
        }
        reject(new DOMException("Display capture timed out.", "TimeoutError"));
      }, ms);
      promise.then(
        (v) => {
          if (tid != null) window.clearTimeout(tid);
          resolve(v);
        },
        (e) => {
          if (tid != null) window.clearTimeout(tid);
          reject(e);
        }
      );
    });
  }

  /**
   * Chrome’s screen picker steals OS/tab focus; nudge this window and tab back as soon as the
   * dialog closes (success, cancel, or timeout). Tiered retries help after native UI teardown.
   */
  function restoreWindowFocusAfterDisplayPicker() {
    const kick = () => {
      try {
        if (typeof window.focus === "function") window.focus();
      } catch (_) {
        /* ignore */
      }
      try {
        if (document.hasFocus && !document.hasFocus() && snipeBtn && typeof snipeBtn.focus === "function") {
          snipeBtn.focus({ preventScroll: true });
        }
      } catch (_) {
        /* ignore */
      }
    };
    kick();
    requestAnimationFrame(() => {
      kick();
      requestAnimationFrame(kick);
    });
    window.setTimeout(kick, 0);
    window.setTimeout(kick, 48);
  }

  async function buildMicOnlyBundle() {
    const micStream = await acquireMicStreamForMixing();
    const live = micStream.getAudioTracks().filter((t) => t.readyState === "live");
    if (!live.length) {
      micStream.getTracks().forEach((t) => t.stop());
      throw new Error("No live microphone track.");
    }
    return {
      recordStream: new MediaStream(live),
      displayStream: null,
      micStream,
      audioContext: null,
      hints: [],
      inputState: {
        video: false,
        mic: true,
        sys: false,
      },
      captureMode: "mic-only",
      recordIncludeVideo: false,
      recordIncludeDisplayAudio: false,
    };
  }

  /**
   * Picks display and/or mic from input intent.
   * When the microphone is required, acquire it **before** getDisplayMedia so the mic prompt still runs under
   * the same user activation as the button click; calling getUserMedia after the share dialog can hang or never prompt.
   */
  async function buildCaptureBundle() {
    await refreshMicDeviceList();
    const intent = getInputIntent();
    const wantV = intent.video;
    const wantS = intent.sys;
    const wantM = micIntentEffective(intent);

    if (!wantV && !wantS && !wantM) {
      throw new Error("Choose at least one input (video, microphone, or system sound).");
    }

    if (!wantV && !wantS && wantM) {
      document.body.classList.remove("is-arming");
      try {
        return await buildMicOnlyBundle();
      } catch (e) {
        if (e && e.name === "NotAllowedError") {
          setInputPermissionBlocked({ mic: true });
        }
        throw e;
      }
    }

    let micStream = null;
    if (wantM) {
      try {
        micStream = await acquireMicStreamForMixing();
      } catch (e) {
        document.body.classList.remove("is-arming");
        if (e && e.name === "NotAllowedError") {
          setInputPermissionBlocked({ mic: true });
        }
        throw e;
      }
    }

    let displayStream;
    try {
      /* Always request display audio in the same getDisplayMedia call as video (when sharing a surface).
       * Chrome then shows “Share tab audio” / system audio in the picker; user can enable sound without a second prompt. */
      displayStream = await raceDisplayMedia(getDisplayStreamWithAudio(), 120000, () => {});
    } catch (e) {
      if (micStream) {
        micStream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch (_) {
            /* ignore */
          }
        });
        micStream = null;
      }
      if (e && e.name === "NotAllowedError") {
        setInputPermissionBlocked({
          video: !!(wantV || wantS),
          sys: !!wantS,
        });
      }
      throw e;
    } finally {
      restoreWindowFocusAfterDisplayPicker();
    }
    document.body.classList.remove("is-arming");

    /* Chrome occasionally attaches display-audio tracks on the next frame after resolve. */
    await new Promise((r) => requestAnimationFrame(() => r()));
    const streamHasDisplayAudio = displayStream.getAudioTracks().some((t) => t.readyState !== "ended");
    const effectiveIncludeDisplayAudio = wantS || streamHasDisplayAudio;
    /* Do not persist sys:true here — that turned the Sound hub LED on after share even when the user never toggled Sound. */

    let pipe;
    try {
      pipe = await makeRecordPipeline(displayStream, micStream, {
        includeVideo: wantV,
        includeDisplayAudio: effectiveIncludeDisplayAudio,
      });
    } catch (e) {
      displayStream.getTracks().forEach((t) => t.stop());
      if (micStream) micStream.getTracks().forEach((t) => t.stop());
      throw e;
    }

    const { recordStream, audioContext, videoTrack, displayAudioTracks, hasSys, hasMic } = pipe;

    if (!wantV && wantS) {
      displayStream.getVideoTracks().forEach((t) => {
        try {
          t.enabled = false;
        } catch (_) {
          /* ignore */
        }
      });
    }

    const vtLive = displayStream.getVideoTracks()[0];
    return {
      recordStream,
      displayStream,
      micStream,
      audioContext,
      hints: [],
      inputState: {
        video: Boolean(wantV && vtLive && vtLive.readyState === "live"),
        mic: hasMic,
        sys: hasSys,
      },
      captureMode: wantV ? "display" : "display-audio-only",
      recordIncludeVideo: wantV,
      recordIncludeDisplayAudio: effectiveIncludeDisplayAudio,
    };
  }

  async function studioTeardownVoicePipeline(bundle) {
    if (!bundle) return;
    try {
      if (bundle.audioContext && bundle.audioContext.state !== "closed") {
        await bundle.audioContext.close();
      }
    } catch (_) {
      /* ignore */
    }
    bundle.audioContext = null;
    if (bundle.micStream) {
      bundle.micStream.getTracks().forEach((t) => t.stop());
      bundle.micStream = null;
    }
  }

  async function studioRebuildRecordStream(bundle) {
    if (!bundle.displayStream) {
      if (bundle.captureMode === "mic-only") {
        const live = bundle.micStream
          ? bundle.micStream.getAudioTracks().filter((t) => t.readyState !== "ended")
          : [];
        if (!live.length) {
          setStatus("Microphone removed — closing capture.");
          disposeStudioCapture();
          return;
        }
        bundle.recordStream = new MediaStream(live);
        bundle.audioContext = null;
        bundle.inputState = { video: false, mic: true, sys: false };
        applyLiveIndicatorsFromCaptureBundle(bundle);
        wireLivePreviewSurface(bundle);
      }
      return;
    }
    const pipe = await makeRecordPipeline(bundle.displayStream, bundle.micStream, {
      includeVideo: bundle.recordIncludeVideo !== false,
      includeDisplayAudio: bundle.recordIncludeDisplayAudio !== false,
    });
    bundle.recordStream = pipe.recordStream;
    bundle.audioContext = pipe.audioContext;
    bundle.inputState.mic = pipe.hasMic;
    bundle.inputState.sys = pipe.hasSys;
    bundle.inputState.video = Boolean(
      bundle.recordIncludeVideo !== false &&
        bundle.displayStream.getVideoTracks()[0] &&
        bundle.displayStream.getVideoTracks()[0].readyState === "live"
    );
    applyLiveIndicatorsFromCaptureBundle(bundle);
    wireLivePreviewSurface(bundle);
  }

  function applyLiveIndicatorsFromCaptureBundle(bundle) {
    void bundle;
    refreshInputLeds();
  }

  function applyLiveIndicatorsFromSession(sess) {
    void sess;
    refreshInputLeds();
  }

  async function onStudioVoiceToggle() {
    if (studioVoiceToggleBusy) return;
    studioVoiceToggleBusy = true;
    try {
      if (recordSession) {
        await syncRecordingSessionWithIntent(recordSession);
        updateStudioMicToggleMenuLabel();
        applyLiveIndicatorsFromSession(recordSession);
        const sess = recordSession;
        if (sess && !sess.displayStream && sess.micStream) {
          const live = sess.micStream.getAudioTracks().filter((t) => t.readyState === "live");
          if (live.length && micIntentEffective(getInputIntent())) {
            captureStudio.classList.add("capture-studio--audio-meter-preview");
          }
        }
        setStatus("Microphones updated.");
        return;
      }
      if (studioCapture) {
        await syncStudioCaptureMicDevices(studioCapture);
        updateStudioMicToggleMenuLabel();
        setStatus("Microphones updated.");
      }
    } finally {
      studioVoiceToggleBusy = false;
    }
  }

  async function beginRecordingFromStudio() {
    if (snipeArming) return;
    const bundle = studioCapture;
    if (recordSession) return;
    if (!bundle) {
      setStatus("Capture not ready — turn on an input, then pick what to share.");
      return;
    }

    /* getSettings() can populate displaySurface / size after the first wire — re-check before applying crop. */
    if (bundle.captureMode !== "mic-only" && bundle.displayStream) {
      const nowMeta = displayCaptureWireMeta(bundle.displayStream);
      if (studioRegionNorm && shouldInvalidateCropFromWireMeta(lastWiredDisplayWireMeta, nowMeta)) {
        clearStudioRegionCrop();
      }
      if (nowMeta) {
        lastWiredDisplayWireMeta = nowMeta;
      }
    }

    const norm = bundle.recordIncludeVideo ? studioRegionNorm : null;
    if (norm && (norm.w < 0.02 || norm.h < 0.02)) {
      setStatus("Crop area too small — draw a larger box or clear crop in Screen menu.");
      disposeStudioCapture();
      return;
    }

    if (bundle.captureMode === "mic-only") {
      const micTracks = bundle.micStream
        ? bundle.micStream.getAudioTracks().filter((t) => t.readyState !== "ended")
        : [];
      if (!micTracks.length) {
        setStatus("Microphone ended.");
        disposeStudioCapture();
        return;
      }
    } else {
      const displayStream = bundle.displayStream;
      if (!displayStream) {
        setStatus("Capture ended.");
        disposeStudioCapture();
        return;
      }
      const vTrackPre = displayStream.getVideoTracks()[0];
      if (bundle.recordIncludeVideo) {
        if (!vTrackPre || vTrackPre.readyState === "ended") {
          setStatus("Capture ended.");
          disposeStudioCapture();
          return;
        }
      } else {
        const aud = displayStream.getAudioTracks().filter((t) => t.readyState !== "ended");
        const hasMic = bundle.micStream?.getAudioTracks().some((t) => t.readyState !== "ended");
        if (!aud.length && !hasMic) {
          setStatus(
            "No shared audio — enable “Share audio” in the picker, or turn on the microphone."
          );
          disposeStudioCapture();
          return;
        }
      }
    }

    snipeBtn.disabled = true;
    setStudioSigTriggersDisabled(true);

    captureStudio.classList.add("capture-studio--starting");
    try {
    const displayStream = bundle.displayStream;
    let recordStreamForRec;
    /** Dedicated element for crop pump — drawImage from the on-screen preview often yields black in Chrome (compositing/CSS). */
    let pumpFeedVideo = null;
    let pumpCanvas = null;
    let pumpLoopRef = null;
    let cvVideoTrack = null;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    let sh = 0;
    let studioMixer = null;

    if (bundle.captureMode === "mic-only") {
      await detachBundleAudioContextOnly(bundle);
      try {
        studioMixer = await openStudioRecordAudioMixer(new MediaStream(), bundle.micStream);
      } catch (eMix) {
        setStatus((eMix && eMix.message) || "Could not start audio for recording.");
        snipeBtn.disabled = false;
        setStudioSigTriggersDisabled(false);
        captureStudio.classList.add("capture-studio--live-preview");
        document.body.classList.add("is-live-capture");
        ensureSnipeInStudio();
        showPreviewRecordTimerZero();
        return;
      }
      recordStreamForRec = studioMixer?.audioTrack
        ? new MediaStream([studioMixer.audioTrack])
        : new MediaStream(
            bundle.micStream.getAudioTracks().filter((t) => t.readyState !== "ended")
          );
    } else {
      /* Unmute wait first (cheap when there is no tab audio). Web Audio only when Voice is on —
       * otherwise passthrough display audio or video-only (avoids renderer errors + long resume). */
      await waitForDisplayCaptureAudioUnmute(displayStream, displayStream, 1500);
      await detachBundleAudioContextOnly(bundle);

      const vt0 = displayStream.getVideoTracks()[0];
      const canPumpScreen = Boolean(vt0 && vt0.readyState !== "ended");

      const v = studioVideo;
      if (bundle.recordIncludeVideo) {
        await new Promise((resolve) => {
          if (v.readyState >= 1 && v.videoWidth > 1) {
            resolve();
            return;
          }
          const t = window.setTimeout(resolve, 2500);
          v.addEventListener(
            "loadedmetadata",
            () => {
              window.clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        });
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        if (vw < 2 || vh < 2) {
          setStatus("Video not ready — wait a second and try Start recording again.");
          snipeBtn.disabled = false;
          setStudioSigTriggersDisabled(false);
          captureStudio.classList.add("capture-studio--live-preview");
          document.body.classList.add("is-live-capture");
          ensureSnipeInStudio();
          showPreviewRecordTimerZero();
          return;
        }
      }

      /* Screen share almost always includes a video track. Build the canvas pump whenever it exists so we can
       * record black video + mixed audio first, then switch to real frames when the user turns screen video on
       * — one MediaRecorder stream, no broken multi-segment mux. */
      if (bundle.recordIncludeVideo || canPumpScreen) {
        displayStream.getVideoTracks().forEach((t) => {
          try {
            t.enabled = true;
          } catch (_) {
            /* ignore */
          }
        });

        pumpFeedVideo = document.createElement("video");
        pumpFeedVideo.muted = true;
        pumpFeedVideo.playsInline = true;
        pumpFeedVideo.setAttribute("playsinline", "");
        pumpFeedVideo.setAttribute("webkit-playsinline", "");
        pumpFeedVideo.setAttribute("aria-hidden", "true");
        pumpFeedVideo.srcObject = displayStream;
        pumpFeedVideo.style.cssText =
          "position:fixed;left:0;top:0;width:4px;height:4px;opacity:0.02;pointer-events:none;z-index:2147483646;object-fit:fill;";
        document.body.appendChild(pumpFeedVideo);
        try {
          await pumpFeedVideo.play();
        } catch (_) {
          /* ignore */
        }
        await new Promise((resolve) => {
          if (pumpFeedVideo.videoWidth > 1 && pumpFeedVideo.videoHeight > 1) {
            resolve();
            return;
          }
          const t = window.setTimeout(resolve, 4200);
          pumpFeedVideo.addEventListener(
            "loadedmetadata",
            () => {
              window.clearTimeout(t);
              resolve();
            },
            { once: true }
          );
        });
        const pvw = pumpFeedVideo.videoWidth;
        const pvh = pumpFeedVideo.videoHeight;
        if (pvw < 2 || pvh < 2) {
          try {
            pumpFeedVideo.pause();
            pumpFeedVideo.srcObject = null;
            pumpFeedVideo.remove();
          } catch (_) {
            /* ignore */
          }
          pumpFeedVideo = null;
          setStatus("Video decode not ready — wait a moment and try Start recording again.");
          snipeBtn.disabled = false;
          setStudioSigTriggersDisabled(false);
          captureStudio.classList.add("capture-studio--live-preview");
          document.body.classList.add("is-live-capture");
          ensureSnipeInStudio();
          showPreviewRecordTimerZero();
          return;
        }
        if (norm) {
          sx = Math.round(norm.x * pvw);
          sy = Math.round(norm.y * pvh);
          sw = Math.round(norm.w * pvw);
          sh = Math.round(norm.h * pvh);
          sx = clamp(sx, 0, pvw - 2);
          sy = clamp(sy, 0, pvh - 2);
          sw = clamp(sw, 2, pvw - sx);
          sh = clamp(sh, 2, pvh - sy);
        } else {
          /* Full frame via canvas pump — avoids forkVideoTrackForRecorder black frames in some builds. */
          sx = 0;
          sy = 0;
          sw = pvw;
          sh = pvh;
        }

        const maxW = 1920;
        let cw = sw;
        let ch = sh;
        if (cw > maxW) {
          ch = Math.round((ch * maxW) / cw);
          cw = maxW;
        }
        pumpCanvas = document.createElement("canvas");
        pumpCanvas.width = cw % 2 === 0 ? cw : cw + 1;
        pumpCanvas.height = ch % 2 === 0 ? ch : ch + 1;
        const pctx = pumpCanvas.getContext("2d", { alpha: false });
        /* Prefer 0 fps + requestFrame per draw; Safari may reject 0 — fall back to 30. */
        let cvStream;
        try {
          cvStream = pumpCanvas.captureStream(0);
        } catch (_) {
          cvStream = pumpCanvas.captureStream(30);
        }
        cvVideoTrack = cvStream.getVideoTracks()[0];

        const feed = pumpFeedVideo;
        pumpLoopRef = () => {
          const sess = recordSession;
          if (!sess || !sess.pumpActive) return;
          const wantReal = sess.recordIncludeVideo !== false;
          if (
            feed &&
            feed.readyState >= HTMLMediaElement.HAVE_METADATA &&
            feed.videoWidth > 1 &&
            feed.videoHeight > 1
          ) {
            try {
              pctx.fillStyle = "#000";
              pctx.fillRect(0, 0, pumpCanvas.width, pumpCanvas.height);
              if (wantReal) {
                pctx.drawImage(feed, sx, sy, sw, sh, 0, 0, pumpCanvas.width, pumpCanvas.height);
              }
            } catch (_) {
              /* ignore */
            }
            try {
              if (cvVideoTrack && typeof cvVideoTrack.requestFrame === "function") {
                cvVideoTrack.requestFrame();
              }
            } catch (_) {
              /* ignore */
            }
          }
          sess.pumpRafId = requestAnimationFrame(pumpLoopRef);
        };
      }

    /* Always run the studio mixer for display capture so MediaRecorder keeps one stream end-to-end.
     * Turning mic/tab audio on later only patches the mixer — no recorder stop/start (broken multi-segment files). */
    try {
      studioMixer = await openStudioRecordAudioMixer(displayStream, bundle.micStream || null);
    } catch (eMix) {
      if (pumpFeedVideo) {
        try {
          pumpFeedVideo.pause();
          pumpFeedVideo.srcObject = null;
          pumpFeedVideo.remove();
        } catch (_) {
          /* ignore */
        }
        pumpFeedVideo = null;
      }
      setStatus((eMix && eMix.message) || "Could not start audio for recording.");
      snipeBtn.disabled = false;
      setStudioSigTriggersDisabled(false);
      captureStudio.classList.add("capture-studio--live-preview");
      document.body.classList.add("is-live-capture");
      ensureSnipeInStudio();
      showPreviewRecordTimerZero();
      return;
    }
    if (studioMixer && typeof studioMixer.setDisplayAudible === "function") {
      studioMixer.setDisplayAudible(bundle.recordIncludeDisplayAudio !== false);
    }

    const mixAudio = studioMixer?.audioTrack;
    if (!mixAudio) {
      studioMixer?.close();
      setStatus("No audio track to record.");
      snipeBtn.disabled = false;
      setStudioSigTriggersDisabled(false);
      ensureSnipeInStudio();
      return;
    }
    if (bundle.recordIncludeVideo && !cvVideoTrack) {
      studioMixer?.close();
      if (pumpFeedVideo) {
        try {
          pumpFeedVideo.pause();
          pumpFeedVideo.srcObject = null;
          pumpFeedVideo.remove();
        } catch (_) {
          /* ignore */
        }
        pumpFeedVideo = null;
      }
      setStatus("Could not build screen video for recording.");
      snipeBtn.disabled = false;
      setStudioSigTriggersDisabled(false);
      ensureSnipeInStudio();
      return;
    }
    /* Black canvas + audio when screen video is off but a display video track exists — same recorder when user turns video on. */
    recordStreamForRec = cvVideoTrack
      ? new MediaStream([cvVideoTrack, mixAudio])
      : new MediaStream([mixAudio]);

    }

    recordStreamForRec = bundle.displayStream
      ? stripMutedStuckDisplayAudio(recordStreamForRec, bundle.displayStream)
      : recordStreamForRec;
    await yieldToMediaPipeline();

    const mime = pickRecorderMimeForStream(recordStreamForRec);

    const brRec = getRecordingBitrates();
    const recOptsFull = {};
    if (mime) recOptsFull.mimeType = mime;
    if (recordStreamForRec.getVideoTracks().length > 0) {
      recOptsFull.videoBitsPerSecond = brRec.video;
    }
    if (
      recordStreamForRec.getAudioTracks().length > 0 &&
      (!mime ||
        mime.includes("opus") ||
        mime.includes("webm") ||
        mime.includes("mp4"))
    ) {
      recOptsFull.audioBitsPerSecond = brRec.audio;
    }

    let recorder;
    try {
      recorder = new MediaRecorder(recordStreamForRec, recOptsFull);
    } catch (_) {
      try {
        const light = {};
        if (mime) light.mimeType = mime;
        if (recordStreamForRec.getVideoTracks().length > 0) {
          light.videoBitsPerSecond = brRec.video;
        }
        if (
          recordStreamForRec.getAudioTracks().length > 0 &&
          mime &&
          (mime.includes("mp4") || mime.includes("webm"))
        ) {
          light.audioBitsPerSecond = brRec.audio;
        }
        recorder = new MediaRecorder(recordStreamForRec, light);
      } catch (e2) {
        try {
          recorder = mime
            ? new MediaRecorder(recordStreamForRec, { mimeType: mime })
            : new MediaRecorder(recordStreamForRec);
        } catch (e3) {
          if (pumpFeedVideo) {
            try {
              pumpFeedVideo.pause();
              pumpFeedVideo.srcObject = null;
              pumpFeedVideo.remove();
            } catch (_) {
              /* ignore */
            }
            pumpFeedVideo = null;
          }
          studioMixer?.close();
          snipeBtn.disabled = false;
          setStudioSigTriggersDisabled(false);
          setStatus((e3 && e3.message) || "Could not create recorder.");
          disposeStudioCapture();
          return;
        }
      }
    }

    const chunks = [];
    const outMime = mime || recorder.mimeType || "video/webm";
    const started = Date.now();

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finalizeRecordingSession();
      }
    };

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    recorder.onerror = () => {
      try {
        if (recorder.state === "recording" || recorder.state === "paused") {
          recorder.stop();
        }
      } catch (_) {
        /* ignore */
      }
    };

    const onDisplayEndedHandler = () => handleDisplayTrackEnded();

    detachStudioDisplayListener();
    studioCapture = null;
    captureStudio.classList.remove("capture-studio--selecting");

    /* Do not refreshInputLeds here — recordSession is assigned below; earlier call left LEDs armed (blue). */
    setStatus(bundle.hints.length ? bundle.hints.join(" ") : "Recording.");

    const endGuardTrack = bundle.displayStream
      ? bundle.displayStream.getVideoTracks()[0]
      : bundle.micStream?.getAudioTracks()[0] ?? null;

    const sessRef = {
      arming: true,
      chunks,
      segmentBlobs: [],
      outMime,
      displayStream: bundle.displayStream,
      endGuardTrack,
      recordIncludeVideo: bundle.recordIncludeVideo !== false,
      recordIncludeDisplayAudio: bundle.recordIncludeDisplayAudio !== false,
      recordStreamUsed: recordStreamForRec,
      micStream: bundle.micStream,
      audioContext: studioMixer?.ctx ?? null,
      studioRecordAudioMixer: studioMixer,
      /** Canvas-captured screen video track — set when recording with screen video (for lazy audio mixer). */
      cvVideoTrack: cvVideoTrack || null,
      recorder,
      tick: null,
      onKey,
      onDisplayEndedHandler,
      pumpActive: Boolean(pumpLoopRef),
      pumpRafId: null,
      pumpLoopRef: pumpLoopRef || null,
      pumpCanvas,
      recStartedAt: started,
      totalPausedMs: 0,
      pauseStartedAt: null,
      pauseObjectUrl: null,
      pauseHadCropOverlay: false,
      pumpFeedVideo,
    };
    recordSession = sessRef;

    recorder.onstop = () => {
      finishRecordingUi(chunks, outMime, sessRef);
    };

    document.body.classList.add("is-recording");
    refreshInputLeds();

    document.addEventListener("keydown", onKey, true);

    try {
      await yieldToMediaPipeline();
      if (recordSession !== sessRef) return;
      if (studioMixer && studioMixer.ctx.state !== "closed") {
        await Promise.race([
          studioMixer.ctx.resume(),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      }
      if (recordSession !== sessRef) return;
      recordSession.arming = false;
      /* Bind preview to display *before* MediaRecorder + crop pump — otherwise drawImage sees an empty/wrong frame and records black. */
      syncStudioVideoPreviewForRecordingSession(recordSession);
      await yieldToMediaPipeline();
      if (recordSession !== sessRef) return;
      refreshInputLeds();
      if (pumpCanvas && cvVideoTrack && pumpFeedVideo) {
        const pctx = pumpCanvas.getContext("2d");
        if (pctx && pumpFeedVideo.videoWidth > 1 && pumpFeedVideo.videoHeight > 1) {
          try {
            pctx.fillStyle = "#000";
            pctx.fillRect(0, 0, pumpCanvas.width, pumpCanvas.height);
            if (bundle.recordIncludeVideo !== false) {
              pctx.drawImage(
                pumpFeedVideo,
                sx,
                sy,
                sw,
                sh,
                0,
                0,
                pumpCanvas.width,
                pumpCanvas.height
              );
            }
          } catch (_) {
            /* ignore */
          }
          try {
            if (typeof cvVideoTrack.requestFrame === "function") {
              cvVideoTrack.requestFrame();
            }
          } catch (_) {
            /* ignore */
          }
        }
      }
      recorder.start(100);
      if (studioMixer && studioMixer.ctx.state !== "closed") {
        void studioMixer.ctx.resume();
      }
      if (endGuardTrack) {
        endGuardTrack.addEventListener("ended", onDisplayEndedHandler);
      }
      if (pumpLoopRef && recordSession.pumpActive) {
        recordSession.pumpRafId = requestAnimationFrame(pumpLoopRef);
      }
      applySnipeStudioStopUi();
      setStudioSigTriggersDisabled(false);
      recordMetricsEl.hidden = false;
      recordBytesEl.textContent = "0 B";
      recordElapsedEl.textContent = formatDuration(0);
      recordElapsedEl.setAttribute("datetime", "PT0S");
      startRecordingTick(recordSession);
    } catch (e) {
      /* recordSession may already be null if handleDisplayTrackEnded ran during an await
       * while arming && recorder was still inactive (listener used to be attached earlier). */
      const sess = recordSession;
      if (sess?.tick) {
        clearInterval(sess.tick);
        sess.tick = null;
      }
      hideRecordTimer();
      if (sess) {
        sess.pumpActive = false;
        if (sess.pumpRafId != null) {
          cancelAnimationFrame(sess.pumpRafId);
          sess.pumpRafId = null;
        }
      }
      document.removeEventListener("keydown", onKey, true);
      detachDisplayEndedListener(sess);
      if (sess) {
        restoreRecordingPanel();
        disposeCapture(sess);
        cleanupRecordingPumpAndStudio(sess);
      } else {
        cleanupRecordingPumpAndStudio(null);
      }
      recordSession = null;
      ensureSnipeInCluster();
      snipeBtn.disabled = false;
      setStudioSigTriggersDisabled(false);
      document.body.classList.remove("is-recording", "is-recording-paused", "is-arming");
      hideControlPanelCompletely();
      setStatus((e && e.message) || "Recorder failed to start.");
      return;
    }
    } finally {
      captureStudio.classList.remove("capture-studio--starting");
    }
  }

  async function startSnipe() {
    if (snipeArming) {
      return;
    }
    if (recordSession || pendingPreview) {
      return;
    }
    /* Orphan studioCapture (e.g. MediaRecorder failed) used to block all future starts silently. */
    if (studioCapture) {
      disposeStudioCapture();
    }

    if (!window.isSecureContext) {
      return;
    }
    await refreshMicDeviceList();
    const intentPre = getInputIntent();
    if (!intentPre.video && !intentPre.sys && !micIntentEffective(intentPre)) {
      setStatus("Turn on screen, tab audio, or microphone first.");
      return;
    }
    const micOnlyStart = !intentPre.video && !intentPre.sys && micIntentEffective(intentPre);
    if (!micOnlyStart && !navigator.mediaDevices?.getDisplayMedia) {
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      return;
    }

    document.body.classList.remove("is-preview");
    snipeArming = true;
    const awaitingShare = captureStudio.classList.contains("capture-studio--await-share");
    if (!awaitingShare) {
      showArmingPanel();
    } else {
      hideControlPanelCompletely();
      document.body.classList.remove("is-arming");
      captureStudio.classList.remove("capture-studio--await-share", "capture-studio--empty-preview");
      setStudioAwaitShareVisible(false);
    }

    let bundle = null;
    try {
      bundle = await buildCaptureBundle();
      clearInputPermissionBlocked();
      hideControlPanelCompletely();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));

      document.body.classList.remove("is-preview");
      studioCapture = bundle;
      applyLiveIndicatorsFromCaptureBundle(bundle);
      syncStudioQualitySelects();
      studioVideo.muted = true;
      studioVideoWrap.classList.remove("capture-studio__video-wrap--swap-out");
      wireLivePreviewSurface(bundle);
      syncStudioDeviceNameMenus();
      captureStudio.classList.remove("capture-studio--selecting", "capture-studio--pump-only");
      captureStudio.classList.add("capture-studio--live-preview");
      captureStudio.classList.remove("hidden");
      captureStudio.setAttribute("aria-hidden", "false");
      document.body.classList.add("is-live-capture");
      syncStudioAspectFromCapture();
      applyStoredStudioWidth();
      updateStudioResizeHandleVisibility();
      showPreviewRecordTimerZero();

      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      syncScadaClusterStudioWide();
      ensureSnipeInStudio();

      if (bundle.displayStream) {
        const vt0 = bundle.displayStream.getVideoTracks()[0];
        const deadline = Date.now() + 8000;
        while (
          vt0 &&
          vt0.readyState !== "live" &&
          vt0.readyState !== "ended" &&
          Date.now() < deadline
        ) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } catch (err) {
      try {
        detachStudioDisplayListener();
      } catch {
        /* ignore */
      }
      if (bundle) {
        try {
          disposeCapture(bundle);
        } catch {
          /* ignore */
        }
      }
      studioCapture = null;
      closeStudioUiOnly();
      hideControlPanelCompletely();
      const name = err && err.name;
      const msg = err && err.message;
      if (name === "AbortError") {
        clearInputPermissionBlocked();
        cancelStatusReveal();
        setStatus("");
        void refreshMicDeviceList();
      } else if (name === "NotAllowedError") {
        if (!document.querySelector(".studio-deck__sig--blocked")) {
          const intent = getInputIntent();
          setInputPermissionBlocked({
            video: !!intent.video,
            sys: !!intent.sys,
            mic: micIntentEffective(intent),
          });
        }
      } else if (name === "TimeoutError") {
        setStatus("Display capture timed out — try again.");
      } else if (msg) {
        setStatus(msg);
      } else {
        setStatus("Could not start capture — try again.");
      }
    } finally {
      snipeArming = false;
      if (!recordSession && !pendingPreview) {
        snipeBtn.disabled = false;
      }
    }
  }

  function onStudioKeydown(e) {
    if (recordSession) return;
    const awaiting =
      captureStudio.classList.contains("capture-studio--await-share") && !studioCapture;
    if (!studioCapture && !awaiting) return;
    if (e.key !== "Escape") return;
    const devPanel = document.getElementById("studio-device-settings");
    if (devPanel && !devPanel.hidden) {
      e.preventDefault();
      closeStudioInputMenus();
      return;
    }
    e.preventDefault();
    disposeStudioCapture();
    setStatus("");
  }

  const studioSigClickTimers = new WeakMap();

  scadaCluster.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (!captureStudio.contains(t) && !t.closest("#studio-device-bar") && !t.closest(".hub-input-row"))
      return;
    const devSetChip = t.closest(".studio-deck__device-settings-btn");
    if (
      devSetChip &&
      (captureStudio.contains(devSetChip) ||
        devSetChip.closest("#studio-device-bar") ||
        devSetChip.closest(".hub-input-row"))
    ) {
      const scrollTo = devSetChip.getAttribute("data-studio-settings-scroll");
      if (scrollTo) {
        e.preventDefault();
        e.stopPropagation();
        toggleStudioDeviceSettingsChip(scrollTo, devSetChip);
      }
      return;
    }
    if (!captureStudio.contains(t) && !t.closest("#studio-device-bar") && !t.closest(".hub-input-row"))
      return;
    const micDevBtn = t.closest("[data-mic-device-id].studio-deck__sig--btn");
    if (micDevBtn && (captureStudio.contains(micDevBtn) || micDevBtn.closest("#studio-device-bar"))) {
      if (micDevBtn.disabled) return;
      e.stopPropagation();
      let st = studioSigClickTimers.get(micDevBtn);
      if (!st) {
        st = { count: 0, tm: null };
        studioSigClickTimers.set(micDevBtn, st);
      }
      st.count += 1;
      if (st.tm) clearTimeout(st.tm);
      st.tm = setTimeout(() => {
        const n = st.count;
        st.count = 0;
        st.tm = null;
        const id = micDevBtn.getAttribute("data-mic-device-id");
        if (n === 1 && id) {
          const devPanel = document.getElementById("studio-device-settings");
          if (
            devPanel &&
            !devPanel.hidden &&
            captureStudio.classList.contains("capture-studio--device-settings-open")
          ) {
            const wrap = micDevBtn.closest("[data-device-bar-group]");
            const g = wrap?.getAttribute("data-device-bar-group") || "";
            const m = g.match(/^mic-(\d+)$/);
            if (m) {
              const scrollTo = `studio-mic-custom-${m[1]}`;
              if ((devPanel.dataset.openScrollTarget || "") !== scrollTo) {
                const opener = wrap?.querySelector(".studio-deck__device-settings-btn");
                openStudioDeviceSettingsPanel(scrollTo, opener || null);
                return;
              }
            }
          }
          toggleMicDevice(id);
        } else if (n >= 2) {
          openStudioMicMenu();
        }
      }, 280);
      return;
    }
    const sigBtn = t.closest(".studio-deck__sig--btn");
    if (sigBtn && (captureStudio.contains(sigBtn) || sigBtn.closest("#studio-device-bar"))) {
      if (sigBtn.disabled) return;
      e.stopPropagation();
      let st = studioSigClickTimers.get(sigBtn);
      if (!st) {
        st = { count: 0, tm: null };
        studioSigClickTimers.set(sigBtn, st);
      }
      st.count += 1;
      if (st.tm) clearTimeout(st.tm);
      st.tm = setTimeout(() => {
        const n = st.count;
        st.count = 0;
        st.tm = null;
        if (n === 1) {
          const k = sigBtn.getAttribute("data-studio-signal");
          if (k === "video" || k === "sys") {
            const devPanel = document.getElementById("studio-device-settings");
            const map = { video: "studio-menu-video", sys: "studio-menu-sys" };
            const scrollToId = map[k];
            if (
              scrollToId &&
              devPanel &&
              !devPanel.hidden &&
              captureStudio.classList.contains("capture-studio--device-settings-open") &&
              !pendingPreview &&
              !snipeArming &&
              (devPanel.dataset.openScrollTarget || "") !== scrollToId
            ) {
              const wrap = sigBtn.closest(".studio-deck__sig-wrap--with-settings");
              const opener = wrap?.querySelector(".studio-deck__device-settings-btn");
              openStudioDeviceSettingsPanel(scrollToId, opener || null);
            } else if (!pendingPreview && !snipeArming) {
              toggleHubInputSignal(k);
            }
          }
        } else if (n >= 2) {
          openStudioInputMenu(sigBtn);
        }
      }, 280);
      return;
    }
    const menuAct = t.closest("[data-studio-menu-action]");
    if (menuAct && captureStudio.contains(menuAct)) {
      e.preventDefault();
      e.stopPropagation();
      handleStudioMenuAction(menuAct.getAttribute("data-studio-menu-action"));
    }
  });

  captureStudio.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLSelectElement)) return;
    if (!t.classList.contains("js-studio-quality")) return;
    setQualityPreset(t.value);
    setStatus(
      t.value === "high"
        ? "Quality: high (larger files)."
        : t.value === "data"
          ? "Quality: smaller files."
          : "Quality: balanced."
    );
  });

  captureStudio.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.classList.contains("js-device-custom-name")) {
      const kind = t.getAttribute("data-custom-kind");
      const prefs = getDeviceDisplayPrefs();
      if (kind === "video") {
        prefs.customVideo = t.value.trim() || DEFAULT_CUSTOM_VIDEO;
      } else if (kind === "sys") {
        prefs.customSys = t.value.trim() || DEFAULT_CUSTOM_SYS;
      }
      persistDeviceDisplayPrefs(prefs);
      scheduleDeviceNamePersistAndRefresh();
      if (kind === "video") {
        const rv = document.getElementById("studio-real-name-video");
        if (rv) rv.textContent = getRealNameVideo();
      }
      if (kind === "sys") {
        const rs = document.getElementById("studio-real-name-sys");
        if (rs) rs.textContent = getRealNameSys();
      }
      return;
    }
    if (t.classList.contains("js-mic-custom-name")) {
      const id = t.getAttribute("data-device-id");
      if (!id) return;
      const prefs = getDeviceDisplayPrefs();
      prefs.customMics = { ...prefs.customMics, [id]: t.value };
      persistDeviceDisplayPrefs(prefs);
      scheduleDeviceNamePersistAndRefresh();
    }
  });

  document.addEventListener(
    "mousedown",
    (e) => {
      if (!studioCapture || captureStudio.classList.contains("hidden")) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("#studio-device-bar")) return;
      if (t.closest("#studio-device-settings")) return;
      /* Hub record / pause / metrics — must not dismiss device menus (mousedown fires before snipe click). */
      if (t.closest("#hub-control-bar")) return;
      /* Resize grip: first mousedown of a double-click must not close the menu — otherwise width restores and
         dblclick midpoint (min/max) runs with the wrong cur / open state. */
      if (t.closest(".capture-studio__resize")) return;
      closeStudioInputMenus();
    },
    true
  );

  studioOverlay.addEventListener("mousedown", onStudioOverlayDown);
  document.addEventListener("mousemove", onStudioOverlayMove);
  document.addEventListener("mouseup", onStudioOverlayUp);

  studioVideo.addEventListener("loadedmetadata", () => {
    syncStudioAspectFromCapture();
    updateStudioResizeHandleVisibility();
    if (studioRegionNorm && studioCapture) updateRegionVisualFromNorm();
  });

  window.addEventListener("resize", () => {
    clampStudioWidthToViewport();
    scheduleStudioFitForDeviceSettingsPanel();
    if (studioRegionNorm && studioCapture) updateRegionVisualFromNorm();
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      clampStudioWidthToViewport();
      scheduleStudioFitForDeviceSettingsPanel();
    });
  }

  function cancelStudioResizeRaf() {
    if (studioResizeRafId != null) {
      cancelAnimationFrame(studioResizeRafId);
      studioResizeRafId = null;
    }
  }

  function flushStudioResizePendingWidth(opts) {
    const skipShrink = opts && opts.skipShrink === true;
    if (studioResizePendingW != null) {
      captureStudio.style.width = `${studioResizePendingW}px`;
      studioResizePendingW = null;
    }
    syncScadaClusterStudioWide();
    if (!skipShrink) {
      shrinkStudioWidthUntilClusterFits();
    }
  }

  studioResizeHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    cancelStudioWidthAnimation();
    studioResizePtr = e.pointerId;
    studioResizeStartX = e.clientX;
    studioResizeStartY = e.clientY;
    studioResizeStartW = captureStudio.getBoundingClientRect().width;
    studioResizeHandle.classList.add("capture-studio__resize--dragging");
    try {
      studioResizeHandle.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  });
  studioResizeHandle.addEventListener("pointermove", (e) => {
    if (e.pointerId !== studioResizePtr) return;
    /* Bottom-right corner: horizontal and vertical drag both scale width; stage height follows --st-ar-* */
    const dw = e.clientX - studioResizeStartX + (e.clientY - studioResizeStartY);
    const cap = studioMaxW();
    const w = Math.round(Math.max(studioMinW(), Math.min(cap, studioResizeStartW + dw)));
    studioResizePendingW = w;
    if (studioResizeRafId != null) return;
    studioResizeRafId = requestAnimationFrame(() => {
      studioResizeRafId = null;
      flushStudioResizePendingWidth();
    });
  });
  function endStudioResize(e) {
    if (studioResizePtr == null || e.pointerId !== studioResizePtr) return;
    studioResizePtr = null;
    studioResizeHandle.classList.remove("capture-studio__resize--dragging");
    const dx = e.clientX - studioResizeStartX;
    const dy = e.clientY - studioResizeStartY;
    const noDrag =
      Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) < 2.5;
    cancelStudioResizeRaf();
    flushStudioResizePendingWidth({ skipShrink: noDrag });
    try {
      studioResizeHandle.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    try {
      localStorage.setItem(
        STUDIO_USER_W_KEY,
        String(Math.round(captureStudio.getBoundingClientRect().width))
      );
    } catch (_) {
      /* ignore */
    }
    /* Tap / first click of double-click must not run viewport fit or mark “user resized” — that changed width
       between clicks and broke min/max dblclick with the menu open. */
    if (!noDrag) {
      noteStudioUserControlledWidthChange();
      scheduleStudioFitForDeviceSettingsPanel();
    }
  }
  studioResizeHandle.addEventListener("pointerup", endStudioResize);
  studioResizeHandle.addEventListener("pointercancel", endStudioResize);

  studioResizeHandle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    noteStudioUserControlledWidthChange();
    const minW = studioMinW();
    let maxW = studioMaxW();
    const panel = document.getElementById("studio-device-settings");
    if (
      panel &&
      !panel.hidden &&
      captureStudio.classList.contains("capture-studio--device-settings-open")
    ) {
      maxW = computeMaxStudioWidthFittingViewport(maxW);
    }
    const cur = measureStudioInlineWidthPx();
    const eps = 6;
    let next;
    if (cur >= maxW - eps) {
      next = minW;
    } else if (cur <= minW + eps) {
      next = maxW;
    } else {
      const mid = (minW + maxW) / 2;
      next = cur <= mid ? maxW : minW;
    }
    animateStudioWidthTo(next);
  });

  /* Trackpad pinch (Ctrl+wheel): resize studio from anywhere on the page while preview is open */
  function onStudioPinchWheel(e) {
    if (!studioPinchEligible()) return;
    if (!e.ctrlKey) return;
    if (studioPinchIgnoreTarget(e.target, e)) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = getStudioWidthPxForPinch();
    const dy = studioPinchNormDelta(e.deltaY, e.deltaMode);
    const dx = studioPinchNormDelta(e.deltaX, e.deltaMode);
    const dm = e.deltaMode;
    let gain =
      dm === 1
        ? STUDIO_PINCH_WHEEL_GAIN_LINE
        : dm === 2
          ? STUDIO_PINCH_WHEEL_GAIN_PAGE
          : STUDIO_PINCH_WHEEL_GAIN_PIXEL;
    const dwRaw = -(dy + dx * 0.35) * gain;
    let dw = dwRaw;
    if (dm === 1) {
      const a = STUDIO_PINCH_WHEEL_LINE_SMOOTH;
      const prev = studioPinchLineDwSmooth;
      dw = prev === 0 ? dwRaw : dwRaw * (1 - a) + prev * a;
      studioPinchLineDwSmooth = dw;
      if (studioPinchLineSmoothResetTimer != null) clearTimeout(studioPinchLineSmoothResetTimer);
      studioPinchLineSmoothResetTimer = window.setTimeout(() => {
        studioPinchLineSmoothResetTimer = null;
        studioPinchLineDwSmooth = 0;
      }, 220);
    } else {
      studioPinchLineDwSmooth = 0;
      if (studioPinchLineSmoothResetTimer != null) {
        clearTimeout(studioPinchLineSmoothResetTimer);
        studioPinchLineSmoothResetTimer = null;
      }
    }
    applyStudioWidthFromPinch(cur + dw);
  }
  window.addEventListener("wheel", onStudioPinchWheel, { passive: false, capture: true });

  if (typeof GestureEvent !== "undefined") {
    captureStudio.addEventListener(
      "gesturestart",
      (e) => {
        if (!studioPinchEligible()) return;
        if (studioPinchIgnoreTarget(e.target, e)) return;
        e.preventDefault();
        studioWebkitPinchActive = true;
        studioWebkitPinchBaseW = getStudioWidthPxForPinch();
      },
      { passive: false }
    );
    captureStudio.addEventListener(
      "gesturechange",
      (e) => {
        if (!studioWebkitPinchActive) return;
        e.preventDefault();
        applyStudioWidthFromPinch(
          studioWebkitPinchBaseW * (1 + (e.scale - 1) * STUDIO_PINCH_GESTURE_BOOST)
        );
      },
      { passive: false }
    );
    captureStudio.addEventListener(
      "gestureend",
      (e) => {
        if (!studioWebkitPinchActive) return;
        studioWebkitPinchActive = false;
        e.preventDefault();
      },
      { passive: false }
    );
  }

  document.addEventListener("keydown", onStudioKeydown, true);

  function onTrimDragMove(e) {
    if (!trimDragKind || !pendingPreview) return;
    if (!isFinite(studioVideo.duration) || studioVideo.duration <= 0) return;
    e.preventDefault();
    const t = trimClientXToTime(e.clientX);
    const d = studioVideo.duration;
    if (trimDragKind === "in") {
      pendingPreview.trimIn = clamp(t, 0, pendingPreview.trimOut - MIN_TRIM_SEC);
    } else {
      pendingPreview.trimOut = clamp(t, pendingPreview.trimIn + MIN_TRIM_SEC, d);
    }
    syncTrimVisuals();
  }

  function onTrimDragEnd() {
    document.removeEventListener("pointermove", onTrimDragMove, true);
    document.removeEventListener("pointerup", onTrimDragEnd, true);
    document.removeEventListener("pointercancel", onTrimDragEnd, true);
    trimDragKind = null;
  }

  function onTrimPointerDown(e, kind) {
    if (!pendingPreview || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (trimDragKind) onTrimDragEnd();
    trimDragKind = kind;
    document.addEventListener("pointermove", onTrimDragMove, true);
    document.addEventListener("pointerup", onTrimDragEnd, true);
    document.addEventListener("pointercancel", onTrimDragEnd, true);
  }

  previewTrimIn.addEventListener("pointerdown", (e) => onTrimPointerDown(e, "in"));
  previewTrimOut.addEventListener("pointerdown", (e) => onTrimPointerDown(e, "out"));

  previewTrimTrack.addEventListener("pointerdown", (e) => {
    if (e.target === previewTrimIn || e.target === previewTrimOut) return;
    if (e.target.closest(".preview-trim__split")) return;
    if (!pendingPreview || !isFinite(studioVideo.duration) || studioVideo.duration <= 0) return;
    e.preventDefault();
    studioVideo.currentTime = trimClientXToTime(e.clientX);
  });

  previewTrimSplits.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(".preview-trim__split");
    if (!btn || !pendingPreview) return;
    e.preventDefault();
    e.stopPropagation();
    const t = parseFloat(btn.dataset.time, 10);
    const d = studioVideo.duration;
    if (!isFinite(t) || !isFinite(d) || d <= 0) return;
    const tt = clamp(t, 0, d);
    if (e.shiftKey) {
      pendingPreview.trimOut = clamp(tt, pendingPreview.trimIn + MIN_TRIM_SEC, d);
    } else if (e.metaKey || e.ctrlKey) {
      pendingPreview.trimIn = clamp(tt, 0, pendingPreview.trimOut - MIN_TRIM_SEC);
    } else {
      studioVideo.currentTime = tt;
    }
    syncTrimVisuals();
  });

  function onPreviewKeydown(e) {
    if (!pendingPreview || !captureStudio.classList.contains("capture-studio--review")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closePreview();
    }
  }

  previewDiscardBtn.addEventListener("click", () => closePreview());

  previewSaveBtn.addEventListener("click", async () => {
    if (!pendingPreview) return;
    const d = studioVideo.duration;
    const { trimIn, trimOut, blob, ext, defaultBase } = pendingPreview;
    previewSaveBtn.disabled = true;
    setStatus("Exporting…");
    try {
      let outBlob = blob;
      if (isFinite(d) && d > 0 && !isFullTrimRange(trimIn, trimOut, d)) {
        const trimmed = await exportTrimmedBlob(blob, trimIn, trimOut);
        if (trimmed && trimmed.size > 0) {
          outBlob = trimmed;
        } else {
          setStatus("Trim not supported — saving full length.");
        }
      }
      const name = safeDownloadFilename(previewFilename.value, defaultBase, ext);
      downloadBlob(outBlob, name);
      closePreview();
      setStatus(`Saved ${name}`);
      window.setTimeout(() => setStatus(""), 4000);
    } catch (err) {
      setStatus((err && err.message) || "Save failed.");
    } finally {
      previewSaveBtn.disabled = false;
    }
  });

  document.addEventListener("keydown", onPreviewKeydown, true);

  /* Hub physics: wheel injects velocity, page scroll blocked in zone; damped spring settles to true layout center. */
  (function initElasticHubScroll() {
    const wrapEl = document.querySelector("main.wrap");
    if (!wrapEl || !scadaCluster) return;

    const edgePad = 2;
    const wheelImpulse = 10.2;
    const touchGain = 1.45;
    const velCap = 5200;
    const pixelDeltaBoost = 1.72;
    const reduceMotion =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stiffness = reduceMotion ? 640 : 118;
    const damping = reduceMotion ? 66 : 17;
    /* Hard viewport clamp + small bounce; no rubber-band past screen edges. */
    const wallRestitution = reduceMotion ? 0.32 : 0.14;
    /** Fraction of hub translate applied to body::before grid (background-position), unless reduced motion. */
    const hubBgFollow = reduceMotion ? 0 : 0.1;

    let posX = 0;
    let posY = 0;
    let velX = 0;
    let velY = 0;
    let physRaf = null;
    let lastPhysT = 0;
    let touching = false;
    let touchId = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartPosX = 0;
    let touchStartPosY = 0;

    function blockedTarget(el) {
      if (!el || !(el instanceof Element)) return true;
      return Boolean(
        el.closest(
          "button, a, input, textarea, select, video, label, .preview-trim__track, .preview-trim__handle, .preview-trim__split, .studio-deck__sig--btn, .studio-deck__sig--hub, .studio-deck__device-settings-btn, .hub-record-cancel, .studio-deck__btn, .studio-deck__sig-menu, .capture-studio__overlay, .capture-studio__region, .capture-studio__resize, #studio-device-signals-scroll, .hub-input-row__signals, .record-panel__signals"
        )
      );
    }

    function wheelStealsScroll(el) {
      if (!el || !(el instanceof Element)) return false;
      if (el.closest("textarea, input, select, [contenteditable='true']")) return false;
      /* Horizontal device bars: let wheel reach them (map to scrollLeft) — do not steal for hub bounce. */
      const inputBar = el.closest(
        "#studio-device-signals-scroll, .hub-input-row__signals, .record-panel__signals"
      );
      if (inputBar && inputBar.scrollWidth > inputBar.clientWidth + 1) {
        return false;
      }
      /* Let nested scroll surfaces handle wheel; capture-phase hub listener runs before them otherwise. */
      if (
        el.closest(
          ".studio-deck__sig-menu, .studio-deck__sig-menu-inner, .preview-trim__track, .preview-trim__handle, .preview-trim__range"
        )
      ) {
        return false;
      }
      return true;
    }

    function hubTravelBounds() {
      const r = scadaCluster.getBoundingClientRect();
      const bl = r.left - posX;
      const br = r.right - posX;
      const bt = r.top - posY;
      const bb = r.bottom - posY;
      const iw = window.innerWidth;
      const ih = window.innerHeight;
      const p = edgePad;
      let minX = p - bl;
      let maxX = iw - br - p;
      let minY = p - bt;
      let maxY = ih - bb - p;
      if (minX > maxX) {
        const m = (minX + maxX) * 0.5;
        minX = maxX = m;
      }
      if (minY > maxY) {
        const m = (minY + maxY) * 0.5;
        minY = maxY = m;
      }
      return { minX, maxX, minY, maxY };
    }

    function clampPos(x, y) {
      const { minX, maxX, minY, maxY } = hubTravelBounds();
      return {
        x: Math.max(minX, Math.min(maxX, x)),
        y: Math.max(minY, Math.min(maxY, y)),
      };
    }

    function normWheelDelta(d, mode) {
      if (mode === 1) return d * 16;
      if (mode === 2) return d * Math.min(900, window.innerHeight * 0.85);
      return d * pixelDeltaBoost;
    }

    function applyTransform(x, y) {
      posX = x;
      posY = y;
      const root = document.documentElement;
      if (Math.abs(x) < 0.02 && Math.abs(y) < 0.02) {
        scadaCluster.style.transition = "";
        scadaCluster.style.transform = "";
        root.style.removeProperty("--hub-bump-x");
        root.style.removeProperty("--hub-bump-y");
      } else {
        scadaCluster.style.transition = "none";
        scadaCluster.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (hubBgFollow <= 0) {
          root.style.removeProperty("--hub-bump-x");
          root.style.removeProperty("--hub-bump-y");
        } else {
          root.style.setProperty("--hub-bump-x", `${(x * hubBgFollow).toFixed(2)}px`);
          root.style.setProperty("--hub-bump-y", `${(y * hubBgFollow).toFixed(2)}px`);
        }
      }
    }

    function snapToRest() {
      posX = 0;
      posY = 0;
      velX = 0;
      velY = 0;
      lastPhysT = 0;
      scadaCluster.style.transition = "";
      scadaCluster.style.transform = "";
      document.documentElement.style.removeProperty("--hub-bump-x");
      document.documentElement.style.removeProperty("--hub-bump-y");
    }

    function physicsStep(t) {
      physRaf = null;
      if (touching) {
        applyTransform(posX, posY);
        physRaf = requestAnimationFrame(physicsStep);
        return;
      }

      if (!lastPhysT) lastPhysT = t;
      let dt = (t - lastPhysT) / 1000;
      lastPhysT = t;
      if (dt > 0.055) dt = 0.055;
      if (dt <= 0) dt = 1 / 60;

      const b = hubTravelBounds();
      const { minX, maxX, minY, maxY } = b;

      let ax = -stiffness * posX - damping * velX;
      let ay = -stiffness * posY - damping * velY;

      velX += ax * dt;
      velY += ay * dt;
      posX += velX * dt;
      posY += velY * dt;
      if (posX > maxX) {
        posX = maxX;
        velX *= -wallRestitution;
      } else if (posX < minX) {
        posX = minX;
        velX *= -wallRestitution;
      }
      if (posY > maxY) {
        posY = maxY;
        velY *= -wallRestitution;
      } else if (posY < minY) {
        posY = minY;
        velY *= -wallRestitution;
      }

      const speed = Math.hypot(velX, velY);
      const dist = Math.hypot(posX, posY);
      if (dist < 0.55 && speed < 6) {
        snapToRest();
        return;
      }

      applyTransform(posX, posY);
      physRaf = requestAnimationFrame(physicsStep);
    }

    function kickPhysics() {
      if (physRaf == null) physRaf = requestAnimationFrame(physicsStep);
    }

    /* Capture on <main.wrap> so we run before <video> and other descendants eat wheel (bubble on window missed those). */
    wrapEl.addEventListener(
      "wheel",
      (e) => {
        if (!wheelStealsScroll(e.target)) return;
        if (e.ctrlKey && studioPinchEligible() && !studioPinchIgnoreTarget(e.target, e)) return;
        const dx = normWheelDelta(e.deltaX, e.deltaMode);
        const dy = normWheelDelta(e.deltaY, e.deltaMode);
        if (dx === 0 && dy === 0) return;

        e.preventDefault();
        e.stopPropagation();

        velX += -dx * wheelImpulse;
        velY += -dy * wheelImpulse;
        const sp = Math.hypot(velX, velY);
        if (sp > velCap) {
          const s = velCap / sp;
          velX *= s;
          velY *= s;
        }

        kickPhysics();
      },
      { passive: false, capture: true }
    );

    wrapEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" || e.isPrimary === false) return;
      if (blockedTarget(e.target)) return;
      touching = true;
      velX = 0;
      velY = 0;
      touchId = e.pointerId;
      touchStartX = e.clientX;
      touchStartY = e.clientY;
      touchStartPosX = posX;
      touchStartPosY = posY;
      try {
        wrapEl.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      kickPhysics();
    });

    wrapEl.addEventListener("pointermove", (e) => {
      if (e.pointerId !== touchId) return;
      const ndx = e.clientX - touchStartX;
      const ndy = e.clientY - touchStartY;
      const c = clampPos(
        touchStartPosX + ndx * touchGain,
        touchStartPosY + ndy * touchGain
      );
      posX = c.x;
      posY = c.y;
      applyTransform(posX, posY);
    });

    wrapEl.addEventListener("pointerup", endTouch);
    wrapEl.addEventListener("pointercancel", endTouch);

    function endTouch(e) {
      if (e.pointerId !== touchId) return;
      touchId = null;
      touching = false;
      try {
        wrapEl.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
      lastPhysT = 0;
      kickPhysics();
    }
  })();

  installInputBarWheelToHorizontalScroll();
  resetInputBarsScrollLeft();
  syncDeviceUiScale();
  void refreshMicDeviceList().then(() => {
    closeStudioUiOnly();
    applyIdleInputIndicators();
  });
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", scheduleMicDeviceListRefresh);
  }

  const hubSigClickTimers = new WeakMap();
  hubInputRow.addEventListener("click", (e) => {
    if (pendingPreview || snipeArming) return;
    const btn = e.target.closest(".studio-deck__sig--hub");
    if (!btn || !hubInputRow.contains(btn)) return;
    let st = hubSigClickTimers.get(btn);
    if (!st) {
      st = { count: 0, tm: null };
      hubSigClickTimers.set(btn, st);
    }
    st.count += 1;
    if (st.tm) clearTimeout(st.tm);
    st.tm = setTimeout(() => {
      const n = st.count;
      st.count = 0;
      st.tm = null;
      const micDev = btn.getAttribute("data-mic-device-id");
      if (micDev) {
        if (n === 1) toggleMicDevice(micDev);
        else         if (n >= 2) {
          if (recordSession) {
            openStudioMicMenu();
          } else {
            openStudioForHubSettings("mic");
          }
        }
        return;
      }
      const sig = btn.getAttribute("data-signal");
      if (!sig) return;
      if (n === 1) toggleHubInputSignal(sig);
      else if (n >= 2) {
        if (recordSession) {
          const map = { video: "studio-sig-video", sys: "studio-sig-sys" };
          const bid = map[sig];
          const sb = bid ? document.getElementById(bid) : null;
          if (sb) openStudioInputMenu(sb);
        } else {
          openStudioForHubSettings(sig);
        }
      }
    }, 280);
  });

  if (hubRecordCancel) {
    hubRecordCancel.addEventListener("click", () => {
      if (!recordSession) return;
      discardRecordingSession();
    });
  }

  if (hubRecordSave) {
    hubRecordSave.addEventListener("click", () => {
      if (!recordSession?.recorder) return;
      const st = recordSession.recorder.state;
      if (st !== "paused" && st !== "recording") return;
      finalizeRecordingSession();
    });
  }

  snipeBtn.addEventListener("click", () => {
    if (recordSession) {
      toggleRecordingPause();
      return;
    }
    if (studioCapture && !recordSession && !pendingPreview && !snipeArming) {
      beginRecordingFromStudio();
      return;
    }
    startSnipe();
  });
  recordStopBtn.addEventListener("click", stopRecordingFromPanel);
})();
