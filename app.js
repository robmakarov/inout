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
(function(){ var b=document.getElementById('user-btn'); if(b)b.addEventListener('click',function(){ var m=document.getElementById('user-modal-backdrop'); if(m){ m.style.display='block'; m.setAttribute('aria-hidden','false'); } var c=document.getElementById('channel-modal-backdrop'); if(c)c.style.display='none'; }); var x=document.getElementById('user-close'); if(x)x.addEventListener('click',function(){ var m=document.getElementById('user-modal-backdrop'); if(m){ m.style.display='none'; m.setAttribute('aria-hidden','true'); } }); var m=document.getElementById('user-modal-backdrop'); if(m)m.addEventListener('click',function(e){ if(e.target===m){ m.style.display='none'; m.setAttribute('aria-hidden','true'); } }); })();
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
      }
    });
    if (typeof window !== 'undefined') window.sb = sb;
  }
} catch(e) {}

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
  let current = 0;
  let pending = 0;
  const readTop = () => Math.max(0, Math.round((typeof vv.offsetTop === 'number') ? vv.offsetTop : 0));
  const apply = () => {
    raf = 0;
    const next = pending;
    if (Math.abs(next - current) < 2) return;
    current = next;
    document.documentElement.style.setProperty('--vv-top', current + 'px');
  };
  const schedule = () => { pending = readTop(); if (!raf) raf = requestAnimationFrame(apply); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  schedule();
})();

const feedInner  = document.getElementById('feed-inner');
const feedEl     = document.getElementById('feed');
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
const umUserId     = document.getElementById('um-user-id');
const umCopyIdBtn  = document.getElementById('um-copy-id');
const umShowQrBtn  = document.getElementById('um-show-qr');
const umExportLocalBtn = document.getElementById('um-export-local');
const umClearLocalBtn  = document.getElementById('um-clear-local');
const qrModalBackdrop = document.getElementById('qr-modal-backdrop');
const qrModalImg   = document.getElementById('qr-modal-img');
const qrModalClose = document.getElementById('qr-modal-close');
const umNickname   = document.getElementById('um-nickname');
const umNickSave   = document.getElementById('um-nick-save');
const umSyncInputChk = document.getElementById('um-sync-input');
const umVersionBadge = document.getElementById('um-version-badge');
const umUpgradeBtn   = document.getElementById('um-upgrade-btn');
const tabsEl     = document.getElementById('tabs');
const viewsCloseAllBtn = document.getElementById('views-close-all');
const clipboardBubble    = document.getElementById('clipboard-bubble');
const clipboardBubbleTxt = document.getElementById('clipboard-bubble-text');
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
const fieldTimeChk   = document.getElementById('field-time');
const fieldAuthorChk = document.getElementById('field-author');
const viewVisualSelect = document.getElementById('view-visual');
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

(function ensureModalsClosedOnLoad() {
  if (umBackdrop) { umBackdrop.style.display = 'none'; umBackdrop.setAttribute('aria-hidden', 'true'); }
  if (cmBackdrop) cmBackdrop.style.display = 'none';
  if (logDropupPanel) logDropupPanel.classList.remove('open');
  if (qrModalBackdrop) qrModalBackdrop.setAttribute('aria-hidden', 'true');
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
      try {
        const key = getLocalObjectsKey();
        const raw = localStorage.getItem(key) || '{}';
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
    });
  }

  if (umClearLocalBtn) {
    umClearLocalBtn.addEventListener('click', () => {
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

        // 3) Clear all local/session storage for this origin
        try { localStorage.clear(); } catch (_) {}
        try { sessionStorage.clear(); } catch (_) {}

        // 4) Clear current UI
        clearObjects();
        if (emptyEl && !emptyEl.parentNode && feedInner) feedInner.appendChild(emptyEl);
        toast('All local data and shell cleared. Reloading…');

        // 5) Reload page to pick up a clean state
        setTimeout(() => {
          if (typeof location !== 'undefined' && location.reload) location.reload();
        }, 600);
      } catch (e) {
        console.error(e);
        toast('Failed to clear local data.');
      }
    });
  }
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
      } catch (err) {
        console.error(err);
        toast('Failed to create visit QR.');
      }
    });
  }

  const closeQrModal = () => {
    stopPolling();
    qrModalBackdrop.setAttribute('aria-hidden', 'true');
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
  function openUserModalEarly() {
    var back = document.getElementById('user-modal-backdrop');
    if (!back) return;
    var cm = document.getElementById('channel-modal-backdrop');
    if (cm) cm.style.display = 'none';
    back.style.display = 'block';
    back.setAttribute('aria-hidden', 'false');
  }
  function closeUserModalEarly() {
    var back = document.getElementById('user-modal-backdrop');
    if (!back) return;
    back.style.display = 'none';
    back.setAttribute('aria-hidden', 'true');
  }
  var btn = document.getElementById('user-btn');
  if (btn) btn.addEventListener('click', openUserModalEarly);
  var closeBtn = document.getElementById('user-close');
  if (closeBtn) closeBtn.addEventListener('click', closeUserModalEarly);
  var back = document.getElementById('user-modal-backdrop');
  if (back) back.addEventListener('click', function(e) { if (e.target === back) closeUserModalEarly(); });
})();

// Supabase table name for stored objects (was 'entries').
const OBJECTS_TABLE        = 'entries';
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
let myId;
try { myId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); } catch (_) { myId = 'fallback-' + Date.now(); }
let currentUser    = null;
let currentView    = 'main';
let currentChannel = currentView; // temporary alias while migrating off "channel"
let viewNames      = ['main'];
let secondaryViewName = null; /* legacy; will be removed when views[] fully replaces secondary. Persisted to device (localStorage). */
let secondaryViewChannel = null; // temporary alias during migration
const VIEWS_KEY           = 'inout_views_v1';
const LEFT_VIEWS_KEY      = 'inout_left_views_v1';
const CURRENT_VIEW_KEY    = 'inout_current_view_v1';
const SECONDARY_VIEW_KEY  = 'inout_secondary_view_name_v1';
const MULTIVIEW_SPLIT_KEY = 'inout_multiview_split_v1';
const INPUT_STATE_KEY      = 'inout_input_state_v2';
const INPUT_SLOTS_KEY      = 'inout_input_slots_v1';
const SYNC_INPUT_PREF_KEY  = 'inout_sync_input_v1';
const FIELD_PREFS_KEY      = 'inout_field_prefs_v1';
const ORDER_STATE_KEY      = 'inout_order_state_v1';
const SCROLL_STATE_KEY     = 'inout_scroll_state_v1';
const WAS_EDITING_KEY      = 'inout_was_editing_v1';
const AUTH_BACKUP_KEY     = 'inout_auth_user_backup';
let suppressAutoAuth      = false; // when true, never auto-log user back in this tab
const seenIds       = new Set();
const viewScroll = new Map();
const OPEN_VIEWS_KEY     = 'inout_open_views_v1';

function getLocalObjectsKey() {
  if (currentUser && currentUser.id) {
    return LOCAL_USER_OBJECTS_KEY_PREFIX + String(currentUser.id);
  }
  return LOCAL_ANON_OBJECTS_KEY;
}

