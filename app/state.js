/* INOUT – shared state, Supabase client, DOM refs (load first) */
const SUPABASE_URL  = 'https://tfmbqiwxfgrwtjvoqomf.supabase.co';
const SUPABASE_ANON = 'sb_publishable_QzPgZBu5XwFXmnvD-DYCRw_EWFuhLn_';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
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
let myId           = crypto.randomUUID();
let currentUser    = null;
let currentChannel = 'main';
let channels       = ['main'];
const CHANNELS_KEY         = 'inout_channels_v1';
const CURRENT_CHANNEL_KEY  = 'inout_current_channel_v1';
const INPUT_STATE_KEY      = 'inout_input_state_v2';
const FIELD_PREFS_KEY      = 'inout_field_prefs_v1';
const ORDER_STATE_KEY      = 'inout_order_state_v1';
const WAS_EDITING_KEY      = 'inout_was_editing_v1';
const seenIds       = new Set();
const channelScroll = new Map();
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
