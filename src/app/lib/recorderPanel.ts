/**
 * U1 — THE ON-TOP RECORDER PANEL (Document Picture-in-Picture).
 *
 * A real browser window, owned by this document, that floats above every other
 * app while a take runs: the timer, the audio ring, stop and pause/continue.
 * Robert 2026-09-02, DECISIONS robert (5): "thats mvp too".
 *
 * WHAT THE BROWSER KEEPS FOR ITSELF (probed off-repo before the task existed,
 * ~/Downloads/inout-dpip-test.html, and re-read by scripts/dpip-check.mjs):
 * the title bar is browser UI — no CSS here reaches it — the origin string in
 * it cannot be hidden, there is no icon API, and script can neither move nor
 * resize the window (`resizeTo` throws). The panel document starts EMPTY: no
 * stylesheet, no fonts, nothing inherited from the page, so the CSS is written
 * into it here rather than linked.
 *
 * THE ONE THING THAT DECIDES WHERE THIS IS CALLED FROM — measured, not argued
 * (`node scripts/dpip-check.mjs`, Chrome 152, macOS, 2026-09-02):
 *
 *   requestWindow() CONSUMES the click's transient activation
 *        (navigator.userActivation.isActive: true → false across the call)
 *   getDisplayMedia() does NOT
 *        (isActive still true immediately after it is fired)
 *   requestWindow() survives a resolved-promise await      (loadCaptureEngine)
 *   requestWindow() with no gesture at all → NotAllowedError
 *   Chrome's screen picker SURVIVES the panel opening over it
 *        (the display promise was still pending 3 s later, picker up)
 *
 * So one record press can pay for both, in exactly one order: the screen
 * request FIRST (it is dispatched synchronously inside the gesture —
 * acquire.ts:1133 — and takes nothing), the panel SECOND. Reversing it would
 * spend the activation getDisplayMedia needs and kill the take, which is why
 * `whenDisplayDispatched()` exists and why nothing here is called before it.
 *
 * Falls back to nothing: unsupported browser, insecure context, `?panel=0`, or
 * a rejected request all leave the app exactly as it was.
 */
import { displayRequestPending } from '@core/capture/displayInflight'

interface PanelRequestOptions {
  width?: number
  height?: number
  disallowReturnToOpener?: boolean
  preferInitialWindowPlacement?: boolean
}

interface DocumentPictureInPictureApi {
  readonly window: Window | null
  requestWindow(options?: PanelRequestOptions): Promise<Window>
}

type PanelHost = Window & { documentPictureInPicture?: DocumentPictureInPictureApi }

/**
 * What we ASK for. Chrome clamps it to its own floor and remembers what the
 * user dragged it to afterwards, so this is an opening offer, not a size — the
 * layout below is written to survive being made smaller than it.
 */
export const PANEL_WIDTH = 320
export const PANEL_HEIGHT = 132

export interface PanelSize {
  outerW: number
  outerH: number
  innerW: number
  innerH: number
}

/** `?panel=0` turns the whole thing off; anything else is the default, ON. */
export function panelEnabled(): boolean {
  if (typeof location === 'undefined') return true
  const v = new URLSearchParams(location.search).get('panel')
  return !(v === '0' || v === 'off')
}

/** Chrome/Edge 130+, Firefox 151+, and only on a secure context. */
export function panelSupported(host: PanelHost | undefined = globalThis.window as PanelHost): boolean {
  if (!host) return false
  if (!host.isSecureContext) return false
  return typeof host.documentPictureInPicture?.requestWindow === 'function'
}

export function readPanelSize(win: Window): PanelSize {
  return {
    outerW: win.outerWidth,
    outerH: win.outerHeight,
    innerW: win.innerWidth,
    innerH: win.innerHeight,
  }
}

/**
 * The smallest the user has actually dragged it to. Pure so the floor can be
 * tested without a window — and it is a FLOOR, not the last reading: a panel
 * dragged small and then large again has still proved the small one exists.
 *
 * Automation cannot answer this (Chrome ignores the requested size under CDP
 * and reports outer 0×0), so the number can only come from a real drag on a
 * real take. This is the instrument that collects it — `__inoutPanel()`.
 */
export function noteSmallest(prev: PanelSize | null, next: PanelSize): PanelSize | null {
  // outer 0×0 is what a driven Chrome reports; it is not a size anyone dragged.
  if (next.outerW <= 0 || next.outerH <= 0) return prev
  if (!prev) return next
  const area = (s: PanelSize): number => s.outerW * s.outerH
  return area(next) < area(prev) ? next : prev
}