function loadLocalObjects() {
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

function saveLocalObjects(objByView) {
  try {
    const key = getLocalObjectsKey();
    localStorage.setItem(key, JSON.stringify(objByView || {}));
  } catch (_) {}
}

function upsertLocalObjectForCurrentView(obj) {
  if (!obj || typeof obj.id === 'undefined') return;
  const byView = loadLocalObjects();
  const key = currentView || 'main';
  const list = Array.isArray(byView[key]) ? byView[key] : [];
  const idx = list.findIndex(o => o && o.id === obj.id);
  if (idx >= 0) list[idx] = obj; else list.push(obj);
  byView[key] = list;
  saveLocalObjects(byView);
}

async function loadLocalObjectsForCurrentView() {
  try {
    const byView = loadLocalObjects();
    const key = currentView || 'main';
    let list = Array.isArray(byView[key]) ? byView[key] : [];

    // Apply saved order (same mechanism as cloud, but using anon/user key)
    try {
      const raw = localStorage.getItem(ORDER_STATE_KEY);
      if (raw) {
        const map = JSON.parse(raw);
        if (map && typeof map === 'object') {
          const orderKey = currentUser && currentUser.id
            ? (currentUser.id + '::' + key)
            : ('anon::' + key);
          const arr = Array.isArray(map[orderKey]) ? map[orderKey] : [];
          if (arr.length) list = sortObjectsByOrder(list, arr);
        }
      }
    } catch (_) {}

    await replaceFeedWithList(list);
  } catch (_) {
    // ignore local load errors; show empty state
  }
}

function removeLocalObjectsForCurrentView(ids) {
  if (!ids || !ids.length) return;
  const byView = loadLocalObjects();
  const key = currentView || 'main';
  let list = Array.isArray(byView[key]) ? byView[key] : [];
  const set = new Set(ids);
  list = list.filter(o => !o || typeof o.id === 'undefined' ? false : !set.has(o.id));
  byView[key] = list;
  saveLocalObjects(byView);
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
let orderSub = null;
let viewSub  = null;
let draftChannel = null;
let latestRemoteDraft = '';
let latestClipboardText = '';
let inputStateSub = null;
let inputSaveToDbTimer = null;
let inputSlotsSaveToDbTimer = null;
const INPUT_SAVE_DEBOUNCE_MS = 150;
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

function loadInputSlots() {
  if (inputSlots.length > 0) return;
  try {
    const raw = localStorage.getItem(INPUT_SLOTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        inputSlots = parsed.map(normalizeSlot).filter(Boolean);
        if (inputSlots.length > 0) return;
      }
    }
  } catch (_) {}
  inputSlots = [{ id: 'slot-0', channel: (typeof currentChannel !== 'undefined' ? currentChannel : 'main'), value: '' }];
}
function normalizeSlot(s) {
  if (!s || typeof s !== 'object') return null;
  var id = s.id != null ? String(s.id) : 'slot-' + Date.now();
  var ch = s.channel != null ? String(s.channel) : 'main';
  var val = s.value != null ? String(s.value) : '';
  return { id: id, channel: ch, value: capSyncText(val) };
}

function saveInputSlots() {
  try {
    localStorage.setItem(INPUT_SLOTS_KEY, JSON.stringify(inputSlots));
    if (getSyncInputPref()) scheduleSaveSlotsToDb();
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
    const labelEl = document.createElement('span');
    labelEl.className = 'composer-slot-label';
    labelEl.setAttribute('aria-hidden', 'true');
    labelEl.textContent = 'To: ' + targetLabel;
    inputWrap.appendChild(labelEl);
    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Add object…';
    textarea.rows = 1;
    textarea.maxLength = 2000;
    textarea.autocomplete = 'off';
    textarea.spellcheck = true;
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
      const lbl = inputWrap.querySelector('.composer-slot-label');
      if (lbl) lbl.textContent = 'To: ' + (ch === 'main' ? 'Feed' : ch);
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
        if (sendBtn) sendBtn.disabled = !val.trim();
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
      textarea.value = '';
      inputSlots[index].value = '';
      saveInputSlots();
      if (typeof autoResize === 'function') autoResize(isPrimary ? input : textarea);
      const sBtn = row.querySelector('.composer-send');
      if (sBtn) sBtn.disabled = true;
      clearBtn.disabled = true;
      if (isPrimary) {
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
  _inputListenersAttached = false;
  attachInputListeners();
}

async function sendFromSlot(index) {
  loadInputSlots();
  const slot = inputSlots[index];
  if (!slot) return;
  const text = (slot.value || '').trim();
  if (!text) return;
  const slotRow = composerSlotsContainer && composerSlotsContainer.querySelector('[data-slot-index="' + String(index) + '"]');
  const textarea = slotRow ? slotRow.querySelector('textarea') : null;
  const sendBtnEl = slotRow ? slotRow.querySelector('.composer-send') : null;
  if (textarea) textarea.disabled = true;
  if (sendBtnEl) sendBtnEl.disabled = true;
  await sendText(text, { channel: slot.channel });
  if (textarea) textarea.disabled = false;
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
const selectedIds = new Set();
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
  if (!feedEl) return false;
  var feedRect = feedEl.getBoundingClientRect();
  var edgeZone = Math.max(56, feedRect.height * 0.2);
  var baseStep = 6;
  var maxScroll = feedEl.scrollHeight - feedEl.clientHeight;
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
    feedEl.scrollTop = Math.max(0, feedEl.scrollTop - step);
    return true;
  }
  if (inBottom) {
    if (clientY >= feedRect.bottom) closeness = 1;
    else closeness = 1 - (feedRect.bottom - clientY) / edgeZone;
    step = baseStep * (0.5 + 2.5 * Math.min(1, closeness));
    if (maxScroll > 0) feedEl.scrollTop = Math.min(maxScroll, feedEl.scrollTop + step);
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
  const feedRect = feedEl.getBoundingClientRect();
  const scrollTop = feedEl.scrollTop;
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
      modeState.selectedIds.add(id);
      r.classList.add('obj-selected');
    } else {
      selectedIds.delete(id);
      modeState.selectedIds.delete(id);
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
        modeState.selectedIds.add(id);
        r.classList.add('obj-selected');
      } else {
        selectedIds.delete(id);
        modeState.selectedIds.delete(id);
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
let fieldPrefs = { showTime:true, showAuthor:true, viewMode:'feed' };
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
  if (currentUser) {
    try {
      sb.from('action_log').insert({
        id: entry.id,
        user_id: currentUser.id,
        device_id: myId,
        type: 'error',
        action: 'error',
        details: {},
        message: entry.message,
      }).then(() => {}).catch(() => {});
    } catch (_) {}
  }
}

function updateLogBadge() {
  if (!logActionBtn) return;
  const last = actionLog[0];
  const isError = last && last.type === 'error';
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

function openLogDropup() {
  if (!logDropupPanel) return;
  renderLogDropup();
  logDropupPanel.classList.add('open');
  console.debug('[inout] Action log opened');
}

function closeLogDropup() {
  if (!logDropupPanel) return;
  logDropupPanel.classList.remove('open');
}

function pushUndo(action) {
  if (!action) return;
  undoStack.push(action);
  if (undoStack.length > 50) undoStack.shift();
}

async function undoLastAction() {
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
      toast('Undid last action.');
      return;
    } else if (action.type === 'view' && action.before && action.channel) {
      if (action.channel !== currentChannel) {
        currentChannel = action.channel;
      }
      fieldPrefs = {
        showTime: !!action.before.showTime,
        showAuthor: !!action.before.showAuthor,
        viewMode: (action.before.viewMode === 'table' || action.before.viewMode === 'feed') ? action.before.viewMode : 'feed',
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
    }
    autoResize();
    sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
  }
  updateEditingRowHighlight();
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

function getDraggingRowAndSource() {
  const fromPrimary = feedInner && feedInner.querySelector('.obj.dragging');
  if (fromPrimary) return { row: fromPrimary, feedInner: feedInner, channel: currentChannel };
  const fromSecondary = secondaryFeedInner && secondaryFeedInner.querySelector('.obj.dragging');
  if (fromSecondary) return { row: fromSecondary, feedInner: secondaryFeedInner, channel: secondaryViewChannel };
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
      _inputListenersAttached = false;
      attachInputListeners();
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
  if (!feedEl || !feedInner || !feedDropOriginEl || typeof originContentTop !== 'number' || typeof originContentHeight !== 'number') return;
  var feedRect = feedEl.getBoundingClientRect();
  var scrollTop = feedEl.scrollTop;
  var feedHeight = feedRect.height;
  var topPx, heightPx;
  if (originContentTop < scrollTop) {
    feedDropOriginEl.classList.add('stuck');
    topPx = feedRect.top;
    heightPx = 2;
  } else if (originContentTop + originContentHeight > scrollTop + feedHeight) {
    feedDropOriginEl.classList.add('stuck');
    topPx = feedRect.bottom - 2;
    heightPx = 2;
  } else {
    feedDropOriginEl.classList.remove('stuck');
    topPx = feedRect.top + (originContentTop - scrollTop);
    heightPx = 2;
  }
  feedDropOriginEl.style.left = feedRect.left + 'px';
  feedDropOriginEl.style.width = feedRect.width + 'px';
  feedDropOriginEl.style.top = topPx + 'px';
  feedDropOriginEl.style.height = heightPx + 'px';
  feedDropOriginEl.classList.add('visible');
}
function showDropOriginLine() {}
function hideDropOriginLine() { originContentTop = null; originContentHeight = null; }
function showOriginGhostOverlay(block) {}
function removeOriginGhostOverlay() { originGhostOverlayEl = null; }
function createOriginGhostFromRow(row) { return row; }
function insertOriginGhostsAndDetachRows(block) {
  if (!feedInner || !block || block.length === 0) return;
  originInsertBefore = block[block.length - 1].nextSibling;
  var ghosts = [];
  for (var i = 0; i < block.length; i++) ghosts.push(createOriginGhostFromRow(block[i]));
  for (var j = 0; j < block.length; j++) feedInner.insertBefore(ghosts[j], block[j]);
  for (var k = block.length - 1; k >= 0; k--) block[k].parentNode && block[k].parentNode.removeChild(block[k]);
  originGhostRows = ghosts;
  draggedRowsStored = block.slice();
  originGhostsActive = true;
  lastDropInsertBefore = ghosts[0];
  lastWantAppend = false;
  if (ghosts.length && ghosts[0].offsetTop !== undefined) {
    originContentTop = ghosts[0].offsetTop;
    var lastG = ghosts[ghosts.length - 1];
    originContentHeight = (lastG.offsetTop || 0) + (lastG.offsetHeight || 0) - originContentTop;
    if (originContentHeight < 2) originContentHeight = 2;
    if (!feedDropOriginEl) {
      feedDropOriginEl = document.createElement('div');
      feedDropOriginEl.className = 'feed-drop-origin';
      feedDropOriginEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(feedDropOriginEl);
    }
    if (feedDropOriginEl.parentNode !== document.body) document.body.appendChild(feedDropOriginEl);
    updateOriginLinePosition();
  }
}
function removeOriginGhostsAndInsertRows() {
  if (!originGhostsActive || !feedInner || !feedEl) return;
  var scrollTop = feedEl.scrollTop;
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
  feedEl.scrollTop = scrollTop;
}
function focusMainInput() {
  if (input) input.focus();
}

function updateTabBadge(ch) {
  if (!tabsEl) return;
  const btn = tabsEl.querySelector('.tab[data-channel="' + CSS.escape(ch) + '"]');
  if (!btn) return;
  const badge = btn.querySelector('.tab-badge');
  if (!badge) return;
  const n = unreadCounts.get(ch) || 0;
  if (n > 0) {
    badge.textContent = String(n);
    badge.classList.add('show');
  } else {
    badge.textContent = '';
    badge.classList.remove('show');
  }
}

function updateAllTabBadges() {
  viewNames.forEach(ch => updateTabBadge(ch));
}

function refreshMoveTargets() {
  if (!moveTargetSelect) return;
  moveTargetSelect.innerHTML = '';
  for (const ch of viewNames) {
    const opt = document.createElement('option');
    opt.value = ch;
    opt.textContent = ch === 'main' ? 'Feed' : ch;
    moveTargetSelect.appendChild(opt);
  }
}

function isNearBottom() {
  const base = 80;
  const extra = (inputArea && inputArea.offsetHeight) ? inputArea.offsetHeight : 120;
  const threshold = base + extra;
  return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < threshold;
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
            if (typeof saved === 'number' && saved >= 0) {
              feedEl.scrollTop = Math.min(saved, Math.max(0, feedEl.scrollHeight - feedEl.clientHeight));
            } else {
  scrollBottom();
            }
          }
        });
      });
      setupFullscreenOnFirstTap();
      setupFocusOnFirstInteraction();
    } catch (_) {}
    if (typeof done === 'function') done();
  }
  try { if (localStorage.getItem(WAS_EDITING_KEY)) { try { localStorage.setItem(INPUT_STATE_KEY, ''); localStorage.removeItem(WAS_EDITING_KEY); } catch (_) {} if (input) { input.value = ''; input.placeholder = 'Add object…'; sendBtn.disabled = true; autoResize(); updateClearInputBtn(); } } } catch (_) {}
  try { loadChannelsList(); } catch (_) {}
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
          if (currentUser) await syncChannelsFromServer();
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
                    var maxScroll = feedEl.scrollHeight - feedEl.clientHeight;
                    if (maxScroll > 0) feedEl.scrollTop = Math.min(saved, Math.max(0, maxScroll));
                  });
                });
              }
            })();
            subscribeRealtimeAll();
            setupDraftChannel();
            setupDndBroadcastChannel();
            subscribeOrderRealtime();
            subscribeViewRealtime();
            subscribeActionLog();
            if (!window._dndVisibilityBound) {
              window._dndVisibilityBound = true;
              document.addEventListener('visibilitychange', function() {
                if (document.visibilityState !== 'visible' || !currentUser || !currentChannel || typeof setupDndBroadcastChannel !== 'function') return;
                /* Brief delay so WebSocket can reconnect (helps web→mobile when mobile was backgrounded) */
                setTimeout(function() { setupDndBroadcastChannel(); }, 100);
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
  umBackdrop.style.display = 'block';
  umBackdrop.setAttribute('aria-hidden', 'false');
}

function closeUserModal() {
  if (!umBackdrop) return;
  umBackdrop.style.display = 'none';
  umBackdrop.setAttribute('aria-hidden', 'true');
  requestAnimationFrame(focusMainInput);
}

if (userBtn) userBtn.addEventListener('click', openUserModal);
if (umClose) umClose.addEventListener('click', closeUserModal);
if (umBackdrop) umBackdrop.addEventListener('click', e => {
  if (e.target === umBackdrop) closeUserModal();
});
if (logActionBtn) logActionBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (logDropupPanel && logDropupPanel.classList.contains('open')) closeLogDropup();
  else openLogDropup();
});
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
    if (umBackdrop && umBackdrop.style.display === 'block') {
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
    sendBtn.disabled = !input.value.trim();
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
    sendBtn.disabled = !input.value.trim();
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
  // Anonymous, non-shared: use local per-device store.
  if (!currentUser && !tempSessionId) {
    await loadLocalObjectsForCurrentView();
    return;
  }
  const list = await fetchObjectsList();
  await replaceFeedWithList(list);
  // Mirror current view's objects into local per-device storage so they persist on this device.
  try {
    if (Array.isArray(list)) {
      const byView = loadLocalObjects();
      const key = currentView || 'main';
      byView[key] = list;
      saveLocalObjects(byView);
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
  await replaceFeedWithList(data || []);
}

async function replaceFeedWithList(list) {
  if (!feedInner) return;
  seenIds.clear();
  globalObjectNum = 0;
  objectCount = 0;
  const frag = document.createDocumentFragment();
  for (const msg of list) {
    const row = createObjectRow(msg, false);
    if (row) frag.appendChild(row);
  }
  const hasRows = frag.childNodes.length > 0;
  objectCount = hasRows ? frag.childNodes.length : 0;
  /* Table visual: same as feed for now (to be corrected later). */
  feedInner.classList.remove('view-table');
  if (hasRows) {
    requestAnimationFrame(() => {
      if (feedInner) {
        feedInner.replaceChildren(frag);
        updateObjectCount();
        applyFieldPrefsToObjects();
        if (feedEl) feedEl.scrollTop = 0;
      }
    });
  } else {
    if (emptyEl) feedInner.replaceChildren(emptyEl);
    else feedInner.replaceChildren();
    updateObjectCount();
  }
}

/** Render a message list into a given feed-inner element (e.g. secondary view). Does not update global objectCount. */
async function replaceFeedWithListInto(list, targetFeedInner) {
  if (!targetFeedInner) return;
  const savedSeen = new Set(seenIds);
  seenIds.clear();
  const frag = document.createDocumentFragment();
  for (const msg of list) {
    const row = createObjectRow(msg, false, { skipEmptyRemove: true });
    if (row) frag.appendChild(row);
  }
  seenIds.clear();
  savedSeen.forEach(function(id) { seenIds.add(id); });
  const hasRows = frag.childNodes.length > 0;
  if (hasRows) {
    targetFeedInner.classList.remove('view-table');
    targetFeedInner.replaceChildren(frag);
  } else {
    const empty = targetFeedInner.querySelector('.empty-placeholder') || document.createElement('div');
    empty.className = 'empty-placeholder';
    if (!empty.textContent) empty.textContent = 'Nothing yet.';
    targetFeedInner.replaceChildren(empty);
  }
}

/* ═══ REALTIME ════════════════════════════════════════════ */
function subscribeRealtimeAll() {
  for (const sub of channelSubs.values()) {
    try { sub.unsubscribe(); } catch (_) {}
  }
  channelSubs = new Map();

  viewNames.forEach(ch => {
    try {
      console.log('[realtime] subscribe', ch);
    } catch (_) {}
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
}

// Anonymous guest realtime for a temp-session shared view.
function subscribeTempSessionRealtimeGuest() {
  if (!sb || sb === null || currentUser || !tempSessionId || !sb.channel) return;
  try {
    const chName = 'entries-temp-session-' + String(tempSessionId);
    const orFilter = 'channel.eq.' + String(currentChannel) + ',temp_session_id.eq.' + String(tempSessionId);
    const sub = sb
      .channel(chName)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'entries', filter: orFilter },
        (payload) => {
          const row = payload.new;
          if (!row) return;
          const ch = row.channel || currentChannel;
          if (!ch) return;
          if (!viewNames.includes(ch)) {
            viewNames.push(ch);
            if (typeof saveChannelsList === 'function') saveChannelsList();
          }
          currentView = ch;
          currentChannel = ch;
          if (typeof renderTabs === 'function') renderTabs();
          if (typeof onInsertForChannel === 'function') {
            onInsertForChannel(ch, row);
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'entries', filter: orFilter },
        (payload) => {
          const row = payload.new;
          if (!row) return;
          const ch = row.channel || currentChannel;
          if (!ch) return;
          if (typeof onUpdateForChannel === 'function') {
            onUpdateForChannel(ch, row);
          }
        }
      )
      .subscribe();
    channelSubs.set(chName, sub);
  } catch (_) {}
}

/** Update the primary text of an object row. Looks in primary feed, then secondary. */
function updateObjectRowText(objId, textValue) {
  if (objId == null) return;
  const idStr = String(objId);
  const textEl = findObjectRowTextEl(objId);
  if (!textEl) return;
  textEl.innerHTML = linkify(escapeHtml(textValue || ''));
}

function findObjectRowTextEl(objId) {
  if (objId == null) return null;
  const idStr = String(objId);
  const sel = '.obj[data-id="' + CSS.escape(idStr) + '"] .obj-text';
  for (let i = 0; i < views.length; i++) {
    const v = views[i];
    const inner = v && v.feedInner;
    if (!inner) continue;
    const el = inner.querySelector(sel);
    if (el) return el;
  }
  return null;
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

/** Apply the same edit (inferred from oldPrimary -> newPrimary) to every other id. Only single-character insert or delete is applied to others so each object keeps its own text; larger pastes/replaces only change the primary. */
function applyPrimaryEditToMultiEdit(newPrimary) {
  if (!editingObjectTextMap || !editingObjectIds || editingObjectIds.size <= 1) return;
  const oldPrimary = editingObjectTextMap[editingObjectId];
  if (oldPrimary == null || oldPrimary === newPrimary) {
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
      let text = editingObjectTextMap[id];
      if (text == null) return;
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
  [feedInner, secondaryFeedInner].forEach(fi => {
    if (!fi) return;
    fi.querySelectorAll('.obj').forEach(row => {
      const id = row.dataset.id != null ? Number(row.dataset.id) : null;
      if (id != null && editingSet.has(id)) return;
      const textEl = row.querySelector('.obj-text');
      if (!textEl || !textEl.querySelector('.obj-edit-caret, .obj-edit-selection')) return;
      textEl.innerHTML = linkify(escapeHtml(textEl.textContent || ''));
    });
  });
  const caret = '<span class="obj-edit-caret" aria-hidden="true"></span>';
  const selCls = 'obj-edit-selection';
  const cursorStart = input.selectionStart || 0;
  const cursorEnd = input.selectionEnd != null ? input.selectionEnd : cursorStart;
  ids.forEach(id => {
    const text = (editingObjectTextMap && editingObjectTextMap[id] != null) ? editingObjectTextMap[id] : input.value;
    const len = text.length;
    const start = Math.min(cursorStart, len);
    const end = Math.min(Math.max(cursorEnd, start), len);
    const before = text.slice(0, start);
    const sel = text.slice(start, end);
    const after = text.slice(end);
    const html =
      escapeHtml(before) +
      (sel ? '<span class="' + selCls + '">' + escapeHtml(sel) + '</span>' : '') +
      caret +
      escapeHtml(after);
    const textEl = findObjectRowTextEl(id);
    if (textEl) textEl.innerHTML = html || caret;
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
    originalEditTextForCancel = null;
    editingObjectId = null;
    try { localStorage.removeItem(WAS_EDITING_KEY); } catch (_) {}
    if (input) input.placeholder = 'Add object…';
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
        const row = payload.new || payload.old || {};
        if (!row || row.channel !== currentChannel) return;
        if (suppressNextOrderApply) { suppressNextOrderApply = false; return; }
        if (Date.now() < suppressOrderApplyUntil) return;
        await loadObjectOrderForCurrentChannel();
        applyObjectOrderToDOM();
      }
    )
    .subscribe();
}

function subscribeViewRealtime() {
  if (!sb || !sb.channel) return;
  if (viewSub) {
    try { viewSub.unsubscribe(); } catch (_) {}
    viewSub = null;
  }
  const chName = 'views-' + String(currentChannel || '');
  const filter = 'channel=eq.' + String(currentChannel || '');
  viewSub = sb
    .channel(chName)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'views',
        filter,
      },
      payload => {
        const row = payload.new || payload.old || {};
        if (!row || row.channel !== currentChannel || !row.config) return;
        if (suppressNextViewApply) { suppressNextViewApply = false; return; }
        if (Date.now() < suppressOrderApplyUntil) return;
        const cfg = row.config || {};
        // Update order
        if (Array.isArray(cfg.order)) {
          currentObjectOrder = cfg.order
            .map(x => Number(x))
            .filter(x => Number.isFinite(x));
          saveOrderToLocal();
          applyObjectOrderToDOM();
        }
        // Update field prefs
        const defTime = true;
        const defAuthor = currentChannel === 'main' ? false : true;
        fieldPrefs = {
          showTime: typeof cfg.showTime === 'boolean' ? cfg.showTime : defTime,
          showAuthor: typeof cfg.showAuthor === 'boolean' ? cfg.showAuthor : defAuthor,
          viewMode: (cfg.viewMode === 'table' || cfg.viewMode === 'feed') ? cfg.viewMode : 'feed',
        };
        saveFieldPrefsForCurrentChannel();
        applyFieldPrefsToObjects();
      }
    )
    .subscribe();
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
  let handled = false;
  try {
    console.log('[realtime] insert', ch, msg && msg.id);
  } catch (_) {}
  views.forEach(view => {
    if (!view || view.channel !== ch || !view.feedInner) return;
    const inner = view.feedInner;
    if (inner === feedInner) {
        hideEmpty();
      appendObject(msg, true);
      objectCount++;
      updateObjectCount();
          requestAnimationFrame(scrollBottom);
      handled = true;
    } else {
      hideEmptyInFeed(inner);
      const row = createObjectRow(msg, true, { skipEmptyRemove: true });
      if (row) inner.appendChild(row);
      handled = true;
    }
  });
  if (!handled) {
    // Fallback: if this is the current View and we have a primary feed,
    // append directly so guests (or layouts without a registered view)
    // still see realtime inserts.
    if (ch === currentChannel && feedInner) {
      hideEmpty();
      appendObject(msg, true);
      objectCount++;
      updateObjectCount();
      try {
        requestAnimationFrame(scrollBottom);
      } catch (_) {}
    } else {
      const next = (unreadCounts.get(ch) || 0) + 1;
      unreadCounts.set(ch, next);
      updateTabBadge(ch);
    }
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
function setSyncInputPref(on) {
  // Sync is always on; ignore UI toggles.
}

/** Merge so both typists are preserved. When diverged a lot (big suffix) we use last-write-wins to avoid runaway growth. putRemoteNewer = which suffix goes last when we concatenate. */
function mergeInputText(local, remote, putRemoteNewer) {
  if (local == null) local = '';
  if (remote == null) remote = '';
  local = String(local);
  remote = String(remote);
  if (local === remote) return local;
  if (local.length > INPUT_SYNC_MAX_LENGTH || remote.length > INPUT_SYNC_MAX_LENGTH) {
    return capSyncText(putRemoteNewer ? remote : local);
  }
  if (remote.indexOf(local) === 0) return capSyncText(remote);
  if (local.indexOf(remote) === 0) return capSyncText(local);
  var i = 0;
  while (i < local.length && i < remote.length && local[i] === remote[i]) i++;
  var localSuf = local.slice(i);
  var remoteSuf = remote.slice(i);
  if (localSuf.length > 400 || remoteSuf.length > 400) {
    return capSyncText(putRemoteNewer ? remote : local);
  }
  var pre = local.slice(0, i);
  var merged = putRemoteNewer !== false ? pre + localSuf + remoteSuf : pre + remoteSuf + localSuf;
  return capSyncText(merged);
}

async function saveInputToDb() {
  inputSaveToDbTimer = null;
  if (!currentUser || !sb || !sb.from || !getSyncInputPref()) return;
  try {
    await sb.from(USER_INPUT_STATE_TABLE).upsert({
      user_id: currentUser.id,
      channel: currentChannel || 'main',
      text: input ? (input.value || '') : '',
      updated_at: new Date().toISOString(),
      device_id: myId
    }, { onConflict: 'user_id,channel' });
  } catch (e) { console.error('saveInputToDb', e); }
}

function scheduleSaveInputToDb() {
  if (inputSaveToDbTimer) clearTimeout(inputSaveToDbTimer);
  if (!currentUser || !getSyncInputPref()) return;
  inputSaveToDbTimer = setTimeout(saveInputToDb, INPUT_SAVE_DEBOUNCE_MS);
}

async function saveSlotsToDb() {
  inputSlotsSaveToDbTimer = null;
  if (!currentUser || !sb || !sb.from || !getSyncInputPref()) return;
  try {
    await sb.from(USER_INPUT_STATE_TABLE).upsert({
      user_id: currentUser.id,
      channel: SLOTS_SYNC_CHANNEL,
      text: JSON.stringify(inputSlots),
      updated_at: new Date().toISOString(),
      device_id: myId
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
        const row = payload.new || payload.old;
        if (!row) return;
        if (row.device_id === myId) return;
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
                const mobile = isMobileOrTouchDevice();
                const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
                const remoteAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
                const putRemoteLast = remoteAt > lastSlotsEditAt || (remoteAt === lastSlotsEditAt && (row.device_id || '') > (myId || ''));
                inputSlots.forEach(function(slot, i) {
                  const ta = (i === 0 && input) ? input : composerSlotsContainer.querySelector('.composer-slot[data-slot-index="' + i + '"] textarea');
                  if (!ta) return;
                  if (mobile && ta === activeEl) return;
                  const remoteVal = capSyncText(slot.value);
                  const merged = mergeInputText(ta.value, remoteVal, putRemoteLast);
                  if (merged === ta.value) return;
                  ta.value = merged;
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
                scheduleSaveSlotsToDb();
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
            }
          } catch (_) {}
          return;
        }
        if (row.channel !== (currentChannel || 'main')) return;
        if (!input) return;
        const remoteText = capSyncText(row.text);
        const remoteAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
        const putRemoteLast = remoteAt > lastPrimaryInputEditAt || (remoteAt === lastPrimaryInputEditAt && (row.device_id || '') > (myId || ''));
        const merged = mergeInputText(input.value, remoteText, putRemoteLast);
        if (merged !== input.value) {
          input.value = merged;
          if (typeof autoResize === 'function') autoResize();
          if (sendBtn) sendBtn.disabled = !merged.trim();
          if (typeof updateClearInputBtn === 'function') updateClearInputBtn();
          saveInputGlobal();
          scheduleSaveInputToDb();
        }
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
    const { data, error } = await sb.from(USER_INPUT_STATE_TABLE).select('text').eq('user_id', currentUser.id).eq('channel', channel).maybeSingle();
    if (error || !data) return;
    const text = capSyncText(data.text);
    input.value = text;
    autoResize();
    sendBtn.disabled = !text.trim();
    updateClearInputBtn();
    saveInputGlobal();
  } catch (_) {}
}

async function loadSlotsFromDb() {
  if (!currentUser || !sb || !sb.from || !getSyncInputPref()) return false;
  try {
    const { data, error } = await sb.from(USER_INPUT_STATE_TABLE).select('text').eq('user_id', currentUser.id).eq('channel', SLOTS_SYNC_CHANNEL).maybeSingle();
    if (error || !data || data.text == null) return false;
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
  const slotsApplied = await loadSlotsFromDb();
  if (slotsApplied && composerSlotsContainer && typeof renderComposerSlots === 'function') {
    renderComposerSlots();
    updatePrimaryInputRefs();
    if (typeof attachInputListeners === 'function') attachInputListeners();
  }
  await loadInputFromDbForChannel(currentChannel);
}

/* ═══ CROSS-DEVICE DRAFTS (SAME USER) ══════════════════════ */
function setupDraftChannel() {
  teardownDraftChannel();
  latestRemoteDraft = '';

  draftChannel = sb
    .channel('drafts-' + String(currentChannel || 'global'), {
      config: {
        broadcast: { self: true }
      }
    })
    .on('broadcast', { event: 'draft' }, payload => {
      const data = payload.payload || {};
      if (!data) return;
      const text = (data.text != null ? String(data.text) : '').trim();
      const editingId = data.editingId != null ? Number(data.editingId) : null;
      const authorName = data.authorName != null ? String(data.authorName) : '';
      const deviceId = data.deviceId != null ? String(data.deviceId) : '';
      latestRemoteDraft = text;
      const isSelf = (data.from === myId);
      if (editingId != null && Number.isFinite(editingId)) {
        showRemoteEditingDoppelganger(editingId, text, authorName || (isSelf ? 'Editing' : 'Someone'), deviceId, isSelf);
      } else {
        if (lastRemoteEditingId != null) clearRemoteEditingDoppelganger(lastRemoteEditingId);
      }
      // Only show draft bubble for drafts coming from other devices / clients.
      if (!isSelf && text && !editingId) {
        showDraftBubble(text);
      } else if (!text || isSelf) {
        hideDraftBubble();
      }
    })
    .subscribe();
}

function teardownDraftChannel() {
  latestRemoteDraft = '';
  hideDraftBubble();
  if (draftChannel) {
    try { draftChannel.unsubscribe(); } catch (_) {}
    draftChannel = null;
  }
}

function broadcastDraft(text) {
  if (!draftChannel) return;
  const authorName =
    (currentUser && currentUser.user_metadata && currentUser.user_metadata.full_name) ||
    (currentUser && currentUser.email) ||
    (currentUser && currentUser.id ? String(currentUser.id).slice(0, 8) : (visitInviteNick || 'guest'));
  draftChannel.send({
    type: 'broadcast',
    event: 'draft',
    payload: {
      from: myId,
      text: text || '',
      editingId: editingObjectId != null ? editingObjectId : null,
      authorName: authorName || undefined,
      deviceId: myId
    }
  });
}

var lastRemoteEditingId = null;
var savedTextForRemote = Object.create(null);

function showRemoteEditingDoppelganger(objId, text, authorName, deviceId, skipEditingRows) {
  const idStr = String(objId);
  const rows = [];
  if (feedInner) {
    rows.push.apply(rows, Array.from(feedInner.querySelectorAll('.obj[data-id="' + CSS.escape(idStr) + '"]')));
  }
  if (secondaryFeedInner) {
    rows.push.apply(rows, Array.from(secondaryFeedInner.querySelectorAll('.obj[data-id="' + CSS.escape(idStr) + '"]')));
  }
  if (!rows.length) return;
  if (lastRemoteEditingId != null && lastRemoteEditingId !== objId) {
    clearRemoteEditingDoppelganger(lastRemoteEditingId);
  }
  rows.forEach(function(row) {
    if (skipEditingRows && row.classList.contains('obj-editing')) return;
    const textEl = row.querySelector('.obj-text');
    if (!textEl) return;
    if (savedTextForRemote[objId] === undefined) {
      savedTextForRemote[objId] = textEl.textContent || '';
    }
    textEl.innerHTML = linkify(escapeHtml(text || ''));
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
  if (secondaryFeedInner) {
    rows.push.apply(rows, Array.from(secondaryFeedInner.querySelectorAll('.obj[data-id="' + CSS.escape(idStr) + '"]')));
  }
  rows.forEach(function(row) {
    row.classList.remove('obj-remote-editing');
    const textEl = row.querySelector('.obj-text');
    const badge = textEl ? textEl.querySelector('.obj-remote-edit-badge') : row.querySelector('.obj-remote-edit-badge');
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    if (!skipRestore && savedTextForRemote[objId] !== undefined && textEl) {
      textEl.innerHTML = linkify(escapeHtml(savedTextForRemote[objId] || ''));
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
  if (feedForScroll) feedForScroll.addEventListener('scroll', remoteDndScrollResize, { passive: true });
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
        if (remoteDnd && remoteDnd.from === data.from) {
          remoteDnd = null;
          hideRemoteDndLines();
        }
      } else if (data.type === 'dnd_dropped') {
        if (data.from === myId) return;
        if (String(data.channel) !== String(currentChannel)) return;
        var newOrder = Array.isArray(data.newOrder) ? data.newOrder.map(function(x) { return Number(x); }).filter(function(x) { return Number.isFinite(x); }) : [];
        var movedIds = Array.isArray(data.movedIds) ? data.movedIds.map(function(x) { return Number(x); }).filter(function(x) { return Number.isFinite(x); }) : [];
        if (!newOrder.length) return;
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
    if (feedForScroll) feedForScroll.removeEventListener('scroll', remoteDndScrollResize);
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
  if (remoteGhostEl) {
    remoteGhostEl.classList.remove('visible');
  }
  if (remoteSpiritEl) {
    remoteSpiritEl.classList.remove('visible');
  }
  if (remoteDropOriginEl) {
    remoteDropOriginEl.classList.remove('visible');
  }
  if (remoteDropTargetEl) {
    remoteDropTargetEl.classList.remove('visible');
  }
}

function broadcastDndStart() {
  if (!dndBroadcastChannel || !currentUser || !dndChannelReady) return;
  var insertBeforeId = dndOriginInsertBefore && dndOriginInsertBefore.dataset ? Number(dndOriginInsertBefore.dataset.id) : null;
  var block = (dragSelectedRows && dragSelectedRows.length) ? dragSelectedRows : (typeof row !== 'undefined' && row ? [row] : []);
  var lastDraggedId = block.length ? (block[block.length - 1].dataset && block[block.length - 1].dataset.id ? Number(block[block.length - 1].dataset.id) : null) : null;
  var draggingIds = block.map(function(r) { return Number(r.dataset.id); }).filter(function(id) { return Number.isFinite(id); });
  dndBroadcastChannel.send({
    type: 'broadcast',
    event: 'dnd',
    payload: {
      type: 'dnd_start',
      from: myId,
      channel: String(currentChannel),
      draggingIds: draggingIds,
      origin: { insertBeforeId: insertBeforeId, wantAppend: !!dndOriginWantAppend, lastDraggedId: lastDraggedId },
      cursorY: typeof lastDragClientY === 'number' ? lastDragClientY : null
    }
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
    dndBroadcastChannel.send({
      type: 'broadcast',
      event: 'dnd',
      payload: {
        type: 'dnd_move',
        from: myId,
        channel: String(currentChannel),
        target: { insertBeforeId: insertBeforeId, wantAppend: !!lastReorderTarget.wantAppend },
        cursorY: y
      }
    });
  }, 80);
}

function broadcastDndEnd() {
  if (!dndBroadcastChannel || !dndChannelReady) return;
  dndBroadcastChannel.send({
    type: 'broadcast',
    event: 'dnd',
    payload: { type: 'dnd_end', from: myId, channel: String(currentChannel) }
  });
}

function broadcastDndDropped(newOrder, movedIds) {
  if (!dndBroadcastChannel || !dndChannelReady || !newOrder || !movedIds.length) return;
  dndBroadcastChannel.send({
    type: 'broadcast',
    event: 'dnd',
    payload: {
      type: 'dnd_dropped',
      from: myId,
      channel: String(currentChannel),
      newOrder: newOrder,
      movedIds: movedIds
    }
  });
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
  clipboardBubbleTxt.textContent = text;
  clipboardBubble.style.display = 'flex';
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

function setSelectMode(on) {
  selectMode = !!on;
  currentMode = selectMode ? Modes.SELECT : Modes.NORMAL;
  if (selectMode) {
    document.body.dataset.mode = Modes.SELECT;
  } else {
    document.body.dataset.mode = Modes.NORMAL;
    modeState.selectedIds.clear();
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
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = (modeState && modeState.selectedIds) ? modeState.selectedIds.size : selectedIds.size;
  if (count > 0 && !selectMode) {
    selectModeAutoOn = true;
    setSelectMode(true);
  } else if (count === 0 && selectModeAutoOn) {
    selectModeAutoOn = false;
    setSelectMode(false);
  }
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

function saveSecondaryViewState() {
  try {
    if (secondaryViewChannel) localStorage.setItem(SECONDARY_VIEW_KEY, secondaryViewChannel);
    else localStorage.removeItem(SECONDARY_VIEW_KEY);
  } catch (_) {}
}

async function restoreSecondaryView() {
  try {
    const raw = localStorage.getItem(OPEN_VIEWS_KEY);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return;
    for (const name of list) {
      if (typeof name === 'string' && viewNames.includes(name)) {
        await openSecondaryView(name);
      }
    }
  } catch (_) {}
}

var secondaryViewEl = null;
var secondaryFeedInner = null;
var secondaryFeedEl = null;
var multiviewResizerEl = null;

function setupSecondaryFeedDnd() {
  if (!secondaryFeedEl || !secondaryViewEl) return;
  function handleSecondaryDragover(e) {
    if (e.dataTransfer.types.includes('application/x-inout-draft')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      secondaryViewEl.classList.add('view-drop-over');
      return;
    }
    const src = getDraggingRowAndSource();
    if (!src) return;
    // Dragging inside this view: run full reorder logic for this feed.
    if (src.channel === secondaryViewChannel) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      processFeedDragover(e);
      return;
    }
    // Dragging from another view: just show drop-over highlight.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    secondaryViewEl.classList.add('view-drop-over');
  }
  function handleSecondaryDragleave(e) {
    if (!secondaryViewEl.contains(e.relatedTarget)) secondaryViewEl.classList.remove('view-drop-over');
  }
  secondaryViewEl.addEventListener('dragover', handleSecondaryDragover);
  secondaryViewEl.addEventListener('dragleave', handleSecondaryDragleave);
  secondaryFeedEl.addEventListener('dragover', handleSecondaryDragover);
  secondaryFeedEl.addEventListener('dragleave', handleSecondaryDragleave);
  function handleSecondaryDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    dragDropHandled = true;
    secondaryViewEl.classList.remove('view-drop-over');
    const draftSlotIndex = e.dataTransfer.getData('application/x-inout-draft');
    if (draftSlotIndex !== '' && draftSlotIndex != null) {
      const text = (e.dataTransfer.getData('text/plain') || '').trim();
      const slotIndex = parseInt(draftSlotIndex, 10);
      if (text && Number.isFinite(slotIndex) && inputSlots[slotIndex] && secondaryViewChannel) {
        sendText(text, { channel: secondaryViewChannel });
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
    const id = e.dataTransfer.getData('application/x-inout-obj-id') || e.dataTransfer.getData('text/plain');
    const numId = Number(id);
    if (!Number.isFinite(numId)) return;
    const src = getDraggingRowAndSource();
    if (!src || src.channel === secondaryViewChannel) return;
    const rowEl = src.row;
    animateObjectToView(rowEl, secondaryFeedEl, async () => {
      const ok = await moveSingleObject(numId, secondaryViewChannel);
      if (src.channel === currentChannel) {
        currentObjectOrder = currentObjectOrder.filter(x => x !== numId);
        saveObjectOrderForCurrentView();
        showEmptyIfNoObjects();
      }
      if (ok) {
        const list = await fetchObjectsListForChannel(secondaryViewChannel);
        await replaceFeedWithListInto(list, secondaryFeedInner);
      } else if (rowEl) rowEl.style.visibility = '';
    });
  }
  secondaryViewEl.addEventListener('drop', handleSecondaryDrop, true);
  secondaryFeedEl.addEventListener('drop', handleSecondaryDrop, true);
}

function closeSecondaryView() {
  const viewsContainer = document.querySelector('.multiview-views');
  if (viewsContainer) {
    viewsContainer.querySelectorAll('.view').forEach(el => { if (el.parentNode) el.parentNode.removeChild(el); });
    if (multiviewResizerEl && multiviewResizerEl.parentNode) multiviewResizerEl.parentNode.removeChild(multiviewResizerEl);
  }
  multiviewResizerEl = null;
  secondaryViewEl = null;
  secondaryFeedInner = null;
  secondaryFeedEl = null;
  secondaryViewChannel = null;
  views = views.filter(v => v && v.id === 'view-0');
  try { localStorage.setItem(OPEN_VIEWS_KEY, '[]'); } catch (_) {}
  saveSecondaryViewState();
  updateTabsUI();
}

function applyMultiviewSplit(ratio) {
  const viewsContainer = document.querySelector('.multiview-views');
  if (!viewsContainer) return;
  ratio = Math.max(0.2, Math.min(0.8, ratio));
  viewsContainer.style.setProperty('--multiview-split', String(ratio));
  try { localStorage.setItem(MULTIVIEW_SPLIT_KEY, String(ratio)); } catch (_) {}
}

function setupMultiviewResizer(resizerEl, viewsEl) {
  if (!resizerEl || !viewsEl) return;
  let startX = 0;
  let startRatio = 0.5;
  resizerEl.addEventListener('mousedown', e => {
    e.preventDefault();
    const rect = viewsEl.getBoundingClientRect();
    const current = parseFloat(viewsEl.style.getPropertyValue('--multiview-split')) || 0.5;
    startX = e.clientX;
    startRatio = current;
    const onMove = (e2) => {
      const w = viewsEl.offsetWidth;
      if (w <= 0) return;
      const dx = e2.clientX - startX;
      const ratio = startRatio + dx / w;
      applyMultiviewSplit(ratio);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

async function openSecondaryView(ch) {
  if (!viewNames.includes(ch)) return;
  secondaryViewChannel = ch;
  saveSecondaryViewState();
  const viewsContainer = document.querySelector('.multiview-views');
  if (!viewsContainer) return;
  // Add resizer only once when opening the first secondary view
  if (!multiviewResizerEl) {
    const resizer = document.createElement('div');
    resizer.className = 'multiview-resizer';
    resizer.setAttribute('aria-label', 'Resize views');
    try {
      const saved = localStorage.getItem(MULTIVIEW_SPLIT_KEY);
      if (saved) applyMultiviewSplit(parseFloat(saved));
      else viewsContainer.style.setProperty('--multiview-split', '0.5');
    } catch (_) {
      viewsContainer.style.setProperty('--multiview-split', '0.5');
    }
    setupMultiviewResizer(resizer, viewsContainer);
    viewsContainer.appendChild(resizer);
    multiviewResizerEl = resizer;
  }
  const view = document.createElement('div');
  view.className = 'view';
  view.setAttribute('data-channel', ch);
  const visual = document.createElement('div');
  visual.className = 'visual';
  visual.setAttribute('aria-label', 'View: ' + (ch === 'main' ? 'Feed' : ch));
  // clone base feed structure so each view has identical markup, including loader/empty classes
  const baseFeed = document.getElementById('feed');
  let feedInner = null;
  let feedEl = null;
  if (baseFeed) {
    const feedClone = baseFeed.cloneNode(true);
    feedClone.removeAttribute('id');
    feedClone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    feedInner = feedClone.querySelector('.feed-inner');
    feedEl = feedClone;
    visual.appendChild(feedClone);
  } else {
    const feed = document.createElement('div');
    feed.className = 'feed';
    feedInner = document.createElement('div');
    feedInner.className = 'feed-inner';
    const empty = document.createElement('div');
    empty.className = 'empty-placeholder';
    empty.textContent = 'Loading…';
    feedInner.appendChild(empty);
    feed.appendChild(feedInner);
    feedEl = feed;
    visual.appendChild(feed);
  }
  view.appendChild(visual);
  viewsContainer.appendChild(view);
  secondaryViewEl = view;
  secondaryFeedEl = feedEl;
  secondaryFeedInner = feedInner;
  if (secondaryFeedEl) setupSecondaryFeedDnd();
  // register this view in views[] with its own feedInner so realtime/updates target the right feed
  const viewId = 'view-' + views.length;
  const viewRecord = {
    id: viewId,
    channel: ch,
    rootEl: view,
    feedInner: feedInner,
    objects: [],
    config: {},
  };
  views.push(viewRecord);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'view-close-floating';
  closeBtn.setAttribute('aria-label', 'Close view');
  closeBtn.textContent = '×';
  view.appendChild(closeBtn);
  closeBtn.addEventListener('click', () => {
    views = views.filter(v => v && v !== viewRecord);
    if (view.parentNode) view.parentNode.removeChild(view);
    if (secondaryViewEl === view) {
      const other = views.find(v => v && v.id !== 'view-0' && v.rootEl && document.body.contains(v.rootEl));
      if (other) {
        secondaryViewEl = other.rootEl;
        secondaryViewChannel = other.channel;
        secondaryFeedInner = other.feedInner;
        secondaryFeedEl = other.rootEl && other.rootEl.querySelector && other.rootEl.querySelector('.feed') || null;
      } else {
        secondaryViewEl = null;
        secondaryFeedInner = null;
        secondaryFeedEl = null;
        secondaryViewChannel = null;
        if (multiviewResizerEl && multiviewResizerEl.parentNode) multiviewResizerEl.parentNode.removeChild(multiviewResizerEl);
        multiviewResizerEl = null;
      }
      saveSecondaryViewState();
    }
    try {
      const open = Array.from(new Set(views.filter(v => v && v.id !== 'view-0').map(v => v.channel)));
      localStorage.setItem(OPEN_VIEWS_KEY, JSON.stringify(open));
    } catch (_) {}
    updateTabsUI();
  });
  const list = await fetchObjectsListForChannel(ch);
  await replaceFeedWithListInto(list, feedInner);
  updateTabsUI();
  try {
    const open = Array.from(new Set(views.filter(v => v && v.id !== 'view-0').map(v => v.channel)));
    localStorage.setItem(OPEN_VIEWS_KEY, JSON.stringify(open));
  } catch (_) {}
}

function toggleSecondaryView(ch) {
  // Always open another view for this name; multiview supports many views.
  openSecondaryView(ch);
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

function saveInputGlobal() {
  if (!input) return;
  try {
    if (inputSlots.length > 0) {
      inputSlots[0].value = input.value || '';
      saveInputSlots();
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
  if (fieldAuthorChk) {
    const isMain = currentChannel === 'main';
    fieldAuthorChk.disabled = isMain;
    fieldAuthorChk.checked = !isMain && !!fieldPrefs.showAuthor;
  }
  if (viewVisualSelect) viewVisualSelect.value = (fieldPrefs.viewMode === 'table' ? 'table' : 'feed');
}

async function loadFieldPrefsForCurrentChannel() {
  const defTime = true;
  const defAuthor = currentChannel === 'main' ? false : true;
  if (currentUser) {
    try {
      const { data, error } = await sb
        .from('views')
        .select('config')
        .eq('user_id', currentUser.id)
        .eq('channel', currentChannel)
        .limit(1)
        .maybeSingle();
      if (!error && data && data.config) {
        const cfg = data.config || {};
        fieldPrefs = {
          showTime: typeof cfg.showTime === 'boolean' ? cfg.showTime : defTime,
          showAuthor: typeof cfg.showAuthor === 'boolean' ? cfg.showAuthor : defAuthor,
          viewMode: (cfg.viewMode === 'table' || cfg.viewMode === 'feed') ? cfg.viewMode : 'feed',
        };
        try {
          const raw = localStorage.getItem(FIELD_PREFS_KEY);
          const map = raw ? JSON.parse(raw) : {};
          map[currentChannel] = { showTime: !!fieldPrefs.showTime, showAuthor: !!fieldPrefs.showAuthor, viewMode: fieldPrefs.viewMode };
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
      viewMode: (prefs.viewMode === 'table' || prefs.viewMode === 'feed') ? prefs.viewMode : 'feed',
    };
  } catch (_) {
    fieldPrefs = { showTime: true, showAuthor: currentChannel !== 'main', viewMode: 'feed' };
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
      viewMode: fieldPrefs.viewMode === 'table' ? 'table' : 'feed',
    };
    localStorage.setItem(FIELD_PREFS_KEY, JSON.stringify(map));
  } catch(_) {}
  // Skipping remote views upsert for now (table is optional / may not exist).
}

function applyFieldPrefsToObjects() {
  if (!feedInner || !fieldPrefs) return;
  const rows = feedInner.querySelectorAll('.obj');
  rows.forEach(row => {
    if (row.classList.contains('obj-header')) return;
    const timeEl = row.querySelector('.obj-time');
    const senderEl = row.querySelector('.obj-sender');
    if (timeEl) timeEl.style.setProperty('display', fieldPrefs.showTime ? 'block' : 'none', 'important');
    const isMain = currentChannel === 'main' || (row.dataset.channel === 'main');
    if (senderEl) senderEl.style.setProperty('display', !isMain && fieldPrefs.showAuthor ? 'flex' : 'none', 'important');
  });
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
  };
  const move = e => {
    if (!touchDragState || !touchDragState.started || !touchDragState.row) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    e.preventDefault();
    if (!touchDragState.originLineShown) {
      touchDragState.originLineShown = true;
      showDropOriginLine();
    }
    const y = touch.clientY;
    lastDragClientY = y;
    lastDragClientX = touch.clientX;
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
          dndBroadcastChannel.send({
            type: 'broadcast',
            event: 'dnd',
            payload: {
              type: 'dnd_move',
              from: myId,
              channel: String(currentChannel),
              target: { insertBeforeId: insertBeforeId, wantAppend: !insertRef },
              cursorY: y
            }
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
    var droppedMovedIdsTouch = (dragSelectedRows && dragSelectedRows.length) ? dragSelectedRows.map(function(x) { return Number(x.dataset.id); }).filter(function(id) { return Number.isFinite(id); }) : (r.dataset && r.dataset.id ? [Number(r.dataset.id)] : []);
    if (feedInner) feedInner.querySelectorAll('.obj-drag-group').forEach(function(el) { el.classList.remove('obj-drag-group'); });
    dragSelectedRows = [];
    clearEdgeScrollInterval();
    clearTimeout(touchDragState.timer);
    document.removeEventListener('touchmove', move, { passive: false });
    document.removeEventListener('touchend', end);
    hideDropOriginLine();
    r.classList.remove('dragging');
    if (document.body) {
      document.body.classList.remove('dnd-active');
      document.body.classList.add('dnd-just-ended');
    }
    touchDragState.started = false;
    touchDragState.row = null;
    touchDragState.originLineShown = false;
    dndOriginInsertBefore = null;
    dndOriginWantAppend = false;
    dndOriginLineY = null;
    broadcastDndEnd();
    const container = r && r.closest ? r.closest('.feed-inner') : null;
    recomputeOrderFromDOM(container);
    applyObjectOrderToDOM();
    saveObjectOrderForCurrentView();
    if (droppedMovedIdsTouch.length && dndBroadcastChannel && dndChannelReady) {
      broadcastDndDropped(currentObjectOrder.slice(), droppedMovedIdsTouch);
    }
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
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end);
}

/** Table view: header row (Time, Author, Value, Actions). No dataset.id so it stays first. */
function createObjectHeaderRow() {
  const row = document.createElement('div');
  row.className = 'obj obj-header';
  row.setAttribute('aria-hidden', 'true');
  const checkboxPlaceholder = document.createElement('div');
  checkboxPlaceholder.className = 'obj-checkbox-zone';
  checkboxPlaceholder.setAttribute('aria-hidden', 'true');
  const time = document.createElement('div');
  time.className = 'obj-time';
  time.textContent = 'Time';
  const sender = document.createElement('div');
  sender.className = 'obj-sender';
  sender.textContent = 'Author';
  const text = document.createElement('div');
  text.className = 'obj-text';
  text.textContent = 'Value';
  const actions = document.createElement('div');
  actions.className = 'obj-actions';
  row.appendChild(checkboxPlaceholder);
  row.appendChild(time);
  row.appendChild(sender);
  row.appendChild(text);
  row.appendChild(actions);
  return row;
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
  row.draggable = true;
  row.addEventListener('dragstart', e => {
    if (pointerDownOnSelectArea) {
      e.preventDefault();
      pointerDownOnSelectArea = false;
      return;
    }
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
    var isTableView = !!(feedInner && feedInner.classList.contains('view-table'));
    if (dragSelectedRows.length > 1) {
      var stackContainer = document.createElement('div');
      stackContainer.className = 'obj-drag-spirit obj-drag-spirit-stack';
      stackContainer.setAttribute('aria-hidden', 'true');
      stackContainer.style.width = spiritW + 'px';
      stackContainer.style.left = (rowRect.left + rowRect.width / 2) + 'px';
      stackContainer.style.top = startTop + 'px';
      var maxVisible = 4;
      var toShow = Math.min(dragSelectedRows.length, maxVisible);
      if (isTableView) {
        var tableWrap = document.createElement('div');
        tableWrap.className = 'obj-drag-spirit-table-wrap';
        tableWrap.style.width = '100%';
        for (var si = 0; si < toShow; si++) {
          var r = dragSelectedRows[si];
          var clone = r.cloneNode(true);
          clone.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
          clone.classList.add('obj', 'obj-drag-spirit-row');
          clone.removeAttribute('draggable');
          clone.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
          tableWrap.appendChild(clone);
        }
        stackContainer.appendChild(tableWrap);
      } else {
        for (var si = 0; si < toShow; si++) {
          var r = dragSelectedRows[si];
          var clone = r.cloneNode(true);
          clone.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
          clone.classList.add('obj', 'obj-drag-spirit-row');
          clone.removeAttribute('draggable');
          clone.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
          stackContainer.appendChild(clone);
        }
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
      if (isTableView) {
        var wrap = document.createElement('div');
        wrap.className = 'obj-drag-spirit-table-wrap';
        wrap.setAttribute('aria-hidden', 'true');
        wrap.style.width = spiritW + 'px';
        wrap.style.left = (rowRect.left + rowRect.width / 2) + 'px';
        wrap.style.top = startTop + 'px';
        var clone = row.cloneNode(true);
        clone.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
        clone.classList.add('obj', 'obj-drag-spirit', 'obj-drag-spirit-bubble');
        clone.removeAttribute('draggable');
        clone.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
        wrap.appendChild(clone);
        document.body.appendChild(wrap);
        dragSpiritEl = wrap;
      } else {
    dragSpiritEl = row.cloneNode(true);
        dragSpiritEl.classList.remove('dragging', 'obj-drag-group', 'obj-selected', 'new-flash', 'obj-editing', 'obj-drag-over', 'obj-drag-target', 'dragging-in-feed');
        dragSpiritEl.classList.add('obj', 'obj-drag-spirit', 'obj-drag-spirit-bubble');
    dragSpiritEl.removeAttribute('draggable');
    dragSpiritEl.setAttribute('aria-hidden', 'true');
        dragSpiritEl.style.width = spiritW + 'px';
        dragSpiritEl.style.left = (rowRect.left + rowRect.width / 2) + 'px';
        dragSpiritEl.style.top = startTop + 'px';
        dragSpiritEl.querySelectorAll('.obj-checkbox-zone, .obj-actions, .obj-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    document.body.appendChild(dragSpiritEl);
      }
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
    requestAnimationFrame(() => {
      var droppedMovedIds = [];
      try {
        if (lastReorderTarget && !originGhostsActive && feedInner && dragSelectedRows.length) {
          var insertBefore = lastReorderTarget.insertBefore;
          var wantAppend = lastReorderTarget.wantAppend;
          var block = dragSelectedRows.length > 1 ? dragSelectedRows.slice() : [row];
          droppedMovedIds = block.map(function(r) { return Number(r.dataset.id); }).filter(function(id) { return Number.isFinite(id); });
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
          if (droppedMovedIds.length && dndBroadcastChannel && dndChannelReady) {
            broadcastDndDropped(currentObjectOrder.slice(), droppedMovedIds);
          }
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
    if (e.target.closest('.obj-checkbox-zone')) return;
    const contentLeft = row.querySelector('.obj-time') || row.querySelector('.obj-sender') || row.querySelector('.obj-text');
    if (contentLeft && e.touches[0].clientX < contentLeft.getBoundingClientRect().left) return;
    if (!touchDragState || !touchDragState.bound) {
      setupTouchDragHandlers();
    }
    if (!touchDragState) return;
    clearTimeout(touchDragState.timer);
    touchDragState.row = row;
    touchDragState.started = false;
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
      hideRemoteDndLines();
      broadcastDndStart();
      /* origin line shown on first touchmove, not here, so it doesn't appear on long-press alone */
    }, 200); // long press threshold
  }, { passive: true });
  if (isNew) setTimeout(() => row.classList.remove('new-flash'), 800);

  const actions = document.createElement('div');
  actions.className = 'obj-actions';

  const actionDelete = document.createElement('button');
  actionDelete.className = 'obj-action-btn';
  actionDelete.textContent = 'Del';
  actionDelete.addEventListener('click', e => {
    e.stopPropagation();
    if (!obj.id) return;
    deleteSingleObject(obj.id);
  });

  const actionMove = document.createElement('button');
  actionMove.className = 'obj-action-btn';
  actionMove.textContent = 'Move';
  actionMove.addEventListener('click', e => {
    e.stopPropagation();
    if (!obj.id) return;
    moveSingleObject(obj.id);
  });

  const actionExport = document.createElement('button');
  actionExport.className = 'obj-action-btn';
  actionExport.textContent = 'Exp';
  actionExport.addEventListener('click', e => {
    e.stopPropagation();
    if (!obj.id) return;
    exportSingleObject(obj.id);
  });

  const actionCopy = document.createElement('button');
  actionCopy.className = 'obj-action-btn';
  actionCopy.textContent = 'Copy';
  actionCopy.addEventListener('click', e => {
    e.stopPropagation();
    if (!obj.text) return;
    try {
      navigator.clipboard.writeText(obj.text);
      toast('Message copied.');
    } catch (err) {
      console.error(err);
      toast('Could not copy.');
    }
  });

  const actionCut = document.createElement('button');
  actionCut.className = 'obj-action-btn';
  actionCut.textContent = 'Cut';
  actionCut.addEventListener('click', e => {
    e.stopPropagation();
    if (!obj.id || !obj.text) return;
    try {
      navigator.clipboard.writeText(obj.text);
      deleteSingleObject(obj.id);
      toast('Message cut.');
    } catch (err) {
      console.error(err);
      toast('Could not cut.');
    }
  });

  actions.appendChild(actionDelete);
  actions.appendChild(actionMove);
  actions.appendChild(actionExport);
  actions.appendChild(actionCopy);
  actions.appendChild(actionCut);

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

  const isMainFeed = (obj.channel && obj.channel === 'main') || (!obj.channel && currentChannel === 'main');
  const wantAuthor = !isMainFeed && (!!fieldPrefs ? !!fieldPrefs.showAuthor : true);
  sender.style.setProperty('display', wantAuthor ? 'flex' : 'none', 'important');

  const selectWrap = document.createElement('div');
  selectWrap.className = 'obj-select-wrap';
  const selectBox = document.createElement('input');
  selectBox.type = 'checkbox';
  selectBox.className = 'obj-select';
  selectBox.addEventListener('change', () => {
    if (!obj.id) return;
    if (selectBox.checked) {
      selectedIds.add(obj.id);
      modeState.selectedIds.add(obj.id);
      row.classList.add('obj-selected');
    } else {
      selectedIds.delete(obj.id);
      modeState.selectedIds.delete(obj.id);
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
      modeState.selectedIds.add(obj.id);
      row.classList.add('obj-selected');
    } else {
      selectedIds.delete(obj.id);
      modeState.selectedIds.delete(obj.id);
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
      if (feedEl) state.startYContent = startY - feedEl.getBoundingClientRect().top + feedEl.scrollTop;
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
      ev.preventDefault();
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
    document.addEventListener('touchmove', onTouchMove, { passive: false });
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
      if (feedEl) state.startYContent = startY - feedEl.getBoundingClientRect().top + feedEl.scrollTop;
      feedInner.querySelectorAll('.obj').forEach(r => {
        const box = r.querySelector('.obj-select');
        if (box) state.startRowStates.set(r, box.checked);
      });
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
    if (e.target.closest('.obj-checkbox-zone, .obj-actions') || (e.target.closest('a') && e.target.closest('.obj-text'))) return;
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
      if (feedEl) state.startYContent = startY - feedEl.getBoundingClientRect().top + feedEl.scrollTop;
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
    if (e.target.closest('.obj-checkbox-zone, .obj-actions') || (e.target.closest('a') && e.target.closest('.obj-text'))) return;
    const startY = e.touches[0].clientY;
    const state = { started: false, mode: null, startRowStates: null, startYContent: null, didWeMove: false };
    const onTouchMove = (ev) => {
      if (!state.started || ev.touches.length !== 1) return;
      ev.preventDefault();
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
    };
    document.addEventListener('touchmove', onTouchMove, { passive: false });
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
      if (feedEl) state.startYContent = startY - feedEl.getBoundingClientRect().top + feedEl.scrollTop;
      feedInner.querySelectorAll('.obj').forEach(r => {
        const box = r.querySelector('.obj-select');
        if (box) state.startRowStates.set(r, box.checked);
      });
    }, 200);
    const onDocTouchMove = (ev) => {
      if (timer) clearTimeout(timer);
      timer = null;
      document.removeEventListener('touchmove', onTouchMove, { passive: false });
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('touchmove', onDocTouchMove, true);
      document.removeEventListener('touchend', onDocTouchEnd, true);
      document.removeEventListener('touchcancel', onDocTouchEnd, true);
    };
    const onDocTouchEnd = () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('touchend', onDocTouchEnd, true);
      document.removeEventListener('touchcancel', onDocTouchEnd, true);
      document.removeEventListener('touchmove', onDocTouchMove, true);
    };
    document.addEventListener('touchend', onDocTouchEnd, true);
    document.addEventListener('touchcancel', onDocTouchEnd, true);
    document.addEventListener('touchmove', onDocTouchMove, true);
  }, { passive: true });

  const time = document.createElement('div');
  time.className = 'obj-time';
  time.textContent = formatTime(obj.created_at);
  if (fieldPrefs) time.style.setProperty('display', fieldPrefs.showTime ? 'block' : 'none', 'important');

  const text = document.createElement('div');
  text.className = 'obj-text';
  text.innerHTML = linkify(escapeHtml(obj.text));
  text.addEventListener('click', e => {
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
    /* Restore previous row’s text so its doppelganger doesn’t stay */
    restoreEditingRowsOnCancel();
    const multi = selectMode && selectedIds.size > 1 && selectedIds.has(obj.id);
    const idsToEdit = multi ? new Set(selectedIds) : new Set([obj.id]);
    originalEditTextForCancelMap = {};
    editingObjectTextMap = {};
    /* Read each row's own text from that row's DOM so every object keeps its own doppelganger. */
    [feedInner, secondaryFeedInner].forEach(fi => {
      if (!fi) return;
      fi.querySelectorAll('.obj').forEach(row => {
        const id = row.dataset.id != null ? Number(row.dataset.id) : null;
        if (id == null || !idsToEdit.has(id)) return;
        const textEl = row.querySelector('.obj-text');
        let raw = (textEl && textEl.textContent) ? textEl.textContent : '';
        const badge = textEl && textEl.querySelector('.obj-remote-edit-badge');
        if (badge && badge.textContent) raw = raw.slice(0, -badge.textContent.length);
        originalEditTextForCancelMap[id] = raw;
        editingObjectTextMap[id] = raw;
      });
    });
    input.value = obj.text || '';
    var len = input.value.length;
    input.selectionStart = len;
    input.selectionEnd = len;
    editingObjectId = obj.id;
    editingObjectIds = idsToEdit;
    originalEditTextForCancel = obj.text || '';
    editTypingUndoStack = [obj.text || ''];
    editTypingRedoStack = [];
    modeState.editing.active = true;
    modeState.editing.primaryId = obj.id;
    modeState.editing.ids = idsToEdit;
    currentMode = Modes.EDIT;
    document.body.dataset.mode = Modes.EDIT;
    if (editTypingCommitTimer) {
      clearTimeout(editTypingCommitTimer);
      editTypingCommitTimer = null;
    }
    try { localStorage.setItem(WAS_EDITING_KEY, '1'); } catch (_) {}
    input.placeholder = idsToEdit.size > 1 ? 'Editing ' + idsToEdit.size + ' objects…' : 'Editing object…';
    autoResize();
    sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
    saveInputGlobal();
    updateEditingRowHighlight();
    updateEditingRowFromInput();
    focusMainInput();
    requestAnimationFrame(updateEditingRowFromInput);
  });

  row.addEventListener('click', e => {
    if (e.target.closest('.obj-checkbox-zone')) return;
    if (e.target.closest('.obj-text')) return;
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

  row.appendChild(checkboxZone);
  row.appendChild(time);
  row.appendChild(sender);
  row.appendChild(text);
  row.appendChild(actions);
  row.addEventListener('mousedown', e => {
    if (e.target.closest('.obj-checkbox-zone')) return;
    const contentLeft = row.querySelector('.obj-time') || row.querySelector('.obj-sender') || row.querySelector('.obj-text');
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
  const row = createObjectRow(obj, isNew);
  if (!row) return;
  feedInner.appendChild(row);
  // Ensure new messages respect the current view (time/author) settings.
  applyFieldPrefsToObjects();
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

function renderInitialObjects(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  hideEmpty();
  const frag = document.createDocumentFragment();
  for (const msg of list) {
    const row = createObjectRow(msg, false);
    if (row) frag.appendChild(row);
  }
  requestAnimationFrame(() => {
    if (feedInner) feedInner.appendChild(frag);
  });
}

function loadOrderFromLocal() {
  try {
    const raw = localStorage.getItem(ORDER_STATE_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw);
    if (!map || typeof map !== 'object') return [];
    const key = currentUser ? (currentUser.id + '::' + currentView) : ('anon::' + currentView);
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
    const key = currentUser ? (currentUser.id + '::' + currentView) : ('anon::' + currentView);
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
function setupTabs() {
  renderTabs();
  if (viewsCloseAllBtn) {
    viewsCloseAllBtn.addEventListener('click', () => {
      closeSecondaryView();
    });
  }
  const manageMenuToggle = document.getElementById('manage-menu-toggle');
  const manageMenu = document.getElementById('manage-menu');
  if (manageMenuToggle && manageMenu) {
    manageMenu.hidden = true;
    manageMenuToggle.addEventListener('click', () => {
      const isOpen = manageMenu.classList.toggle('open');
      manageMenu.hidden = !isOpen;
      manageMenuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }
}

function updateTabsUI() {
  if (!tabsEl) return;
  const buttons = tabsEl.querySelectorAll('.tab[data-channel]');
  buttons.forEach(btn => {
    const ch = btn.getAttribute('data-channel') || 'main';
    if (ch === currentView) {
      btn.classList.add('tab-active');
    } else {
      btn.classList.remove('tab-active');
    }
  });
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
}

async function loadObjectOrderForCurrentChannel() {
  currentObjectOrder = [];
  // 1) Try unified view object (channel-owned, not per-user).
  try {
    const { data, error } = await sb
      .from('views')
      .select('config')
      .eq('channel', currentChannel)
      .limit(1)
      .maybeSingle();
    if (!error && data && data.config) {
      const cfg = data.config || {};
      const orderArr = Array.isArray(cfg.order) ? cfg.order : [];
      currentObjectOrder = orderArr
        .map(x => Number(x))
        .filter(x => Number.isFinite(x));
      // Pull view rules into fieldPrefs and mirror into local storage.
      const defTime = true;
      const defAuthor = currentChannel === 'main' ? false : true;
      fieldPrefs = {
        showTime: typeof cfg.showTime === 'boolean' ? cfg.showTime : defTime,
        showAuthor: typeof cfg.showAuthor === 'boolean' ? cfg.showAuthor : defAuthor,
        viewMode: (cfg.viewMode === 'table' || cfg.viewMode === 'feed') ? cfg.viewMode : 'feed',
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
  if (!currentObjectOrder.length) return;
  saveOrderToLocal();
  suppressOrderApplyUntil = Date.now() + 600;
  // Persist order into unified views config for this channel (owner writes; guests just read).
  if (currentUser) {
    try {
      const cfg = {
        order: currentObjectOrder.slice(),
        showTime: fieldPrefs && typeof fieldPrefs.showTime === 'boolean' ? fieldPrefs.showTime : true,
        showAuthor: fieldPrefs && typeof fieldPrefs.showAuthor === 'boolean'
          ? fieldPrefs.showAuthor
          : (currentView === 'main' ? false : true),
        viewMode: fieldPrefs && (fieldPrefs.viewMode === 'table' || fieldPrefs.viewMode === 'feed')
          ? fieldPrefs.viewMode
          : 'feed',
      };
      suppressNextViewApply = true;
      const { error } = await sb
        .from('views')
        .upsert(
          { channel: currentView, config: cfg },
          { onConflict: 'channel' }
        );
      if (error) console.error(error);
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
    const header = inner.querySelector('.obj.obj-header');
    const rows = Array.from(inner.querySelectorAll('.obj:not(.obj-header)'));
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
  const frag = document.createDocumentFragment();
    currentObjectOrder.forEach(id => {
    const row = byId.get(id);
    if (row) {
      frag.appendChild(row);
      byId.delete(id);
    }
  });
  byId.forEach(row => frag.appendChild(row));
    if (header && header.parentNode === inner) inner.insertBefore(header, inner.firstChild);
    inner.appendChild(frag);
  });
}

function renderTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';

  viewNames.forEach(ch => {
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.setAttribute('data-channel', ch);
    const label = document.createElement('span');
    label.textContent = ch === 'main' ? 'Feed' : ch;
    btn.appendChild(label);

    if (sharedChannels.has(ch) && ch !== 'main') {
      const shared = document.createElement('span');
      shared.className = 'tab-shared';
      shared.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M16 11c1.657 0 3-1.567 3-3.5S17.657 4 16 4s-3 1.567-3 3.5S14.343 11 16 11Z" stroke="currentColor" stroke-width="1.6"/><path d="M8 11c1.657 0 3-1.567 3-3.5S9.657 4 8 4 5 5.567 5 7.5 6.343 11 8 11Z" stroke="currentColor" stroke-width="1.6"/><path d="M4 20c0-3.314 2.686-6 6-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M14 14c3.314 0 6 2.686 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 14c1.7 0 3.24.71 4.33 1.85" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      btn.appendChild(shared);
    }

    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    btn.appendChild(badge);

    if (ch !== 'main') {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.addEventListener('click', e => {
        e.stopPropagation();
        deleteChannel(ch);
      });
      btn.appendChild(close);
    }

    btn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        toggleSecondaryView(ch);
        return;
      }
      switchChannel(ch);
    });
    btn.addEventListener('dragenter', e => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      tabsEl.querySelectorAll('.tab.tab-drop-target').forEach(t => t.classList.remove('tab-drop-target'));
      btn.classList.add('tab-drop-target');
    });
    btn.addEventListener('dragover', e => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      btn.classList.add('tab-drop-target');
    });
    btn.addEventListener('dragleave', e => {
      if (!btn.contains(e.relatedTarget)) btn.classList.remove('tab-drop-target');
    });
    btn.addEventListener('drop', e => {
      e.preventDefault();
      dragDropHandled = true;
      btn.classList.remove('tab-drop-target');
      const id = e.dataTransfer.getData('application/x-inout-obj-id') || e.dataTransfer.getData('text/plain');
      if (!id || ch === currentChannel) return;
      const numId = Number(id);
      if (!Number.isFinite(numId)) return;
      const rowEl = feedInner.querySelector('.obj[data-id="' + CSS.escape(String(numId)) + '"]');
      if (rowEl) {
        animateObjectToTab(rowEl, btn, async () => {
          const ok = await moveSingleObject(numId, ch);
          if (!ok) rowEl.style.visibility = '';
        });
      } else {
        moveSingleObject(numId, ch);
      }
    });
    tabsEl.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'tab tab-new';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', openChannelModal);
  tabsEl.appendChild(addBtn);

  updateTabsUI();
  updateAllTabBadges();
  refreshMoveTargets();
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

async function switchChannel(ch) {
  if (ch === currentChannel && ch === currentView) return;
  teardownDndBroadcastChannel();
  if (editingObjectId != null) cancelEditingMode(true);
  if (feedEl) {
    viewScroll.set(currentView, feedEl.scrollTop);
    saveScrollState();
  }
  currentChannel = ch;
  currentView = ch;
  // keep main view's View name in sync
  if (views[0]) views[0].channel = ch;
  try {
    localStorage.setItem(CURRENT_CHANNEL_KEY, currentChannel);
  } catch (_) {}
  unreadCounts.set(ch, 0);
  updateTabsUI();
  updateTabBadge(ch);
  refreshMoveTargets();
  await loadFieldPrefsForCurrentChannel();
  if (getSyncInputPref() && currentUser) {
    await loadInputFromDbForChannel(ch);
  }
  if (currentUser) {
    setupDndBroadcastChannel();
    subscribeOrderRealtime();
    subscribeViewRealtime();
    ensureMembership().then(reloadForUser);
  } else if (tempSessionId) {
    subscribeViewRealtime();
    await loadObjectOrderForCurrentChannel();
    await loadObjects();
  } else {
    clearObjects();
  }
}

function openChannelModal() {
  if (!currentUser) {
    toast('Sign in to create a feed.');
    return;
  }
  if (!cmBackdrop || !cmName || !cmSelf || !cmOthers) return;
  cmName.value = '';
  cmOthers.value = '';
  cmSelf.textContent = currentUser.id || '';
  cmBackdrop.style.display = 'flex';
  cmName.focus();
}

function closeChannelModal() {
  if (!cmBackdrop) return;
  cmBackdrop.style.display = 'none';
  requestAnimationFrame(focusMainInput);
}

if (cmCancel) cmCancel.addEventListener('click', closeChannelModal);
if (cmBackdrop) cmBackdrop.addEventListener('click', e => {
  if (e.target === cmBackdrop) closeChannelModal();
});
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
    subscribeViewRealtime();
    return;
  }

  if (currentUser) {
    try {
      await refreshSharedFlags();
      renderTabs();
      subscribeRealtimeAll();
      setupDraftChannel();
      restoreLastChannel();
      await restoreSecondaryView();
      await loadObjectOrderForCurrentChannel();
      await loadObjects();
      restoreInputGlobal();
      if (getSyncInputPref()) {
        await restoreInputFromDb();
        setupInputStateRealtime();
      } else {
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
    // When not signed in, hydrate view from local per-device objects (anonymous mode),
    // unless we are in a temp-session guest mode.
    if (tempSessionId) {
      await loadObjectOrderForCurrentChannel();
      await loadObjects();
      subscribeViewRealtime();
    } else {
      // Restore multiview layout (open views + split) for anonymous/guest users.
      await restoreSecondaryView();
      await loadLocalObjectsForCurrentView();
    }
  }
}

var explicitSignOut = false;
function setupAuthListener() {
  if (!sb || !sb.auth || typeof sb.auth.onAuthStateChange !== 'function') return;
  sb.auth.onAuthStateChange(async (event, session) => {
    if (suppressAutoAuth) {
      return;
    }
    if (session && session.user) {
    const prevUser = currentUser;
      currentUser = session.user;
      try { sessionStorage.setItem(AUTH_BACKUP_KEY, JSON.stringify(currentUser)); } catch (_) {}
    updateAuthUI();
    if (!prevUser && currentUser) {
        try {
      await syncChannelsFromServer();
          await reloadForUser();
          setupDraftChannel();
          setupDndBroadcastChannel();
        } catch (e) {
          console.error(e);
          renderTabs();
          try { await loadObjects(); } catch (_) {}
          if (feedInner && emptyEl && !emptyEl.parentNode) feedInner.appendChild(emptyEl);
        }
      }
      return;
    }
    if (explicitSignOut) {
      explicitSignOut = false;
      try { sessionStorage.removeItem(AUTH_BACKUP_KEY); } catch (_) {}
      return;
    }
    try {
      const { data } = await sb.auth.getSession();
      if (data?.session?.user) {
        currentUser = data.session.user;
        try { sessionStorage.setItem(AUTH_BACKUP_KEY, JSON.stringify(currentUser)); } catch (_) {}
        updateAuthUI();
        return;
      }
    } catch (_) {}
  });

  if (umAuthBtn) umAuthBtn.addEventListener('click', () => {
    if (currentUser) {
      signOut();
    } else {
      signIn();
    }
  });

  if (umCopyIdBtn) umCopyIdBtn.addEventListener('click', copyUserId);

  if (umNickSave && umNickname) {
    umNickSave.addEventListener('click', saveNickname);
  }
}

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

function updateAuthUI() {
  if (userBtn) userBtn.classList.toggle('signed-in', !!currentUser);

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
  const list = await fetchObjectsList();
  await replaceFeedWithList(list);
  subscribeRealtimeAll();
  var savedScroll = viewScroll.get(currentView);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
   if (feedEl) {
        if (typeof savedScroll === 'number' && savedScroll >= 0) {
          feedEl.scrollTop = Math.min(savedScroll, Math.max(0, feedEl.scrollHeight - feedEl.clientHeight));
    } else {
      scrollBottom();
    }
  }
      if (input) input.focus();
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
        }
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
    toast('User id copied.');
  } catch (e) {
    console.error(e);
    toast('Failed to copy id.');
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

function setupFullscreenOnFirstTap() {
  if (!window.matchMedia('(max-width: 540px)').matches) return;
  let done = false;
  function tryFullscreen() {
    if (done) return;
    done = true;
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }
  document.addEventListener('click', tryFullscreen, { once: true });
  document.addEventListener('touchstart', tryFullscreen, { once: true });
}

/* ═══ SEND ════════════════════════════════════════════════ */
async function send() {
  const text = input.value.trim();
  if (!text) return;

  await sendText(text);
}

async function sendText(text, options) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  const targetChannel = (options && options.channel != null) ? options.channel : currentChannel;

  if (input) { input.disabled = true; }
  if (sendBtn) sendBtn.disabled = true;

  const idsToSave = editingObjectIds && editingObjectIds.size
    ? Array.from(editingObjectIds)
    : (editingObjectId != null ? [editingObjectId] : []);
  if (idsToSave.length > 0) {
    const trimmedPerId = idsToSave.map(id => (editingObjectTextMap && editingObjectTextMap[id] != null) ? String(editingObjectTextMap[id]).trim() : trimmed);
    const befores = [];
    if (idsToSave.length === 1) {
      const { data: before, error: selErr } = await sb
        .from(OBJECTS_TABLE)
        .select('id, created_at, text, channel, user_id, author_name')
        .eq('id', idsToSave[0])
        .maybeSingle();
    if (selErr) {
      input.disabled = false;
      console.error(selErr);
      toast('Failed to update — ' + humanError(selErr.message));
      sendBtn.disabled = false;
      return;
    }
      if (before) befores.push(before);
    } else {
      const { data: list, error: selErr } = await sb
        .from(OBJECTS_TABLE)
        .select('id, created_at, text, channel, user_id, author_name')
        .in('id', idsToSave);
      if (selErr) {
    input.disabled = false;
        console.error(selErr);
        toast('Failed to update — ' + humanError(selErr.message));
      sendBtn.disabled = false;
      return;
    }
      if (list) befores.push(...list);
    }
    let lastError = null;
    for (let i = 0; i < idsToSave.length; i++) {
      const id = idsToSave[i];
      const textToSave = trimmedPerId[i];
      const editPayload = {
        p_channel: currentChannel,
        p_entry_id: id,
        p_action: 'edit',
        p_payload: { text: textToSave },
      };
      if (tempSessionId) editPayload.p_temp_session_id = tempSessionId;
      const { error } = await sb.rpc('perform_entry_action', editPayload);
      if (error) lastError = error;
    }
    input.disabled = false;
    if (lastError) {
      console.error(lastError);
      toast('Failed to update — ' + humanError(lastError.message));
      sendBtn.disabled = false;
      return;
    }
    if (befores.length) {
      const afterById = {};
      idsToSave.forEach((id, i) => { afterById[id] = trimmedPerId[i] || trimmed; });
      pushUndo({ type: 'edit', entries: befores.map(b => ({ id: b.id, beforeText: b.text, afterText: afterById[b.id] != null ? afterById[b.id] : trimmed })) });
      befores.forEach(b => logAction('edit', { id: b.id }));
    }
    idsToSave.forEach((id, i) => updateObjectRowText(id, trimmedPerId[i] || trimmed));
    originalEditTextForCancel = null;
    originalEditTextForCancelMap = null;
    editingObjectTextMap = null;
    editingObjectIds = null;
    reactivateInputMode({ clearInput: targetChannel === currentChannel });
    return;
  }

  let data = null;
  let error = null;

  if (currentUser && sb && sb.from) {
    // Signed-in path: insert into Supabase as before.
    const payload = {
      text: trimmed,
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
  } else if (tempSessionId && sb && sb.from) {
    // Guest in temp session: write to Supabase with temp_session_id
    const res = await sb
      .from(OBJECTS_TABLE)
      .insert({
        text: trimmed,
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
      text: trimmed,
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
    upsertLocalObjectForCurrentView(data);
    // Undo/log only for signed-in Supabase sends
    if (currentUser && sb && sb.from) {
      pushUndo({ type: 'send', entries: [data] });
      logAction('send', { channel: currentChannel });
    }
    reactivateInputMode({ clearInput: targetChannel === currentChannel });
  } else {
    if (sendBtn) sendBtn.disabled = false;
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
function attachInputListeners() {
  if (_inputListenersAttached) return;
  var inp = document.getElementById('object-input');
  var btn = document.getElementById('send-btn');
  if (inp) input = inp;
  if (btn) sendBtn = btn;
  if (!input) return;
  _inputListenersAttached = true;
input.addEventListener('input', () => {
  lastPrimaryInputEditAt = Date.now();
  autoResize();
    if (sendBtn) sendBtn.disabled = !input.value.trim();
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
    if (editingObjectId != null) updateEditingRowFromInput();
  });
  input.addEventListener('keyup', () => {
    if (editingObjectId != null) updateEditingRowFromInput();
  });
  input.addEventListener('select', () => {
    if (editingObjectId != null) updateEditingRowFromInput();
  });
  input.addEventListener('mouseup', () => {
    if (editingObjectId != null) updateEditingRowFromInput();
  });
  if (sendBtn) sendBtn.addEventListener('click', send);
}
if (composerSlotsContainer) {
  renderComposerSlots();
}
setupInputAreaDropTarget();
attachInputListeners();
if (!input && typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    if (composerSlotsContainer) renderComposerSlots();
    attachInputListeners();
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
    latestRemoteDraft = '';
    hideDraftBubble();
    broadcastDraft('');
  });
}

if (clipboardPasteBtn) {
  clipboardPasteBtn.addEventListener('click', () => {
    if (!latestClipboardText) return;
    input.value = latestClipboardText;
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
      latestClipboardText = trimmed;
      showClipboardBubble(trimmed);
    } catch (e) {
      console.error(e);
      toast('Could not read clipboard.');
    }
  });
}

if (clearInputBtn) {
  clearInputBtn.addEventListener('click', () => {
    if (!input) return;
    input.value = '';
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
      modeState.selectedIds.clear();
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
        modeState.selectedIds.add(n);
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
    modeState.selectedIds.clear();
    feedInner.querySelectorAll('.obj.obj-selected').forEach(row => row.classList.remove('obj-selected'));
    updateSelectionUI();
  });
}

if (viewVisualSelect) {
  viewVisualSelect.addEventListener('change', () => {
    const viewMode = viewVisualSelect.value === 'table' ? 'table' : 'feed';
    if (fieldPrefs.viewMode === viewMode) return;
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor, viewMode: fieldPrefs.viewMode } });
    fieldPrefs.viewMode = viewMode;
    logAction('view', { viewMode });
    saveFieldPrefsForCurrentChannel();
    applyFieldPrefsUI();
    if (currentUser) {
      loadObjects().catch(() => {});
    } else {
      loadLocalObjectsForCurrentView().catch?.(() => {});
    }
  });
}

if (fieldTimeChk) {
  fieldTimeChk.addEventListener('change', () => {
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor, viewMode: fieldPrefs.viewMode } });
    fieldPrefs.showTime = !!fieldTimeChk.checked;
    logAction('view', { showTime: !!fieldTimeChk.checked, showAuthor: fieldPrefs.showAuthor });
    saveFieldPrefsForCurrentChannel();
    applyFieldPrefsToObjects();
  });
}

if (fieldAuthorChk) {
  fieldAuthorChk.addEventListener('change', () => {
    // In main feed authors are never shown; keep UI in sync with that rule.
    if (currentChannel === 'main' || fieldAuthorChk.disabled) {
      fieldAuthorChk.checked = false;
      return;
    }
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor, viewMode: fieldPrefs.viewMode } });
    fieldPrefs.showAuthor = !!fieldAuthorChk.checked;
    logAction('view', { showTime: fieldPrefs.showTime, showAuthor: !!fieldAuthorChk.checked });
    saveFieldPrefsForCurrentChannel();
    applyFieldPrefsToObjects();
  });
}

var MANAGE_BAR_ORDER_KEY = 'inout_manage_bar_order_v1';
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

function saveManageBarOrder() {
  var actions = document.getElementById('manage-actions');
  if (!actions) return;
  var ids = Array.from(actions.children)
    .filter(function(n) { return n.getAttribute && n.getAttribute('data-bar-id'); })
    .map(function(n) { return n.getAttribute('data-bar-id'); });
  try { localStorage.setItem(MANAGE_BAR_ORDER_KEY, JSON.stringify(ids)); } catch (_) {}
}

function setupBarDndMode(on) {
  var scroll = document.getElementById('manage-bar-scroll');
  var actions = document.getElementById('manage-actions');
  if (!scroll || !actions) return;
  var buttons = Array.from(actions.querySelectorAll('[data-bar-id]'));
  if (on) {
    buttons.forEach(function(btn) {
      btn.setAttribute('draggable', 'true');
      btn.classList.remove('bar-dragging');
    });
    if (barDndIndicatorEl && barDndIndicatorEl.parentNode) barDndIndicatorEl.remove();
    barDndIndicatorEl = null;
    barDndDraggedEl = null;
  } else {
    buttons.forEach(function(btn) { btn.setAttribute('draggable', 'false'); });
    if (barDndIndicatorEl && barDndIndicatorEl.parentNode) barDndIndicatorEl.remove();
    barDndIndicatorEl = null;
    barDndDraggedEl = null;
  }
}

if (viewToggleBtn && viewMenu) {
  viewToggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    viewMenu.classList.toggle('open');
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
  });
}

if (deleteSelectedBtn) {
  deleteSelectedBtn.addEventListener('click', async () => {
    if (!currentUser) return;
    // Use global selection union (across all open views).
    let ids = Array.from(modeState.selectedIds || [])
      .map(x => Number(x))
      .filter(id => Number.isFinite(id));
    try {
      let rowsToDelete = [];
      // If nothing selected, operate on whole tab (for this user).
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
      // Clear selection across all views.
      selectedIds.clear();
      modeState.selectedIds.clear();
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
  });
}

if (moveSelectedBtn) {
  moveSelectedBtn.addEventListener('click', async () => {
    if (!currentUser || !moveTargetSelect) return;
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
        console.error(error);
        toast('Failed to move — ' + humanError(error.message));
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
  });
}

async function deleteSingleObject(id, fromChannel) {
  if (!id || !sb || !sb.rpc) return;
  const ch = fromChannel != null ? fromChannel : currentChannel;
  try {
    const payload = {
      p_channel: ch,
      p_entry_id: id,
      p_action: 'delete',
      p_payload: {},
    };
    if (tempSessionId) payload.p_temp_session_id = tempSessionId;
    const { error } = await sb.rpc('perform_entry_action', payload);
    if (error) {
      console.error(error);
      toast('Failed to delete — ' + humanError(error.message));
      return;
    }
    // UI removal will be driven by realtime DELETE events (onDeleteForChannel).
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

function animateObjectToView(rowEl, targetFeedEl, onDone) {
  if (!rowEl || !targetFeedEl) {
    if (typeof onDone === 'function') onDone();
    return;
  }
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
  const to = targetFeedEl.getBoundingClientRect();
  const toCenterX = to.left + to.width / 2;
  const toCenterY = to.top + to.height / 2;
  const fromCenterX = from.left + from.width / 2;
  const fromCenterY = from.top + from.height / 2;
  const dx = toCenterX - fromCenterX;
  const dy = toCenterY - fromCenterY;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      clone.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(0.4)';
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
  if (!sb || !sb.rpc) return false;

  const useRpc = !!tempSessionId || !!currentUser;

  if (useRpc) {
    try {
      const rpcPayload = {
        p_channel: currentChannel,
        p_entry_id: id,
        p_action: 'move',
        p_payload: { target_channel: target },
      };
      if (tempSessionId) rpcPayload.p_temp_session_id = tempSessionId;
      const { error } = await sb.rpc('perform_entry_action', rpcPayload);
      if (!error) {
        const el = feedInner && feedInner.querySelector('.obj[data-id="' + CSS.escape(String(id)) + '"]');
        if (el) el.remove();
        currentObjectOrder = currentObjectOrder.filter(x => x !== id);
        saveObjectOrderForCurrentView();
        showEmptyIfNoObjects();
        return true;
      }
      if (tempSessionId) {
        toast('Failed to move — ' + humanError(error.message));
        return false;
      }
      // Owner: fall through to direct update if RPC doesn't support move
      if (error.code !== 'PGRST202' && error.message && !error.message.includes('move')) {
        toast('Failed to move — ' + humanError(error.message));
        return false;
      }
    } catch (e) {
      if (tempSessionId) {
        console.error(e);
        toast('Failed to move — ' + humanError(e.message));
        return false;
      }
    }
  }

  // Owner-only fallback: direct update (when RPC move not implemented)
  if (!currentUser) return false;
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
    const el = feedInner.querySelector('.obj[data-id="' + CSS.escape(String(id)) + '"]');
    if (el) el.remove();
    currentObjectOrder = currentObjectOrder.filter(x => x !== id);
    saveObjectOrderForCurrentView();
    showEmptyIfNoObjects();
    return true;
  } catch (e) {
    console.error(e);
    toast('Failed to move — ' + humanError(e.message));
    return false;
  }
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
    let line;
    if (data.channel === 'main') {
      line = `[${timeStr}] ${data.text}`;
    } else {
      const author = data.author_name
        ? String(data.author_name)
        : (data.user_id ? String(data.user_id) : 'unknown');
      line = `[${timeStr}] ${author}: ${data.text}`;
    }
    const blob = new Blob([line + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const name = data.channel === 'main' ? 'feed' : data.channel;
    a.download = `inout-${name}-msg-${id}.txt`;
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
          return `[${timeStr}] ${row.text}`;
        }
        const author = row.author_name
          ? String(row.author_name)
          : (row.user_id ? String(row.user_id) : 'unknown');
        return `[${timeStr}] ${author}: ${row.text}`;
      });

      const content = lines.join('\n');
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = currentChannel === 'main' ? 'feed' : currentChannel;
      a.href = url;
      a.download = `inout-${name}.txt`;
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

function autoResize(el) {
  const target = (el && el.nodeType === 1) ? el : input;
  if (!target) return;
  target.style.height = 'auto';
  target.style.height = Math.min(target.scrollHeight, 160) + 'px';
}

/* ═══ SCROLL ══════════════════════════════════════════════ */
var scrollSaveTimer = null;
if (feedEl) {
feedEl.addEventListener('scroll', () => {
    atBottom = isNearBottom();
  if (atBottom) scrollBtn.classList.remove('visible');
    viewScroll.set(currentView, feedEl.scrollTop);
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveScrollState, 200);
    if (document.body.classList.contains('dnd-active')) updateOriginLinePosition();
}, { passive: true });
}

/* FLIP animation: smooth shift of rows when reordering during drag */
function flipAnimateShift(feedInner, dragging, oldRects, rowsArray) {
  // FLIP animation disabled to avoid extra ghost line at previous position.
  // Keep function for API compatibility; no-op for now.
}

/* Single feed-level DnD: only the feed handles dragover/drop so drop always fires reliably */
var feedDragoverRaf = null;
var feedDragoverLast = null;
var lastDragClientX = null;
var lastDragClientY = null;
var lastIndicatorStyle = { left: -1, width: -1, top: -1, visible: false };
var lastDragTargetRow = null;
var dragSpiritEl = null;
function processFeedDragover(ev) {
  // Determine which feed/view this drag event is over.
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
  const dragging = localFeedInner.querySelector('.obj.dragging');
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
feedEl.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('application/x-inout-draft')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return;
  }
  const dragging = feedInner ? feedInner.querySelector('.obj.dragging') : null;
  const draggingFromSecondary = secondaryFeedInner && secondaryFeedInner.querySelector('.obj.dragging');
  if (!feedInner || (!dragging && !draggingFromSecondary && !originGhostsActive)) return;
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
  const fromSecondary = secondaryFeedInner && secondaryFeedInner.querySelector('.obj.dragging');
  if (fromSecondary && secondaryViewChannel && currentChannel !== secondaryViewChannel) {
    e.preventDefault();
    e.stopPropagation();
    dragDropHandled = true;
    const id = e.dataTransfer.getData('application/x-inout-obj-id') || e.dataTransfer.getData('text/plain');
    const numId = Number(id);
    if (Number.isFinite(numId)) {
      const rowEl = fromSecondary;
      animateObjectToView(rowEl, feedEl, async () => {
        const ok = await moveSingleObject(numId, currentChannel);
        if (rowEl.parentNode) rowEl.parentNode.removeChild(rowEl);
        if (ok) {
          if (currentUser) await loadObjects();
          else await loadLocalObjectsForCurrentView();
        } else if (rowEl) rowEl.style.visibility = '';
      });
    }
    return;
  }
  if (feedInner && (feedInner.querySelector('.obj.dragging') || originGhostsActive)) {
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
}

// Dragover: when over feed, run processFeedDragover (primary reorder) or show indicator (drag from secondary). When outside feed, show indicator at top/bottom.
document.addEventListener('dragover', e => {
  if (!feedEl || !feedInner) return;
  const draggingPrimary = feedInner.querySelector('.obj.dragging');
  const draggingSecondary = secondaryFeedInner && secondaryFeedInner.querySelector('.obj.dragging');
  if (!draggingPrimary && !draggingSecondary && !originGhostsActive) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  lastDragClientX = e.clientX;
  lastDragClientY = e.clientY;
  const targetFeed = (e.target && e.target.closest && e.target.closest('.feed')) || feedEl;
  const feedRect = targetFeed.getBoundingClientRect();
  const y = e.clientY;
  const x = e.clientX;
  const inFeed = x >= feedRect.left && x <= feedRect.right && y >= feedRect.top && y <= feedRect.bottom;
  if (inFeed) {
    if (draggingPrimary || originGhostsActive) {
    processFeedDragover(e);
    } else if (draggingSecondary) {
      if (!feedDropIndicatorEl) {
        feedDropIndicatorEl = document.createElement('div');
        feedDropIndicatorEl.className = 'feed-drop-indicator';
        document.body.appendChild(feedDropIndicatorEl);
      }
      feedDropIndicatorEl.style.left = feedRect.left + 'px';
      feedDropIndicatorEl.style.width = feedRect.width + 'px';
      feedDropIndicatorEl.style.height = '4px';
      feedDropIndicatorEl.style.top = (feedRect.bottom - 2) + 'px';
      feedDropIndicatorEl.classList.add('visible');
      lastIndicatorStyle = { left: feedRect.left, width: feedRect.width, top: feedRect.bottom - 2, visible: true };
    }
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
  feedEl.scrollTop = feedEl.scrollHeight;
  if (scrollBtn) scrollBtn.classList.remove('visible');
  atBottom = true;
}

/* ═══ UTILS ═══════════════════════════════════════════════ */

// Pure helpers for view state (order, selection) – safe to reuse across controllers.
function normalizeOrder(list, order) {
  if (!Array.isArray(list) || !list.length) return [];
  if (!Array.isArray(order) || !order.length) return list
    .map(m => (m && typeof m.id !== 'undefined') ? Number(m.id) : null)
    .filter(id => Number.isFinite(id));
  const byId = new Set(list.map(m => (m && typeof m.id !== 'undefined') ? Number(m.id) : null).filter(id => Number.isFinite(id)));
  const out = [];
  order.forEach(id => {
    id = Number(id);
    if (Number.isFinite(id) && byId.has(id)) {
      out.push(id);
      byId.delete(id);
    }
  });
  byId.forEach(id => out.push(id));
  return out;
}

function toggleIdInSet(set, id, on) {
  if (!set || !Number.isFinite(id)) return;
  if (on === true) {
    set.add(id);
  } else if (on === false) {
    set.delete(id);
  } else {
    if (set.has(id)) set.delete(id); else set.add(id);
  }
}
var formatTimeCache = new Map();
var formatTimeCacheMax = 200;
function formatTime(iso) {
  var cached = formatTimeCache.get(iso);
  if (cached !== undefined) return cached;
  const d = new Date(iso);
  const s = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (formatTimeCache.size >= formatTimeCacheMax) {
    var first = formatTimeCache.keys().next().value;
    if (first !== undefined) formatTimeCache.delete(first);
  }
  formatTimeCache.set(iso, s);
  return s;
}

function escapeHtml(s) {
  return s
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function linkify(s) {
  return s.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function toast(msg, dur = 2800) {
  clearTimeout(toastTimer);
  const s = typeof msg === 'string' ? msg : String(msg);
  toastEl.textContent = s;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
  if (s.toLowerCase().includes('failed') || s.toLowerCase().includes('error')) logError(s);
}

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
function ensureLoaderMinDisplay() {
  var w = loaderMinUntil - Date.now();
  if (w > 0) return new Promise(function(r) { setTimeout(r, w); });
  return Promise.resolve();
}
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
      if (document.visibilityState === 'visible' && typeof input !== 'undefined' && input && document.activeElement && document.activeElement !== input && !/^(INPUT|TEXTAREA|BUTTON|SELECT)$/.test((document.activeElement.tagName || '').toUpperCase())) {
        setTimeout(function() { input.focus(); }, 0);
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
  function openModal(){ if(channelBack) channelBack.style.display='none'; if(back){ back.style.display='block'; back.setAttribute('aria-hidden','false'); } }
  function closeModal(){ if(back){ back.style.display='none'; back.setAttribute('aria-hidden','true'); } }
  if(btn){ btn.onclick = openModal; }
  if(closeBtn){ closeBtn.onclick = closeModal; }
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
