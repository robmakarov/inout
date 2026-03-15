try { if (document.body) document.body.classList.add('loaded'); } catch (_) {}
(function(){
  try {
    if (localStorage.getItem('inout_was_editing_v1')) {
      localStorage.setItem('inout_input_state_v2', '');
      localStorage.removeItem('inout_was_editing_v1');
      var el = document.getElementById('msg-input');
      if (el) { el.value = ''; el.placeholder = 'say something…'; }
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
  if (typeof supabase !== 'undefined') {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { detectSessionInUrl: true } });
  }
} catch(e) {}
if (typeof window !== 'undefined') window.sb = sb;
(function attachAuthButtonEarly() {
  var btn = document.getElementById('um-auth-btn');
  if (!btn) return;
  btn.addEventListener('click', function authBtnClick() {
    if (typeof signIn === 'function') signIn();
    else if (sb && sb.auth && typeof sb.auth.signInWithOAuth === 'function') {
      var redirectTo = window.location.origin ? window.location.origin + '/' : undefined;
      sb.auth.signInWithOAuth({ provider: 'google', options: redirectTo ? { redirectTo: redirectTo } : {} }).then(function(r) {
        if (r && r.data && r.data.url) window.location.href = r.data.url;
      }).catch(function(err) {
        if (typeof toast === 'function') toast('Sign-in failed');
        else if (console && console.error) console.error(err);
      });
    }
  });
})();
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
const input      = document.getElementById('msg-input');
const sendBtn    = document.getElementById('send-btn');
const clearInputBtn = document.getElementById('clear-input');
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
const msgCountEl = document.getElementById('msg-count');
const toastEl    = document.getElementById('toast');
const userBtn    = document.getElementById('user-btn');
const umBackdrop = document.getElementById('user-modal-backdrop');
const umClose    = document.getElementById('user-close');
const umAuthStatus = document.getElementById('um-auth-status');
const umAuthBtn    = document.getElementById('um-auth-btn');
const umUserId     = document.getElementById('um-user-id');
const umCopyIdBtn  = document.getElementById('um-copy-id');
const umNickname   = document.getElementById('um-nickname');
const umNickSave   = document.getElementById('um-nick-save');
const umVersionBadge = document.getElementById('um-version-badge');
const umUpgradeBtn   = document.getElementById('um-upgrade-btn');
const tabsEl     = document.getElementById('tabs');
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

(function ensureModalsClosedOnLoad() {
  if (umBackdrop) { umBackdrop.style.display = 'none'; umBackdrop.setAttribute('aria-hidden', 'true'); }
  if (cmBackdrop) cmBackdrop.style.display = 'none';
  if (logDropupPanel) logDropupPanel.classList.remove('open');
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

let msgCount    = 0;
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
let currentChannel = 'main';
let channels       = ['main'];
const CHANNELS_KEY         = 'inout_channels_v1';
const LEFT_CHANNELS_KEY    = 'inout_left_channels_v1';
const CURRENT_CHANNEL_KEY  = 'inout_current_channel_v1';
const INPUT_STATE_KEY      = 'inout_input_state_v2';
const FIELD_PREFS_KEY      = 'inout_field_prefs_v1';
const ORDER_STATE_KEY      = 'inout_order_state_v1';
const SCROLL_STATE_KEY     = 'inout_scroll_state_v1';
const WAS_EDITING_KEY      = 'inout_was_editing_v1';
const AUTH_BACKUP_KEY     = 'inout_auth_user_backup';
const seenIds       = new Set();
const channelScroll = new Map();
function loadScrollState() {
  try {
    var raw = localStorage.getItem(SCROLL_STATE_KEY);
    if (!raw) return;
    var o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k) && typeof o[k] === 'number' && o[k] >= 0) channelScroll.set(k, o[k]);
    }
  } catch (_) {}
}
function saveScrollState() {
  try {
    var o = {};
    channelScroll.forEach(function(v, k) { o[k] = v; });
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
  const rows = Array.from(feedInner.querySelectorAll('.msg'));
  let changed = false;
  for (const r of rows) {
    const rRect = r.getBoundingClientRect();
    const rowTop = rRect.top - feedRect.top + scrollTop;
    const rowBottom = rowTop + rRect.height;
    const overlaps = rowBottom > rectTop && rowTop < rectBottom;
    const desired = overlaps ? (mode === 'select') : (startRowStates.get(r) ?? false);
    const box = r.querySelector('.msg-select');
    const id = r.dataset.id != null ? Number(r.dataset.id) : NaN;
    if (!box || !Number.isFinite(id)) continue;
    if (box.checked === desired) continue;
    box.checked = desired;
    if (box.checked) {
      selectedIds.add(id);
      r.classList.add('msg-selected');
    } else {
      selectedIds.delete(id);
      r.classList.remove('msg-selected');
    }
    changed = true;
  }
  if (changed) updateSelectionUI();
}

function toggleRowAtY(feedInner, clientY) {
  if (!feedInner) return;
  const rows = Array.from(feedInner.querySelectorAll('.msg'));
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      const box = r.querySelector('.msg-select');
      const id = r.dataset.id != null ? Number(r.dataset.id) : NaN;
      if (!box || !Number.isFinite(id)) continue;
      box.checked = !box.checked;
      if (box.checked) {
        selectedIds.add(id);
        r.classList.add('msg-selected');
      } else {
        selectedIds.delete(id);
        r.classList.remove('msg-selected');
      }
      updateSelectionUI();
      return;
    }
  }
}
let editingMessageId = null;
let fieldPrefs = { showTime:true, showAuthor:true };
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
  if (currentUser) {
    try {
      sb.from('action_log').insert({
        id: entry.id,
        user_id: currentUser.id,
        device_id: myId,
        type: 'action',
        action: entry.action,
        details: entry.details || {},
        message: null,
      }).then(() => {}).catch(() => {});
    } catch (_) {}
  }
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
      const { error } = await sb.from('entries').insert(rows);
      if (error) throw error;
      if (feedEl) feedEl.classList.add('feed-updating');
      requestAnimationFrame(() => {
        const frag = document.createDocumentFragment();
        rows.forEach(e => {
          const row = createMsgRow(e, false);
          if (row) {
            frag.appendChild(row);
            if (e.id != null) currentMessageOrder.push(e.id);
            msgCount++;
          }
        });
        feedInner.appendChild(frag);
        updateMsgCount();
        saveMessageOrderForCurrentChannel();
        applyFieldPrefsToMessages();
        showEmptyIfNoMessages();
        requestAnimationFrame(() => { if (feedEl) feedEl.classList.remove('feed-updating'); });
      });
    } else if (action.type === 'move' && Array.isArray(action.entries) && action.entries.length) {
      const rows = action.entries;
      await Promise.all(rows.map(e => {
        return sb
          .from('entries')
          .update({ channel: e.channel, created_at: e.created_at })
          .eq('user_id', currentUser.id)
          .eq('id', e.id);
      }));
      const forCurrent = rows.filter(e => e.channel === currentChannel);
      if (feedEl) feedEl.classList.add('feed-updating');
      requestAnimationFrame(() => {
        const frag = document.createDocumentFragment();
        forCurrent.forEach(e => {
          const row = createMsgRow(e, false);
          if (row) {
            frag.appendChild(row);
            if (e.id != null) currentMessageOrder.push(e.id);
            msgCount++;
          }
        });
        if (frag.childNodes.length) feedInner.appendChild(frag);
        if (forCurrent.length) {
          saveMessageOrderForCurrentChannel();
          applyMessageOrderToDOM();
          applyFieldPrefsToMessages();
        }
        showEmptyIfNoMessages();
        requestAnimationFrame(() => { if (feedEl) feedEl.classList.remove('feed-updating'); });
      });
    } else if (action.type === 'send' && Array.isArray(action.entries) && action.entries.length) {
      const ids = action.entries.map(e => e.id).filter(Boolean);
      if (ids.length) {
        const { error } = await sb.from('entries').delete().in('id', ids);
        if (error) throw error;
      }
      if (feedEl) feedEl.classList.add('feed-updating');
      requestAnimationFrame(() => {
        ids.forEach(id => {
          const el = feedInner.querySelector('.msg[data-id="' + CSS.escape(String(id)) + '"]');
          if (el) el.remove();
        });
        currentMessageOrder = currentMessageOrder.filter(x => !ids.includes(x));
        msgCount = Math.max(0, msgCount - ids.length);
        updateMsgCount();
        saveMessageOrderForCurrentChannel();
        showEmptyIfNoMessages();
        requestAnimationFrame(() => { if (feedEl) feedEl.classList.remove('feed-updating'); });
      });
    } else if (action.type === 'edit' && Array.isArray(action.entries) && action.entries.length) {
      const rows = action.entries;
      await Promise.all(rows.map(e => {
        return sb
          .from('entries')
          .update({ text: e.beforeText })
          .eq('user_id', currentUser.id)
          .eq('id', e.id);
      }));
      rows.forEach(e => { updateMessageRowText(e.id, e.beforeText); });
      toast('Undid last action.');
      return;
    } else if (action.type === 'view' && action.before && action.channel) {
      if (action.channel !== currentChannel) {
        currentChannel = action.channel;
      }
      fieldPrefs = {
        showTime: !!action.before.showTime,
        showAuthor: !!action.before.showAuthor,
      };
      saveFieldPrefsForCurrentChannel();
      applyFieldPrefsToMessages();
      return;
    } else if (action.type === 'order' && Array.isArray(action.before)) {
      currentMessageOrder = action.before.slice();
      await saveMessageOrderForCurrentChannel();
      applyMessageOrderToDOM();
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
  if (!feedInner) return;
  feedInner.querySelectorAll('.msg.msg-editing').forEach(r => r.classList.remove('msg-editing'));
  if (editingMessageId != null) {
    const row = feedInner.querySelector('.msg[data-id="' + CSS.escape(String(editingMessageId)) + '"]');
    if (row) row.classList.add('msg-editing');
  }
}