export interface PanelReading {
  supported: boolean
  open: boolean
  /** Live geometry, or the last reading taken before it closed. */
  size: PanelSize | null
  /** The smallest outer box this browser has ever let the user drag it to. */
  smallest: PanelSize | null
  /** outerHeight − innerHeight: the browser's own title bar, in CSS px. */
  titleBarPx: number | null
  /** outerWidth − innerWidth: 0 on macOS Chrome, per the off-repo rig. */
  sidePx: number | null
}

let lastSize: PanelSize | null = null
let smallest: PanelSize | null = null
let openWindow: Window | null = null

const SMALLEST_KEY = 'inout.panel.smallest'

function loadSmallest(): PanelSize | null {
  try {
    const raw = localStorage.getItem(SMALLEST_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as PanelSize
    return typeof v?.outerW === 'number' && v.outerW > 0 ? v : null
  } catch {
    return null
  }
}

function saveSmallest(s: PanelSize | null): void {
  if (!s) return
  try {
    localStorage.setItem(SMALLEST_KEY, JSON.stringify(s))
  } catch {
    /* private mode — the console line is still the evidence */
  }
}

/** The take's own readout, for the console. Agent/dev surface only (S1's rule:
 *  bug data is not shown to users). */
export function panelReading(): PanelReading {
  const size = openWindow && !openWindow.closed ? readPanelSize(openWindow) : lastSize
  return {
    supported: panelSupported(),
    open: !!openWindow && !openWindow.closed,
    size,
    smallest: smallest ?? loadSmallest(),
    titleBarPx: size ? size.outerH - size.innerH : null,
    sidePx: size ? size.outerW - size.innerW : null,
  }
}

/**
 * THE PANEL'S OWN STYLESHEET. Written into the panel document because there is
 * nothing there to inherit — not the app's tokens, not even a font. The values
 * are copied from src/styles/tokens.css rather than imported: a build that
 * splits the CSS out of the JS would leave this window unstyled, and an
 * unstyled stop button on top of every app is worse than none.
 *
 * Hierarchy (org style.md rule 1): the TIMER dominates — it is the one thing
 * this window exists to show from across the room. Colour only says WHERE
 * (rule 2): the record dot and the ring are markers, the type stays neutral.
 */
const PANEL_CSS = `
:root { color-scheme: dark }
* { box-sizing: border-box; margin: 0; padding: 0; font: inherit; color: inherit }
html, body { height: 100% }
body {
  background: #0a0a0c;
  color: #f5f5f7;
  font: 14px/1.35 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
.rp {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
  padding: 10px 12px;
}
.rp__head { display: flex; align-items: center; gap: 10px; min-height: 34px }
.rp__dot {
  flex: none;
  width: 9px; height: 9px; border-radius: 50%;
  background: #ff3b30;
  animation: rp-pulse 1.2s cubic-bezier(0.25, 0.1, 0.25, 1) infinite;
}
.rp--paused .rp__dot { background: #ffd60a; animation: none }
.rp--idle .rp__dot { background: #5c5c66; animation: none }
.rp__time {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1;
}
.rp--warn .rp__time { color: #ffd60a }
.rp__label { font-size: 13px; color: #98989f; letter-spacing: 0.01em }
.rp__ring {
  margin-left: auto;
  position: relative;
  flex: none;
  width: 30px; height: 30px;
  display: grid; place-items: center;
}
.rp__ring i {
  position: absolute;
  width: 22px; height: 22px;
  border: 2px solid #0a84ff;
  border-radius: 50%;
  opacity: 0.4;
  will-change: transform, opacity;
}
.rp__ring b { width: 7px; height: 7px; border-radius: 50%; background: #0a84ff }
.rp__actions { display: flex; gap: 8px }
.rp__btn {
  flex: 1;
  min-height: 36px;
  border: 0;
  border-radius: 999px;
  background: #1e1e23;
  color: #f5f5f7;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 140ms cubic-bezier(0.25, 0.1, 0.25, 1), transform 140ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.rp__btn:hover { background: #2a2a31 }
.rp__btn:active { transform: scale(0.97) }
.rp__btn:disabled { opacity: 0.5; cursor: default }
.rp__btn--stop { flex: 1.4; background: #ff3b30 }
.rp__btn--stop:hover { background: #ff5348 }
.rp__note { font-size: 12px; color: #5c5c66 }
@keyframes rp-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.35 } }
@media (prefers-reduced-motion: reduce) {
  .rp__dot { animation: none }
}
`

/**
 * WAIT UNTIL THE SCREEN REQUEST IS IN FLIGHT — the whole reason this module has
 * an ordering function in it.
 *
 * `displayRequestPending()` flips true the instant acquire.ts registers the raw
 * getDisplayMedia promise (acquire.ts:1292), which is the line after the
 * dispatch. And the converse is the part that makes this airtight: when it is
 * ALREADY true, acquire refuses the press ('busy', acquire.ts:1223) and
 * dispatches nothing — so there is no activation left to protect either way.
 *
 * Transient activation lasts ~5 s and nothing before this consumes it, so the
 * wait costs the panel nothing. The budget is a safety net, not a schedule:
 * a take with no screen never waits at all.
 */
export async function whenDisplayDispatched(wantsScreen: boolean, budgetMs = 1000): Promise<void> {
  if (!wantsScreen) return
  // A synthetic take generates its streams and never asks Chrome for a screen,
  // so there is nothing to wait behind. The predicate is duplicated rather than
  // imported: core/capture/synthetic.ts pulls acquire.ts with it, and that is
  // the whole capture engine landing in the first-paint chunk (O7).
  if (typeof location !== 'undefined' && location.search.includes('synthetic')) return
  const deadline = Date.now() + budgetMs
  while (!displayRequestPending() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8))
  }
}

