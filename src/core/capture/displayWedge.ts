/**
 * SELF-HEALING FOR A WEDGED SCREEN SHARE — the "never happens to users" layer.
 *
 * The wedge itself (PO 2026-08-24, twice, incl. a fresh Chrome): the user
 * picks a surface, Chrome lights the indicator, and getDisplayMedia neither
 * resolves nor rejects. It lives in Chrome's browser process / the macOS
 * native picker, survives tab close, and no page code can release a track the
 * page never received. What the app CAN do is stop presenting the same
 * request to a browser that just choked on it.
 *
 * Policy, one wedge of state:
 *  - A display timeout marks this MACHINE wedged. The next record click sends
 *    a CONSERVATIVE getDisplayMedia: video only, no audio request, no
 *    selfBrowserSurface/surfaceSwitching hints, no width/height/fps
 *    constraints (capDisplayTrack already enforces the ceiling after
 *    delivery — that second line of defence is exactly why dropping the
 *    picker constraints costs nothing). If one of our options is what the
 *    native picker chokes on, the user's second click just works and they
 *    never learn any of this happened.
 *  - A success with the FULL request clears the mark: the wedge was
 *    transient, full features stay.
 *  - A success in conservative mode KEEPS the mark — this machine has proven
 *    it chokes on the full request — but the mark expires after 24h, so a
 *    Chrome update that fixes the underlying bug returns the user to full
 *    features (tab audio) without anyone having to clear site data.
 *  - A wedge in conservative mode changes nothing here: there is no smaller
 *    request left, and the session's error path already says the one thing
 *    that works (quit Chrome).
 *
 * Same storage discipline as grants.ts: localStorage with an in-memory
 * fallback, and the browser remains the only authority — this mark only ever
 * shapes the next REQUEST, never what we believe about permissions.
 */

const KEY = 'inout.displayWedge.v1'
const CONSERVATIVE_TTL_MS = 24 * 60 * 60 * 1000

interface WedgeState {
  /** Last display timeout, ms since epoch. 0 = never / cleared. */
  wedgedAt: number
  count: number
}

let mem: WedgeState | null = null

function load(): WedgeState {
  if (mem) return mem
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '')
    if (parsed && typeof parsed === 'object' && typeof (parsed as WedgeState).wedgedAt === 'number') {
      mem = { wedgedAt: (parsed as WedgeState).wedgedAt, count: (parsed as WedgeState).count | 0 }
      return mem
    }
  } catch {
    /* absent, corrupt, or storage refused — memory-only is fine */
  }
  mem = { wedgedAt: 0, count: 0 }
  return mem
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem))
  } catch {
    /* memory-only */
  }
}

/** Should the next getDisplayMedia be the minimal, nothing-optional request? */
export function isDisplayConservative(now = Date.now()): boolean {
  const s = load()
  return s.wedgedAt > 0 && now - s.wedgedAt < CONSERVATIVE_TTL_MS
}

/** A display acquisition hit its deadline with the share taken but never delivered. */
export function rememberDisplayWedge(now = Date.now()): void {
  const s = load()
  s.wedgedAt = now
  s.count += 1
  save()
}

/**
 * The screen arrived. Full-request success means the machine is healthy —
 * clear the mark so nothing stays degraded. Conservative success keeps it
 * (the TTL is the way back to full features).
 */
export function rememberDisplaySuccess(usedConservative: boolean): void {
  if (usedConservative) return
  const s = load()
  if (s.wedgedAt === 0) return
  s.wedgedAt = 0
  save()
}

/** How many times this machine has wedged — telemetry, not behaviour. */
export function displayWedgeCount(): number {
  return load().count
}

/** Test seam — module state outlives test cases. */
export function resetDisplayWedgeForTests(): void {
  mem = { wedgedAt: 0, count: 0 }
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* memory-only */
  }
}