function cancelEditingMode(clearInput) {
  editingMessageId = null;
  try { localStorage.removeItem(WAS_EDITING_KEY); } catch (_) {}
  if (input) {
    input.placeholder = 'say something…';
    if (clearInput) {
      input.value = '';
      saveInputGlobal();
      if (currentUser) broadcastDraft('');
    }
    autoResize();
    sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
  }
  updateEditingRowHighlight();
}
let currentMessageOrder = [];
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
let feedDropIndicatorEl = null;
let feedDropOriginEl = null;
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
function showDropOriginLine() {
  if (!feedEl || !feedInner) return;
  var block = (dragSelectedRows && dragSelectedRows.length > 0) ? dragSelectedRows : (feedInner.querySelector('.msg.dragging') ? [feedInner.querySelector('.msg.dragging')] : []);
  if (block.length === 0) return;
  var firstRow = block[0];
  var lastRow = block[block.length - 1];
  /* Capture positions before any msg-drag-group margin is applied */
  originContentTop = firstRow.offsetTop || 0;
  originContentHeight = (lastRow.offsetTop || 0) + (lastRow.offsetHeight || 0) - originContentTop;
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
function hideDropOriginLine() {
  originContentTop = null;
  originContentHeight = null;
  if (feedDropOriginEl) {
    feedDropOriginEl.classList.remove('visible');
    if (feedDropOriginEl.parentNode) feedDropOriginEl.parentNode.removeChild(feedDropOriginEl);
  }
}
function showOriginGhostOverlay(block) {
  if (!feedInner || !block || block.length === 0) return;
  removeOriginGhostOverlay();
  var first = block[0];
  var last = block[block.length - 1];
  var top = first.offsetTop;
  var height = (last.offsetTop + last.offsetHeight) - top;
  if (height < 2) height = 32;
  originGhostOverlayEl = document.createElement('div');
  originGhostOverlayEl.className = 'origin-ghost-overlay msg-origin-ghost';
  originGhostOverlayEl.setAttribute('aria-hidden', 'true');
  originGhostOverlayEl.style.top = top + 'px';
  originGhostOverlayEl.style.height = height + 'px';
  feedInner.appendChild(originGhostOverlayEl);
}
function removeOriginGhostOverlay() {
  if (originGhostOverlayEl && originGhostOverlayEl.parentNode) originGhostOverlayEl.parentNode.removeChild(originGhostOverlayEl);
  originGhostOverlayEl = null;
}
function createOriginGhostFromRow(row) {
  var g = row.cloneNode(true);
  g.classList.remove('msg', 'dragging', 'msg-drag-group', 'msg-selected', 'new-flash', 'msg-editing', 'msg-drag-over', 'msg-drag-target');
  g.classList.add('msg-origin-ghost');
  g.removeAttribute('draggable');
  g.removeAttribute('data-id');
  g.querySelectorAll('.msg-checkbox-zone, .msg-actions, .msg-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
  return g;
}
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
function focusMessageInput() {
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
  channels.forEach(ch => updateTabBadge(ch));
}

function refreshMoveTargets() {
  if (!moveTargetSelect) return;
  moveTargetSelect.innerHTML = '';
  for (const ch of channels) {
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
      var saved = channelScroll.get(currentChannel);
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
  try { if (localStorage.getItem(WAS_EDITING_KEY)) { try { localStorage.setItem(INPUT_STATE_KEY, ''); localStorage.removeItem(WAS_EDITING_KEY); } catch (_) {} if (input) { input.value = ''; input.placeholder = 'say something…'; sendBtn.disabled = true; autoResize(); updateClearInputBtn(); } } } catch (_) {}
  try { loadChannelsList(); } catch (_) {}
  try { loadScrollState(); } catch (_) {}
  try { setupTabs(); } catch (_) {}
  try { restoreLastChannel(); } catch (_) {}
  try { refreshMoveTargets(); } catch (_) {}
  try {
    if (feedInner) {
      feedInner.innerHTML = '';
      if (emptyEl && emptyEl.parentNode) emptyEl.remove();
      showEmptyIfNoMessages();
      if (msgCountEl) updateMsgCount();
    }
  } catch (_) {}
  try { setupAuthListener(); } catch (_) {}
  finish();
  (function runAsync() {
    refreshAuth().then(function() {
      if (typeof cleanupAuthHash === 'function') cleanupAuthHash();
      return Promise.race([
        (async function() {
          if (currentUser) await syncChannelsFromServer();
          await loadMessageOrderForCurrentChannel();
          await loadFieldPrefsForCurrentChannel();
          refreshMoveTargets();
          if (currentUser) {
            await loadMessages();
            (function restoreScrollAfterLoad() {
              var saved = channelScroll.get(currentChannel);
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
            subscribeOrderRealtime();
            subscribeViewRealtime();
            subscribeActionLog();
          }
        })(),
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('timeout')); }, 12000); })
      ]);
    }).catch(function(e) {
      if (e && e.message !== 'timeout') console.error(e);
      try { renderTabs(); } catch (_) {}
      refreshMoveTargets();
      if (currentUser && typeof loadMessages === 'function') loadMessages().catch(function() {});
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
  requestAnimationFrame(focusMessageInput);
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
  // Ctrl/Cmd+Z → undo last destructive action anywhere in the app.
  const isUndoKey = (e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
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
    if (el.closest && el.closest('.msg-actions, .msg-select-wrap')) return true;
    return false;
  }
  document.addEventListener('focusin', () => {
    if (isInteractive(document.activeElement)) return;
    setTimeout(() => { if (input && document.activeElement !== input) input.focus(); }, 0);
  });
  document.addEventListener('click', (e) => {
    if (isInteractive(e.target)) return;
    if (input && document.activeElement !== input) {
      setTimeout(() => { if (input) input.focus(); }, 0);
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest || !t.closest('button')) return;
    if (t.closest('#user-modal') || t.closest('#channel-modal-backdrop')) return;
    setTimeout(() => { if (input) input.focus(); }, 0);
  });
  if (feedEl) {
    feedEl.addEventListener('focus', () => {
      if (input && document.activeElement === feedEl) setTimeout(() => { if (input) input.focus(); }, 0);
    });
  }
  input.addEventListener('focusout', (e) => {
    const next = e.relatedTarget;
    if (next && isInteractive(next)) return;
    if (document.activeElement && (document.activeElement.closest('#user-modal') || document.activeElement.closest('#channel-modal-backdrop'))) return;
    setTimeout(() => { if (input && document.activeElement !== input) input.focus(); }, 0);
  });
}

/* ═══ LOAD ════════════════════════════════════════════════ */
/* entries table fields: id, created_at, text, channel, user_id, author_name */
async function fetchMessagesList() {
  if (!currentUser) return [];
  let query = sb
    .from('entries')
    .select('id, created_at, text, channel, user_id, author_name')
    .eq('channel', currentChannel);
  if (currentChannel === 'main' && currentUser) {
    query = query.eq('user_id', currentUser.id);
  }
  const { data, error } = await query.order('created_at', { ascending: true }).limit(100);
  if (error) { console.error(error); return []; }
  return data && data.length > 0 ? sortMessagesByOrder(data, currentMessageOrder) : [];
}

async function loadMessages() {
  const list = await fetchMessagesList();
  await replaceFeedWithList(list);
}

async function replaceFeedWithList(list) {
  if (!feedInner) return;
  seenIds.clear();
  globalMsgNum = 0;
  msgCount = 0;
  const frag = document.createDocumentFragment();
  for (const msg of list) {
    const row = createMsgRow(msg, false);
    if (row) frag.appendChild(row);
  }
  const hasRows = frag.childNodes.length > 0;
  msgCount = hasRows ? frag.childNodes.length : 0;
  if (hasRows) {
    requestAnimationFrame(() => {
      if (feedInner) {
        feedInner.replaceChildren(frag);
        updateMsgCount();
        applyFieldPrefsToMessages();
        var saved = channelScroll.get(currentChannel);
        if (feedEl && typeof saved === 'number' && saved >= 0) {
          var maxScroll = feedEl.scrollHeight - feedEl.clientHeight;
          if (maxScroll > 0) feedEl.scrollTop = Math.min(saved, maxScroll);
        }
      }
    });
  } else {
    if (emptyEl) feedInner.replaceChildren(emptyEl);
    else feedInner.replaceChildren();
    updateMsgCount();
  }
}

/* ═══ REALTIME ════════════════════════════════════════════ */
function subscribeRealtimeAll() {
  for (const sub of channelSubs.values()) {
    try { sub.unsubscribe(); } catch (_) {}
  }
  channelSubs = new Map();

  if (!currentUser) return;

  channels.forEach(ch => {
    let filter = 'channel=eq.' + ch;
    if (ch === 'main' && currentUser) {
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
      .subscribe();
    channelSubs.set(ch, sub);
  });
}

function updateMessageRowText(msgId, text) {
  if (!feedInner || msgId == null) return;
  const idStr = String(msgId);
  const el = feedInner.querySelector('.msg[data-id="' + CSS.escape(idStr) + '"]');
  if (!el) return;
  const textEl = el.querySelector('.msg-text');
  if (textEl) textEl.innerHTML = linkify(escapeHtml(text || ''));
}

function onUpdateForChannel(ch, row) {
  if (ch !== currentChannel || !row) return;
  const id = row.id != null ? row.id : row.Id;
  if (id == null) return;
  if (id === editingMessageId) {
    editingMessageId = null;
    try { localStorage.removeItem(WAS_EDITING_KEY); } catch (_) {}
    if (input && input.placeholder === 'Editing message…') input.placeholder = 'say something…';
  }
  const text = row.text != null ? row.text : (row.Text != null ? row.Text : '');
  updateMessageRowText(id, text);
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
        await loadMessageOrderForCurrentChannel();
        applyMessageOrderToDOM();
      }
    )
    .subscribe();
}

function subscribeViewRealtime() {
  if (!currentUser) return;
  if (viewSub) {
    try { viewSub.unsubscribe(); } catch (_) {}
    viewSub = null;
  }
  viewSub = sb
    .channel('views-' + currentUser.id)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'views',
        filter: 'user_id=eq.' + currentUser.id
      },
      payload => {
        const row = payload.new || payload.old || {};
        if (!row || row.channel !== currentChannel || !row.config) return;
        if (suppressNextViewApply) { suppressNextViewApply = false; return; }
        if (Date.now() < suppressOrderApplyUntil) return;
        const cfg = row.config || {};
        // Update order
        if (Array.isArray(cfg.order)) {
          currentMessageOrder = cfg.order
            .map(x => Number(x))
            .filter(x => Number.isFinite(x));
          saveOrderToLocal();
          applyMessageOrderToDOM();
        }
        // Update field prefs
        const defTime = true;
        const defAuthor = currentChannel === 'main' ? false : true;
        fieldPrefs = {
          showTime: typeof cfg.showTime === 'boolean' ? cfg.showTime : defTime,
          showAuthor: typeof cfg.showAuthor === 'boolean' ? cfg.showAuthor : defAuthor,
        };
        saveFieldPrefsForCurrentChannel();
        applyFieldPrefsToMessages();
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
  if (ch === currentChannel) {
        hideEmpty();
    appendMsg(msg, true);
        msgCount++;
        updateMsgCount();
    // Always keep the newest message visible (messenger behavior).
          requestAnimationFrame(scrollBottom);
    return;
  }

  const next = (unreadCounts.get(ch) || 0) + 1;
  unreadCounts.set(ch, next);
  updateTabBadge(ch);
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

/* ═══ CROSS-DEVICE DRAFTS (SAME USER) ══════════════════════ */
function setupDraftChannel() {
  teardownDraftChannel();
  latestRemoteDraft = '';
  if (!currentUser) return;

  draftChannel = sb
    .channel('drafts-' + currentUser.id, {
      config: {
        broadcast: { self: false }
      }
    })
    .on('broadcast', { event: 'draft' }, payload => {
      const data = payload.payload || {};
      if (!data || data.from === myId) return; // ignore own events
      const text = (data.text || '').trim();
      latestRemoteDraft = text;
      if (text) {
        showDraftBubble(text);
      } else {
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
  if (!draftChannel || !currentUser) return;
  draftChannel.send({
    type: 'broadcast',
    event: 'draft',
    payload: { from: myId, text: text || '' }
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

function showEmptyIfNoMessages() {
  if (!feedInner || !emptyEl) return;
  const hasMsg = feedInner.querySelector('.msg');
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
  if (selectedIds.size > 0 && !selectMode) {
    selectModeAutoOn = true;
    setSelectMode(true);
  } else if (selectedIds.size === 0 && selectModeAutoOn) {
    selectModeAutoOn = false;
    setSelectMode(false);
  }
}

function restoreLastChannel() {
  try {
    const saved = localStorage.getItem(CURRENT_CHANNEL_KEY);
    if (!saved) return;
    if (!channels.includes(saved)) return;
    currentChannel = saved;
    updateTabsUI();
  } catch (_) {}
}

function restoreInputGlobal() {
  if (!input) return;
  try {
    input.value = localStorage.getItem(INPUT_STATE_KEY) || '';
    autoResize();
    sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
  } catch (_) {}
}

function saveInputGlobal() {
  if (!input) return;
  try {
    localStorage.setItem(INPUT_STATE_KEY, input.value || '');
  } catch (_) {}
}

function updateClearInputBtn() {
  if (!clearInputBtn || !input) return;
  clearInputBtn.disabled = !input.value;
}

function applyFieldPrefsUI() {
  if (fieldTimeChk) fieldTimeChk.checked = !!fieldPrefs.showTime;
  if (fieldAuthorChk) {
    const isMain = currentChannel === 'main';
    fieldAuthorChk.disabled = isMain;
    fieldAuthorChk.checked = !isMain && !!fieldPrefs.showAuthor;
  }
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
        };
        try {
          const raw = localStorage.getItem(FIELD_PREFS_KEY);
          const map = raw ? JSON.parse(raw) : {};
          map[currentChannel] = { showTime: !!fieldPrefs.showTime, showAuthor: !!fieldPrefs.showAuthor };
          localStorage.setItem(FIELD_PREFS_KEY, JSON.stringify(map));
        } catch (_) {}
        applyFieldPrefsUI();
        applyFieldPrefsToMessages();
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
    };
  } catch (_) {
    fieldPrefs = { showTime: true, showAuthor: currentChannel !== 'main' };
  }
  applyFieldPrefsUI();
  applyFieldPrefsToMessages();
}

function saveFieldPrefsForCurrentChannel() {
  try {
    const raw = localStorage.getItem(FIELD_PREFS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[currentChannel] = {
      showTime: !!fieldPrefs.showTime,
      showAuthor: !!fieldPrefs.showAuthor,
    };
    localStorage.setItem(FIELD_PREFS_KEY, JSON.stringify(map));
  } catch(_) {}
  // Also persist into unified view config so other devices see it.
  if (currentUser) {
    const cfg = {
      order: currentMessageOrder.slice(),
      showTime: !!fieldPrefs.showTime,
      showAuthor: !!fieldPrefs.showAuthor,
    };
    sb
      .from('views')
      .upsert(
        {
          user_id: currentUser.id,
          channel: currentChannel,
          config: cfg,
        },
        { onConflict: 'user_id,channel' }
      )
      .then(() => {})
      .catch(() => {});
  }
}

function applyFieldPrefsToMessages() {
  if (!feedInner || !fieldPrefs) return;
  const rows = feedInner.querySelectorAll('.msg');
  rows.forEach(row => {
    const timeEl = row.querySelector('.msg-time');
    const senderEl = row.querySelector('.msg-sender');
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
    const rows = Array.from(feedInner.querySelectorAll('.msg'));
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
    if (feedInner) feedInner.querySelectorAll('.msg-drag-group').forEach(function(r) { r.classList.remove('msg-drag-group'); });
    dragSelectedRows = [];
    clearEdgeScrollInterval();
    clearTimeout(touchDragState.timer);
    document.removeEventListener('touchmove', move, { passive: false });
    document.removeEventListener('touchend', end);
    hideDropOriginLine();
    const r = touchDragState.row;
    r.classList.remove('dragging');
    if (document.body) {
      document.body.classList.remove('dnd-active');
      document.body.classList.add('dnd-just-ended');
    }
    touchDragState.started = false;
    touchDragState.row = null;
    touchDragState.originLineShown = false;
    recomputeOrderFromDOM();
    saveMessageOrderForCurrentChannel();
    applyFieldPrefsToMessages();
    r.style.pointerEvents = 'none';
    void r.offsetHeight;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (document.body) document.body.classList.remove('dnd-just-ended');
        r.style.pointerEvents = '';
        focusMessageInput();
      });
    });
  };
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end);
}

function createMsgRow(msg, isNew) {
  if (msg && typeof msg.id !== 'undefined') {
    if (seenIds.has(msg.id)) return null;
    seenIds.add(msg.id);
  }
  // remove empty state
  if (emptyEl.parentNode) emptyEl.remove();

  const row  = document.createElement('div');
  row.className = 'msg' + (isNew ? ' new-flash' : '');
  if (typeof msg.id !== 'undefined') row.dataset.id = String(msg.id);
  row.draggable = true;
  row.addEventListener('dragstart', e => {
    if (pointerDownOnSelectArea) {
      e.preventDefault();
      pointerDownOnSelectArea = false;
      return;
    }
    if (dragSpiritEl && dragSpiritEl.parentNode) dragSpiritEl.parentNode.removeChild(dragSpiritEl);
    dragSpiritEl = row.cloneNode(true);
    dragSpiritEl.classList.remove('dragging', 'msg-drag-group', 'msg-selected', 'new-flash', 'msg-editing', 'msg-drag-over', 'msg-drag-target', 'dragging-in-feed');
    dragSpiritEl.classList.add('msg', 'msg-drag-spirit');
    dragSpiritEl.removeAttribute('draggable');
    dragSpiritEl.setAttribute('aria-hidden', 'true');
    dragSpiritEl.style.width = Math.max(200, (row.offsetWidth || 280)) + 'px';
    dragSpiritEl.style.left = (e.clientX || 0) + 'px';
    dragSpiritEl.style.top = (e.clientY || 0) + 'px';
    dragSpiritEl.querySelectorAll('.msg-checkbox-zone, .msg-actions, .msg-select-wrap').forEach(function(el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    document.body.appendChild(dragSpiritEl);
    if (!dragImageEl) {
      dragImageEl = document.createElement('div');
      dragImageEl.setAttribute('aria-hidden', 'true');
      dragImageEl.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
      document.body.appendChild(dragImageEl);
    }
    if (dragImageEl.parentNode !== document.body) document.body.appendChild(dragImageEl);
    e.dataTransfer.setDragImage(dragImageEl, -9999, -9999);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', typeof msg.text === 'string' ? msg.text : '');
    if (typeof msg.id !== 'undefined') e.dataTransfer.setData('application/x-inout-msg-id', String(msg.id));
    if (feedInner && selectedIds.has(msg.id) && selectedIds.size > 1) {
      dragSelectedRows = Array.from(feedInner.querySelectorAll('.msg.msg-selected'));
    } else {
      dragSelectedRows = [row];
    }
    dragSelectedRows.forEach(function(r) {
      if (dragSelectedRows.length > 1) r.classList.add('msg-drag-group');
      r.classList.add('dragging-in-feed');
    });
    row.classList.add('dragging');
    showOriginGhostOverlay(dragSelectedRows.slice());
    if (document.body) document.body.classList.add('dnd-active');
    savedOrderBeforeDrag = currentMessageOrder.slice();
    dragDropHandled = false;
    if (feedInner) feedInner.querySelectorAll('.msg-drag-over').forEach(r => r.classList.remove('msg-drag-over'));
  });
  row.addEventListener('dragend', () => {
    requestAnimationFrame(() => {
      try {
        if (lastReorderTarget && !originGhostsActive && feedInner && dragSelectedRows.length) {
          var insertBefore = lastReorderTarget.insertBefore;
          var wantAppend = lastReorderTarget.wantAppend;
          var block = dragSelectedRows.length > 1 ? dragSelectedRows.slice() : [row];
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
          } else {
            if (wantAppend) feedInner.appendChild(row);
            else if (insertBefore && insertBefore.parentNode === feedInner) feedInner.insertBefore(row, insertBefore);
          }
        }
        if (dragSpiritEl && dragSpiritEl.parentNode) dragSpiritEl.parentNode.removeChild(dragSpiritEl);
        dragSpiritEl = null;
        removeOriginGhostOverlay();
        if (feedInner) feedInner.querySelectorAll('.msg.dragging-in-feed').forEach(r => r.classList.remove('dragging-in-feed'));
        removeOriginGhostsAndInsertRows();
        if (feedInner) feedInner.querySelectorAll('.msg-drag-group').forEach(r => r.classList.remove('msg-drag-group'));
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
        if (feedInner) feedInner.querySelectorAll('.msg-drag-over, .msg-drag-target').forEach(r => r.classList.remove('msg-drag-over', 'msg-drag-target', 'msg-drag-nudge-right'));
        row.classList.remove('dragging');
        tabsEl.querySelectorAll('.tab.tab-drop-target').forEach(t => t.classList.remove('tab-drop-target'));
        const domOrder = feedInner ? Array.from(feedInner.querySelectorAll('.msg')).map(r => Number(r.dataset.id)).filter(id => Number.isFinite(id)) : [];
        const orderChanged = !dragDropHandled && domOrder.length === savedOrderBeforeDrag.length && domOrder.some((id, i) => id !== savedOrderBeforeDrag[i]);
        if (!dragDropHandled && !orderChanged) {
          currentMessageOrder = savedOrderBeforeDrag.slice();
          applyMessageOrderToDOM();
          saveMessageOrderForCurrentChannel();
        } else {
          recomputeOrderFromDOM();
          saveMessageOrderForCurrentChannel();
        }
        applyFieldPrefsToMessages();
        row.style.pointerEvents = 'none';
        void row.offsetHeight;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (document.body) document.body.classList.remove('dnd-just-ended');
            row.style.pointerEvents = '';
            focusMessageInput();
          });
        });
      } finally {
        if (dragSpiritEl && dragSpiritEl.parentNode) dragSpiritEl.parentNode.removeChild(dragSpiritEl);
        dragSpiritEl = null;
        lastDragClientX = null;
        lastDragClientY = null;
        removeOriginGhostOverlay();
        if (feedInner) feedInner.querySelectorAll('.msg.dragging-in-feed').forEach(r => r.classList.remove('dragging-in-feed'));
        hideDropOriginLine();
        if (feedDropIndicatorEl) feedDropIndicatorEl.classList.remove('visible');
        lastIndicatorStyle = { left: -1, width: -1, top: -1, visible: false };
      }
    });
  });
  /* row-level dragover/drop removed: feed is the single drop target for reliable reorder */
  row.addEventListener('touchstart', e => {
    if (!feedInner) return;
    if (e.target.closest('.msg-checkbox-zone')) return;
    const contentLeft = row.querySelector('.msg-time') || row.querySelector('.msg-sender') || row.querySelector('.msg-text');
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
      if (feedInner && selectedIds.has(msg.id) && selectedIds.size > 1) {
        dragSelectedRows = Array.from(feedInner.querySelectorAll('.msg.msg-selected'));
      } else {
        dragSelectedRows = [row];
      }
      dragSelectedRows.forEach(function(r) {
        if (dragSelectedRows.length > 1) r.classList.add('msg-drag-group');
      });
      row.classList.add('dragging');
      if (document.body) document.body.classList.add('dnd-active');
      /* origin line shown on first touchmove, not here, so it doesn't appear on long-press alone */
    }, 300); // long press threshold
  }, { passive: true });
  if (isNew) setTimeout(() => row.classList.remove('new-flash'), 800);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const actionDelete = document.createElement('button');
  actionDelete.className = 'msg-action-btn';
  actionDelete.textContent = 'Del';
  actionDelete.addEventListener('click', e => {
    e.stopPropagation();
    if (!msg.id) return;
    deleteSingleMessage(msg.id);
  });

  const actionMove = document.createElement('button');
  actionMove.className = 'msg-action-btn';
  actionMove.textContent = 'Move';
  actionMove.addEventListener('click', e => {
    e.stopPropagation();
    if (!msg.id) return;
    moveSingleMessage(msg.id);
  });

  const actionExport = document.createElement('button');
  actionExport.className = 'msg-action-btn';
  actionExport.textContent = 'Exp';
  actionExport.addEventListener('click', e => {
    e.stopPropagation();
    if (!msg.id) return;
    exportSingleMessage(msg.id);
  });

  const actionCopy = document.createElement('button');
  actionCopy.className = 'msg-action-btn';
  actionCopy.textContent = 'Copy';
  actionCopy.addEventListener('click', e => {
    e.stopPropagation();
    if (!msg.text) return;
    try {
      navigator.clipboard.writeText(msg.text);
      toast('Message copied.');
    } catch (err) {
      console.error(err);
      toast('Could not copy.');
    }
  });

  actions.appendChild(actionDelete);
  actions.appendChild(actionMove);
  actions.appendChild(actionExport);
  actions.appendChild(actionCopy);

  const sender = document.createElement('div');
  sender.className = 'msg-sender';
  if (msg.author_name) {
    sender.textContent = String(msg.author_name);
  } else if (msg.user_id && currentUser && msg.user_id === currentUser.id) {
    const nick = currentUser.user_metadata && currentUser.user_metadata.nickname
      ? String(currentUser.user_metadata.nickname)
      : 'you';
    sender.textContent = nick;
  } else if (msg.user_id) {
    sender.textContent = String(msg.user_id);
  } else {
    sender.textContent = 'unknown';
  }
  const fullLabel = sender.textContent;
  if (fullLabel.length > 10) {
    sender.textContent = fullLabel.slice(0, 10) + '…';
  }

  const isMainFeed = (msg.channel && msg.channel === 'main') || (!msg.channel && currentChannel === 'main');
  const wantAuthor = !isMainFeed && (!!fieldPrefs ? !!fieldPrefs.showAuthor : true);
  sender.style.setProperty('display', wantAuthor ? 'flex' : 'none', 'important');

  const selectWrap = document.createElement('div');
  selectWrap.className = 'msg-select-wrap';
  const selectBox = document.createElement('input');
  selectBox.type = 'checkbox';
  selectBox.className = 'msg-select';
  selectBox.addEventListener('change', () => {
    if (!msg.id) return;
    if (selectBox.checked) {
      selectedIds.add(msg.id);
      row.classList.add('msg-selected');
    } else {
      selectedIds.delete(msg.id);
      row.classList.remove('msg-selected');
    }
    updateSelectionUI();
  });
  selectWrap.appendChild(selectBox);
  const checkboxZone = document.createElement('div');
  checkboxZone.className = 'msg-checkbox-zone';
  const zoneLeft = document.createElement('div');
  zoneLeft.className = 'msg-checkbox-zone-left';
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
      selectedIds.add(msg.id);
      row.classList.add('msg-selected');
    } else {
      selectedIds.delete(msg.id);
      row.classList.remove('msg-selected');
    }
    if (!selectMode) {
      selectModeAutoOn = true;
      setSelectMode(true);
    }
    updateSelectionUI();
  }, true);
  checkboxZone.addEventListener('mousedown', e => {
    if (!msg.id) return;
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
      feedInner.querySelectorAll('.msg').forEach(r => {
        const box = r.querySelector('.msg-select');
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
    if (!msg.id || e.touches.length !== 1) return;
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
      feedInner.querySelectorAll('.msg').forEach(r => {
        const box = r.querySelector('.msg-select');
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

  /* long-press on message row (anywhere except checkbox-zone/actions/links) starts drag-select; any movement before delay cancels so reorder doesn't trigger */
  row.addEventListener('mousedown', e => {
    if (!msg.id) return;
    if (e.target.closest('.msg-checkbox-zone, .msg-actions') || (e.target.closest('a') && e.target.closest('.msg-text'))) return;
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
      feedInner.querySelectorAll('.msg').forEach(r => {
        const box = r.querySelector('.msg-select');
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
    if (!msg.id || e.touches.length !== 1) return;
    if (e.target.closest('.msg-checkbox-zone, .msg-actions') || (e.target.closest('a') && e.target.closest('.msg-text'))) return;
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
      feedInner.querySelectorAll('.msg').forEach(r => {
        const box = r.querySelector('.msg-select');
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
  time.className = 'msg-time';
  time.textContent = formatTime(msg.created_at);
  if (fieldPrefs) time.style.setProperty('display', fieldPrefs.showTime ? 'block' : 'none', 'important');

  const text = document.createElement('div');
  text.className = 'msg-text';
  text.innerHTML = linkify(escapeHtml(msg.text));
  text.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    e.stopPropagation();
    if (typeof msg.id === 'undefined') return;
    if (selectMode && editingMessageId) {
      cancelEditingMode(true);
      setTimeout(() => { saveInputGlobal(); if (input) input.focus(); }, 0);
      return;
    }
    if (Number(msg.id) === Number(editingMessageId)) {
      cancelEditingMode(true);
      setTimeout(() => { saveInputGlobal(); if (input) input.focus(); }, 0);
      return;
    }
    input.value = msg.text || '';
    editingMessageId = msg.id;
    try { localStorage.setItem(WAS_EDITING_KEY, '1'); } catch (_) {}
    input.placeholder = 'Editing message…';
    autoResize();
    sendBtn.disabled = !input.value.trim();
    updateClearInputBtn();
    saveInputGlobal();
    updateEditingRowHighlight();
    focusMessageInput();
  });

  row.addEventListener('click', e => {
    if (e.target.closest('.msg-checkbox-zone')) return;
    if (e.target.closest('.msg-text')) return;
    if (selectMode) {
      if (e.target.closest('.msg-actions')) return;
      if (dragSelectJustEnded || dragSelectToggledByTouch) return;
      e.preventDefault();
      e.stopPropagation();
      selectBox.checked = !selectBox.checked;
      if (selectBox.checked) {
        selectedIds.add(msg.id);
        row.classList.add('msg-selected');
  } else {
        selectedIds.delete(msg.id);
        row.classList.remove('msg-selected');
      }
      updateSelectionUI();
      return;
    }
    if (!editingMessageId) return;
    if (String(row.dataset.id) !== String(editingMessageId)) return;
    if (e.target.closest('button, a, .msg-actions, .msg-select, .msg-select-wrap')) return;
    e.stopPropagation();
    e.preventDefault();
    cancelEditingMode(true);
    setTimeout(() => { saveInputGlobal(); if (input) input.focus(); }, 0);
  }, true);

  row.appendChild(checkboxZone);
  row.appendChild(time);
  row.appendChild(sender);
  row.appendChild(text);
  row.appendChild(actions);
  row.addEventListener('mousedown', e => {
    if (e.target.closest('.msg-checkbox-zone')) return;
    const contentLeft = row.querySelector('.msg-time') || row.querySelector('.msg-sender') || row.querySelector('.msg-text');
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

function appendMsg(msg, isNew) {
  const row = createMsgRow(msg, isNew);
  if (!row) return;
  feedInner.appendChild(row);
  // Ensure new messages respect the current view (time/author) settings.
  applyFieldPrefsToMessages();
  if (typeof msg.id !== 'undefined') {
    const idNum = Number(msg.id);
    if (Number.isFinite(idNum)) {
      currentMessageOrder = currentMessageOrder.filter(x => x !== idNum);
      currentMessageOrder.push(idNum);
      saveMessageOrderForCurrentChannel();
    }
  }
}

function sortMessagesByOrder(list, order) {
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

function renderInitialMessages(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  hideEmpty();
  const frag = document.createDocumentFragment();
  for (const msg of list) {
    const row = createMsgRow(msg, false);
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
    const key = currentUser ? (currentUser.id + '::' + currentChannel) : ('anon::' + currentChannel);
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
    const key = currentUser ? (currentUser.id + '::' + currentChannel) : ('anon::' + currentChannel);
    map[key] = (currentMessageOrder || []).slice();
    localStorage.setItem(ORDER_STATE_KEY, JSON.stringify(map));
  } catch (_) {}
}

let globalMsgNum = 0;

function hideEmpty() {
  if (emptyEl.parentNode) emptyEl.remove();
}

function updateMsgCount() {
  msgCountEl.textContent = msgCount + (msgCount === 1 ? ' msg' : ' msgs');
}

/* ═══ TABS ════════════════════════════════════════════════ */
function setupTabs() {
  renderTabs();
}

function updateTabsUI() {
  if (!tabsEl) return;
  const buttons = tabsEl.querySelectorAll('.tab[data-channel]');
  buttons.forEach(btn => {
    const ch = btn.getAttribute('data-channel') || 'main';
    if (ch === currentChannel) {
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
      channels = ['main', ...Array.from(new Set(cleaned))];
    }
  } catch (_) {}
}

function saveChannelsList() {
  try {
    const toSave = channels.filter(ch => ch !== 'main');
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(toSave));
  } catch (_) {}
}

async function loadMessageOrderForCurrentChannel() {
  currentMessageOrder = [];
  // 1) Try unified view object (if table exists and user is signed in).
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
        const orderArr = Array.isArray(cfg.order) ? cfg.order : [];
        currentMessageOrder = orderArr
          .map(x => Number(x))
          .filter(x => Number.isFinite(x));
        // Pull view rules into fieldPrefs and mirror into local storage.
        const defTime = true;
        const defAuthor = currentChannel === 'main' ? false : true;
        fieldPrefs = {
          showTime: typeof cfg.showTime === 'boolean' ? cfg.showTime : defTime,
          showAuthor: typeof cfg.showAuthor === 'boolean' ? cfg.showAuthor : defAuthor,
        };
        saveFieldPrefsForCurrentChannel();
        // also mirror order into local backup
        saveOrderToLocal();
      }
    } catch (e) {
      // views table might not exist yet; fail soft
      console.error(e);
    }
  }
  // 2) If no view-based order, fall back to legacy message_orders + local.
  if (!currentMessageOrder.length && currentUser) {
    try {
      const { data, error } = await sb
        .from('message_orders')
        .select('entry_id, position')
        .eq('user_id', currentUser.id)
        .eq('channel', currentChannel)
        .order('position', { ascending: true });
      if (!error && data && data.length) {
        currentMessageOrder = data
          .map(row => Number(row.entry_id))
          .filter(x => Number.isFinite(x));
      }
    } catch (e) {
      console.error(e);
    }
  }
  // 3) Final fallback: pure local order.
  if (!currentMessageOrder.length) {
    currentMessageOrder = loadOrderFromLocal();
  }
}

let suppressNextOrderApply = false;
let suppressNextViewApply = false;
let suppressOrderApplyUntil = 0; /* ignore realtime order/view applies until this timestamp */

async function saveMessageOrderForCurrentChannel() {
  if (!currentMessageOrder.length) return;
  saveOrderToLocal();
  suppressOrderApplyUntil = Date.now() + 600;
  if (currentUser) {
    try {
      const rows = currentMessageOrder.map((entryId, index) => ({
        user_id: currentUser.id,
        channel: currentChannel,
        entry_id: entryId,
        position: index,
      }));
      suppressNextOrderApply = true;
      const { error } = await sb
        .from('message_orders')
        .upsert(rows, { onConflict: 'user_id,channel,entry_id' });
      if (error) console.error(error);
    } catch (e) { console.error(e); }
  }
  if (currentUser) {
    try {
      const cfg = {
        order: currentMessageOrder.slice(),
        showTime: !!fieldPrefs.showTime,
        showAuthor: !!fieldPrefs.showAuthor,
      };
      suppressNextViewApply = true;
      await sb.from('views').upsert(
        { user_id: currentUser.id, channel: currentChannel, config: cfg },
        { onConflict: 'user_id,channel' }
      );
    } catch (e) { console.error(e); }
  }
}

function recomputeOrderFromDOM() {
  if (!feedInner) return;
  pushUndo({ type: 'order', before: (currentMessageOrder || []).slice() });
  logAction('reorder', { channel: currentChannel });
  const ids = Array.from(feedInner.querySelectorAll('.msg'))
    .map(row => Number(row.dataset.id))
    .filter(id => Number.isFinite(id));
  currentMessageOrder = ids;
}

function applyMessageOrderToDOM() {
  if (!feedInner) return;
  if (!currentMessageOrder.length) return;
  const rows = Array.from(feedInner.querySelectorAll('.msg'));
  if (!rows.length) return;
  // Skip if DOM order already matches — avoids reflow/blink when nothing changed
  const domOrder = rows.map(r => Number(r.dataset.id)).filter(id => Number.isFinite(id));
  if (domOrder.length === currentMessageOrder.length &&
      domOrder.every((id, i) => id === currentMessageOrder[i])) return;
  const byId = new Map();
  rows.forEach(row => {
    const id = Number(row.dataset.id);
    if (Number.isFinite(id)) byId.set(id, row);
  });
  if (!byId.size) return;
  const frag = document.createDocumentFragment();
  currentMessageOrder.forEach(id => {
    const row = byId.get(id);
    if (row) {
      frag.appendChild(row);
      byId.delete(id);
    }
  });
  // append any remaining rows that weren't in the saved order
  byId.forEach(row => frag.appendChild(row));
  feedInner.appendChild(frag);
}

function renderTabs() {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';

  channels.forEach(ch => {
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

    btn.addEventListener('click', () => switchChannel(ch));
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
      const id = e.dataTransfer.getData('application/x-inout-msg-id') || e.dataTransfer.getData('text/plain');
      if (!id || ch === currentChannel) return;
      const numId = Number(id);
      if (!Number.isFinite(numId)) return;
      const rowEl = feedInner.querySelector('.msg[data-id="' + CSS.escape(String(numId)) + '"]');
      if (rowEl) {
        animateMessageToTab(rowEl, btn, async () => {
          const ok = await moveSingleMessage(numId, ch);
          if (!ok) rowEl.style.visibility = '';
        });
      } else {
        moveSingleMessage(numId, ch);
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
    const merged = new Set(['main', ...channels, ...server]);
    channels = Array.from(merged);
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
    // mark channel as shared if it has any member other than me
    const { data, error } = await sb
      .from('channel_members')
      .select('channel,user_id')
      .in('channel', channels)
      .neq('user_id', currentUser.id);
    if (error) {
      console.error(error);
      return;
    }
    (data || []).forEach(r => {
      if (r && typeof r.channel === 'string') sharedChannels.add(r.channel);
    });
  } catch (e) {
    console.error(e);
  }
}

async function switchChannel(ch) {
  if (ch === currentChannel) return;
  if (editingMessageId != null) cancelEditingMode(true);
  if (feedEl) {
    channelScroll.set(currentChannel, feedEl.scrollTop);
    saveScrollState();
  }
  currentChannel = ch;
  try {
    localStorage.setItem(CURRENT_CHANNEL_KEY, currentChannel);
  } catch (_) {}
  unreadCounts.set(ch, 0);
  updateTabsUI();
  updateTabBadge(ch);
  refreshMoveTargets();
  await loadFieldPrefsForCurrentChannel();
  if (currentUser) {
    ensureMembership().then(reloadForUser);
  } else {
    clearMessages();
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
  requestAnimationFrame(focusMessageInput);
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
  if (!channels.includes(name)) {
    channels.push(name);
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
  channels = channels.filter(x => x !== ch);
  saveChannelsList();
  unreadCounts.delete(ch);
  sharedChannels.delete(ch);
  if (currentChannel === ch) {
    currentChannel = 'main';
  }
  renderTabs();
  subscribeRealtimeAll();
  if (currentUser) {
    try {
      sb.from('channel_members').delete().eq('channel', ch).eq('user_id', currentUser.id).then(function() {}).catch(function() {});
    } catch (_) {}
    reloadForUser();
  } else {
    clearMessages();
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
async function refreshAuth() {
  try {
    try {
      var b = sessionStorage.getItem(AUTH_BACKUP_KEY);
      if (b) currentUser = JSON.parse(b);
    } catch (_) {}
    var session = null;
    try {
      var sessionPromise = sb.auth.getSession();
      var sessionResult = await Promise.race([
        sessionPromise,
        new Promise(function(_, rej) { setTimeout(function() { rej(new Error('session timeout')); }, 4000); })
      ]);
      session = (sessionResult && sessionResult.data && sessionResult.data.session) || null;
    } catch (_) {}
    if (session?.user) {
      currentUser = session.user;
    } else if (!currentUser) {
      try {
        var userResult = await Promise.race([
          sb.auth.getUser(),
          new Promise(function(_, rej) { setTimeout(function() { rej(new Error('user timeout')); }, 3000); })
        ]);
        if (userResult && userResult.data && userResult.data.user) currentUser = userResult.data.user;
      } catch (_) {}
    }
    if (!currentUser) {
      try {
        var backup = sessionStorage.getItem(AUTH_BACKUP_KEY);
        if (backup) currentUser = JSON.parse(backup);
      } catch (_) {}
    }
    if (currentUser) try { sessionStorage.setItem(AUTH_BACKUP_KEY, JSON.stringify(currentUser)); } catch (_) {}
  } catch (e) {
    try {
      var b = sessionStorage.getItem(AUTH_BACKUP_KEY);
      if (b) currentUser = JSON.parse(b);
    } catch (_) {}
    if (!currentUser) currentUser = null;
  }
  updateAuthUI();
  if (currentUser) {
    try {
      await refreshSharedFlags();
      renderTabs();
      subscribeRealtimeAll();
      setupDraftChannel();
      restoreLastChannel();
      await loadMessageOrderForCurrentChannel();
      await loadMessages();
      restoreInputGlobal();
    } catch (e) {
      renderTabs();
      try { await loadMessages(); } catch (_) {}
      if (feedInner && emptyEl && !emptyEl.parentNode) feedInner.appendChild(emptyEl);
    }
  } else {
    sharedChannels.clear();
    unreadCounts.clear();
    renderTabs();
    subscribeRealtimeAll();
    teardownDraftChannel();
  }
}

var explicitSignOut = false;
function setupAuthListener() {
  sb.auth.onAuthStateChange(async (event, session) => {
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
        } catch (e) {
          console.error(e);
          renderTabs();
          try { await loadMessages(); } catch (_) {}
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
    try {
      var backup = sessionStorage.getItem(AUTH_BACKUP_KEY);
      if (backup) {
        currentUser = JSON.parse(backup);
        updateAuthUI();
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
}

async function reloadForUser() {
  if (editingMessageId != null) cancelEditingMode(true);
  await loadMessageOrderForCurrentChannel();
  const list = await fetchMessagesList();
  await replaceFeedWithList(list);
  subscribeRealtimeAll();
  var savedScroll = channelScroll.get(currentChannel);
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
  applyFieldPrefsToMessages();
}

function clearMessages() {
  feedInner.innerHTML = '';
  globalMsgNum = 0;
  msgCount = 0;
  updateMsgCount();
  seenIds.clear();
  if (emptyEl && !emptyEl.parentNode) {
    feedInner.appendChild(emptyEl);
  }
}

async function signIn() {
  if (!sb || !sb.auth || typeof sb.auth.signInWithOAuth !== 'function') {
    toast('Sign-in not available in this local build.');
    return;
  }
  try {
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
  if (!sb || !sb.auth || typeof sb.auth.signOut !== 'function') {
    toast('Sign-out not available in this local build.');
    return;
  }
  explicitSignOut = true;
  currentUser = null;
  try { sessionStorage.removeItem(AUTH_BACKUP_KEY); } catch (_) {}
  updateAuthUI();
  clearMessages();
  teardownDraftChannel();
  sharedChannels.clear();
  unreadCounts.clear();
  renderTabs();
  try {
    const { error } = await sb.auth.signOut();
    if (error) console.error(error);
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
  if (!location.hash) return;
  if (!location.hash.includes('access_token=')) return;
  try {
    history.replaceState(null, '', location.pathname + location.search);
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

async function sendText(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  if (!currentUser) {
    toast('Sign in with Google to send.');
    return;
  }

  sendBtn.disabled = true;
  input.disabled   = true;

  if (editingMessageId) {
    const { data: before, error: selErr } = await sb
      .from('entries')
      .select('id, created_at, text, channel, user_id, author_name')
      .eq('id', editingMessageId)
      .eq('user_id', currentUser.id)
      .maybeSingle();
    if (selErr) {
      input.disabled = false;
      console.error(selErr);
      toast('Failed to update — ' + humanError(selErr.message));
      sendBtn.disabled = false;
      return;
    }
    const { data, error } = await sb
      .from('entries')
      .update({ text: trimmed })
      .eq('id', editingMessageId)
      .eq('user_id', currentUser.id)
      .select('id, created_at, text, channel, user_id, author_name')
      .single();
    input.disabled = false;
    if (error) {
      console.error(error);
      toast('Failed to update — ' + humanError(error.message));
      sendBtn.disabled = false;
      return;
    }
    if (before && before.id) {
      pushUndo({ type: 'edit', entries: [{ id: before.id, beforeText: before.text, afterText: trimmed }] });
      logAction('edit', { id: before.id });
    }
    updateMessageRowText(editingMessageId, trimmed);
    cancelEditingMode(true);
    requestAnimationFrame(focusMessageInput);
    return;
  }

  const { data, error } = await sb
    .from('entries')
    .insert({
      text: trimmed,
      user_id: currentUser.id,
      channel: currentChannel,
    })
    .select('id, created_at, text, channel, user_id, author_name')
    .single();

  input.disabled = false;

  if (error) {
    console.error(error);
    const msg = 'Failed to send — ' + humanError(error.message);
    toast(msg);
    logError(msg);
    sendBtn.disabled = false;
  } else {
    if (data && data.channel === currentChannel) {
      hideEmpty();
      appendMsg(data, true);
      msgCount++;
      updateMsgCount();
    }
    if (data) {
      pushUndo({ type: 'send', entries: [data] });
      logAction('send', { channel: currentChannel });
    }
    input.value = '';
    autoResize();
    sendBtn.disabled = true;
    updateClearInputBtn();
    saveInputGlobal();
    requestAnimationFrame(focusMessageInput);
  }
}

/* ═══ INPUT HANDLING ══════════════════════════════════════ */
input.addEventListener('input', () => {
  autoResize();
  sendBtn.disabled = !input.value.trim();
  saveInputGlobal();
  updateClearInputBtn();
  // send current draft for this user so other devices see it
  if (currentUser) {
    broadcastDraft(input.value);
  }
});

input.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (editingMessageId) cancelEditingMode(true);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) send();
  }
});

sendBtn.addEventListener('click', send);

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
    if (currentUser) {
      broadcastDraft('');
    }
  });
}

if (clipboardPasteBtn) {
  clipboardPasteBtn.addEventListener('click', () => {
    if (!latestClipboardText) return;
    input.value = latestClipboardText;
    autoResize();
    sendBtn.disabled = !input.value.trim();
    requestAnimationFrame(focusMessageInput);
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
    if (currentUser) {
      broadcastDraft('');
    }
    requestAnimationFrame(focusMessageInput);
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
        feedInner.querySelectorAll('.msg-select').forEach(box => { box.checked = false; });
        feedInner.querySelectorAll('.msg.msg-selected').forEach(row => row.classList.remove('msg-selected'));
      }
    } else {
      selectModeAutoOn = false;
    }
    setSelectMode(!selectMode);
  });
}

if (selectAllBtn) {
  selectAllBtn.addEventListener('click', () => {
    const boxes = feedInner.querySelectorAll('.msg-select');
    boxes.forEach(box => {
      box.checked = true;
      const row = box.closest('.msg');
      const id = row && row.dataset.id;
      if (id) selectedIds.add(Number(id));
    });
    updateSelectionUI();
  });
}

if (selectNoneBtn) {
  selectNoneBtn.addEventListener('click', () => {
    selectModeAutoOn = false;
    const boxes = feedInner.querySelectorAll('.msg-select');
    boxes.forEach(box => {
      box.checked = false;
    });
    selectedIds.clear();
    feedInner.querySelectorAll('.msg.msg-selected').forEach(row => row.classList.remove('msg-selected'));
    updateSelectionUI();
  });
}

if (fieldTimeChk) {
  fieldTimeChk.addEventListener('change', () => {
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor } });
    fieldPrefs.showTime = !!fieldTimeChk.checked;
    logAction('view', { showTime: !!fieldTimeChk.checked, showAuthor: fieldPrefs.showAuthor });
    saveFieldPrefsForCurrentChannel();
    applyFieldPrefsToMessages();
  });
}

if (fieldAuthorChk) {
  fieldAuthorChk.addEventListener('change', () => {
    // In main feed authors are never shown; keep UI in sync with that rule.
    if (currentChannel === 'main' || fieldAuthorChk.disabled) {
      fieldAuthorChk.checked = false;
      return;
    }
    pushUndo({ type: 'view', channel: currentChannel, before: { showTime: fieldPrefs.showTime, showAuthor: fieldPrefs.showAuthor } });
    fieldPrefs.showAuthor = !!fieldAuthorChk.checked;
    logAction('view', { showTime: fieldPrefs.showTime, showAuthor: !!fieldAuthorChk.checked });
    saveFieldPrefsForCurrentChannel();
    applyFieldPrefsToMessages();
  });
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
    const boxes = feedInner.querySelectorAll('.msg-select:checked');
    let ids = Array.from(boxes)
      .map(box => {
        const row = box.closest('.msg');
        return row && row.dataset.id ? Number(row.dataset.id) : null;
      })
      .filter(id => typeof id === 'number');
    try {
      let rowsToDelete = [];
      // If nothing selected, operate on whole tab (for this user).
      if (!ids.length) {
        const { data, error } = await sb
          .from('entries')
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
          .from('entries')
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
        .from('entries')
        .delete()
        .in('id', ids);
      if (error) {
        console.error(error);
        toast('Failed to delete — ' + humanError(error.message));
        return;
      }
      pushUndo({ type: 'delete', entries: rowsToDelete });
      logAction('delete', { count: rowsToDelete.length, channel: currentChannel });
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
    const boxes = feedInner.querySelectorAll('.msg-select:checked');
    const ids = Array.from(boxes)
      .map(box => {
        const row = box.closest('.msg');
        return row && row.dataset.id ? Number(row.dataset.id) : null;
      })
      .filter(id => typeof id === 'number');
    if (!ids.length) return;
    try {
      const now = new Date().toISOString();
      const { data, error } = await sb
        .from('entries')
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
        .from('entries')
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

async function deleteSingleMessage(id) {
  if (!currentUser || !id) return;
  try {
    const { data, error: selErr } = await sb
      .from('entries')
      .select('id, created_at, text, channel, user_id, author_name')
      .eq('id', id)
      .maybeSingle();
    if (selErr) {
      console.error(selErr);
      toast('Failed to delete — ' + humanError(selErr.message));
      return;
    }
    const { error } = await sb
      .from('entries')
      .delete()
      .eq('id', id);
    if (error) {
      console.error(error);
      toast('Failed to delete — ' + humanError(error.message));
      return;
    }
    if (data) {
      pushUndo({ type: 'delete', entries: [data] });
      logAction('delete', { id: data.id });
    }
    const el = feedInner.querySelector('.msg[data-id="' + id + '"]');
    if (el) el.remove();
    // keep local order in sync
    currentMessageOrder = currentMessageOrder.filter(x => x !== id);
    saveMessageOrderForCurrentChannel();
    showEmptyIfNoMessages();
  } catch (e) {
    console.error(e);
    toast('Failed to delete — ' + humanError(e.message));
  }
}

function animateMessageToTab(rowEl, tabEl, onDone) {
  const from = rowEl.getBoundingClientRect();
  const clone = rowEl.cloneNode(true);
  clone.classList.add('msg-fly-clone');
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

async function moveSingleMessage(id, targetChannel) {
  if (!currentUser || !id) return false;
  const target = targetChannel != null ? targetChannel : (moveTargetSelect && moveTargetSelect.value);
  if (!target || target === currentChannel) return false;
  try {
    const { data: before, error: selErr } = await sb
      .from('entries')
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
      .from('entries')
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
    const el = feedInner.querySelector('.msg[data-id="' + CSS.escape(String(id)) + '"]');
    if (el) el.remove();
    currentMessageOrder = currentMessageOrder.filter(x => x !== id);
    saveMessageOrderForCurrentChannel();
    showEmptyIfNoMessages();
    return true;
  } catch (e) {
    console.error(e);
    toast('Failed to move — ' + humanError(e.message));
    return false;
  }
}

async function exportSingleMessage(id) {
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
      const boxes = feedInner.querySelectorAll('.msg-select:checked');
      let orderedIds = [];
      if (boxes.length) {
        const selectedIds = new Set(
          Array.from(boxes)
            .map(b => { const row = b.closest('.msg'); return row && row.dataset.id ? Number(row.dataset.id) : null; })
            .filter(id => typeof id === 'number')
        );
        // Order as presented in the feed (DOM order).
        orderedIds = Array.from(feedInner.querySelectorAll('.msg'))
          .map(row => row.dataset.id ? Number(row.dataset.id) : null)
          .filter(id => Number.isFinite(id) && selectedIds.has(id));
      } else {
        // Whole tab: use current view order (currentMessageOrder), or DOM order if empty.
        orderedIds = currentMessageOrder.length
          ? currentMessageOrder.slice()
          : Array.from(feedInner.querySelectorAll('.msg'))
              .map(row => row.dataset.id ? Number(row.dataset.id) : null)
              .filter(id => Number.isFinite(id));
      }

      let query = sb
        .from('entries')
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

function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

/* ═══ SCROLL ══════════════════════════════════════════════ */
var scrollSaveTimer = null;
if (feedEl) {
feedEl.addEventListener('scroll', () => {
    atBottom = isNearBottom();
  if (atBottom) scrollBtn.classList.remove('visible');
    channelScroll.set(currentChannel, feedEl.scrollTop);
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
  if (!feedInner) return;
  if (typeof ev.clientX === 'number') lastDragClientX = ev.clientX;
  if (typeof ev.clientY === 'number') lastDragClientY = ev.clientY;
  if (dragSpiritEl && typeof ev.clientX === 'number' && typeof ev.clientY === 'number') {
    dragSpiritEl.style.left = ev.clientX + 'px';
    dragSpiritEl.style.top = ev.clientY + 'px';
  }
  if (originGhostsActive) {
    var slotRows = Array.from(feedInner.children).filter(function(n) { return n.classList && (n.classList.contains('msg') || n.classList.contains('msg-origin-ghost')); });
    if (!slotRows.length) return;
    var slotFirstRow = slotRows[0];
    var slotContentLeft = slotFirstRow.querySelector('.msg-time') || slotFirstRow.querySelector('.msg-sender') || slotFirstRow.querySelector('.msg-text');
    if (slotContentLeft && ev.clientX < slotContentLeft.getBoundingClientRect().left) return;
    var slotY = ev.clientY;
    var slotFirstRect = slotFirstRow.getBoundingClientRect();
    var slotLastRow = slotRows[slotRows.length - 1];
    var slotLastRect = slotLastRow.getBoundingClientRect();
    var slotFeedRect = feedEl.getBoundingClientRect();
    var slotDropAtEndThreshold = 32;
    var slotInEmptyZone = slotY >= slotLastRect.bottom - slotDropAtEndThreshold;
    var slotInLastRowLowerHalf = slotY >= slotLastRect.top + slotLastRect.height * 0.5;
    var slotWantAppendFirst = slotInEmptyZone || slotInLastRowLowerHalf;
    var slotWantAppend = slotWantAppendFirst;
    var slotInsertBeforeNode = null;
    var slotLineY = 0;
    if (slotY < slotFirstRect.top) {
      slotInsertBeforeNode = slotFirstRow;
      slotLineY = slotFirstRect.top;
    } else if (slotWantAppend) {
      slotLineY = slotLastRect.bottom;
    } else {
      for (var i = 0; i < slotRows.length; i++) {
        var r = slotRows[i];
        var rect = r.getBoundingClientRect();
        if (slotY >= rect.top && slotY <= rect.bottom) {
          if (r === slotLastRow && !r.classList.contains('msg-origin-ghost')) {
            slotWantAppend = true;
            slotLineY = rect.bottom;
            break;
          }
          var midY = rect.top + rect.height / 2;
          if (slotY < midY) {
            slotInsertBeforeNode = r;
            slotLineY = rect.top;
          } else {
            slotInsertBeforeNode = r.nextSibling;
            slotLineY = rect.bottom;
          }
          break;
        }
      }
      if (slotInsertBeforeNode === null && !slotWantAppend && slotRows.length && slotY >= slotLastRect.bottom - slotDropAtEndThreshold) {
        slotWantAppend = true;
        slotLineY = slotLastRect.bottom;
      }
    }
    lastDropInsertBefore = slotWantAppend ? null : slotInsertBeforeNode;
    lastWantAppend = slotWantAppend;
    var slotTargetRow = slotWantAppend ? slotLastRow : slotInsertBeforeNode;
    if (slotTargetRow !== lastDragTargetRow) {
      if (lastDragTargetRow && lastDragTargetRow.classList) lastDragTargetRow.classList.remove('msg-drag-target', 'msg-drag-nudge-right');
      if (slotTargetRow && slotTargetRow.classList && slotTargetRow.classList.contains('msg')) slotTargetRow.classList.add('msg-drag-target', 'msg-drag-nudge-right');
      lastDragTargetRow = slotTargetRow;
    }
    lastReorderTarget = { insertBefore: slotInsertBeforeNode, wantAppend: slotWantAppend };
    if (!feedDropIndicatorEl) {
      feedDropIndicatorEl = document.createElement('div');
      feedDropIndicatorEl.className = 'feed-drop-indicator';
      document.body.appendChild(feedDropIndicatorEl);
    }
    var indLeft = slotFeedRect.left;
    var indWidth = slotFeedRect.width;
    var indTop = slotLineY < slotFeedRect.top ? slotFeedRect.top - 2 : (slotLineY > slotFeedRect.bottom ? slotFeedRect.bottom - 2 : slotLineY - 2);
    feedDropIndicatorEl.style.left = indLeft + 'px';
    feedDropIndicatorEl.style.width = indWidth + 'px';
    feedDropIndicatorEl.style.height = '4px';
    feedDropIndicatorEl.style.top = indTop + 'px';
    if (!lastIndicatorStyle.visible) {
      feedDropIndicatorEl.classList.add('visible');
      lastIndicatorStyle.visible = true;
    }
    lastIndicatorStyle.left = indLeft;
    lastIndicatorStyle.width = indWidth;
    lastIndicatorStyle.top = indTop;
    updateEdgeScroll(ev.clientY, ev.clientX);
    return;
  }
  const dragging = feedInner.querySelector('.msg.dragging');
  if (!dragging) return;
  const allRows = Array.from(feedInner.querySelectorAll('.msg'));
  const skipSet = new Set(dragSelectedRows && dragSelectedRows.length ? dragSelectedRows : [dragging]);
  const rows = allRows.filter(function(r) { return !skipSet.has(r); });
  if (!rows.length) return;
  const firstRow = rows[0];
  const contentLeft = firstRow.querySelector('.msg-time') || firstRow.querySelector('.msg-sender') || firstRow.querySelector('.msg-text');
  if (contentLeft && ev.clientX < contentLeft.getBoundingClientRect().left) return;
  const y = ev.clientY;
  const firstRect = firstRow.getBoundingClientRect();
  const lastRow = rows[rows.length - 1];
  const lastRect = lastRow.getBoundingClientRect();
  const feedRect = feedEl.getBoundingClientRect();
  const dropAtEndThreshold = 32;
  const inEmptyZone = y >= lastRect.bottom - dropAtEndThreshold;
  const inLastRowLowerHalf = y >= lastRect.top + lastRect.height * 0.5;
  const wantAppendFirst = inEmptyZone || inLastRowLowerHalf;
  let wantAppend = wantAppendFirst;
  let insertBeforeNode = null;
  let lineY = 0;
  var rowUnderCursor = null;
  if (y < firstRect.top) {
    insertBeforeNode = firstRow;
    lineY = firstRect.top;
    rowUnderCursor = firstRow;
  } else if (wantAppend) {
    lineY = lastRect.bottom;
    rowUnderCursor = lastRow;
  } else {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rect = r.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        rowUnderCursor = r;
        if (r === lastRow) {
          wantAppend = true;
          lineY = rect.bottom;
          break;
        }
        const midY = rect.top + rect.height / 2;
        if (y < midY) {
          insertBeforeNode = r;
          lineY = rect.top;
        } else {
          insertBeforeNode = r.nextElementSibling || r.nextSibling;
          lineY = rect.bottom;
        }
        break;
      }
    }
    if (insertBeforeNode === null && !wantAppend && rows.length && y >= lastRect.bottom - dropAtEndThreshold) {
      wantAppend = true;
      lineY = lastRect.bottom;
      rowUnderCursor = lastRow;
    }
  }
  var targetRow = (rowUnderCursor && rowUnderCursor.classList) ? rowUnderCursor : (wantAppend ? lastRow : (insertBeforeNode && insertBeforeNode.classList ? insertBeforeNode : firstRow));
  if (targetRow && !targetRow.classList) targetRow = null;
  if (targetRow !== lastDragTargetRow) {
    if (lastDragTargetRow && lastDragTargetRow.classList) {
      lastDragTargetRow.classList.remove('msg-drag-target', 'msg-drag-nudge-right');
    }
    if (targetRow && targetRow.classList) {
      targetRow.classList.add('msg-drag-target', 'msg-drag-nudge-right');
    }
    lastDragTargetRow = targetRow;
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
  } else {
    var inFeed = ev.clientX >= feedRect.left && ev.clientX <= feedRect.right && ev.clientY >= feedRect.top && ev.clientY <= feedRect.bottom;
    if (inFeed) {
      if (feedDropIndicatorEl && lastIndicatorStyle.visible) {
        feedDropIndicatorEl.classList.remove('visible');
        lastIndicatorStyle.visible = false;
      }
      lastReorderTarget = null;
      if (lastDragTargetRow) {
        lastDragTargetRow.classList.remove('msg-drag-target', 'msg-drag-nudge-right');
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
  const dragging = feedInner ? feedInner.querySelector('.msg.dragging') : null;
  if (!feedInner || (!dragging && !originGhostsActive)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  processFeedDragover(e);
});
feedEl.addEventListener('drop', e => {
  if (feedInner && (feedInner.querySelector('.msg.dragging') || originGhostsActive)) {
    e.preventDefault();
    dragDropHandled = true;
    if (feedInner) {
      feedInner.querySelectorAll('.msg-drag-over').forEach(r => r.classList.remove('msg-drag-over'));
      feedInner.querySelectorAll('.msg-drag-target').forEach(r => r.classList.remove('msg-drag-target', 'msg-drag-nudge-right'));
    }
  }
});
feedEl.addEventListener('dragleave', e => {
  if (!e.relatedTarget || !feedEl.contains(e.relatedTarget)) {
    if (feedInner) feedInner.querySelectorAll('.msg-drag-over').forEach(r => r.classList.remove('msg-drag-over'));
  }
});
}

// Dragover: when over feed, always run processFeedDragover (so lastDropInsertBefore updates even if feedEl doesn't receive the event). When outside feed, show indicator at top/bottom.
document.addEventListener('dragover', e => {
  if (!feedEl || !feedInner) return;
  if (!feedInner.querySelector('.msg.dragging') && !originGhostsActive) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  lastDragClientX = e.clientX;
  lastDragClientY = e.clientY;
  if (dragSpiritEl) {
    dragSpiritEl.style.left = e.clientX + 'px';
    dragSpiritEl.style.top = e.clientY + 'px';
  }
  const feedRect = feedEl.getBoundingClientRect();
  const y = e.clientY;
  const x = e.clientX;
  const inFeed = x >= feedRect.left && x <= feedRect.right && y >= feedRect.top && y <= feedRect.bottom;
  if (inFeed) {
    processFeedDragover(e);
    return;
  }
  if (lastDragTargetRow && lastDragTargetRow.classList) {
    lastDragTargetRow.classList.remove('msg-drag-target', 'msg-drag-nudge-right');
    lastDragTargetRow = null;
  }
  const rows = originGhostsActive
    ? Array.from(feedInner.children).filter(function(n) { return n.classList && (n.classList.contains('msg') || n.classList.contains('msg-origin-ghost')); })
    : Array.from(feedInner.querySelectorAll('.msg'));
  if (!rows.length) return;
  const firstRow = rows[0];
  const lastRow = rows[rows.length - 1];
  const firstRect = firstRow.getBoundingClientRect();
  const lastRect = lastRow.getBoundingClientRect();

  var lineY = y < feedRect.top ? firstRect.top : lastRect.bottom;
  var indTop = lineY < feedRect.top ? feedRect.top - 2 : (lineY > feedRect.bottom ? feedRect.bottom - 2 : lineY - 2);

  if (!feedDropIndicatorEl) {
    feedDropIndicatorEl = document.createElement('div');
    feedDropIndicatorEl.className = 'feed-drop-indicator';
    document.body.appendChild(feedDropIndicatorEl);
  }
  feedDropIndicatorEl.style.left = feedRect.left + 'px';
  feedDropIndicatorEl.style.width = feedRect.width + 'px';
  feedDropIndicatorEl.style.height = '4px';
  feedDropIndicatorEl.style.top = indTop + 'px';
  feedDropIndicatorEl.classList.add('visible');

  updateEdgeScroll(e.clientY, e.clientX);
}, { passive: false });

document.addEventListener('drop', e => {
  if (!feedInner) return;
  if (feedInner.querySelector('.msg.dragging') || originGhostsActive) {
    e.preventDefault();
    e.stopPropagation();
    dragDropHandled = true;
    feedInner.querySelectorAll('.msg-drag-over, .msg-drag-target').forEach(function(r) { r.classList.remove('msg-drag-over', 'msg-drag-target', 'msg-drag-nudge-right'); });
  }
}, { passive: false });

function scrollBottom() {
  if (!feedEl) return;
  feedEl.scrollTop = feedEl.scrollHeight;
  if (scrollBtn) scrollBtn.classList.remove('visible');
  atBottom = true;
}

/* ═══ UTILS ═══════════════════════════════════════════════ */
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
  if (!window.sb && typeof supabase !== 'undefined') {
    try {
      window.sb = supabase.createClient('https://tfmbqiwxfgrwtjvoqomf.supabase.co', 'sb_publishable_QzPgZBu5XwFXmnvD-DYCRw_EWFuhLn_', { auth: { detectSessionInUrl: true } });
    } catch(_) {}
  }
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