/**
 * Open the panel. NEVER throws and never rejects: every failure here is
 * "exactly today", and the record press must not be able to notice.
 */
export async function openRecorderPanel(): Promise<Window | null> {
  if (!panelEnabled() || !panelSupported()) return null
  const host = window as PanelHost
  const api = host.documentPictureInPicture
  if (!api) return null
  try {
    // One panel per document. A previous one still standing (a take that ended
    // without its close reaching here) would make requestWindow open into it.
    if (api.window && !api.window.closed) api.window.close()
    const win = await api.requestWindow({ width: PANEL_WIDTH, height: PANEL_HEIGHT })
    const style = win.document.createElement('style')
    style.textContent = PANEL_CSS
    win.document.head.appendChild(style)
    // The bar is browser UI and the origin in it cannot be removed; the title
    // is the one part of it we own.
    win.document.title = 'INOUT — recording'
    openWindow = win
    smallest = smallest ?? loadSmallest()
    const measure = (): void => {
      const s = readPanelSize(win)
      lastSize = s
      const next = noteSmallest(smallest, s)
      if (next !== smallest) {
        smallest = next
        saveSmallest(smallest)
      }
    }
    measure()
    win.addEventListener('resize', measure)
    win.addEventListener('pagehide', () => {
      measure()
      if (openWindow === win) openWindow = null
      const r = panelReading()
      console.info(
        `[panel] closed · last ${r.size ? `${r.size.outerW}x${r.size.outerH} outer / ${r.size.innerW}x${r.size.innerH} inner` : 'unread'}` +
          ` · title bar ${r.titleBarPx ?? '?'}px · smallest ever ${r.smallest ? `${r.smallest.outerW}x${r.smallest.outerH}` : 'unmeasured'}`,
      )
    })
    console.info(
      `[panel] opened · asked ${PANEL_WIDTH}x${PANEL_HEIGHT} · got ${win.innerWidth}x${win.innerHeight} inner,` +
        ` ${win.outerWidth}x${win.outerHeight} outer · title bar ${win.outerHeight - win.innerHeight}px`,
    )
    return win
  } catch (err) {
    // NotAllowedError = the activation was already spent. Nothing to say to the
    // user: they pressed record and they are recording.
    console.info(`[panel] not opened — ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`)
    return null
  }
}

/** Close it. Idempotent, and safe on a window the user already closed. */
export function closeRecorderPanel(win?: Window | null): void {
  const target = win ?? openWindow
  if (!target) return
  try {
    if (!target.closed) target.close()
  } catch {
    /* already gone with its document */
  }
  if (openWindow === target) openWindow = null
}

declare global {
  interface Window {
    __inoutPanel?: () => PanelReading
  }
}

if (typeof window !== 'undefined') {
  window.__inoutPanel = panelReading
}
