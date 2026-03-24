try { if (document.body) document.body.classList.add('loaded'); } catch (_) {}
(function(){
  try {
    if (localStorage.getItem('inout_was_editing_v1')) {
      localStorage.setItem('inout_input_state_v2', '');
      localStorage.removeItem('inout_was_editing_v1');
      var el = document.getElementById('object-input');
      if (el) { el.value = ''; el.placeholder = 'Add object…'; }
    }
  } catch (_) {}
})();
if (document.body) document.body.classList.add('loaded');
/* INOUT – shared state, Supabase client, DOM refs (load first) */
const SUPABASE_URL  = 'https://tfmbqiwxfgrwtjvoqomf.supabase.co';
const SUPABASE_ANON = 'sb_publishable_QzPgZBu5XwFXmnvD-DYCRw_EWFuhLn_';
var sb = null;
try {
  if (typeof window !== 'undefined') {
    sb = window.sb || window._sb || null;
    if (sb) window.sb = sb;
  }
  if (!sb && typeof supabase !== 'undefined') {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: {
        detectSessionInUrl: true,
        flowType: 'pkce',
        persistSession: false,
        autoRefreshToken: false,
      },
      realtime: { params: { eventsPerSecond: 100 } },
    });
    if (typeof window !== 'undefined') window.sb = sb;
  }
} catch(e) {}

/* Declared before any setup IIFE that may call notifyWorkspaceChromeChanged → schedulePersonalWorkspacePersist */
let currentUser = null;

/* Run OAuth callback (code exchange) as soon as client exists so URL is still intact */
var _oauthCallbackPromise = null;
if (sb && sb.auth && typeof location !== 'undefined' && location.search && location.search.includes('code=')) {
  (function runCodeExchange() {
    var params = new URLSearchParams(location.search);
    var code = params.get('code');
    if (!code || typeof sb.auth.exchangeCodeForSession !== 'function') return;
    _oauthCallbackPromise = sb.auth.exchangeCodeForSession(code).then(function(result) {
      if (result && result.data && result.data.session) {
        try { history.replaceState(null, '', location.pathname || '/'); } catch (_) {}
      }
      return result;
    }).catch(function(e) {
      console.error('OAuth code exchange failed', e);
      return null;
  });
})();
}

// Optional visit / temp-session info encoded in QR URL: ?tempSession=<id>&visitNick=<nickname>
let visitInviteNick = null;
let tempSessionId = null;
try {
  if (typeof location !== 'undefined' && location.search) {
    const params = new URLSearchParams(location.search);
    const ts = params.get('tempSession');
    if (ts) tempSessionId = ts;
    const vn = params.get('visitNick');
    if (vn && !ts) visitInviteNick = decodeURIComponent(vn);
  }
} catch (_) {}
const STRIPE_PUBLISHABLE_KEY = 'pk_live_xxx_replace_me';
const STRIPE_PRICE_ID        = 'price_xxx_replace_me';
let stripe = null;
if (window.Stripe && STRIPE_PUBLISHABLE_KEY && !STRIPE_PUBLISHABLE_KEY.includes('replace_me')) {
  stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
}

(function setupVisualViewportPinning() {
  const vv = window.visualViewport;
  if (!vv) return;
  let raf = 0;
  let currentTop = 0;
  let currentHeight = 0;
  let pendingTop = 0;
  let pendingHeight = 0;
  const read = () => {
    pendingTop = Math.max(0, Math.round((typeof vv.offsetTop === 'number') ? vv.offsetTop : 0));
    pendingHeight = Math.max(100, Math.round((typeof vv.height === 'number') ? vv.height : window.innerHeight));
  };
  const apply = () => {
    raf = 0;
    if (Math.abs(pendingTop - currentTop) < 2 && Math.abs(pendingHeight - currentHeight) < 2) return;
    currentTop = pendingTop;
    currentHeight = pendingHeight;
    document.documentElement.style.setProperty('--vv-top', currentTop + 'px');
    document.documentElement.style.setProperty('--vv-height', currentHeight + 'px');
  };
  const schedule = () => { read(); if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  schedule();
})();

(function setupMobileInputScrollIntoView() {
  const vv = window.visualViewport;
  const inputArea = document.getElementById('input-area');
  if (!vv || !inputArea) return;
  let lastHeight = vv.height;
  const onResize = () => {
    if (window.innerWidth > 540) return;
    const shrank = vv.height < lastHeight;
    lastHeight = vv.height;
    if (!shrank) return;
    const active = document.activeElement;
    if (!active || !inputArea.contains(active)) return;
    requestAnimationFrame(() => {
      inputArea.scrollIntoView({ block: 'end', behavior: 'smooth' });
    });
  };
  vv.addEventListener('resize', onResize);
})();

const feedInner  = document.getElementById('feed-inner');
const feedEl     = document.getElementById('feed');
/**
 * Scroll surface for a feed node: primary layout uses .visual-feed-stack as the scrollport
 * (#feed is content-only). Split panes use .visual > .feed with no stack — that element scrolls.
 */
function getFeedScrollSurface(feed) {
  if (!feed || typeof feed.closest !== 'function') return feed;
  var stack = feed.closest('.visual-feed-stack');
  if (!stack) return feed;
  try {
    if (typeof getComputedStyle !== 'undefined') {
      var oy = getComputedStyle(stack).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return stack;
    }
  } catch (_) {}
  return stack;
}
function primaryFeedScrollSurface() {
  return feedEl ? getFeedScrollSurface(feedEl) : null;
}

/** Scroll surface for the feed that contains `node` (for wheel routing from chrome / value strips). */
function getFeedScrollSurfaceForElement(node) {
  if (!node || typeof node.closest !== 'function') return primaryFeedScrollSurface();
  var view = node.closest('#multiview .view');
  if (!view) return primaryFeedScrollSurface();
  var feed = view.querySelector('#feed') || view.querySelector('.feed');
  if (!feed) return primaryFeedScrollSurface();
  return getFeedScrollSurface(feed);
}

var inoutLastWheelAt = 0;
var INOUT_WHEEL_INTERACTION_GAP_MS = 180;


function routeWheelDeltaToPrimaryView(deltaY) {
  var surf = primaryFeedScrollSurface();
  if (!surf) return false;
  var max = surf.scrollHeight - surf.clientHeight;
  if (!(max > 1)) return false;
  var prev = surf.scrollTop || 0;
  var next = Math.max(0, Math.min(max, prev + (Number(deltaY) || 0)));
  if (Math.abs(next - prev) < 0.01) return false;
  surf.scrollTop = next;
  return true;
}

const inputArea  = document.getElementById('input-area');
var input       = document.getElementById('object-input');
var sendBtn     = document.getElementById('send-btn');
var clearInputBtn = document.getElementById('clear-input');
const composerSlotsContainer = document.getElementById('composer-slots-container');
const emptyEl    = document.getElementById('empty');
try {
  if (emptyEl) {
    var loader = emptyEl.querySelector('.loader-inner');
    if (loader) {
      for (var i = emptyEl.childNodes.length - 1; i >= 0; i--) {
        if (emptyEl.childNodes[i] !== loader) emptyEl.removeChild(emptyEl.childNodes[i]);
      }
    }
  }
} catch (_) {}
const scrollBtn  = document.getElementById('scroll-btn');
const ocNum      = document.getElementById('oc-num');
const objectCountEl = document.getElementById('object-count');
const toastEl    = document.getElementById('toast');
const userBtn    = document.getElementById('user-btn');
const umBackdrop = document.getElementById('user-modal-backdrop');
const umClose    = document.getElementById('user-close');
const umAuthStatus = document.getElementById('um-auth-status');
  const umAuthBtn    = document.getElementById('um-auth-btn');
  const umStorageInfo = document.getElementById('um-storage-info');
  const umUserId     = document.getElementById('um-user-id');
const umCopyIdBtn  = document.getElementById('um-copy-id');
const umShowQrBtn  = document.getElementById('um-show-qr');
const umExportLocalBtn = document.getElementById('um-export-local');
const umClearLocalBtn  = document.getElementById('um-clear-local');
const umGuestNotifStatus = document.getElementById('um-guest-notif-status');
const umEnableGuestNotifBtn = document.getElementById('um-enable-guest-notif');
const qrModalBackdrop = document.getElementById('qr-modal-backdrop');
const qrModalImg   = document.getElementById('qr-modal-img');
const qrModalClose = document.getElementById('qr-modal-close');
const umNickname   = document.getElementById('um-nickname');
const umNickSave   = document.getElementById('um-nick-save');
const umLayoutEditBtn = document.getElementById('um-layout-edit');
const secretControlsBackdrop = document.getElementById('secret-controls-backdrop');
const secretControlsCloseBtn = document.getElementById('secret-controls-close');
const secretTogglePinnedRail = document.getElementById('secret-toggle-pinned-rail');
const secretToggleGrips = document.getElementById('secret-toggle-grips');
const secretToggleLayout = document.getElementById('secret-toggle-layout');
const secretToggleCursorFx = document.getElementById('secret-toggle-cursor-fx');
const secretControlsResetBtn = document.getElementById('secret-controls-reset');
const umSyncInputChk = document.getElementById('um-sync-input');
const umLayoutSyncChk = document.getElementById('um-layout-sync');
const umVersionBadge = document.getElementById('um-version-badge');
const umUpgradeBtn   = document.getElementById('um-upgrade-btn');
const tabsEl     = document.getElementById('tabs');
const clipboardBubble    = document.getElementById('clipboard-bubble');
const clipboardBubbleTxt = document.getElementById('clipboard-bubble-text');
const clipboardBubbleDeviceEl = document.getElementById('clipboard-bubble-device');
const clipboardPasteBtn  = document.getElementById('clipboard-paste');
const clipboardDismissBtn= document.getElementById('clipboard-dismiss');
const clipboardButton    = document.getElementById('clipboard-button');
const selectToggle = document.getElementById('select-toggle');
const selectExtra  = document.getElementById('select-extra');
const selectAllBtn = document.getElementById('select-all');
const selectNoneBtn = document.getElementById('select-none');
const manageActions = document.getElementById('manage-actions');
const deleteSelectedBtn = document.getElementById('delete-selected');
const moveSelectedBtn = document.getElementById('move-selected');
const moveTargetSelect = document.getElementById('move-target');
const exportTabBtn   = document.getElementById('export-tab');
const exportJsonTabBtn = document.getElementById('export-json-tab');
const importTextTabBtn = document.getElementById('import-text-tab');
const importTextFileInput = document.getElementById('import-text-file-input');
const addMembersBtn  = document.getElementById('add-members-btn');
const addMembersBackdrop = document.getElementById('add-members-modal-backdrop');
const addMembersChannelEl = document.getElementById('add-members-channel');
const addMembersIdsInput = document.getElementById('add-members-ids');
const addMembersCancelBtn = document.getElementById('add-members-cancel');
const addMembersSaveBtn = document.getElementById('add-members-save');
const fieldTimeChk   = document.getElementById('field-time');
const fieldAuthorChk = document.getElementById('field-author');
const fieldLabelsChk = document.getElementById('field-labels');
const viewToggleBtn  = document.getElementById('view-toggle');
const viewMenu       = document.getElementById('view-menu');
const draftBubble    = document.getElementById('draft-bubble');
const draftBubbleTxt = document.getElementById('draft-bubble-text');
const draftCopyBtn   = document.getElementById('draft-copy');
const draftSendBtn   = document.getElementById('draft-send');
const draftClearBtn  = document.getElementById('draft-clear');
const cmBackdrop = document.getElementById('channel-modal-backdrop');
const cmName     = document.getElementById('cm-name');
const cmSelf     = document.getElementById('cm-self');
const cmOthers   = document.getElementById('cm-others');
const cmCancel   = document.getElementById('cm-cancel');
const cmCreate   = document.getElementById('cm-create');
const logActionBtn   = document.getElementById('log-action-btn');
const logDropupPanel = document.getElementById('log-dropup-panel');
const logDropupBody  = document.getElementById('log-dropup-body');

function isUserModalBackdropOpen() {
  try {
    if (!umBackdrop) return false;
    var d = umBackdrop.style.display;
    return d === 'flex' || d === 'block';
  } catch (_) {
    return false;
  }
}
function showUserModalBackdrop() {
  if (!umBackdrop) return;
  umBackdrop.style.display = 'flex';
  umBackdrop.setAttribute('aria-hidden', 'false');
}
function hideUserModalBackdrop() {
  if (!umBackdrop) return;
  umBackdrop.style.display = 'none';
  umBackdrop.setAttribute('aria-hidden', 'true');
}

// Global interaction modes (kept separate from views/objects).
const Modes = {
  NORMAL: 'normal',
  SELECT: 'select',
  EDIT: 'edit',
  REORDER: 'reorder',
  REALTIME_INSPECT: 'realtime-inspect',
};
let currentMode = Modes.NORMAL;
const modeState = {
  selectedIds: new Set(),      // union of selected objects across all views
  editing: { active: false, primaryId: null, ids: null },
  reorderActive: false,
  realtimeInspectTarget: null, // object id or view name being inspected
};

// View registry: all open views on this device.
// Each entry: { id, channel (View name), rootEl, feedInner, objects, config }
let views = [];

const SECRET_TOGGLES_KEY = 'inout_secret_toggles_v1';
let secretToggles = {
  showPinnedRail: false,
  showGrips: false,
  enableLayoutEdit: false,
  enableCursorFx: false,
};

function loadSecretToggles() {
  try {
    const raw = localStorage.getItem(SECRET_TOGGLES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    secretToggles.showPinnedRail = !!parsed.showPinnedRail;
    secretToggles.showGrips = !!parsed.showGrips;
    secretToggles.enableLayoutEdit = !!parsed.enableLayoutEdit;
    secretToggles.enableCursorFx = !!parsed.enableCursorFx;
  } catch (_) {}
}

function saveSecretToggles() {
  try { localStorage.setItem(SECRET_TOGGLES_KEY, JSON.stringify(secretToggles)); } catch (_) {}
}

function applySecretToggles() {
  if (document.body) {
    document.body.classList.toggle('secret-show-pinned-rail', !!secretToggles.showPinnedRail);
    document.body.classList.toggle('secret-show-grips', !!secretToggles.showGrips);
  }
  if (typeof setWindowsRevealEffectsEnabled === 'function') {
    setWindowsRevealEffectsEnabled(!!secretToggles.enableCursorFx);
  }
  if (umLayoutEditBtn) {
    umLayoutEditBtn.disabled = !secretToggles.enableLayoutEdit;
    if (secretToggles.enableLayoutEdit) {
      umLayoutEditBtn.removeAttribute('title');
      umLayoutEditBtn.textContent = 'Layout edit';
    } else {
      umLayoutEditBtn.setAttribute('title', 'Layout editing is temporarily disabled');
      umLayoutEditBtn.textContent = 'Layout edit (coming soon)';
    }
  }
}

function openSecretControls() {
  if (!secretControlsBackdrop) return;
  if (secretTogglePinnedRail) secretTogglePinnedRail.checked = !!secretToggles.showPinnedRail;
  if (secretToggleGrips) secretToggleGrips.checked = !!secretToggles.showGrips;
  if (secretToggleLayout) secretToggleLayout.checked = !!secretToggles.enableLayoutEdit;
  if (secretToggleCursorFx) secretToggleCursorFx.checked = !!secretToggles.enableCursorFx;
  secretControlsBackdrop.setAttribute('aria-hidden', 'false');
  if (typeof INOUT_FOLDER_SYNC !== 'undefined' && INOUT_FOLDER_SYNC.refreshStatus) {
    INOUT_FOLDER_SYNC.refreshStatus();
  }
  notifyWorkspaceChromeChanged();
}

function closeSecretControls() {
  if (!secretControlsBackdrop) return;
  secretControlsBackdrop.setAttribute('aria-hidden', 'true');
  notifyWorkspaceChromeChanged();
}

(function ensureModalsClosedOnLoad() {
  hideUserModalBackdrop();
  if (cmBackdrop) cmBackdrop.style.display = 'none';
  if (addMembersBackdrop) addMembersBackdrop.style.display = 'none';
  if (logDropupPanel) logDropupPanel.classList.remove('open');
  if (qrModalBackdrop) qrModalBackdrop.setAttribute('aria-hidden', 'true');
  if (secretControlsBackdrop) secretControlsBackdrop.setAttribute('aria-hidden', 'true');
})();

(function setupSecretControls() {
  loadSecretToggles();
  applySecretToggles();
  if (secretTogglePinnedRail) {
    secretTogglePinnedRail.addEventListener('change', function() {
      secretToggles.showPinnedRail = !!secretTogglePinnedRail.checked;
      saveSecretToggles();
      applySecretToggles();
    });
  }
  if (secretToggleGrips) {
    secretToggleGrips.addEventListener('change', function() {
      secretToggles.showGrips = !!secretToggleGrips.checked;
      saveSecretToggles();
      applySecretToggles();
    });
  }
  if (secretToggleLayout) {
    secretToggleLayout.addEventListener('change', function() {
      secretToggles.enableLayoutEdit = !!secretToggleLayout.checked;
      saveSecretToggles();
      applySecretToggles();
    });
  }
  if (secretToggleCursorFx) {
    secretToggleCursorFx.addEventListener('change', function() {
      secretToggles.enableCursorFx = !!secretToggleCursorFx.checked;
      saveSecretToggles();
      applySecretToggles();
    });
  }
  if (secretControlsCloseBtn) secretControlsCloseBtn.addEventListener('click', closeSecretControls);
  if (secretControlsBackdrop) {
    secretControlsBackdrop.addEventListener('click', function(e) {
      if (e.target === secretControlsBackdrop) closeSecretControls();
    });
  }
  if (secretControlsResetBtn) {
    secretControlsResetBtn.addEventListener('click', function() {
      secretToggles = { showPinnedRail: false, showGrips: false, enableLayoutEdit: false, enableCursorFx: false };
      saveSecretToggles();
      applySecretToggles();
      if (secretTogglePinnedRail) secretTogglePinnedRail.checked = false;
      if (secretToggleGrips) secretToggleGrips.checked = false;
      if (secretToggleLayout) secretToggleLayout.checked = false;
      if (secretToggleCursorFx) secretToggleCursorFx.checked = false;
      if (typeof toast === 'function') toast('Secret toggles reset.');
    });
  }

  // Hidden open gestures:
  // 1) Click logo 5 times within ~2.2s
  const logoEl = document.querySelector('.logo');
  let logoTapCount = 0;
  let logoTapTimer = null;
  if (logoEl) {
    logoEl.addEventListener('click', function() {
      logoTapCount += 1;
      if (logoTapTimer) clearTimeout(logoTapTimer);
      if (logoTapCount >= 5) {
        logoTapCount = 0;
        openSecretControls();
        return;
      }
      logoTapTimer = setTimeout(function() { logoTapCount = 0; logoTapTimer = null; }, 2200);
    });
  }
  // 2) Keyboard shortcut Ctrl/Cmd + Alt + Shift + .
  document.addEventListener('keydown', function(e) {
    const isDot = e.key === '.' || e.code === 'Period';
    if (!isDot) return;
    if (!(e.altKey && e.shiftKey && (e.ctrlKey || e.metaKey))) return;
    e.preventDefault();
    openSecretControls();
  });
})();

(function registerServiceWorker() {
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js').catch(() => {});
      });
    }
  } catch (_) {}
})();

function subscribeTempSessionJoins() {
  if (!sb || !currentUser || !sb.channel) return;
  try {
    sb
      .channel('temp-session-joins')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'temp_session_events' },
        async (payload) => {
          try {
            const tempId = payload.new && payload.new.temp_session_id;
            if (!tempId || !sb.from) return;
            let ch = null;
            const { data, error } = await sb
              .from('temp_sessions')
              .select('channel, owner_id')
              .eq('id', tempId)
              .maybeSingle();
            if (!data || data.owner_id !== currentUser.id) return;
            if (data && (data.channel === '' || data.channel)) ch = data.channel;
            if (!ch) ch = 'visit-' + String(tempId).slice(0, 8);
            if (!ch) ch = 'main';
            if (qrModalBackdrop) qrModalBackdrop.setAttribute('aria-hidden', 'true');
            if (!viewNames.includes(ch)) {
              viewNames.push(ch);
              saveChannelsList();
            }
            currentView = ch;
            currentChannel = ch;
            renderTabs();
            // Ensure inviter has persistent membership in this shared View.
            ensureMembership().catch(function() {});
            await loadObjects();
            toast('Guest joined your view ' + currentView + '.');
          } catch (e) {
            console.error(e);
          }
        }
      )
      .subscribe();
  } catch (_) {}
}

(function setupLocalDataButtons() {
  if (umExportLocalBtn) {
    umExportLocalBtn.addEventListener('click', () => {
      (async function () {
        try {
          let raw = '{}';
          if (usesIndexedDbForObjectData()) {
            const store = getActiveLocalStore();
            if (store && store.init && store.exportJsonString) {
              await store.init();
              raw = await store.exportJsonString();
            }
          } else if (currentUser && currentUser.id) {
            const key = getLocalObjectsKey();
            raw = localStorage.getItem(key) || '{}';
          } else if (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.init && INOUT_LOCAL_DB.exportJsonString) {
            await INOUT_LOCAL_DB.init();
            raw = await INOUT_LOCAL_DB.exportJsonString();
          } else {
            const key = getLocalObjectsKey();
            raw = localStorage.getItem(key) || '{}';
          }
          const blob = new Blob([raw], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'inout-local-base.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {
          console.error(e);
          toast('Failed to export local base.');
        }
      })();
    });
  }

  if (umClearLocalBtn) {
    umClearLocalBtn.addEventListener('click', () => {
      (async function () {
        try {
          // 1) Unregister all service workers for this origin (remove shell)
          if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            navigator.serviceWorker.getRegistrations().then(regs => {
              regs.forEach(reg => reg.unregister().catch(() => {}));
            }).catch(() => {});
          }

          // 2) Clear all caches used by service workers
          if (typeof caches !== 'undefined' && caches.keys) {
            caches.keys().then(keys => {
              keys.forEach(k => caches.delete(k).catch(() => {}));
            }).catch(() => {});
          }

          // 3) Device object databases (IndexedDB) — all named vaults
          if (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.forVault) {
            const reg = readVaultRegistry();
            const seen = new Set();
            (reg.vaults || []).forEach(v => {
              if (!v || !v.id || seen.has(v.id)) return;
              seen.add(v.id);
            });
            seen.add('default');
            for (const vid of seen) {
              try {
                await INOUT_LOCAL_DB.forVault(vid).deleteDatabase();
              } catch (_) {}
            }
          } else if (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.deleteDatabase) {
            try { await INOUT_LOCAL_DB.deleteDatabase(); } catch (_) {}
          }

          // 4) Clear all local/session storage for this origin
          try { localStorage.clear(); } catch (_) {}
          try { sessionStorage.clear(); } catch (_) {}

          // 5) Clear current UI
          clearObjects();
          if (emptyEl && !emptyEl.parentNode && feedInner) feedInner.appendChild(emptyEl);
          toast('All local data and shell cleared. Reloading…');

          // 6) Reload page to pick up a clean state
          setTimeout(() => {
            if (typeof location !== 'undefined' && location.reload) location.reload();
          }, 600);
        } catch (e) {
          console.error(e);
          toast('Failed to clear local data.');
        }
      })();
    });
  }
})();

(function setupGuestNotificationUI() {
  if (!umEnableGuestNotifBtn) return;
  umEnableGuestNotifBtn.addEventListener('click', function() {
    try {
      if (typeof Notification === 'undefined') {
        toast('Notifications not supported in this browser.');
        if (umGuestNotifStatus) umGuestNotifStatus.textContent = 'Not supported';
        return;
      }
      Notification.requestPermission().then(function(p) {
        if (umGuestNotifStatus) umGuestNotifStatus.textContent = 'Notification permission: ' + p;
        if (p === 'granted') toast('Guest chat notifications enabled.');
        else toast('Notifications not enabled.');
      }).catch(function() {
        toast('Could not request notification permission.');
      });
    } catch (_) {}
  });
})();



(function setupQrModal() {
  if (!qrModalBackdrop || !qrModalImg) return;

  let pollIntervalId = null;
  let lastCreatedTempSessionId = null;

  function stopPolling() {
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    lastCreatedTempSessionId = null;
  }

  async function onGuestJoined(ch) {
    stopPolling();
    if (!ch) return;

    // Tag owner's existing objects in this shared View with the temp session id,
    // so the anonymous guest (who only has temp_session_id) can read them via RLS.
    try {
      if (sb && sb.from && lastCreatedTempSessionId && currentUser) {
        await sb
          .from(OBJECTS_TABLE)
          .update({ temp_session_id: lastCreatedTempSessionId })
          .eq('channel', ch)
          .eq('user_id', currentUser.id)
          .is('temp_session_id', null);
      }
    } catch (e) {
      console.error('Failed to tag shared objects with temp_session_id', e);
    }

    if (!viewNames.includes(ch)) {
      viewNames.push(ch);
      if (typeof saveChannelsList === 'function') saveChannelsList();
    }
    // Persist membership so shared View survives refresh.
    if (typeof ensureMembership === 'function') {
      try { await ensureMembership(); } catch (_) {}
    }
    currentView = ch;
    currentChannel = ch;
    if (typeof renderTabs === 'function') renderTabs();
    if (typeof loadObjects === 'function') loadObjects().catch(function() {});
  }

  if (umShowQrBtn) {
    umShowQrBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (!currentUser || !sb || !sb.from) {
          toast('Sign in to share a visit link.');
          return;
        }
        stopPolling();
        const base = (typeof window !== 'undefined' && window.location)
          ? (window.location.origin + window.location.pathname)
          : '';

        // Share the current View so owner and guest see the same view name in nav.
        const sharedChannel = currentChannel || currentView || 'main';

        const { data, error } = await sb
          .from('temp_sessions')
          .insert({
            channel: sharedChannel,
            owner_id: currentUser.id,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          })
          .select('id')
          .single();

        if (error || !data) {
          console.error(error);
          toast('Failed to create visit link.');
          return;
        }

        lastCreatedTempSessionId = data.id;

        // Ensure this view is in owner's nav (usually already is).
        if (!viewNames.includes(sharedChannel)) {
          viewNames.push(sharedChannel);
          if (typeof saveChannelsList === 'function') saveChannelsList();
          if (typeof renderTabs === 'function') renderTabs();
        }
        if (typeof ensureMembership === 'function') {
          try { await ensureMembership(); } catch (_) {}
        }

        pollIntervalId = setInterval(async () => {
          const id = lastCreatedTempSessionId;
          if (!id || !sb || !currentUser) return;
          try {
            const { data: row, error: err } = await sb
              .from('temp_sessions')
              .select('channel')
              .eq('id', id)
              .eq('owner_id', currentUser.id)
              .maybeSingle();
            if (err || !row) return;
            const ch = row.channel && String(row.channel).trim();
            if (!ch) return;
            onGuestJoined(ch);
          } catch (_) {}
        }, 2000);

        const inviteUrl = base
          ? (base + (base.includes('?') ? '&' : '?') + 'tempSession=' + encodeURIComponent(data.id))
          : ('?tempSession=' + encodeURIComponent(data.id));
        const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=220x220&color=FFFFFF&bgcolor=000000&data=' + encodeURIComponent(inviteUrl);
        qrModalImg.src = qrUrl;
        qrModalBackdrop.setAttribute('aria-hidden', 'false');
        if (typeof notifyWorkspaceChromeChanged === 'function') notifyWorkspaceChromeChanged();
      } catch (err) {
        console.error(err);
        toast('Failed to create visit QR.');
      }
    });
  }

  const closeQrModal = () => {
    stopPolling();
    qrModalBackdrop.setAttribute('aria-hidden', 'true');
    if (typeof notifyWorkspaceChromeChanged === 'function') notifyWorkspaceChromeChanged();
  };
  if (qrModalClose) {
    qrModalClose.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeQrModal();
    });
  }
  const inner = document.getElementById('qr-modal');
  if (inner) {
    inner.addEventListener('click', (e) => {
      // clicks inside modal content should not close it
      e.stopPropagation();
    });
  }
  qrModalBackdrop.addEventListener('click', e => {
    if (e.target === qrModalBackdrop) closeQrModal();
  });
})();

(function setupProfileAndModalsEarly() {
  function closeUserModalEarly() {
    if (typeof closeUserModal === 'function') closeUserModal();
    else hideUserModalBackdrop();
  }
  var closeBtn = document.getElementById('user-close');
  if (closeBtn) closeBtn.addEventListener('click', closeUserModalEarly);
  var back = document.getElementById('user-modal-backdrop');
  if (back) back.addEventListener('click', function(e) { if (e.target === back) closeUserModalEarly(); });
})();

// Supabase table name for stored objects (was 'entries').
const OBJECTS_TABLE        = 'entries';
/** Stored in `entries.text`: plain string = one value; multi = prefix + JSON array of strings, or `{ v, l }` with per-column labels. */
const INOUT_MULTI_VALUE_PREFIX = '__INOUT_VALUES_JSON__\n';
var INOUT_VALUE_COL_LABEL_MAX = 72;

function defaultValueColumnHeaderLabel(index) {
  if (index === 0) return 'Value';
  return 'Value ' + (index + 1);
}

var lastKnownEntryTextById = new Map();

function entryTextCacheKey(channel, id) {
  return String(channel != null && String(channel).trim() !== '' ? channel : 'main') + ':' + String(id);
}

/** Fallback id-only key so label sync still resolves text when a row channel key differs from remember-time key. */
function entryTextCacheKeyIdOnly(id) {
  return 'id:' + String(id);
}

function rememberEntryText(channel, id, text) {
  if (id == null || !Number.isFinite(Number(id))) return;
  var t = String(text != null ? text : '');
  lastKnownEntryTextById.set(entryTextCacheKey(channel, id), t);
  lastKnownEntryTextById.set(entryTextCacheKeyIdOnly(id), t);
}

function getLastKnownEntryTextForChannel(channel, id) {
  if (id == null || !Number.isFinite(Number(id))) return null;
  var v = lastKnownEntryTextById.get(entryTextCacheKey(channel, id));
  if (v != null) return v;
  var v2 = lastKnownEntryTextById.get(entryTextCacheKeyIdOnly(id));
  return v2 != null ? v2 : null;
}

function parseObjectTextPayload(raw) {
  var s = raw == null ? '' : String(raw);
  if (s.indexOf(INOUT_MULTI_VALUE_PREFIX) !== 0) {
    return { parts: [s], labels: null };
  }
  try {
    var j = JSON.parse(s.slice(INOUT_MULTI_VALUE_PREFIX.length));
    if (Array.isArray(j)) {
      var arr = j.length ? j.map(function(x) { return String(x); }) : [''];
      return { parts: arr, labels: null };
    }
    if (j && typeof j === 'object' && Array.isArray(j.v)) {
      var v = j.v.length ? j.v.map(function(x) { return String(x); }) : [''];
      var l = Array.isArray(j.l) ? j.l.map(function(x) { return (x == null ? '' : String(x)); }) : null;
      return { parts: v, labels: l };
    }
  } catch (e) {}
  return { parts: [s], labels: null };
}

function parseObjectTextToParts(raw) {
  return parseObjectTextPayload(raw).parts;
}

function alignLabelsForResize(labels, partCount) {
  var n = Math.max(0, Number(partCount) || 0);
  var out = [];
  for (var i = 0; i < n; i++) {
    var from = labels && labels[i];
    if (from != null && String(from).trim())
      out.push(String(from).trim().slice(0, INOUT_VALUE_COL_LABEL_MAX));
    else out.push(defaultValueColumnHeaderLabel(i));
  }
  return out;
}

function labelsAlignedToNewPartCount(prevPayload, newPartCount) {
  var pay = prevPayload || { parts: [], labels: null };
  var oldN = pay.parts.length;
  var labs = alignLabelsForResize(pay.labels, oldN);
  var n = Math.max(0, Number(newPartCount) || 0);
  if (n <= labs.length) return labs.slice(0, n);
  var o = labs.slice();
  while (o.length < n) o.push(defaultValueColumnHeaderLabel(o.length));
  return o;
}

function moveValueSlotInLabels(labels, fromIdx, toIdx) {
  if (!labels || !labels.length) return labels;
  var p = labels.map(function(x) { return String(x != null ? x : ''); });
  if (fromIdx < 0 || fromIdx >= p.length) return p;
  if (toIdx < 0) toIdx = 0;
  if (toIdx > p.length) toIdx = p.length;
  if (fromIdx === toIdx) return p;
  var x = p.splice(fromIdx, 1)[0];
  if (fromIdx < toIdx) toIdx--;
  p.splice(toIdx, 0, x);
  return p;
}

function serializeObjectParts(parts, labelsOpt) {
  if (!parts || !parts.length) return '';
  var pl = parts.map(function(p) { return String(p != null ? p : ''); });
  var n = pl.length;
  var labs =
    labelsOpt !== undefined && labelsOpt !== null
      ? alignLabelsForResize(labelsOpt, n)
      : alignLabelsForResize(null, n);
  /* Always store { v, l } so per-column labels live in DB (plain single-line would drop labels and break labels after view change). */
  return INOUT_MULTI_VALUE_PREFIX + JSON.stringify({ v: pl, l: labs });
}

/** Legacy rows stored plain text with no `l` array; upgrade in memory using current view header names so DB can be migrated. */
function normalizeEntryTextToJsonIfPlain(ent) {
  if (!ent || ent.text == null) return ent;
  var s = String(ent.text);
  if (s.indexOf(INOUT_MULTI_VALUE_PREFIX) === 0) return ent;
  var parts = parseObjectTextToParts(s);
  if (!parts.length) parts.push('');
  var labs = [];
  for (var c = 0; c < parts.length; c++) labs.push(valueColumnHeaderLabel(c));
  var next = serializeObjectParts(parts, labs);
  if (next === s) return ent;
  return Object.assign({}, ent, { text: next });
}

/** Persist rows whose text was upgraded from plain to JSON (fire-and-forget; idempotent after first success). */
function schedulePersistNormalizedEntries(originalList, normalizedList) {
  if (!originalList || !normalizedList || originalList.length !== normalizedList.length) return;
  var pending = [];
  for (var i = 0; i < normalizedList.length; i++) {
    var o = originalList[i];
    var n = normalizedList[i];
    if (!o || !n || o.id == null || n.id == null || Number(o.id) !== Number(n.id)) continue;
    if (String(o.text) === String(n.text)) continue;
    pending.push(n);
  }
  if (!pending.length) return;
  (async function() {
    for (var j = 0; j < pending.length; j++) {
      var ent = pending[j];
      try {
        var ch = ent.channel != null ? String(ent.channel) : String(currentChannel || 'main');
        await persistObjectTextPayload(Number(ent.id), ent.text, ch);
      } catch (e) {
        console.error('migrate plain entry text', e);
      }
    }
  })();
}

function computeMaxValueColumnsFromMessages(messages) {
  var m = 1;
  (messages || []).forEach(function(msg) {
    if (!msg) return;
    var n = parseObjectTextToParts(msg.text).length;
    if (n > m) m = n;
  });
  return m;
}

function computeMaxValueColumnsFromFeedInner(inner) {
  if (!inner) return 1;
  var max = 1;
  inner.querySelectorAll('.obj').forEach(function(row) {
    var n = row.querySelectorAll('.obj-value-cell').length;
    if (n > max) max = n;
  });
  return max;
}

/** Which value cell was clicked; empty cells often have no inner nodes so target may be the wrap. */
function resolveValueCellFromPointer(valuesWrap, clientX, clientY, target) {
  if (!valuesWrap) return null;
  var cell = target && target.closest && target.closest('.obj-value-cell');
  if (cell && valuesWrap.contains(cell)) return cell;
  var cells = valuesWrap.querySelectorAll(':scope > .obj-value-cell');
  if (!cells.length) return null;
  var x = clientX;
  var y = clientY;
  var i;
  for (i = 0; i < cells.length; i++) {
    var r = cells[i].getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return cells[i];
  }
  var wr = valuesWrap.getBoundingClientRect();
  if (x < wr.left || x > wr.right || y < wr.top || y > wr.bottom) return null;
  // In gaps between columns, choose the next column to the right so "under header" clicks map predictably.
  for (i = 0; i < cells.length; i++) {
    var r2 = cells[i].getBoundingClientRect();
    if (x <= r2.right) return cells[i];
  }
  return cells[cells.length - 1] || null;
}

/** Plain value text for a cell (excludes `.obj-remote-edit-badge` and similar injected UI). */
function valueCellPlainText(cell) {
  if (!cell) return '';
  var clone = cell.cloneNode(true);
  clone.querySelectorAll('.obj-remote-edit-badge').forEach(function(b) {
    if (b.parentNode) b.parentNode.removeChild(b);
  });
  return String(clone.textContent || '');
}

function partsFromRowDom(row) {
  var cells = row.querySelectorAll('.obj-value-cell');
  if (!cells.length) {
    var legacy = row.querySelector('.obj-text');
    return [legacy ? valueCellPlainText(legacy) : ''];
  }
  return Array.from(cells).map(function(c) { return valueCellPlainText(c); });
}

function getJoinedRowTextForEdit(row) {
  if (!row) return '';
  var raw = null;
  if (Object.prototype.hasOwnProperty.call(row, '__inoutEntryTextRaw')) {
    raw = row.__inoutEntryTextRaw;
  }
  if (raw == null) {
    var ch = channelKeyForRowEl(row);
    var rid = row.dataset && row.dataset.id != null ? Number(row.dataset.id) : NaN;
    if (Number.isFinite(rid)) raw = getLastKnownEntryTextForChannel(ch, rid);
  }
  if (raw != null) {
    var rawParts = parseObjectTextToParts(raw);
    while (rawParts.length > 1 && !String(rawParts[rawParts.length - 1] || '').trim()) rawParts.pop();
    if (rawParts.length <= 1) return rawParts[0] || '';
    return rawParts.join('\n\n');
  }
  var parts = partsFromRowDom(row);
  while (parts.length > 1 && !String(parts[parts.length - 1] || '').trim()) parts.pop();
  if (parts.length <= 1) return parts[0] || '';
  return parts.join('\n\n');
}

/**
 * Split composer / `editingObjectTextMap` text into per-column parts for inline edit UI.
 * Stored DB text uses PREFIX + JSON; the textarea and map use `parts.join('\\n\\n')` without
 * a prefix — `parseObjectTextToParts` would treat that as a single column, so we split on
 * `\\n\\n` when the row has multiple value cells (same convention as mergeComposerIntoParts).
 * Single-column rows never split so a value may contain `\\n\\n` literally.
 */
function parsePartsForEditingDisplay(joinedText, valueCellCount) {
  var n = Math.max(1, Math.floor(Number(valueCellCount) || 0));
  var s = String(joinedText != null ? joinedText : '');
  if (s.indexOf(INOUT_MULTI_VALUE_PREFIX) === 0) {
    var pr = parseObjectTextToParts(s);
    while (pr.length < n) pr.push('');
    if (pr.length > n) pr = pr.slice(0, n);
    return pr;
  }
  if (n <= 1) return [s];
  var chunks = s.split(/\n\n/);
  while (chunks.length < n) chunks.push('');
  if (chunks.length > n) {
    chunks[n - 1] = chunks.slice(n - 1).join('\n\n');
    chunks = chunks.slice(0, n);
  }
  return chunks;
}

function mergeComposerIntoParts(prevParts, composerText) {
  if (!prevParts || prevParts.length <= 1) {
    return [composerText == null ? '' : String(composerText)];
  }
  var N = prevParts.length;
  var t = composerText == null ? '' : String(composerText);
  var chunks = t.split(/\n\n/);
  if (chunks.length === 1) {
    var o = prevParts.slice();
    o[0] = chunks[0];
    return o;
  }
  while (chunks.length < N) chunks.push('');
  if (chunks.length > N) {
    chunks[N - 1] = chunks.slice(N - 1).join('\n\n');
    chunks = chunks.slice(0, N);
  }
  return chunks;
}

function ensureRowValueCellCount(row, maxCols, partsForFill) {
  var wrap = row.querySelector('.obj-values-wrap');
  if (!wrap) return;
  bindValueWrapScrollSync(wrap);
  var colWrap = document.getElementById('multi-value-col-labels');
  if (colWrap && Math.abs((wrap.scrollLeft || 0) - (colWrap.scrollLeft || 0)) >= 1) {
    wrap.scrollLeft = colWrap.scrollLeft || 0;
  }
  partsForFill = partsForFill ? partsForFill.slice() : [];
  while (partsForFill.length < maxCols) partsForFill.push('');
  if (partsForFill.length > maxCols) partsForFill = partsForFill.slice(0, maxCols);
  var editing = row.classList.contains('obj-editing');
  var cells = Array.from(wrap.querySelectorAll(':scope > .obj-value-cell'));
  while (cells.length > maxCols) {
    var rem = cells.pop();
    if (rem && rem.parentNode === wrap) wrap.removeChild(rem);
  }
  while (cells.length < maxCols) {
    var idx = cells.length;
    var cell = document.createElement('div');
    cell.className = 'obj-text obj-value-cell';
    cell.dataset.valueIndex = String(idx);
    cell.innerHTML = renderVisualOnlyHtml(partsForFill[idx] != null ? partsForFill[idx] : '');
    wrap.appendChild(cell);
    cells.push(cell);
  }
  for (var i = 0; i < maxCols; i++) {
    var c = cells[i];
    c.dataset.valueIndex = String(i);
    if (editing) continue;
    if (c.querySelector('.obj-remote-edit-badge')) continue;
    var want = partsForFill[i] != null ? partsForFill[i] : '';
    var html = renderVisualOnlyHtml(want);
    if (c.innerHTML !== html) c.innerHTML = html;
  }
  row.dataset.valueCols = String(maxCols);
  var entryRaw = row && Object.prototype.hasOwnProperty.call(row, '__inoutEntryTextRaw')
    ? row.__inoutEntryTextRaw
    : null;
  if (entryRaw == null) {
    var ch = channelKeyForRowEl(row);
    var rid = row.dataset.id != null ? Number(row.dataset.id) : NaN;
    entryRaw = Number.isFinite(rid) ? getLastKnownEntryTextForChannel(ch, rid) : null;
  }
  wrap.querySelectorAll(':scope > .obj-value-cell').forEach(function(c) {
    applyValueColumnLabelAttrToCell(c, entryRaw);
  });
}

function syncFeedMultiValueChrome(inner, messagesList) {
  if (!inner) return;
  var maxCols = messagesList && messagesList.length
    ? computeMaxValueColumnsFromMessages(messagesList)
    : computeMaxValueColumnsFromFeedInner(inner);
  maxCols = Math.max(1, maxCols);
  inner.dataset.inoutValueCols = String(maxCols);
  inner.style.setProperty('--inout-value-cols', String(maxCols));
  inner.classList.toggle('inout-multi-value-cols', maxCols > 1);
  var staleHeader = inner.querySelector('.obj.obj-header');
  if (staleHeader) staleHeader.remove();
  inner.querySelectorAll('.obj').forEach(function(row) {
    if (row.dataset.id == null) return;
    var parts = partsFromRowDom(row);
    while (parts.length < maxCols) parts.push('');
    if (parts.length > maxCols) parts = parts.slice(0, maxCols);
    ensureRowValueCellCount(row, maxCols, parts);
  });
  try {
    if (typeof feedInner !== 'undefined' && inner === feedInner && typeof updateMultiValueChromeBar === 'function')
      updateMultiValueChromeBar();
  } catch (_) {}
}

var inoutMultiValueFilterMode = 'all';
var inoutMultiValueColumnFilterIndex = null;
var inoutColHeaderFilterClickTimer = null;
var INOUT_VALUE_COL_LABELS_KEY = 'inout_value_column_labels_v1';

function valueColumnLabelsStorageChannel() {
  try {
    if (typeof currentChannel !== 'undefined' && currentChannel != null && String(currentChannel).trim())
      return String(currentChannel).trim();
    if (typeof currentView !== 'undefined' && currentView != null && String(currentView).trim())
      return String(currentView).trim();
  } catch (_) {}
  return 'main';
}

function getValueColumnLabelOverridesForChannel() {
  try {
    var raw = localStorage.getItem(INOUT_VALUE_COL_LABELS_KEY);
    var all = raw ? JSON.parse(raw) : {};
    var ch = valueColumnLabelsStorageChannel();
    var m = all[ch];
    return m && typeof m === 'object' ? m : {};
  } catch (_) {
    return {};
  }
}

function setValueColumnLabelOverrideAt(index, labelOrEmpty) {
  try {
    var raw = localStorage.getItem(INOUT_VALUE_COL_LABELS_KEY);
    var all = raw ? JSON.parse(raw) : {};
    if (typeof all !== 'object' || all === null) all = {};
    var ch = valueColumnLabelsStorageChannel();
    if (!all[ch] || typeof all[ch] !== 'object') all[ch] = {};
    var k = String(index);
    if (!labelOrEmpty) delete all[ch][k];
    else all[ch][k] = labelOrEmpty;
    if (Object.keys(all[ch]).length === 0) delete all[ch];
    localStorage.setItem(INOUT_VALUE_COL_LABELS_KEY, JSON.stringify(all));
  } catch (_) {}
}

function valueColumnHeaderLabel(index) {
  var map = getValueColumnLabelOverridesForChannel();
  var k = String(index);
  var o = map[k];
  if (o != null && String(o).trim()) return String(o).trim().slice(0, INOUT_VALUE_COL_LABEL_MAX);
  return defaultValueColumnHeaderLabel(index);
}

/** Column titles shown in manage bar: prefer labels stored on objects in the feed; fallback to view localStorage defaults. */
function getColumnHeaderLabelsForFeed(inner) {
  if (!inner) return [];
  var maxCols = parseInt(inner.dataset.inoutValueCols, 10) || 1;
  maxCols = Math.max(1, maxCols);
  var out = [];
  for (var c = 0; c < maxCols; c++) out.push('');
  var rows = inner.querySelectorAll('.obj[data-id]');
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var raw = row.__inoutEntryTextRaw;
    if (raw == null || raw === '') continue;
    var pay = parseObjectTextPayload(raw);
    var labsAligned = alignLabelsForResize(pay.labels, pay.parts.length);
    for (var i = 0; i < maxCols && i < labsAligned.length; i++) {
      if (out[i]) continue;
      var t = labsAligned[i] != null ? String(labsAligned[i]).trim() : '';
      if (t) out[i] = t.slice(0, INOUT_VALUE_COL_LABEL_MAX);
    }
  }
  for (var j = 0; j < maxCols; j++) {
    if (!out[j]) out[j] = valueColumnHeaderLabel(j);
  }
  return out;
}

function getDisplayValueLabelForEntryText(entryRawText, colIndex) {
  var i = Number(colIndex);
  if (!Number.isFinite(i) || i < 0) return valueColumnHeaderLabel(0);
  var s = entryRawText == null ? '' : String(entryRawText);
  /* Legacy plain string (no JSON payload): only view-level header overrides apply. */
  if (s.indexOf(INOUT_MULTI_VALUE_PREFIX) !== 0) return valueColumnHeaderLabel(i);
  var pay = parseObjectTextPayload(entryRawText);
  var labsAligned = alignLabelsForResize(pay.labels, pay.parts.length);
  if (i < labsAligned.length && labsAligned[i] != null && String(labsAligned[i]).trim())
    return String(labsAligned[i]).trim().slice(0, INOUT_VALUE_COL_LABEL_MAX);
  return valueColumnHeaderLabel(i);
}

async function fetchEntriesForCurrentViewForLabelSync() {
  var ch = String(currentChannel || currentView || 'main');
  if (!shouldUseServerForObjects()) {
    try {
      var byView = await getLocalObjectByViewMap();
      return Array.isArray(byView[ch]) ? byView[ch].slice() : [];
    } catch (_) {
      return [];
    }
  }
  if (!sb || !sb.from) return [];
  if (tempSessionId && currentChannel) {
    var q = sb
      .from(OBJECTS_TABLE)
      .select('id, text, channel, user_id, author_name, temp_session_id')
      .or('channel.eq.' + currentChannel + ',temp_session_id.eq.' + tempSessionId)
      .order('created_at', { ascending: true });
    var res = await q;
    if (res.error) {
      console.error(res.error);
      return [];
    }
    return res.data || [];
  }
  return fetchObjectsListForChannel(ch);
}

async function persistValueColumnDisplayNamesToAllEntries(colIndex, nameOrEmpty) {
  var idx = Number(colIndex);
  if (!Number.isFinite(idx) || idx < 0) return false;
  var ch = String(currentChannel || currentView || 'main');
  var resolvedName =
    nameOrEmpty && String(nameOrEmpty).trim()
      ? String(nameOrEmpty).trim().slice(0, INOUT_VALUE_COL_LABEL_MAX)
      : '';
  var list = await fetchEntriesForCurrentViewForLabelSync();
  var okAll = true;
  for (var i = 0; i < list.length; i++) {
    var ent = list[i];
    if (!ent || ent.id == null) continue;
    var pay = parseObjectTextPayload(ent.text);
    if (pay.parts.length <= idx) continue;
    var labs = alignLabelsForResize(pay.labels, pay.parts.length);
    if (resolvedName) labs[idx] = resolvedName;
    else labs[idx] = defaultValueColumnHeaderLabel(idx);
    var ser = serializeObjectParts(pay.parts, labs);
    var rowCh = ent.channel != null ? String(ent.channel) : ch;
    var ok = await persistObjectTextPayload(Number(ent.id), ser, rowCh);
    if (!ok) okAll = false;
  }
  return okAll;
}

function applyValueColumnLabelAttrToCell(cell, entryRawText) {
  if (!cell || !cell.classList || !cell.classList.contains('obj-value-cell')) return;
  var vi = parseInt(cell.dataset.valueIndex, 10);
  if (!Number.isFinite(vi)) return;
  var raw = entryRawText;
  if (raw == null) {
    var row = cell.closest('.obj');
    if (row && Object.prototype.hasOwnProperty.call(row, '__inoutEntryTextRaw')) {
      raw = row.__inoutEntryTextRaw;
    }
    if (raw == null && row && row.dataset.id != null) {
      var ch = channelKeyForRowEl(row);
      raw = getLastKnownEntryTextForChannel(ch, Number(row.dataset.id));
    }
  }
  try {
    cell.setAttribute('data-value-label', getDisplayValueLabelForEntryText(raw, vi));
  } catch (_) {}
}

function syncAllValueColumnLabelAttrs() {
  try {
    document.querySelectorAll('.obj-value-cell').forEach(function(c) {
      applyValueColumnLabelAttrToCell(c, null);
    });
  } catch (_) {}
}

async function promptRenameValueColumnHeader(btn) {
  if (!btn) return;
  var idx = parseInt(btn.getAttribute('data-value-index'), 10);
  if (!Number.isFinite(idx)) return;
  var fromFeed =
    typeof feedInner !== 'undefined' && feedInner ? getColumnHeaderLabelsForFeed(feedInner) : [];
  var cur =
    fromFeed.length > idx && String(fromFeed[idx] || '').trim()
      ? String(fromFeed[idx]).trim()
      : valueColumnHeaderLabel(idx);
  var raw = typeof window !== 'undefined' && window.prompt ? window.prompt('Column header name', cur) : null;
  if (raw == null) return;
  var next = String(raw).replace(/\r?\n/g, ' ').trim().slice(0, INOUT_VALUE_COL_LABEL_MAX);
  var cleared = !next || next === defaultValueColumnHeaderLabel(idx);
  if (cleared) setValueColumnLabelOverrideAt(idx, '');
  else setValueColumnLabelOverrideAt(idx, next);
  var ok = await persistValueColumnDisplayNamesToAllEntries(idx, cleared ? '' : next);
  if (!ok) toast('Some objects could not be updated in the database.');
  rebuildMultiValueColumnLabelButtons();
  syncAllValueColumnLabelAttrs();
  try {
    if (typeof logAction === 'function')
      logAction('view', { valueColumnHeader: { index: idx, label: cleared ? null : next } });
  } catch (_) {}
}

function columnPartNonEmpty(row, idx) {
  if (!row || idx == null || !Number.isFinite(Number(idx))) return true;
  var i = Number(idx);
  var parts = partsFromRowDom(row);
  return i >= 0 && i < parts.length && String(parts[i]).trim().length > 0;
}

/**
 * When filtering by column index, ensure every object has at least that many value slots in stored text
 * (pad with empty strings + persist) so rows aren’t dropped just because the slot was missing from JSON.
 */
function expandStoredColumnSlotsForFilter(colIdx) {
  if (typeof feedInner === 'undefined' || !feedInner) return;
  if (colIdx == null || !Number.isFinite(Number(colIdx))) return;
  var idx = Number(colIdx);
  if (idx < 0) return;
  var minNeed = idx + 1;
  var feedMax = Math.max(minNeed, parseInt(feedInner.dataset.inoutValueCols, 10) || minNeed);
  feedInner.querySelectorAll('.obj[data-id]').forEach(function(row) {
    var id = row.dataset.id != null ? Number(row.dataset.id) : NaN;
    if (!Number.isFinite(id)) return;
    var raw = Object.prototype.hasOwnProperty.call(row, '__inoutEntryTextRaw')
      ? row.__inoutEntryTextRaw
      : null;
    if (raw == null) {
      var ch0 = channelKeyForRowEl(row);
      raw = getLastKnownEntryTextForChannel(ch0, id);
    }
    if (raw == null) return;
    var pay = parseObjectTextPayload(String(raw));
    var parts = pay.parts.slice();
    var domParts = partsFromRowDom(row);
    var dlen = domParts.length;
    for (var d = 0; d < dlen; d++) {
      if (d >= parts.length) parts.push(String(domParts[d] != null ? domParts[d] : ''));
    }
    var rowCols = parseInt(row.dataset.valueCols, 10) || 0;
    var targetLen = Math.max(minNeed, feedMax, rowCols);
    while (parts.length < targetLen) parts.push('');
    var next = serializeObjectParts(parts, labelsAlignedToNewPartCount(pay, parts.length));
    if (String(next) === String(raw)) return;
    row.__inoutEntryTextRaw = next;
    var ch = channelKeyForRowEl(row);
    rememberEntryText(ch, id, next);
    updateObjectRowText(id, next);
    persistObjectTextPayload(id, next, ch).catch(function() {});
  });
}

function syncInoutObjLeadingWidthVar() {
  try {
    var inner = document.getElementById('feed-inner');
    var mbar = document.getElementById('manage-bar');
    if (!inner || !mbar) return;
    var row = inner.querySelector('.obj[data-id] .obj-leading-col');
    var rowW = row ? Math.ceil(row.getBoundingClientRect().width) : 0;
    var start = mbar.querySelector('.manage-bar-start');
    var filterSlot = mbar.querySelector('.multi-value-filter-slot');
    var startW = start ? Math.ceil(start.getBoundingClientRect().width) : 0;
    var filterW = filterSlot ? Math.ceil(filterSlot.getBoundingClientRect().width) : 0;
    var w = Math.max(rowW, startW, filterW);
    var props = [inner, mbar];
    if (w > 0) {
      props.forEach(function(el) {
        if (el) el.style.setProperty('--inout-obj-leading-w', w + 'px');
      });
    } else {
      props.forEach(function(el) {
        if (el) el.style.removeProperty('--inout-obj-leading-w');
      });
    }
  } catch (_) {}
}

function countNonEmptyValuePartsInRow(row) {
  if (!row) return 0;
  var parts = partsFromRowDom(row);
  var n = 0;
  for (var i = 0; i < parts.length; i++) {
    if (String(parts[i]).trim()) n++;
  }
  return n;
}

function feedHasAnyObjectWithMultipleMessageValues(inner) {
  if (!inner) return false;
  var rows = inner.querySelectorAll('.obj[data-id]');
  for (var i = 0; i < rows.length; i++) {
    if (countNonEmptyValuePartsInRow(rows[i]) > 1) return true;
  }
  return false;
}

function closeInoutMultiValueFilterMenu() {
  var menu = document.getElementById('multi-value-filter-menu');
  var trig = document.getElementById('multi-value-filter-trigger');
  if (menu) {
    menu.hidden = true;
    menu.style.position = '';
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
    menu.style.bottom = '';
    menu.style.zIndex = '';
    menu.style.maxHeight = '';
    menu.style.overflowY = '';
  }
  if (trig) trig.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', closeInoutMultiValueFilterMenuOnDoc);
}

function closeInoutMultiValueFilterMenuOnDoc() {
  closeInoutMultiValueFilterMenu();
}

function syncInoutMultiValueFilterMenuAria() {
  var menu = document.getElementById('multi-value-filter-menu');
  if (!menu) return;
  var mode = inoutMultiValueFilterMode;
  menu.querySelectorAll('[data-multi-value-filter]').forEach(function(b) {
    var m = b.getAttribute('data-multi-value-filter') || '';
    b.setAttribute('aria-checked', m === mode ? 'true' : 'false');
  });
}

var inoutColScrollSyncing = false;

function inoutMultiValueLayoutCtx() {
  return {
    feedInner: (typeof feedInner !== 'undefined' ? feedInner : null),
    bindVerticalWheelToHorizontalScroll: bindVerticalWheelToHorizontalScroll,
    getColumnHeaderLabelsForFeed: getColumnHeaderLabelsForFeed,
    valueColumnHeaderLabel: valueColumnHeaderLabel,
    state: {
      getInoutColScrollSyncing: function() { return inoutColScrollSyncing; },
      setInoutColScrollSyncing: function(v) { inoutColScrollSyncing = !!v; },
      getInoutMultiValueColumnFilterIndex: function() { return inoutMultiValueColumnFilterIndex; },
      setInoutMultiValueColumnFilterIndex: function(v) { inoutMultiValueColumnFilterIndex = v; },
    },
  };
}

function bindVerticalWheelToHorizontalScroll(el) {
  if (!window.InoutScroll || !window.InoutScroll.bindVerticalWheelToHorizontalScroll) return;
  window.InoutScroll.bindVerticalWheelToHorizontalScroll(el, {
    wheelState: {
      get lastWheelAt() { return inoutLastWheelAt; },
      set lastWheelAt(v) { inoutLastWheelAt = v; },
      get gapMs() { return INOUT_WHEEL_INTERACTION_GAP_MS; },
    },
    getFeedScrollSurfaceForElement: getFeedScrollSurfaceForElement,
  });
}

function syncValueWrapsToHeaderScroll(scrollLeft, sourceWrap) {
  if (!window.InoutMultiValueLayout || !window.InoutMultiValueLayout.syncValueWrapsToHeaderScroll) return;
  window.InoutMultiValueLayout.syncValueWrapsToHeaderScroll(scrollLeft, sourceWrap, inoutMultiValueLayoutCtx());
}

function syncHeaderScrollToValueWrap(scrollLeft) {
  if (!window.InoutMultiValueLayout || !window.InoutMultiValueLayout.syncHeaderScrollToValueWrap) return;
  window.InoutMultiValueLayout.syncHeaderScrollToValueWrap(scrollLeft);
}

function bindValueWrapScrollSync(wrap) {
  if (!window.InoutMultiValueLayout || !window.InoutMultiValueLayout.bindValueWrapScrollSync) return;
  window.InoutMultiValueLayout.bindValueWrapScrollSync(wrap, inoutMultiValueLayoutCtx());
}

function syncHeaderScrollFromPrimaryFeed() {
  if (!window.InoutMultiValueLayout || !window.InoutMultiValueLayout.syncHeaderScrollFromPrimaryFeed) return;
  window.InoutMultiValueLayout.syncHeaderScrollFromPrimaryFeed(inoutMultiValueLayoutCtx());
}

function syncManageBarLabelButtonWidthsFromFeed() {
  if (!window.InoutMultiValueLayout || !window.InoutMultiValueLayout.syncManageBarLabelButtonWidthsFromFeed) return;
  window.InoutMultiValueLayout.syncManageBarLabelButtonWidthsFromFeed(inoutMultiValueLayoutCtx());
}

function rebuildMultiValueColumnLabelButtons() {
  if (!window.InoutMultiValueLayout || !window.InoutMultiValueLayout.rebuildMultiValueColumnLabelButtons) return;
  window.InoutMultiValueLayout.rebuildMultiValueColumnLabelButtons(inoutMultiValueLayoutCtx());
}

function updateMultiValueColumnLabelButtonsActive() {
  if (!window.InoutMultiValueLayout || !window.InoutMultiValueLayout.updateMultiValueColumnLabelButtonsActive) return;
  window.InoutMultiValueLayout.updateMultiValueColumnLabelButtonsActive(inoutMultiValueLayoutCtx());
}

function applyInoutMultiValueFilter() {
  if (typeof feedInner === 'undefined' || !feedInner) return;
  var multiONLY = inoutMultiValueFilterMode === 'multi';
  var colIdx = inoutMultiValueColumnFilterIndex;
  if (colIdx != null) expandStoredColumnSlotsForFilter(colIdx);
  feedInner.querySelectorAll('.obj[data-id]').forEach(function(row) {
    var passesMulti = !multiONLY || countNonEmptyValuePartsInRow(row) > 1;
    var passesCol = colIdx == null || columnPartNonEmpty(row, colIdx);
    row.classList.toggle('obj-filtered-out', !(passesMulti && passesCol));
  });
  var trig = document.getElementById('multi-value-filter-trigger');
  if (trig) trig.classList.toggle('multi-value-filter-active', multiONLY || colIdx != null);
  updateMultiValueColumnLabelButtonsActive();
  syncInoutMultiValueFilterMenuAria();
}

function updateMultiValueChromeBar() {
  var bar = document.getElementById('multi-value-chrome-middle');
  if (typeof feedInner === 'undefined' || !feedInner || !bar) return;
  var show = feedHasAnyObjectWithMultipleMessageValues(feedInner);
  if (!show) {
    bar.hidden = true;
    bar.setAttribute('aria-hidden', 'true');
    inoutMultiValueColumnFilterIndex = null;
    if (inoutMultiValueFilterMode !== 'all') {
      inoutMultiValueFilterMode = 'all';
      applyInoutMultiValueFilter();
    }
    closeInoutMultiValueFilterMenu();
    feedInner.querySelectorAll('.obj.obj-filtered-out').forEach(function(r) {
      r.classList.remove('obj-filtered-out');
    });
    var lw = document.getElementById('multi-value-col-labels');
    if (lw) {
      lw.replaceChildren();
      lw.setAttribute('aria-hidden', 'true');
    }
    var trig = document.getElementById('multi-value-filter-trigger');
    if (trig) trig.classList.remove('multi-value-filter-active');
    return;
  }
  bar.hidden = false;
  bar.removeAttribute('aria-hidden');
  syncInoutObjLeadingWidthVar();
  var labelsWrap = document.getElementById('multi-value-col-labels');
  if (labelsWrap) labelsWrap.setAttribute('aria-hidden', 'false');
  rebuildMultiValueColumnLabelButtons();
  syncHeaderScrollFromPrimaryFeed();
  syncManageBarLabelButtonWidthsFromFeed();
  applyInoutMultiValueFilter();
}

function setupMultiValueChromeBar() {
  var trig = document.getElementById('multi-value-filter-trigger');
  var menu = document.getElementById('multi-value-filter-menu');
  if (!trig || !menu) return;
  trig.addEventListener('click', function(e) {
    e.stopPropagation();
    var open = !menu.hidden;
    if (open) {
      closeInoutMultiValueFilterMenu();
      return;
    }
    var mb = document.getElementById('manage-bar');
    var mbt = document.getElementById('manage-bar-trigger');
    if (mb && mbt && mb.classList.contains('manage-bar-open')) {
      mb.classList.remove('manage-bar-open');
      mbt.setAttribute('aria-expanded', 'false');
    }
    menu.hidden = false;
    trig.setAttribute('aria-expanded', 'true');
    if (typeof positionMultiValueFilterMenuClamp === 'function') positionMultiValueFilterMenuClamp();
    document.addEventListener('click', closeInoutMultiValueFilterMenuOnDoc);
  });
  menu.querySelectorAll('[data-multi-value-filter]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var mode = btn.getAttribute('data-multi-value-filter') === 'multi' ? 'multi' : 'all';
      inoutMultiValueFilterMode = mode;
      if (mode === 'all') inoutMultiValueColumnFilterIndex = null;
      applyInoutMultiValueFilter();
      closeInoutMultiValueFilterMenu();
    });
  });
  var colWrap = document.getElementById('multi-value-col-labels');
  if (colWrap && !colWrap.dataset.inoutColFilterBound) {
    colWrap.dataset.inoutColFilterBound = '1';
    bindVerticalWheelToHorizontalScroll(colWrap);
    colWrap.addEventListener('scroll', function() {
      if (inoutColScrollSyncing) return;
      inoutColScrollSyncing = true;
      syncValueWrapsToHeaderScroll(colWrap.scrollLeft || 0, null);
      inoutColScrollSyncing = false;
    }, { passive: true });
    colWrap.addEventListener('click', function(e) {
      var b = e.target && e.target.closest && e.target.closest('.multi-value-col-label-btn');
      if (!b || !colWrap.contains(b)) return;
      e.stopPropagation();
      var idx = parseInt(b.getAttribute('data-value-index'), 10);
      if (!Number.isFinite(idx)) return;
      if (e.detail >= 2) {
        if (inoutColHeaderFilterClickTimer) {
          clearTimeout(inoutColHeaderFilterClickTimer);
          inoutColHeaderFilterClickTimer = null;
        }
        promptRenameValueColumnHeader(b);
        return;
      }
      clearTimeout(inoutColHeaderFilterClickTimer);
      inoutColHeaderFilterClickTimer = setTimeout(function() {
        inoutColHeaderFilterClickTimer = null;
        if (inoutMultiValueColumnFilterIndex === idx) inoutMultiValueColumnFilterIndex = null;
        else inoutMultiValueColumnFilterIndex = idx;
        applyInoutMultiValueFilter();
      }, 300);
    });
  }
  if (typeof window !== 'undefined' && !document.body.dataset.inoutColResizeBound) {
    document.body.dataset.inoutColResizeBound = '1';
    window.addEventListener('resize', function() {
      syncManageBarLabelButtonWidthsFromFeed();
      syncHeaderScrollFromPrimaryFeed();
    }, { passive: true });
  }
}

const USER_INPUT_STATE_TABLE = 'user_input_state';
const SLOTS_SYNC_CHANNEL = '__slots__';

function isMobileOrTouchDevice() {
  try {
    return !!(typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || ('ontouchstart' in (window || {}))));
  } catch (_) { return false; }
}

// Per-device/local storage keys.
const LOCAL_DEVICE_ID_KEY      = 'inout_device_id';
const LOCAL_ANON_OBJECTS_KEY   = 'inout_anon_objects_v1';
// (Optional: per-user local objects, not yet used but reserved)
const LOCAL_USER_OBJECTS_KEY_PREFIX = 'inout_user_objects_';

let objectCount    = 0;
let atBottom    = true;
let presenceCh  = null;
let toastTimer     = null;
if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  crypto.randomUUID = function randomUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };
}
/** Stable per-browser tab storage; must survive refresh so realtime input_state ignores our own rows. */
let myId;
(function initStableDeviceId() {
  try {
    if (typeof localStorage !== 'undefined') {
      var sid = localStorage.getItem(LOCAL_DEVICE_ID_KEY);
      if (sid && String(sid).length >= 8) {
        myId = String(sid);
        return;
      }
    }
  } catch (_) {}
  try {
    myId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(LOCAL_DEVICE_ID_KEY, myId);
    } catch (_) {}
  } catch (_) {
    myId = 'fallback-' + Date.now();
  }
})();
/** Per browser tab — input_state must ignore same-tab echoes but accept other tabs / devices. */
const INPUT_TAB_INSTANCE_KEY = 'inout_input_tab_inst_v1';
let inputSyncTabInstanceId;
(function initInputSyncTabInstance() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      var ti = sessionStorage.getItem(INPUT_TAB_INSTANCE_KEY);
      if (ti && String(ti).length >= 4) {
        inputSyncTabInstanceId = String(ti);
        return;
      }
      ti =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 't' + Date.now() + '-' + Math.random().toString(16).slice(2);
      sessionStorage.setItem(INPUT_TAB_INSTANCE_KEY, ti);
      inputSyncTabInstanceId = String(ti);
      return;
    }
  } catch (_) {}
  inputSyncTabInstanceId = 't' + Date.now();
})();
function getInputStateDeviceId() {
  return String(myId) + ':' + String(inputSyncTabInstanceId || 'tab');
}
let currentView    = 'main';
let currentChannel = currentView; // temporary alias while migrating off "channel"
let viewNames      = ['main'];
const VIEW_DISPLAY_NAMES_KEY = 'inout_view_display_names_v1';
let viewDisplayNames = {};
const VIEWS_KEY           = 'inout_views_v1';
const LEFT_VIEWS_KEY      = 'inout_left_views_v1';
const LEFT_CHANNELS_KEY   = LEFT_VIEWS_KEY; /* alias: left-rail hidden feeds */
const CURRENT_VIEW_KEY    = 'inout_current_view_v1';
const CURRENT_CHANNEL_KEY = 'inout_current_channel_v1';
const INPUT_STATE_KEY      = 'inout_input_state_v2';
const INPUT_SLOTS_KEY      = 'inout_input_slots_v1';
const SYNC_INPUT_PREF_KEY  = 'inout_sync_input_v1';
const FIELD_PREFS_KEY      = 'inout_field_prefs_v1';
const ORDER_STATE_KEY      = 'inout_order_state_v1';
const PINNED_STATE_KEY     = 'inout_pinned_v1';
const SCROLL_STATE_KEY     = 'inout_scroll_state_v1';
const WAS_EDITING_KEY      = 'inout_was_editing_v1';
const AUTH_BACKUP_KEY     = 'inout_auth_user_backup';
const STORAGE_TARGET_KEY   = 'inout_storage_target_v1';
const ACTIVE_LOCAL_VAULT_KEY = 'inout_active_local_vault_v1';
const VAULT_REGISTRY_KEY   = 'inout_local_vault_registry_v1';
let suppressAutoAuth      = false; // when true, never auto-log user back in this tab

function getStorageTarget() {
  try {
    const v = localStorage.getItem(STORAGE_TARGET_KEY);
    if (v === 'local' || v === 'cloud') return v;
  } catch (_) {}
  return 'cloud';
}

function setStorageTarget(mode) {
  try {
    localStorage.setItem(STORAGE_TARGET_KEY, mode === 'local' ? 'local' : 'cloud');
  } catch (_) {}
}

function getActiveVaultId() {
  try {
    const v = localStorage.getItem(ACTIVE_LOCAL_VAULT_KEY);
    if (v && String(v).trim()) return String(v).trim();
  } catch (_) {}
  return 'default';
}

function setActiveVaultId(id) {
  try {
    const s = (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.sanitizeVaultId)
      ? INOUT_LOCAL_DB.sanitizeVaultId(id)
      : (String(id || 'default').trim() || 'default');
    localStorage.setItem(ACTIVE_LOCAL_VAULT_KEY, s);
  } catch (_) {}
}

function readVaultRegistry() {
  try {
    const raw = localStorage.getItem(VAULT_REGISTRY_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && Array.isArray(j.vaults)) return j;
  } catch (_) {}
  return { vaults: [{ id: 'default', label: 'Default', createdAt: 0 }] };
}

function writeVaultRegistry(reg) {
  try {
    localStorage.setItem(VAULT_REGISTRY_KEY, JSON.stringify(reg || { vaults: [] }));
  } catch (_) {}
}

function ensureVaultRegistry() {
  let reg = readVaultRegistry();
  if (!reg.vaults || !reg.vaults.length) {
    reg = { vaults: [{ id: 'default', label: 'Default', createdAt: Date.now() }] };
    writeVaultRegistry(reg);
  } else if (!reg.vaults.some(v => v && v.id === 'default')) {
    reg.vaults.unshift({ id: 'default', label: 'Default', createdAt: 0 });
    writeVaultRegistry(reg);
  }
  return reg;
}

function getActiveLocalStore() {
  ensureVaultRegistry();
  const vid = getActiveVaultId();
  if (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.forVault) {
    return INOUT_LOCAL_DB.forVault(vid);
  }
  return INOUT_LOCAL_DB;
}

function usesIndexedDbForObjectData() {
  if (tempSessionId) return false;
  if (getStorageTarget() === 'local') return true;
  return !currentUser;
}

function shouldUseServerForObjects() {
  if (tempSessionId) return true;
  if (getStorageTarget() === 'local') return false;
  return !!currentUser;
}

function getScopedViewStorageKey(viewKey) {
  const ch = viewKey != null ? viewKey : currentView || 'main';
  let prefix;
  if (usesIndexedDbForObjectData()) {
    prefix = 'vault:' + getActiveVaultId();
  } else if (currentUser && currentUser.id) {
    prefix = 'user:' + currentUser.id;
  } else {
    prefix = 'anon';
  }
  return prefix + '::' + ch;
}
const seenIds       = new Set();
const viewScroll = new Map();
const OPEN_VIEWS_KEY     = 'inout_open_views_v1';
/** Reserved `views.channel` for per-user UI state (not a real feed). */
const WORKSPACE_META_VIEW_CHANNEL = '__inout_open_panels__';
const MANAGE_BAR_ORDER_KEY = 'inout_manage_bar_order_v1';
const FRAME_ORDER_KEY    = 'inout_frame_order_v1';
var _personalWorkspacePersistTimer = null;
var _channelViewRulesPersistTimer = null;
/** True while switching tab from personal workspace realtime (skip re-persist). */
var applyingWorkspaceFocusFromRemote = false;
/** Ignore personal-workspace `focusedChannel` from realtime briefly after a local tab change (avoids fighting the user). */
var lastLocalFocusedChannelSwitchAt = 0;
var REMOTE_FOCUSED_CHANNEL_GRACE_MS = 700;
/** True during full applyPersonalWorkspaceStateFromServer (avoid persist/flush feedback loops). */
var applyingPersonalWorkspaceFromRemote = false;
/** Nonces from our recent workspace upserts — skip only those realtime echoes (not other devices). */
var myWorkspacePushNonces = new Set();
function rememberWorkspacePushNonce(n) {
  if (!n) return;
  try {
    myWorkspacePushNonces.add(n);
    setTimeout(function() {
      try {
        myWorkspacePushNonces.delete(n);
      } catch (_) {}
    }, 15000);
  } catch (_) {}
}

/** Monotonic workspace config revision (see applyPersonalWorkspaceStateFromServer). */
var lastAppliedWorkspaceRev = 0;
/** Drop merge payloads older than the last applied workspace row (out-of-order realtime). */
var lastMergedWorkspaceRevMs = 0;
/** Serialize mergeMultiview applies: postgres + broadcast can arrive together and interleave switchChannel / secondaries. */
var _wsMergeMutex = Promise.resolve();
async function acquireWsMergeLock() {
  var prev = _wsMergeMutex;
  var release;
  _wsMergeMutex = new Promise(function(res) {
    release = res;
  });
  await prev;
  return release;
}
/** True while applying saved workspace on load — lets switchChannel reload data when vars already match. */
var inoutHydratingWorkspace = false;
/** One debounced tab switch for the whole strip — per-tab timers never cleared each other, so multiple switchChannel calls could race. */
var pendingViewSwitchTimer = null;
var pendingViewSwitchChannel = null;
function clearPendingViewSwitchClick() {
  if (pendingViewSwitchTimer) {
    clearTimeout(pendingViewSwitchTimer);
    pendingViewSwitchTimer = null;
  }
  pendingViewSwitchChannel = null;
}
/** Serialize channel switches so a fast tab chain or overlapping realtime + click cannot interleave teardown/subscribe. */
var switchChannelQueueTail = Promise.resolve();
function switchChannel(ch) {
  var run = switchChannelQueueTail.then(function() {
    return switchChannelInternal(ch);
  });
  switchChannelQueueTail = run.catch(function(e) {
    console.error('switchChannel', e);
  });
  return run;
}
/** Drop input_state realtime merges for a short window after switching views (stale merge + race with DB load). */
var inoutChannelInputQuietUntil = 0;
/** Briefly ignore user_input_state realtime after composer focus (mobile had no “recent local edit” guard; refocus merged stale rows). */
var composerRemoteMergeSuppressedUntil = 0;
function bumpComposerRemoteMergeSuppress(ms) {
  var add = typeof ms === 'number' ? ms : 750;
  var t = Date.now() + add;
  if (t > composerRemoteMergeSuppressedUntil) composerRemoteMergeSuppressedUntil = t;
}
/** Latest applied user_input_state.updated_at (ms) per channel — suppress duplicate PG events after refresh. */
var lastSeenInputStateTs = Object.create(null);
function inputStateDedupeKey(row) {
  if (!row || typeof row !== 'object') return '';
  return row.channel === SLOTS_SYNC_CHANNEL ? '__slots' : String(row.channel || 'main');
}
function shouldSkipStaleInputRealtimeRow(row) {
  var ra = row && row.updated_at ? new Date(row.updated_at).getTime() : 0;
  if (!Number.isFinite(ra)) ra = 0;
  var k = inputStateDedupeKey(row);
  var prev = lastSeenInputStateTs[k];
  return prev != null && ra <= prev;
}
function markInputRealtimeRowApplied(row) {
  if (!row || typeof row !== 'object') return;
  var ra = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  if (!Number.isFinite(ra)) ra = 0;
  var k = inputStateDedupeKey(row);
  var prev = lastSeenInputStateTs[k] || 0;
  if (ra > prev) lastSeenInputStateTs[k] = ra;
}

var workspaceUiBroadcastSub = null;
function teardownWorkspaceUiBroadcast() {
  if (workspaceUiBroadcastSub) {
    try {
      workspaceUiBroadcastSub.unsubscribe();
    } catch (_) {}
    workspaceUiBroadcastSub = null;
  }
}

/** Supabase Realtime: use httpSend when present so broadcast does not warn on REST fallback. */
function realtimeBroadcastSend(channel, eventName, payload) {
  if (!channel || payload == null || typeof payload !== 'object') return;
  var ev = String(eventName || '');
  if (!ev) return;
  try {
    if (typeof channel.httpSend === 'function') {
      channel.httpSend(ev, payload).catch(function() {});
      return;
    }
    channel.send({
      type: 'broadcast',
      event: ev,
      payload: payload,
    });
  } catch (e) {
    console.error('realtimeBroadcastSend', e);
  }
}

function tryBroadcastWorkspaceConfig(cfgPlain) {
  if (!workspaceUiBroadcastSub || !cfgPlain || typeof cfgPlain !== 'object') return;
  try {
    var payload = JSON.stringify({ config: cfgPlain });
    if (payload.length > 110000) return;
    realtimeBroadcastSend(workspaceUiBroadcastSub, 'workspace_state', { config: cfgPlain });
  } catch (e) {
    console.error('tryBroadcastWorkspaceConfig', e);
  }
}

function setupWorkspaceUiBroadcast() {
  teardownWorkspaceUiBroadcast();
  if (!sb || !sb.channel || !currentUser || !currentUser.id) return;
  var uid = String(currentUser.id).replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    workspaceUiBroadcastSub = sb
      .channel('workspace-ui-' + uid, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'workspace_state' }, function(msg) {
        try {
          var data = msg && msg.payload ? msg.payload : {};
          var cfg = data.config;
          if (!cfg || typeof cfg !== 'object') return;
          if (cfg._wsPushNonce && myWorkspacePushNonces.has(cfg._wsPushNonce)) return;
          applyPersonalWorkspaceStateFromServer(cfg, { mergeMultiview: true }).catch(function(e) {
            console.error('workspace broadcast apply', e);
          });
        } catch (err) {
          console.error('workspace broadcast', err);
        }
      })
      .subscribe();
  } catch (e) {
    console.error('setupWorkspaceUiBroadcast', e);
  }
}

/** Add feeds referenced only in workspace config. */
function ensureWorkspaceChannelsFromCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  var add = [];
  if (typeof cfg.focusedChannel === 'string' && cfg.focusedChannel.trim()) {
    add.push(cfg.focusedChannel.trim());
  }
  if (Array.isArray(cfg.channelStripOrder)) {
    cfg.channelStripOrder.forEach(function(c) {
      add.push(String(c || '').trim());
    });
  }
  var changed = false;
  add.forEach(function(ch) {
    if (!ch || ch === 'main') return;
    if (viewNames.indexOf(ch) < 0) {
      viewNames.push(ch);
      changed = true;
    }
  });
  if (changed) {
    try {
      localStorage.setItem(
        CHANNELS_KEY,
        JSON.stringify(viewNames.filter(function(c) {
          return c !== 'main';
        }))
      );
    } catch (_) {}
    refreshWorkspaceChannelUi();
  }
}

function gatherUiChromeForWorkspace() {
  try {
    return {
      userModal: isUserModalBackdropOpen(),
      channelModal: !!(cmBackdrop && cmBackdrop.style.display === 'flex'),
      addMembersModal: !!(addMembersBackdrop && addMembersBackdrop.style.display === 'flex'),
      secretControlsOpen: !!(secretControlsBackdrop && secretControlsBackdrop.getAttribute('aria-hidden') === 'false'),
      qrModalOpen: !!(qrModalBackdrop && qrModalBackdrop.getAttribute('aria-hidden') === 'false'),
      viewMenuOpen: !!(viewMenu && viewMenu.classList.contains('open')),
      manageBarOpen: !!(document.getElementById('manage-bar') && document.getElementById('manage-bar').classList.contains('manage-bar-open')),
      logDropupOpen: !!(logDropupPanel && logDropupPanel.classList.contains('open')),
    };
  } catch (_) {
    return {};
  }
}

function applyWorkspaceUiChrome(u) {
  if (!u || typeof u !== 'object') return;
  try {
    if (umBackdrop) {
      if (u.userModal) showUserModalBackdrop();
      else hideUserModalBackdrop();
    }
    if (cmBackdrop) {
      cmBackdrop.style.display = u.channelModal ? 'flex' : 'none';
    }
    if (addMembersBackdrop) {
      addMembersBackdrop.style.display = u.addMembersModal ? 'flex' : 'none';
    }
    if (secretControlsBackdrop) {
      secretControlsBackdrop.setAttribute('aria-hidden', u.secretControlsOpen ? 'false' : 'true');
    }
    if (qrModalBackdrop) {
      qrModalBackdrop.setAttribute('aria-hidden', u.qrModalOpen ? 'false' : 'true');
    }
    if (viewMenu && viewToggleBtn) {
      if (u.viewMenuOpen) {
        viewMenu.classList.add('open');
        if (typeof positionViewMenuClamp === 'function') positionViewMenuClamp();
      } else {
        viewMenu.classList.remove('open');
        if (typeof clearViewMenuInlinePosition === 'function') clearViewMenuInlinePosition();
      }
    }
    var mb = document.getElementById('manage-bar');
    var mbt = document.getElementById('manage-bar-trigger');
    if (mb && mbt) {
      if (u.manageBarOpen) {
        mb.classList.add('manage-bar-open');
        mbt.setAttribute('aria-expanded', 'true');
        if (typeof positionManageBarDropdownClamp === 'function') positionManageBarDropdownClamp();
      } else {
        if (typeof closeManageBarDropdown === 'function') closeManageBarDropdown();
      }
    }
    if (logDropupPanel) {
      if (u.logDropupOpen) {
        if (typeof renderLogDropup === 'function') renderLogDropup();
        logDropupPanel.classList.add('open');
        if (typeof positionLogDropupPanelFixed === 'function') positionLogDropupPanelFixed();
        if (logActionBtn) logActionBtn.setAttribute('aria-expanded', 'true');
      } else {
        logDropupPanel.classList.remove('open');
        if (typeof clearLogDropupPanelFixed === 'function') clearLogDropupPanelFixed();
        if (logActionBtn) logActionBtn.setAttribute('aria-expanded', 'false');
      }
    }
  } catch (e) {
    console.error('applyWorkspaceUiChrome', e);
  }
}
/** After applying remote feed scroll, ignore briefly so programmatic scroll does not re-broadcast. */
var suppressScrollWorkspacePersistUntil = 0;
const LAYOUT_SYNC_KEY    = 'inout_layout_sync_v1';
const DEFAULT_FRAME_ORDER = ['nav', 'multiview', 'input'];

function getLocalObjectsKey() {
  if (currentUser && currentUser.id) {
    return LOCAL_USER_OBJECTS_KEY_PREFIX + String(currentUser.id);
  }
  return LOCAL_ANON_OBJECTS_KEY;
}

/** Signed-in: object mirror map in localStorage. Anonymous: IndexedDB (see INOUT_LOCAL_DB). */
function loadLocalObjectsFromLocalStorage() {
  try {
    const key = getLocalObjectsKey();
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch (_) {
    return {};
  }
}

function saveLocalObjectsToLocalStorage(objByView) {
  try {
    const key = getLocalObjectsKey();
    localStorage.setItem(key, JSON.stringify(objByView || {}));
  } catch (_) {}
}

/**
 * Unified local object map: anon → device DB (IndexedDB); signed-in → per-user JSON cache in localStorage.
 * Cloud remains authoritative when signed in; this is replica/offline-shaped cache for the device.
 */
async function getLocalObjectByViewMap() {
  if (usesIndexedDbForObjectData()) {
    if (typeof indexedDB === 'undefined') {
      return loadLocalObjectsFromLocalStorage();
    }
    try {
      const store = getActiveLocalStore();
      if (store && store.init && store.getByViewMap) {
        await store.init();
        return await store.getByViewMap();
      }
    } catch (e) {
      console.error('getLocalObjectByViewMap', e);
    }
    return loadLocalObjectsFromLocalStorage();
  }
  if (currentUser && currentUser.id) {
    return loadLocalObjectsFromLocalStorage();
  }
  if (typeof indexedDB === 'undefined') {
    return loadLocalObjectsFromLocalStorage();
  }
  try {
    if (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.init && INOUT_LOCAL_DB.getByViewMap) {
      await INOUT_LOCAL_DB.init();
      return await INOUT_LOCAL_DB.getByViewMap();
    }
  } catch (e) {
    console.error('getLocalObjectByViewMap', e);
  }
  return loadLocalObjectsFromLocalStorage();
}

async function saveLocalObjectByViewMap(objByView) {
  try {
    if (usesIndexedDbForObjectData()) {
      if (typeof indexedDB === 'undefined') {
        saveLocalObjectsToLocalStorage(objByView);
        return;
      }
      try {
        const store = getActiveLocalStore();
        if (store && store.init && store.setByViewMap) {
          await store.init();
          await store.setByViewMap(objByView || {});
          return;
        }
      } catch (e) {
        console.error('saveLocalObjectByViewMap', e);
      }
      saveLocalObjectsToLocalStorage(objByView);
      return;
    }
    if (currentUser && currentUser.id) {
      saveLocalObjectsToLocalStorage(objByView);
      return;
    }
    if (typeof indexedDB === 'undefined') {
      saveLocalObjectsToLocalStorage(objByView);
      return;
    }
    try {
      if (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.init && INOUT_LOCAL_DB.setByViewMap) {
        await INOUT_LOCAL_DB.init();
        await INOUT_LOCAL_DB.setByViewMap(objByView || {});
        return;
      }
    } catch (e) {
      console.error('saveLocalObjectByViewMap', e);
    }
    saveLocalObjectsToLocalStorage(objByView);
  } finally {
    try {
      if (typeof usesIndexedDbForObjectData === 'function' && usesIndexedDbForObjectData() &&
          typeof INOUT_FOLDER_SYNC !== 'undefined' && INOUT_FOLDER_SYNC &&
          typeof INOUT_FOLDER_SYNC.scheduleWrite === 'function') {
        INOUT_FOLDER_SYNC.scheduleWrite();
      }
    } catch (_) {}
  }
}

async function upsertLocalObjectForCurrentView(obj) {
  if (!obj || typeof obj.id === 'undefined') return;
  const byView = await getLocalObjectByViewMap();
  const key = currentView || 'main';
  const list = Array.isArray(byView[key]) ? byView[key] : [];
  const idx = list.findIndex(o => o && o.id === obj.id);
  if (idx >= 0) list[idx] = obj; else list.push(obj);
  byView[key] = list;
  await saveLocalObjectByViewMap(byView);
}

async function loadLocalObjectsForCurrentView() {
  try {
    const byView = await getLocalObjectByViewMap();
    const key = currentView || 'main';
    let list = Array.isArray(byView[key]) ? byView[key] : [];

    // Apply saved order (same mechanism as cloud, but using anon/user key)
    try {
      const raw = localStorage.getItem(ORDER_STATE_KEY);
      if (raw) {
        const map = JSON.parse(raw);
        if (map && typeof map === 'object') {
          const orderKey = getScopedViewStorageKey(key);
          const arr = Array.isArray(map[orderKey]) ? map[orderKey] : [];
          if (arr.length) list = sortObjectsByOrder(list, arr);
        }
      }
    } catch (_) {}

    const rawList = list.slice();
    list = list.map(normalizeEntryTextToJsonIfPlain);
    schedulePersistNormalizedEntries(rawList, list);
    await replaceFeedWithList(list);
  } catch (_) {
    // ignore local load errors; show empty state
  }
}

async function removeLocalObjectsFromView(ids, viewKey) {
  if (!ids || !ids.length) return;
  const byView = await getLocalObjectByViewMap();
  const key = viewKey != null ? viewKey : (currentView || 'main');
  let list = Array.isArray(byView[key]) ? byView[key] : [];
  const set = new Set(ids.map(x => Number(x)).filter(Number.isFinite));
  list = list.filter(o => !o || o.id == null ? false : !set.has(Number(o.id)));
  byView[key] = list;
  await saveLocalObjectByViewMap(byView);
}

async function removeLocalObjectsForCurrentView(ids) {
  return removeLocalObjectsFromView(ids, currentView || 'main');
}
function getDeviceId() {
  try {
    let id = localStorage.getItem(LOCAL_DEVICE_ID_KEY);
    if (!id) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        id = crypto.randomUUID();
      } else {
        id = 'dev-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);
      }
      localStorage.setItem(LOCAL_DEVICE_ID_KEY, id);
    }
    return id;
  } catch (_) {
    return 'dev-fallback-' + Date.now().toString(16);
  }
}

function hueFromStringForClipboardBubble(str) {
  var h = 2166136261 >>> 0;
  var s = String(str || '');
  for (var i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  return h % 360;
}

function clipboardBubbleDeviceLabel(deviceId) {
  var s = String(deviceId || '').replace(/-/g, '');
  if (s.length >= 4) return s.slice(0, 4).toUpperCase();
  return (s || 'DEV').slice(0, 6).toUpperCase();
}

function applyClipboardBubbleDeviceStyle() {
  if (!clipboardBubble) return;
  var id = getDeviceId();
  var hue = hueFromStringForClipboardBubble(id);
  clipboardBubble.style.setProperty('--cb-device-hue', String(hue));
  if (clipboardBubbleDeviceEl) {
    clipboardBubbleDeviceEl.textContent = clipboardBubbleDeviceLabel(id);
    clipboardBubbleDeviceEl.setAttribute('title', 'Clipboard on this device (' + id + ')');
  }
}

/** Text copied or written to the clipboard while using this app. */
function getCopiedTextFromCopyEvent(e) {
  try {
    if (e && e.clipboardData && e.clipboardData.getData) {
      var t = e.clipboardData.getData('text/plain');
      if (t != null && String(t).trim()) return String(t);
    }
  } catch (_) {}
  try {
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.toString) return sel.toString();
  } catch (_) {}
  return '';
}

function loadScrollState() {
  try {
    var raw = localStorage.getItem(SCROLL_STATE_KEY);
    if (!raw) return;
    var o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'number' && o[k] >= 0) viewScroll.set(k, o[k]);
    }
  } catch (_) {}
}
function saveScrollState() {
  try {
    var o = {};
    viewScroll.forEach(function(v, k) { o[k] = v; });
    localStorage.setItem(SCROLL_STATE_KEY, JSON.stringify(o));
  } catch (_) {}
}
const unreadCounts  = new Map();
const sharedChannels = new Set();
let channelSubs = new Map();
let membershipRealtimeSub = null;
let orderSub = null;
let viewSub  = null;
var viewRealtimeResubscribeTimer = null;
/** Bumps on each subscribeViewRealtime(); stale channel status callbacks (e.g. CLOSED after unsubscribe) are ignored. */
var viewRealtimeSubscribeGen = 0;
let viewEditingChannel = null;
let composerSyncChannel = null;
/** @type {Record<string, { objectId: number, authorName: string, ts: number }>} */
let viewEditingPresence = Object.create(null);
let viewPresencePruneTimer = null;
let layoutChannel = null;
let latestRemoteDraft = '';
let latestClipboardText = '';
let inputStateSub = null;
let inputSaveToDbTimer = null;
let inputSlotsSaveToDbTimer = null;
const INPUT_SAVE_DEBOUNCE_MS = 45;
let lastPrimaryInputEditAt = 0;
let lastSlotsEditAt = 0;
const INPUT_SYNC_MAX_LENGTH = 10000;
function capSyncText(s) {
  if (s == null) return '';
  var t = String(s);
  return t.length > INPUT_SYNC_MAX_LENGTH ? t.slice(0, INPUT_SYNC_MAX_LENGTH) : t;
}

// Register initial view from static DOM once globals (including currentView) are initialized.
views.push({
  id: 'view-0',
  channel: currentView,
  rootEl: document.getElementById('view-app'),
  get feedInner() { return feedInner; },
  objects: [],      // array of objects (or ids) belonging to this view
  config: {},       // per-view settings (layout, filters, etc.), to be filled later
});

/** Multiple composer slots: each has target (channel) and value. Primary slot (index 0) keeps id="object-input" / id="send-btn" for existing code. */
let inputSlots = [];
let primarySlotAutoTarget = true;

function loadInputSlots() {
  if (inputSlots.length > 0) return;
  try {
    const raw = localStorage.getItem(INPUT_SLOTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        inputSlots = parsed.map(normalizeSlot).filter(Boolean);
        if (inputSlots.length > 0) {
          primarySlotAutoTarget = true;
          return;
        }
      }
    }
  } catch (_) {}
  inputSlots = [{ id: 'slot-0', channel: (typeof currentChannel !== 'undefined' ? currentChannel : 'main'), value: '' }];
  primarySlotAutoTarget = true;
}
function normalizeSlot(s) {
  if (!s || typeof s !== 'object') return null;
  var id = s.id != null ? String(s.id) : 'slot-' + Date.now();
  var ch = s.channel != null ? String(s.channel) : 'main';
  var val = s.value != null ? String(s.value) : '';
  return { id: id, channel: ch, value: capSyncText(val) };
}

function saveInputSlots(opts) {
  opts = opts || {};
  try {
    localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots));
    if (!opts.skipRemote && getSyncInputPref()) scheduleSaveSlotsToDb();
  } catch (_) {}
}

function updatePrimaryInputRefs() {
  if (typeof document === 'undefined') return;
  const inp = document.getElementById('object-input');
  const btn = document.getElementById('send-btn');
  const clearBtn = document.getElementById('clear-input');
  if (inp) input = inp;
  if (btn) sendBtn = btn;
  if (clearBtn) clearInputBtn = clearBtn;
}

function renderComposerSlots() {
  if (!composerSlotsContainer) return;
  /* New #object-input / send-btn nodes need attachInputListeners; avoid treating stale DOM as still bound. */
  _inputListenersAttached = false;
  loadInputSlots();
  const channels = (typeof viewNames !== 'undefined' && Array.isArray(viewNames)) ? viewNames : ['main'];
  composerSlotsContainer.innerHTML = '';
  inputSlots.forEach((slot, index) => {
    const isPrimary = index === 0;
    const row = document.createElement('div');
    row.className = 'composer composer-slot composer-slot-bubble';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'New object');
    row.dataset.slotIndex = String(index);
    row.dataset.slotId = slot.id;
    const slotHasContent = (slot.value || '').trim().length > 0;
    row.draggable = slotHasContent;
    if (slotHasContent) {
      row.classList.add('composer-slot-draggable');
      row.addEventListener('dragstart', function(ev) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', (slot.value || '').trim());
        ev.dataTransfer.setData('application/x-inout-draft', String(index));
      });
    }

    const targetWrap = document.createElement('div');
    targetWrap.className = 'composer-slot-target';
    const targetSelect = document.createElement('select');
    targetSelect.className = 'composer-slot-target-select';
    targetSelect.setAttribute('aria-label', 'Target view');
    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = ch === 'main' ? 'Feed' : ch;
      if (ch === slot.channel) opt.selected = true;
      targetSelect.appendChild(opt);
    });
    targetWrap.appendChild(targetSelect);
    row.appendChild(targetWrap);

    const inputWrap = document.createElement('div');
    inputWrap.className = 'composer-input-wrap';
    const targetLabel = (slot.channel === 'main' ? 'Feed' : slot.channel);
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add object…';
    textarea.rows = 1;
    textarea.maxLength = 2000;
    textarea.autocomplete = 'off';
    textarea.spellcheck = false;
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('aria-label', 'Object value for ' + targetLabel);
    textarea.value = slot.value || '';
    if (isPrimary) {
      textarea.id = 'object-input';
    } else {
      textarea.className = 'composer-slot-input';
      textarea.dataset.slotIndex = String(index);
    }
    const countSpan = document.createElement('span');
    countSpan.className = 'composer-count';
    countSpan.setAttribute('aria-live', 'polite');
    if (isPrimary) countSpan.id = 'object-input-count';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'clear-input-btn';
    clearBtn.setAttribute('aria-label', 'Clear input');
    clearBtn.title = 'Clear';
    clearBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    if (isPrimary) clearBtn.id = 'clear-input';
    inputWrap.appendChild(textarea);
    inputWrap.appendChild(countSpan);
    inputWrap.appendChild(clearBtn);
    row.appendChild(inputWrap);

    const sendBtnEl = document.createElement('button');
    sendBtnEl.type = 'button';
    sendBtnEl.className = 'composer-send';
    sendBtnEl.disabled = !(slot.value || '').trim();
    sendBtnEl.setAttribute('aria-label', 'Send');
    sendBtnEl.innerHTML = '<span class="composer-send-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></span><span class="composer-send-label">Send</span>';
    if (isPrimary) sendBtnEl.id = 'send-btn';
    row.appendChild(sendBtnEl);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'composer-slot-remove';
    removeBtn.setAttribute('aria-label', 'Remove input');
    removeBtn.title = 'Remove input';
    removeBtn.textContent = '×';
    if (inputSlots.length <= 1) removeBtn.style.display = 'none';
    row.appendChild(removeBtn);

    composerSlotsContainer.appendChild(row);

    targetSelect.addEventListener('change', function() {
      const ch = this.value;
      inputSlots[index].channel = ch;
      saveInputSlots();
      if (index === 0) primarySlotAutoTarget = false;
      textarea.setAttribute('aria-label', 'Object value for ' + (ch === 'main' ? 'Feed' : ch));
    });
    textarea.addEventListener('input', function() {
      lastSlotsEditAt = Date.now();
      const val = this.value || '';
      inputSlots[index].value = val;
      saveInputSlots();
      if (typeof autoResize === 'function') autoResize(this);
      const sendB = row.querySelector('.composer-send');
      if (sendB) sendB.disabled = !val.trim();
      const clrB = row.querySelector('.clear-input-btn');
      if (clrB) clrB.disabled = !val;
      row.draggable = !!val.trim();
      row.classList.toggle('composer-slot-draggable', !!val.trim());
      if (isPrimary) {
        saveInputGlobal();
        updateClearInputBtn();
        scheduleSaveInputToDb();
        var inObjEdit = editingObjectId != null || (editingObjectIds && editingObjectIds.size > 0);
        if (sendBtn) sendBtn.disabled = inObjEdit ? false : !val.trim();
        if (editingObjectId != null) {
          if (editingObjectIds && editingObjectIds.size > 1) applyPrimaryEditToMultiEdit(val);
          else if (editingObjectTextMap && editingObjectId != null) { editingObjectTextMap[editingObjectId] = val; }
          updateEditingRowFromInput();
          if (editTypingCommitTimer) clearTimeout(editTypingCommitTimer);
          editTypingCommitTimer = setTimeout(commitTypingSegment, TYPING_COMMIT_MS);
        }
        broadcastDraft(val);
      }
    });
    textarea.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (editingObjectId) cancelEditingMode(true);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const sBtn = row.querySelector('.composer-send');
        if (sBtn && !sBtn.disabled) sendFromSlot(index);
      }
    });
    clearBtn.addEventListener('click', function() {
      if (isPrimary && editingObjectId != null) {
        cancelEditingMode(true);
        return;
      }
      textarea.value = '';
      inputSlots[index].value = '';
      saveInputSlots();
      if (typeof autoResize === 'function') autoResize(isPrimary ? input : textarea);
      const sBtn = row.querySelector('.composer-send');
      if (sBtn) sBtn.disabled = true;
      clearBtn.disabled = true;
      if (isPrimary) {
        lastPrimaryInputEditAt = 0;
        lastSlotsEditAt = 0;
        saveInputGlobal();
        updateClearInputBtn();
        broadcastDraft('');
        requestAnimationFrame(focusMainInput);
      }
    });
    sendBtnEl.addEventListener('click', function() { sendFromSlot(index); });
    removeBtn.addEventListener('click', function() { removeComposerSlot(index); });
  });
  updatePrimaryInputRefs();
  if (typeof attachInputListeners === 'function') attachInputListeners();
}

function addComposerSlot(opts) {
  loadInputSlots();
  const ch = (opts && opts.channel != null) ? opts.channel : (typeof currentChannel !== 'undefined' ? currentChannel : 'main');
  const text = (opts && opts.text != null) ? String(opts.text) : '';
  inputSlots.push({ id: 'slot-' + Date.now(), channel: ch, value: text });
  saveInputSlots();
  renderComposerSlots();
  const lastRow = composerSlotsContainer && composerSlotsContainer.querySelector('[data-slot-index="' + (inputSlots.length - 1) + '"]');
  if (lastRow) {
    const ta = lastRow.querySelector('textarea');
    if (ta) { ta.focus(); requestAnimationFrame(function() { if (ta) ta.focus(); }); }
  }
}

function removeComposerSlot(index) {
  loadInputSlots();
  if (inputSlots.length <= 1) return;
  inputSlots.splice(index, 1);
  saveInputSlots();
  renderComposerSlots();
}

async function sendFromSlot(index) {
  loadInputSlots();
  const slot = inputSlots[index];
  if (!slot) return;
  const inObjEdit =
    editingObjectId != null || (editingObjectIds != null && editingObjectIds.size > 0);
  if (inObjEdit && index === 0) {
    await send();
    return;
  }
  const text = (slot.value || '').trim();
  if (!text) return;
  const slotRow = composerSlotsContainer && composerSlotsContainer.querySelector('[data-slot-index="' + String(index) + '"]');
  const textarea = slotRow ? slotRow.querySelector('textarea') : null;
  const sendBtnEl = slotRow ? slotRow.querySelector('.composer-send') : null;
  if (textarea) textarea.disabled = true;
  if (sendBtnEl) sendBtnEl.disabled = true;
  try {
    await sendText(text, { channel: slot.channel });
  } finally {
    if (textarea) textarea.disabled = false;
  }
  if (sendBtnEl) sendBtnEl.disabled = true;
  slot.value = '';
  if (textarea) textarea.value = '';
  saveInputSlots();
  if (typeof autoResize === 'function' && textarea) autoResize(textarea);
  if (sendBtnEl) sendBtnEl.disabled = true;
  if (index === 0) {
    saveInputGlobal();
    updateClearInputBtn();
    broadcastDraft('');
  }
}

let selectMode = false;
let selectModeAutoOn = false;
/** Same Set as modeState.selectedIds — single source of truth for selection. */
const selectedIds = modeState.selectedIds;
let dragSelectActive = false;
let dragSelectStarted = false;
let dragSelectJustEnded = false;
let dragSelectToggledByTouch = false;
let dragSelectMode = 'select';
let pointerDownOnSelectArea = false;

var edgeScrollIntervalId = null;
var edgeScrollLastY = 0;
var edgeScrollLastX = 0;
var dragImageEl = null;
var lastReorderTarget = null;
function clearEdgeScrollInterval() {
  if (edgeScrollIntervalId) {
    clearInterval(edgeScrollIntervalId);
    edgeScrollIntervalId = null;
  }
}
function scrollFeedAtTouchEdge(clientY, clientX) {
  var surf = primaryFeedScrollSurface();
  if (!surf) return false;
  var feedRect = surf.getBoundingClientRect();
  var edgeZone = Math.max(56, feedRect.height * 0.2);
  var baseStep = 6;
  var maxScroll = surf.scrollHeight - surf.clientHeight;
  var inTop = clientY < feedRect.top + edgeZone;
  var inBottom = clientY > feedRect.bottom - edgeZone;
  if (typeof clientX === 'number') {
    var under = document.elementFromPoint(clientX, clientY);
    if (under && (under.closest('#manage-bar') || under.closest('#input-area'))) return false;
  }
  var closeness, step;
  if (inTop) {
    if (clientY <= feedRect.top) closeness = 1;
    else closeness = 1 - (clientY - feedRect.top) / edgeZone;
    step = baseStep * (0.5 + 2.5 * Math.min(1, closeness));
    surf.scrollTop = Math.max(0, surf.scrollTop - step);
    return true;
  }
  if (inBottom) {
    if (clientY >= feedRect.bottom) closeness = 1;
    else closeness = 1 - (feedRect.bottom - clientY) / edgeZone;
    step = baseStep * (0.5 + 2.5 * Math.min(1, closeness));
    if (maxScroll > 0) surf.scrollTop = Math.min(maxScroll, surf.scrollTop + step);
    return true;
  }
  return false;
}
function tickEdgeScroll() {
  if (!scrollFeedAtTouchEdge(edgeScrollLastY, edgeScrollLastX)) clearEdgeScrollInterval();
}
function updateEdgeScroll(clientY, clientX) {
  edgeScrollLastY = clientY;
  edgeScrollLastX = typeof clientX === 'number' ? clientX : edgeScrollLastX;
  var inZone = scrollFeedAtTouchEdge(clientY, edgeScrollLastX);
  if (inZone && !edgeScrollIntervalId) edgeScrollIntervalId = setInterval(tickEdgeScroll, 16);
  else if (!inZone) clearEdgeScrollInterval();
}

function applyDragSelectRect(feedInner, feedEl, startYContent, currentYClient, mode, startRowStates) {
  if (!feedInner || !feedEl || startYContent == null || currentYClient == null || !startRowStates) return;
  const scrollEl = getFeedScrollSurface(feedEl);
  if (!scrollEl) return;
  const feedRect = scrollEl.getBoundingClientRect();
  const scrollTop = scrollEl.scrollTop;
  const currentYContent = currentYClient - feedRect.top + scrollTop;
  const rectTop = Math.min(startYContent, currentYContent);
  const rectBottom = Math.max(startYContent, currentYContent);
  const rows = Array.from(feedInner.querySelectorAll('.obj'));
  let changed = false;
  for (const r of rows) {
    const rRect = r.getBoundingClientRect();
    const rowTop = rRect.top - feedRect.top + scrollTop;
    const rowBottom = rowTop + rRect.height;
    const overlaps = rowBottom > rectTop && rowTop < rectBottom;
    const desired = overlaps ? (mode === 'select') : (startRowStates.get(r) ?? false);
    const box = r.querySelector('.obj-select');
    const id = r.dataset.id != null ? Number(r.dataset.id) : NaN;
    if (!box || !Number.isFinite(id)) continue;
    if (box.checked === desired) continue;
    box.checked = desired;
    if (box.checked) {
      selectedIds.add(id);
      r.classList.add('obj-selected');
    } else {
      selectedIds.delete(id);
      r.classList.remove('obj-selected');
    }
    changed = true;
  }
  if (changed) updateSelectionUI();
}

function toggleRowAtY(feedInner, clientY) {
  if (!feedInner) return;
  const rows = Array.from(feedInner.querySelectorAll('.obj'));
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      const box = r.querySelector('.obj-select');
      const id = r.dataset.id != null ? Number(r.dataset.id) : NaN;
      if (!box || !Number.isFinite(id)) continue;
      box.checked = !box.checked;
      if (box.checked) {
        selectedIds.add(id);
        r.classList.add('obj-selected');
      } else {
        selectedIds.delete(id);
        r.classList.remove('obj-selected');
      }
      updateSelectionUI();
      return;
    }
  }
}
let editingObjectId = null;
/** When multiple objects are selected and user edits, each row shows its own value with same cursor/selection; edits (insert/delete) apply at the same position to all. */
let editingObjectIds = null;
/** Per-id current draft text during multi-edit (each object keeps its own value; same edit op applied to all). */
var editingObjectTextMap = null;
let originalEditTextForCancel = null;
/** Per-id original text when cancelling multi-edit. */
var originalEditTextForCancelMap = null;
var editTypingUndoStack = [];
var editTypingCommitTimer = null;
var TYPING_COMMIT_MS = 1800;
var MAX_TYPING_UNDO = 20;
let fieldPrefs = { showTime:true, showAuthor:true, showLabels:true };
let undoStack = [];
let actionLog = [];
let actionLogSub = null;
let logErrorSignalTimer = null;
/* Create table in Supabase SQL editor for realtime log across devices:
create table if not exists action_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  device_id text not null,
  created_at timestamptz default now(),
  type text not null,
  action text not null,
  details jsonb default '{}',
  message text
);
alter table action_log enable row level security;
create policy "Users can manage own action_log" on action_log for all using (auth.uid() = user_id);
alter publication supabase_realtime add table action_log;
*/

/* Optional: persist main input per user+channel for cross-device sync. Run in Supabase SQL editor if you use "Sync input across devices":
create table if not exists user_input_state (
  user_id uuid references auth.users(id) on delete cascade not null,
  channel text not null default 'main',
  text text not null default '',
  updated_at timestamptz default now(),
  device_id text,
  primary key (user_id, channel)
);
alter table user_input_state enable row level security;
create policy "Users manage own input state" on user_input_state for all using (auth.uid() = user_id);
alter publication supabase_realtime add table user_input_state;
*/

function logAction(action, details, opts) {
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    deviceId: myId,
    userId: currentUser ? currentUser.id : null,
    type: 'action',
    action: action || 'unknown',
    details: details || {},
    fromThisDevice: true,
  };
  actionLog.unshift(entry);
  if (actionLog.length > 100) {
    const removed = actionLog.pop();
    if (currentUser && removed?.id) {
      try { sb.from('action_log').delete().eq('user_id', currentUser.id).eq('id', removed.id).then(() => {}).catch(() => {}); } catch (_) {}
    }
  }
  updateLogBadge();
  // Remote action_log table is optional; skip network writes to avoid 404 spam.
}

function logError(message) {
  const entry = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    deviceId: myId,
    userId: currentUser ? currentUser.id : null,
    type: 'error',
    action: 'error',
    message: typeof message === 'string' ? message : String(message),
    fromThisDevice: true,
  };
  actionLog.unshift(entry);
  if (actionLog.length > 100) {
    const removed = actionLog.pop();
    if (currentUser && removed?.id) {
      try { sb.from('action_log').delete().eq('user_id', currentUser.id).eq('id', removed.id).then(() => {}).catch(() => {}); } catch (_) {}
    }
  }
  updateLogBadge();
  /* Remote action_log is optional (same as logAction); skip insert to avoid 404 when table missing. */
}

function updateLogBadge() {
  if (!logActionBtn) return;
  const last = actionLog[0];
  const isError = last && last.type === 'error';
  const label = last
    ? (last.message ? String(last.message).slice(0, 36) + (last.message.length > 36 ? '…' : '') : (last.action || last.type || 'event'))
    : 'No events';
  logActionBtn.textContent = label;
  logActionBtn.classList.remove('error-signal', 'error-signal-faded');
  if (isError) {
    logActionBtn.classList.add('error-signal');
    clearTimeout(logErrorSignalTimer);
    logErrorSignalTimer = setTimeout(() => {
      if (logActionBtn) {
        logActionBtn.classList.remove('error-signal');
        logActionBtn.classList.add('error-signal-faded');
      }
    }, 5000);
  }
}

function renderLogDropup() {
  if (!logDropupBody) return;
  logDropupBody.innerHTML = '';
  if (!actionLog.length) {
    logDropupBody.innerHTML = '<p style="padding:10px;color:var(--muted);font-size:11px;">No events yet.</p>';
    return;
  }
  actionLog.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'log-event-card' + (entry.fromThisDevice ? ' from-this-device' : '') + (entry.type === 'error' ? ' error' : '');
    const timeStr = new Date(entry.ts).toLocaleTimeString();
    const actionLabel = entry.action || entry.type;
    const deviceLabel = entry.fromThisDevice ? 'This device' : 'Other device';
    card.innerHTML =
      '<span class="log-event-time">' + escapeHtml(timeStr) + '</span>' +
      '<div class="log-event-body">' +
        '<div class="log-event-device">' + escapeHtml(deviceLabel) + '</div>' +
        '<div class="log-event-action">' + escapeHtml(actionLabel) + '</div>' +
        (entry.message ? '<div class="log-event-message">' + escapeHtml(entry.message) + '</div>' : '') +
      '</div>';
    logDropupBody.appendChild(card);
  });
}

var VIEWPORT_MARGIN = 8;

/**
 * Position a fixed panel (right- or left-aligned to anchor), clamped inside the viewport.
 * @param {DOMRect} anchorRect
 * @param {HTMLElement} el
 * @param {{ gap?: number, margin?: number, maxHeightCap?: number, zIndex?: number, allowFlip?: boolean, align?: 'left'|'right' }} [options]
 */
function positionFixedDropdownClamped(anchorRect, el, options) {
  options = options || {};
  var margin = options.margin != null ? options.margin : VIEWPORT_MARGIN;
  var gap = options.gap != null ? options.gap : 4;
  var maxHeightCap = options.maxHeightCap != null ? options.maxHeightCap : 320;
  var zIndex = options.zIndex != null ? options.zIndex : 3500;
  var allowFlip = options.allowFlip !== false;
  var align = options.align === 'left' ? 'left' : 'right';
  if (!el || !anchorRect) return;
  el.style.position = 'fixed';
  el.style.zIndex = String(zIndex);
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  var top = Math.round(anchorRect.bottom + gap);
  el.style.top = top + 'px';
  el.style.left = 'auto';
  function apply() {
    var er = el.getBoundingClientRect();
    var ew = er.width;
    var eh = er.height;
    var left = align === 'left' ? anchorRect.left : anchorRect.right - ew;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - ew));
    el.style.left = Math.round(left) + 'px';
    var y = top;
    var spaceBelow = window.innerHeight - y - margin;
    var spaceAbove = anchorRect.top - margin;
    if (allowFlip && spaceBelow < Math.min(96, eh) && spaceAbove > spaceBelow) {
      y = Math.round(anchorRect.top - gap - eh);
      if (y < margin) y = margin;
    }
    el.style.top = y + 'px';
    var avail = window.innerHeight - margin - y;
    avail = Math.min(maxHeightCap, Math.max(40, avail));
    el.style.maxHeight = Math.floor(avail) + 'px';
    el.style.overflowY = 'auto';
  }
  requestAnimationFrame(apply);
}

function clearViewMenuInlinePosition() {
  if (!viewMenu) return;
  viewMenu.style.top = '';
  viewMenu.style.left = '';
  viewMenu.style.right = '';
  viewMenu.style.bottom = '';
  viewMenu.style.maxHeight = '';
  viewMenu.style.overflowY = '';
}

function positionViewMenuClamp() {
  if (!viewToggleBtn || !viewMenu) return;
  positionFixedDropdownClamped(viewToggleBtn.getBoundingClientRect(), viewMenu, {
    gap: 4,
    maxHeightCap: 320,
    zIndex: 130
  });
}

function clearManageBarDropdownPosition() {
  var dd = document.querySelector('.manage-bar-dropdown');
  if (!dd) return;
  dd.style.position = '';
  dd.style.top = '';
  dd.style.left = '';
  dd.style.right = '';
  dd.style.bottom = '';
  dd.style.zIndex = '';
  dd.style.maxHeight = '';
  dd.style.overflowY = '';
  var bs = dd.querySelector('.bar-scroll');
  if (bs) bs.style.maxHeight = '';
}

function positionManageBarDropdownClamp() {
  var mb = document.getElementById('manage-bar');
  var mbt = document.getElementById('manage-bar-trigger');
  var dd = mb && mb.querySelector('.manage-bar-dropdown');
  if (!mb || !mbt || !dd || !mb.classList.contains('manage-bar-open')) return;
  var r = mbt.getBoundingClientRect();
  var m = VIEWPORT_MARGIN;
  dd.style.position = 'fixed';
  dd.style.zIndex = '1200';
  dd.style.right = 'auto';
  dd.style.bottom = 'auto';
  var top = Math.round(r.bottom + 4);
  dd.style.top = top + 'px';
  dd.style.left = 'auto';
  requestAnimationFrame(function() {
    var dr = dd.getBoundingClientRect();
    var dw = dr.width;
    var left = r.right - dw;
    left = Math.max(m, Math.min(left, window.innerWidth - m - dw));
    dd.style.left = Math.round(left) + 'px';
    var y = top;
    var eh = dr.height;
    var spaceBelow = window.innerHeight - y - m;
    var spaceAbove = r.top - m;
    if (spaceBelow < Math.min(96, eh) && spaceAbove > spaceBelow) {
      y = Math.round(r.top - 4 - eh);
      if (y < m) y = m;
    }
    dd.style.top = y + 'px';
    var avail = window.innerHeight - m - y;
    var cap = Math.min(0.7 * window.innerHeight, Math.max(120, avail));
    var barScroll = dd.querySelector('.bar-scroll');
    if (barScroll) barScroll.style.maxHeight = Math.floor(cap) + 'px';
  });
}

function positionMultiValueFilterMenuClamp() {
  var trig = document.getElementById('multi-value-filter-trigger');
  var menu = document.getElementById('multi-value-filter-menu');
  if (!trig || !menu || menu.hidden) return;
  positionFixedDropdownClamped(trig.getBoundingClientRect(), menu, {
    align: 'left',
    gap: 4,
    maxHeightCap: 280,
    zIndex: 1190
  });
}

function repositionOpenDropdownsToViewport() {
  try {
    if (viewMenu && viewMenu.classList.contains('open') && viewToggleBtn) {
      positionViewMenuClamp();
    }
    var mb = document.getElementById('manage-bar');
    var mbt = document.getElementById('manage-bar-trigger');
    if (mb && mbt && mb.classList.contains('manage-bar-open')) {
      positionManageBarDropdownClamp();
    }
    var mv = document.getElementById('multi-value-filter-menu');
    var mvt = document.getElementById('multi-value-filter-trigger');
    if (mv && mvt && !mv.hidden) {
      positionMultiValueFilterMenuClamp();
    }
    document.querySelectorAll('.obj-actions.obj-actions-open').forEach(function(actions) {
      var trig = actions.querySelector('.obj-actions-trigger');
      var dd = actions.querySelector('.obj-actions-dropdown');
      if (trig && dd) {
        positionFixedDropdownClamped(trig.getBoundingClientRect(), dd, {
          gap: 2,
          maxHeightCap: 320,
          zIndex: 3500
        });
      }
    });
    if (logDropupPanel && logDropupPanel.classList.contains('open') && logActionBtn) {
      positionLogDropupPanelFixed();
    }
  } catch (_) {}
}

function positionLogDropupPanelFixed() {
  if (!logDropupPanel || !logActionBtn) return;
  if (!logActionBtn.closest || !logActionBtn.closest('.manage-log-in-menu')) return;
  var r = logActionBtn.getBoundingClientRect();
  var w = Math.min(320, Math.max(200, window.innerWidth - 16));
  var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  var top = r.bottom + 4;
  var maxH = Math.min(280, Math.max(120, window.innerHeight - top - 12));
  logDropupPanel.classList.add('log-dropup-panel-fixed');
  logDropupPanel.style.left = left + 'px';
  logDropupPanel.style.top = top + 'px';
  logDropupPanel.style.width = w + 'px';
  logDropupPanel.style.maxHeight = maxH + 'px';
}

function clearLogDropupPanelFixed() {
  if (!logDropupPanel) return;
  logDropupPanel.classList.remove('log-dropup-panel-fixed');
  logDropupPanel.style.left = '';
  logDropupPanel.style.top = '';
  logDropupPanel.style.width = '';
  logDropupPanel.style.maxHeight = '';
}

function openLogDropup() {
  if (!logDropupPanel) return;
  renderLogDropup();
  logDropupPanel.classList.add('open');
  positionLogDropupPanelFixed();
  if (logActionBtn) logActionBtn.setAttribute('aria-expanded', 'true');
  console.debug('[inout] Action log opened');
  notifyWorkspaceChromeChanged();
}

function closeLogDropup() {
  if (!logDropupPanel) return;
  logDropupPanel.classList.remove('open');
  clearLogDropupPanelFixed();
  if (logActionBtn) logActionBtn.setAttribute('aria-expanded', 'false');
  notifyWorkspaceChromeChanged();
}

function pushUndo(action) {
  if (!action) return;
  undoStack.push(action);
  if (undoStack.length > 50) undoStack.shift();
}

async function undoLastAction() {
  if (!shouldUseServerForObjects()) {
    toast('Undo isn’t available for local object storage yet.');
    return;
  }
  if (!currentUser) {
    toast('Sign in to undo.');
    return;
  }
  const action = undoStack.pop();
  if (!action) {
    toast('Nothing to undo.');
    return;
  }
  try {
    if (action.type === 'delete' && Array.isArray(action.entries) && action.entries.length) {
      const rows = action.entries.map(e => ({
        id: e.id,
        created_at: e.created_at,
        text: e.text,
        channel: e.channel,
        user_id: e.user_id,
        author_name: e.author_name ?? null,
      }));
      const { error } = await sb.from(OBJECTS_TABLE).insert(rows);
      if (error) throw error;
      if (feedEl) feedEl.classList.add('feed-updating');
      requestAnimationFrame(() => {
        const frag = document.createDocumentFragment();
        rows.forEach(e => {
          const row = createObjectRow(e, false);
          if (row) {
            frag.appendChild(row);
            if (e.id != null) currentObjectOrder.push(e.id);
            objectCount++;
          }
        });
        feedInner.appendChild(frag);
        updateObjectCount();
        saveObjectOrderForCurrentView();
        applyFieldPrefsToObjects();
        showEmptyIfNoObjects();
        requestAnimationFrame(() => { if (feedEl) feedEl.classList.remove('feed-updating'); });
      });
    } else if (action.type === 'move' && Array.isArray(action.entries) && action.entries.length) {
      const rows = action.entries;
      await Promise.all(rows.map(e => {
        return sb
          .from(OBJECTS_TABLE)
          .update({ channel: e.channel, created_at: e.created_at })
          .eq('user_id', currentUser.id)
          .eq('id', e.id);
      }));
      const forCurrent = rows.filter(e => e.channel === currentChannel);
      if (feedEl) feedEl.classList.add('feed-updating');
      requestAnimationFrame(() => {
        const frag = document.createDocumentFragment();
        forCurrent.forEach(e => {
          const row = createObjectRow(e, false);
          if (row) {
            frag.appendChild(row);
            if (e.id != null) currentObjectOrder.push(e.id);
            objectCount++;
          }
        });
        if (frag.childNodes.length) feedInner.appendChild(frag);
        if (forCurrent.length) {
          saveObjectOrderForCurrentView();
          applyObjectOrderToDOM();
          applyFieldPrefsToObjects();
        }
        showEmptyIfNoObjects();
        requestAnimationFrame(() => { if (feedEl) feedEl.classList.remove('feed-updating'); });
      });
    } else if (action.type === 'send' && Array.isArray(action.entries) && action.entries.length) {
      const ids = action.entries.map(e => e.id).filter(Boolean);
      if (ids.length) {
        const { error } = await sb.from(OBJECTS_TABLE).delete().in('id', ids);
        if (error) throw error;
      }
      if (feedEl) feedEl.classList.add('feed-updating');
      requestAnimationFrame(() => {
        ids.forEach(id => {
          const el = feedInner.querySelector('.obj[data-id="' + CSS.escape(String(id)) + '"]');
          if (el) el.remove();
        });
        currentObjectOrder = currentObjectOrder.filter(x => !ids.includes(x));
        objectCount = Math.max(0, objectCount - ids.length);
        updateObjectCount();
        saveObjectOrderForCurrentView();
        showEmptyIfNoObjects();
        requestAnimationFrame(() => { if (feedEl) feedEl.classList.remove('feed-updating'); });
      });
    } else if (action.type === 'edit' && Array.isArray(action.entries) && action.entries.length) {
      const rows = action.entries;
      await Promise.all(rows.map(e => {
        return sb
          .from(OBJECTS_TABLE)
          .update({ text: e.beforeText })
          .eq('user_id', currentUser.id)
          .eq('id', e.id);
      }));
      rows.forEach(e => { updateObjectRowText(e.id, e.beforeText); });
      if (typeof syncFeedMultiValueChrome === 'function') syncFeedMultiValueChrome(feedInner);
      toast('Undid last action.');
      return;
    } else if (action.type === 'view' && action.before && action.channel) {
      if (action.channel !== currentChannel) {
        currentChannel = action.channel;
      }
      fieldPrefs = {
        showTime: !!action.before.showTime,
        showAuthor: !!action.before.showAuthor,
        showLabels: typeof action.before.showLabels === 'boolean' ? action.before.showLabels : true,
      };
      saveFieldPrefsForCurrentChannel();
      applyFieldPrefsUI();
      loadObjects().catch(() => {});
      return;
    } else if (action.type === 'order' && Array.isArray(action.before)) {
      currentObjectOrder = action.before.slice();
      await saveObjectOrderForCurrentView();
      applyObjectOrderToDOM();
      toast('Undid last action.');
      return;
    } else {
      // Unknown or empty action; nothing to do.
      return;
    }
    toast('Undid last action.');
  } catch (e) {
    console.error(e);
    toast('Undo failed — ' + humanError(e.message));
  }
}

function updateEditingRowHighlight() {
  views.forEach(view => {
    const inner = view && view.feedInner;
    if (inner) inner.querySelectorAll('.obj.obj-editing').forEach(r => r.classList.remove('obj-editing'));
  });
  const ids = editingObjectIds && editingObjectIds.size ? editingObjectIds : (editingObjectId != null ? [editingObjectId] : []);
  ids.forEach(id => {
    const row = findObjectRowEl(id);
    if (row) row.classList.add('obj-editing');
  });
}

function restoreEditingRowsOnCancel() {
  if (editingObjectIds && originalEditTextForCancelMap) {
    editingObjectIds.forEach(id => {
      const text = originalEditTextForCancelMap[id];
      if (text !== undefined) updateObjectRowText(id, text);
    });
  } else if (editingObjectId != null && originalEditTextForCancel != null) {
    updateObjectRowText(editingObjectId, originalEditTextForCancel);
  }
}

/** Input mode is default and reactivates after every operation; only edit mode interrupts it. */
function reactivateInputMode(opts) {
  opts = opts || {};
  teardownMultiValueObjectEditInputs();
  var idsToEndPresence =
    editingObjectIds && editingObjectIds.size
      ? Array.from(editingObjectIds)
      : editingObjectId != null
        ? [editingObjectId]
        : [];
  idsToEndPresence.forEach(function(oid) {
    broadcastViewEditingEnd(oid);
  });
  restoreEditingRowsOnCancel();
  originalEditTextForCancel = null;
  originalEditTextForCancelMap = null;
  editingObjectTextMap = null;
  editingObjectId = null;
  editingObjectIds = null;
  editTypingUndoStack = [];
  if (editTypingCommitTimer) {
    clearTimeout(editTypingCommitTimer);
    editTypingCommitTimer = null;
  }
  try { localStorage.removeItem(WAS_EDITING_KEY); } catch (_) {}
  if (input) {
    input.placeholder = 'Add object…';
    if (opts.clearInput) {
      input.value = '';
      saveInputGlobal();
      broadcastDraft('');
      /* Cleared composer = no in-flight local typing to protect; allow cross-device slot/input_state merges immediately. */
      lastPrimaryInputEditAt = 0;
      lastSlotsEditAt = 0;
    }
    autoResize();
    sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
  }
  updateEditingRowHighlight();
  if (currentUser && sb && sb.from && getSyncInputPref()) {
    try {
      if (inputSaveToDbTimer) {
        clearTimeout(inputSaveToDbTimer);
        inputSaveToDbTimer = null;
      }
      saveInputToDb();
    } catch (_) {}
  }
  focusMainInput();
}

function cancelEditingMode(clearInput) {
  modeState.editing.active = false;
  modeState.editing.primaryId = null;
  modeState.editing.ids = null;
  if (currentMode === Modes.EDIT) {
    currentMode = selectMode ? Modes.SELECT : Modes.NORMAL;
    document.body.dataset.mode = currentMode;
  }
  reactivateInputMode({ clearInput: !!clearInput });
}
let currentObjectOrder = [];
let touchDragState = null; // for mobile long-press drag
let dragDropHandled = false;
let savedOrderBeforeDrag = [];
var dragSelectedRows = [];
var originGhostRows = [];
var draggedRowsStored = [];
var originGhostsActive = false;
var lastDropInsertBefore = null;
var lastWantAppend = false;
var originInsertBefore = null;
var dndOriginInsertBefore = null;
var dndOriginWantAppend = false;
var dndOriginLineY = null;
var dndStackFormTimer = null;
let feedDropIndicatorEl = null;
let feedDropOriginEl = null;
/** HTML5 drag: reorder/move value slots between objects (same channel / feed pane only). */
const VALUE_DND_MIME = 'application/x-inout-value-dnd';
var valueDnDActive = false;
var valueDnDSourceCell = null;
var valueDnDHoverCell = null;

function channelKeyForRowEl(row) {
  if (!row) return String(currentChannel || 'main');
  var ds = row.getAttribute('data-object-channel');
  if (ds != null && String(ds) !== '') return String(ds);
  return String(currentChannel || 'main');
}

function moveValueSlotInParts(parts, fromIdx, toIdx) {
  var p = parts.map(function(x) { return String(x != null ? x : ''); });
  if (fromIdx < 0 || fromIdx >= p.length) return p;
  if (toIdx < 0) toIdx = 0;
  if (toIdx > p.length) toIdx = p.length;
  if (fromIdx === toIdx) return p;
  var x = p.splice(fromIdx, 1)[0];
  if (fromIdx < toIdx) toIdx--;
  p.splice(toIdx, 0, x);
  return p;
}

function clearValueDnDHoverClass() {
  if (valueDnDHoverCell) {
    valueDnDHoverCell.classList.remove('obj-value-dnd-over');
    valueDnDHoverCell = null;
  }
}

function updateValueDnDHoverFromPoint(clientX, clientY) {
  var el = document.elementFromPoint(clientX, clientY);
  var cell = el && el.closest && el.closest('.obj-value-cell');
  if (cell === valueDnDHoverCell) return;
  clearValueDnDHoverClass();
  valueDnDHoverCell = cell;
  if (valueDnDHoverCell) valueDnDHoverCell.classList.add('obj-value-dnd-over');
}

async function performValueSlotDnDDrop(e, rawPayload) {
  var src;
  try {
    src = JSON.parse(rawPayload);
  } catch (_) {
    return false;
  }
  var idS = Number(src.id);
  var viS = parseInt(src.vi, 10);
  var chS = src.ch != null ? String(src.ch) : String(currentChannel || 'main');
  if (!Number.isFinite(idS) || !Number.isFinite(viS)) return false;
  var el = document.elementFromPoint(e.clientX, e.clientY);
  var tgtCell = el && el.closest && el.closest('.obj-value-cell');
  if (!tgtCell) return false;
  var tgtRow = tgtCell.closest('.obj');
  if (!tgtRow || tgtRow.dataset.id == null) return false;
  var idT = Number(tgtRow.dataset.id);
  var viT = parseInt(tgtCell.dataset.valueIndex || '0', 10);
  if (!Number.isFinite(idT) || !Number.isFinite(viT)) return false;
  if (idS === idT && viS === viT) return true;
  var chT = channelKeyForRowEl(tgtRow);
  if (chS !== chT) {
    toast('Move values within the same channel only.');
    return true;
  }
  var srcRow = findObjectRowEl(idS);
  if (!srcRow) return false;
  if (idS === idT) {
    var parts = partsFromRowDom(srcRow).map(function(x) { return String(x != null ? x : ''); });
    if (viS < 0 || viS >= parts.length) return false;
    var rawSame = getLastKnownEntryTextForChannel(chS, idS);
    var paySame =
      rawSame != null ? parseObjectTextPayload(rawSame) : { parts: parts.slice(), labels: null };
    var labsSame = labelsAlignedToNewPartCount(paySame, parts.length);
    parts = moveValueSlotInParts(parts, viS, viT);
    labsSame = moveValueSlotInLabels(labsSame, viS, viT);
    var ok = await persistObjectTextPayload(idS, serializeObjectParts(parts, labsSame), chS);
    if (!ok) toast('Could not reorder values.');
  } else {
    var srcParts = partsFromRowDom(srcRow).map(function(x) { return String(x != null ? x : ''); });
    var tgtParts = partsFromRowDom(tgtRow).map(function(x) { return String(x != null ? x : ''); });
    if (viS < 0 || viS >= srcParts.length) return false;
    viT = Math.max(0, Math.min(viT, tgtParts.length));
    var rawSrc = getLastKnownEntryTextForChannel(chS, idS);
    var rawTgt = getLastKnownEntryTextForChannel(chT, idT);
    var paySrc =
      rawSrc != null ? parseObjectTextPayload(rawSrc) : { parts: srcParts.slice(), labels: null };
    var payTgt =
      rawTgt != null ? parseObjectTextPayload(rawTgt) : { parts: tgtParts.slice(), labels: null };
    var srcLab = labelsAlignedToNewPartCount(paySrc, srcParts.length);
    var tgtLab = labelsAlignedToNewPartCount(payTgt, tgtParts.length);
    var movedLab = srcLab[viS];
    var piece = srcParts[viS];
    srcParts.splice(viS, 1);
    srcLab.splice(viS, 1);
    if (srcParts.length === 0) srcParts = [''];
    if (srcLab.length === 0) srcLab = [defaultValueColumnHeaderLabel(0)];
    tgtParts.splice(viT, 0, piece);
    tgtLab.splice(viT, 0, movedLab);
    var ok1 = await persistObjectTextPayload(idS, serializeObjectParts(srcParts, srcLab), chS);
    var ok2 = await persistObjectTextPayload(idT, serializeObjectParts(tgtParts, tgtLab), chT);
    if (!ok1 || !ok2) toast('Could not move value.');
  }
  if (feedInner) syncFeedMultiValueChrome(feedInner);
  if (typeof applyFieldPrefsToObjects === 'function') applyFieldPrefsToObjects(true);
  return true;
}

function getDraggingRowAndSource() {
  const fromPrimary = feedInner && feedInner.querySelector('.obj.dragging');
  if (fromPrimary) return { row: fromPrimary, feedInner: feedInner, channel: currentChannel };
  return null;
}

function setupInputAreaDropTarget() {
  const zone = document.getElementById('input-area');
  if (!zone) return;
  const slotsContainer = document.getElementById('composer-slots-container');
  if (slotsContainer) {
    slotsContainer.addEventListener('dragover', function(e) {
      if (!e.dataTransfer.types.includes('application/x-inout-draft')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const slotRow = e.target && e.target.closest && e.target.closest('.composer-slot');
      slotsContainer.querySelectorAll('.composer-slot-drop-before').forEach(function(el) { el.classList.remove('composer-slot-drop-before'); });
      slotsContainer.querySelectorAll('.composer-slot-drop-after').forEach(function(el) { el.classList.remove('composer-slot-drop-after'); });
      if (slotRow) {
        const rect = slotRow.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) slotRow.classList.add('composer-slot-drop-before');
        else slotRow.classList.add('composer-slot-drop-after');
      }
    });
    slotsContainer.addEventListener('dragleave', function(e) {
      if (!slotsContainer.contains(e.relatedTarget)) {
        slotsContainer.querySelectorAll('.composer-slot-drop-before').forEach(function(el) { el.classList.remove('composer-slot-drop-before'); });
        slotsContainer.querySelectorAll('.composer-slot-drop-after').forEach(function(el) { el.classList.remove('composer-slot-drop-after'); });
      }
    });
    slotsContainer.addEventListener('drop', function(e) {
      slotsContainer.querySelectorAll('.composer-slot-drop-before').forEach(function(el) { el.classList.remove('composer-slot-drop-before'); });
      slotsContainer.querySelectorAll('.composer-slot-drop-after').forEach(function(el) { el.classList.remove('composer-slot-drop-after'); });
      const draftIndex = e.dataTransfer.getData('application/x-inout-draft');
      if (draftIndex === '' || draftIndex == null) return;
      const draggedIndex = parseInt(draftIndex, 10);
      if (!Number.isFinite(draggedIndex) || !inputSlots[draggedIndex]) return;
      e.preventDefault();
      e.stopPropagation();
      const slotRow = e.target && e.target.closest && e.target.closest('.composer-slot');
      let dropIndex = draggedIndex;
      if (slotRow) {
        const targetIndex = parseInt(slotRow.dataset.slotIndex, 10);
        if (Number.isFinite(targetIndex)) {
          const rect = slotRow.getBoundingClientRect();
          dropIndex = e.clientY < rect.top + rect.height / 2 ? targetIndex : targetIndex + 1;
        }
      } else {
        dropIndex = inputSlots.length;
      }
      if (dropIndex === draggedIndex) return;
      const removed = inputSlots.splice(draggedIndex, 1)[0];
      const insertAt = dropIndex > draggedIndex ? dropIndex - 1 : dropIndex;
      inputSlots.splice(insertAt, 0, removed);
      saveInputSlots();
      renderComposerSlots();
    });
  }
  zone.addEventListener('dragover', function(e) {
    const id = e.dataTransfer.getData('application/x-inout-obj-id');
    if (!id && !e.dataTransfer.types.includes('application/x-inout-obj-id')) return;
    const src = getDraggingRowAndSource();
    if (!src) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('input-area-drag-over');
  });
  zone.addEventListener('dragleave', function(e) {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('input-area-drag-over');
  });
  zone.addEventListener('drop', function(e) {
    zone.classList.remove('input-area-drag-over');
    const id = e.dataTransfer.getData('application/x-inout-obj-id');
    const numId = Number(id);
    const text = (e.dataTransfer.getData('text/plain') || '').trim();
    const src = getDraggingRowAndSource();
    if (!Number.isFinite(numId) || !text) return;
    e.preventDefault();
    e.stopPropagation();
    dragDropHandled = true;
    const fromChannel = src ? src.channel : currentChannel;
    addComposerSlot({ text: text, channel: fromChannel });
    deleteSingleObject(numId, fromChannel);
    if (src && src.row && src.row.parentNode) {
      src.row.parentNode.removeChild(src.row);
      if (src.channel === currentChannel) {
        currentObjectOrder = currentObjectOrder.filter(x => x !== numId);
        saveObjectOrderForCurrentView();
        showEmptyIfNoObjects();
      }
    }
  });
}

var originContentTop = null;
var originContentHeight = null;
var originGhostOverlayEl = null;
function updateOriginLinePosition() {
  if (!feedEl || !feedInner || !feedDropOriginEl) return;
  var ghost = originGhostRows && originGhostRows[0];
  if (!ghost || !ghost.getBoundingClientRect) return;
  var surf = getFeedScrollSurface(feedEl);
  if (!surf) return;
  var surfRect = surf.getBoundingClientRect();
  var gRect = ghost.getBoundingClientRect();
  var margin = 2;
  var topPx, heightPx = 2;
  if (gRect.bottom < surfRect.top + margin) {
    feedDropOriginEl.classList.add('stuck');
    topPx = surfRect.top;
  } else if (gRect.top > surfRect.bottom - margin) {
    feedDropOriginEl.classList.add('stuck');
    topPx = surfRect.bottom - 2;
  } else {
    feedDropOriginEl.classList.remove('stuck');
    topPx = gRect.top;
  }
  feedDropOriginEl.style.left = surfRect.left + 'px';
  feedDropOriginEl.style.width = surfRect.width + 'px';
  feedDropOriginEl.style.top = topPx + 'px';
  feedDropOriginEl.style.height = heightPx + 'px';
  feedDropOriginEl.classList.add('visible');
}
function showDropOriginLine() {}
function hideDropOriginLine() { originContentTop = null; originContentHeight = null; }
function showOriginGhostOverlay(block) {}
function removeOriginGhostOverlay() { originGhostOverlayEl = null; }
function createOriginGhostFromRow(row) {
  if (!row || typeof row.cloneNode !== 'function') return row;
  var clone = row.cloneNode(true);
  clone.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
  clone.removeAttribute('draggable');
  clone.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  });
  return clone;
}
function removeOriginGhostsAndInsertRows() {
  if (!originGhostsActive || !feedInner || !feedEl) return;
  var surf = getFeedScrollSurface(feedEl);
  var scrollTop = surf ? surf.scrollTop : 0;
  var insertBefore = lastDropInsertBefore;
  if (!insertBefore && !lastWantAppend && originInsertBefore) insertBefore = originInsertBefore;
  if (draggedRowsStored.length) {
    if (insertBefore && insertBefore.parentNode === feedInner) {
      feedInner.insertBefore(draggedRowsStored[0], insertBefore);
      for (var i = 1; i < draggedRowsStored.length; i++) feedInner.insertBefore(draggedRowsStored[i], draggedRowsStored[i - 1].nextSibling);
    } else {
      draggedRowsStored.forEach(function(r) { feedInner.appendChild(r); });
    }
  }
  originGhostRows.forEach(function(g) { if (g.parentNode) g.parentNode.removeChild(g); });
  originGhostRows = [];
  draggedRowsStored = [];
  originGhostsActive = false;
  lastDropInsertBefore = null;
  lastWantAppend = false;
  originInsertBefore = null;
  if (surf) surf.scrollTop = scrollTop;
}
function focusMainInput() {
  if (multiValueEditInputs && multiValueEditInputs.active) {
    var list = multiValueEditInputs.textareas || [];
    var idx = Math.max(0, Math.min(list.length - 1, multiValueEditInputs.focusIndex || 0));
    var ta = list[idx] || list[0];
    if (ta) {
      try { ta.focus({ preventScroll: true }); } catch (_) { try { ta.focus(); } catch (_) {} }
      return;
    }
  }
  if (input) input.focus();
}

var multiValueEditInputs = {
  active: false,
  container: null,
  textareas: [],
  focusIndex: 0,
};

function teardownMultiValueObjectEditInputs() {
  if (input) input.style.removeProperty('display');
  if (multiValueEditInputs.container && multiValueEditInputs.container.parentNode) {
    multiValueEditInputs.container.parentNode.removeChild(multiValueEditInputs.container);
  }
  multiValueEditInputs.active = false;
  multiValueEditInputs.container = null;
  multiValueEditInputs.textareas = [];
  multiValueEditInputs.focusIndex = 0;
  if (composerSlotsContainer) composerSlotsContainer.classList.remove('object-edit-multi-inputs');
}

function joinedTextFromMultiValueEditInputs() {
  if (!multiValueEditInputs.active) return input ? String(input.value || '') : '';
  var list = multiValueEditInputs.textareas || [];
  if (!list.length) return '';
  return list.map(function(ta) { return String(ta && ta.value != null ? ta.value : ''); }).join('\n\n');
}

function setHiddenInputSelectionFromMultiValueEditor(idx, ta) {
  if (!input || !ta) return;
  var i = Math.max(0, Math.floor(Number(idx) || 0));
  var list = multiValueEditInputs.textareas || [];
  var pos = 0;
  for (var p = 0; p < i; p++) pos += String(list[p] && list[p].value != null ? list[p].value : '').length + 2;
  var ss = Number(ta.selectionStart || 0);
  var se = ta.selectionEnd != null ? Number(ta.selectionEnd) : ss;
  input.selectionStart = Math.max(0, pos + ss);
  input.selectionEnd = Math.max(input.selectionStart, pos + Math.max(ss, se));
}

function applyObjectEditTextFromPartsEditor() {
  if (!input || editingObjectId == null || !multiValueEditInputs.active) return;
  var joined = joinedTextFromMultiValueEditInputs();
  input.value = joined;
  if (editingObjectIds && editingObjectIds.size > 1) {
    applyPrimaryEditToMultiEdit(joined);
  } else if (editingObjectTextMap && editingObjectId != null) {
    editingObjectTextMap[editingObjectId] = joined;
  }
  saveInputGlobal();
  updateClearInputBtn();
  scheduleSaveInputToDb();
  if (sendBtn) sendBtn.disabled = false;
  updateEditingRowFromInput();
  if (editTypingCommitTimer) clearTimeout(editTypingCommitTimer);
  editTypingCommitTimer = setTimeout(commitTypingSegment, TYPING_COMMIT_MS);
  broadcastDraft(input.value);
}

function renderMultiValueObjectEditInputs(joinedText, focusIndex) {
  teardownMultiValueObjectEditInputs();
  if (!input || editingObjectId == null) return false;
  var row = findObjectRowEl(editingObjectId);
  var count = row ? row.querySelectorAll('.obj-value-cell').length : 1;
  if (!(count > 1)) return false;
  var parts = parsePartsForEditingDisplay(joinedText, count);
  while (parts.length < count) parts.push('');
  if (parts.length > count) parts = parts.slice(0, count);
  var wrap = input.closest('.composer-input-wrap');
  if (!wrap) return false;
  var box = document.createElement('div');
  box.className = 'object-edit-multi-inputs';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Edit object values');
  var textareas = [];
  for (var i = 0; i < parts.length; i++) {
    var ta = document.createElement('textarea');
    ta.className = 'composer-slot-input object-edit-part-input';
    ta.rows = 1;
    ta.maxLength = 2000;
    ta.autocomplete = 'off';
    ta.spellcheck = false;
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('data-part-index', String(i));
    ta.setAttribute('aria-label', 'Object value ' + (i + 1));
    ta.placeholder = valueColumnHeaderLabel(i);
    ta.value = String(parts[i] != null ? parts[i] : '');
    ta.addEventListener('input', function(e) {
      var idx = parseInt(e.target.getAttribute('data-part-index'), 10);
      multiValueEditInputs.focusIndex = Number.isFinite(idx) ? idx : 0;
      setHiddenInputSelectionFromMultiValueEditor(idx, e.target);
      applyObjectEditTextFromPartsEditor();
      if (typeof autoResize === 'function') autoResize(e.target);
    });
    var syncSel = function(ev) {
      var idx = parseInt(ev.target.getAttribute('data-part-index'), 10);
      multiValueEditInputs.focusIndex = Number.isFinite(idx) ? idx : 0;
      setHiddenInputSelectionFromMultiValueEditor(idx, ev.target);
      updateEditingRowFromInput();
    };
    ta.addEventListener('click', syncSel);
    ta.addEventListener('keyup', syncSel);
    ta.addEventListener('select', syncSel);
    ta.addEventListener('mouseup', syncSel);
    ta.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        cancelEditingMode(true);
      }
    });
    box.appendChild(ta);
    textareas.push(ta);
  }
  input.style.display = 'none';
  wrap.appendChild(box);
  multiValueEditInputs.active = true;
  multiValueEditInputs.container = box;
  multiValueEditInputs.textareas = textareas;
  multiValueEditInputs.focusIndex = Math.max(0, Math.min(textareas.length - 1, Number(focusIndex) || 0));
  if (composerSlotsContainer) composerSlotsContainer.classList.add('object-edit-multi-inputs');
  return true;
}

function updateTabBadge(ch) {
  if (!window.InoutTabsUi || !window.InoutTabsUi.updateTabBadge) return;
  window.InoutTabsUi.updateTabBadge(ch, inoutTabsUiCtx());
}

function updateAllTabBadges() {
  if (!window.InoutTabsUi || !window.InoutTabsUi.updateAllTabBadges) return;
  window.InoutTabsUi.updateAllTabBadges(inoutTabsUiCtx());
}

function loadViewDisplayNames() {
  viewDisplayNames = {};
  try {
    const raw = localStorage.getItem(VIEW_DISPLAY_NAMES_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') viewDisplayNames = parsed;
  } catch (_) {}
}

function saveViewDisplayNames() {
  try {
    localStorage.setItem(VIEW_DISPLAY_NAMES_KEY, JSON.stringify(viewDisplayNames || {}));
  } catch (_) {}
}

function getViewDefaultName(ch) {
  return ch === 'main' ? 'Feed' : String(ch);
}

function getViewDisplayName(ch) {
  const key = String(ch);
  const v = viewDisplayNames && typeof viewDisplayNames === 'object' ? viewDisplayNames[key] : null;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return getViewDefaultName(key);
}

function applyRemoteViewTitle(channel, titleValue) {
  const key = String(channel || '');
  if (!key) return;
  if (typeof titleValue === 'string' && titleValue.trim()) viewDisplayNames[key] = titleValue.trim();
  else delete viewDisplayNames[key];
  saveViewDisplayNames();
  if (tabsEl) {
    const btn = tabsEl.querySelector('.tab[data-channel="' + CSS.escape(key) + '"]');
    if (btn) {
      const lbl = btn.querySelector('.tab-label');
      if (lbl) lbl.textContent = getViewDisplayName(key);
    }
  }
  refreshMoveTargets();
  syncComposerTargetSelects();
}

async function persistViewTitle(channel, titleValue) {
  if (!sb || !sb.from || !channel) return;
  try {
    const ch = String(channel);
    let cfg = {};
    try {
      let q = sb.from('views').select('config').eq('channel', ch).limit(1);
      if (currentUser && currentUser.id && !isChannelViewCollaborative(ch)) q = q.eq('user_id', currentUser.id);
      const { data } = await q.maybeSingle();
      const parsed = data ? normalizeViewConfig(data.config) : null;
      if (parsed && typeof parsed === 'object') cfg = parsed;
    } catch (_) {}
    const nextCfg = Object.assign({}, cfg);
    if (typeof titleValue === 'string' && titleValue.trim()) nextCfg.title = titleValue.trim();
    else delete nextCfg.title;
    await upsertChannelViewConfigMerged(ch, nextCfg);
  } catch (e) {
    console.error(e);
  }
}

function refreshMoveTargets() {
  if (!moveTargetSelect) return;
  moveTargetSelect.innerHTML = '';
  for (const ch of viewNames) {
    const opt = document.createElement('option');
    opt.value = ch;
    opt.textContent = getViewDisplayName(ch);
    moveTargetSelect.appendChild(opt);
  }
}

function isNearBottom() {
  const base = 80;
  const extra = (inputArea && inputArea.offsetHeight) ? inputArea.offsetHeight : 120;
  const threshold = base + extra;
  var surf = primaryFeedScrollSurface();
  if (!surf) return true;
  return surf.scrollHeight - surf.scrollTop - surf.clientHeight < threshold;
}

/* ═══ INIT ═══════════════════════════════════════════════ */
function init(done) {
  function finish() {
    try {
  setupPresence();
      var saved = viewScroll.get(currentView);
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          if (feedEl) {
            var surfInit = primaryFeedScrollSurface();
            if (surfInit) {
              if (typeof saved === 'number' && saved >= 0) {
                surfInit.scrollTop = Math.min(saved, Math.max(0, surfInit.scrollHeight - surfInit.clientHeight));
              } else {
                scrollBottom();
              }
            }
          }
        });
      });
      setupFocusOnFirstInteraction();
    } catch (_) {}
    if (typeof done === 'function') done();
  }
  try {
    var wasEditingFlag = !!localStorage.getItem(WAS_EDITING_KEY);
    localStorage.removeItem(WAS_EDITING_KEY);
    if (wasEditingFlag) {
      try {
        localStorage.setItem(INPUT_STATE_KEY, '');
      } catch (_) {}
      if (input) {
        input.value = '';
        input.placeholder = 'Add object…';
        if (sendBtn) sendBtn.disabled = true;
        autoResize();
        updateClearInputBtn();
      }
    }
  } catch (_) {}
  try { loadChannelsList(); } catch (_) {}
  try { loadViewDisplayNames(); } catch (_) {}
  try { loadScrollState(); } catch (_) {}
  try { setupTabs(); } catch (_) {}
  try { restoreLastChannel(); } catch (_) {}
  try { refreshMoveTargets(); } catch (_) {}
  try {
    if (feedInner) {
      feedInner.innerHTML = '';
      if (emptyEl && emptyEl.parentNode) emptyEl.remove();
      showEmptyIfNoObjects();
      if (objectCountEl) updateObjectCount();
    }
  } catch (_) {}
  // In this build we do not auto-sync auth state from Supabase; sign-in/out are driven by buttons only.
  finish();
  (function runAsync() {
    refreshAuth().then(function() {
      if (typeof cleanupAuthHash === 'function') cleanupAuthHash();
      return Promise.race([
        (async function() {
          if (currentUser) {
            await syncChannelsFromServer();
            try {
              restoreLastChannel();
            } catch (_) {}
          }
          await loadObjectOrderForCurrentChannel();
          await loadFieldPrefsForCurrentChannel();
          refreshMoveTargets();
          if (currentUser) {
            await loadObjects();
            (function restoreScrollAfterLoad() {
              var saved = viewScroll.get(currentView);
              if (feedEl && typeof saved === 'number' && saved >= 0) {
                requestAnimationFrame(function() {
                  requestAnimationFrame(function() {
                    var surfL = primaryFeedScrollSurface();
                    if (!surfL) return;
                    var maxScroll = surfL.scrollHeight - surfL.clientHeight;
                    if (maxScroll > 0) surfL.scrollTop = Math.min(saved, Math.max(0, maxScroll));
                  });
                });
              }
            })();
            subscribeRealtimeAll();
            setupDraftChannel();
            setupLayoutChannel();
            setupDndBroadcastChannel();
            subscribeOrderRealtime();
            subscribeViewRealtime();
            subscribeActionLog();
            if (!window._dndVisibilityBound) {
              window._dndVisibilityBound = true;
              document.addEventListener('visibilitychange', function() {
                if (document.visibilityState === 'hidden') {
                  if (currentUser && sb && typeof flushPersonalWorkspacePersist === 'function') {
                    flushPersonalWorkspacePersist().catch(function() {});
                  }
                  return;
                }
                if (!currentUser || !currentChannel || typeof setupDndBroadcastChannel !== 'function') return;
                /* Brief delay so WebSocket can reconnect (helps web→mobile when mobile was backgrounded) */
                setTimeout(function() {
                  setupDndBroadcastChannel();
                  if (typeof subscribeViewRealtime === 'function') subscribeViewRealtime();
                }, 100);
              });
              window.addEventListener('pagehide', function() {
                if (currentUser && sb && typeof flushPersonalWorkspacePersist === 'function') {
                  flushPersonalWorkspacePersist().catch(function() {});
                }
              });
            }
          }
        })(),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('timeout')); }, 12000); })
      ]);
    }).catch(function(e) {
      if (e && e.message !== 'timeout') console.error(e);
      try { renderTabs(); } catch (_) {}
      refreshMoveTargets();
      if (currentUser && typeof loadMessages === 'function') loadObjects().catch(function() {});
      if (feedInner && emptyEl && !emptyEl.parentNode) feedInner.appendChild(emptyEl);
    });
  })();
}

function openUserModal() {
  if (!umBackdrop) return;
  if (typeof closeChannelModal === 'function') closeChannelModal();
  const ap = document.getElementById('add-members-modal-backdrop');
  if (ap) ap.style.display = 'none';
  showUserModalBackdrop();
  /* Paint the drawer first; vault panel + workspace persist run next frame so realtime work doesn’t delay open. */
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      if (typeof refreshStorageUIPanel === 'function') refreshStorageUIPanel();
      if (typeof notifyWorkspaceChromeChanged === 'function') notifyWorkspaceChromeChanged();
    });
  });
}

function closeUserModal() {
  if (!umBackdrop) return;
  hideUserModalBackdrop();
  requestAnimationFrame(focusMainInput);
  notifyWorkspaceChromeChanged();
}

/* user-btn / user-close: wired in profileButtonFallback (end of file) so OAuth fallback and workspace sync share one path */
if (umBackdrop) umBackdrop.addEventListener('click', e => {
  if (e.target === umBackdrop) closeUserModal();
});
if (logActionBtn) {
  logActionBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (logDropupPanel && logDropupPanel.classList.contains('open')) closeLogDropup();
    else openLogDropup();
  });
  updateLogBadge();
}
if (typeof window !== 'undefined') {
  window.addEventListener(
    'resize',
    function() {
      if (logDropupPanel && logDropupPanel.classList.contains('open') && logDropupPanel.classList.contains('log-dropup-panel-fixed'))
        positionLogDropupPanelFixed();
    },
    { passive: true }
  );
}
document.addEventListener('click', e => {
  if (logDropupPanel && logDropupPanel.classList.contains('open') && !logDropupPanel.contains(e.target) && e.target !== logActionBtn) closeLogDropup();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (logDropupPanel && logDropupPanel.classList.contains('open')) {
      closeLogDropup();
      return;
    }
    if (cmBackdrop && cmBackdrop.style.display === 'flex') {
      closeChannelModal();
      return;
    }
    if (addMembersBackdrop && addMembersBackdrop.style.display === 'flex') {
      closeAddMembersModal();
      return;
    }
    if (isUserModalBackdropOpen()) {
      closeUserModal();
      return;
    }
  }
  // Ctrl/Cmd+Z → undo; Ctrl/Cmd+Shift+Z → redo when typing in edit mode.
  const isUndoKey = (e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
  const isRedoKey = (e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey;
  if (isUndoKey && editingObjectId != null && editTypingUndoStack.length > 1) {
    e.preventDefault();
    var last = editTypingUndoStack.pop();
    editTypingRedoStack.push(last);
    var prev = editTypingUndoStack[editTypingUndoStack.length - 1];
    input.value = prev;
    updateEditingRowFromInput();
    saveInputGlobal();
    updateClearInputBtn();
    if (sendBtn) sendBtn.disabled = false;
    broadcastDraft(input.value);
    return;
  }
  if (isRedoKey && editingObjectId != null && editTypingRedoStack.length > 0) {
    e.preventDefault();
    var next = editTypingRedoStack.pop();
    editTypingUndoStack.push(next);
    input.value = next;
    updateEditingRowFromInput();
    saveInputGlobal();
    updateClearInputBtn();
    if (sendBtn) sendBtn.disabled = false;
    broadcastDraft(input.value);
    return;
  }
  if (isUndoKey) {
    e.preventDefault();
    undoLastAction();
  }
});

function setupFocusOnFirstInteraction() {
  if (!input) return;
  function isInteractive(el) {
    if (!el || el === document.body) return false;
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('input, textarea, [contenteditable="true"], button, a, select')) return true;
    if (el.closest && (el.closest('#user-modal') || el.closest('#channel-modal-backdrop') || el.closest('#view-menu'))) return true;
    if (el.closest && el.closest('.obj-actions, .obj-select-wrap')) return true;
    return false;
  }
  document.addEventListener('focusin', () => {
    if (isInteractive(document.activeElement)) return;
    if (isMobileOrTouchDevice()) return;
    setTimeout(() => { if (input && document.activeElement !== input) input.focus(); }, 0);
  });
  document.addEventListener('click', (e) => {
    if (isInteractive(e.target)) return;
    if (isMobileOrTouchDevice()) return;
    if (input && document.activeElement !== input) {
      setTimeout(() => { if (input) input.focus(); }, 0);
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest || !t.closest('button')) return;
    if (t.closest('#user-modal') || t.closest('#channel-modal-backdrop')) return;
    /* View tabs / nav: refocusing composer here caused Chrome to jump into keyboard / pseudo-fullscreen after switches. */
    if (t.closest('#tabs') || t.closest('#nav')) return;
    if (isMobileOrTouchDevice()) return;
    setTimeout(() => { if (input) input.focus(); }, 0);
  });
  if (feedEl) {
    feedEl.addEventListener('focus', () => {
      if (isMobileOrTouchDevice()) return;
      if (input && document.activeElement === feedEl) setTimeout(() => { if (input) input.focus(); }, 0);
    });
  }
  if (input) {
  input.addEventListener('focusout', (e) => {
    if (isMobileOrTouchDevice()) return;
    const next = e.relatedTarget;
    if (next && isInteractive(next)) return;
    if (document.activeElement && (document.activeElement.closest('#user-modal') || document.activeElement.closest('#channel-modal-backdrop'))) return;
    setTimeout(() => { if (input && document.activeElement !== input) input.focus(); }, 0);
  });
  }
}

/* ═══ LOAD ════════════════════════════════════════════════ */
/* entries table fields: id, created_at, text, channel, user_id, author_name */
async function fetchObjectsList() {
  return fetchObjectsListForChannel(currentChannel);
}

async function fetchObjectsListForChannel(ch) {
  let query = sb
    .from(OBJECTS_TABLE)
    .select('id, created_at, text, channel, user_id, author_name')
    .eq('channel', ch);

  // For the main view when signed in, keep per-user isolation.
  if (currentUser && ch === 'main') {
    query = query.eq('user_id', currentUser.id);
  }
  const { data, error } = await query.order('created_at', { ascending: true }).limit(100);
  if (error) { console.error(error); return []; }
  const list = data || [];
  if (ch === currentChannel && list.length > 0 && currentObjectOrder.length > 0) {
    return sortObjectsByOrder(list, currentObjectOrder);
  }
  return list;
}

async function loadObjects() {
  if (!shouldUseServerForObjects()) {
    await loadLocalObjectsForCurrentView();
    return;
  }
  const raw = await fetchObjectsList();
  const list = raw.map(normalizeEntryTextToJsonIfPlain);
  schedulePersistNormalizedEntries(raw, list);
  await replaceFeedWithList(list);
  // Mirror current view's objects into local per-device storage so they persist on this device.
  try {
    if (Array.isArray(list)) {
      const byView = await getLocalObjectByViewMap();
      const key = currentView || 'main';
      byView[key] = list;
      await saveLocalObjectByViewMap(byView);
    }
  } catch (_) {}
}

async function loadObjectsForTempSession() {
  if (!tempSessionId || !sb || !sb.from) return;
  let query = sb
    .from(OBJECTS_TABLE)
    .select('id, created_at, text, channel, user_id, author_name, temp_session_id');

  // For a shared view, load both owner's and guest's objects by channel or temp_session_id.
  if (currentChannel) {
    query = query.or(
      'channel.eq.' + currentChannel + ',temp_session_id.eq.' + tempSessionId
    );
  } else {
    query = query.eq('temp_session_id', tempSessionId);
  }

  const { data, error } = await query.order('created_at', { ascending: true });

  if (error) {
    console.error(error);
    return;
  }
  const raw = data || [];
  const list = raw.map(normalizeEntryTextToJsonIfPlain);
  schedulePersistNormalizedEntries(raw, list);
  await replaceFeedWithList(list);
}

async function replaceFeedWithList(list) {
  if (!feedInner) return;
  inoutMultiValueFilterMode = 'all';
  inoutMultiValueColumnFilterIndex = null;
  closeInoutMultiValueFilterMenu();
  seenIds.clear();
  lastKnownEntryTextById.clear();
  globalObjectNum = 0;
  objectCount = 0;
  const maxValCols = computeMaxValueColumnsFromMessages(list);
  feedInner.dataset.inoutValueCols = String(maxValCols);
  const pinnedIds = new Set(getPinnedIds(currentView));
  const railFrag = document.createDocumentFragment();
  const feedFrag = document.createDocumentFragment();
  for (const msg of list) {
    const row = createObjectRow(msg, false, { valueColumnCount: maxValCols });
    if (!row) continue;
    const id = Number(msg.id);
    if (Number.isFinite(id) && pinnedIds.has(id)) railFrag.appendChild(row);
    else feedFrag.appendChild(row);
  }
  const rail = document.getElementById('view-pinned-rail');
  const hasFeedRows = feedFrag.childNodes.length > 0;
  objectCount = feedFrag.childNodes.length + railFrag.childNodes.length;
  /* When there is no saved order, seed currentObjectOrder from this list (feed part, in list order) and persist so the view has an order from first load. */
  if (!currentObjectOrder.length && list.length) {
    const feedOrder = list
      .filter(m => m && Number.isFinite(Number(m.id)) && !pinnedIds.has(Number(m.id)))
      .map(m => Number(m.id));
    if (feedOrder.length) {
      currentObjectOrder = feedOrder;
      saveObjectOrderForCurrentView();
    }
  }
  requestAnimationFrame(() => {
    if (rail) rail.replaceChildren(railFrag);
    if (feedInner) {
      if (hasFeedRows) feedInner.replaceChildren(feedFrag);
      else if (emptyEl) feedInner.replaceChildren(emptyEl);
      else feedInner.replaceChildren();
    }
    updateObjectCount();
    applyFieldPrefsToObjects(true);
    syncFeedMultiValueChrome(feedInner, list);
    if (feedEl) {
      var ps = primaryFeedScrollSurface();
      if (ps) ps.scrollTop = 0;
    }
  });
}

/** Render a message list into a given feed-inner element. Does not update global objectCount. */
async function replaceFeedWithListInto(list, targetFeedInner) {
  if (!targetFeedInner) return;
  const savedSeen = new Set(seenIds);
  seenIds.clear();
  const maxValCols = computeMaxValueColumnsFromMessages(list);
  targetFeedInner.dataset.inoutValueCols = String(maxValCols);
  const frag = document.createDocumentFragment();
  for (const msg of list) {
    const row = createObjectRow(msg, false, { skipEmptyRemove: true, valueColumnCount: maxValCols });
    if (row) frag.appendChild(row);
  }
  seenIds.clear();
  savedSeen.forEach(function(id) { seenIds.add(id); });
  const hasRows = frag.childNodes.length > 0;
  if (hasRows) {
    targetFeedInner.replaceChildren(frag);
    syncFeedMultiValueChrome(targetFeedInner, list);
  } else {
    const empty = targetFeedInner.querySelector('.empty-placeholder') || document.createElement('div');
    empty.className = 'empty-placeholder';
    if (!empty.textContent) empty.textContent = 'Nothing yet.';
    targetFeedInner.replaceChildren(empty);
  }
}

/* ═══ REALTIME ════════════════════════════════════════════ */
var realtimeInsertBuffer = new Map();
var realtimeInsertFlushTimer = null;
function flushRealtimeInsertBuffer() {
  realtimeInsertFlushTimer = null;
  if (realtimeInsertBuffer.size === 0) return;
  var byChannel = new Map(realtimeInsertBuffer);
  realtimeInsertBuffer = new Map();
  byChannel.forEach(function(msgs, ch) {
    if (!msgs.length) return;
    var primaryUpdated = false;
    views.forEach(function(view) {
      if (!view || view.channel !== ch || !view.feedInner) return;
      var inner = view.feedInner;
      var vccInner = parseInt(inner.dataset.inoutValueCols, 10) || 1;
      var frag = document.createDocumentFragment();
      msgs.forEach(function(msg) {
        var row = createObjectRow(msg, true, {
          skipEmptyRemove: inner !== feedInner,
          valueColumnCount: vccInner,
        });
        if (row) frag.appendChild(row);
      });
      if (frag.childNodes.length === 0) return;
      if (inner === feedInner) {
        hideEmpty();
        feedInner.appendChild(frag);
        objectCount += frag.childNodes.length;
        updateObjectCount();
        requestAnimationFrame(scrollBottom);
        primaryUpdated = true;
      } else {
        hideEmptyInFeed(inner);
        inner.appendChild(frag);
      }
    });
    if (!primaryUpdated && ch === currentChannel && feedInner) {
      hideEmpty();
      var vccP = parseInt(feedInner.dataset.inoutValueCols, 10) || 1;
      var frag = document.createDocumentFragment();
      msgs.forEach(function(msg) {
        var row = createObjectRow(msg, true, { skipEmptyRemove: false, valueColumnCount: vccP });
        if (row) frag.appendChild(row);
      });
      if (frag.childNodes.length > 0) {
        feedInner.appendChild(frag);
        objectCount += frag.childNodes.length;
        updateObjectCount();
        requestAnimationFrame(scrollBottom);
      }
    } else if (!primaryUpdated && msgs.length) {
      var next = (unreadCounts.get(ch) || 0) + msgs.length;
      unreadCounts.set(ch, next);
      updateTabBadge(ch);
      if (!currentUser && tempSessionId) {
        maybeNotifyGuestMessage(ch, msgs[msgs.length - 1]);
      }
    }
  });
}

function maybeNotifyGuestMessage(ch, msg) {
  try {
    if (!tempSessionId || currentUser) return;
    if (typeof Notification === 'undefined') return;
    if (document.visibilityState === 'visible' && !document.hidden) return;
    if (Notification.permission !== 'granted') return;

    const viewName = getViewDisplayName(ch);
    const text = msg && typeof msg.text !== 'undefined' ? String(msg.text) : '';
    const cleaned = text.trim().replace(/\s+/g, ' ');
    const snippet = cleaned ? (cleaned.length > 90 ? cleaned.slice(0, 90) + '…' : cleaned) : 'New message';

    new Notification('INOUT', {
      body: viewName + ': ' + snippet,
      tag: 'guest-chat-' + String(ch),
      renotify: false,
    });
  } catch (_) {}
}

/** Realtime: when another device adds/updates membership, show the feed tab; DELETE removes it. */
function subscribeChannelMembershipRealtime() {
  try {
    if (membershipRealtimeSub) {
      try { membershipRealtimeSub.unsubscribe(); } catch (_) {}
      membershipRealtimeSub = null;
    }
    if (!currentUser || !sb || !sb.channel) return;
    const uid = currentUser.id;
    if (!uid) return;
    const baseCh = 'inout-memberships-' + String(uid);
    async function onMembershipUpsert(row, showToast) {
      if (!row || typeof row.channel !== 'string' || !row.channel.trim()) return;
      const ch = row.channel.trim();
      if (leftChannels.has(ch)) return;
      if (!viewNames.includes(ch)) {
        viewNames.push(ch);
        saveChannelsList();
      }
      await refreshSharedFlags();
      subscribeRealtimeAll();
      renderTabs();
      refreshMoveTargets();
      if (showToast) toast('You were added to view "' + ch + '"');
    }
    async function onMembershipDelete(row) {
      if (!row || typeof row.channel !== 'string' || !row.channel.trim()) return;
      const ch = row.channel.trim();
      if (ch === 'main') return;
      if (leftChannels.has(ch)) return;
      viewNames = viewNames.filter(x => x !== ch);
      saveChannelsList();
      sharedChannels.delete(ch);
      schedulePersonalWorkspacePersist();
      if (currentChannel === ch || currentView === ch) {
        try {
          await switchChannel('main');
        } catch (_) {}
      }
      subscribeRealtimeAll();
      renderTabs();
      refreshMoveTargets();
    }
    membershipRealtimeSub = sb
      .channel(baseCh)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'channel_members',
          filter: 'user_id=eq.' + String(uid),
        },
        async (payload) => {
          await onMembershipUpsert(payload.new, true);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'channel_members',
          filter: 'user_id=eq.' + String(uid),
        },
        async (payload) => {
          await onMembershipUpsert(payload.new, false);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'channel_members',
          filter: 'user_id=eq.' + String(uid),
        },
        async (payload) => {
          await onMembershipDelete(payload.old);
        }
      )
      .subscribe();
  } catch (e) {
    console.error('subscribeChannelMembershipRealtime', e);
  }
}

function subscribeRealtimeAll() {
  for (const sub of channelSubs.values()) {
    try { sub.unsubscribe(); } catch (_) {}
  }
  channelSubs = new Map();

  if (!shouldUseServerForObjects() || !sb || !sb.channel) {
    return;
  }

  viewNames.forEach(ch => {
    let filter = 'channel=eq.' + ch;
    // For signed-in users, "main" is per-user; other views rely on RLS.
    if (currentUser && ch === 'main') {
      filter += ',user_id=eq.' + currentUser.id;
    }
    const sub = sb
      .channel('entries-' + ch)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'entries', filter },
        payload => onInsertForChannel(ch, payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'entries', filter },
        payload => onUpdateForChannel(ch, payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'entries', filter },
        payload => onDeleteForChannel(ch, payload.old)
      )
      .subscribe();
    channelSubs.set(ch, sub);
  });

  // When a guest sends a message (entry with temp_session_id), add that shared view to inviter's nav if owned by currentUser
  (function subscribeGuestViewReveal() {
    const chName = 'entries-guest-view-reveal';
    const sub = sb
      .channel(chName)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'entries' },
        async (payload) => {
          const row = payload.new;
          if (!row || row.temp_session_id == null) return;
          const channel = row.channel;
          if (!channel) return;
          try {
            const { data } = await sb
              .from('temp_sessions')
              .select('owner_id')
              .eq('id', row.temp_session_id)
              .maybeSingle();
            if (!data || data.owner_id !== currentUser.id) return;
            if (!viewNames.includes(channel)) {
              viewNames.push(channel);
              saveChannelsList();
            }
            // Switch inviter into the shared view immediately.
            currentView = channel;
            currentChannel = channel;
            renderTabs();
            // Ensure realtime + data for this shared view are active for inviter.
            subscribeRealtimeAll();
            if (typeof loadObjects === 'function') {
              loadObjects().catch(function() {});
            }
          } catch (_) {}
        }
      )
      .subscribe();
    channelSubs.set(chName, sub);
  })();

  subscribeChannelMembershipRealtime();
}

/** Update value cell(s) from stored text (plain or multi-value JSON). */
function updateObjectRowText(objId, textValue) {
  if (objId == null) return;
  const row = findObjectRowEl(objId);
  var ch = row ? channelKeyForRowEl(row) : String(currentChannel || 'main');
  rememberEntryText(ch, objId, textValue);
  if (!row) return;
  row.__inoutEntryTextRaw = String(textValue != null ? textValue : '');
  var maxCols = parseInt(row.dataset.valueCols, 10) || row.querySelectorAll('.obj-value-cell').length || 1;
  var parts = parseObjectTextToParts(textValue);
  while (parts.length < maxCols) parts.push('');
  if (parts.length > maxCols) parts = parts.slice(0, maxCols);
  ensureRowValueCellCount(row, maxCols, parts);
}


/** [start,end) offsets of each part inside joined `parts.join('\\n\\n')`. */
function partOffsetsInJoinedText(parts) {
  var out = [];
  var pos = 0;
  var p = parts || [];
  for (var i = 0; i < p.length; i++) {
    var plen = String(p[i] != null ? p[i] : '').length;
    out.push({ start: pos, end: pos + plen });
    pos += plen;
    if (i < p.length - 1) pos += 2;
  }
  return out;
}

function trimTrailingEmptyPartsArray(parts) {
  var arr = (parts || []).map(function(x) { return String(x != null ? x : ''); });
  while (arr.length > 1 && !String(arr[arr.length - 1] || '').trim()) arr.pop();
  return arr;
}

function trimTrailingEmptyPartsArrayWithMin(parts, minLen) {
  var arr = (parts || []).map(function(x) { return String(x != null ? x : ''); });
  var m = Math.max(0, Math.floor(Number(minLen) || 0));
  while (arr.length > m && !String(arr[arr.length - 1] || '').trim()) arr.pop();
  return arr;
}

/**
 * Escape + caret/selection for one value column.
 * partStart / partEndEx: global offsets in joined text; partEndEx is exclusive (slice(partStart, partEndEx) === part).
 * Textarea selection is [selStart, selEnd) with selEnd exclusive.
 */
function renderObjValuePartEditHtml(partText, partStart, partEndEx, selStart, selEnd) {
  var caret = '<span class="obj-edit-caret" aria-hidden="true"></span>';
  var selCls = 'obj-edit-selection';
  var pt = String(partText != null ? partText : '');
  var g0 = partStart;
  var g1 = partEndEx;
  var hasRange = selStart !== selEnd;
  var os = Math.max(selStart, g0);
  var oe = Math.min(selEnd, g1);
  var caretAfterInThisPart = selEnd > g0 && selEnd <= g1;
  if (!hasRange) {
    var cp = selStart;
    if (cp < g0 || cp > g1) {
      return '<span class="obj-edit-value">' + escapeHtml(pt) + '</span>';
    }
    var off = Math.max(0, Math.min(pt.length, cp - g0));
    var html =
      escapeHtml(pt.slice(0, off)) + caret + escapeHtml(pt.slice(off));
    return '<span class="obj-edit-value">' + html + '</span>';
  }
  if (oe <= os) {
    if (caretAfterInThisPart) {
      return '<span class="obj-edit-value">' + escapeHtml(pt) + caret + '</span>';
    }
    return '<span class="obj-edit-value">' + escapeHtml(pt) + '</span>';
  }
  var ls = os - g0;
  var le = oe - g0;
  var before = escapeHtml(pt.slice(0, ls));
  var mid = escapeHtml(pt.slice(ls, le));
  var after = escapeHtml(pt.slice(le));
  var midHtml = '<span class="' + selCls + '">' + mid + '</span>';
  if (caretAfterInThisPart) {
    return '<span class="obj-edit-value">' + before + midHtml + caret + after + '</span>';
  }
  return '<span class="obj-edit-value">' + before + midHtml + after + '</span>';
}

function findObjectRowEl(objId) {
  if (objId == null) return null;
  const idStr = String(objId);
  const sel = '.obj[data-id="' + CSS.escape(idStr) + '"]';
  for (let i = 0; i < views.length; i++) {
    const v = views[i];
    const inner = v && v.feedInner;
    if (!inner) continue;
    const el = inner.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** For stack edit, diff indices must follow the longest row: if the primary were empty, L=0 would prepend into long rows instead of appending in parallel. Tie → clicked row. */
function pickMultiEditPrimaryId(idsToEdit, clickedId, textMap) {
  if (!idsToEdit || idsToEdit.size <= 1) return clickedId;
  var maxLen = -1;
  var candidates = [];
  idsToEdit.forEach(function(selId) {
    var t = textMap[selId];
    var L = t != null ? String(t).length : 0;
    if (L > maxLen) {
      maxLen = L;
      candidates = [selId];
    } else if (L === maxLen) {
      candidates.push(selId);
    }
  });
  for (var i = 0; i < candidates.length; i++) {
    if (Number(candidates[i]) === Number(clickedId)) return clickedId;
  }
  return candidates[0];
}

/**
 * Enter object edit mode for one or more ids (composer + doppelgangers).
 * @param {Set<number>} idsToEdit
 * @param {number} primarySeedId  Row used to pick primary when lengths tie (e.g. clicked object id).
 * @param {number|null} clickedValueIndex Preferred value index where caret should start.
 */
function applyObjectEditMode(idsToEdit, primarySeedId, clickedValueIndex) {
  if (!input || !idsToEdit || idsToEdit.size < 1) return;
  const seed =
    primarySeedId != null && Number.isFinite(Number(primarySeedId))
      ? Number(primarySeedId)
      : Number(Array.from(idsToEdit)[0]);

  var prevIdsForPresence =
    editingObjectIds && editingObjectIds.size
      ? Array.from(editingObjectIds)
      : editingObjectId != null
        ? [editingObjectId]
        : [];
  prevIdsForPresence.forEach(function(oid) {
    broadcastViewEditingEnd(oid);
  });
  restoreEditingRowsOnCancel();

  originalEditTextForCancelMap = {};
  editingObjectTextMap = {};
  [feedInner].forEach(fi => {
    if (!fi) return;
    fi.querySelectorAll('.obj').forEach(row => {
      const id = row.dataset.id != null ? Number(row.dataset.id) : null;
      if (id == null || !idsToEdit.has(id)) return;
      let raw = getJoinedRowTextForEdit(row);
      originalEditTextForCancelMap[id] = raw;
      editingObjectTextMap[id] = raw;
    });
  });
  editingObjectIds = idsToEdit;
  const primaryId = pickMultiEditPrimaryId(idsToEdit, seed, editingObjectTextMap);
  editingObjectId = primaryId;
  var primaryText =
    editingObjectTextMap[primaryId] != null ? String(editingObjectTextMap[primaryId]) : '';
  var caretPos = null;
  var prefIdx = Number(clickedValueIndex);
  var primaryRowForCols = findObjectRowEl(primaryId);
  var cellCountForPrimary = primaryRowForCols
    ? primaryRowForCols.querySelectorAll('.obj-value-cell').length
    : 1;
  if (Number.isFinite(prefIdx) && prefIdx >= 0) {
    var parseCols = Math.max(cellCountForPrimary, prefIdx + 1);
    var p = trimTrailingEmptyPartsArray(parsePartsForEditingDisplay(primaryText, parseCols));
    while (p.length <= prefIdx) p.push('');
    var minCols = Math.max(prefIdx + 1, cellCountForPrimary);
    p = trimTrailingEmptyPartsArrayWithMin(p, minCols);
    primaryText = p.length > 1 ? p.join('\n\n') : (p[0] || '');
    editingObjectTextMap[primaryId] = primaryText;
    var pos = 0;
    for (var pi = 0; pi < prefIdx; pi++) pos += String(p[pi] || '').length + 2;
    if (prefIdx === 0 && p.length === 1) {
      caretPos = primaryText.length;
    } else {
      caretPos = Math.max(0, Math.min(primaryText.length, pos));
    }
  }
  input.value = primaryText;
  var len = input.value.length;
  var sel = Number.isFinite(caretPos) ? Math.max(0, Math.min(len, caretPos)) : len;
  input.selectionStart = sel;
  input.selectionEnd = sel;
  originalEditTextForCancel = primaryText;
  editTypingUndoStack = [primaryText];
  editTypingRedoStack = [];
  modeState.editing.active = true;
  modeState.editing.primaryId = primaryId;
  modeState.editing.ids = idsToEdit;
  currentMode = Modes.EDIT;
  document.body.dataset.mode = Modes.EDIT;
  if (editTypingCommitTimer) {
    clearTimeout(editTypingCommitTimer);
    editTypingCommitTimer = null;
  }
  try {
    localStorage.setItem(WAS_EDITING_KEY, '1');
  } catch (_) {}
  input.placeholder = idsToEdit.size > 1 ? 'Editing ' + idsToEdit.size + ' objects…' : 'Editing object…';
  var wantedFocusPart = Number.isFinite(prefIdx) && prefIdx >= 0 ? prefIdx : 0;
  var hasMultiEditInputs = renderMultiValueObjectEditInputs(primaryText, wantedFocusPart);
  autoResize();
  if (hasMultiEditInputs) {
    (multiValueEditInputs.textareas || []).forEach(function(ta) {
      if (typeof autoResize === 'function') autoResize(ta);
    });
    var ta = multiValueEditInputs.textareas[wantedFocusPart] || multiValueEditInputs.textareas[0];
    if (ta) {
      var ts = ta.value != null ? String(ta.value).length : 0;
      ta.selectionStart = ts;
      ta.selectionEnd = ts;
      setHiddenInputSelectionFromMultiValueEditor(wantedFocusPart, ta);
    }
  }
  sendBtn.disabled = false;
  updateClearInputBtn();
  saveInputGlobal();
  updateEditingRowHighlight();
  updateEditingRowFromInput();
  focusMainInput();
  requestAnimationFrame(updateEditingRowFromInput);
  broadcastComposerClear();
  broadcastDraft(input.value);
}

/** Apply the same edit (inferred from oldPrimary -> newPrimary) to every other id. Only single-character insert or delete is applied to others so each object keeps its own text; larger pastes/replaces only change the primary. */
function applyPrimaryEditToMultiEdit(newPrimary) {
  if (!editingObjectTextMap || !editingObjectIds || editingObjectIds.size <= 1) return;
  const oldPrimary =
    editingObjectTextMap[editingObjectId] != null ? String(editingObjectTextMap[editingObjectId]) : '';
  if (oldPrimary === newPrimary) {
    editingObjectTextMap[editingObjectId] = newPrimary;
    return;
  }
  const oldLen = oldPrimary.length;
  const newLen = newPrimary.length;
  let L = 0;
  while (L < oldLen && L < newLen && oldPrimary[L] === newPrimary[L]) L++;
  let R = 0;
  while (R < oldLen - L && R < newLen - L && oldPrimary[oldLen - 1 - R] === newPrimary[newLen - 1 - R]) R++;
  const oldMiddle = oldPrimary.slice(L, oldLen - R);
  const newMiddle = newPrimary.slice(L, newLen - R);
  /* Only propagate single-character insert or single-character delete to others; larger changes (paste, replace selection) only update the primary so each object keeps its own content. */
  const singleCharEdit = (oldMiddle.length <= 1 && newMiddle.length <= 1);
  if (singleCharEdit) {
    editingObjectIds.forEach(id => {
      if (id === editingObjectId) return;
      let text = editingObjectTextMap[id] != null ? String(editingObjectTextMap[id]) : '';
      let pos = Math.min(L, text.length);
      let removeLen = Math.min(oldMiddle.length, text.length - pos);
      if (removeLen < 1 && oldMiddle.length >= 1 && text.length > 0) {
        pos = text.length - 1;
        removeLen = 1;
      }
      editingObjectTextMap[id] = text.slice(0, pos) + newMiddle + text.slice(pos + removeLen);
    });
  }
  editingObjectTextMap[editingObjectId] = newPrimary;
}

/** Doppelganger: each row shows its own value (from editingObjectTextMap or input) with the same cursor/selection position (capped per row length). */
function updateEditingRowFromInput() {
  const ids = editingObjectIds && editingObjectIds.size ? Array.from(editingObjectIds) : (editingObjectId != null ? [editingObjectId] : []);
  if (ids.length === 0 || !input) return;
  const editingSet = new Set(ids);
  [feedInner].forEach(fi => {
    if (!fi) return;
    fi.querySelectorAll('.obj').forEach(row => {
      const id = row.dataset.id != null ? Number(row.dataset.id) : null;
      if (id != null && editingSet.has(id)) return;
      row.querySelectorAll('.obj-value-cell, .obj-text').forEach(function(textEl) {
        if (!textEl.querySelector('.obj-edit-caret, .obj-edit-selection')) return;
        textEl.innerHTML = renderVisualOnlyHtml(textEl.textContent || '');
      });
    });
  });
  const cursorStart = input.selectionStart || 0;
  const cursorEnd = input.selectionEnd != null ? input.selectionEnd : cursorStart;
  ids.forEach(id => {
    const text = (editingObjectTextMap && editingObjectTextMap[id] != null) ? editingObjectTextMap[id] : input.value;
    const len = text.length;
    const start = Math.min(cursorStart, len);
    const end = Math.min(Math.max(cursorEnd, start), len);
    const row = findObjectRowEl(id);
    if (!row) return;
    var valuesWrap = row.querySelector('.obj-values-wrap');
    var cells = valuesWrap ? valuesWrap.querySelectorAll(':scope > .obj-value-cell') : [];
    if (!cells.length) {
      var legacy = row.querySelector('.obj-text');
      if (!legacy) return;
      const caret = '<span class="obj-edit-caret" aria-hidden="true"></span>';
      const selCls = 'obj-edit-selection';
      const before = text.slice(0, start);
      const sel = text.slice(start, end);
      const after = text.slice(end);
      const html =
        escapeHtml(before) +
        (sel ? '<span class="' + selCls + '">' + escapeHtml(sel) + '</span>' : '') +
        caret +
        escapeHtml(after);
      legacy.innerHTML = '<span class="obj-edit-value">' + (html || caret) + '</span>';
      return;
    }
    var n = cells.length;
    var parts = parsePartsForEditingDisplay(text, n);
    if (parts.length > n) parts = parts.slice(0, n);
    var offs = partOffsetsInJoinedText(parts);
    for (var i = 0; i < n; i++) {
      var o = offs[i] || { start: 0, end: 0 };
      cells[i].innerHTML = renderObjValuePartEditHtml(
        parts[i] != null ? parts[i] : '',
        o.start,
        o.end,
        start,
        end
      );
    }
  });
}

function commitTypingSegment() {
  editTypingCommitTimer = null;
  if (editingObjectId == null || !input) return;
  var t = input.value;
  if (editTypingUndoStack[editTypingUndoStack.length - 1] !== t) {
    editTypingUndoStack.push(t);
    editTypingRedoStack = [];
    if (editTypingUndoStack.length > MAX_TYPING_UNDO) editTypingUndoStack.shift();
  }
}

function onUpdateForChannel(ch, row) {
  if (!row) return;
  const id = row.id != null ? row.id : row.Id;
  if (id == null) return;
  const text = row.text != null ? row.text : (row.Text != null ? row.Text : '');
  if (id === editingObjectId) {
    teardownMultiValueObjectEditInputs();
    originalEditTextForCancel = null;
    originalEditTextForCancelMap = null;
    editingObjectTextMap = null;
    editingObjectIds = null;
    editingObjectId = null;
    try { localStorage.removeItem(WAS_EDITING_KEY); } catch (_) {}
    if (input) input.placeholder = 'Add object…';
    modeState.editing.active = false;
    modeState.editing.primaryId = null;
    modeState.editing.ids = null;
    if (currentMode === Modes.EDIT) {
      currentMode = selectMode ? Modes.SELECT : Modes.NORMAL;
      document.body.dataset.mode = currentMode;
    }
  }
  // apply update in all views showing this channel
  let anyUpdated = false;
  views.forEach(view => {
    if (!view || view.channel !== ch) return;
    updateObjectRowText(id, text);
    clearRemoteEditingDoppelganger(id, true);
    anyUpdated = true;
  });
  if (!anyUpdated && ch === currentChannel) {
    // Fallback for guests or layouts without registered views: update primary feed directly.
    updateObjectRowText(id, text);
    clearRemoteEditingDoppelganger(id, true);
    anyUpdated = true;
  }
  if (anyUpdated) updateEditingRowHighlight();
}

function onDeleteForChannel(ch, row) {
  if (!row) return;
  const id = row.id != null ? row.id : row.Id;
  if (id == null) return;
  // Remove from all views showing this channel
  let removed = false;
  views.forEach(view => {
    if (!view || view.channel !== ch || !view.feedInner) return;
    const sel = '.obj[data-id="' + CSS.escape(String(id)) + '"]';
    const el = view.feedInner.querySelector(sel);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
      removed = true;
    }
  });
  if (!removed && ch === currentChannel && feedInner) {
    const sel = '.obj[data-id="' + CSS.escape(String(id)) + '"]';
    const el = feedInner.querySelector(sel);
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
      removed = true;
    }
  }
  if (removed) {
    currentObjectOrder = currentObjectOrder.filter(x => x !== id);
    saveObjectOrderForCurrentView();
    showEmptyIfNoObjects();
  }
}

function subscribeOrderRealtime() {
  if (!currentUser) return;
  if (orderSub) {
    try { orderSub.unsubscribe(); } catch (_) {}
    orderSub = null;
  }
  orderSub = sb
    .channel('message-orders-' + currentUser.id)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'message_orders',
        filter: 'user_id=eq.' + currentUser.id
      },
      async payload => {
        try {
          const row = payload.new || payload.old || {};
          if (!row || row.channel !== currentChannel) return;
          if (suppressNextOrderApply) { suppressNextOrderApply = false; return; }
          if (Date.now() < suppressOrderApplyUntil) return;
          await loadObjectOrderForCurrentChannel();
          dismissRemoteReorderOverlayForChannel(String(currentChannel || ''));
          applyObjectOrderToDOM();
        } catch (e) {
          if (typeof console !== 'undefined' && console.error) console.error('order realtime', e);
        }
      }
    )
    .subscribe();
}

function applyObjectOrderToFeedInner(inner, orderIds) {
  if (!inner || !Array.isArray(orderIds) || !orderIds.length) return;
  const rows = Array.from(inner.querySelectorAll('.obj'));
  if (!rows.length) return;
  const domOrder = rows.map(r => Number(r.dataset.id)).filter(id => Number.isFinite(id));
  if (domOrder.length === orderIds.length && domOrder.every((id, i) => id === orderIds[i])) return;
  const byId = new Map();
  rows.forEach(row => {
    const id = Number(row.dataset.id);
    if (Number.isFinite(id)) byId.set(id, row);
  });
  if (!byId.size) return;
  const order = orderIds.map(Number).filter(id => byId.has(id));
  const frag = document.createDocumentFragment();
  order.forEach(id => {
    const row = byId.get(id);
    if (row) {
      frag.appendChild(row);
      byId.delete(id);
    }
  });
  byId.forEach(row => frag.appendChild(row));
  inner.appendChild(frag);
  if (typeof syncFeedMultiValueChrome === 'function') syncFeedMultiValueChrome(inner);
}

function applyFieldPrefsToFeedInner(inner, fp) {
  if (!inner || !fp) return;
  inner.querySelectorAll('.obj').forEach(row => {
    const timeEl = row.querySelector('.obj-time');
    const senderEl = row.querySelector('.obj-sender');
    if (timeEl) {
      if (!fp.showTime) timeEl.style.setProperty('display', 'none', 'important');
      else timeEl.style.removeProperty('display');
    }
    if (senderEl) senderEl.style.setProperty('display', fp.showAuthor ? 'block' : 'none', 'important');
  });
  inner.classList.toggle('obj-labels-off', !fp.showLabels);
  syncFeedMultiValueChrome(inner);
}

/** Apply `views.config` to every open feed pane for this channel (single main feed). */
function applyViewsTableConfigToChannel(channel, cfg, opts) {
  if (!cfg || typeof cfg !== 'object') return;
  opts = opts || {};
  const skipOrder = !!opts.skipOrder;
  const ch = String(channel || '');
  applyRemoteViewTitle(ch, cfg.title);
  const defTime = true;
  const defAuthor = true;
  const fp = {
    showTime: typeof cfg.showTime === 'boolean' ? cfg.showTime : defTime,
    showAuthor: typeof cfg.showAuthor === 'boolean' ? cfg.showAuthor : defAuthor,
    showLabels: typeof cfg.showLabels === 'boolean' ? cfg.showLabels : true,
  };
  const orderArr = skipOrder
    ? []
    : (Array.isArray(cfg.order) ? cfg.order.map(x => Number(x)).filter(x => Number.isFinite(x)) : []);
  views.forEach(view => {
    if (!view || view.channel !== ch || !view.feedInner) return;
    if (orderArr.length) applyObjectOrderToFeedInner(view.feedInner, orderArr);
    applyFieldPrefsToFeedInner(view.feedInner, fp);
  });
  if (orderArr.length) {
    dismissRemoteReorderOverlayForChannel(ch);
  }
  if (ch === String(currentChannel || '')) {
    if (orderArr.length) {
      currentObjectOrder = orderArr.slice();
      try {
        saveOrderToLocal();
      } catch (_) {}
    }
    fieldPrefs = fp;
    try {
      saveFieldPrefsForCurrentChannel();
    } catch (_) {}
    applyFieldPrefsUI();
    applyFieldPrefsToObjects();
  }
}

function scheduleViewRealtimeResubscribe(reason) {
  if (viewRealtimeResubscribeTimer) clearTimeout(viewRealtimeResubscribeTimer);
  viewRealtimeResubscribeTimer = setTimeout(function() {
    viewRealtimeResubscribeTimer = null;
    if (!currentUser || !sb) return;
    try {
      subscribeViewRealtime();
    } catch (e) {
      console.error('view realtime resubscribe', e);
    }
  }, reason === 'visible' ? 400 : 900);
}

/* Cross-device view UI (Time/Author/Labels, order) uses postgres_changes on public.views.
   Ensure: alter publication supabase_realtime add table views; */
function subscribeViewRealtime() {
  if (!sb || !sb.channel) return;
  if (viewSub) {
    try { viewSub.unsubscribe(); } catch (_) {}
    viewSub = null;
  }
  var myGen = ++viewRealtimeSubscribeGen;
  const chName = 'views-all';
  viewSub = sb
    .channel(chName)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'views',
      },
      payload => {
        try {
          const row = payload.new || payload.old || {};
          if (!row || !row.channel) return;
          const rowCh = String(row.channel);
          if (rowCh === WORKSPACE_META_VIEW_CHANNEL) {
            if (currentUser && row.user_id != null && String(row.user_id) !== String(currentUser.id)) return;
            const cfgW = normalizeViewConfig(row.config);
            if (cfgW && cfgW._wsPushNonce && myWorkspacePushNonces.has(cfgW._wsPushNonce)) return;
            if (cfgW && typeof cfgW === 'object') {
              applyPersonalWorkspaceStateFromServer(cfgW, { mergeMultiview: true }).catch(function(e) {
                console.error('personal workspace apply', e);
              });
            }
            return;
          }
          const rowUid = row.user_id != null ? String(row.user_id) : '';
          const isMine = !!(currentUser && rowUid === String(currentUser.id));
          const collaborative = isChannelViewCollaborative(rowCh);
          if (!isMine && !collaborative) return;
          const cfg = normalizeViewConfig(row.config);
          if (!cfg) return;
          if (isMine && suppressNextViewApply) {
            suppressNextViewApply = false;
            return;
          }
          /* During local reorder, still apply view prefs from other tabs/devices; only skip order. */
          const skipOrder = isMine && Date.now() < suppressOrderApplyUntil;
          applyViewsTableConfigToChannel(rowCh, cfg, { skipOrder });
        } catch (e) {
          if (typeof console !== 'undefined' && console.error) console.error('view realtime', e);
        }
      }
    )
    .subscribe(function(status) {
      if (myGen !== viewRealtimeSubscribeGen) return;
      if (status === 'SUBSCRIBED') {
        if (viewRealtimeResubscribeTimer) {
          clearTimeout(viewRealtimeResubscribeTimer);
          viewRealtimeResubscribeTimer = null;
        }
        return;
      }
      /* CLOSED is common during intentional unsubscribe/reconnect; still schedule resubscribe for real drops. */
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (typeof console !== 'undefined' && console.warn) console.warn('views-all realtime', status);
        scheduleViewRealtimeResubscribe(status);
      } else if (status === 'CLOSED') {
        scheduleViewRealtimeResubscribe(status);
      }
    });
  setupWorkspaceUiBroadcast();
}

/** `views` realtime is table-wide — do not tear it down on every tab switch (avoids CLOSED churn + races). */
function ensureViewRealtimeSubscribed() {
  if (!sb || !sb.channel) return;
  if (viewSub) return;
  subscribeViewRealtime();
}

function subscribeActionLog() {
  if (!currentUser) return;
  if (actionLogSub) {
    try { actionLogSub.unsubscribe(); } catch (_) {}
    actionLogSub = null;
  }
  try {
    actionLogSub = sb
      .channel('action-log-' + currentUser.id)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'action_log',
          filter: 'user_id=eq.' + currentUser.id
        },
        payload => {
          const row = payload.new;
          if (!row) return;
          if (row.device_id === myId) return;
          const entry = {
            id: row.id,
            ts: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
            deviceId: row.device_id,
            userId: row.user_id,
            type: row.type || 'action',
            action: row.action || 'unknown',
            details: row.details || {},
            message: row.message || null,
            fromThisDevice: false,
          };
          actionLog.unshift(entry);
          if (actionLog.length > 100) {
            const removed = actionLog.pop();
            if (currentUser && removed?.id) {
              try { sb.from('action_log').delete().eq('user_id', currentUser.id).eq('id', removed.id).then(() => {}).catch(() => {}); } catch (_) {}
            }
          }
          updateLogBadge();
          if (logDropupPanel && logDropupPanel.classList.contains('open')) renderLogDropup();
        }
      )
      .subscribe();
  } catch (_) {}
}

function onInsertForChannel(ch, msg) {
  if (!realtimeInsertBuffer.has(ch)) realtimeInsertBuffer.set(ch, []);
  realtimeInsertBuffer.get(ch).push(msg);
  if (!realtimeInsertFlushTimer) {
    realtimeInsertFlushTimer = 1;
    queueMicrotask(function() {
      realtimeInsertFlushTimer = null;
      flushRealtimeInsertBuffer();
    });
  }
}

function hideEmptyInFeed(feedInnerEl) {
  if (!feedInnerEl) return;
  const empty = feedInnerEl.querySelector('.empty-placeholder');
  if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
}

/* ═══ PRESENCE (online count) ════════════════════════════ */
function setupPresence() {
  presenceCh = sb.channel('presence-room', {
    config: { presence: { key: myId } }
  });

  presenceCh
    .on('presence', { event: 'sync' }, () => {
      const state = presenceCh.presenceState();
      ocNum.textContent = Object.keys(state).length;
    })
    .on('presence', { event: 'join' }, () => {})
    .on('presence', { event: 'leave' }, () => {})
    .subscribe(async status => {
      if (status === 'SUBSCRIBED') {
        await presenceCh.track({ online_at: new Date().toISOString() });
      }
    });
}

/* ═══ SYNC INPUT ACROSS DEVICES (DB + REALTIME) ═══════════ */
function getSyncInputPref() {
  return true;
}

/** Merge so both typists appear; deletions sync by taking newer when one is prefix of the other. localAt/remoteAt = ms. */
function mergeInputText(local, remote, localAt, remoteAt) {
  if (local == null) local = '';
  if (remote == null) remote = '';
  local = String(local);
  remote = String(remote);
  if (local === remote) return local;
  /* '' is a prefix of every string; without this branch, empty local always loses to remote and stale DB rows resurrect after refresh. */
  if (local === '' && remote !== '') {
    return capSyncText((remoteAt || 0) > (localAt || 0) ? remote : local);
  }
  if (remote === '' && local !== '') {
    return capSyncText((localAt || 0) > (remoteAt || 0) ? local : remote);
  }
  if (local.length > INPUT_SYNC_MAX_LENGTH || remote.length > INPUT_SYNC_MAX_LENGTH) {
    return capSyncText((remoteAt || 0) > (localAt || 0) ? remote : local);
  }
  if (remote.indexOf(local) === 0) {
    return capSyncText((remoteAt || 0) >= (localAt || 0) ? remote : local);
  }
  if (local.indexOf(remote) === 0) {
    return capSyncText((localAt || 0) >= (remoteAt || 0) ? local : remote);
  }
  var i = 0;
  while (i < local.length && i < remote.length && local[i] === remote[i]) i++;
  var pre = local.slice(0, i);
  var localSuf = local.slice(i);
  var remoteSuf = remote.slice(i);
  var limit = 300;
  if (localSuf.length > limit || remoteSuf.length > limit) {
    return capSyncText((remoteAt || 0) > (localAt || 0) ? remote : local);
  }
  var merged = (remoteAt || 0) <= (localAt || 0)
    ? pre + remoteSuf + localSuf
    : pre + localSuf + remoteSuf;
  return capSyncText(merged);
}

async function saveInputToDb(opts) {
  opts = opts && typeof opts === 'object' ? opts : {};
  inputSaveToDbTimer = null;
  if (!currentUser || !sb || !sb.from || !getSyncInputPref()) return;
  /* Object edit text lives in the composer but must not be written to user_input_state — it would come back after refresh as a fake “still editing” draft. */
  if (editingObjectId != null) return;
  try {
    var text = input ? (input.value || '') : '';
    var targetChannel = opts.channel != null ? String(opts.channel) : (currentChannel || 'main');
    await sb.from(USER_INPUT_STATE_TABLE).upsert({
      user_id: currentUser.id,
      channel: targetChannel,
      text: capSyncText(text),
      updated_at: new Date().toISOString(),
      device_id: getInputStateDeviceId()
    }, { onConflict: 'user_id,channel' });
  } catch (e) { console.error('saveInputToDb', e); }
}

function scheduleSaveInputToDb() {
  if (editingObjectId != null) return;
  if (inputSaveToDbTimer) clearTimeout(inputSaveToDbTimer);
  if (!currentUser || !getSyncInputPref()) return;
  inputSaveToDbTimer = setTimeout(saveInputToDb, INPUT_SAVE_DEBOUNCE_MS);
}

async function saveSlotsToDb() {
  inputSlotsSaveToDbTimer = null;
  if (!currentUser || !sb || !sb.from || !getSyncInputPref()) return;
  try {
    var slotsToSave = inputSlots.map(function(s) {
      return { id: s.id, channel: s.channel, value: capSyncText(s.value) };
    });
    await sb.from(USER_INPUT_STATE_TABLE).upsert({
      user_id: currentUser.id,
      channel: SLOTS_SYNC_CHANNEL,
      text: JSON.stringify(slotsToSave),
      updated_at: new Date().toISOString(),
      device_id: getInputStateDeviceId()
    }, { onConflict: 'user_id,channel' });
  } catch (e) { console.error('saveSlotsToDb', e); }
}

function scheduleSaveSlotsToDb() {
  if (inputSlotsSaveToDbTimer) clearTimeout(inputSlotsSaveToDbTimer);
  if (!currentUser || !getSyncInputPref()) return;
  inputSlotsSaveToDbTimer = setTimeout(saveSlotsToDb, INPUT_SAVE_DEBOUNCE_MS);
}

function teardownInputStateRealtime() {
  if (inputStateSub) {
    try { inputStateSub.unsubscribe(); } catch (_) {}
    inputStateSub = null;
  }
}

function setupInputStateRealtime() {
  teardownInputStateRealtime();
  if (!currentUser || !sb || !getSyncInputPref()) return;
  try {
    inputStateSub = sb
      .channel('input-state-' + currentUser.id)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: USER_INPUT_STATE_TABLE,
        filter: 'user_id=eq.' + currentUser.id
      }, payload => {
        try {
        var row = payload && (payload.new || payload.old);
        if (!row || typeof row !== 'object') return;
        if (String(row.device_id) === String(getInputStateDeviceId())) return;
        if (shouldSkipStaleInputRealtimeRow(row)) return;
        if (Date.now() < inoutChannelInputQuietUntil) return;
        if (Date.now() < composerRemoteMergeSuppressedUntil) return;
        if (row.channel === SLOTS_SYNC_CHANNEL) {
          try {
            const raw = (row.text != null ? String(row.text) : '') || '[]';
            if (raw.length > INPUT_SYNC_MAX_LENGTH * 20) return;
            const slots = JSON.parse(raw);
            if (Array.isArray(slots) && slots.length > 0) {
              const structureSame = inputSlots.length === slots.length &&
                inputSlots.every(function(s, i) {
                  const t = slots[i];
                  return t && s.id === t.id && s.channel === t.channel;
                });
              if (structureSame && composerSlotsContainer) {
                inputSlots = slots.map(function(s) {
                  return { id: s.id || '', channel: s.channel || 'main', value: capSyncText(s.value) };
                });
                const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
                var remoteAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
                if (!Number.isFinite(remoteAt)) remoteAt = 0;
                inputSlots.forEach(function(slot, i) {
                  const ta = (i === 0 && input) ? input : composerSlotsContainer.querySelector('.composer-slot[data-slot-index="' + i + '"] textarea');
                  if (!ta) return;
                  if (ta === activeEl && Date.now() - lastSlotsEditAt < 1000) return;
                  const remoteVal = capSyncText(slot.value);
                  const merged = mergeInputText(ta.value, remoteVal, lastSlotsEditAt, remoteAt);
                  if (merged === ta.value) return;
                  ta.value = merged;
                  var mlen = merged.length;
                  /* When applying remote update, keep cursor at end so it follows symbols added on other device */
                  ta.selectionStart = mlen;
                  ta.selectionEnd = mlen;
                  inputSlots[i].value = merged;
                  if (i === 0) {
                    if (typeof autoResize === 'function') autoResize();
                    if (sendBtn) sendBtn.disabled = !merged.trim();
                    if (typeof updateClearInputBtn === 'function') updateClearInputBtn();
                    if (typeof saveInputGlobal === 'function') saveInputGlobal();
                  } else {
                    const rowEl = ta.closest && ta.closest('.composer-slot');
                    if (rowEl) {
                      const sBtn = rowEl.querySelector('.composer-send');
                      if (sBtn) sBtn.disabled = !merged.trim();
                    }
                  }
                });
                try { localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots)); } catch (_) {}
              } else {
                let focusedSlotIndex = -1;
                let savedValue = '';
                let savedStart = 0;
                let savedEnd = 0;
                try {
                  if (typeof document !== 'undefined' && composerSlotsContainer) {
                    const el = document.activeElement;
                    if (el && composerSlotsContainer.contains(el)) {
                      if (el.id === 'object-input') {
                        focusedSlotIndex = 0;
                      } else if (el.classList && el.classList.contains('composer-slot-input') && el.dataset.slotIndex != null) {
                        focusedSlotIndex = parseInt(el.dataset.slotIndex, 10);
                      } else {
                        const rowEl = el.closest && el.closest('.composer-slot');
                        if (rowEl && rowEl.dataset.slotIndex != null) {
                          focusedSlotIndex = parseInt(rowEl.dataset.slotIndex, 10);
                        }
                      }
                      if (focusedSlotIndex >= 0) {
                        const slotTextarea = (focusedSlotIndex === 0 && input) ? input : composerSlotsContainer.querySelector('.composer-slot[data-slot-index="' + focusedSlotIndex + '"] textarea');
                        if (slotTextarea && slotTextarea.value !== undefined) {
                          savedValue = slotTextarea.value || '';
                          savedStart = slotTextarea.selectionStart != null ? slotTextarea.selectionStart : savedValue.length;
                          savedEnd = slotTextarea.selectionEnd != null ? slotTextarea.selectionEnd : savedStart;
                        }
                      }
                    }
                  }
                } catch (_) {}
                inputSlots = slots.map(normalizeSlot).filter(Boolean);
                if (inputSlots.length === 0) return;
                if (focusedSlotIndex >= 0 && focusedSlotIndex < inputSlots.length) {
                  inputSlots[focusedSlotIndex] = Object.assign({}, inputSlots[focusedSlotIndex], { value: capSyncText(savedValue) });
                }
                try { localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots)); } catch (_) {}
                if (composerSlotsContainer && typeof renderComposerSlots === 'function') {
                  renderComposerSlots();
                  updatePrimaryInputRefs();
                  if (typeof attachInputListeners === 'function') attachInputListeners();
                  if (focusedSlotIndex >= 0) {
                    const idx = focusedSlotIndex;
                    const val = savedValue;
                    const selStart = savedStart;
                    const selEnd = savedEnd;
                    requestAnimationFrame(function() {
                      let toFocus = null;
                      if (idx === 0 && input) {
                        toFocus = input;
                      } else if (composerSlotsContainer) {
                        toFocus = composerSlotsContainer.querySelector('.composer-slot[data-slot-index="' + idx + '"] textarea');
                      }
                      if (toFocus) {
                        if (toFocus.value !== undefined) {
                          toFocus.value = val;
                          toFocus.setSelectionRange(selStart, selEnd);
                        }
                        if (!isMobileOrTouchDevice()) toFocus.focus();
                        if (idx === 0) {
                          if (typeof autoResize === 'function') autoResize();
                          if (sendBtn) sendBtn.disabled = !val.trim();
                          if (typeof updateClearInputBtn === 'function') updateClearInputBtn();
                        }
                      }
                    });
                  }
                }
              }
              markInputRealtimeRowApplied(row);
            }
          } catch (_) {}
          return;
        }
        if (row.channel !== (currentChannel || 'main')) return;
        if (!input) return;
        if (document.activeElement === input && Date.now() - lastPrimaryInputEditAt < 1000) {
          return;
        }
        var remoteText = capSyncText(row.text);
        var remoteAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
        if (!Number.isFinite(remoteAt)) remoteAt = 0;
        if (remoteText === input.value) {
          markInputRealtimeRowApplied(row);
          return;
        }
        var merged = mergeInputText(input.value, remoteText, lastPrimaryInputEditAt, remoteAt);
        if (merged !== input.value) {
          input.value = merged;
          var len = merged.length;
          /* When applying remote update, keep cursor at end so it follows symbols added on other device */
          input.selectionStart = len;
          input.selectionEnd = len;
          if (typeof autoResize === 'function') autoResize();
          if (sendBtn) sendBtn.disabled = !merged.trim();
          if (typeof updateClearInputBtn === 'function') updateClearInputBtn();
          saveInputGlobal();
          updateRemoteSelectionOverlay();
        }
        markInputRealtimeRowApplied(row);
        } catch (e) {
          if (typeof console !== 'undefined' && console.error) console.error('input-state realtime', e);
        }
      })
      .subscribe();
  } catch (_) {}
}

async function loadInputFromDbForChannel(ch) {
  if (!currentUser || !sb || !sb.from || !getSyncInputPref() || !input) return;
  const channel = ch || currentChannel || 'main';
  try {
    const { data, error } = await sb.from(USER_INPUT_STATE_TABLE).select('text, updated_at').eq('user_id', currentUser.id).eq('channel', channel).maybeSingle();
    if (error) {
      restoreInputGlobal();
      return;
    }
    if (!data) {
      if (editingObjectId != null) return;
      input.value = '';
      input.placeholder = 'Add object…';
      if (primarySlotAutoTarget && inputSlots && inputSlots.length > 0 && inputSlots[0]) {
        inputSlots[0].value = '';
        try { localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots)); } catch (_) {}
      }
      autoResize();
      sendBtn.disabled = true;
      updateClearInputBtn();
      saveInputGlobal({ skipRemote: true });
      try {
        await saveInputToDb({ channel: channel });
      } catch (_) {}
      return;
    }
    if (data.updated_at) {
      var tMain = new Date(data.updated_at).getTime();
      if (Number.isFinite(tMain)) lastSeenInputStateTs[String(channel)] = tMain;
    }
    const text = capSyncText(data.text);
    input.value = text;
    if (editingObjectId == null) {
      input.placeholder = 'Add object…';
    }
    if (primarySlotAutoTarget && inputSlots && inputSlots.length > 0 && inputSlots[0]) {
      inputSlots[0].value = text;
      try { localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots)); } catch (_) {}
    }
    autoResize();
    sendBtn.disabled = !text.trim();
    updateClearInputBtn();
    saveInputGlobal({ skipRemote: true });
  } catch (_) {}
}

async function loadSlotsFromDb() {
  if (!currentUser || !sb || !sb.from || !getSyncInputPref()) return false;
  try {
    const { data, error } = await sb.from(USER_INPUT_STATE_TABLE).select('text, updated_at').eq('user_id', currentUser.id).eq('channel', SLOTS_SYNC_CHANNEL).maybeSingle();
    if (error || !data || data.text == null) return false;
    if (data.updated_at) {
      var tSlots = new Date(data.updated_at).getTime();
      if (Number.isFinite(tSlots)) lastSeenInputStateTs['__slots'] = tSlots;
    }
    const raw = String(data.text).trim() || '[]';
    if (raw.length > INPUT_SYNC_MAX_LENGTH * 2) return false;
    const slots = JSON.parse(raw);
    if (!Array.isArray(slots) || slots.length === 0) return false;
    inputSlots = slots.map(normalizeSlot).filter(Boolean);
    if (inputSlots.length === 0) return false;
    try { localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots)); } catch (_) {}
    return true;
  } catch (_) { return false; }
}

async function restoreInputFromDb() {
  try {
    inoutChannelInputQuietUntil = Math.max(inoutChannelInputQuietUntil, Date.now() + 1400);
  } catch (_) {}
  lastPrimaryInputEditAt = 0;
  lastSlotsEditAt = 0;
  const slotsApplied = await loadSlotsFromDb();
  if (slotsApplied && composerSlotsContainer && typeof renderComposerSlots === 'function') {
    renderComposerSlots();
    updatePrimaryInputRefs();
    if (typeof attachInputListeners === 'function') attachInputListeners();
  }
  await loadInputFromDbForChannel(currentChannel);
  try {
    /* Longer tail: delayed postgres_changes + slot/channel races were merging incremental rows and looked like the composer “typing itself” after refresh. */
    inoutChannelInputQuietUntil = Math.max(inoutChannelInputQuietUntil, Date.now() + 2800);
  } catch (_) {}
}

/* ═══ REALTIME: view object editing (everyone) vs composer input (same intent as before) ═══ */
const VIEW_EDIT_PRESENCE_STALE_MS = 14000;

function renderViewLiveEditingBar() {
  const el = document.getElementById('view-live-editing-bar');
  if (!el) return;
  const now = Date.now();
  const entries = [];
  Object.keys(viewEditingPresence).forEach(from => {
    const p = viewEditingPresence[from];
    if (!p || now - p.ts > VIEW_EDIT_PRESENCE_STALE_MS) {
      delete viewEditingPresence[from];
      return;
    }
    entries.push({
      from,
      objectId: p.objectId,
      label: from === myId ? 'You' : (p.authorName || 'Someone').trim() || 'Someone',
    });
  });
  if (!entries.length) {
    el.setAttribute('hidden', '');
    el.textContent = '';
    return;
  }
  el.removeAttribute('hidden');
  el.textContent = '';
  const prefix = document.createElement('span');
  prefix.className = 'view-live-editing-prefix';
  prefix.textContent = 'Live editing: ';
  el.appendChild(prefix);
  entries.forEach((e, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'view-live-editing-sep';
      sep.textContent = ' · ';
      el.appendChild(sep);
    }
    const pill = document.createElement('span');
    pill.className = 'view-live-editing-pill';
    const strong = document.createElement('strong');
    strong.textContent = e.label;
    pill.appendChild(strong);
    pill.appendChild(document.createTextNode(' · object '));
    const idSpan = document.createElement('span');
    idSpan.className = 'view-live-editing-id';
    idSpan.textContent = '#' + String(e.objectId);
    pill.appendChild(idSpan);
    el.appendChild(pill);
  });
  if (lastRemoteEditingId != null) {
    var stillRemote = false;
    Object.keys(viewEditingPresence).forEach(function(f) {
      var p = viewEditingPresence[f];
      if (p && Number(p.objectId) === Number(lastRemoteEditingId)) stillRemote = true;
    });
    if (!stillRemote) clearRemoteEditingDoppelganger(lastRemoteEditingId, false);
  }
}

function startViewPresencePruneTimer() {
  if (viewPresencePruneTimer) return;
  viewPresencePruneTimer = setInterval(function() {
    renderViewLiveEditingBar();
  }, 900);
}

function stopViewPresencePruneTimer() {
  if (viewPresencePruneTimer) {
    clearInterval(viewPresencePruneTimer);
    viewPresencePruneTimer = null;
  }
}

/** Stop broadcasting object edit to everyone on this view. */
function broadcastViewEditingEnd(lastObjectId) {
  if (!viewEditingChannel) return;
  realtimeBroadcastSend(viewEditingChannel, 'object_edit_end', {
    from: myId,
    objectId: lastObjectId != null && Number.isFinite(Number(lastObjectId)) ? Number(lastObjectId) : null,
  });
}

/** Tell others to drop composer draft/selection overlay for this user (e.g. switching to object edit). */
function broadcastComposerClear() {
  if (!composerSyncChannel) return;
  realtimeBroadcastSend(composerSyncChannel, 'composer_clear', { from: myId });
}

function setupDraftChannel(opts) {
  opts = opts || {};
  teardownDraftChannel({ preserveDraftBubble: !!opts.preserveDraftBubble });
  if (!opts.preserveDraftBubble) {
    latestRemoteDraft = '';
  }
  viewEditingPresence = Object.create(null);
  renderViewLiveEditingBar();

  if (!sb || !sb.channel) return;

  const chSeg = encodeURIComponent(String(currentChannel || 'global')).replace(/%/g, '_');

  viewEditingChannel = sb
    .channel('inout-view-edit-' + chSeg, {
      config: { broadcast: { self: true } },
    })
    .on('broadcast', { event: 'object_edit' }, payload => {
      const data = payload.payload || {};
      const from = data.from != null ? String(data.from) : '';
      const objectId = data.objectId != null ? Number(data.objectId) : NaN;
      if (!from || !Number.isFinite(objectId)) return;
      const authorName = data.authorName != null ? String(data.authorName) : '';
      const text = data.text != null ? String(data.text) : '';
      viewEditingPresence[from] = {
        objectId,
        authorName: authorName || 'Someone',
        ts: Date.now(),
      };
      renderViewLiveEditingBar();
      const isSelf = from === myId;
      showRemoteEditingDoppelganger(
        objectId,
        text,
        authorName || (isSelf ? 'Editing' : 'Someone'),
        data.deviceId != null ? String(data.deviceId) : '',
        isSelf
      );
    })
    .on('broadcast', { event: 'object_edit_end' }, payload => {
      const data = payload.payload || {};
      const from = data.from != null ? String(data.from) : '';
      if (!from) return;
      const prev = viewEditingPresence[from];
      delete viewEditingPresence[from];
      const oidRaw = data.objectId != null ? Number(data.objectId) : prev ? prev.objectId : null;
      const oid = oidRaw != null && Number.isFinite(oidRaw) ? oidRaw : null;
      renderViewLiveEditingBar();
      if (oid != null) {
        const stillEditing = Object.keys(viewEditingPresence).some(function(f) {
          const p = viewEditingPresence[f];
          return p && Number(p.objectId) === oid;
        });
        if (!stillEditing) {
          clearRemoteEditingDoppelganger(oid, false);
        }
      }
    })
    .subscribe();

  composerSyncChannel = sb
    .channel('inout-composer-' + chSeg, {
      config: { broadcast: { self: true } },
    })
    .on('broadcast', { event: 'input_sync' }, payload => {
      const data = payload.payload || {};
      const isSelf = data.from === myId;
      const text = data.text != null ? String(data.text) : '';
      latestRemoteDraft = text.trim();
      if (!isSelf) {
        const rs = data.selectionStart != null ? Number(data.selectionStart) : null;
        const re = data.selectionEnd != null ? Number(data.selectionEnd) : null;
        if (Number.isFinite(rs) && Number.isFinite(re) && rs >= 0 && re >= 0) {
          remoteSelection = {
            start: Math.min(rs, re),
            end: Math.max(rs, re),
            deviceId: data.deviceId != null ? String(data.deviceId) : '',
          };
        } else {
          remoteSelection = null;
        }
        updateRemoteSelectionOverlay();
      }
      if (!isSelf && text.trim()) {
        showDraftBubble(text);
      } else if (!text.trim() || isSelf) {
        hideDraftBubble();
      }
    })
    .on('broadcast', { event: 'composer_clear' }, payload => {
      const data = payload.payload || {};
      if (data.from === myId) return;
      latestRemoteDraft = '';
      remoteSelection = null;
      updateRemoteSelectionOverlay();
      hideDraftBubble();
    })
    .subscribe();

  startViewPresencePruneTimer();
}

function teardownDraftChannel(opts) {
  opts = opts || {};
  if (!opts.preserveDraftBubble) {
    latestRemoteDraft = '';
    hideDraftBubble();
  }
  remoteSelection = null;
  updateRemoteSelectionOverlay();
  viewEditingPresence = Object.create(null);
  renderViewLiveEditingBar();
  stopViewPresencePruneTimer();
  if (viewEditingChannel) {
    try { viewEditingChannel.unsubscribe(); } catch (_) {}
    viewEditingChannel = null;
  }
  if (composerSyncChannel) {
    try { composerSyncChannel.unsubscribe(); } catch (_) {}
    composerSyncChannel = null;
  }
}

/* ═══ FRAME ORDER (fixed: nav → multiview → input; drag may fire but DOM is always canonical) ── */
function getLayoutSyncPref() {
  try {
    const v = localStorage.getItem(LAYOUT_SYNC_KEY);
    return v !== 'false' && v !== '0';
  } catch (_) { return true; }
}
function setLayoutSyncPref(on, syncWorkspace) {
  try { localStorage.setItem(LAYOUT_SYNC_KEY, on ? '1' : '0'); } catch (_) {}
  if (syncWorkspace !== false) schedulePersonalWorkspacePersist();
}

function getFrameOrder() {
  /* Tabs → feed → composer only; reordering was removed so nav/input never stack above/below the view wrongly. */
  return DEFAULT_FRAME_ORDER.slice();
}

function applyFrameOrder(order) {
  const zone = document.getElementById('frames-zone');
  if (!zone) return;
  const canonical = DEFAULT_FRAME_ORDER.slice();
  const frames = Array.from(zone.querySelectorAll('.frame'));
  const byId = new Map();
  frames.forEach(f => {
    const id = f.getAttribute('data-frame-id');
    if (id) byId.set(id, f);
  });
  canonical.forEach(id => {
    const f = byId.get(id);
    if (f) zone.appendChild(f);
  });
}


function setupLayoutChannel() {
  if (layoutChannel) { try { layoutChannel.unsubscribe(); } catch (_) {} layoutChannel = null; }
  if (!sb || !sb.channel || !getLayoutSyncPref()) return;
  const layoutUserId = (currentUser && currentUser.id) ? String(currentUser.id) : getDeviceId();
  const chName = 'layout-' + layoutUserId;
  try {
    layoutChannel = sb.channel(chName, { config: { broadcast: { self: true } } })
      .on('broadcast', { event: 'layout' }, (payload) => {
        const data = payload.payload || {};
        const order = data.frameOrder;
        if (!Array.isArray(order) || order.length === 0) return;
        applyFrameOrder(order);
        try {
          localStorage.setItem(FRAME_ORDER_KEY, JSON.stringify(DEFAULT_FRAME_ORDER.slice()));
        } catch (_) {}
      })
      .subscribe();
  } catch (_) {}
}

function initFramesZone() {
  const zone = document.getElementById('frames-zone');
  if (!zone) return;
  applyFrameOrder(getFrameOrder());
  const frames = Array.from(zone.querySelectorAll('.frame'));
  frames.forEach(frame => {
    if (frame.querySelector('.frame-grip')) return;
    const grip = document.createElement('div');
    grip.className = 'frame-grip';
    grip.setAttribute('aria-hidden', 'true');
    grip.draggable = false;
    var first = frame.firstChild;
    while (first && first.nodeType !== 1) first = first.nextSibling;
    frame.insertBefore(grip, first || null);
  });
}

function broadcastDraft(text) {
  const authorName =
    (currentUser && currentUser.user_metadata && currentUser.user_metadata.full_name) ||
    (currentUser && currentUser.email) ||
    (currentUser && currentUser.id ? String(currentUser.id).slice(0, 8) : (visitInviteNick || 'guest'));
  const payloadBase = {
    from: myId,
    authorName: authorName || undefined,
    deviceId: myId,
  };
  const body = text != null ? text : (input ? input.value : '');

  if (editingObjectId != null && Number.isFinite(Number(editingObjectId))) {
    /* Never broadcast empty object_edit — use cancelEditingMode / object_edit_end so rows restore and remotes clear doppelgangers. */
    if (!String(body).length) return;
    if (!viewEditingChannel) return;
    realtimeBroadcastSend(
      viewEditingChannel,
      'object_edit',
      Object.assign({}, payloadBase, {
        objectId: Number(editingObjectId),
        text: String(body),
        ts: Date.now(),
      })
    );
    return;
  }

  if (!composerSyncChannel) return;
  var selStart = 0, selEnd = 0;
  if (input) {
    selStart = input.selectionStart != null ? input.selectionStart : 0;
    selEnd = input.selectionEnd != null ? input.selectionEnd : selStart;
  }
  realtimeBroadcastSend(
    composerSyncChannel,
    'input_sync',
    Object.assign({}, payloadBase, {
      text: body,
      selectionStart: selStart,
      selectionEnd: selEnd,
    })
  );
}

var lastRemoteEditingId = null;
var savedTextForRemote = Object.create(null);
var remoteSelection = null;

function updateRemoteSelectionOverlay() {
  var wrap = input && input.closest && input.closest('.composer-input-wrap');
  if (!wrap) return;
  var id = 'remote-selection-overlay';
  var el = document.getElementById(id);
  if (!remoteSelection) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
    return;
  }
  var text = input.value || '';
  var start = Math.max(0, Math.min(remoteSelection.start, text.length));
  var end = Math.max(0, Math.min(remoteSelection.end, text.length));
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'remote-selection-overlay';
    el.setAttribute('aria-hidden', 'true');
    wrap.appendChild(el);
  }
  var cs = typeof getComputedStyle === 'function' ? getComputedStyle(input) : null;
  if (cs) {
    el.style.font = cs.font;
    el.style.padding = cs.padding;
    el.style.lineHeight = cs.lineHeight;
    el.style.letterSpacing = cs.letterSpacing;
    el.style.whiteSpace = cs.whiteSpace;
    el.style.wordWrap = cs.wordWrap;
    el.style.boxSizing = cs.boxSizing || 'border-box';
  }
  el.style.top = (input.offsetTop || 0) + 'px';
  el.style.left = (input.offsetLeft || 0) + 'px';
  el.style.width = (input.offsetWidth || 0) + 'px';
  el.style.height = (input.offsetHeight || 0) + 'px';
  var before = escapeHtml(text.slice(0, start));
  var mid = escapeHtml(text.slice(start, end));
  var after = escapeHtml(text.slice(end));
  var caret = '<span class="remote-caret" aria-hidden="true"></span>';
  var selSpan = mid ? '<span class="remote-selection-highlight">' + mid + '</span>' : '';
  if (start < end) {
    el.innerHTML = before + selSpan + after;
  } else {
    el.innerHTML = before + caret + after;
  }
  el.scrollTop = input.scrollTop;
  el.scrollLeft = input.scrollLeft;
}

function showRemoteEditingDoppelganger(objId, text, authorName, deviceId, skipEditingRows) {
  const idStr = String(objId);
  const rows = [];
  if (feedInner) {
    rows.push.apply(rows, Array.from(feedInner.querySelectorAll('.obj[data-id="' + CSS.escape(idStr) + '"]')));
  }
  if (!rows.length) return;
  if (lastRemoteEditingId != null && lastRemoteEditingId !== objId) {
    clearRemoteEditingDoppelganger(lastRemoteEditingId);
  }
  rows.forEach(function(row) {
    if (skipEditingRows && row.classList.contains('obj-editing')) return;
    const textEl = row.querySelector('.obj-value-cell') || row.querySelector('.obj-text');
    if (!textEl) return;
    if (savedTextForRemote[objId] === undefined) {
      savedTextForRemote[objId] = getJoinedRowTextForEdit(row);
    }
    textEl.innerHTML = renderVisualOnlyHtml(text || '');
    row.classList.add('obj-remote-editing');
    let badge = textEl.querySelector('.obj-remote-edit-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'obj-remote-edit-badge';
      badge.setAttribute('aria-label', 'Editing elsewhere');
      const icon = document.createElement('span');
      icon.className = 'obj-remote-edit-device';
      icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>';
      badge.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'obj-remote-edit-author';
      badge.appendChild(label);
      textEl.appendChild(badge);
    }
    const authorSpan = badge.querySelector('.obj-remote-edit-author');
    if (authorSpan) {
      var name = (authorName || 'Editing').trim();
      var shortName = name.split(/\s+/)[0] || name;
      if (shortName.length > 12) shortName = shortName.slice(0, 12) + '…';
      authorSpan.textContent = shortName;
    }
  });
  lastRemoteEditingId = objId;
}

function clearRemoteEditingDoppelganger(objId, skipRestore) {
  const idStr = String(objId);
  const rows = [];
  if (feedInner) {
    rows.push.apply(rows, Array.from(feedInner.querySelectorAll('.obj[data-id="' + CSS.escape(idStr) + '"]')));
  }
  rows.forEach(function(row) {
    row.classList.remove('obj-remote-editing');
    const textEl = row.querySelector('.obj-value-cell') || row.querySelector('.obj-text');
    const badge = textEl ? textEl.querySelector('.obj-remote-edit-badge') : row.querySelector('.obj-remote-edit-badge');
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    if (!skipRestore && savedTextForRemote[objId] !== undefined) {
      updateObjectRowText(objId, savedTextForRemote[objId]);
    }
  });
  delete savedTextForRemote[objId];
  if (lastRemoteEditingId === objId) lastRemoteEditingId = null;
}

let dndBroadcastChannel = null;
let dndChannelReady = false;
let remoteDnd = null;
let remoteDropOriginEl = null;
let remoteDropTargetEl = null;
let remoteGhostEl = null;
let remoteSpiritEl = null;
let dndBroadcastThrottle = null;

function getLineRectForInsert(feedEl, feedInner, insertBeforeId, wantAppend) {
  if (!feedEl || !feedInner) return null;
  var rows = feedInner.querySelectorAll('.obj');
  if (!rows.length) return null;
  var feedRect = feedEl.getBoundingClientRect();
  var row = null;
  var id = insertBeforeId != null ? Number(insertBeforeId) : null;
  if (wantAppend || id == null) {
    row = rows[rows.length - 1];
  } else {
    for (var i = 0; i < rows.length; i++) {
      if (Number(rows[i].dataset.id) === id) { row = rows[i]; break; }
    }
  }
  if (!row) {
    row = wantAppend ? rows[rows.length - 1] : rows[0];
  }
  var rect = row.getBoundingClientRect();
  var top = wantAppend ? rect.bottom : rect.top;
  if (top < feedRect.top) top = feedRect.top - 2;
  else if (top > feedRect.bottom) top = feedRect.bottom - 2;
  else top = top - 2;
  return { left: feedRect.left, width: feedRect.width, top: top };
}

/* Origin line = bottom of the last dragged row (so border is correct across devices) */
function getLineRectForOrigin(feedEl, feedInner, lastDraggedId, wantAppend) {
  if (!feedEl || !feedInner) return null;
  var rows = feedInner.querySelectorAll('.obj');
  if (!rows.length) return null;
  var feedRect = feedEl.getBoundingClientRect();
  var row = null;
  if (wantAppend || lastDraggedId == null) {
    row = rows[rows.length - 1];
  } else {
    var id = Number(lastDraggedId);
    for (var i = 0; i < rows.length; i++) {
      if (Number(rows[i].dataset.id) === id) { row = rows[i]; break; }
    }
  }
  if (!row) {
    row = wantAppend ? rows[rows.length - 1] : rows[0];
  }
  var rect = row.getBoundingClientRect();
  var top = rect.bottom; /* line just below the row (bottom of block) */
  if (top < feedRect.top) top = feedRect.top - 2;
  else if (top > feedRect.bottom) top = feedRect.bottom - 2;
  else top = top - 2;
  return { left: feedRect.left, width: feedRect.width, top: top };
}

var remoteDndScrollResize = null;
function setupDndBroadcastChannel() {
  teardownDndBroadcastChannel();
  dndChannelReady = false;
  if (!currentUser || !currentChannel || !sb) return;
  remoteDndScrollResize = function() {
    if (remoteDnd && (remoteDropOriginEl || remoteDropTargetEl || remoteGhostEl || remoteSpiritEl)) applyRemoteDndLines();
  };
  var feedForScroll = document.getElementById('feed');
  if (feedForScroll) {
    feedForScroll.addEventListener('scroll', remoteDndScrollResize, { passive: true });
    var surfScroll = getFeedScrollSurface(feedForScroll);
    if (surfScroll && surfScroll !== feedForScroll) surfScroll.addEventListener('scroll', remoteDndScrollResize, { passive: true });
  }
  window.addEventListener('resize', remoteDndScrollResize);
  var chName = 'dnd-' + String(currentChannel);
  dndBroadcastChannel = sb.channel(chName, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'dnd' }, function(msg) {
      var data = (msg && msg.payload) ? msg.payload : (msg && typeof msg.type !== 'undefined' ? msg : {});
      if (!data || !data.type) return;
      if (data.from === myId) return;
      var ch = (data.channel != null) ? String(data.channel).trim() : '';
      var curCh = (currentChannel != null) ? String(currentChannel).trim() : '';
      if (ch !== curCh) return;
      if (document.body && document.body.classList.contains('dnd-active')) return;
      if (data.type === 'dnd_start') {
        var o = data.origin || {};
        var draggingIds = Array.isArray(data.draggingIds) ? data.draggingIds.map(function(x) { return Number(x); }).filter(function(x) { return Number.isFinite(x); }) : [];
        var startCursorY = typeof data.cursorY === 'number' ? data.cursorY : null;
        remoteDnd = {
          from: data.from,
          channel: data.channel,
          draggingIds: draggingIds,
          cursorY: startCursorY,
          origin: {
            insertBeforeId: o.insertBeforeId != null ? Number(o.insertBeforeId) : null,
            wantAppend: !!o.wantAppend,
            lastDraggedId: o.lastDraggedId != null ? Number(o.lastDraggedId) : null
          },
          target: { insertBeforeId: o.insertBeforeId != null ? Number(o.insertBeforeId) : null, wantAppend: !!o.wantAppend }
        };
        requestAnimationFrame(function() {
          requestAnimationFrame(function() { applyRemoteDndLines(); });
        });
      } else if (data.type === 'dnd_move') {
        if (data.target) {
          var target = { insertBeforeId: data.target.insertBeforeId != null ? Number(data.target.insertBeforeId) : null, wantAppend: !!data.target.wantAppend };
          var cursorY = typeof data.cursorY === 'number' ? data.cursorY : null;
          if (remoteDnd && remoteDnd.from === data.from) {
            remoteDnd.target = target;
            remoteDnd.cursorY = cursorY;
          } else {
            remoteDnd = { from: data.from, channel: data.channel, draggingIds: remoteDnd && remoteDnd.draggingIds ? remoteDnd.draggingIds : [], origin: {}, target: target, cursorY: cursorY };
          }
          requestAnimationFrame(function() {
            requestAnimationFrame(function() { applyRemoteDndLines(); });
          });
        }
      } else if (data.type === 'dnd_end') {
        var endCh = String(data.channel || '');
        if (
          remoteDnd &&
          (remoteDnd.from === data.from || String(remoteDnd.channel || '') === endCh)
        ) {
          remoteDnd = null;
          hideRemoteDndLines();
        }
      } else if (data.type === 'order_sync') {
        if (data.from === myId) return;
        if (String(data.channel) !== String(currentChannel)) return;
        if (document.body && document.body.classList.contains('dnd-active')) return;
        var syncOrder = Array.isArray(data.newOrder) ? data.newOrder.map(function(x) { return Number(x); }).filter(function(x) { return Number.isFinite(x); }) : [];
        if (!syncOrder.length) return;
        dismissRemoteReorderOverlayForChannel(String(currentChannel));
        suppressOrderApplyUntil = Date.now() + 600;
        currentObjectOrder = syncOrder;
        saveOrderToLocal();
        applyObjectOrderToDOM();
      } else if (data.type === 'dnd_dropped') {
        if (data.from === myId) return;
        if (String(data.channel) !== String(currentChannel)) return;
        var newOrder = Array.isArray(data.newOrder) ? data.newOrder.map(function(x) { return Number(x); }).filter(function(x) { return Number.isFinite(x); }) : [];
        var movedIds = Array.isArray(data.movedIds) ? data.movedIds.map(function(x) { return Number(x); }).filter(function(x) { return Number.isFinite(x); }) : [];
        if (!newOrder.length) return;
        dismissRemoteReorderOverlayForChannel(String(currentChannel));
        suppressOrderApplyUntil = Date.now() + 800;
        currentObjectOrder = newOrder;
        saveOrderToLocal();
        applyObjectOrderToDOM();
        var inner = document.getElementById('feed-inner');
        if (inner && movedIds.length) {
          var stagger = 30;
          var duration = 220 + movedIds.length * stagger;
          inner.querySelectorAll('.obj').forEach(function(r) {
            var id = Number(r.dataset.id);
            if (movedIds.indexOf(id) >= 0) {
              r.classList.add('obj-remote-reorder');
              var i = movedIds.indexOf(id);
              r.style.animationDelay = (i * stagger) + 'ms';
            }
          });
          setTimeout(function() {
            if (!inner.parentNode) return;
            inner.querySelectorAll('.obj-remote-reorder').forEach(function(r) {
              r.classList.remove('obj-remote-reorder');
              r.style.animationDelay = '';
            });
          }, duration);
        }
      }
    })
    .subscribe(function(status) {
      dndChannelReady = status === 'SUBSCRIBED';
    });
}

function teardownDndBroadcastChannel() {
  dndChannelReady = false;
  remoteDnd = null;
  hideRemoteDndLines();
  if (remoteDndScrollResize) {
    var feedForScroll = document.getElementById('feed');
    if (feedForScroll) {
      feedForScroll.removeEventListener('scroll', remoteDndScrollResize);
      var surfScroll = getFeedScrollSurface(feedForScroll);
      if (surfScroll && surfScroll !== feedForScroll) surfScroll.removeEventListener('scroll', remoteDndScrollResize);
    }
    window.removeEventListener('resize', remoteDndScrollResize);
    remoteDndScrollResize = null;
  }
  if (dndBroadcastChannel) {
    try { dndBroadcastChannel.unsubscribe(); } catch (_) {}
    dndBroadcastChannel = null;
  }
  if (dndBroadcastThrottle) { clearTimeout(dndBroadcastThrottle); dndBroadcastThrottle = null; }
}

var applyRemoteDndLinesRetry = null;
function applyRemoteDndLines() {
  if (!remoteDnd) return;
  var feed = document.getElementById('feed');
  var inner = document.getElementById('feed-inner');
  if (!feed || !inner) return;
  var rows = inner.querySelectorAll('.obj');
  if (!rows.length) {
    /* Feed may still be loading (e.g. on mobile); retry once so web→mobile works */
    if (applyRemoteDndLinesRetry) return;
    applyRemoteDndLinesRetry = setTimeout(function() {
      applyRemoteDndLinesRetry = null;
      applyRemoteDndLines();
    }, 80);
    return;
  }
  var origin = remoteDnd.origin;
  var target = remoteDnd.target;
  var draggingIds = remoteDnd.draggingIds || [];
  /* Origin line = bottom of last dragged row (correct border across devices) */
  var originRect = origin.lastDraggedId != null
    ? getLineRectForOrigin(feed, inner, origin.lastDraggedId, origin.wantAppend)
    : getLineRectForInsert(feed, inner, origin.insertBeforeId, origin.wantAppend);
  var targetRect = getLineRectForInsert(feed, inner, target.insertBeforeId, target.wantAppend);
  /* Remote ghost = union of dragged rows' rects (size), positioned at cursor and clamped to feed */
  var ghostRect = null;
  if (draggingIds.length) {
    var feedRectForGhost = feed.getBoundingClientRect();
    var minTop = Infinity;
    var maxBottom = -Infinity;
    for (var g = 0; g < rows.length; g++) {
      var r = rows[g];
      var id = Number(r.dataset.id);
      if (Number.isFinite(id) && draggingIds.indexOf(id) >= 0) {
        var br = r.getBoundingClientRect();
        if (br.top < minTop) minTop = br.top;
        if (br.bottom > maxBottom) maxBottom = br.bottom;
      }
    }
    if (minTop !== Infinity && maxBottom !== -Infinity && maxBottom > minTop) {
      ghostRect = { width: feedRectForGhost.width, height: maxBottom - minTop };
    }
  }
  var cursorY = remoteDnd.cursorY;
  var feedRect = feed ? feed.getBoundingClientRect() : null;
  var spiritY = (typeof cursorY === 'number' && feedRect) ? Math.max(feedRect.top + 24, Math.min(feedRect.bottom - 24, cursorY)) : null;
  if (ghostRect && typeof spiritY === 'number' && feedRect) {
    var ghostTop = Math.max(feedRect.top, Math.min(feedRect.bottom - ghostRect.height, spiritY - ghostRect.height / 2));
    if (!remoteGhostEl || !remoteGhostEl.classList.contains('remote-origin-ghost-container')) {
      if (remoteGhostEl && remoteGhostEl.parentNode) remoteGhostEl.parentNode.removeChild(remoteGhostEl);
      var ghostContainer = document.createElement('div');
      ghostContainer.className = 'remote-origin-ghost-container';
      ghostContainer.setAttribute('aria-hidden', 'true');
      var orderedRows = [];
      for (var gi = 0; gi < draggingIds.length; gi++) {
        for (var g = 0; g < rows.length; g++) {
          if (Number(rows[g].dataset.id) === draggingIds[gi]) {
            orderedRows.push(rows[g]);
            break;
          }
        }
      }
      for (var oi = 0; oi < orderedRows.length; oi++) ghostContainer.appendChild(createOriginGhostFromRow(orderedRows[oi]));
      document.body.appendChild(ghostContainer);
      remoteGhostEl = ghostContainer;
    }
    remoteGhostEl.style.left = feedRect.left + 'px';
    remoteGhostEl.style.width = ghostRect.width + 'px';
    remoteGhostEl.style.top = ghostTop + 'px';
    remoteGhostEl.style.height = ghostRect.height + 'px';
    remoteGhostEl.classList.add('visible');
  } else if (remoteGhostEl) {
    remoteGhostEl.classList.remove('visible');
  }
  if (typeof cursorY === 'number' && feed) {
    if (!feedRect) feedRect = feed.getBoundingClientRect();
    var margin = 24;
    var spiritYVal = Math.max(feedRect.top + margin, Math.min(feedRect.bottom - margin, cursorY));
    var spiritX = feedRect.left + feedRect.width / 2;
    var firstRow = null;
    var firstId = draggingIds.length ? draggingIds[0] : null;
    if (Number.isFinite(firstId)) {
      for (var si = 0; si < rows.length; si++) {
        if (Number(rows[si].dataset.id) === firstId) {
          firstRow = rows[si];
          break;
        }
      }
    }
    if (!remoteSpiritEl || !remoteSpiritEl.classList.contains('obj')) {
      if (remoteSpiritEl && remoteSpiritEl.parentNode) remoteSpiritEl.parentNode.removeChild(remoteSpiritEl);
      if (firstRow) {
        remoteSpiritEl = firstRow.cloneNode(true);
        remoteSpiritEl.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
        remoteSpiritEl.classList.add('obj', 'obj-drag-spirit', 'remote-drag-spirit');
        remoteSpiritEl.removeAttribute('draggable');
        remoteSpiritEl.setAttribute('aria-hidden', 'true');
        remoteSpiritEl.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
        var spiritW = firstRow.offsetWidth || 280;
        var maxW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth - 24 : spiritW;
        if (spiritW > maxW) spiritW = maxW;
        remoteSpiritEl.style.width = spiritW + 'px';
        remoteSpiritEl.style.minWidth = '0';
        document.body.appendChild(remoteSpiritEl);
      } else {
        remoteSpiritEl = document.createElement('div');
        remoteSpiritEl.className = 'obj-drag-spirit remote-drag-spirit';
        remoteSpiritEl.setAttribute('aria-hidden', 'true');
        remoteSpiritEl.style.minWidth = '280px';
        remoteSpiritEl.style.minHeight = '32px';
        document.body.appendChild(remoteSpiritEl);
      }
    }
    if (remoteSpiritEl) {
      remoteSpiritEl.style.left = spiritX + 'px';
      remoteSpiritEl.style.top = spiritYVal + 'px';
      remoteSpiritEl.classList.add('visible');
    }
  } else if (remoteSpiritEl) {
    remoteSpiritEl.classList.remove('visible');
  }
  if (originRect) {
    if (!remoteDropOriginEl) {
      remoteDropOriginEl = document.createElement('div');
      remoteDropOriginEl.className = 'feed-drop-origin remote-dnd-line';
      remoteDropOriginEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(remoteDropOriginEl);
    }
    remoteDropOriginEl.style.left = originRect.left + 'px';
    remoteDropOriginEl.style.width = originRect.width + 'px';
    remoteDropOriginEl.style.top = originRect.top + 'px';
    remoteDropOriginEl.style.height = '2px';
    remoteDropOriginEl.classList.add('visible');
  }
  if (targetRect) {
    // remote drop target visual removed
  }
}

function hideRemoteDndLines() {
  if (applyRemoteDndLinesRetry) {
    clearTimeout(applyRemoteDndLinesRetry);
    applyRemoteDndLinesRetry = null;
  }
  if (remoteGhostEl && remoteGhostEl.parentNode) remoteGhostEl.parentNode.removeChild(remoteGhostEl);
  remoteGhostEl = null;
  if (remoteSpiritEl && remoteSpiritEl.parentNode) remoteSpiritEl.parentNode.removeChild(remoteSpiritEl);
  remoteSpiritEl = null;
  if (remoteDropOriginEl && remoteDropOriginEl.parentNode) remoteDropOriginEl.parentNode.removeChild(remoteDropOriginEl);
  remoteDropOriginEl = null;
  if (remoteDropTargetEl && remoteDropTargetEl.parentNode) remoteDropTargetEl.parentNode.removeChild(remoteDropTargetEl);
  remoteDropTargetEl = null;
}

/** Drop ghost/spirit when order landed via DB or order_sync — dnd_end can be missed if channel was slow. */
function dismissRemoteReorderOverlayForChannel(channelKey) {
  var want = String(channelKey != null ? channelKey : '');
  if (remoteDnd && String(remoteDnd.channel || '') !== want) return;
  remoteDnd = null;
  hideRemoteDndLines();
}

function broadcastDndStart() {
  if (!dndBroadcastChannel || !currentUser || !dndChannelReady) return;
  var insertBeforeId = dndOriginInsertBefore && dndOriginInsertBefore.dataset ? Number(dndOriginInsertBefore.dataset.id) : null;
  var block = (dragSelectedRows && dragSelectedRows.length) ? dragSelectedRows : (typeof row !== 'undefined' && row ? [row] : []);
  var lastDraggedId = block.length ? (block[block.length - 1].dataset && block[block.length - 1].dataset.id ? Number(block[block.length - 1].dataset.id) : null) : null;
  var draggingIds = block.map(function(r) { return Number(r.dataset.id); }).filter(function(id) { return Number.isFinite(id); });
  realtimeBroadcastSend(dndBroadcastChannel, 'dnd', {
    type: 'dnd_start',
    from: myId,
    channel: String(currentChannel),
    draggingIds: draggingIds,
    origin: { insertBeforeId: insertBeforeId, wantAppend: !!dndOriginWantAppend, lastDraggedId: lastDraggedId },
    cursorY: typeof lastDragClientY === 'number' ? lastDragClientY : null,
  });
}

function broadcastDndMove() {
  if (!dndBroadcastChannel || !dndChannelReady || !lastReorderTarget) return;
  if (dndBroadcastThrottle) return;
  dndBroadcastThrottle = setTimeout(function() {
    dndBroadcastThrottle = null;
    if (!dndBroadcastChannel || !dndChannelReady || !lastReorderTarget) return;
    var insertBeforeId = lastReorderTarget.insertBefore && lastReorderTarget.insertBefore.dataset ? Number(lastReorderTarget.insertBefore.dataset.id) : null;
    var y = typeof lastDragClientY === 'number' ? lastDragClientY : null;
    realtimeBroadcastSend(dndBroadcastChannel, 'dnd', {
      type: 'dnd_move',
      from: myId,
      channel: String(currentChannel),
      target: { insertBeforeId: insertBeforeId, wantAppend: !!lastReorderTarget.wantAppend },
      cursorY: y,
    });
  }, 80);
}

function broadcastDndEnd() {
  if (!dndBroadcastChannel || !dndChannelReady) return;
  realtimeBroadcastSend(dndBroadcastChannel, 'dnd', {
    type: 'dnd_end',
    from: myId,
    channel: String(currentChannel),
  });
}

function computeReorderMovedIdsForBroadcast(oldOrder, newOrder) {
  const oldArr = Array.isArray(oldOrder) ? oldOrder : [];
  const newArr = Array.isArray(newOrder) ? newOrder : [];
  if (!newArr.length) return [];
  if (!oldArr.length) return newArr.slice();
  if (oldArr.length !== newArr.length) return newArr.slice();
  const touched = new Set();
  for (let i = 0; i < newArr.length; i++) {
    if (oldArr[i] !== newArr[i]) {
      touched.add(newArr[i]);
      if (oldArr[i] != null) touched.add(oldArr[i]);
    }
  }
  return touched.size ? Array.from(touched).filter(id => Number.isFinite(Number(id))).map(Number) : newArr.slice();
}

function broadcastDndDropped(newOrder, movedIds) {
  if (!dndBroadcastChannel || !dndChannelReady || !newOrder || !newOrder.length) return;
  const mids = Array.isArray(movedIds) ? movedIds.map(x => Number(x)).filter(x => Number.isFinite(x)) : [];
  realtimeBroadcastSend(dndBroadcastChannel, 'dnd', {
    type: 'dnd_dropped',
    from: myId,
    channel: String(currentChannel),
    newOrder: newOrder,
    movedIds: mids.length ? mids : computeReorderMovedIdsForBroadcast(savedOrderBeforeDrag, newOrder),
  });
}

/** After DB save / any order change — keeps peers in sync when postgres realtime misses updates. */
function broadcastOrderSyncFromSave() {
  if (!currentObjectOrder.length) return;
  if (!shouldUseServerForObjects() || !currentUser || !currentChannel) return;
  var attempt = 0;
  function tick() {
    if (!currentObjectOrder.length || attempt > 16) return;
    if (dndBroadcastChannel && dndChannelReady) {
      try {
        realtimeBroadcastSend(dndBroadcastChannel, 'dnd', {
          type: 'order_sync',
          from: myId,
          channel: String(currentChannel),
          newOrder: currentObjectOrder.slice(),
        });
      } catch (_) {}
      return;
    }
    attempt++;
    setTimeout(tick, 200);
  }
  tick();
}

function maybeBroadcastOrderAfterReorder(savedBefore, movedIds) {
  if (!dndBroadcastChannel || !dndChannelReady || !currentObjectOrder.length) return;
  const before = Array.isArray(savedBefore) ? savedBefore : [];
  const orderChanged =
    before.length !== currentObjectOrder.length ||
    currentObjectOrder.some((id, i) => before[i] !== id);
  if (!orderChanged) return;
  const mids = Array.isArray(movedIds) ? movedIds.map(x => Number(x)).filter(x => Number.isFinite(x)) : [];
  broadcastDndDropped(
    currentObjectOrder.slice(),
    mids.length ? mids : computeReorderMovedIdsForBroadcast(before, currentObjectOrder)
  );
}

function showDraftBubble(text) {
  if (!draftBubble || !draftBubbleTxt) return;
  draftBubbleTxt.textContent = text;
  draftBubble.style.display = 'flex';
}

function hideDraftBubble() {
  if (!draftBubble) return;
  draftBubble.style.display = 'none';
  if (draftBubbleTxt) draftBubbleTxt.textContent = '';
}

function showClipboardBubble(text) {
  if (!clipboardBubble || !clipboardBubbleTxt) return;
  var raw = String(text == null ? '' : text);
  if (!raw.trim()) return;
  latestClipboardText = raw;
  var preview = raw.length > 240 ? raw.slice(0, 240) + '…' : raw;
  clipboardBubbleTxt.textContent = preview;
  applyClipboardBubbleDeviceStyle();
  clipboardBubble.style.display = 'flex';
}

function isTextLikeFile(file) {
  if (!file || !file.name) return false;
  var n = String(file.name).toLowerCase();
  return file.type === 'text/plain' || n.endsWith('.txt') || n.endsWith('.md');
}

function readFileAsText(file) {
  return new Promise(function(resolve, reject) {
    var r = new FileReader();
    r.onload = function() { resolve(String(r.result != null ? r.result : '')); };
    r.onerror = function() { reject(r.error); };
    r.readAsText(file);
  });
}

/** Dropped .txt / plain text — show above composer like clipboard (full text on Paste). */
function showTextFileBubble(text, filename) {
  if (!clipboardBubble || !clipboardBubbleTxt) return;
  var raw = String(text == null ? '' : text);
  if (!raw.trim()) {
    toast('File is empty.');
    return;
  }
  latestClipboardText = raw;
  var head = filename ? ('📄 ' + filename + '\n') : '📄 ';
  var body = raw.length > 220 ? raw.slice(0, 220) + '…' : raw;
  clipboardBubbleTxt.textContent = head + body;
  if (clipboardBubbleDeviceEl) {
    clipboardBubbleDeviceEl.textContent = '📄';
    clipboardBubbleDeviceEl.setAttribute('title', 'Text file — Paste puts full contents into input');
  }
  clipboardBubble.style.display = 'flex';
}

function isFileDragDataTransfer(dt) {
  if (!dt || !dt.types) return false;
  try {
    if (typeof dt.types.contains === 'function' && dt.types.contains('Files')) return true;
  } catch (_) {}
  try {
    for (var i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === 'Files') return true;
    }
  } catch (_) {}
  return false;
}

var TEXT_IMPORT_MAX_LINES = 400;

async function importPlainTextLinesAsObjects(text) {
  var lines = String(text || '').split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
  if (!lines.length) {
    toast('No non-empty lines to import.');
    return;
  }
  var use = lines.slice(0, TEXT_IMPORT_MAX_LINES);
  for (var i = 0; i < use.length; i++) {
    await sendText(use[i]);
  }
  if (lines.length > TEXT_IMPORT_MAX_LINES) {
    toast('Imported ' + TEXT_IMPORT_MAX_LINES + ' lines (cap).');
  } else {
    toast('Imported ' + use.length + ' line(s) as objects.');
  }
}

function setupTextFileImportDropTargets() {
  function onDragOverFeed(e) {
    if (!isFileDragDataTransfer(e.dataTransfer)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
  }
  function onDropFeed(e) {
    if (!isFileDragDataTransfer(e.dataTransfer)) return;
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !isTextLikeFile(f)) return;
    e.preventDefault();
    e.stopPropagation();
    readFileAsText(f)
      .then(function(t) { return importPlainTextLinesAsObjects(t); })
      .catch(function(err) {
        console.error(err);
        toast('Could not read file.');
      });
  }
  if (feedEl) {
    feedEl.addEventListener('dragover', onDragOverFeed);
    feedEl.addEventListener('drop', onDropFeed, true);
  }
  var inputArea = document.getElementById('input-area');
  if (inputArea) {
    inputArea.addEventListener('dragover', function(e) {
      if (!isFileDragDataTransfer(e.dataTransfer)) return;
      var t = e.target;
      if (t && t.closest && t.closest('.composer-input-wrap')) {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
      }
    });
    inputArea.addEventListener('drop', function(e) {
      if (!isFileDragDataTransfer(e.dataTransfer)) return;
      var t = e.target;
      if (!t || !t.closest || !t.closest('.composer-input-wrap')) return;
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !isTextLikeFile(f)) return;
      e.preventDefault();
      e.stopPropagation();
      readFileAsText(f)
        .then(function(text) {
          showTextFileBubble(text, f.name);
          toast('Text file — use Paste to put it in the input.');
        })
        .catch(function(err) {
          console.error(err);
          toast('Could not read file.');
        });
    }, true);
  }
}

function hideClipboardBubble() {
  if (!clipboardBubble) return;
  clipboardBubble.style.display = 'none';
  if (clipboardBubbleTxt) clipboardBubbleTxt.textContent = '';
}

function showEmptyIfNoObjects() {
  if (!feedInner || !emptyEl) return;
  const hasMsg = feedInner.querySelector('.obj');
  if (hasMsg) return;
  try {
    var loader = emptyEl.querySelector('.loader-inner');
    if (loader) {
      for (var i = emptyEl.childNodes.length - 1; i >= 0; i--) {
        if (emptyEl.childNodes[i] !== loader) emptyEl.removeChild(emptyEl.childNodes[i]);
      }
    }
  } catch (_) {}
  if (!emptyEl.parentNode) {
    emptyEl.style.animation = '';
    feedInner.appendChild(emptyEl);
  }
}

/** Clear selection when switching primary tab/view so counts don’t accumulate across channels. */
function clearSelectionOnPrimaryViewSwitch() {
  selectModeAutoOn = false;
  selectedIds.clear();
  try {
    document.querySelectorAll('.obj .obj-select').forEach(function(box) {
      box.checked = false;
    });
    document.querySelectorAll('.obj.obj-selected').forEach(function(row) {
      row.classList.remove('obj-selected');
    });
  } catch (_) {}
  if (selectMode) setSelectMode(false);
  else {
    refreshObjectRowBulkActionBars();
  }
}

function setSelectMode(on) {
  selectMode = !!on;
  currentMode = selectMode ? Modes.SELECT : Modes.NORMAL;
  if (selectMode) {
    document.body.dataset.mode = Modes.SELECT;
  } else {
    document.body.dataset.mode = Modes.NORMAL;
    selectedIds.clear();
    try {
      document.querySelectorAll('.obj .obj-select').forEach(function(box) {
        box.checked = false;
      });
      document.querySelectorAll('.obj.obj-selected').forEach(function(row) {
        row.classList.remove('obj-selected');
      });
    } catch (_) {}
  }
  if (selectToggle) {
    selectToggle.classList.toggle('active', selectMode);
    selectToggle.textContent = 'Select';
    selectToggle.setAttribute('aria-pressed', selectMode ? 'true' : 'false');
  }
  if (selectExtra) selectExtra.classList.toggle('show', selectMode);
  document.body.classList.toggle('select-mode', selectMode);
  if (manageActions) {
    manageActions.classList.toggle('visible', selectMode);
  }
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(syncInoutManageRailWidthVar);
  } else {
    syncInoutManageRailWidthVar();
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedIds.size;
  if (count > 0 && !selectMode) {
    selectModeAutoOn = true;
    setSelectMode(true);
  } else if (count === 0 && selectModeAutoOn) {
    selectModeAutoOn = false;
    setSelectMode(false);
  }
  refreshObjectRowBulkActionBars();
}

function refreshObjectRowBulkActionBars() {
  const sel = selectedIds;
  const n = sel && typeof sel.size === 'number' ? sel.size : 0;
  try {
    document.querySelectorAll('.obj').forEach(function(row) {
      const actions = row.querySelector('.obj-actions');
      if (!actions) return;
      const rawId = row.dataset && row.dataset.id;
      const id = rawId != null && rawId !== '' ? Number(rawId) : NaN;
      const bulk = n > 1 && Number.isFinite(id) && sel && sel.has(id);
      actions.classList.toggle('obj-actions-bulk', bulk);
      const trigger = actions.querySelector('.obj-actions-trigger');
      if (!trigger) return;
      if (bulk) {
        trigger.textContent = String(n);
        trigger.setAttribute('aria-label', 'Actions for all ' + n + ' selected');
        trigger.classList.add('obj-actions-trigger-bulk');
      } else {
        trigger.textContent = '\u22EE';
        trigger.setAttribute('aria-label', 'Object actions');
        trigger.classList.remove('obj-actions-trigger-bulk');
      }
    });
  } catch (_) {}
}

function restoreLastChannel() {
  try {
    const saved = localStorage.getItem(CURRENT_VIEW_KEY);
    if (!saved) return;
    if (!viewNames.includes(saved)) return;
    currentView = saved;
    currentChannel = currentView;
    if (views[0]) views[0].channel = currentView;
    updateTabsUI();
  } catch (_) {}
}

/** Single main feed only: strip any legacy extra `.view` nodes under `#multiview`. */
function closeExtraViews() {
  const root = document.getElementById('multiview');
  if (root) {
    root.querySelectorAll('.view').forEach(function(el) {
      if (el.id === 'view-app') return;
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }
  views = views.filter(v => v && v.id === 'view-0');
  try { localStorage.setItem(OPEN_VIEWS_KEY, '[]'); } catch (_) {}
  updateTabsUI();
}

function restoreInputGlobal() {
  if (!input) return;
  try {
    if (inputSlots.length > 0) {
      input.value = inputSlots[0].value || '';
    } else {
      input.value = localStorage.getItem(INPUT_STATE_KEY) || '';
    }
    autoResize();
    if (sendBtn) sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
  } catch (_) {}
}

function saveInputGlobal(opts) {
  opts = opts || {};
  if (!input) return;
  try {
    if (inputSlots.length > 0) {
      inputSlots[0].value = input.value || '';
      saveInputSlots(opts);
    } else {
      localStorage.setItem(INPUT_STATE_KEY, input.value || '');
    }
  } catch (_) {}
}

function updateClearInputBtn() {
  if (!clearInputBtn || !input) return;
  clearInputBtn.disabled = !input.value;
  updateComposerCount();
}

function applyFieldPrefsUI() {
  if (fieldTimeChk) fieldTimeChk.checked = !!fieldPrefs.showTime;
  if (fieldAuthorChk) fieldAuthorChk.checked = !!fieldPrefs.showAuthor;
  if (fieldLabelsChk) fieldLabelsChk.checked = !!fieldPrefs.showLabels;
}

async function persistChannelViewRulesForCurrentChannel() {
  if (!currentUser || !shouldUseServerForObjects() || !sb || !sb.from) return;
  const ch = String(currentChannel || currentView || 'main');
  try {
    let q = sb.from('views').select('config').eq('channel', ch).limit(1);
    if (!isChannelViewCollaborative(ch) && currentUser.id) q = q.eq('user_id', currentUser.id);
    const { data } = await q.maybeSingle();
    const base = data ? normalizeViewConfig(data.config) : null;
    const cfg = Object.assign({}, base && typeof base === 'object' ? base : {}, {
      order: Array.isArray(currentObjectOrder) ? currentObjectOrder.slice() : [],
      title:
        viewDisplayNames && typeof viewDisplayNames[ch] === 'string' && viewDisplayNames[ch].trim()
          ? viewDisplayNames[ch].trim()
          : base && base.title != null
            ? base.title
            : null,
      showTime: !!fieldPrefs.showTime,
      showAuthor: !!fieldPrefs.showAuthor,
      showLabels: !!fieldPrefs.showLabels,
      viewMode: 'feed',
    });
    if (!cfg.title) delete cfg.title;
    suppressNextViewApply = true;
    const { error: upErr } = await upsertChannelViewConfigMerged(ch, cfg);
    if (upErr) console.error(upErr);
  } catch (e) {
    console.error(e);
  }
}

function schedulePersistChannelViewRules() {
  if (!currentUser || !shouldUseServerForObjects() || !sb) return;
  if (_channelViewRulesPersistTimer) clearTimeout(_channelViewRulesPersistTimer);
  _channelViewRulesPersistTimer = setTimeout(function() {
    _channelViewRulesPersistTimer = null;
    persistChannelViewRulesForCurrentChannel();
  }, 400);
}

async function loadFieldPrefsForCurrentChannel() {
  const defTime = true;
  const defAuthor = true;
  if (currentUser) {
    try {
      let q = sb
        .from('views')
        .select('config')
        .eq('channel', currentChannel)
        .limit(1);
      if (!isChannelViewCollaborative(currentChannel)) q = q.eq('user_id', currentUser.id);
      const { data, error } = await q.maybeSingle();
      const cfgPref = !error && data ? normalizeViewConfig(data.config) : null;
      if (cfgPref) {
        applyRemoteViewTitle(currentChannel, cfgPref.title);
        fieldPrefs = {
          showTime: typeof cfgPref.showTime === 'boolean' ? cfgPref.showTime : defTime,
          showAuthor: typeof cfgPref.showAuthor === 'boolean' ? cfgPref.showAuthor : defAuthor,
          showLabels: typeof cfgPref.showLabels === 'boolean' ? cfgPref.showLabels : true,
        };
        try {
          const raw = localStorage.getItem(FIELD_PREFS_KEY);
          const map = raw ? JSON.parse(raw) : {};
          map[currentChannel] = { showTime: !!fieldPrefs.showTime, showAuthor: !!fieldPrefs.showAuthor, showLabels: !!fieldPrefs.showLabels };
          localStorage.setItem(FIELD_PREFS_KEY, JSON.stringify(map));
        } catch (_) {}
        applyFieldPrefsUI();
        applyFieldPrefsToObjects();
        return;
      }
    } catch (_) {}
  }
  try {
    const raw = localStorage.getItem(FIELD_PREFS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const prefs = map[currentChannel] || {};
    fieldPrefs = {
      showTime: typeof prefs.showTime === 'boolean' ? prefs.showTime : defTime,
      showAuthor: typeof prefs.showAuthor === 'boolean' ? prefs.showAuthor : defAuthor,
      showLabels: typeof prefs.showLabels === 'boolean' ? prefs.showLabels : true,
    };
  } catch (_) {
    fieldPrefs = { showTime: true, showAuthor: true, showLabels: true };
  }
  applyFieldPrefsUI();
  applyFieldPrefsToObjects();
}

function saveFieldPrefsForCurrentChannel() {
  try {
    const raw = localStorage.getItem(FIELD_PREFS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[currentChannel] = {
      showTime: !!fieldPrefs.showTime,
      showAuthor: !!fieldPrefs.showAuthor,
      showLabels: !!fieldPrefs.showLabels,
    };
    localStorage.setItem(FIELD_PREFS_KEY, JSON.stringify(map));
  } catch(_) {}
}

/** @param {boolean} [skipMultiValueChrome] True when caller runs syncFeedMultiValueChrome right after (avoids a second full pass). */
function applyFieldPrefsToObjects(skipMultiValueChrome) {
  if (!feedInner || !fieldPrefs) return;
  const rows = feedInner.querySelectorAll('.obj');
  rows.forEach(row => {
    const timeEl = row.querySelector('.obj-time');
    const senderEl = row.querySelector('.obj-sender');
    if (timeEl) {
      if (!fieldPrefs.showTime) timeEl.style.setProperty('display', 'none', 'important');
      else timeEl.style.removeProperty('display');
    }
    if (senderEl) senderEl.style.setProperty('display', fieldPrefs.showAuthor ? 'block' : 'none', 'important');
  });
  feedInner.classList.toggle('obj-labels-off', !fieldPrefs.showLabels);
  if (!skipMultiValueChrome) {
    syncFeedMultiValueChrome(feedInner);
    }
  applyFieldPrefsUI();
}

/* ═══ RENDER ══════════════════════════════════════════════ */
function setupTouchDragHandlers() {
  if (touchDragState && touchDragState.bound) return;
  touchDragState = {
    row: null,
    started: false,
    timer: null,
    bound: true,
    originLineShown: false,
    fromRail: false,
  };
  const move = e => {
    if (!touchDragState || !touchDragState.started || !touchDragState.row) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    if (e.cancelable) e.preventDefault();
    if (!touchDragState.originLineShown) {
      touchDragState.originLineShown = true;
      showDropOriginLine();
    }
    const y = touch.clientY;
    const x = touch.clientX;
    lastDragClientY = y;
    lastDragClientX = x;
    const rail = document.getElementById('view-pinned-rail');
    if (rail) {
      const rr = rail.getBoundingClientRect();
      if (x >= rr.left && x <= rr.right && y >= rr.top && y <= rr.bottom) {
        lastReorderTarget = { pinToEdge: true };
        return;
      }
    }
    if (lastReorderTarget && lastReorderTarget.pinToEdge) lastReorderTarget = null;
    const rows = Array.from(feedInner.querySelectorAll('.obj'));
    if (!rows.length) return;
    var block = dragSelectedRows && dragSelectedRows.length > 1 ? dragSelectedRows.slice() : [touchDragState.row];
    var skip = new Set(block);
    let target = null;
    let targetCenterDist = Infinity;
    rows.forEach(r => {
      if (skip.has(r)) return;
      const rect = r.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const dist = Math.abs(center - y);
      if (dist < targetCenterDist) {
        targetCenterDist = dist;
        target = r;
      }
    });
    if (!target) return;
    const targetRect = target.getBoundingClientRect();
    const before = y < targetRect.top + targetRect.height / 2;
    var insertRef = before ? target : target.nextSibling;
    lastReorderTarget = { insertBefore: insertRef || null, wantAppend: !insertRef };
    if (dndBroadcastChannel) {
      var insertBeforeId = insertRef && insertRef.dataset && insertRef.dataset.id ? Number(insertRef.dataset.id) : null;
      if (dndBroadcastThrottle) { clearTimeout(dndBroadcastThrottle); }
      dndBroadcastThrottle = setTimeout(function() {
        dndBroadcastThrottle = null;
        if (dndBroadcastChannel && dndChannelReady) {
          realtimeBroadcastSend(dndBroadcastChannel, 'dnd', {
            type: 'dnd_move',
            from: myId,
            channel: String(currentChannel),
            target: { insertBeforeId: insertBeforeId, wantAppend: !insertRef },
            cursorY: y,
          });
        }
      }, 80);
    }
    if (block.length > 1) {
      var refAfterBlock = block[block.length - 1].nextSibling;
      block.forEach(function(r) { if (r.parentNode === feedInner) feedInner.removeChild(r); });
      var ins = block.indexOf(target) >= 0 ? refAfterBlock : insertRef;
      if (ins) {
        feedInner.insertBefore(block[0], ins);
        for (var i = 1; i < block.length; i++) feedInner.insertBefore(block[i], block[i - 1].nextSibling);
      } else {
        feedInner.appendChild(block[0]);
        for (var j = 1; j < block.length; j++) feedInner.insertBefore(block[j], block[j - 1].nextSibling);
      }
    } else {
      if (insertRef) feedInner.insertBefore(touchDragState.row, insertRef);
      else feedInner.appendChild(touchDragState.row);
    }
    updateEdgeScroll(y, touch.clientX);
  };
  const end = () => {
    if (!touchDragState || !touchDragState.row) return;
    var r = touchDragState.row;
    const wasStarted = touchDragState.started;
    var block = (dragSelectedRows && dragSelectedRows.length) ? dragSelectedRows.slice() : [r];
    var droppedMovedIdsTouch = block.map(function(x) { return Number(x.dataset.id); }).filter(function(id) { return Number.isFinite(id); });
    var fromRail = touchDragState.fromRail;
    const railEnd = document.getElementById('view-pinned-rail');
    if (feedInner) feedInner.querySelectorAll('.obj-drag-group').forEach(function(el) { el.classList.remove('obj-drag-group'); });
    dragSelectedRows = [];
    clearEdgeScrollInterval();
    clearTimeout(touchDragState.timer);
    document.removeEventListener('touchmove', move, { passive: false });
    hideDropOriginLine();
    r.classList.remove('dragging');
    if (document.body) {
      document.body.classList.remove('dnd-active');
      if (wasStarted) document.body.classList.add('dnd-just-ended');
    }
    touchDragState.started = false;
    touchDragState.row = null;
    touchDragState.originLineShown = false;
    touchDragState.fromRail = false;
    dndOriginInsertBefore = null;
    dndOriginWantAppend = false;
    dndOriginLineY = null;
    if (!wasStarted) {
      requestAnimationFrame(function() {
        if (document.body) document.body.classList.remove('dnd-just-ended');
      });
      return;
    }
    broadcastDndEnd();
    if (lastReorderTarget && lastReorderTarget.pinToEdge && railEnd && droppedMovedIdsTouch.length) {
      addPinnedIds(currentView, droppedMovedIdsTouch);
      block.forEach(function(el) {
        if (el.parentNode === feedInner) feedInner.removeChild(el);
        if (railEnd && el.parentNode !== railEnd) railEnd.appendChild(el);
      });
      currentObjectOrder = currentObjectOrder.filter(function(id) { return droppedMovedIdsTouch.indexOf(id) === -1; });
      saveObjectOrderForCurrentView();
      lastReorderTarget = null;
    } else if (fromRail && droppedMovedIdsTouch.length) {
      removePinnedIds(currentView, droppedMovedIdsTouch);
    }
    const container = r && r.closest ? r.closest('.feed-inner') : null;
    recomputeOrderFromDOM(container);
    applyObjectOrderToDOM();
    saveObjectOrderForCurrentView();
    maybeBroadcastOrderAfterReorder(savedOrderBeforeDrag, droppedMovedIdsTouch);
    lastReorderTarget = null;
    applyFieldPrefsToObjects();
    r.style.pointerEvents = 'none';
    void r.offsetHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => {
        if (document.body) document.body.classList.remove('dnd-just-ended');
        r.style.pointerEvents = '';
          focusMainInput();
        }, 120);
      });
    });
  };
  /* Do NOT register non-passive document touchmove here — iOS/WKWebView disables fast scrolling
   * while any non-passive touchmove exists on document, even if preventDefault is never called.
   * touchmove/end are attached only when long-press reorder actually starts (see row touchstart). */
  touchDragState._onTouchMoveForDnD = move;
  document.addEventListener('touchend', end, { passive: true });
}

/** Create one object row (DOM) from object data; primary value is obj.text. options.skipEmptyRemove: true when building for a non-primary feed. */
function createObjectRow(obj, isNew, options) {
  if (obj && typeof obj.id !== 'undefined') {
    if (seenIds.has(obj.id)) return null;
    seenIds.add(obj.id);
  }
  if (!(options && options.skipEmptyRemove)) {
    if (emptyEl && emptyEl.parentNode) emptyEl.remove();
  }

  const row  = document.createElement('div');
  row.className = 'obj' + (isNew ? ' new-flash' : '');
  if (typeof obj.id !== 'undefined') row.dataset.id = String(obj.id);
  var valueColCount =
    (options && options.valueColumnCount) ||
    (feedInner && parseInt(feedInner.dataset.inoutValueCols, 10)) ||
    1;
  valueColCount = Math.max(1, valueColCount);
  row.dataset.valueCols = String(valueColCount);
  row.draggable = true;
  if (obj.channel != null) row.setAttribute('data-object-channel', String(obj.channel));
  if (typeof obj.id !== 'undefined') {
    rememberEntryText(
      obj.channel != null ? String(obj.channel) : String(currentChannel || 'main'),
      obj.id,
      obj.text
    );
  }
  row.__inoutEntryTextRaw = String(obj && obj.text != null ? obj.text : '');
  row.addEventListener('dragstart', e => {
    if (pointerDownOnSelectArea) {
      e.preventDefault();
      pointerDownOnSelectArea = false;
      return;
    }
    var valueCellStart = e.target.closest && e.target.closest('.obj-value-cell');
    if (
      valueCellStart &&
      row.contains(valueCellStart) &&
      !e.target.closest('a') &&
      !e.target.closest('.obj-remote-edit-badge') &&
      !selectMode &&
      !row.classList.contains('obj-editing') &&
      typeof obj.id !== 'undefined'
    ) {
      valueDnDActive = true;
      valueDnDSourceCell = valueCellStart;
      valueCellStart.classList.add('obj-value-dnd-source');
      try {
        e.dataTransfer.setData(
          VALUE_DND_MIME,
          JSON.stringify({
            id: Number(obj.id),
            vi: parseInt(valueCellStart.dataset.valueIndex || '0', 10),
            ch: channelKeyForRowEl(row),
          })
        );
      } catch (_) {}
      e.dataTransfer.effectAllowed = 'move';
      if (!dragImageEl) {
        dragImageEl = document.createElement('div');
        dragImageEl.setAttribute('aria-hidden', 'true');
        dragImageEl.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
        document.body.appendChild(dragImageEl);
      }
      if (dragImageEl.parentNode !== document.body) document.body.appendChild(dragImageEl);
      e.dataTransfer.setDragImage(dragImageEl, -9999, -9999);
      e.stopPropagation();
      return;
    }
    valueDnDActive = false;
    if (dragSpiritEl && dragSpiritEl.parentNode) dragSpiritEl.parentNode.removeChild(dragSpiritEl);
    if (feedInner && selectedIds.has(obj.id) && selectedIds.size > 1) {
      dragSelectedRows = Array.from(feedInner.querySelectorAll('.obj.obj-selected'));
    } else {
      dragSelectedRows = [row];
    }
    var spiritW = Math.max(200, (row.offsetWidth || 280));
    var rowRect = row.getBoundingClientRect();
    var fr0 = feedEl ? feedEl.getBoundingClientRect() : rowRect;
    var margin0 = 24;
    var startTop = Math.max(fr0.top + margin0, Math.min(fr0.bottom - margin0, e.clientY || rowRect.top));
    if (dragSelectedRows.length > 1) {
      var stackContainer = document.createElement('div');
      stackContainer.className = 'obj-drag-spirit obj-drag-spirit-stack';
      stackContainer.setAttribute('aria-hidden', 'true');
      stackContainer.style.width = spiritW + 'px';
      stackContainer.style.left = (rowRect.left + rowRect.width / 2) + 'px';
      stackContainer.style.top = startTop + 'px';
      var maxVisible = 4;
      var toShow = Math.min(dragSelectedRows.length, maxVisible);
      for (var si = 0; si < toShow; si++) {
        var r = dragSelectedRows[si];
        var clone = r.cloneNode(true);
        clone.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
        clone.classList.add('obj', 'obj-drag-spirit-row');
        clone.removeAttribute('draggable');
        clone.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
        stackContainer.appendChild(clone);
      }
      if (dragSelectedRows.length > maxVisible) {
        var extra = document.createElement('div');
        extra.className = 'obj-drag-spirit-stack-more';
        extra.textContent = '+' + (dragSelectedRows.length - maxVisible);
        stackContainer.appendChild(extra);
      }
      document.body.appendChild(stackContainer);
      dragSpiritEl = stackContainer;
    } else {
      dragSpiritEl = row.cloneNode(true);
      dragSpiritEl.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
      dragSpiritEl.classList.add('obj', 'obj-drag-spirit', 'obj-drag-spirit-row');
      dragSpiritEl.removeAttribute('draggable');
      dragSpiritEl.setAttribute('aria-hidden', 'true');
      dragSpiritEl.style.width = spiritW + 'px';
      dragSpiritEl.style.left = (rowRect.left + rowRect.width / 2) + 'px';
      dragSpiritEl.style.top = startTop + 'px';
      dragSpiritEl.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
      document.body.appendChild(dragSpiritEl);
    }
    if (!dragImageEl) {
      dragImageEl = document.createElement('div');
      dragImageEl.setAttribute('aria-hidden', 'true');
      dragImageEl.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
      document.body.appendChild(dragImageEl);
    }
    if (dragImageEl.parentNode !== document.body) document.body.appendChild(dragImageEl);
    e.dataTransfer.setDragImage(dragImageEl, -9999, -9999);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', typeof obj.text === 'string' ? obj.text : '');
    if (typeof obj.id !== 'undefined') e.dataTransfer.setData('application/x-inout-obj-id', String(obj.id));
    dragSelectedRows.forEach(function(r) {
      if (dragSelectedRows.length > 1) r.classList.add('obj-drag-group');
      r.classList.add('dragging-in-feed');
    });
    if (dragSelectedRows.length > 1) {
      dragSelectedRows.forEach(function(r) { r.classList.add('obj-dnd-stack-form'); });
      if (dndStackFormTimer) clearTimeout(dndStackFormTimer);
      dndStackFormTimer = setTimeout(function() {
        if (feedInner) feedInner.querySelectorAll('.obj.obj-dnd-stack-form').forEach(function(r) { r.classList.remove('obj-dnd-stack-form'); });
        dndStackFormTimer = null;
      }, 280);
      var block = dragSelectedRows;
      var lastInBlock = block[block.length - 1];
      dndOriginInsertBefore = lastInBlock.nextSibling;
      dndOriginWantAppend = !dndOriginInsertBefore;
      var firstRect = block[0].getBoundingClientRect();
      dndOriginLineY = firstRect.top;
    } else {
      dndOriginInsertBefore = row.nextSibling;
      dndOriginWantAppend = !dndOriginInsertBefore;
      var rowRect = row.getBoundingClientRect();
      dndOriginLineY = rowRect.top;
    }
    row.classList.add('dragging');
    lastDragClientX = typeof e.clientX === 'number' ? e.clientX : null;
    lastDragClientY = typeof e.clientY === 'number' ? e.clientY : null;
    showOriginGhostOverlay(dragSelectedRows.slice());
    if (document.body) document.body.classList.add('dnd-active');
    savedOrderBeforeDrag = currentObjectOrder.slice();
    dragDropHandled = false;
    if (feedInner) feedInner.querySelectorAll('.obj-drag-over').forEach(r => r.classList.remove('obj-drag-over'));
    hideRemoteDndLines();
    broadcastDndStart();
  });
  row.addEventListener('dragend', () => {
    var wasValueDnD = !!valueDnDActive;
    if (valueDnDSourceCell) valueDnDSourceCell.classList.remove('obj-value-dnd-source');
    valueDnDSourceCell = null;
    clearValueDnDHoverClass();
    valueDnDActive = false;
    requestAnimationFrame(() => {
      if (wasValueDnD) {
        if (dragSpiritEl && dragSpiritEl.parentNode) dragSpiritEl.parentNode.removeChild(dragSpiritEl);
        dragSpiritEl = null;
        lastDragClientX = null;
        lastDragClientY = null;
        dndOriginInsertBefore = null;
        dndOriginWantAppend = false;
        dndOriginLineY = null;
        if (dndStackFormTimer) { clearTimeout(dndStackFormTimer); dndStackFormTimer = null; }
        removeOriginGhostOverlay();
        if (feedInner) feedInner.querySelectorAll('.obj.dragging-in-feed').forEach(r => r.classList.remove('dragging-in-feed'));
        hideDropOriginLine();
        if (feedDropIndicatorEl) feedDropIndicatorEl.classList.remove('visible');
        lastIndicatorStyle = { left: -1, width: -1, top: -1, visible: false };
        row.style.pointerEvents = 'none';
        void row.offsetHeight;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(() => {
              row.style.pointerEvents = '';
              focusMainInput();
            }, 120);
          });
        });
        return;
      }
      var droppedMovedIds = [];
      const rail = document.getElementById('view-pinned-rail');
      try {
        if (lastReorderTarget && !originGhostsActive && feedInner && dragSelectedRows.length) {
          var block = dragSelectedRows.length > 1 ? dragSelectedRows.slice() : [row];
          droppedMovedIds = block.map(function(r) { return Number(r.dataset.id); }).filter(function(id) { return Number.isFinite(id); });
          if (lastReorderTarget.pinToEdge && rail && droppedMovedIds.length) {
            addPinnedIds(currentView, droppedMovedIds);
            block.forEach(function(r) {
              if (r.parentNode === feedInner) feedInner.removeChild(r);
              if (rail && r.parentNode !== rail) rail.appendChild(r);
            });
            currentObjectOrder = currentObjectOrder.filter(id => !droppedMovedIds.includes(id));
            saveObjectOrderForCurrentView();
          } else if (rail && block[0] && block[0].parentNode === rail) {
            removePinnedIds(currentView, droppedMovedIds);
            var insertBefore = lastReorderTarget.insertBefore;
            var wantAppend = lastReorderTarget.wantAppend;
            block.forEach(function(r) { if (r.parentNode === rail) rail.removeChild(r); });
            if (insertBefore && insertBefore.parentNode === feedInner) {
              feedInner.insertBefore(block[0], insertBefore);
              for (var i = 1; i < block.length; i++) feedInner.insertBefore(block[i], block[i - 1].nextSibling);
            } else {
              block.forEach(function(r) { feedInner.appendChild(r); });
            }
            recomputeOrderFromDOM(feedInner);
            applyObjectOrderToDOM();
            saveObjectOrderForCurrentView();
          } else {
            var insertBefore = lastReorderTarget.insertBefore;
            var wantAppend = lastReorderTarget.wantAppend;
            if (block.length > 1) {
              var refAfterBlock = block[block.length - 1].nextSibling;
              block.forEach(function(r) { if (r.parentNode === feedInner) feedInner.removeChild(r); });
              var insertRef = wantAppend ? null : (block.indexOf(insertBefore) >= 0 ? refAfterBlock : insertBefore);
              if (insertRef) {
                feedInner.insertBefore(block[0], insertRef);
                for (var i = 1; i < block.length; i++) feedInner.insertBefore(block[i], block[i - 1].nextSibling);
              } else {
                feedInner.appendChild(block[0]);
                for (var j = 1; j < block.length; j++) feedInner.insertBefore(block[j], block[j - 1].nextSibling);
              }
              block.forEach(function(r, i) {
                r.classList.add('obj-dnd-just-dropped');
                r.style.animationDelay = (i * 30) + 'ms';
              });
              setTimeout(function() {
                block.forEach(function(r) {
                  r.classList.remove('obj-dnd-just-dropped');
                  r.style.animationDelay = '';
                });
              }, 220 + (block.length * 30));
            } else {
              if (wantAppend) feedInner.appendChild(row);
              else if (insertBefore && insertBefore.parentNode === feedInner) feedInner.insertBefore(row, insertBefore);
              row.classList.add('obj-dnd-just-dropped');
              setTimeout(function() {
                row.classList.remove('obj-dnd-just-dropped');
                row.style.animationDelay = '';
              }, 220);
            }
          }
        }
        if (dragSpiritEl && dragSpiritEl.parentNode) dragSpiritEl.parentNode.removeChild(dragSpiritEl);
        dragSpiritEl = null;
        removeOriginGhostOverlay();
        if (feedInner) feedInner.querySelectorAll('.obj.dragging-in-feed').forEach(r => r.classList.remove('dragging-in-feed'));
        removeOriginGhostsAndInsertRows();
        if (feedInner) feedInner.querySelectorAll('.obj-drag-group').forEach(r => r.classList.remove('obj-drag-group'));
        dragSelectedRows = [];
        if (document.body) {
          document.body.classList.remove('dnd-active');
          document.body.classList.add('dnd-just-ended');
        }
        lastReorderTarget = null;
        feedDragoverRaf = null;
        feedDragoverLast = null;
        lastDragClientX = null;
        lastDragClientY = null;
        clearEdgeScrollInterval();
        lastDragTargetRow = null;
        dndOriginInsertBefore = null;
        dndOriginWantAppend = false;
        dndOriginLineY = null;
        if (dndStackFormTimer) { clearTimeout(dndStackFormTimer); dndStackFormTimer = null; }
        broadcastDndEnd();
        if (feedInner) feedInner.querySelectorAll('.obj-drag-over, .obj-drag-target, .obj-dnd-stack-form').forEach(r => r.classList.remove('obj-drag-over', 'obj-drag-target', 'obj-drag-nudge-right', 'obj-dnd-stack-form'));
        row.classList.remove('dragging');
        tabsEl.querySelectorAll('.tab.tab-drop-target').forEach(t => t.classList.remove('tab-drop-target'));
        const domOrder = feedInner ? Array.from(feedInner.querySelectorAll('.obj')).map(r => Number(r.dataset.id)).filter(id => Number.isFinite(id)) : [];
        const orderChanged = !dragDropHandled && domOrder.length === savedOrderBeforeDrag.length && domOrder.some((id, i) => id !== savedOrderBeforeDrag[i]);
        if (!dragDropHandled && !orderChanged) {
          currentObjectOrder = savedOrderBeforeDrag.slice();
          applyObjectOrderToDOM();
          saveObjectOrderForCurrentView();
        } else {
          const container = row && row.closest ? row.closest('.feed-inner') : null;
          recomputeOrderFromDOM(container);
          applyObjectOrderToDOM();
          saveObjectOrderForCurrentView();
          maybeBroadcastOrderAfterReorder(savedOrderBeforeDrag, droppedMovedIds);
        }
        applyFieldPrefsToObjects();
        row.style.pointerEvents = 'none';
        void row.offsetHeight;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(() => {
            if (document.body) document.body.classList.remove('dnd-just-ended');
            row.style.pointerEvents = '';
              focusMainInput();
            }, 120);
          });
        });
      } finally {
        if (dragSpiritEl && dragSpiritEl.parentNode) dragSpiritEl.parentNode.removeChild(dragSpiritEl);
        dragSpiritEl = null;
        lastDragClientX = null;
        lastDragClientY = null;
        dndOriginInsertBefore = null;
        dndOriginWantAppend = false;
        dndOriginLineY = null;
        if (dndStackFormTimer) { clearTimeout(dndStackFormTimer); dndStackFormTimer = null; }
        removeOriginGhostOverlay();
        if (feedInner) feedInner.querySelectorAll('.obj.dragging-in-feed').forEach(r => r.classList.remove('dragging-in-feed'));
        hideDropOriginLine();
        if (feedDropIndicatorEl) feedDropIndicatorEl.classList.remove('visible');
        lastIndicatorStyle = { left: -1, width: -1, top: -1, visible: false };
      }
    });
  });
  /* row-level dragover/drop removed: feed is the single drop target for reliable reorder */
  row.addEventListener('touchstart', e => {
    if (!feedInner) return;
    if (e.target.closest('.obj-value-cell')) return;
    if (e.target.closest('.obj-checkbox-zone')) return;
    if (e.target.closest('.obj-actions')) return;
    const contentLeft =
      row.querySelector('.obj-time') ||
      row.querySelector('.obj-sender') ||
      row.querySelector('.obj-value-cell') ||
      row.querySelector('.obj-text');
    if (contentLeft && e.touches[0].clientX < contentLeft.getBoundingClientRect().left) return;
    if (!touchDragState || !touchDragState.bound) {
      setupTouchDragHandlers();
    }
    if (!touchDragState) return;
    clearTimeout(touchDragState.timer);
    touchDragState.row = row;
    const railForTouch = document.getElementById('view-pinned-rail');
    touchDragState.fromRail = !!(railForTouch && railForTouch.contains(row));
    touchDragState.started = false;
    const dndY0 = e.touches[0].clientY;
    const dndX0 = e.touches[0].clientX;
    function cancelLongPressIfScrolled(ev) {
      if (touchDragState.started || touchDragState.row !== row) return;
      if (!touchDragState.timer) return;
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      if (Math.abs(t.clientY - dndY0) > 14 || Math.abs(t.clientX - dndX0) > 14) {
        clearTimeout(touchDragState.timer);
        touchDragState.timer = null;
        row.removeEventListener('touchmove', cancelLongPressIfScrolled);
        row.removeEventListener('touchend', clearLongPressRowListeners);
        row.removeEventListener('touchcancel', clearLongPressRowListeners);
      }
    }
    function clearLongPressRowListeners() {
      row.removeEventListener('touchmove', cancelLongPressIfScrolled);
      row.removeEventListener('touchend', clearLongPressRowListeners);
      row.removeEventListener('touchcancel', clearLongPressRowListeners);
      if (touchDragState.row === row && !touchDragState.started && touchDragState.timer) {
        clearTimeout(touchDragState.timer);
        touchDragState.timer = null;
      }
      if (touchDragState.row === row && !touchDragState.started) touchDragState.row = null;
    }
    row.addEventListener('touchmove', cancelLongPressIfScrolled, { passive: true });
    row.addEventListener('touchend', clearLongPressRowListeners, { passive: true });
    row.addEventListener('touchcancel', clearLongPressRowListeners, { passive: true });
    touchDragState.timer = setTimeout(() => {
      if (!touchDragState || touchDragState.row !== row) return;
      touchDragState.started = true;
      if (feedInner && selectedIds.has(obj.id) && selectedIds.size > 1) {
        dragSelectedRows = Array.from(feedInner.querySelectorAll('.obj.obj-selected'));
      } else {
        dragSelectedRows = [row];
      }
      var block = dragSelectedRows;
      var lastInBlock = block[block.length - 1];
      dndOriginInsertBefore = lastInBlock.nextSibling;
      dndOriginWantAppend = !dndOriginInsertBefore;
      var firstRect = block[0].getBoundingClientRect();
      dndOriginLineY = firstRect.top;
      dragSelectedRows.forEach(function(r) {
        if (dragSelectedRows.length > 1) r.classList.add('obj-drag-group');
      });
      row.classList.add('dragging');
      if (document.body) document.body.classList.add('dnd-active');
      savedOrderBeforeDrag = currentObjectOrder.slice();
      hideRemoteDndLines();
      broadcastDndStart();
      row.removeEventListener('touchmove', cancelLongPressIfScrolled);
      row.removeEventListener('touchend', clearLongPressRowListeners);
      row.removeEventListener('touchcancel', clearLongPressRowListeners);
      var dndMove = touchDragState && touchDragState._onTouchMoveForDnD;
      if (dndMove) document.addEventListener('touchmove', dndMove, { passive: false });
      /* origin line shown on first touchmove, not here, so it doesn't appear on long-press alone */
    }, 200); // long press threshold
  }, { passive: true });
  if (isNew) setTimeout(() => row.classList.remove('new-flash'), 800);

  const actions = document.createElement('div');
  actions.className = 'obj-actions';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'obj-actions-trigger';
  trigger.setAttribute('aria-label', 'Object actions');
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.textContent = '\u22EE';

  const dropdown = document.createElement('div');
  dropdown.className = 'obj-actions-dropdown';
  dropdown.setAttribute('role', 'menu');

  var objActionsScrollCloseEl = null;
  var objActionsScrollCloseFn = null;
  var objActionsScrollAttachTimer = null;
  function closeDropdown() {
    actions.classList.remove('obj-actions-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeDropdown);
    if (objActionsScrollAttachTimer != null) {
      clearTimeout(objActionsScrollAttachTimer);
      objActionsScrollAttachTimer = null;
    }
    if (objActionsScrollCloseEl && objActionsScrollCloseFn) {
      try {
        objActionsScrollCloseEl.removeEventListener('scroll', objActionsScrollCloseFn);
      } catch (_) {}
      objActionsScrollCloseEl = null;
      objActionsScrollCloseFn = null;
    }
    dropdown.style.position = '';
    dropdown.style.top = '';
    dropdown.style.right = '';
    dropdown.style.left = '';
    dropdown.style.bottom = '';
    dropdown.style.zIndex = '';
    dropdown.style.maxHeight = '';
    dropdown.style.overflowY = '';
  }
  function positionObjActionsDropdown() {
    positionFixedDropdownClamped(trigger.getBoundingClientRect(), dropdown, {
      gap: 2,
      maxHeightCap: 320,
      zIndex: 3500
    });
  }
  trigger.addEventListener('mousedown', e => {
    e.stopPropagation();
  });
  dropdown.addEventListener('mousedown', e => {
    e.stopPropagation();
  });
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = actions.classList.toggle('obj-actions-open');
    trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) {
      positionObjActionsDropdown();
      /* Defer so this same click/tap is not handled as an outside click on document. */
      setTimeout(function() {
        document.addEventListener('click', closeDropdown);
      }, 0);
      var scrollPort = row.closest && row.closest('.visual-feed-stack');
      if (scrollPort) {
        objActionsScrollCloseFn = function() {
          closeDropdown();
        };
        /* Defer: opening can reflow/scroll the stack once; immediate scroll would close before the menu appears. */
        objActionsScrollAttachTimer = setTimeout(function() {
          objActionsScrollAttachTimer = null;
          if (!actions.classList.contains('obj-actions-open')) return;
          objActionsScrollCloseEl = scrollPort;
          scrollPort.addEventListener('scroll', objActionsScrollCloseFn, { passive: true });
        }, 100);
      }
    } else {
      closeDropdown();
    }
  });

  const menuSingle = document.createElement('div');
  menuSingle.className = 'obj-actions-menu obj-actions-menu-single';

  const actionEdit = document.createElement('button');
  actionEdit.className = 'obj-action-btn';
  actionEdit.type = 'button';
  actionEdit.setAttribute('role', 'menuitem');
  actionEdit.textContent = 'Edit';
  actionEdit.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!obj.id) return;
    const multi = selectMode && selectedIds.size > 1 && selectedIds.has(obj.id);
    const idsToEdit = multi ? new Set(selectedIds) : new Set([obj.id]);
    applyObjectEditMode(idsToEdit, obj.id, null);
  });

  const actionAddValue = document.createElement('button');
  actionAddValue.className = 'obj-action-btn';
  actionAddValue.type = 'button';
  actionAddValue.setAttribute('role', 'menuitem');
  actionAddValue.textContent = 'Add value';
  actionAddValue.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!obj.id) return;
    addValueColumnToObjectFromMenu(obj);
  });

  const actionDelete = document.createElement('button');
  actionDelete.className = 'obj-action-btn';
  actionDelete.type = 'button';
  actionDelete.setAttribute('role', 'menuitem');
  actionDelete.textContent = 'Del';
  actionDelete.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!obj.id) return;
    deleteSingleObject(obj.id);
  });

  const actionMove = document.createElement('button');
  actionMove.className = 'obj-action-btn';
  actionMove.type = 'button';
  actionMove.setAttribute('role', 'menuitem');
  actionMove.textContent = 'Move';
  actionMove.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!obj.id) return;
    moveSingleObject(obj.id);
  });

  const actionExport = document.createElement('button');
  actionExport.className = 'obj-action-btn';
  actionExport.type = 'button';
  actionExport.setAttribute('role', 'menuitem');
  actionExport.textContent = 'Txt';
  actionExport.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!obj.id) return;
    exportSingleObject(obj.id);
  });

  const actionExportJson = document.createElement('button');
  actionExportJson.className = 'obj-action-btn';
  actionExportJson.type = 'button';
  actionExportJson.setAttribute('role', 'menuitem');
  actionExportJson.textContent = 'JSON';
  actionExportJson.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!obj.id) return;
    exportSingleObjectJson(obj.id);
  });

  const actionCopy = document.createElement('button');
  actionCopy.className = 'obj-action-btn';
  actionCopy.type = 'button';
  actionCopy.setAttribute('role', 'menuitem');
  actionCopy.textContent = 'Copy';
  actionCopy.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    var joinedCopy = parseObjectTextToParts(obj.text).join('\n\n');
    if (!joinedCopy) return;
    try {
      navigator.clipboard.writeText(joinedCopy);
      if (typeof showClipboardBubble === 'function') showClipboardBubble(joinedCopy);
      toast('Message copied.');
    } catch (err) {
      console.error(err);
      toast('Could not copy.');
    }
  });

  const actionCut = document.createElement('button');
  actionCut.className = 'obj-action-btn';
  actionCut.type = 'button';
  actionCut.setAttribute('role', 'menuitem');
  actionCut.textContent = 'Cut';
  actionCut.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!obj.id || !obj.text) return;
    try {
      navigator.clipboard.writeText(obj.text);
      if (typeof showClipboardBubble === 'function') showClipboardBubble(obj.text);
      deleteSingleObject(obj.id);
      toast('Message cut.');
    } catch (err) {
      console.error(err);
      toast('Could not cut.');
    }
  });

  menuSingle.appendChild(actionEdit);
  menuSingle.appendChild(actionAddValue);
  menuSingle.appendChild(actionDelete);
  menuSingle.appendChild(actionMove);
  menuSingle.appendChild(actionExport);
  menuSingle.appendChild(actionExportJson);
  menuSingle.appendChild(actionCopy);
  menuSingle.appendChild(actionCut);

  const menuBulk = document.createElement('div');
  menuBulk.className = 'obj-actions-menu obj-actions-menu-bulk';

  const actionBulkEdit = document.createElement('button');
  actionBulkEdit.className = 'obj-action-btn';
  actionBulkEdit.type = 'button';
  actionBulkEdit.setAttribute('role', 'menuitem');
  actionBulkEdit.textContent = 'Edit all';
  actionBulkEdit.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    if (!selectedIds.size) return;
    applyObjectEditMode(new Set(selectedIds), obj.id, null);
  });

  const actionBulkDelete = document.createElement('button');
  actionBulkDelete.className = 'obj-action-btn';
  actionBulkDelete.type = 'button';
  actionBulkDelete.setAttribute('role', 'menuitem');
  actionBulkDelete.textContent = 'Del all';
  actionBulkDelete.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    handleDeleteSelectedObjects();
  });

  const actionBulkMove = document.createElement('button');
  actionBulkMove.className = 'obj-action-btn';
  actionBulkMove.type = 'button';
  actionBulkMove.setAttribute('role', 'menuitem');
  actionBulkMove.textContent = 'Move all';
  actionBulkMove.addEventListener('click', e => {
    e.stopPropagation();
    closeDropdown();
    handleMoveSelectedObjects();
  });

  menuBulk.appendChild(actionBulkEdit);
  menuBulk.appendChild(actionBulkDelete);
  menuBulk.appendChild(actionBulkMove);

  dropdown.appendChild(menuSingle);
  dropdown.appendChild(menuBulk);
  actions.appendChild(trigger);
  actions.appendChild(dropdown);

  const sender = document.createElement('div');
  sender.className = 'obj-sender';
  if (obj.author_name) {
    sender.textContent = String(obj.author_name);
  } else if (obj.user_id && currentUser && obj.user_id === currentUser.id) {
    const nick = currentUser.user_metadata && currentUser.user_metadata.nickname
      ? String(currentUser.user_metadata.nickname)
      : 'you';
    sender.textContent = nick;
  } else if (obj.user_id) {
    sender.textContent = String(obj.user_id);
  } else {
    sender.textContent = 'unknown';
  }
  const fullLabel = sender.textContent;
  if (fullLabel.length > 10) {
    sender.textContent = fullLabel.slice(0, 10) + '…';
  }

  const wantAuthor = !!fieldPrefs ? !!fieldPrefs.showAuthor : true;
  sender.style.setProperty('display', wantAuthor ? 'block' : 'none', 'important');

  const selectWrap = document.createElement('div');
  selectWrap.className = 'obj-select-wrap';
  const selectBox = document.createElement('input');
  selectBox.type = 'checkbox';
  selectBox.className = 'obj-select';
  selectBox.addEventListener('change', () => {
    if (!obj.id) return;
    if (selectBox.checked) {
      selectedIds.add(obj.id);
      row.classList.add('obj-selected');
    } else {
      selectedIds.delete(obj.id);
      row.classList.remove('obj-selected');
    }
    updateSelectionUI();
  });
  selectWrap.appendChild(selectBox);
  const checkboxZone = document.createElement('div');
  checkboxZone.className = 'obj-checkbox-zone';
  const zoneLeft = document.createElement('div');
  zoneLeft.className = 'obj-checkbox-zone-left';
  zoneLeft.setAttribute('aria-hidden', 'true');
  checkboxZone.appendChild(zoneLeft);
  checkboxZone.appendChild(selectWrap);
  checkboxZone.addEventListener('click', e => {
    if (dragSelectJustEnded || dragSelectToggledByTouch) {
      dragSelectJustEnded = false;
      dragSelectToggledByTouch = false;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    selectBox.checked = !selectBox.checked;
    if (selectBox.checked) {
      selectedIds.add(obj.id);
      row.classList.add('obj-selected');
    } else {
      selectedIds.delete(obj.id);
      row.classList.remove('obj-selected');
    }
    if (!selectMode) {
      selectModeAutoOn = true;
      setSelectMode(true);
    }
    updateSelectionUI();
  }, true);
  checkboxZone.addEventListener('mousedown', e => {
    if (!obj.id) return;
    pointerDownOnSelectArea = true;
    dragSelectJustEnded = false;
    dragSelectToggledByTouch = false;
    const startY = e.clientY;
    const state = { started: false, mode: null, startRowStates: null, didWeMove: false };
    const onMove = (ev) => {
      if (!state.started) return;
      applyDragSelectRect(feedInner, feedEl, state.startYContent, ev.clientY, state.mode, state.startRowStates);
      updateEdgeScroll(ev.clientY, ev.clientX);
      state.didWeMove = true;
    };
    const onEnd = () => {
      clearEdgeScrollInterval();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      if (state.started && !state.didWeMove) toggleRowAtY(feedInner, startY);
      dragSelectActive = false;
      dragSelectStarted = false;
      dragSelectJustEnded = true;
      pointerDownOnSelectArea = false;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    const timer = setTimeout(() => {
      state.started = true;
      dragSelectStarted = true;
      if (!selectMode) {
        selectModeAutoOn = true;
        setSelectMode(true);
      }
      dragSelectActive = true;
      state.mode = selectBox.checked ? 'deselect' : 'select';
      state.startRowStates = new Map();
      if (feedEl) {
        var se = getFeedScrollSurface(feedEl);
        state.startYContent = startY - se.getBoundingClientRect().top + se.scrollTop;
      }
      feedInner.querySelectorAll('.obj').forEach(r => {
        const box = r.querySelector('.obj-select');
        if (box) state.startRowStates.set(r, box.checked);
      });
    }, 200);
    const onDocUp = () => {
      clearTimeout(timer);
      document.removeEventListener('mouseup', onDocUp, true);
      pointerDownOnSelectArea = false;
    };
    document.addEventListener('mouseup', onDocUp, true);
  });
  checkboxZone.addEventListener('touchstart', e => {
    if (!obj.id || e.touches.length !== 1) return;
    pointerDownOnSelectArea = true;
    dragSelectJustEnded = false;
    dragSelectToggledByTouch = false;
    const startY = e.touches[0].clientY;
    const state = { started: false, mode: null, startRowStates: null, didWeMove: false };
    const onTouchMove = (ev) => {
      if (!state.started || ev.touches.length !== 1) return;
      if (ev.cancelable) ev.preventDefault();
      const cy = ev.touches[0].clientY;
      applyDragSelectRect(feedInner, feedEl, state.startYContent, cy, state.mode, state.startRowStates);
      updateEdgeScroll(cy, ev.touches[0].clientX);
      state.didWeMove = true;
    };
    const onTouchEnd = () => {
      clearEdgeScrollInterval();
      document.removeEventListener('touchmove', onTouchMove, { passive: false });
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      if (state.started && !state.didWeMove) toggleRowAtY(feedInner, startY);
      dragSelectActive = false;
      dragSelectStarted = false;
      dragSelectJustEnded = true;
      pointerDownOnSelectArea = false;
    };
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    const timer = setTimeout(() => {
      state.started = true;
      dragSelectStarted = true;
      if (!selectMode) {
        selectModeAutoOn = true;
        setSelectMode(true);
      }
      dragSelectActive = true;
      state.mode = selectBox.checked ? 'deselect' : 'select';
      state.startRowStates = new Map();
      if (feedEl) {
        var se2 = getFeedScrollSurface(feedEl);
        state.startYContent = startY - se2.getBoundingClientRect().top + se2.scrollTop;
      }
      feedInner.querySelectorAll('.obj').forEach(r => {
        const box = r.querySelector('.obj-select');
        if (box) state.startRowStates.set(r, box.checked);
      });
      document.addEventListener('touchmove', onTouchMove, { passive: false });
    }, 200);
    const onDocTouchEnd = () => {
      clearTimeout(timer);
      document.removeEventListener('touchend', onDocTouchEnd, true);
      document.removeEventListener('touchcancel', onDocTouchEnd, true);
      pointerDownOnSelectArea = false;
      if (!state.started) {
        selectBox.checked = !selectBox.checked;
        dragSelectToggledByTouch = true;
        updateSelectionUI();
      }
    };
    document.addEventListener('touchend', onDocTouchEnd, true);
    document.addEventListener('touchcancel', onDocTouchEnd, true);
  }, { passive: true });

  /* long-press on object row (anywhere except checkbox-zone/actions/links) starts drag-select */
  row.addEventListener('mousedown', e => {
    if (!obj.id) return;
    if (
      e.target.closest('.obj-checkbox-zone, .obj-actions') ||
      (e.target.closest('a') && e.target.closest('.obj-text, .obj-value-cell'))
    ) {
      return;
    }
    const startY = e.clientY;
    const state = { started: false, mode: null, startRowStates: null, startYContent: null, didWeMove: false };
    const onMove = (ev) => {
      if (!state.started) return;
      applyDragSelectRect(feedInner, feedEl, state.startYContent, ev.clientY, state.mode, state.startRowStates);
      updateEdgeScroll(ev.clientY, ev.clientX);
      state.didWeMove = true;
    };
    const onEnd = () => {
      clearEdgeScrollInterval();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      if (state.started && !state.didWeMove) toggleRowAtY(feedInner, startY);
      dragSelectActive = false;
      dragSelectStarted = false;
      dragSelectJustEnded = true;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    let timer = setTimeout(() => {
      timer = null;
      state.started = true;
      dragSelectStarted = true;
      if (!selectMode) {
        selectModeAutoOn = true;
        setSelectMode(true);
      }
      dragSelectActive = true;
      state.mode = selectBox.checked ? 'deselect' : 'select';
      state.startRowStates = new Map();
      if (feedEl) {
        var se3 = getFeedScrollSurface(feedEl);
        state.startYContent = startY - se3.getBoundingClientRect().top + se3.scrollTop;
      }
      feedInner.querySelectorAll('.obj').forEach(r => {
        const box = r.querySelector('.obj-select');
        if (box) state.startRowStates.set(r, box.checked);
      });
    }, 200);
    const onDocMove = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('mousemove', onDocMove, true);
      document.removeEventListener('mouseup', onDocUp, true);
    };
    const onDocUp = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('mouseup', onDocUp, true);
      document.removeEventListener('mousemove', onDocMove, true);
    };
    document.addEventListener('mouseup', onDocUp, true);
    document.addEventListener('mousemove', onDocMove, true);
  });
  row.addEventListener('touchstart', e => {
    if (!obj.id || e.touches.length !== 1) return;
    if (
      e.target.closest('.obj-checkbox-zone, .obj-actions') ||
      (e.target.closest('a') && e.target.closest('.obj-text, .obj-value-cell'))
    ) {
      return;
    }
    const startY = e.touches[0].clientY;
    const state = { started: false, mode: null, startRowStates: null, startYContent: null, didWeMove: false };
    const onTouchMove = (ev) => {
      if (!state.started || ev.touches.length !== 1) return;
      if (ev.cancelable) ev.preventDefault();
      const cy = ev.touches[0].clientY;
      applyDragSelectRect(feedInner, feedEl, state.startYContent, cy, state.mode, state.startRowStates);
      updateEdgeScroll(cy, ev.touches[0].clientX);
      state.didWeMove = true;
    };
    const onTouchEnd = () => {
      clearEdgeScrollInterval();
      document.removeEventListener('touchmove', onTouchMove, { passive: false });
      document.removeEventListener('touchmove', onDocTouchMove, { capture: true, passive: true });
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('touchend', onDocTouchEnd, true);
      document.removeEventListener('touchcancel', onDocTouchEnd, true);
      if (state.started && !state.didWeMove) toggleRowAtY(feedInner, startY);
      dragSelectActive = false;
      dragSelectStarted = false;
      dragSelectJustEnded = true;
    };
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    let timer = setTimeout(() => {
      timer = null;
      state.started = true;
      dragSelectStarted = true;
      if (!selectMode) {
        selectModeAutoOn = true;
        setSelectMode(true);
      }
      dragSelectActive = true;
      state.mode = selectBox.checked ? 'deselect' : 'select';
      state.startRowStates = new Map();
      if (feedEl) {
        var se4 = getFeedScrollSurface(feedEl);
        state.startYContent = startY - se4.getBoundingClientRect().top + se4.scrollTop;
      }
      feedInner.querySelectorAll('.obj').forEach(r => {
        const box = r.querySelector('.obj-select');
        if (box) state.startRowStates.set(r, box.checked);
      });
      document.addEventListener('touchmove', onTouchMove, { passive: false });
    }, 300);
    const onDocTouchMove = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      document.removeEventListener('touchmove', onTouchMove, { passive: false });
      document.removeEventListener('touchmove', onDocTouchMove, { capture: true, passive: true });
    };
    const onDocTouchEnd = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('touchend', onDocTouchEnd, true);
      document.removeEventListener('touchcancel', onDocTouchEnd, true);
      document.removeEventListener('touchmove', onDocTouchMove, { capture: true, passive: true });
    };
    document.addEventListener('touchend', onDocTouchEnd, true);
    document.addEventListener('touchcancel', onDocTouchEnd, true);
    document.addEventListener('touchmove', onDocTouchMove, { passive: true, capture: true });
  }, { passive: true });

  const time = document.createElement('div');
  time.className = 'obj-time';
  time.textContent = formatTime(obj.created_at);
  if (fieldPrefs) {
    if (!fieldPrefs.showTime) time.style.setProperty('display', 'none', 'important');
    else time.style.removeProperty('display');
  }

  var valueParts = parseObjectTextToParts(obj.text);
  while (valueParts.length < valueColCount) valueParts.push('');
  if (valueParts.length > valueColCount) valueParts = valueParts.slice(0, valueColCount);
  const valuesWrap = document.createElement('div');
  valuesWrap.className = 'obj-values-wrap';
  for (var _vci = 0; _vci < valueColCount; _vci++) {
    const cell = document.createElement('div');
    cell.className = 'obj-text obj-value-cell';
    cell.dataset.valueIndex = String(_vci);
    cell.innerHTML = renderVisualOnlyHtml(valueParts[_vci] != null ? valueParts[_vci] : '');
    applyValueColumnLabelAttrToCell(cell, obj.text);
    valuesWrap.appendChild(cell);
  }
  valuesWrap.addEventListener('click', e => {
    var clickedCell = resolveValueCellFromPointer(valuesWrap, e.clientX, e.clientY, e.target);
    if (!clickedCell) {
      clickedCell = valuesWrap.querySelector(':scope > .obj-value-cell:last-child');
      if (!clickedCell) return;
    }
    if (e.target.closest('a')) return;
    e.stopPropagation();
    if (typeof obj.id === 'undefined') return;
    if (selectMode && editingObjectId) {
      cancelEditingMode(true);
      return;
    }
    if (Number(obj.id) === Number(editingObjectId)) {
      cancelEditingMode(true);
      return;
    }
    const multi = selectMode && selectedIds.size > 1 && selectedIds.has(obj.id);
    const idsToEdit = multi ? new Set(selectedIds) : new Set([obj.id]);
    var valueIndex = parseInt(clickedCell.getAttribute('data-value-index'), 10);
    applyObjectEditMode(idsToEdit, obj.id, Number.isFinite(valueIndex) ? valueIndex : null);
  });

  const leadingMeta = document.createElement('div');
  leadingMeta.className = 'obj-leading-meta';
  leadingMeta.appendChild(time);
  leadingMeta.appendChild(sender);
  const leadingCol = document.createElement('div');
  leadingCol.className = 'obj-leading-col';
  leadingCol.appendChild(checkboxZone);
  leadingCol.appendChild(leadingMeta);
  const contentWrap = document.createElement('div');
  contentWrap.className = 'obj-content';
  contentWrap.appendChild(valuesWrap);

  row.addEventListener('click', e => {
    if (e.target.closest('.obj-checkbox-zone')) return;
    if (e.target.closest('.obj-values-wrap, .obj-text')) return;
    if (selectMode) {
      if (e.target.closest('.obj-actions')) return;
      if (dragSelectJustEnded || dragSelectToggledByTouch) return;
      e.preventDefault();
      e.stopPropagation();
      selectBox.checked = !selectBox.checked;
      if (selectBox.checked) {
        selectedIds.add(obj.id);
        row.classList.add('obj-selected');
  } else {
        selectedIds.delete(obj.id);
        row.classList.remove('obj-selected');
      }
      updateSelectionUI();
      return;
    }
    const inEditing = editingObjectId != null && (String(row.dataset.id) === String(editingObjectId) || (editingObjectIds && editingObjectIds.has(obj.id)));
    if (!inEditing) return;
    if (e.target.closest('button, a, .obj-actions, .obj-select, .obj-select-wrap')) return;
    e.stopPropagation();
    e.preventDefault();
    cancelEditingMode(true);
  }, true);

  row.appendChild(leadingCol);
  row.appendChild(contentWrap);
  row.appendChild(actions);
  row.addEventListener('mousedown', e => {
    if (e.target.closest('.obj-checkbox-zone')) return;
    const contentLeft =
      row.querySelector('.obj-time') ||
      row.querySelector('.obj-sender') ||
      row.querySelector('.obj-value-cell') ||
      row.querySelector('.obj-text');
    if (contentLeft && e.clientX < contentLeft.getBoundingClientRect().left) {
      pointerDownOnSelectArea = true;
      const clear = () => {
        document.removeEventListener('mouseup', clear, true);
        pointerDownOnSelectArea = false;
      };
      document.addEventListener('mouseup', clear, true);
    }
  });
  return row;
}

function appendObject(obj, isNew) {
  var maxValCols = Math.max(
    computeMaxValueColumnsFromFeedInner(feedInner),
    parseObjectTextToParts(obj.text).length,
    1
  );
  feedInner.dataset.inoutValueCols = String(maxValCols);
  const row = createObjectRow(obj, isNew, { valueColumnCount: maxValCols });
  if (!row) return;
  feedInner.appendChild(row);
  // Ensure new messages respect the current view (time/author) settings.
  applyFieldPrefsToObjects(true);
  syncFeedMultiValueChrome(feedInner);
  if (typeof obj.id !== 'undefined') {
    const idNum = Number(obj.id);
    if (Number.isFinite(idNum)) {
      currentObjectOrder = currentObjectOrder.filter(x => x !== idNum);
      currentObjectOrder.push(idNum);
      saveObjectOrderForCurrentView();
    }
  }
}

function sortObjectsByOrder(list, order) {
  if (!Array.isArray(list) || list.length === 0) return list;
  if (!Array.isArray(order) || order.length === 0) return list;
  const byId = new Map();
  list.forEach(m => { if (m && typeof m.id !== 'undefined') byId.set(m.id, m); });
  const out = [];
  order.forEach(id => {
    const m = byId.get(id);
    if (m) { out.push(m); byId.delete(id); }
  });
  byId.forEach(m => out.push(m));
  return out.length ? out : list;
}

function getPinnedIds(channel) {
  try {
    const raw = localStorage.getItem(PINNED_STATE_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object') return [];
    const key = getScopedViewStorageKey(channel || currentView);
    const arr = map[key];
    if (!Array.isArray(arr)) return [];
    return arr.map(x => Number(x)).filter(x => Number.isFinite(x));
  } catch (_) {
    return [];
  }
}

function setPinnedIds(channel, ids) {
  try {
    const raw = localStorage.getItem(PINNED_STATE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const key = getScopedViewStorageKey(channel || currentView);
    map[key] = (ids || []).slice();
    localStorage.setItem(PINNED_STATE_KEY, JSON.stringify(map));
  } catch (_) {}
}

function addPinnedIds(channel, idsToAdd) {
  const ch = channel || currentView;
  const set = new Set(getPinnedIds(ch));
  idsToAdd.forEach(id => set.add(Number(id)));
  setPinnedIds(ch, Array.from(set));
}

function removePinnedIds(channel, idsToRemove) {
  const ch = channel || currentView;
  const removeSet = new Set(idsToRemove.map(x => Number(x)));
  const kept = getPinnedIds(ch).filter(id => !removeSet.has(id));
  setPinnedIds(ch, kept);
}

function loadOrderFromLocal() {
  try {
    const raw = localStorage.getItem(ORDER_STATE_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object') return [];
    const key = getScopedViewStorageKey(currentView);
    const arr = map[key];
    if (!Array.isArray(arr)) return [];
    return arr
      .map(x => Number(x))
      .filter(x => Number.isFinite(x));
  } catch (_) {
    return [];
  }
}

function saveOrderToLocal() {
  try {
    const raw = localStorage.getItem(ORDER_STATE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const key = getScopedViewStorageKey(currentView);
    map[key] = (currentObjectOrder || []).slice();
    localStorage.setItem(ORDER_STATE_KEY, JSON.stringify(map));
  } catch (_) {}
}

let globalObjectNum = 0;

function hideEmpty() {
  if (emptyEl.parentNode) emptyEl.remove();
}

function updateObjectCount() {
  objectCountEl.textContent = objectCount + (objectCount === 1 ? ' object' : ' objects');
}

/* ═══ TABS ════════════════════════════════════════════════ */
function syncInoutManageRailWidthVar() {
  try {
    if (typeof syncInoutObjLeadingWidthVar === 'function') syncInoutObjLeadingWidthVar();
  } catch (_) {}
}

var inoutRevealFxEnabled = false;
function setWindowsRevealEffectsEnabled(on) {
  inoutRevealFxEnabled = !!on;
  if (inoutRevealFxEnabled) {
    try { setupWindowsRevealEffects(); } catch (_) {}
    try { document.documentElement.classList.add('win10-cursor-fx-on'); } catch (_) {}
    try { document.documentElement.classList.add('win10-cursor-hide'); } catch (_) {}
    return;
  }
  try { document.documentElement.classList.remove('win10-cursor-fx-on'); } catch (_) {}
  try { document.documentElement.classList.remove('win10-cursor-hide'); } catch (_) {}
  try {
    document.querySelectorAll('.win10-reveal-target').forEach(function(el) {
      el.classList.remove('win10-reveal-target');
    });
    document.querySelectorAll('.win10-reveal-active').forEach(function(el) {
      el.classList.remove('win10-reveal-active');
      el.style.removeProperty('--reveal-x');
      el.style.removeProperty('--reveal-y');
    });
    document.querySelectorAll('.win10-label-reveal').forEach(function(el) {
      el.classList.remove('win10-label-reveal');
      el.style.removeProperty('--reveal-x');
      el.style.removeProperty('--reveal-y');
    });
  } catch (_) {}
  try {
    var c = document.getElementById('win10-reveal-cursor');
    if (c) c.classList.remove('active', 'strike');
    var b = document.getElementById('win10-reveal-bolt');
    if (b) b.classList.remove('active');
  } catch (_) {}
}

function setupWindowsRevealEffects() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return;
  if (document.body.dataset.inoutRevealBound === '1') return;
  var mq = null;
  try { mq = window.matchMedia('(hover: hover) and (pointer: fine)'); } catch (_) {}
  if (!mq || !mq.matches) return;
  document.body.dataset.inoutRevealBound = '1';
  var selector = '.tab, .manage-btn, .manage-bar-trigger, #send-btn, .draft-btn, #user-btn, #nav, #manage-bar, #input-area, .input-wrap, .composer-slot, .view, .visual, .visual-feed-stack, #feed, .obj';
  var activeEl = null;
  var activeLabelObj = null;
  var pointerOutsideWindow = false;
  var lastCursorX = null;
  var lastCursorY = null;
  var strikeTimer = null;
  var boltEl = document.getElementById('win10-reveal-bolt');
  var cursorEl = document.getElementById('win10-reveal-cursor');
  if (!boltEl) {
    boltEl = document.createElement('div');
    boltEl.id = 'win10-reveal-bolt';
    boltEl.className = 'win10-reveal-bolt';
    boltEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(boltEl);
  }
  if (!cursorEl) {
    cursorEl = document.createElement('div');
    cursorEl.id = 'win10-reveal-cursor';
    cursorEl.className = 'win10-reveal-cursor';
    cursorEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cursorEl);
  }
  function clearReveal(el) {
    if (!el) return;
    el.classList.remove('win10-reveal-active');
    el.style.removeProperty('--reveal-x');
    el.style.removeProperty('--reveal-y');
  }
  function hideRevealCursor() {
    if (!cursorEl) return;
    cursorEl.classList.remove('active');
  }
  function setCursorPosition(x, y) {
    if (!cursorEl) return;
    cursorEl.style.setProperty('--cursor-x', x + 'px');
    cursorEl.style.setProperty('--cursor-y', y + 'px');
    lastCursorX = x;
    lastCursorY = y;
  }
  function runCursorStrikeTo(x, y) {
    if (!cursorEl) return;
    if (strikeTimer) {
      clearTimeout(strikeTimer);
      strikeTimer = null;
    }
    if (lastCursorX == null || lastCursorY == null) {
      setCursorPosition(x, y);
      return;
    }
    if (boltEl) {
      var dx = x - lastCursorX;
      var dy = y - lastCursorY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var angle = Math.atan2(dy, dx) * (180 / Math.PI);
      boltEl.classList.remove('active');
      boltEl.style.setProperty('--bolt-x', lastCursorX + 'px');
      boltEl.style.setProperty('--bolt-y', lastCursorY + 'px');
      boltEl.style.setProperty('--bolt-len', Math.max(0, dist) + 'px');
      boltEl.style.setProperty('--bolt-angle', angle + 'deg');
      requestAnimationFrame(function() {
        if (boltEl) boltEl.classList.add('active');
      });
      setTimeout(function() {
        if (boltEl) boltEl.classList.remove('active');
      }, 170);
    }
    cursorEl.classList.remove('strike');
    setCursorPosition(lastCursorX, lastCursorY);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        if (!cursorEl) return;
        cursorEl.classList.add('strike');
        setCursorPosition(x, y);
        strikeTimer = setTimeout(function() {
          if (cursorEl) cursorEl.classList.remove('strike');
          strikeTimer = null;
        }, 180);
      });
    });
  }
  function setRevealCursorMode(targetEl) {
    if (!cursorEl) return;
    var t = targetEl && targetEl.nodeType === 1 ? targetEl : null;
    var mode = 'cross';
    if (t) {
      var editable = t.closest && t.closest('input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable]:not([contenteditable="false"])');
      if (editable && !editable.hasAttribute('disabled') && !editable.readOnly) {
        mode = 'text';
      } else {
        var c = '';
        try { c = String(window.getComputedStyle(t).cursor || '').toLowerCase(); } catch (_) {}
        if (c.indexOf('not-allowed') >= 0 || c.indexOf('no-drop') >= 0) mode = 'blocked';
        else if (c.indexOf('ew-resize') >= 0 || c.indexOf('col-resize') >= 0 || c.indexOf('e-resize') >= 0 || c.indexOf('w-resize') >= 0) mode = 'ew';
        else if (c.indexOf('ns-resize') >= 0 || c.indexOf('row-resize') >= 0 || c.indexOf('n-resize') >= 0 || c.indexOf('s-resize') >= 0) mode = 'ns';
        else if (c.indexOf('nwse-resize') >= 0 || c.indexOf('se-resize') >= 0 || c.indexOf('nw-resize') >= 0) mode = 'nwse';
        else if (c.indexOf('nesw-resize') >= 0 || c.indexOf('sw-resize') >= 0 || c.indexOf('ne-resize') >= 0) mode = 'nesw';
        else if (c.indexOf('move') >= 0 || c.indexOf('grab') >= 0 || c.indexOf('grabbing') >= 0 || c.indexOf('all-scroll') >= 0) mode = 'move';
        else if (c.indexOf('pointer') >= 0) mode = 'pointer';
      }
    }
    cursorEl.setAttribute('data-mode', mode);
  }
  document.addEventListener('pointermove', function(e) {
    if (!inoutRevealFxEnabled) return;
    var t = e && e.target && e.target.nodeType === 1
      ? e.target
      : (e && e.target && e.target.parentElement ? e.target.parentElement : null);
    var el = t && t.closest ? t.closest(selector) : null;
    setRevealCursorMode(t);
    var reentered = pointerOutsideWindow;
    if (reentered) pointerOutsideWindow = false;
    if (cursorEl) {
      cursorEl.classList.add('active');
      if (reentered) runCursorStrikeTo(e.clientX, e.clientY);
      else setCursorPosition(e.clientX, e.clientY);
    }
    if (!el) {
      if (activeEl) {
        clearReveal(activeEl);
        activeEl = null;
      }
      if (activeLabelObj) {
        activeLabelObj.classList.remove('win10-label-reveal');
        activeLabelObj.style.removeProperty('--reveal-x');
        activeLabelObj.style.removeProperty('--reveal-y');
        activeLabelObj = null;
      }
      return;
    }
    if (activeEl && activeEl !== el) clearReveal(activeEl);
    activeEl = el;
    el.classList.add('win10-reveal-target');
    var r = el.getBoundingClientRect();
    el.style.setProperty('--reveal-x', (e.clientX - r.left) + 'px');
    el.style.setProperty('--reveal-y', (e.clientY - r.top) + 'px');
    el.classList.add('win10-reveal-active');
    var row = t && t.closest ? t.closest('.feed-inner.obj-labels-off .obj') : null;
    if (activeLabelObj && activeLabelObj !== row) {
      activeLabelObj.classList.remove('win10-label-reveal');
      activeLabelObj.style.removeProperty('--reveal-x');
      activeLabelObj.style.removeProperty('--reveal-y');
      activeLabelObj = null;
    }
    if (row) {
      var rr = row.getBoundingClientRect();
      row.style.setProperty('--reveal-x', (e.clientX - rr.left) + 'px');
      row.style.setProperty('--reveal-y', (e.clientY - rr.top) + 'px');
      row.classList.add('win10-label-reveal');
      activeLabelObj = row;
    }
  }, { passive: true });
  document.addEventListener('pointerleave', function() {
    if (activeEl) {
      clearReveal(activeEl);
      activeEl = null;
    }
    if (activeLabelObj) {
      activeLabelObj.classList.remove('win10-label-reveal');
      activeLabelObj.style.removeProperty('--reveal-x');
      activeLabelObj.style.removeProperty('--reveal-y');
      activeLabelObj = null;
    }
  }, { passive: true });
  window.addEventListener('mouseleave', function() {
    pointerOutsideWindow = true;
    if (activeEl) {
      clearReveal(activeEl);
      activeEl = null;
    }
    if (activeLabelObj) {
      activeLabelObj.classList.remove('win10-label-reveal');
      activeLabelObj.style.removeProperty('--reveal-x');
      activeLabelObj.style.removeProperty('--reveal-y');
      activeLabelObj = null;
    }
  }, { passive: true });
}

function inoutTabsUiCtx() {
  return {
    tabsEl: tabsEl,
    feedInner: feedInner,
    unreadCounts: unreadCounts,
    sharedChannels: sharedChannels,
    inputSlots: inputSlots,
    viewNames: function() { return viewNames; },
    currentView: function() { return currentView; },
    currentChannel: function() { return currentChannel; },
    primarySlotAutoTarget: function() { return primarySlotAutoTarget; },
    inoutHydratingWorkspace: function() { return inoutHydratingWorkspace; },
    getViewDisplayName: getViewDisplayName,
    deleteChannel: deleteChannel,
    renameView: renameView,
    clearPendingViewSwitchClick: clearPendingViewSwitchClick,
    pendingViewSwitchChannel: function() { return pendingViewSwitchChannel; },
    setPendingViewSwitchChannel: function(v) { pendingViewSwitchChannel = v; },
    setPendingViewSwitchTimer: function(v) { pendingViewSwitchTimer = v; },
    switchChannel: switchChannel,
    isMobileOrTouchDevice: (typeof isMobileOrTouchDevice === 'function' ? isMobileOrTouchDevice : function() { return false; }),
    setDragDropHandled: function(v) { dragDropHandled = !!v; },
    animateObjectToTab: animateObjectToTab,
    moveSingleObject: moveSingleObject,
    openChannelModal: openChannelModal,
    refreshMoveTargets: refreshMoveTargets,
    syncComposerTargetSelects: syncComposerTargetSelects,
    bindVerticalWheelToHorizontalScroll: bindVerticalWheelToHorizontalScroll,
    wheelState: {
      lastWheelAt: function() { return inoutLastWheelAt; },
      setLastWheelAt: function(v) { inoutLastWheelAt = v; },
      gapMs: function() { return INOUT_WHEEL_INTERACTION_GAP_MS; },
    },
    nearestVerticalScrollableAncestor: function(node) {
      return window.InoutScroll && window.InoutScroll.nearestVerticalScrollableAncestor
        ? window.InoutScroll.nearestVerticalScrollableAncestor(node)
        : null;
    },
    routeWheelDeltaToPrimaryView: routeWheelDeltaToPrimaryView,
    clearManageBarDropdownPosition: (typeof clearManageBarDropdownPosition === 'function' ? clearManageBarDropdownPosition : null),
    closeLogDropup: (typeof closeLogDropup === 'function' ? closeLogDropup : null),
    notifyWorkspaceChromeChanged: (typeof notifyWorkspaceChromeChanged === 'function' ? notifyWorkspaceChromeChanged : null),
    closeInoutMultiValueFilterMenu: closeInoutMultiValueFilterMenu,
    positionManageBarDropdownClamp: (typeof positionManageBarDropdownClamp === 'function' ? positionManageBarDropdownClamp : null),
    syncInoutManageRailWidthVar: syncInoutManageRailWidthVar,
    syncInoutObjLeadingWidthVar: syncInoutObjLeadingWidthVar,
    setupMultiValueChromeBar: setupMultiValueChromeBar,
    updateMultiValueChromeBar: updateMultiValueChromeBar,
    repositionOpenDropdownsToViewport: (typeof repositionOpenDropdownsToViewport === 'function' ? repositionOpenDropdownsToViewport : null),
  };
}

function setupTabs() {
  if (!window.InoutTabsUi || !window.InoutTabsUi.setupTabs) return;
  window.InoutTabsUi.setupTabs(inoutTabsUiCtx());
}

function updateTabsUI() {
  if (!window.InoutTabsUi || !window.InoutTabsUi.updateTabsUI) return;
  window.InoutTabsUi.updateTabsUI(inoutTabsUiCtx());
}

/** Indeterminate bar on the active tab while channel data loads (local switches only). */
function setTabChannelLoading(channelKey, on) {
  if (!window.InoutTabsUi || !window.InoutTabsUi.setTabChannelLoading) return;
  window.InoutTabsUi.setTabChannelLoading(channelKey, on, inoutTabsUiCtx());
}

var leftChannels = new Set();

function loadLeftChannelsList() {
  try {
    const raw = localStorage.getItem(LEFT_CHANNELS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      leftChannels = new Set(parsed.map(x => (typeof x === 'string' ? x.trim() : '')).filter(x => x && x !== 'main'));
    }
  } catch (_) {}
}

function saveLeftChannelsList() {
  try {
    localStorage.setItem(LEFT_CHANNELS_KEY, JSON.stringify(Array.from(leftChannels)));
  } catch (_) {}
  schedulePersonalWorkspacePersist();
}

function loadChannelsList() {
  try {
    loadLeftChannelsList();
  } catch (_) {}
  try {
    const raw = localStorage.getItem(CHANNELS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const cleaned = parsed
        .map(x => (typeof x === 'string' ? x.trim() : ''))
        .filter(x => x && x !== 'main' && !leftChannels.has(x));
      viewNames = ['main', ...Array.from(new Set(cleaned))];
    }
  } catch (_) {}
}

function saveChannelsList() {
  try {
    const toSave = viewNames.filter(ch => ch !== 'main');
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(toSave));
  } catch (_) {}
  schedulePersonalWorkspacePersist();
}

function normalizeViewConfig(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (_) {
      return null;
    }
  }
  return typeof raw === 'object' ? raw : null;
}

/** Clone view config for PostgREST (drops undefined / non-JSON values). */
function viewConfigJsonSafe(cfg) {
  try {
    return JSON.parse(JSON.stringify(cfg && typeof cfg === 'object' ? cfg : {}));
  } catch (_) {
    return {};
  }
}

/**
 * Save views.config without PostgREST upsert on_conflict (avoids 400 when DB unique/index names differ).
 */
async function upsertViewsConfigForChannel(channelKey, configObj) {
  const ch = String(channelKey || 'main');
  const cfg = viewConfigJsonSafe(configObj);
  if (!sb || !sb.from) return { error: new Error('no supabase client') };
  if (currentUser && currentUser.id) {
    const uid = currentUser.id;
    const { data: row, error: selErr } = await sb
      .from('views')
      .select('channel')
      .eq('user_id', uid)
      .eq('channel', ch)
      .maybeSingle();
    if (selErr) return { error: selErr };
    if (row) {
      const { error } = await sb.from('views').update({ config: cfg }).eq('user_id', uid).eq('channel', ch);
      return { error };
    }
    const ins = await sb.from('views').insert({ user_id: uid, channel: ch, config: cfg });
    if (!ins.error) return ins;
    const { error: upErr } = await sb.from('views').update({ config: cfg }).eq('user_id', uid).eq('channel', ch);
    return { error: upErr };
  }
  const { data: row2, error: selErr2 } = await sb.from('views').select('channel').eq('channel', ch).limit(1).maybeSingle();
  if (selErr2) return { error: selErr2 };
  if (row2) {
    const { error } = await sb.from('views').update({ config: cfg }).eq('channel', ch);
    return { error };
  }
  const guestIns = await sb.from('views').insert({ channel: ch, config: cfg });
  if (!guestIns.error) return guestIns;
  const { error: gUp } = await sb.from('views').update({ config: cfg }).eq('channel', ch);
  return { error: gUp };
}

/** Shared / guest feeds: one `views` row per channel so all watchers see the same order & layout prefs. */
function isChannelViewCollaborative(ch) {
  const c = String(ch || '').trim();
  if (!c || c === 'main') return false;
  if (tempSessionId && !currentUser) return true;
  if (sharedChannels && sharedChannels.has(c)) return true;
  if (tempSessionId && currentUser && c === String(currentChannel || '').trim()) return true;
  return false;
}

async function upsertChannelViewConfigMerged(channelKey, configObj) {
  const ch = String(channelKey || 'main');
  const cfg = viewConfigJsonSafe(configObj);
  if (!sb || !sb.from) return { error: new Error('no supabase client') };
  if (isChannelViewCollaborative(ch)) {
    const { data: row, error: selErr } = await sb
      .from('views')
      .select('channel, config')
      .eq('channel', ch)
      .limit(1)
      .maybeSingle();
    if (selErr) return { error: selErr };
    const merged = Object.assign({}, normalizeViewConfig(row && row.config), cfg);
    if (row) {
      const { error } = await sb.from('views').update({ config: merged }).eq('channel', ch);
      return { error };
    }
    const insertPayload = { channel: ch, config: merged };
    if (currentUser && currentUser.id) insertPayload.user_id = currentUser.id;
    const ins = await sb.from('views').insert(insertPayload);
    if (!ins.error) return ins;
    const { error: upErr } = await sb.from('views').update({ config: merged }).eq('channel', ch);
    return { error: upErr };
  }
  return upsertViewsConfigForChannel(ch, cfg);
}

/** Sync legacy message_orders so postgres_changes + other devices pick up order (views realtime can lag). */
async function syncMessageOrdersFromCurrentOrder(viewChannel) {
  if (!sb || !sb.from || !currentUser || !currentUser.id) return;
  const ch = String(viewChannel || currentChannel || currentView || 'main');
  const uid = currentUser.id;
  const order = Array.isArray(currentObjectOrder) ? currentObjectOrder : [];
  try {
    await sb.from('message_orders').delete().eq('user_id', uid).eq('channel', ch);
    if (!order.length) return;
    const rows = order.map((entry_id, position) => ({
      user_id: uid,
      channel: ch,
      entry_id,
      position,
    }));
    const { error } = await sb.from('message_orders').insert(rows);
    if (error) console.error('message_orders sync', error);
  } catch (e) {
    console.error('message_orders sync', e);
  }
}

function gatherPersonalWorkspaceStateForSave() {
  let frameOrder = null;
  try {
    frameOrder = getFrameOrder();
  } catch (_) {}
  let layoutSync = true;
  try {
    layoutSync = getLayoutSyncPref();
  } catch (_) {}
  let viewDisplayNamesCopy = {};
  try {
    viewDisplayNamesCopy = Object.assign({}, viewDisplayNames && typeof viewDisplayNames === 'object' ? viewDisplayNames : {});
  } catch (_) {}
  let leftChannelIds = [];
  try {
    leftChannelIds = Array.from(leftChannels || []).map(String).filter(Boolean);
  } catch (_) {}
  let manageBarOrder = [];
  try {
    const raw = localStorage.getItem(MANAGE_BAR_ORDER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) manageBarOrder = parsed;
    }
  } catch (_) {}
  /* Feed scroll stays on this device only (SCROLL_STATE_KEY). Omitting feedScrollByView from server
   * workspace prevents one tab’s refresh from pushing scroll onto another device. */
  let channelStripOrder = [];
  try {
    channelStripOrder = viewNames.filter(function(c) {
      return c && c !== 'main';
    });
  } catch (_) {}
  return {
    multiviewSplit: null,
    frameOrder: Array.isArray(frameOrder) ? frameOrder.slice() : null,
    layoutSync: !!layoutSync,
    viewDisplayNames: viewDisplayNamesCopy,
    leftChannelIds: leftChannelIds,
    manageBarOrder: manageBarOrder,
    focusedChannel: String(currentView || currentChannel || 'main'),
    channelStripOrder: channelStripOrder,
    uiChrome: gatherUiChromeForWorkspace(),
  };
}

function refreshWorkspaceChannelUi() {
  try {
    renderTabs();
    refreshMoveTargets();
    syncComposerTargetSelects();
  } catch (_) {}
}

function applyChannelStripOrderFromCfg(cfg) {
  if (!Array.isArray(cfg && cfg.channelStripOrder) || cfg.channelStripOrder.length === 0) return;
  try {
    var strip = cfg.channelStripOrder
      .map(function(x) { return String(x || '').trim(); })
      .filter(Boolean);
    var srv = strip.filter(function(c) { return c !== 'main'; });
    var localExtras = viewNames.filter(function(c) { return c !== 'main' && srv.indexOf(c) < 0; });
    viewNames = ['main'].concat(srv).concat(localExtras);
    viewNames = Array.from(new Set(viewNames));
    saveChannelsList();
    refreshWorkspaceChannelUi();
  } catch (_) {}
}

async function applyFocusedChannelFromCfg(cfg, skipApplyFocusedChannel, errorTag) {
  if (skipApplyFocusedChannel) return;
  if (typeof cfg.focusedChannel !== 'string' || !cfg.focusedChannel.trim()) return;
  var want = cfg.focusedChannel.trim();
  if (!viewNames.includes(want)) return;
  var slot0 = inputSlots && inputSlots[0];
  var slotMismatch =
    primarySlotAutoTarget && slot0 && String(slot0.channel || '') !== want;
  var needSwitch = want !== currentView || want !== currentChannel || slotMismatch;
  var remoteFocusOk =
    Date.now() - lastLocalFocusedChannelSwitchAt >= REMOTE_FOCUSED_CHANNEL_GRACE_MS;
  if (!needSwitch || !remoteFocusOk) return;
  applyingWorkspaceFocusFromRemote = true;
  try {
    await switchChannel(want);
  } catch (e) {
    console.error(errorTag || 'apply focusedChannel', e);
  } finally {
    applyingWorkspaceFocusFromRemote = false;
  }
}

async function applyPersonalWorkspaceStateFromServer(cfg, opts) {
  opts = opts || {};
  const mergeMultiview = !!opts.mergeMultiview;
  const skipApplyFocusedChannel = !!opts.skipApplyFocusedChannel;
  if (!cfg || typeof cfg !== 'object') return;
  if (mergeMultiview) {
    var releaseWsMerge = await acquireWsMergeLock();
    try {
    var revMerge = Number(cfg._wsRev);
    /* Do not drop merges when revMerge < lastMergedWorkspaceRevMs: _wsRev is each client’s Date.now(),
       so another device’s payload often looks “older” and would skip tab sync entirely. */
    applyingPersonalWorkspaceFromRemote = true;
    try {
      ensureWorkspaceChannelsFromCfg(cfg);
      applyChannelStripOrderFromCfg(cfg);
      await applyFocusedChannelFromCfg(cfg, skipApplyFocusedChannel, 'apply focusedChannel (merge)');
      /* Single main feed — no split panes from workspace merge. */
      if (cfg.uiChrome && typeof cfg.uiChrome === 'object') {
        applyWorkspaceUiChrome(cfg.uiChrome);
      }
      if (Number.isFinite(revMerge) && revMerge > lastMergedWorkspaceRevMs) lastMergedWorkspaceRevMs = revMerge;
    } finally {
      applyingPersonalWorkspaceFromRemote = false;
    }
    return;
    } finally {
      releaseWsMerge();
    }
  }
  var revCk = Number(cfg._wsRev);
  if (Number.isFinite(revCk) && revCk <= lastAppliedWorkspaceRev) return;
  applyingPersonalWorkspaceFromRemote = true;
  try {
  ensureWorkspaceChannelsFromCfg(cfg);
  applyChannelStripOrderFromCfg(cfg);
  await applyFocusedChannelFromCfg(cfg, skipApplyFocusedChannel, 'apply focusedChannel');
  /* Single main feed — split panes are not restored from server. */
  if (Array.isArray(cfg.frameOrder) && cfg.frameOrder.length) {
    try {
      applyFrameOrder(cfg.frameOrder);
      localStorage.setItem(FRAME_ORDER_KEY, JSON.stringify(cfg.frameOrder));
    } catch (_) {}
  }
  if (typeof cfg.layoutSync === 'boolean') {
    try {
      setLayoutSyncPref(cfg.layoutSync, false);
      setupLayoutChannel();
    } catch (_) {}
  }
  if (cfg.viewDisplayNames && typeof cfg.viewDisplayNames === 'object') {
    try {
      viewDisplayNames = Object.assign({}, cfg.viewDisplayNames);
      saveViewDisplayNames();
      refreshWorkspaceChannelUi();
    } catch (_) {}
  }
  if (Array.isArray(cfg.leftChannelIds)) {
    try {
      leftChannels = new Set(cfg.leftChannelIds.map(x => String(x || '').trim()).filter(x => x && x !== 'main'));
      localStorage.setItem(LEFT_CHANNELS_KEY, JSON.stringify(Array.from(leftChannels)));
    } catch (_) {}
  }
  if (Array.isArray(cfg.manageBarOrder) && cfg.manageBarOrder.length) {
    try {
      localStorage.setItem(MANAGE_BAR_ORDER_KEY, JSON.stringify(cfg.manageBarOrder));
      applyManageBarOrder();
    } catch (_) {}
  }
  if (cfg.uiChrome && typeof cfg.uiChrome === 'object') {
    applyWorkspaceUiChrome(cfg.uiChrome);
  }
  if (Number.isFinite(revCk) && revCk > lastAppliedWorkspaceRev) lastAppliedWorkspaceRev = revCk;
  } finally {
    applyingPersonalWorkspaceFromRemote = false;
  }
}

function canSyncPersonalWorkspaceNow() {
  return !applyingPersonalWorkspaceFromRemote && !inoutHydratingWorkspace && !!currentUser && !!sb;
}

function schedulePersonalWorkspacePersist() {
  /* Workspace UI sync uses Supabase whenever signed in — independent of object storage target (cloud vs local vault). */
  if (!canSyncPersonalWorkspaceNow()) return;
  if (_personalWorkspacePersistTimer) clearTimeout(_personalWorkspacePersistTimer);
  _personalWorkspacePersistTimer = setTimeout(function() {
    _personalWorkspacePersistTimer = null;
    persistPersonalWorkspaceToServer();
  }, 10);
}
if (typeof window !== 'undefined') window.schedulePersonalWorkspacePersist = schedulePersonalWorkspacePersist;

function notifyWorkspaceChromeChanged() {
  if (!canSyncPersonalWorkspaceNow()) return;
  schedulePersonalWorkspacePersist();
}

function flushPersonalWorkspacePersist() {
  /* Never push workspace while merging remote config — partial DOM can clobber focusedChannel. */
  if (!canSyncPersonalWorkspaceNow()) return Promise.resolve();
  if (_personalWorkspacePersistTimer) {
    clearTimeout(_personalWorkspacePersistTimer);
    _personalWorkspacePersistTimer = null;
  }
  return persistPersonalWorkspaceToServer();
}

(function bindWorkspacePersistOnDocumentHide() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  function persistTabBeforeHide(ev) {
    if (!ev || ev.type !== 'pagehide') {
      if (document.visibilityState !== 'hidden') return;
    }
    try {
      if (typeof currentView !== 'undefined' && currentView)
        localStorage.setItem(CURRENT_VIEW_KEY, String(currentView));
      if (typeof currentChannel !== 'undefined' && currentChannel)
        localStorage.setItem(CURRENT_CHANNEL_KEY, String(currentChannel));
    } catch (_) {}
    if (!canSyncPersonalWorkspaceNow()) return;
    try {
      flushPersonalWorkspacePersist();
    } catch (_) {}
  }
  document.addEventListener('visibilitychange', persistTabBeforeHide);
  window.addEventListener('pagehide', persistTabBeforeHide);
})();

async function persistPersonalWorkspaceToServer() {
  if (!canSyncPersonalWorkspaceNow()) return;
  try {
    const base = gatherPersonalWorkspaceStateForSave();
    try {
      delete base.feedScrollByView;
    } catch (_) {}
    var wsNonce =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'ws' + Date.now() + Math.random().toString(16).slice(2);
    rememberWorkspacePushNonce(wsNonce);
    base._wsPushNonce = wsNonce;
    base._wsRev = Date.now();
    await upsertViewsConfigForChannel(WORKSPACE_META_VIEW_CHANNEL, base);
    try {
      tryBroadcastWorkspaceConfig(JSON.parse(JSON.stringify(base)));
    } catch (bcErr) {
      console.error('workspace broadcast clone', bcErr);
    }
  } catch (e) {
    console.error('persistPersonalWorkspaceToServer', e);
  }
}

/** After loading workspace row: recover last tab when server still says `main` (stale/clobbered) or channel is missing from strip. */
function resolveHydratedFocusedChannel(cfgFull) {
  var savedCh = '';
  try {
    savedCh = (localStorage.getItem(CURRENT_VIEW_KEY) || '').trim();
  } catch (_) {}
  var wf =
    cfgFull && typeof cfgFull.focusedChannel === 'string' ? cfgFull.focusedChannel.trim() : '';
  var want = null;
  if (wf && viewNames.includes(wf)) want = wf;
  if (!want && savedCh && viewNames.includes(savedCh)) want = savedCh;
  if (want === 'main' && savedCh && savedCh !== 'main' && viewNames.includes(savedCh)) want = savedCh;
  if (!want && viewNames.includes('main')) want = 'main';
  return want || 'main';
}

async function hydrateWorkspaceOpenViewsForSignedInUser() {
  if (!currentUser || !sb) {
    return;
  }
  inoutHydratingWorkspace = true;
  try {
    closeExtraViews();
    let cfgFull = null;
    try {
      const { data, error } = await sb
        .from('views')
        .select('config')
        .eq('channel', WORKSPACE_META_VIEW_CHANNEL)
        .eq('user_id', currentUser.id)
        .limit(1)
        .maybeSingle();
      if (!error && data != null) {
        cfgFull = normalizeViewConfig(data.config);
      }
    } catch (e) {
      console.error('hydrateWorkspaceOpenViewsForSignedInUser', e);
    }
    if (cfgFull && typeof cfgFull === 'object') {
      await applyPersonalWorkspaceStateFromServer(cfgFull, { skipApplyFocusedChannel: true });
      try {
        var seedRev = Number(cfgFull._wsRev);
        if (Number.isFinite(seedRev) && seedRev > lastMergedWorkspaceRevMs) lastMergedWorkspaceRevMs = seedRev;
      } catch (_) {}
      try {
        var wantFocus = resolveHydratedFocusedChannel(cfgFull);
        if (wantFocus) await switchChannel(wantFocus);
      } catch (e) {
        console.error('hydrate restore tab', e);
      }
      return;
    }
    try {
      const saved = localStorage.getItem(CURRENT_VIEW_KEY);
      if (saved && viewNames.includes(saved)) {
        await switchChannel(saved);
      }
    } catch (e) {
      console.error('hydrate local channel', e);
    }
  } finally {
    inoutHydratingWorkspace = false;
  }
}

async function loadObjectOrderForCurrentChannel() {
  currentObjectOrder = [];
  if (!shouldUseServerForObjects() || !sb) {
    currentObjectOrder = loadOrderFromLocal();
    return;
  }
  // 1) Try unified view object (per-user main, or one row per shared/guest channel).
  try {
    let q = sb
      .from('views')
      .select('config')
      .eq('channel', currentChannel)
      .limit(1);
    if (currentUser && currentUser.id && !isChannelViewCollaborative(currentChannel)) {
      q = q.eq('user_id', currentUser.id);
    }
    const { data, error } = await q.maybeSingle();
    const cfg = !error && data ? normalizeViewConfig(data.config) : null;
    if (cfg) {
      applyRemoteViewTitle(currentChannel, cfg.title);
      const orderArr = Array.isArray(cfg.order) ? cfg.order : [];
      currentObjectOrder = orderArr
        .map(x => Number(x))
        .filter(x => Number.isFinite(x));
      // Pull view rules into fieldPrefs and mirror into local storage.
      const defTime = true;
      const defAuthor = true;
      fieldPrefs = {
        showTime: typeof cfg.showTime === 'boolean' ? cfg.showTime : defTime,
        showAuthor: typeof cfg.showAuthor === 'boolean' ? cfg.showAuthor : defAuthor,
        showLabels: typeof cfg.showLabels === 'boolean' ? cfg.showLabels : true,
      };
      saveFieldPrefsForCurrentChannel();
      // also mirror order into local backup
      saveOrderToLocal();
    }
  } catch (e) {
    // views table might not exist yet; fail soft
    console.error(e);
  }
  // 2) If no view-based order, fall back to legacy message_orders + local.
  if (!currentObjectOrder.length && currentUser) {
    try {
      const { data, error } = await sb
        .from('message_orders')
        .select('entry_id, position')
        .eq('user_id', currentUser.id)
        .eq('channel', currentChannel)
        .order('position', { ascending: true });
      if (!error && data && data.length) {
        currentObjectOrder = data
          .map(row => Number(row.entry_id))
          .filter(x => Number.isFinite(x));
      }
    } catch (e) {
      console.error(e);
    }
  }
  // 3) Final fallback: pure local order.
  if (!currentObjectOrder.length) {
    currentObjectOrder = loadOrderFromLocal();
  }
}

let suppressNextOrderApply = false;
let suppressNextViewApply = false;
let suppressOrderApplyUntil = 0; /* ignore realtime order/view applies until this timestamp */

async function saveObjectOrderForCurrentView() {
  saveOrderToLocal();
  suppressOrderApplyUntil = Date.now() + 350;
  // Persist order into unified views config for this channel (owner writes; guests just read).
  if (currentUser && shouldUseServerForObjects() && sb) {
    try {
      const orderArr = Array.isArray(currentObjectOrder) ? currentObjectOrder.slice() : [];
      const cfg = {
        order: orderArr,
        title: (viewDisplayNames && typeof viewDisplayNames[currentView] === 'string' && viewDisplayNames[currentView].trim())
          ? viewDisplayNames[currentView].trim()
          : null,
        showTime: fieldPrefs && typeof fieldPrefs.showTime === 'boolean' ? fieldPrefs.showTime : true,
        showAuthor: fieldPrefs && typeof fieldPrefs.showAuthor === 'boolean'
          ? fieldPrefs.showAuthor
          : (currentView === 'main' ? false : true),
        showLabels: fieldPrefs && typeof fieldPrefs.showLabels === 'boolean' ? fieldPrefs.showLabels : true,
        viewMode: 'feed',
      };
      suppressNextViewApply = true;
      const viewCh = String(currentChannel || currentView || 'main');
      const { error } = await upsertChannelViewConfigMerged(viewCh, cfg);
      if (error) console.error(error);
      else {
        if (!isChannelViewCollaborative(viewCh)) await syncMessageOrdersFromCurrentOrder(viewCh);
        broadcastOrderSyncFromSave();
      }
    } catch (e) { console.error(e); }
  }
}

function recomputeOrderFromDOM(container) {
  const targetInner = container || feedInner;
  if (!targetInner) return;
  pushUndo({ type: 'order', before: (currentObjectOrder || []).slice() });
  logAction('reorder', { channel: currentChannel });
  const ids = Array.from(targetInner.querySelectorAll('.obj'))
    .map(row => Number(row.dataset.id))
    .filter(id => Number.isFinite(id));
  currentObjectOrder = ids;
}

function applyObjectOrderToDOM() {
  if (!currentObjectOrder.length) return;
  // Reapply order in every open view showing the current view name.
  views.forEach(view => {
    if (!view || view.channel !== currentView || !view.feedInner) return;
    const inner = view.feedInner;
    const rows = Array.from(inner.querySelectorAll('.obj'));
  if (!rows.length) return;
  const domOrder = rows.map(r => Number(r.dataset.id)).filter(id => Number.isFinite(id));
    if (domOrder.length === currentObjectOrder.length &&
        domOrder.every((id, i) => id === currentObjectOrder[i])) return;
  const byId = new Map();
  rows.forEach(row => {
    const id = Number(row.dataset.id);
    if (Number.isFinite(id)) byId.set(id, row);
  });
  if (!byId.size) return;
  const order = currentObjectOrder.filter(id => byId.has(id));
  const frag = document.createDocumentFragment();
  order.forEach(id => {
    const row = byId.get(id);
    if (row) {
      frag.appendChild(row);
      byId.delete(id);
    }
  });
  byId.forEach(row => frag.appendChild(row));
    inner.appendChild(frag);
  });
}

function renderTabs() {
  if (!window.InoutTabsUi || !window.InoutTabsUi.renderTabs) return;
  window.InoutTabsUi.renderTabs(inoutTabsUiCtx());
}

function renameView(ch, btn) {
  if (!ch || !btn) return;
  const label = btn.querySelector('.tab-label');
  if (!label) return;
  if (btn.querySelector('.tab-rename-input')) return;
  const key = String(ch);
  const hadCustomBefore = !!(viewDisplayNames && typeof viewDisplayNames[key] === 'string' && viewDisplayNames[key].trim());
  const beforeRaw = hadCustomBefore ? viewDisplayNames[key].trim() : null;
  const before = getViewDisplayName(key);
  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.type = 'text';
  input.value = before;
  input.setAttribute('aria-label', 'Rename view');
  input.maxLength = 80;
  label.style.display = 'none';
  btn.classList.add('tab-renaming');
  btn.insertBefore(input, label);
  input.focus();
  input.select();
  var syncTimer = null;
  var scheduleSync = function(nextTitle) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function() {
      persistViewTitle(key, nextTitle);
      syncTimer = null;
    }, 120);
  };

  function cleanup(nextText) {
    if (nextText == null) {
      label.textContent = before;
    } else {
      label.textContent = nextText;
    }
    if (input.parentNode) input.parentNode.removeChild(input);
    label.style.display = '';
    btn.classList.remove('tab-renaming');
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  }

  var finished = false;
  function commit() {
    if (finished) return;
    finished = true;
    const cleaned = String(input.value || '').trim();
    if (!cleaned) {
      applyRemoteViewTitle(key, null);
      cleanup(getViewDefaultName(key));
      persistViewTitle(key, null);
      schedulePersonalWorkspacePersist();
      return;
    }
    applyRemoteViewTitle(key, cleaned);
    cleanup(cleaned);
    persistViewTitle(key, cleaned);
    schedulePersonalWorkspacePersist();
  }

  function cancel() {
    if (finished) return;
    finished = true;
    applyRemoteViewTitle(key, beforeRaw);
    persistViewTitle(key, beforeRaw);
    schedulePersonalWorkspacePersist();
    cleanup(before);
  }

  input.addEventListener('input', function() {
    const liveRaw = String(input.value || '').trim();
    const live = liveRaw || getViewDefaultName(key);
    applyRemoteViewTitle(key, liveRaw || null);
    scheduleSync(liveRaw || null);
    label.textContent = live;
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  input.addEventListener('blur', commit, { once: true });
}

function syncComposerTargetSelects() {
  const channels = (typeof viewNames !== 'undefined' && Array.isArray(viewNames)) ? viewNames : ['main'];
  if (!composerSlotsContainer) return;
  composerSlotsContainer.querySelectorAll('.composer-slot-target-select').forEach((sel, i) => {
    let preferred = sel.value;
    if (i === 0 && typeof currentChannel !== 'undefined' && currentChannel != null && String(currentChannel)) {
      preferred = String(currentChannel);
    } else if (inputSlots && inputSlots[i] && inputSlots[i].channel != null) {
      preferred = String(inputSlots[i].channel);
    }
    sel.innerHTML = '';
    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch;
      opt.textContent = getViewDisplayName(ch);
      if (ch === preferred) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!sel.value && channels.length) sel.selectedIndex = 0;
  });
}

async function syncChannelsFromServer() {
  if (!currentUser) return;
  try {
    const { data, error } = await sb
      .from('channel_members')
      .select('channel')
      .eq('user_id', currentUser.id);
    if (error) {
      console.error(error);
      return;
    }
    const server = (data || [])
      .map(r => (typeof r.channel === 'string' ? r.channel.trim() : ''))
      .filter(ch => ch && ch !== 'main' && !leftChannels.has(ch));
    const merged = new Set(['main', ...viewNames, ...server]);
    viewNames = Array.from(merged);
    saveChannelsList();
    await refreshSharedFlags();
    renderTabs();
    subscribeRealtimeAll();
    refreshMoveTargets();
  } catch (e) {
    console.error(e);
  }
}

async function refreshSharedFlags() {
  if (!currentUser) return;
  sharedChannels.clear();
  try {
    // Mark channel as shared if it has any member other than me
    const { data, error } = await sb
      .from('channel_members')
      .select('channel,user_id')
      .in('channel', viewNames)
      .neq('user_id', currentUser.id);
    if (!error && (data || []).length) {
      (data || []).forEach(r => {
        if (r && typeof r.channel === 'string') sharedChannels.add(r.channel);
      });
    }
    // Also mark channels that have an active visit link (temp_session) owned by me
    const { data: sessions, error: sessErr } = await sb
      .from('temp_sessions')
      .select('channel')
      .eq('owner_id', currentUser.id)
      .not('channel', 'is', null);
    if (!sessErr && (sessions || []).length) {
      (sessions || []).forEach(r => {
        if (r && typeof r.channel === 'string' && viewNames.includes(r.channel)) sharedChannels.add(r.channel);
      });
    }
  } catch (e) {
    console.error(e);
  }
}

async function switchChannelInternal(ch) {
  if (ch === currentChannel && ch === currentView) {
    const slot0 = inputSlots && inputSlots[0];
    const slotMismatch =
      primarySlotAutoTarget && slot0 && String(slot0.channel || '') !== String(ch);
    if (!slotMismatch) {
      /* Hydrate can set currentView via localStorage before switchChannel runs; same tab must still load data. */
      if (inoutHydratingWorkspace) {
        if (currentUser && shouldUseServerForObjects()) {
          try {
            await loadObjectOrderForCurrentChannel();
            await loadObjects();
          } catch (e) {
            console.error('switchChannel same-channel reload', e);
          }
        } else if (tempSessionId) {
          try {
            await loadObjectOrderForCurrentChannel();
            await loadObjects();
          } catch (e) {
            console.error('switchChannel same-channel guest reload', e);
          }
        } else if (!currentUser && !tempSessionId) {
          try {
            await loadLocalObjectsForCurrentView();
          } catch (e) {
            console.error('switchChannel same-channel local reload', e);
          }
        }
      }
      return;
    }
  }
  /* Only clear debounced tab clicks when we actually change channel — same-tab calls must not cancel a pending tap to another tab. */
  clearPendingViewSwitchClick();
  if (!applyingWorkspaceFocusFromRemote && !inoutHydratingWorkspace) {
    try {
      lastLocalFocusedChannelSwitchAt = Date.now();
    } catch (_) {}
  }
  teardownDndBroadcastChannel();
  /* Cancel pending composer DB writes — they would use the NEW channel id with the OLD view's text. */
  if (inputSaveToDbTimer) {
    clearTimeout(inputSaveToDbTimer);
    inputSaveToDbTimer = null;
  }
  if (inputSlotsSaveToDbTimer) {
    clearTimeout(inputSlotsSaveToDbTimer);
    inputSlotsSaveToDbTimer = null;
  }
  lastPrimaryInputEditAt = 0;
  lastSlotsEditAt = 0;
  inoutChannelInputQuietUntil = Date.now() + 520;
  if (editingObjectId != null) cancelEditingMode(true);
  if (feedEl) {
    var surfCh = primaryFeedScrollSurface();
    if (surfCh) viewScroll.set(currentView, surfCh.scrollTop);
    saveScrollState();
  }
  currentChannel = ch;
  currentView = ch;
  clearSelectionOnPrimaryViewSwitch();
  var primaryTextTrim = '';
  try {
    primaryTextTrim = input && String(input.value || '').trim() ? String(input.value).trim() : '';
  } catch (_) {}
  /* Auto-follow tab only when primary is empty; if user is composing, keep slot target. */
  if (primarySlotAutoTarget && inputSlots && inputSlots.length > 0 && !primaryTextTrim) {
    inputSlots[0].channel = ch;
    try { localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots)); } catch (_) {}
    if (typeof renderComposerSlots === 'function' && composerSlotsContainer) {
      renderComposerSlots();
    }
  }
  var syncInputCh = ch;
  try {
    if (inputSlots && inputSlots.length > 0 && inputSlots[0] && inputSlots[0].channel != null) {
      var sc = String(inputSlots[0].channel || '').trim();
      if (sc) syncInputCh = sc;
    }
  } catch (_) {}
  // keep main view's View name in sync
  if (views[0]) views[0].channel = ch;
  try {
    localStorage.setItem(CURRENT_CHANNEL_KEY, currentChannel);
    localStorage.setItem(CURRENT_VIEW_KEY, currentView);
  } catch (_) {}
  unreadCounts.set(ch, 0);
  updateTabsUI();
  updateTabBadge(ch);
  refreshMoveTargets();
  if (currentUser && sb && !applyingWorkspaceFocusFromRemote && !inoutHydratingWorkspace) {
    schedulePersonalWorkspacePersist();
  }
  /* Tab bar load: show for local taps and realtime/workspace focus; skip only full workspace hydrate. */
  var showTabLoad = !inoutHydratingWorkspace;
  if (showTabLoad) setTabChannelLoading(ch, true);
  try {
    await Promise.all([
      loadFieldPrefsForCurrentChannel(),
      currentUser ? ensureMembership() : Promise.resolve(),
    ]);
    if (getSyncInputPref() && currentUser) {
      await loadInputFromDbForChannel(syncInputCh);
    }
    if (currentUser) {
      setupDndBroadcastChannel();
      setupDraftChannel({ preserveDraftBubble: true });
      subscribeOrderRealtime();
      ensureViewRealtimeSubscribed();
      try {
        await reloadForUser();
      } catch (e) {
        console.error('switchChannel reload', e);
      }
    } else if (tempSessionId) {
      setupDraftChannel({ preserveDraftBubble: true });
      ensureViewRealtimeSubscribed();
      await loadObjectOrderForCurrentChannel();
      await loadObjects();
    } else {
      clearObjects();
    }
    if (!applyingWorkspaceFocusFromRemote && !inoutHydratingWorkspace) {
      try {
        await flushPersonalWorkspacePersist();
      } catch (e) {
        console.error('flush workspace after switchChannel', e);
      }
    }
    try {
      inoutChannelInputQuietUntil = Math.max(inoutChannelInputQuietUntil, Date.now() + 240);
    } catch (_) {}
  } finally {
    if (showTabLoad) setTabChannelLoading(ch, false);
  }
}

function openChannelModal() {
  if (!currentUser) {
    toast('Sign in to create a feed.');
    return;
  }
  if (!cmBackdrop || !cmName || !cmSelf || !cmOthers) return;
  closeAddMembersModal();
  cmName.value = '';
  cmOthers.value = '';
  cmSelf.textContent = currentUser.id || '';
  cmBackdrop.style.display = 'flex';
  cmName.focus();
  notifyWorkspaceChromeChanged();
}

function closeChannelModal() {
  if (!cmBackdrop) return;
  cmBackdrop.style.display = 'none';
  requestAnimationFrame(focusMainInput);
  notifyWorkspaceChromeChanged();
}

if (cmCancel) cmCancel.addEventListener('click', closeChannelModal);
if (cmBackdrop) cmBackdrop.addEventListener('click', e => {
  if (e.target === cmBackdrop) closeChannelModal();
});
if (addMembersCancelBtn) addMembersCancelBtn.addEventListener('click', closeAddMembersModal);
if (addMembersSaveBtn) addMembersSaveBtn.addEventListener('click', () => {
  submitAddMembersToCurrentView().catch(e => console.error(e));
});
if (addMembersBackdrop) {
  addMembersBackdrop.addEventListener('click', e => {
    if (e.target === addMembersBackdrop) closeAddMembersModal();
  });
}
if (cmCreate) cmCreate.addEventListener('click', createChannelFromModal);

async function createChannelFromModal() {
  if (!currentUser) {
    toast('Sign in to create a feed.');
    return;
  }
  if (!cmName || !cmOthers) return;
  let name = cmName.value.trim();
  if (!name) {
    toast('Feed name is required.');
    return;
  }
  if (name.toLowerCase() === 'main') {
    toast('Feed name "main" is reserved.');
    return;
  }

  leftChannels.delete(name);
  saveLeftChannelsList();
  if (!viewNames.includes(name)) {
    viewNames.push(name);
    saveChannelsList();
    renderTabs();
  }

  const extraRaw = cmOthers.value || '';
  const extraIds = extraRaw
    .split(',')
    .map(x => x.trim())
    .filter(x => x && x !== currentUser.id);

  try {
    const rows = [
      { channel: name, user_id: currentUser.id, creator_id: currentUser.id },
      ...extraIds.map(id => ({ channel: name, user_id: id, creator_id: currentUser.id })),
    ];
    await sb.from('channel_members').upsert(rows, { onConflict: 'channel,user_id' });
  } catch (e) {
    console.error(e);
    toast('Failed to save members — ' + humanError(e.message));
    closeChannelModal();
    return;
  }

  if (extraIds.length > 0) sharedChannels.add(name);

  try {
  closeChannelModal();
    await switchChannel(name);
  } catch (e) {
    console.error(e);
  } finally {
    if (cmBackdrop && cmBackdrop.style.display === 'flex') cmBackdrop.style.display = 'none';
  }
}

function deleteChannel(ch) {
  if (ch === 'main') return;
  leftChannels.add(ch);
  saveLeftChannelsList();
  viewNames = viewNames.filter(x => x !== ch);
  saveChannelsList();
  unreadCounts.delete(ch);
  sharedChannels.delete(ch);
  if (currentView === ch) {
    currentView = 'main';
    currentChannel = currentView;
  }
  renderTabs();
  subscribeRealtimeAll();
  if (currentUser) {
    try {
      sb.from('channel_members').delete().eq('channel', ch).eq('user_id', currentUser.id).then(function() {}).catch(function() {});
    } catch (_) {}
    reloadForUser();
  } else {
    clearObjects();
  }
}

async function ensureMembership() {
  if (!currentUser) return;
  try {
    await sb.from('channel_members').upsert({
      channel: currentChannel,
      user_id: currentUser.id,
      creator_id: currentUser.id
    }, { onConflict: 'channel,user_id' });
  } catch (e) {
    console.error(e);
  }
}

function closeManageBarDropdown() {
  if (typeof clearManageBarDropdownPosition === 'function') clearManageBarDropdownPosition();
  const manageBar = document.getElementById('manage-bar');
  if (manageBar) manageBar.classList.remove('manage-bar-open');
  const trig = document.getElementById('manage-bar-trigger');
  if (trig) trig.setAttribute('aria-expanded', 'false');
}

function openAddMembersModal() {
  if (!currentUser) {
    toast('Sign in to add people.');
    return;
  }
  if (!addMembersBackdrop || !addMembersChannelEl || !addMembersIdsInput) return;
  if (currentChannel === 'main') {
    toast('Personal view (main) is not shared this way — create another view or use Visit QR for guests.');
    return;
  }
  closeChannelModal();
  const label = typeof getViewDisplayName === 'function' ? getViewDisplayName(currentChannel) : currentChannel;
  addMembersChannelEl.textContent =
    currentChannel + (label && label !== currentChannel ? ' — ' + label : '');
  addMembersIdsInput.value = '';
  addMembersBackdrop.style.display = 'flex';
  closeManageBarDropdown();
  addMembersIdsInput.focus();
  notifyWorkspaceChromeChanged();
}

function closeAddMembersModal() {
  if (!addMembersBackdrop) return;
  addMembersBackdrop.style.display = 'none';
  requestAnimationFrame(focusMainInput);
  notifyWorkspaceChromeChanged();
}

async function submitAddMembersToCurrentView() {
  if (!currentUser || !sb || !sb.from) {
    toast('Sign in to add people.');
    return;
  }
  if (currentChannel === 'main') {
    toast('Use a non-main view to add signed-in collaborators.');
    return;
  }
  if (!addMembersIdsInput) return;
  const raw = addMembersIdsInput.value || '';
  const extraIds = raw
    .split(',')
    .map(x => x.trim())
    .filter(x => x && x !== currentUser.id);
  if (!extraIds.length) {
    toast('Enter at least one user id.');
    return;
  }
  const rows = extraIds.map(id => ({
    channel: currentChannel,
    user_id: id,
    creator_id: currentUser.id,
  }));
  try {
    const { error } = await sb.from('channel_members').upsert(rows, { onConflict: 'channel,user_id' });
    if (error) throw error;
  } catch (e) {
    console.error(e);
    toast('Failed to add people — ' + humanError(e.message));
    return;
  }
  sharedChannels.add(currentChannel);
  await refreshSharedFlags();
  renderTabs();
  subscribeRealtimeAll();
  refreshMoveTargets();
  closeAddMembersModal();
  toast(
    'Added ' +
      extraIds.length +
      ' ' +
      (extraIds.length === 1 ? 'person' : 'people') +
      ' to this view.'
  );
}

/* ═══ AUTH ════════════════════════════════════════════════ */
/** Run when returning from OAuth redirect: exchange code for session or wait for URL to be processed. */
async function ensureOAuthCallbackProcessed() {
  if (!sb || !sb.auth) return;
  if (_oauthCallbackPromise) {
    await _oauthCallbackPromise;
    _oauthCallbackPromise = null;
    await new Promise(function(r) { setTimeout(r, 80); });
    return;
  }
  var hasCode = typeof location !== 'undefined' && location.search && location.search.includes('code=');
  var hasHash = typeof location !== 'undefined' && location.hash && (location.hash.includes('access_token=') || location.hash.includes('code='));
  if (hasCode) {
    var params = new URLSearchParams(location.search);
    var code = params.get('code');
    if (code && typeof sb.auth.exchangeCodeForSession === 'function') {
      try {
        var result = await sb.auth.exchangeCodeForSession(code);
        if (result && result.error) {
          console.error('OAuth code exchange error', result.error);
          if (typeof toast === 'function') toast('Sign-in failed — ' + (result.error.message || 'try again'));
          return;
        }
        if (result && result.data && result.data.session) {
          try { history.replaceState(null, '', location.pathname || '/'); } catch (_) {}
          await new Promise(function(r) { setTimeout(r, 50); });
          return;
        }
      } catch (e) {
        console.error('OAuth code exchange failed', e);
        if (typeof toast === 'function') toast('Sign-in failed — ' + (e && e.message ? e.message : 'try again'));
      }
    }
  }
  if (hasHash) {
    await new Promise(function(r) { setTimeout(r, 350); });
  }
}

async function refreshAuth() {
  // After explicit sign-out in this tab, never auto-log back in until user clicks "Sign in" again.
  if (suppressAutoAuth) {
    currentUser = null;
    updateAuthUI();
    sharedChannels.clear();
    unreadCounts.clear();
    renderTabs();
    subscribeRealtimeAll();
    teardownDraftChannel();
    teardownDndBroadcastChannel();
    return;
  }

  await ensureOAuthCallbackProcessed();
  currentUser = null;
  try {
    if (sb && sb.auth && typeof sb.auth.getSession === 'function') {
      const { data } = await sb.auth.getSession();
      if (data && data.session && data.session.user) {
        currentUser = data.session.user;
      }
    }
  } catch (_) {
    currentUser = null;
  }

  updateAuthUI();

  // Guest temp-session mode: no account, but URL has ?tempSession=...
  if (!currentUser && tempSessionId && sb && sb.rpc) {
    try {
      const { data, error } = await sb.rpc('resolve_temp_session', { temp_session: tempSessionId });
      if (error || !data || !data.length) {
        toast('This visit link is expired or invalid.');
        tempSessionId = null;
      } else {
        const sessionInfo = data[0];
        // Decide shared View name on first link open.
        let ch = sessionInfo.channel;
        if (!ch) {
          const tsPrefix = (tempSessionId || 'temp').toString().slice(0, 8);
          ch = 'visit-' + tsPrefix;
          try {
            if (sb && sb.from) {
              await sb
                .from('temp_sessions')
                .update({ channel: ch })
                .eq('id', tempSessionId);
            }
          } catch (e) {
            console.error('Failed to set shared channel for temp session', e);
          }
        }
        if (!ch) ch = 'main';
        if (!viewNames.includes(ch)) {
          viewNames.push(ch);
          saveChannelsList();
        }
        currentView = ch;
        currentChannel = ch;
        renderTabs();
        await loadObjects();

        // Emit "joined" event so owner can react in realtime
        try {
          await sb.from('temp_session_events').insert({ temp_session_id: tempSessionId });
        } catch (e) {
          console.error('temp_session_events insert failed', e);
        }
        await loadObjectOrderForCurrentChannel();
      }
  } catch (e) {
      console.error(e);
      toast('Failed to join shared view.');
      tempSessionId = null;
    }
    // Anonymous guest in shared view: use channel-based realtime + view (order) realtime.
    subscribeRealtimeAll();
    setupDraftChannel();
    subscribeViewRealtime();
    return;
  }

  if (currentUser) {
    try {
      await refreshSharedFlags();
      await syncChannelsFromServer();
      try {
        restoreLastChannel();
      } catch (_) {}
      renderTabs();
      subscribeRealtimeAll();
      setupDraftChannel();
      await hydrateWorkspaceOpenViewsForSignedInUser();
      try {
        if (currentUser && sb) schedulePersonalWorkspacePersist();
      } catch (_) {}
      await loadObjectOrderForCurrentChannel();
      await loadObjects();
      if (getSyncInputPref()) {
        await restoreInputFromDb();
        setupInputStateRealtime();
      } else {
        restoreInputGlobal();
        teardownInputStateRealtime();
      }
    } catch (e) {
      console.error(e);
      renderTabs();
      try { await loadObjects(); } catch (_) {}
      if (feedInner && emptyEl && !emptyEl.parentNode) feedInner.appendChild(emptyEl);
    }
    // Owner realtime subscriptions, including temp-session joins and view/order
    subscribeTempSessionJoins();
    subscribeOrderRealtime();
    subscribeViewRealtime();
  } else {
    sharedChannels.clear();
    unreadCounts.clear();
    renderTabs();
    subscribeRealtimeAll();
    teardownDraftChannel();
    teardownInputStateRealtime();
    teardownDndBroadcastChannel();
    teardownWorkspaceUiBroadcast();
    if (viewSub) {
      try {
        viewSub.unsubscribe();
      } catch (_) {}
      viewSub = null;
    }
    // When not signed in, hydrate view from local per-device objects (anonymous mode),
    // unless we are in a temp-session guest mode.
    if (tempSessionId) {
      closeExtraViews();
      await loadObjectOrderForCurrentChannel();
      await loadObjects();
      subscribeViewRealtime();
    } else {
      closeExtraViews();
      await loadLocalObjectsForCurrentView();
    }
  }
}

var explicitSignOut = false;

async function saveNickname() {
  if (!currentUser || !umNickname) return;
  const raw = umNickname.value.trim();
  const nick = raw.slice(0, 40);
  try {
    const { data, error } = await sb.auth.updateUser({
      data: { nickname: nick || null }
    });
    if (error) {
      console.error(error);
      toast('Failed to save nickname — ' + humanError(error.message));
      return;
    }
    if (data && data.user) {
      currentUser = data.user;
      updateAuthUI();
      toast('Nickname saved.');
    }
  } catch (e) {
    console.error(e);
    toast('Failed to save nickname — ' + humanError(e.message));
  }
}

function getStorageLocationMessage() {
  if (tempSessionId) {
    return 'Shared view: objects sync through the server. Local databases below are for other sessions on this device.';
  }
  if (getStorageTarget() === 'local') {
    const reg = ensureVaultRegistry();
    const v = getActiveVaultId();
    const ent = reg.vaults.find(x => x && x.id === v);
    const label = ent && ent.label ? ent.label : v;
    return 'Local mode: objects live in database "' + label + '" on this device only.';
  }
  if (currentUser) return 'Cloud mode: objects use the server and sync where your account allows.';
  return 'Cloud mode selected but not signed in — objects still use this device until you sign in.';
}

async function applyStorageModeSideEffects() {
  try {
    teardownDraftChannel();
    subscribeRealtimeAll();
    if (shouldUseServerForObjects() && sb && sb.channel) {
      if (currentUser || tempSessionId) setupDraftChannel();
    }
    await loadObjectOrderForCurrentChannel();
    await loadObjects();
  } catch (e) {
    console.error(e);
  }
}

async function applyActiveVaultSideEffects() {
  try {
    await loadObjectOrderForCurrentChannel();
    await loadObjects();
  } catch (e) {
    console.error(e);
  }
}

function refreshStorageUIPanel() {
  ensureVaultRegistry();
  const cloud = document.getElementById('um-storage-cloud');
  const local = document.getElementById('um-storage-local');
  const hint = document.getElementById('um-storage-hint');
  const panel = document.getElementById('um-vault-panel');
  const wrap = document.getElementById('um-storage-target-wrap');
  if (umStorageInfo) umStorageInfo.textContent = getStorageLocationMessage();
  const target = getStorageTarget();
  if (cloud) cloud.checked = target === 'cloud';
  if (local) local.checked = target === 'local';
  const guest = !!tempSessionId;
  if (wrap) {
    wrap.style.opacity = guest ? '0.55' : '';
    wrap.querySelectorAll('input').forEach(inp => { inp.disabled = !!guest; });
  }
  if (hint) {
    if (guest) {
      hint.textContent = 'While visiting a shared view, objects are loaded from the server.';
    } else if (!currentUser && target === 'cloud') {
      hint.textContent = 'Sign in to sync objects with the server. Until then, data stays in the active local database.';
    } else if (currentUser && target === 'local') {
      hint.textContent = 'Objects are not uploaded to the server while Local is selected.';
    } else {
      hint.textContent = '';
    }
  }
  if (panel) panel.style.display = guest ? 'none' : '';
  const sel = document.getElementById('um-vault-select');
  if (sel) {
    const reg = readVaultRegistry();
    const active = getActiveVaultId();
    sel.innerHTML = '';
    reg.vaults.forEach(v => {
      if (!v || !v.id) return;
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = (v.label || v.id) + (v.id === 'default' ? '' : ' · ' + v.id);
      sel.appendChild(opt);
    });
    if (!reg.vaults.some(x => x.id === active)) {
      setActiveVaultId('default');
    }
    sel.value = getActiveVaultId();
  }
}

(function setupStoragePanelControls() {
  document.querySelectorAll('input[name="um-storage-target"]').forEach(r => {
    r.addEventListener('change', async () => {
      if (tempSessionId) return;
      setStorageTarget(r.value === 'local' ? 'local' : 'cloud');
      refreshStorageUIPanel();
      await applyStorageModeSideEffects();
      toast(r.value === 'local' ? 'Using local object storage.' : 'Using cloud for objects.');
    });
  });
  const sel = document.getElementById('um-vault-select');
  if (sel) {
    sel.addEventListener('change', async () => {
      setActiveVaultId(sel.value);
      refreshStorageUIPanel();
      await applyActiveVaultSideEffects();
    });
  }
  const openBtn = document.getElementById('um-vault-open');
  if (openBtn && sel) {
    openBtn.addEventListener('click', async () => {
      setActiveVaultId(sel.value);
      refreshStorageUIPanel();
      await applyActiveVaultSideEffects();
      toast('Switched active local database.');
    });
  }
  const createBtn = document.getElementById('um-vault-create');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const name = window.prompt('Name for the new local database (this device only):', 'Notebook');
      if (name == null) return;
      const slug = (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.sanitizeVaultId)
        ? INOUT_LOCAL_DB.sanitizeVaultId(name.trim().replace(/\s+/g, '_'))
        : (name.trim().replace(/\s+/g, '_').slice(0, 32) || 'notebook');
      const id = slug + '_' + Math.random().toString(36).slice(2, 6);
      const reg = ensureVaultRegistry();
      if (reg.vaults.some(v => v && v.id === id)) {
        toast('Try a different name.');
        return;
      }
      reg.vaults.push({ id, label: (name.trim() || id).slice(0, 48), createdAt: Date.now() });
      writeVaultRegistry(reg);
      setActiveVaultId(id);
      const store = getActiveLocalStore();
      if (store && store.init) await store.init();
      refreshStorageUIPanel();
      await applyActiveVaultSideEffects();
      toast('Created and opened new local database.');
    });
  }
  const delBtn = document.getElementById('um-vault-delete');
  if (delBtn) {
    delBtn.addEventListener('click', async () => {
      const vaultSel = document.getElementById('um-vault-select');
      const id = vaultSel ? vaultSel.value : getActiveVaultId();
      if (!id || id === 'default') {
        toast('Can’t delete the default database here — use “Clear this device” for a full wipe.');
        return;
      }
      if (!window.confirm('Delete local database "' + id + '" from this device? This cannot be undone.')) return;
      const reg = ensureVaultRegistry();
      reg.vaults = reg.vaults.filter(v => v && v.id !== id);
      writeVaultRegistry(reg);
      if (typeof INOUT_LOCAL_DB !== 'undefined' && INOUT_LOCAL_DB.forVault) {
        const st = INOUT_LOCAL_DB.forVault(id);
        if (st && st.deleteDatabase) await st.deleteDatabase();
      }
      setActiveVaultId('default');
      refreshStorageUIPanel();
      await applyActiveVaultSideEffects();
      toast('Local database deleted.');
    });
  }
})();

function updateAuthUI() {
  if (userBtn) userBtn.classList.toggle('signed-in', !!currentUser);

  refreshStorageUIPanel();

  if (umGuestNotifStatus) {
    if (typeof Notification === 'undefined') umGuestNotifStatus.textContent = 'Not supported';
    else umGuestNotifStatus.textContent = 'Notification permission: ' + Notification.permission;
  }

  if (currentUser) {
    const email = currentUser.email || 'Signed in';
    const nick  = currentUser.user_metadata && currentUser.user_metadata.nickname
      ? String(currentUser.user_metadata.nickname)
      : '';
    if (umAuthStatus) umAuthStatus.textContent = email;
    if (umAuthBtn) umAuthBtn.textContent = 'Sign out';
    if (umNickname) umNickname.value = nick;
    sendBtn.disabled = !input.value.trim();
    if (umUserId) umUserId.textContent = currentUser.id || '—';
    if (umCopyIdBtn) umCopyIdBtn.disabled = !currentUser.id;
    if (umVersionBadge) umVersionBadge.textContent = 'Free';
  } else {
    if (umAuthStatus) umAuthStatus.textContent = 'Not signed in';
    if (umAuthBtn) umAuthBtn.textContent = 'Sign in';
    sendBtn.disabled = true;
    if (umUserId) umUserId.textContent = '—';
    if (umCopyIdBtn) umCopyIdBtn.disabled = true;
    if (umNickname) umNickname.value = '';
    if (umVersionBadge) umVersionBadge.textContent = 'Free';
  }

  // If we arrived via a visit link, gently show who you are visiting and offer next steps.
  if (visitInviteNick && typeof toast === 'function') {
    toast('You are visiting ' + visitInviteNick + '. You can create a shared view with this person.');
    // In future: auto-open a modal with visit info + "Create shared view" button.
    visitInviteNick = null;
  }
}

async function reloadForUser() {
  if (editingObjectId != null) cancelEditingMode(true);
  await loadObjectOrderForCurrentChannel();
  await loadObjects();
  subscribeRealtimeAll();
  var savedScroll = viewScroll.get(currentView);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (feedEl) {
        var surfR = primaryFeedScrollSurface();
        if (surfR) {
          if (typeof savedScroll === 'number' && savedScroll >= 0) {
            surfR.scrollTop = Math.min(savedScroll, Math.max(0, surfR.scrollHeight - surfR.clientHeight));
          } else {
            scrollBottom();
          }
        }
      }
      /* Mobile: programmatic focus after load triggers Chrome keyboard / expanded input UI. */
      if (input && !isMobileOrTouchDevice()) {
        input.focus();
      }
    });
  });
  applyFieldPrefsToObjects();
}

function clearObjects() {
  feedInner.innerHTML = '';
  globalObjectNum = 0;
  objectCount = 0;
  updateObjectCount();
  seenIds.clear();
  lastKnownEntryTextById.clear();
  if (emptyEl && !emptyEl.parentNode) {
    feedInner.appendChild(emptyEl);
  }
}

async function signIn() {
  try {
    suppressAutoAuth = false;
    if (!sb && typeof supabase !== 'undefined') {
      sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
        auth: {
          detectSessionInUrl: true,
          flowType: 'pkce',
          persistSession: false,
          autoRefreshToken: false,
        },
        realtime: { params: { eventsPerSecond: 100 } },
      });
      if (typeof window !== 'undefined') window.sb = sb;
    }
  if (!sb || !sb.auth || typeof sb.auth.signInWithOAuth !== 'function') {
      toast('Sign-in not available.');
    return;
  }
    const redirectTo = typeof window !== 'undefined' && window.location.origin ? window.location.origin + '/' : undefined;
    const { data, error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: redirectTo ? { redirectTo } : {}
    });
    if (error) {
      console.error(error);
      toast('Sign-in failed — ' + humanError(error.message));
      return;
    }
    if (data && data.url) {
      window.location.href = data.url;
    }
  } catch (e) {
    console.error(e);
    toast('Sign-in failed — ' + humanError(e.message));
  }
}
if (typeof window !== 'undefined') window.signIn = signIn;

async function signOut() {
  explicitSignOut = true;
  suppressAutoAuth = true;
  currentUser = null;

  // 1) Clear app storage (everything this tab controls) but PRESERVE device id and anon objects.
  let preserved = {};
  try {
    preserved[LOCAL_DEVICE_ID_KEY] = localStorage.getItem(LOCAL_DEVICE_ID_KEY);
    preserved[LOCAL_ANON_OBJECTS_KEY] = localStorage.getItem(LOCAL_ANON_OBJECTS_KEY);
  } catch (_) {}
  try { sessionStorage.clear(); } catch (_) {}
  try {
    localStorage.clear();
    Object.keys(preserved).forEach(k => {
      if (preserved[k] != null) localStorage.setItem(k, preserved[k]);
    });
  } catch (_) {}

  // 2) Clear all non-httpOnly cookies on this domain (best-effort)
  try {
    const rawCookies = (document.cookie || '').split(';');
    for (const raw of rawCookies) {
      const name = raw.split('=')[0].trim();
      if (!name) continue;
      document.cookie = name + '=; Max-Age=0; path=/';
      document.cookie = name + '=; Max-Age=0; path=/; SameSite=Lax';
    }
  } catch (_) {}

  // 3) Clear any in-memory auth backup key we used
  try { sessionStorage.removeItem(AUTH_BACKUP_KEY); } catch (_) {}

  // 4) Update UI + local state
  updateAuthUI();
  clearObjects();
  teardownDraftChannel();
  teardownDndBroadcastChannel();
  teardownWorkspaceUiBroadcast();
  if (viewSub) {
    try {
      viewSub.unsubscribe();
    } catch (_) {}
    viewSub = null;
  }
  sharedChannels.clear();
  unreadCounts.clear();
  renderTabs();

  // 5) Ask Supabase to sign out on its side (if available)
  try {
    if (sb && sb.auth && typeof sb.auth.signOut === 'function') {
    const { error } = await sb.auth.signOut();
    if (error) console.error(error);
    }
  } catch (e) { console.error(e); }
}

async function copyUserId() {
  if (!currentUser || !currentUser.id) {
    toast('No user id to copy.');
    return;
  }
  try {
    await navigator.clipboard.writeText(currentUser.id);
    if (typeof showClipboardBubble === 'function') showClipboardBubble(currentUser.id);
    toast('User id copied.');
  } catch (e) {
    console.error(e);
    toast('Failed to copy id.');
  }
}

/** Signed-in entry text save: try filters that match typical RLS (shared views vs private main, etc.). */
async function tryUpdateEntryTextRest(entryId, textValue, rowChannel) {
  if (!currentUser || !sb || !sb.from) return false;
  const uid = currentUser.id;
  const id = entryId;
  const tv = String(textValue != null ? textValue : '');
  const ch = String(rowChannel || currentChannel || currentView || 'main');
  var builders;
  if (isChannelViewCollaborative(ch)) {
    builders = [
      function() {
        return sb.from(OBJECTS_TABLE).update({ text: tv }).eq('id', id).eq('channel', ch).select('id');
      },
      function() {
        return sb.from(OBJECTS_TABLE).update({ text: tv }).eq('id', id).eq('user_id', uid).eq('channel', ch).select('id');
      },
      function() {
        return sb.from(OBJECTS_TABLE).update({ text: tv }).eq('id', id).select('id');
      },
    ];
  } else {
    builders = [
      function() {
        return sb.from(OBJECTS_TABLE).update({ text: tv }).eq('id', id).eq('user_id', uid).eq('channel', ch).select('id');
      },
      function() {
        return sb.from(OBJECTS_TABLE).update({ text: tv }).eq('id', id).eq('channel', ch).select('id');
      },
      function() {
        return sb.from(OBJECTS_TABLE).update({ text: tv }).eq('id', id).eq('user_id', uid).select('id');
      },
      function() {
        return sb.from(OBJECTS_TABLE).update({ text: tv }).eq('id', id).select('id');
      },
    ];
  }
  for (var bi = 0; bi < builders.length; bi++) {
    var res = await builders[bi]();
    if (!res.error && res.data && res.data.length) return true;
  }
  return false;
}

/** Save full `entries.text` (plain or multi-value JSON blob). */
async function persistObjectTextPayload(entryId, serializedText, rowChannel) {
  const id = Number(entryId);
  if (!Number.isFinite(id)) return false;
  const ch = String(rowChannel != null ? rowChannel : currentChannel || 'main');
  const tv = String(serializedText != null ? serializedText : '');
  if (!shouldUseServerForObjects()) {
    try {
      const byView = await getLocalObjectByViewMap();
      const list = Array.isArray(byView[ch]) ? byView[ch].slice() : [];
      const idx = list.findIndex(function(o) { return o && Number(o.id) === id; });
      if (idx < 0) return false;
      list[idx] = Object.assign({}, list[idx], { text: tv });
      byView[ch] = list;
      await saveLocalObjectByViewMap(byView);
      updateObjectRowText(id, tv);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  var savedOk = false;
  if (currentUser && sb && sb.from) {
    savedOk = await tryUpdateEntryTextRest(id, tv, ch);
  }
  if (!savedOk && sb && sb.rpc) {
    const editPayload = {
      p_channel: ch,
      p_entry_id: id,
      p_action: 'edit',
      p_payload: { text: tv },
    };
    if (tempSessionId) editPayload.p_temp_session_id = tempSessionId;
    const { error } = await sb.rpc('perform_entry_action', editPayload);
    savedOk = !error;
  }
  if (savedOk) updateObjectRowText(id, tv);
  return savedOk;
}

async function addValueColumnToObjectFromMenu(obj) {
  if (!obj || obj.id == null) return;
  const id = Number(obj.id);
  if (!Number.isFinite(id)) return;
  var row = findObjectRowEl(id);
  var parts = row ? partsFromRowDom(row) : parseObjectTextToParts(obj.text);
  parts.push('');
  var payAdd = parseObjectTextPayload(obj.text);
  var next = serializeObjectParts(parts, labelsAlignedToNewPartCount(payAdd, parts.length));
  var ch = obj.channel != null ? String(obj.channel) : String(currentChannel || 'main');
  var ok = await persistObjectTextPayload(id, next, ch);
  if (!ok) toast('Could not add value.');
  else {
    if (feedInner) {
      var mc = Math.max(computeMaxValueColumnsFromFeedInner(feedInner), parts.length, 1);
      feedInner.dataset.inoutValueCols = String(mc);
    }
    syncFeedMultiValueChrome(feedInner);
    if (typeof applyFieldPrefsToObjects === 'function') applyFieldPrefsToObjects(true);
    toast('Value column added.');
  }
}

function cleanupAuthHash() {
  var clean = false;
  if (location.hash && (location.hash.includes('access_token=') || location.hash.includes('code='))) {
    clean = true;
  }
  if (location.search && location.search.includes('code=')) {
    clean = true;
  }
  if (!clean) return;
  try {
    history.replaceState(null, '', location.pathname || '/');
  } catch (_) {}
}

/* ═══ SEND ════════════════════════════════════════════════ */
async function send() {
  if (!input) return;
  const savingObjectEdit =
    editingObjectId != null || (editingObjectIds != null && editingObjectIds.size > 0);
  if (!savingObjectEdit && !input.value.trim()) return;
  await sendText(input.value || '');
}

async function sendText(text, options) {
  const targetChannel = (options && options.channel != null) ? options.channel : currentChannel;
  const idsToSave = editingObjectIds && editingObjectIds.size
    ? Array.from(editingObjectIds)
    : (editingObjectId != null ? [editingObjectId] : []);
  const trimmedNewPost = (text || '').trim();
  if (idsToSave.length === 0 && !trimmedNewPost) return;

  if (input) { input.disabled = true; }
  if (sendBtn) sendBtn.disabled = true;

  try {
  if (idsToSave.length > 0) {
    const trimmedPerId = idsToSave.map(function(id) {
      if (editingObjectTextMap && editingObjectTextMap[id] != null) {
        return String(editingObjectTextMap[id]).trim();
      }
      return trimmedNewPost;
    });
    if (!shouldUseServerForObjects()) {
      try {
        const byView = await getLocalObjectByViewMap();
        const ch = currentChannel || 'main';
        const list = Array.isArray(byView[ch]) ? byView[ch].slice() : [];
        for (let i = 0; i < idsToSave.length; i++) {
          const id = idsToSave[i];
          let textToSave = trimmedPerId[i];
          const idx = list.findIndex(o => o && Number(o.id) === Number(id));
          if (idx >= 0) {
            const prevPayload = parseObjectTextPayload(list[idx].text);
            const prevParts = prevPayload.parts;
            if (prevParts.length > 1) {
              const merged = mergeComposerIntoParts(prevParts, textToSave);
              textToSave = serializeObjectParts(merged, labelsAlignedToNewPartCount(prevPayload, merged.length));
            }
            list[idx] = Object.assign({}, list[idx], { text: textToSave });
          }
        }
        byView[ch] = list;
        await saveLocalObjectByViewMap(byView);
        idsToSave.forEach((id, i) => updateObjectRowText(id, trimmedPerId[i] || trimmedNewPost));
        originalEditTextForCancel = null;
        originalEditTextForCancelMap = null;
        editingObjectTextMap = null;
        editingObjectIds = null;
        if (input) input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        reactivateInputMode({ clearInput: targetChannel === currentChannel });
        return;
      } catch (e) {
        console.error(e);
        if (input) input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        toast('Failed to update — ' + humanError(e.message));
        return;
      }
    }
    const befores = [];
    const chFilter = String(currentChannel || currentView || 'main');
    if (idsToSave.length === 1) {
      let qs = sb
        .from(OBJECTS_TABLE)
        .select('id, created_at, text, channel, user_id, author_name')
        .eq('id', idsToSave[0])
        .eq('channel', chFilter);
      if (currentUser && currentUser.id && chFilter === 'main') {
        qs = qs.eq('user_id', currentUser.id);
      }
      const { data: before, error: selErr } = await qs.maybeSingle();
      if (selErr) {
        input.disabled = false;
        console.error(selErr);
        toast('Failed to update — ' + humanError(selErr.message));
        sendBtn.disabled = false;
        return;
      }
      if (before) befores.push(before);
    } else {
      let qm = sb
        .from(OBJECTS_TABLE)
        .select('id, created_at, text, channel, user_id, author_name')
        .in('id', idsToSave)
        .eq('channel', chFilter);
      if (currentUser && currentUser.id && chFilter === 'main') {
        qm = qm.eq('user_id', currentUser.id);
      }
      const { data: list, error: selErr } = await qm;
      if (selErr) {
        input.disabled = false;
        console.error(selErr);
        toast('Failed to update — ' + humanError(selErr.message));
        sendBtn.disabled = false;
        return;
      }
      if (list) befores.push(...list);
    }
    /* Channel label out of sync with DB: still load rows you own (matches typical RLS). */
    if (befores.length === 0 && currentUser && currentUser.id) {
      if (idsToSave.length === 1) {
        const { data: fb, error: fbErr } = await sb
          .from(OBJECTS_TABLE)
          .select('id, created_at, text, channel, user_id, author_name')
          .eq('id', idsToSave[0])
          .eq('user_id', currentUser.id)
          .maybeSingle();
        if (!fbErr && fb) befores.push(fb);
      } else {
        const { data: fl, error: flErr } = await sb
          .from(OBJECTS_TABLE)
          .select('id, created_at, text, channel, user_id, author_name')
          .in('id', idsToSave)
          .eq('user_id', currentUser.id);
        if (!flErr && fl && fl.length) befores.push(...fl);
      }
    }
    if (befores.length === 0) {
      input.disabled = false;
      sendBtn.disabled = false;
      toast('Could not load those objects — nothing was saved.');
      return;
    }
    let lastError = null;
    const textSavedById = {};
    for (let i = 0; i < idsToSave.length; i++) {
      const id = idsToSave[i];
      let textToSave = trimmedPerId[i];
      const beforeRow = befores.find(function(b) {
        return b && Number(b.id) === Number(id);
      });
      const prevPayload = beforeRow ? parseObjectTextPayload(beforeRow.text) : { parts: [''], labels: null };
      const prevParts = prevPayload.parts;
      if (prevParts.length > 1) {
        const merged = mergeComposerIntoParts(prevParts, textToSave);
        textToSave = serializeObjectParts(merged, labelsAlignedToNewPartCount(prevPayload, merged.length));
      }
      textSavedById[id] = textToSave;
      const rowChannel = String(
        beforeRow && beforeRow.channel != null ? beforeRow.channel : currentChannel || 'main'
      );
      var savedOk = false;
      /* Signed-in: REST update with RLS-friendly filters (see tryUpdateEntryTextRest). */
      if (currentUser && sb && sb.from) {
        savedOk = await tryUpdateEntryTextRest(id, textToSave, rowChannel);
      }
      if (!savedOk) {
        const editPayload = {
          p_channel: rowChannel,
          p_entry_id: id,
          p_action: 'edit',
          p_payload: { text: textToSave },
        };
        if (tempSessionId) editPayload.p_temp_session_id = tempSessionId;
        const { error } = await sb.rpc('perform_entry_action', editPayload);
        if (error) lastError = error;
      }
    }
    input.disabled = false;
    if (lastError) {
      console.error(lastError);
      toast('Failed to update — ' + humanError(lastError.message));
      sendBtn.disabled = false;
      const idsEndPresence =
        editingObjectIds && editingObjectIds.size
          ? Array.from(editingObjectIds)
          : editingObjectId != null
            ? [editingObjectId]
            : [];
      originalEditTextForCancel = null;
      originalEditTextForCancelMap = null;
      editingObjectTextMap = null;
      editingObjectIds = null;
      editingObjectId = null;
      idsEndPresence.forEach(function(oid) {
        broadcastViewEditingEnd(oid);
      });
      try {
        await loadObjects();
      } catch (e) {
        console.error(e);
      }
      reactivateInputMode({ clearInput: true });
      return;
    }
    if (befores.length) {
      pushUndo({
        type: 'edit',
        entries: befores.map(b => ({
          id: b.id,
          beforeText: b.text,
          afterText: textSavedById[b.id] != null ? textSavedById[b.id] : trimmedNewPost,
        })),
      });
      befores.forEach(b => logAction('edit', { id: b.id }));
    }
    idsToSave.forEach(function(id) {
      updateObjectRowText(id, textSavedById[id] != null ? textSavedById[id] : trimmedNewPost);
    });
    syncFeedMultiValueChrome(feedInner);
    originalEditTextForCancel = null;
    originalEditTextForCancelMap = null;
    editingObjectTextMap = null;
    editingObjectIds = null;
    reactivateInputMode({ clearInput: targetChannel === currentChannel });
    return;
  }

  let data = null;
  let error = null;

  if (shouldUseServerForObjects() && currentUser && sb && sb.from) {
    // Signed-in path: insert into Supabase as before.
    const payload = {
      text: trimmedNewPost,
      user_id: currentUser.id,
      channel: targetChannel,
    };
    // In a shared temp-session View, also tag owner rows with temp_session_id
    // so guests can see and edit them via RLS.
    if (tempSessionId) {
      payload.temp_session_id = tempSessionId;
    }
    const res = await sb
      .from(OBJECTS_TABLE)
      .insert(payload)
      .select('id, created_at, text, channel, user_id, author_name, temp_session_id')
      .single();
    data = res.data;
    error = res.error;
  } else if (shouldUseServerForObjects() && tempSessionId && sb && sb.from) {
    // Guest in temp session: write to Supabase with temp_session_id
    const res = await sb
      .from(OBJECTS_TABLE)
      .insert({
        text: trimmedNewPost,
        temp_session_id: tempSessionId,
      channel: targetChannel,
    })
      .select('id, created_at, text, channel, user_id, author_name, temp_session_id')
    .single();
    data = res.data;
    error = res.error;
  } else {
    // Local-only path: create a synthetic object stored on this device.
    const nowIso = new Date().toISOString();
    data = {
      id: Date.now(),
      created_at: nowIso,
      text: trimmedNewPost,
      channel: targetChannel,
      user_id: getDeviceId(),
      author_name: null,
    };
  }

  if (input) input.disabled = false;

  if (error) {
    console.error(error);
    const msg = 'Failed to send — ' + humanError(error.message);
    toast(msg);
    logError(msg);
    if (sendBtn) sendBtn.disabled = false;
  } else if (data) {
    // Update UI
    if (data.channel === currentChannel) {
      hideEmpty();
      appendObject(data, true);
      objectCount++;
      updateObjectCount();
    }
    // Persist locally for this device
    await upsertLocalObjectForCurrentView(data);
    // Undo/log only for signed-in Supabase sends
    if (shouldUseServerForObjects() && currentUser && sb && sb.from) {
      pushUndo({ type: 'send', entries: [data] });
      logAction('send', { channel: currentChannel });
    }
    reactivateInputMode({ clearInput: targetChannel === currentChannel });
  } else {
    if (sendBtn) sendBtn.disabled = false;
  }
  } finally {
    if (input) input.disabled = false;
    if (sendBtn && input) sendBtn.disabled = !input.value.trim();
  }
}

/* ═══ INPUT HANDLING ══════════════════════════════════════ */
function updateComposerCount() {
  var countEl = document.getElementById('object-input-count');
  var wrap = input && input.closest && input.closest('.composer-input-wrap');
  if (!countEl || !wrap) return;
  var len = (input && input.value) ? input.value.length : 0;
  if (len >= 1800) {
    wrap.classList.add('has-count');
    countEl.textContent = len + '/2000';
  } else {
    wrap.classList.remove('has-count');
    countEl.textContent = '';
  }
}

var _inputListenersAttached = false;
var _documentDraftSelectionBound = false;
var _draftSelChangeTimer = null;
function onDraftSelectionChangeDoc() {
  var inp = document.getElementById('object-input');
  if (!inp) return;
  if (document.activeElement !== inp || editingObjectId != null) return;
  if (_draftSelChangeTimer) clearTimeout(_draftSelChangeTimer);
  _draftSelChangeTimer = setTimeout(function() {
    _draftSelChangeTimer = null;
    broadcastDraft();
  }, 45);
}
function attachInputListeners() {
  if (_inputListenersAttached) return;
  var inp = document.getElementById('object-input');
  var btn = document.getElementById('send-btn');
  if (inp) input = inp;
  if (btn) sendBtn = btn;
  if (!input) return;
  _inputListenersAttached = true;
  var primaryManagedBySlots =
    composerSlotsContainer && composerSlotsContainer.contains(input);

  if (!primaryManagedBySlots) {
    input.addEventListener('input', () => {
      lastPrimaryInputEditAt = Date.now();
      autoResize();
      var inObjEdit = editingObjectId != null || (editingObjectIds && editingObjectIds.size > 0);
      if (sendBtn) sendBtn.disabled = inObjEdit ? false : !input.value.trim();
      saveInputGlobal();
      updateClearInputBtn();
      scheduleSaveInputToDb();
      if (editingObjectId != null) {
        if (editingObjectIds && editingObjectIds.size > 1) {
          applyPrimaryEditToMultiEdit(input.value);
        } else if (editingObjectTextMap && editingObjectId != null) {
          editingObjectTextMap[editingObjectId] = input.value;
        }
        updateEditingRowFromInput();
        if (editTypingCommitTimer) clearTimeout(editTypingCommitTimer);
        editTypingCommitTimer = setTimeout(commitTypingSegment, TYPING_COMMIT_MS);
      }
      broadcastDraft(input.value);
      updateRemoteSelectionOverlay();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (editingObjectId) cancelEditingMode(true);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (sendBtn && !sendBtn.disabled) send();
      }
    });
    input.addEventListener('click', () => {
      if (!isMobileOrTouchDevice() && document.activeElement !== input) {
        try {
          input.focus({ preventScroll: true });
        } catch (_) {
          try {
            input.focus();
          } catch (_) {}
        }
      }
      if (editingObjectId != null) updateEditingRowFromInput();
      else broadcastDraft();
    });
    input.addEventListener('keyup', () => {
      if (editingObjectId != null) updateEditingRowFromInput();
      else broadcastDraft();
    });
    input.addEventListener('select', () => {
      if (editingObjectId != null) updateEditingRowFromInput();
      else broadcastDraft();
    });
    input.addEventListener('mouseup', () => {
      if (editingObjectId != null) updateEditingRowFromInput();
      else broadcastDraft();
    });
    if (sendBtn) sendBtn.addEventListener('click', send);
  }

  if (!_documentDraftSelectionBound) {
    try {
      document.addEventListener('selectionchange', onDraftSelectionChangeDoc);
      _documentDraftSelectionBound = true;
    } catch (_) {}
  }
  input.addEventListener('scroll', () => {
    var ov = document.getElementById('remote-selection-overlay');
    if (ov) { ov.scrollTop = input.scrollTop; ov.scrollLeft = input.scrollLeft; }
  });
}
if (composerSlotsContainer) {
  renderComposerSlots();
  if (!composerSlotsContainer.dataset.inoutComposerFocusSuppress) {
    composerSlotsContainer.dataset.inoutComposerFocusSuppress = '1';
    composerSlotsContainer.addEventListener('focusin', function(ev) {
      var t = ev.target;
      if (!t || t.tagName !== 'TEXTAREA') return;
      if (!t.closest || !t.closest('.composer-slot')) return;
      bumpComposerRemoteMergeSuppress(850);
    });
  }
}
setupInputAreaDropTarget();
setupTextFileImportDropTargets();
attachInputListeners();
if (typeof initFramesZone === 'function') initFramesZone();
if (umLayoutSyncChk) {
  umLayoutSyncChk.checked = getLayoutSyncPref();
  umLayoutSyncChk.addEventListener('change', function() {
    setLayoutSyncPref(umLayoutSyncChk.checked);
    if (umLayoutSyncChk.checked && typeof setupLayoutChannel === 'function') setupLayoutChannel();
    else if (layoutChannel) { try { layoutChannel.unsubscribe(); } catch (_) {} layoutChannel = null; }
  });
}
if (!input && typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    if (composerSlotsContainer) renderComposerSlots();
    attachInputListeners();
    if (typeof initFramesZone === 'function') initFramesZone();
  });
}

var composerAddSlotBtn = document.getElementById('composer-add-slot');
if (composerAddSlotBtn) {
  composerAddSlotBtn.addEventListener('click', addComposerSlot);
}

if (draftCopyBtn) {
  draftCopyBtn.addEventListener('click', () => {
    if (!latestRemoteDraft) return;
    try {
      navigator.clipboard.writeText(latestRemoteDraft);
      if (typeof showClipboardBubble === 'function') showClipboardBubble(latestRemoteDraft);
      toast('Draft copied to clipboard.');
    } catch (e) {
      console.error(e);
      toast('Could not copy draft.');
    }
  });
}

if (draftSendBtn) {
  draftSendBtn.addEventListener('click', () => {
    if (!latestRemoteDraft) return;
    sendText(latestRemoteDraft);
  });
}

if (draftClearBtn) {
  draftClearBtn.addEventListener('click', () => {
    if (editingObjectId != null) {
      cancelEditingMode(true);
      return;
    }
    latestRemoteDraft = '';
    hideDraftBubble();
    broadcastDraft('');
  });
}

if (clipboardPasteBtn) {
  clipboardPasteBtn.addEventListener('click', () => {
    if (!latestClipboardText) return;
    input.value = latestClipboardText;
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {}
    autoResize();
    sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
    requestAnimationFrame(focusMainInput);
  });
}

if (clipboardDismissBtn) {
  clipboardDismissBtn.addEventListener('click', () => {
    hideClipboardBubble();
  });
}

if (clipboardButton) {
  clipboardButton.addEventListener('click', async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) return;
    try {
      const text = (await navigator.clipboard.readText()) || '';
      const trimmed = text.trim();
      if (!trimmed) return;
      showClipboardBubble(text);
    } catch (e) {
      console.error(e);
      toast('Could not read clipboard.');
    }
  });
}

(function setupClipboardCopyBubbleListeners() {
  function onCopyOrCut(e) {
    var txt = getCopiedTextFromCopyEvent(e);
    if (!txt || !String(txt).trim()) return;
    if (typeof showClipboardBubble === 'function') showClipboardBubble(txt);
  }
  document.addEventListener('copy', onCopyOrCut, true);
  document.addEventListener('cut', onCopyOrCut, true);
})();

if (clearInputBtn) {
  clearInputBtn.addEventListener('click', () => {
    if (!input) return;
    input.value = '';
    lastPrimaryInputEditAt = 0;
    lastSlotsEditAt = 0;
    autoResize();
    saveInputGlobal();
    updateClearInputBtn();
    sendBtn.disabled = true;
    broadcastDraft('');
    requestAnimationFrame(focusMainInput);
  });
}

if (umUpgradeBtn) {
  umUpgradeBtn.addEventListener('click', () => {
    toast('Pro version coming soon — payment provider not selected yet.');
  });
}

if (selectToggle) {
  selectToggle.addEventListener('click', () => {
    if (selectMode) {
      selectedIds.clear();
      selectModeAutoOn = false;
      if (feedInner) {
        feedInner.querySelectorAll('.obj-select').forEach(box => { box.checked = false; });
        feedInner.querySelectorAll('.obj.obj-selected').forEach(row => row.classList.remove('obj-selected'));
      }
    } else {
      selectModeAutoOn = false;
    }
    setSelectMode(!selectMode);
  });
}

if (selectAllBtn) {
  selectAllBtn.addEventListener('click', () => {
    const boxes = feedInner.querySelectorAll('.obj-select');
    boxes.forEach(box => {
      box.checked = true;
      const row = box.closest('.obj');
      const id = row && row.dataset.id;
      if (id) {
        const n = Number(id);
        selectedIds.add(n);
      }
    });
    updateSelectionUI();
  });
}

if (selectNoneBtn) {
  selectNoneBtn.addEventListener('click', () => {
    selectModeAutoOn = false;
    const boxes = feedInner.querySelectorAll('.obj-select');
    boxes.forEach(box => {
      box.checked = false;
    });
    selectedIds.clear();
    feedInner.querySelectorAll('.obj.obj-selected').forEach(row => row.classList.remove('obj-selected'));
    updateSelectionUI();
  });
}

if (fieldTimeChk) {
  fieldTimeChk.addEventListener('change', () => {
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor, showLabels: fieldPrefs.showLabels } });
    fieldPrefs.showTime = !!fieldTimeChk.checked;
    logAction('view', { showTime: !!fieldTimeChk.checked, showAuthor: fieldPrefs.showAuthor });
    saveFieldPrefsForCurrentChannel();
    schedulePersistChannelViewRules();
    applyFieldPrefsToObjects();
  });
}

if (fieldAuthorChk) {
  fieldAuthorChk.addEventListener('change', () => {
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor, showLabels: fieldPrefs.showLabels } });
    fieldPrefs.showAuthor = !!fieldAuthorChk.checked;
    logAction('view', { showTime: fieldPrefs.showTime, showAuthor: !!fieldAuthorChk.checked });
    saveFieldPrefsForCurrentChannel();
    schedulePersistChannelViewRules();
    applyFieldPrefsToObjects();
  });
}

if (fieldLabelsChk) {
  fieldLabelsChk.addEventListener('change', () => {
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor, showLabels: fieldPrefs.showLabels } });
    fieldPrefs.showLabels = !!fieldLabelsChk.checked;
    logAction('view', { showLabels: !!fieldLabelsChk.checked });
    saveFieldPrefsForCurrentChannel();
    schedulePersistChannelViewRules();
    applyFieldPrefsToObjects();
  });
}

var barDndDraggedEl = null;
var barDndIndicatorEl = null;

function applyManageBarOrder() {
  var actions = document.getElementById('manage-actions');
  if (!actions) return;
  var order = [];
  try {
    var raw = localStorage.getItem(MANAGE_BAR_ORDER_KEY);
    if (raw) order = JSON.parse(raw);
  } catch (_) {}
  var nodes = Array.from(actions.children).filter(function(n) { return n.getAttribute && n.getAttribute('data-bar-id'); });
  var viewMenuEl = document.getElementById('view-menu');
  if (!order.length || order.length !== nodes.length) {
    order = nodes.map(function(n) { return n.getAttribute('data-bar-id'); });
  }
  var byId = new Map();
  nodes.forEach(function(n) { byId.set(n.getAttribute('data-bar-id'), n); });
  order.forEach(function(id) {
    var n = byId.get(id);
    if (n) { actions.removeChild(n); actions.appendChild(n); }
  });
  if (viewMenuEl && viewMenuEl.parentNode === actions) {
    actions.removeChild(viewMenuEl);
    actions.appendChild(viewMenuEl);
  }
}

if (viewToggleBtn && viewMenu) {
  viewToggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    viewMenu.classList.toggle('open');
    if (viewMenu.classList.contains('open')) {
      if (typeof positionViewMenuClamp === 'function') positionViewMenuClamp();
    } else if (typeof clearViewMenuInlinePosition === 'function') {
      clearViewMenuInlinePosition();
    }
    if (typeof notifyWorkspaceChromeChanged === 'function') notifyWorkspaceChromeChanged();
  });

  // Keep clicks inside the dropdown (labels, checkboxes) from closing it.
  viewMenu.addEventListener('click', e => {
    e.stopPropagation();
  });

  document.addEventListener('click', e => {
    if (!viewMenu.classList.contains('open')) return;
    const target = e.target;
    if (target === viewMenu || viewMenu.contains(target) || target === viewToggleBtn) return;
    viewMenu.classList.remove('open');
    if (typeof clearViewMenuInlinePosition === 'function') clearViewMenuInlinePosition();
    if (typeof notifyWorkspaceChromeChanged === 'function') notifyWorkspaceChromeChanged();
  });
}

async function handleDeleteSelectedObjects() {
  let ids = Array.from(selectedIds)
    .map(x => Number(x))
    .filter(id => Number.isFinite(id));
  try {
    if (!shouldUseServerForObjects()) {
      const byView = await getLocalObjectByViewMap();
      const ch = currentChannel || 'main';
      let list = Array.isArray(byView[ch]) ? byView[ch] : [];
      if (!ids.length) {
        ids = list.map(o => o && o.id).filter(id => id != null).map(Number).filter(Number.isFinite);
      }
      if (!ids.length) return;
      await removeLocalObjectsForCurrentView(ids);
      selectedIds.clear();
      try {
        views.forEach(v => {
          const inner = v && v.feedInner;
          if (!inner) return;
          inner.querySelectorAll('.obj-select:checked').forEach(box => { box.checked = false; });
          inner.querySelectorAll('.obj.obj-selected').forEach(row => row.classList.remove('obj-selected'));
        });
      } catch (_) {}
      setSelectMode(false);
      logAction('delete', { count: ids.length, channel: currentChannel });
      await reloadForUser();
      return;
    }
    if (!currentUser) return;
    let rowsToDelete = [];
    if (!ids.length) {
      const { data, error } = await sb
        .from(OBJECTS_TABLE)
        .select('id, created_at, text, channel, user_id, author_name')
        .eq('channel', currentChannel)
        .eq('user_id', currentUser.id);
      if (error) {
        console.error(error);
        toast('Failed to delete — ' + humanError(error.message));
        return;
      }
      rowsToDelete = data || [];
      ids = rowsToDelete.map(r => r.id);
      if (!ids.length) return;
    } else {
      const { data, error } = await sb
        .from(OBJECTS_TABLE)
        .select('id, created_at, text, channel, user_id, author_name')
        .in('id', ids);
      if (error) {
        console.error(error);
        toast('Failed to delete — ' + humanError(error.message));
        return;
      }
      rowsToDelete = data || [];
    }
    const { error } = await sb
      .from(OBJECTS_TABLE)
      .delete()
      .in('id', ids);
    if (error) {
      console.error(error);
      toast('Failed to delete — ' + humanError(error.message));
      return;
    }
    pushUndo({ type: 'delete', entries: rowsToDelete });
    logAction('delete', { count: rowsToDelete.length, channel: currentChannel });
    selectedIds.clear();
    try {
      views.forEach(v => {
        const inner = v && v.feedInner;
        if (!inner) return;
        inner.querySelectorAll('.obj-select:checked').forEach(box => { box.checked = false; });
        inner.querySelectorAll('.obj.obj-selected').forEach(row => row.classList.remove('obj-selected'));
      });
    } catch (_) {}
    setSelectMode(false);
    await reloadForUser();
  } catch (e) {
    console.error(e);
    toast('Failed to delete — ' + humanError(e.message));
  }
}

async function handleMoveSelectedObjects() {
  if (!moveTargetSelect) return;
  const target = moveTargetSelect.value;
  if (!target || target === currentChannel) return;
  const boxes = feedInner.querySelectorAll('.obj-select:checked');
  const ids = Array.from(boxes)
    .map(box => {
      const row = box.closest('.obj');
      return row && row.dataset.id ? Number(row.dataset.id) : null;
    })
    .filter(id => typeof id === 'number');
  if (!ids.length) return;
  try {
    if (!shouldUseServerForObjects()) {
      const byView = await getLocalObjectByViewMap();
      const src = currentChannel || 'main';
      const srcList = Array.isArray(byView[src]) ? byView[src] : [];
      const idSet = new Set(ids);
      const moving = srcList.filter(o => o && idSet.has(Number(o.id)));
      byView[src] = srcList.filter(o => !o || !idSet.has(Number(o.id)));
      const destList = Array.isArray(byView[target]) ? byView[target].slice() : [];
      const nowIso = new Date().toISOString();
      moving.forEach(o => {
        destList.push(Object.assign({}, o, { channel: target, created_at: nowIso }));
      });
      byView[target] = destList;
      await saveLocalObjectByViewMap(byView);
      logAction('move', { count: moving.length, target });
      setSelectMode(false);
      await reloadForUser();
      return;
    }
    if (!currentUser) return;
    const now = new Date().toISOString();
    const { data, error } = await sb
      .from(OBJECTS_TABLE)
      .select('id, created_at, text, channel, user_id, author_name')
      .eq('user_id', currentUser.id)
      .in('id', ids);
    if (error) {
      console.error(error);
      toast('Failed to move — ' + humanError(error.message));
      return;
    }
    const rowsBefore = data || [];
    const { error: updErr } = await sb
      .from(OBJECTS_TABLE)
      .update({ channel: target, created_at: now })
      .eq('user_id', currentUser.id)
      .in('id', ids);
    if (updErr) {
      console.error(updErr);
      toast('Failed to move — ' + humanError(updErr.message));
      return;
    }
    pushUndo({ type: 'move', entries: rowsBefore });
    logAction('move', { count: rowsBefore.length, target });
    setSelectMode(false);
    await reloadForUser();
  } catch (e) {
    console.error(e);
    toast('Failed to move — ' + humanError(e.message));
  }
}

if (deleteSelectedBtn) {
  deleteSelectedBtn.addEventListener('click', () => {
    handleDeleteSelectedObjects();
  });
}

if (moveSelectedBtn) {
  moveSelectedBtn.addEventListener('click', () => {
    handleMoveSelectedObjects();
  });
}

async function deleteSingleObject(id, fromChannel) {
  const ch = fromChannel != null ? fromChannel : currentChannel;
  if (!shouldUseServerForObjects()) {
    try {
      await removeLocalObjectsFromView([id], ch || 'main');
      if (ch === currentChannel || ch === currentView) {
        const row = feedInner && feedInner.querySelector('.obj[data-id="' + CSS.escape(String(id)) + '"]');
        if (row) row.remove();
        objectCount = Math.max(0, objectCount - 1);
        updateObjectCount();
        showEmptyIfNoObjects();
        currentObjectOrder = (currentObjectOrder || []).filter(x => Number(x) !== Number(id));
        saveOrderToLocal();
      }
    } catch (e) {
      console.error(e);
      toast('Failed to delete — ' + humanError(e.message));
    }
    return;
  }
  const numId = Number(id);
  if (!Number.isFinite(numId)) return;
  if (!sb || !sb.from) {
    toast('Delete not available.');
    return;
  }
  /* Prefer RPC for temp-session guests / shared RLS; fall back to REST like bulk delete when RPC is missing or fails. */
  if (sb.rpc && (tempSessionId || currentUser)) {
    try {
      const payload = {
        p_channel: ch,
        p_entry_id: numId,
        p_action: 'delete',
        p_payload: {},
      };
      if (tempSessionId) payload.p_temp_session_id = tempSessionId;
      const { error } = await sb.rpc('perform_entry_action', payload);
      if (!error) return;
      if (tempSessionId) {
        console.error(error);
        toast('Failed to delete — ' + humanError(error.message));
        return;
      }
      var errCode = error && error.code;
      var errMsg = (error && error.message) || '';
      if (errCode !== 'PGRST202' && !/function|not found|rpc/i.test(String(errMsg))) {
        console.error(error);
        toast('Failed to delete — ' + humanError(error.message));
        return;
      }
    } catch (e) {
      if (tempSessionId) {
        console.error(e);
        toast('Failed to delete — ' + humanError(e.message));
        return;
      }
    }
  }
  if (!currentUser) {
    toast('Sign in to delete.');
    return;
  }
  try {
    const { data: row, error: selErr } = await sb
      .from(OBJECTS_TABLE)
      .select('id, created_at, text, channel, user_id, author_name')
      .eq('id', numId)
      .maybeSingle();
    if (selErr) {
      console.error(selErr);
      toast('Failed to delete — ' + humanError(selErr.message));
      return;
    }
    if (!row) {
      toast('Could not find that object.');
      return;
    }
    const { error: delErr } = await sb.from(OBJECTS_TABLE).delete().eq('id', numId);
    if (delErr) {
      console.error(delErr);
      toast('Failed to delete — ' + humanError(delErr.message));
      return;
    }
    pushUndo({ type: 'delete', entries: [row] });
    logAction('delete', { count: 1, channel: row.channel || ch });
    onDeleteForChannel(String(row.channel || ch), row);
  } catch (e) {
    console.error(e);
    toast('Failed to delete — ' + humanError(e.message));
  }
}

function animateObjectToTab(rowEl, tabEl, onDone) {
  const from = rowEl.getBoundingClientRect();
  const clone = rowEl.cloneNode(true);
  clone.classList.add('obj-fly-clone');
  clone.style.left = from.left + 'px';
  clone.style.top = from.top + 'px';
  clone.style.width = from.width + 'px';
  clone.style.height = from.height + 'px';
  clone.style.transform = 'translate(0,0) scale(1)';
  clone.style.opacity = '1';
  document.body.appendChild(clone);
  rowEl.style.visibility = 'hidden';
  const to = tabEl.getBoundingClientRect();
  const toCenterX = to.left + to.width / 2;
  const toCenterY = to.top + to.height / 2;
  const fromCenterX = from.left + from.width / 2;
  const fromCenterY = from.top + from.height / 2;
  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(0.25)';
      clone.style.opacity = '0';
    });
  });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clone.remove();
    if (typeof onDone === 'function') onDone();
  };
  clone.addEventListener('transitionend', finish);
  setTimeout(finish, 500);
}

async function moveSingleObject(id, targetChannel) {
  if (!id) return false;
  const target = targetChannel != null ? targetChannel : (moveTargetSelect && moveTargetSelect.value);
  if (!target || target === currentChannel) return false;
  if (!sb || !sb.from) return false;

  function finishMoveUi() {
    const el = feedInner && feedInner.querySelector('.obj[data-id="' + CSS.escape(String(id)) + '"]');
    if (el) el.remove();
    currentObjectOrder = (currentObjectOrder || []).filter(x => Number(x) !== Number(id));
    saveObjectOrderForCurrentView();
    showEmptyIfNoObjects();
  }

  if (currentUser) {
    try {
      const { data: before, error: selErr } = await sb
        .from(OBJECTS_TABLE)
        .select('id, created_at, text, channel, user_id, author_name')
        .eq('id', id)
        .maybeSingle();
      if (selErr) {
        console.error(selErr);
        toast('Failed to move — ' + humanError(selErr.message));
        return false;
      }
      const now = new Date().toISOString();
      const { data, error } = await sb
        .from(OBJECTS_TABLE)
        .update({ channel: target, created_at: now })
        .eq('user_id', currentUser.id)
        .eq('id', id)
        .select('id');
      if (error) {
        console.error(error);
        toast('Failed to move — ' + humanError(error.message));
        return false;
      }
      if (!data || data.length === 0) {
        toast('Move not allowed — row may be read-only or policy blocks update.');
        return false;
      }
      if (before) {
        pushUndo({ type: 'move', entries: [before] });
        logAction('move', { id: before.id, target });
      }
      finishMoveUi();
      return true;
    } catch (e) {
      console.error(e);
      toast('Failed to move — ' + humanError(e.message));
      return false;
    }
  }

  if (tempSessionId && sb.rpc) {
    try {
      const rpcPayload = {
        p_channel: currentChannel,
        p_entry_id: id,
        p_action: 'move',
        p_payload: { target_channel: target },
        p_temp_session_id: tempSessionId,
      };
      const { error } = await sb.rpc('perform_entry_action', rpcPayload);
      if (error) {
        toast('Failed to move — ' + humanError(error.message));
        return false;
      }
      finishMoveUi();
      return true;
    } catch (e) {
      console.error(e);
      toast('Failed to move — ' + humanError(e.message));
      return false;
    }
  }
  return false;
}

async function exportSingleObject(id) {
  if (!currentUser || !id) return;
  try {
    const { data, error } = await sb
      .from('entries')
      .select('created_at,text,channel,user_id,author_name')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error(error);
      toast('Failed to export — ' + humanError(error.message));
      return;
    }
    if (!data) {
      toast('Nothing to export.');
      return;
    }
    const d = new Date(data.created_at);
    const timeStr = d.toLocaleString();
    var line;
    if (data.channel === 'main') {
      line = '[' + timeStr + '] ' + data.text;
    } else {
      const author = data.author_name
        ? String(data.author_name)
        : (data.user_id ? String(data.user_id) : 'unknown');
      line = '[' + timeStr + '] ' + author + ': ' + data.text;
    }
    const blob = new Blob([line + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = data.channel === 'main' ? 'feed' : data.channel;
    a.download = 'inout-' + name + '-msg-' + id + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    toast('Failed to export — ' + humanError(e.message));
  }
}

async function exportSingleObjectJson(id) {
  if (!currentUser || !id) return;
  try {
    const { data, error } = await sb
      .from('entries')
      .select('created_at,text,channel,user_id,author_name')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error(error);
      toast('Failed to export — ' + humanError(error.message));
      return;
    }
    if (!data) {
      toast('Nothing to export.');
      return;
    }
    const exportObj = {
      id: id,
      created_at: data.created_at,
      channel: data.channel,
      text: data.text,
      user_id: data.user_id,
      author_name: data.author_name,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = data.channel === 'main' ? 'feed' : data.channel;
    a.download = 'inout-' + name + '-msg-' + id + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    toast('Failed to export — ' + humanError(e.message));
  }
}

if (exportTabBtn) {
  exportTabBtn.addEventListener('click', async () => {
    if (!currentUser) {
      toast('Sign in to export.');
      return;
    }
    try {
      const boxes = feedInner.querySelectorAll('.obj-select:checked');
      let orderedIds = [];
      if (boxes.length) {
        const selectedIds = new Set(
          Array.from(boxes)
            .map(b => { const row = b.closest('.obj'); return row && row.dataset.id ? Number(row.dataset.id) : null; })
            .filter(id => typeof id === 'number')
        );
        // Order as presented in the feed (DOM order).
        orderedIds = Array.from(feedInner.querySelectorAll('.obj'))
          .map(row => row.dataset.id ? Number(row.dataset.id) : null)
          .filter(id => Number.isFinite(id) && selectedIds.has(id));
      } else {
        // Whole tab: use current view order (currentObjectOrder), or DOM order if empty.
        orderedIds = currentObjectOrder.length
          ? currentObjectOrder.slice()
          : Array.from(feedInner.querySelectorAll('.obj'))
              .map(row => row.dataset.id ? Number(row.dataset.id) : null)
              .filter(id => Number.isFinite(id));
      }

      let query = sb
        .from(OBJECTS_TABLE)
        .select('id,created_at,text,channel,user_id,author_name')
        .limit(1000);

      if (orderedIds.length) {
        query = query.in('id', orderedIds);
      } else {
        query = query.eq('channel', currentChannel);
        if (currentChannel === 'main') {
          query = query.eq('user_id', currentUser.id);
        }
      }

      const { data, error } = await query;
      if (error) {
        console.error(error);
        toast('Failed to export — ' + humanError(error.message));
        return;
      }

      const rows = data || [];
      if (!rows.length) {
        toast('Nothing to export.');
        return;
      }

      // Sort by current view order (orderedIds); append any extra at end.
      const byId = new Map(rows.map(r => [r.id, r]));
      const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
      byId.forEach((row, id) => { if (!orderedIds.includes(id)) ordered.push(row); });
      const finalRows = ordered;

      const lines = finalRows.map(row => {
        const d = new Date(row.created_at);
        const timeStr = d.toLocaleString();
        if (row.channel === 'main') {
          return '[' + timeStr + '] ' + row.text;
        }
        const author = row.author_name
          ? String(row.author_name)
          : (row.user_id ? String(row.user_id) : 'unknown');
        return '[' + timeStr + '] ' + author + ': ' + row.text;
      });
      const content = lines.join('\n');
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = currentChannel === 'main' ? 'feed' : currentChannel;
      a.href = url;
      a.download = 'inout-' + name + '.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      toast('Failed to export — ' + humanError(e.message));
    }
  });
}

if (exportJsonTabBtn) {
  exportJsonTabBtn.addEventListener('click', async () => {
    if (!currentUser) {
      toast('Sign in to export.');
      return;
    }
    try {
      const boxes = feedInner.querySelectorAll('.obj-select:checked');
      let orderedIds = [];
      if (boxes.length) {
        const selectedIds = new Set(
          Array.from(boxes)
            .map(b => { const row = b.closest('.obj'); return row && row.dataset.id ? Number(row.dataset.id) : null; })
            .filter(id => typeof id === 'number')
        );
        orderedIds = Array.from(feedInner.querySelectorAll('.obj'))
          .map(row => row.dataset.id ? Number(row.dataset.id) : null)
          .filter(id => Number.isFinite(id) && selectedIds.has(id));
      } else {
        orderedIds = currentObjectOrder.length
          ? currentObjectOrder.slice()
          : Array.from(feedInner.querySelectorAll('.obj'))
              .map(row => row.dataset.id ? Number(row.dataset.id) : null)
              .filter(id => Number.isFinite(id));
      }
      let query = sb
        .from(OBJECTS_TABLE)
        .select('id,created_at,text,channel,user_id,author_name')
        .limit(1000);
      if (orderedIds.length) {
        query = query.in('id', orderedIds);
      } else {
        query = query.eq('channel', currentChannel);
        if (currentChannel === 'main') {
          query = query.eq('user_id', currentUser.id);
        }
      }
      const { data, error } = await query;
      if (error) {
        console.error(error);
        toast('Failed to export — ' + humanError(error.message));
        return;
      }
      const rows = data || [];
      if (!rows.length) {
        toast('Nothing to export.');
        return;
      }
      const byId = new Map(rows.map(r => [r.id, r]));
      const ordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
      byId.forEach((row, id) => { if (!orderedIds.includes(id)) ordered.push(row); });
      const exportBundle = {
        version: 1,
        channel: currentChannel,
        exportedAt: new Date().toISOString(),
        entries: ordered,
      };
      const blob = new Blob([JSON.stringify(exportBundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = currentChannel === 'main' ? 'feed' : currentChannel;
      a.href = url;
      a.download = 'inout-' + name + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      toast('Failed to export — ' + humanError(e.message));
    }
  });
}

if (importTextTabBtn && importTextFileInput) {
  importTextTabBtn.addEventListener('click', () => {
    try { importTextFileInput.click(); } catch (_) {}
  });
  importTextFileInput.addEventListener('change', function() {
    var f = this.files && this.files[0];
    try { this.value = ''; } catch (_) {}
    if (!f) return;
    if (!isTextLikeFile(f)) {
      toast('Choose a .txt or plain text file.');
      return;
    }
    readFileAsText(f)
      .then(function(t) { return importPlainTextLinesAsObjects(t); })
      .catch(function(err) {
        console.error(err);
        toast('Could not read file.');
      });
  });
}

if (addMembersBtn) {
  addMembersBtn.addEventListener('click', () => {
    openAddMembersModal();
  });
}

function autoResize(el) {
  const target = (el && el.nodeType === 1) ? el : input;
  if (!target) return;
  target.style.height = 'auto';
  target.style.height = Math.min(target.scrollHeight, 160) + 'px';
}

/* ═══ SCROLL ══════════════════════════════════════════════ */
var scrollSaveTimer = null;

/**
 * Desktop / trackpad: forward wheel to the correct .feed when the hit target isn’t scrolling (chrome,
 * gaps, or broken flex scrollport). Listener on #multiview (covers full column) in capture phase.
 */
function bindMultiviewWheelScrollCapture() {
  if (!window.InoutScroll || !window.InoutScroll.bindMultiviewWheelScrollCapture) return;
  window.InoutScroll.bindMultiviewWheelScrollCapture({
    getFeedScrollSurface: getFeedScrollSurface,
  });
}

function scheduleScrollPersistIfAllowed() {
  if (Date.now() < suppressScrollWorkspacePersistUntil) return;
  if (!canSyncPersonalWorkspaceNow()) return;
  schedulePersonalWorkspacePersist();
}

/** Track scroll in viewScroll + localStorage; workspace server payload no longer includes scroll (per-device only). */
function bindFeedScrollWorkspaceSync(scrollEl, channelKeyOrFn, isPrimaryFeed) {
  if (!scrollEl) return;
  var stack = scrollEl.closest && scrollEl.closest('.visual-feed-stack');
  function onScroll(ev) {
    var surf = getFeedScrollSurface(scrollEl);
    var t = ev && ev.currentTarget;
    if (t && t !== surf) return;
    if (!surf) return;
    const ch =
      typeof channelKeyOrFn === 'function' ? String(channelKeyOrFn() || 'main') : String(channelKeyOrFn);
    viewScroll.set(ch, surf.scrollTop);
    if (isPrimaryFeed) {
      atBottom = isNearBottom();
      if (atBottom && scrollBtn) scrollBtn.classList.remove('visible');
      if (document.body.classList.contains('dnd-active')) updateOriginLinePosition();
    }
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveScrollState, 75);
    scheduleScrollPersistIfAllowed();
  }
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  if (stack && stack !== scrollEl) stack.addEventListener('scroll', onScroll, { passive: true });
}

if (feedEl) {
  bindFeedScrollWorkspaceSync(
    feedEl,
    function() {
      return currentView;
    },
    true
  );
}
bindMultiviewWheelScrollCapture();

/* Single feed-level DnD: only the feed handles dragover/drop so drop always fires reliably */
var feedDragoverRaf = null;
var feedDragoverLast = null;
var lastDragClientX = null;
var lastDragClientY = null;
var lastIndicatorStyle = { left: -1, width: -1, top: -1, visible: false };
var lastDragTargetRow = null;
var dragSpiritEl = null;
function processFeedDragover(ev) {
  const rail = document.getElementById('view-pinned-rail');
  if (rail && typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
    const railRect = rail.getBoundingClientRect();
    if (ev.clientX >= railRect.left && ev.clientX <= railRect.right && ev.clientY >= railRect.top && ev.clientY <= railRect.bottom) {
      if (feedInner && (feedInner.querySelector('.obj.dragging') || originGhostsActive)) {
        lastReorderTarget = { pinToEdge: true };
        if (lastDragTargetRow && lastDragTargetRow.classList) {
          lastDragTargetRow.classList.remove('obj-drag-target', 'obj-drag-nudge-right');
          lastDragTargetRow = null;
        }
      }
      return;
    }
  }
  if (lastReorderTarget && lastReorderTarget.pinToEdge) lastReorderTarget = null;
  let localFeedEl = null;
  if (ev.currentTarget && ev.currentTarget.classList && ev.currentTarget.classList.contains('feed')) {
    localFeedEl = ev.currentTarget;
  } else if (ev.target && ev.target.closest) {
    localFeedEl = ev.target.closest('.feed');
  }
  if (!localFeedEl && typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
    const elAtPoint = document.elementFromPoint(ev.clientX, ev.clientY);
    if (elAtPoint && elAtPoint.closest) localFeedEl = elAtPoint.closest('.feed');
  }
  if (!localFeedEl) localFeedEl = feedEl;
  const localFeedInner = localFeedEl ? localFeedEl.querySelector('.feed-inner') : null;
  if (!localFeedEl || !localFeedInner) return;
  if (typeof ev.clientX === 'number') lastDragClientX = ev.clientX;
  if (typeof ev.clientY === 'number') lastDragClientY = ev.clientY;
  if (dragSpiritEl) {
    var fr = localFeedEl.getBoundingClientRect();
    var margin = 24;
    var spiritTop = Math.max(fr.top + margin, Math.min(fr.bottom - margin, ev.clientY));
    dragSpiritEl.style.left = (fr.left + fr.width / 2) + 'px';
    dragSpiritEl.style.top = spiritTop + 'px';
  }
  if (originGhostsActive) {
    var slotRows = Array.from(localFeedInner.children).filter(function(n) { return n.classList && (n.classList.contains('obj') || n.classList.contains('obj-origin-ghost')); });
    if (!slotRows.length) return;
    var slotFirstRow = slotRows[0];
    var slotContentLeft = slotFirstRow.querySelector('.obj-time') || slotFirstRow.querySelector('.obj-sender') || slotFirstRow.querySelector('.obj-text');
    if (slotContentLeft && ev.clientX < slotContentLeft.getBoundingClientRect().left) return;
    var slotY = ev.clientY;
    var slotFirstRect = slotFirstRow.getBoundingClientRect();
    var slotLastRow = slotRows[slotRows.length - 1];
    var slotLastRect = slotLastRow.getBoundingClientRect();
    var slotFeedRect = localFeedEl.getBoundingClientRect();
    var slotMidYs = slotRows.map(function(r) {
      var rect = r.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    var slotWantAppend = false;
    var slotInsertBeforeNode = null;
    var slotLineY = 0;
    if (slotY < slotMidYs[0]) {
      slotInsertBeforeNode = slotFirstRow;
      slotLineY = slotFirstRect.top;
    } else if (slotY >= slotMidYs[slotMidYs.length - 1]) {
      slotWantAppend = true;
      slotLineY = slotLastRect.bottom;
    } else {
      for (var i = 0; i < slotRows.length - 1; i++) {
        if (slotY >= slotMidYs[i] && slotY < slotMidYs[i + 1]) {
          var rect = slotRows[i].getBoundingClientRect();
          slotInsertBeforeNode = slotRows[i].nextElementSibling || slotRows[i].nextSibling;
            slotLineY = rect.bottom;
            break;
          }
      }
      if (slotInsertBeforeNode === null && !slotWantAppend) {
        slotInsertBeforeNode = slotFirstRow;
        slotLineY = slotFirstRect.top;
      }
    }
    if (dndOriginLineY != null && Math.abs(slotLineY - dndOriginLineY) < 14) {
      slotInsertBeforeNode = dndOriginInsertBefore;
      slotWantAppend = dndOriginWantAppend;
      slotLineY = dndOriginLineY;
    }
    lastDropInsertBefore = slotWantAppend ? null : slotInsertBeforeNode;
    lastWantAppend = slotWantAppend;
    var slotTargetRow = slotWantAppend ? slotLastRow : slotInsertBeforeNode;
    if (slotTargetRow !== lastDragTargetRow) {
      if (lastDragTargetRow && lastDragTargetRow.classList) lastDragTargetRow.classList.remove('obj-drag-target', 'obj-drag-nudge-right');
      if (slotTargetRow && slotTargetRow.classList && slotTargetRow.classList.contains('obj')) slotTargetRow.classList.add('obj-drag-target', 'obj-drag-nudge-right');
      lastDragTargetRow = slotTargetRow;
    }
    lastReorderTarget = { insertBefore: slotInsertBeforeNode, wantAppend: slotWantAppend };
    var indLeft = slotFeedRect.left;
    var indWidth = slotFeedRect.width;
    var indTop = slotLineY < slotFeedRect.top ? slotFeedRect.top - 2 : (slotLineY > slotFeedRect.bottom ? slotFeedRect.bottom - 2 : slotLineY - 2);
    // local drop indicator visuals removed
    updateEdgeScroll(ev.clientY, ev.clientX);
    broadcastDndMove();
    return;
  }
  const dragging = localFeedInner.querySelector('.obj.dragging') || (rail && rail.querySelector('.obj.dragging'));
  if (!dragging) return;
  const allRows = Array.from(localFeedInner.querySelectorAll('.obj'));
  const skipSet = new Set(dragSelectedRows && dragSelectedRows.length ? dragSelectedRows : [dragging]);
  const rows = allRows.filter(function(r) { return !skipSet.has(r); });
  if (!rows.length) return;
  const firstRow = rows[0];
  const contentLeft = firstRow.querySelector('.obj-time') || firstRow.querySelector('.obj-sender') || firstRow.querySelector('.obj-text');
  if (contentLeft && ev.clientX < contentLeft.getBoundingClientRect().left) return;
  const y = ev.clientY;
  const firstRect = firstRow.getBoundingClientRect();
  const lastRow = rows[rows.length - 1];
  const lastRect = lastRow.getBoundingClientRect();
  const feedRect = localFeedEl.getBoundingClientRect();
  /* Use only row middle lines as boundaries: drop position changes only when cursor crosses a row's vertical center. */
  const midYs = rows.map(function(r) {
    const rect = r.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
  let wantAppend = false;
  let insertBeforeNode = null;
  let lineY = 0;
  var targetRow = null;
  if (y < midYs[0]) {
    insertBeforeNode = firstRow;
    lineY = firstRect.top;
    targetRow = firstRow;
  } else if (y >= midYs[midYs.length - 1]) {
    wantAppend = true;
    lineY = lastRect.bottom;
    targetRow = lastRow;
  } else {
    for (let i = 0; i < rows.length - 1; i++) {
      if (y >= midYs[i] && y < midYs[i + 1]) {
        insertBeforeNode = rows[i].nextElementSibling || rows[i].nextSibling;
        const rect = rows[i].getBoundingClientRect();
          lineY = rect.bottom;
        targetRow = rows[i + 1];
          break;
        }
    }
    if (insertBeforeNode === null && !wantAppend) {
      insertBeforeNode = firstRow;
      lineY = firstRect.top;
      targetRow = firstRow;
    }
  }
  if (targetRow && !targetRow.classList) targetRow = null;
  if (targetRow !== lastDragTargetRow) {
    if (lastDragTargetRow && lastDragTargetRow.classList) {
      lastDragTargetRow.classList.remove('obj-drag-target', 'obj-drag-nudge-right');
    }
    if (targetRow && targetRow.classList) {
      targetRow.classList.add('obj-drag-target', 'obj-drag-nudge-right');
    }
    lastDragTargetRow = targetRow;
  }
  if (dndOriginLineY != null && (wantAppend || insertBeforeNode !== null) && Math.abs(lineY - dndOriginLineY) < 14) {
    insertBeforeNode = dndOriginInsertBefore;
    wantAppend = dndOriginWantAppend;
    lineY = dndOriginLineY;
  }
  const targetChanged = lastReorderTarget === null || lastReorderTarget.insertBefore !== insertBeforeNode || lastReorderTarget.wantAppend !== wantAppend;
  if ((wantAppend || insertBeforeNode !== null) && targetChanged) {
    lastReorderTarget = { insertBefore: insertBeforeNode, wantAppend: wantAppend };
    /* Do not move DOM during dragover: keeps hover target correct and avoids blink. Reorder applied once on dragend. */
  }
  if (wantAppend || insertBeforeNode !== null) {
    if (!feedDropIndicatorEl) {
      feedDropIndicatorEl = document.createElement('div');
      feedDropIndicatorEl.className = 'feed-drop-indicator';
      document.body.appendChild(feedDropIndicatorEl);
    }
    var indLeft = feedRect.left;
    var indWidth = feedRect.width;
    var indTop;
    if (lineY < feedRect.top) {
      indTop = feedRect.top - 2;
    } else if (lineY > feedRect.bottom) {
      indTop = feedRect.bottom - 2;
    } else {
      indTop = lineY - 2;
    }
    if (lastIndicatorStyle.left !== indLeft || lastIndicatorStyle.width !== indWidth || lastIndicatorStyle.top !== indTop) {
      feedDropIndicatorEl.style.left = indLeft + 'px';
      feedDropIndicatorEl.style.width = indWidth + 'px';
      feedDropIndicatorEl.style.height = '4px';
      feedDropIndicatorEl.style.top = indTop + 'px';
      lastIndicatorStyle.left = indLeft;
      lastIndicatorStyle.width = indWidth;
      lastIndicatorStyle.top = indTop;
    }
    if (!lastIndicatorStyle.visible) {
      feedDropIndicatorEl.classList.add('visible');
      lastIndicatorStyle.visible = true;
    }
    broadcastDndMove();
  } else {
    var inFeed = ev.clientX >= feedRect.left && ev.clientX <= feedRect.right && ev.clientY >= feedRect.top && ev.clientY <= feedRect.bottom;
    if (inFeed) {
      if (feedDropIndicatorEl && lastIndicatorStyle.visible) {
        feedDropIndicatorEl.classList.remove('visible');
        lastIndicatorStyle.visible = false;
      }
      lastReorderTarget = null;
      if (lastDragTargetRow) {
        lastDragTargetRow.classList.remove('obj-drag-target', 'obj-drag-nudge-right');
        lastDragTargetRow = null;
      }
    }
  }
  updateEdgeScroll(ev.clientY, ev.clientX);
}
function onFeedScrollDuringDrag() {
  if (document.body && document.body.classList.contains('dnd-active') && typeof lastDragClientX === 'number' && typeof lastDragClientY === 'number') {
    processFeedDragover({ clientX: lastDragClientX, clientY: lastDragClientY });
  }
}
if (feedEl) {
feedEl.addEventListener('scroll', onFeedScrollDuringDrag, { passive: true });
(function() {
  var stackScroll = feedEl.closest && feedEl.closest('.visual-feed-stack');
  if (stackScroll && stackScroll !== feedEl) stackScroll.addEventListener('scroll', onFeedScrollDuringDrag, { passive: true });
})();
feedEl.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('application/x-inout-draft')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return;
  }
  const railForFeed = document.getElementById('view-pinned-rail');
  const dragging = feedInner ? (feedInner.querySelector('.obj.dragging') || (railForFeed && railForFeed.querySelector('.obj.dragging'))) : null;
  if (!feedInner || (!dragging && !originGhostsActive)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (dragging || originGhostsActive) processFeedDragover(e);
});
feedEl.addEventListener('drop', e => {
  const draftSlotIndex = e.dataTransfer.getData('application/x-inout-draft');
  if (draftSlotIndex !== '' && draftSlotIndex != null) {
    e.preventDefault();
    e.stopPropagation();
    dragDropHandled = true;
    const text = (e.dataTransfer.getData('text/plain') || '').trim();
    const slotIndex = parseInt(draftSlotIndex, 10);
    if (text && Number.isFinite(slotIndex) && inputSlots[slotIndex]) {
      sendText(text, { channel: currentChannel });
      inputSlots[slotIndex].value = '';
      saveInputSlots();
      const slotRow = composerSlotsContainer && composerSlotsContainer.querySelector('[data-slot-index="' + slotIndex + '"]');
      if (slotRow) {
        const ta = slotRow.querySelector('textarea');
        if (ta) ta.value = '';
        slotRow.draggable = false;
        slotRow.classList.remove('composer-slot-draggable');
        const sendB = slotRow.querySelector('.composer-send');
        if (sendB) sendB.disabled = true;
      }
    }
    return;
  }
  const railForDrop = document.getElementById('view-pinned-rail');
  const draggingFromFeedOrRail = feedInner && (feedInner.querySelector('.obj.dragging') || (railForDrop && railForDrop.querySelector('.obj.dragging')) || originGhostsActive);
  if (draggingFromFeedOrRail) {
    e.preventDefault();
    dragDropHandled = true;
    if (feedInner) {
      feedInner.querySelectorAll('.obj-drag-over').forEach(r => r.classList.remove('obj-drag-over'));
      feedInner.querySelectorAll('.obj-drag-target').forEach(r => r.classList.remove('obj-drag-target', 'obj-drag-nudge-right'));
    }
  }
});
feedEl.addEventListener('dragleave', e => {
  if (!e.relatedTarget || !feedEl.contains(e.relatedTarget)) {
    if (feedInner) feedInner.querySelectorAll('.obj-drag-over').forEach(r => r.classList.remove('obj-drag-over'));
  }
});
  const railEl = document.getElementById('view-pinned-rail');
  if (railEl) {
    railEl.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    });
    railEl.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      if (feedInner) {
        feedInner.querySelectorAll('.obj-drag-over').forEach(r => r.classList.remove('obj-drag-over'));
        feedInner.querySelectorAll('.obj-drag-target').forEach(r => r.classList.remove('obj-drag-target', 'obj-drag-nudge-right'));
      }
    });
  }
}

// Value-slot drag: allow drop anywhere we can resolve a target cell under the cursor.
document.addEventListener(
  'dragover',
  function(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types || Array.from(dt.types).indexOf(VALUE_DND_MIME) < 0) return;
    e.preventDefault();
    dt.dropEffect = 'move';
    lastDragClientX = e.clientX;
    lastDragClientY = e.clientY;
    updateValueDnDHoverFromPoint(e.clientX, e.clientY);
  },
  true
);

document.addEventListener(
  'drop',
  function(e) {
    var raw = e.dataTransfer && e.dataTransfer.getData(VALUE_DND_MIME);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    dragDropHandled = true;
    clearValueDnDHoverClass();
    performValueSlotDnDDrop(e, raw).catch(function(err) {
      console.error(err);
      toast('Could not move value.');
    });
  },
  true
);

// Dragover: when over feed, run processFeedDragover (primary reorder). When outside feed, show indicator at top/bottom.
document.addEventListener('dragover', e => {
  if (!feedEl || !feedInner) return;
  const rail = document.getElementById('view-pinned-rail');
  const draggingPrimary = feedInner.querySelector('.obj.dragging') || (rail && rail.querySelector('.obj.dragging'));
  if (!draggingPrimary && !originGhostsActive) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  lastDragClientX = e.clientX;
  lastDragClientY = e.clientY;
  const targetFeed = (e.target && e.target.closest && e.target.closest('.feed')) || feedEl;
  const feedRect = targetFeed.getBoundingClientRect();
  const y = e.clientY;
  const x = e.clientX;
  const inFeed = x >= feedRect.left && x <= feedRect.right && y >= feedRect.top && y <= feedRect.bottom;
  let overRail = false;
  if (rail) {
    const rr = rail.getBoundingClientRect();
    overRail = x >= rr.left && x <= rr.right && y >= rr.top && y <= rr.bottom;
  }
  if (inFeed || overRail) {
    if (draggingPrimary || originGhostsActive) processFeedDragover(e);
    return;
  }
  if (lastDragTargetRow && lastDragTargetRow.classList) {
    lastDragTargetRow.classList.remove('obj-drag-target', 'obj-drag-nudge-right');
    lastDragTargetRow = null;
  }
  const rows = originGhostsActive
    ? Array.from(feedInner.children).filter(function(n) { return n.classList && (n.classList.contains('obj') || n.classList.contains('obj-origin-ghost')); })
    : Array.from(feedInner.querySelectorAll('.obj'));
  if (!rows.length) return;
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  const firstRect = firstRow.getBoundingClientRect();
  const lastRect = lastRow.getBoundingClientRect();

  var lineY = y < feedRect.top ? firstRect.top : lastRect.bottom;
  var indTop = lineY < feedRect.top ? feedRect.top - 2 : (lineY > feedRect.bottom ? feedRect.bottom - 2 : lineY - 2);

  // drop indicator visuals removed
  updateEdgeScroll(e.clientY, e.clientX);
}, { passive: false });

document.addEventListener('drop', e => {
  if (!feedInner) return;
  if (feedInner.querySelector('.obj.dragging') || originGhostsActive) {
    e.preventDefault();
    e.stopPropagation();
    dragDropHandled = true;
    feedInner.querySelectorAll('.obj-drag-over, .obj-drag-target').forEach(function(r) { r.classList.remove('obj-drag-over', 'obj-drag-target', 'obj-drag-nudge-right'); });
  }
}, { passive: false });

function scrollBottom() {
  if (!feedEl) return;
  var surf = primaryFeedScrollSurface();
  if (!surf) return;
  surf.scrollTop = surf.scrollHeight;
  if (scrollBtn) scrollBtn.classList.remove('visible');
  atBottom = true;
}

/* ═══ UTILS ═══════════════════════════════════════════════ */

var formatTimePartsCache = new Map();
var formatTimePartsCacheMax = 200;
function formatTimePartsForDisplay(iso) {
  var key = String(iso);
  var hit = formatTimePartsCache.get(key);
  if (hit !== undefined) return hit;
  const d = new Date(iso);
  var o;
  if (Number.isNaN(d.getTime())) {
    o = { date: '', clock: '' };
  } else {
    o = {
      date: d.toLocaleDateString([], { month: 'short', day: '2-digit' }),
      clock: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
    };
  }
  if (formatTimePartsCache.size >= formatTimePartsCacheMax) {
    var firstK = formatTimePartsCache.keys().next().value;
    if (firstK !== undefined) formatTimePartsCache.delete(firstK);
  }
  formatTimePartsCache.set(key, o);
  return o;
}
function formatTime(iso) {
  var p = formatTimePartsForDisplay(iso);
  if (!p.date && !p.clock) return '';
  return p.date + (p.date && p.clock ? ' ' : '') + p.clock;
}

function escapeHtml(s) {
  return s
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function renderVisualOnlyHtml(input) {
  const src = String(input == null ? '' : input);
  if (!src) return '';
  if (typeof document === 'undefined' || !document.implementation) {
    return escapeHtml(src);
  }
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');
  root.innerHTML = src;
  const allowed = new Set([
    'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SMALL',
    'SUB', 'SUP', 'BR', 'P', 'DIV', 'SPAN',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'CODE', 'PRE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
  ]);

  function sanitizeNode(node) {
    if (!node) return;
    if (node.nodeType === 3) return; // text
    if (node.nodeType !== 1) {
      if (node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    const tag = node.tagName ? node.tagName.toUpperCase() : '';
    if (!allowed.has(tag)) {
      const raw = node.outerHTML || node.textContent || '';
      const asText = doc.createTextNode(raw);
      if (node.parentNode) node.parentNode.replaceChild(asText, node);
      return;
    }
    if (node.attributes && node.attributes.length) {
      Array.from(node.attributes).forEach(function(a) {
        node.removeAttribute(a.name);
      });
    }
    Array.from(node.childNodes).forEach(sanitizeNode);
  }

  Array.from(root.childNodes).forEach(sanitizeNode);
  return root.innerHTML;
}

function toast(msg, dur = 2800) {
  clearTimeout(toastTimer);
  const s = typeof msg === 'string' ? msg : String(msg);
  toastEl.textContent = s;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
  if (s.toLowerCase().includes('failed') || s.toLowerCase().includes('error')) logError(s);
}

(function initFolderSyncBridge() {
  if (typeof INOUT_FOLDER_SYNC === 'undefined' || !INOUT_FOLDER_SYNC) return;
  INOUT_FOLDER_SYNC.wireSecretPanel(function (m) { toast(m); });
  INOUT_FOLDER_SYNC.initRestore().catch(function () {});
})();

function humanError(message) {
  if (!message) return 'Something went wrong.';
  const msg = message.toLowerCase();

  if (msg.includes('row-level security')) {
    return 'Not allowed to send this message (security rules).';
  }

  if (msg.includes('failed to fetch') || msg.includes('network')) {
    return 'Network issue — check your connection.';
  }

  if (msg.includes('invalid jw') || msg.includes('jwt')) {
    return 'Session expired — refresh and sign in again.';
  }

  return message;
}

/* ═══ GO ══════════════════════════════════════════════════ */
function markLoaded() {
  try {
    if (document.body && !document.body.classList.contains('loaded')) document.body.classList.add('loaded');
  } catch (_) {}
}
var loaderMinUntil = 0;
(function go() {
  loaderMinUntil = 0;
  var loadTimeout = setTimeout(markLoaded, 4000);
  function done() {
    clearTimeout(loadTimeout);
    markLoaded();
  }
  function run() {
    try {
      if (typeof init === 'function') {
        init(done);
      } else {
        var t = document.getElementById('tabs');
        if (t && !t.hasChildNodes()) {
          var b = document.createElement('button');
          b.className = 'tab';
          b.setAttribute('data-channel', 'main');
          b.appendChild(document.createElement('span')).textContent = 'Feed';
          t.appendChild(b);
        }
        var fi = document.getElementById('feed-inner');
        var emp = document.getElementById('empty');
        if (fi && emp && !emp.parentNode) fi.appendChild(emp);
        done();
      }
    } catch (err) {
      console.error('startup error', err);
      done();
    }
  }
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function onReady() {
        run();
      });
    } else {
      run();
    }
    document.addEventListener('visibilitychange', function() {
      if (typeof isMobileOrTouchDevice === 'function' && isMobileOrTouchDevice()) return;
      if (document.visibilityState === 'visible' && typeof input !== 'undefined' && input && document.activeElement && document.activeElement !== input && !/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test((document.activeElement.tagName || '').toUpperCase())) {
        setTimeout(function() { if (input && !isMobileOrTouchDevice()) input.focus(); }, 0);
      }
    });
  } catch (err) {
    console.error('startup error', err);
    done();
  }
})();
(function profileButtonFallback(){
  if (!window.sb && window._sb) window.sb = window._sb;
  var btn = document.getElementById('user-btn');
  var back = document.getElementById('user-modal-backdrop');
  var channelBack = document.getElementById('channel-modal-backdrop');
  var closeBtn = document.getElementById('user-close');
  function openModal(){
    if (typeof openUserModal === 'function') {
      openUserModal();
      return;
    }
    if (channelBack) channelBack.style.display = 'none';
    if (typeof showUserModalBackdrop === 'function') showUserModalBackdrop();
    else if (back) {
      back.style.display = 'flex';
      back.setAttribute('aria-hidden', 'false');
    }
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        if (typeof refreshStorageUIPanel === 'function') refreshStorageUIPanel();
        if (typeof notifyWorkspaceChromeChanged === 'function') notifyWorkspaceChromeChanged();
      });
    });
  }
  function closeModal(){
    if (typeof closeUserModal === 'function') {
      closeUserModal();
      return;
    }
    if (typeof hideUserModalBackdrop === 'function') hideUserModalBackdrop();
    else if (back) {
      back.style.display = 'none';
      back.setAttribute('aria-hidden', 'true');
    }
    if (typeof notifyWorkspaceChromeChanged === 'function') notifyWorkspaceChromeChanged();
  }
  if (btn) btn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if(back){
    back.onclick = function(e){ if(e.target===back) closeModal(); };
    back.addEventListener('click', function(e){
      var t = e.target;
      if(t && t.closest && t.closest('#um-auth-btn')){
        e.preventDefault();
        e.stopPropagation();
        if(window.signIn && typeof window.signIn === 'function'){ window.signIn(); return; }
        if(window.sb && window.sb.auth && typeof window.sb.auth.signInWithOAuth === 'function'){
          var redirectTo = window.location.origin ? window.location.origin + '/' : undefined;
          window.sb.auth.signInWithOAuth({ provider: 'google', options: redirectTo ? { redirectTo: redirectTo } : {} }).then(function(r){
            if(r && r.data && r.data.url) window.location.href = r.data.url;
          }).catch(function(){});
        }
      }
    }, true);
  }
})();
