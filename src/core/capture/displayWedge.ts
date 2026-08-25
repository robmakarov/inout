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
 * A LADDER, NOT A SWITCH (PO 2026-08-25: "share sound in chrome with screen
 * toggle not there anymore"). The first cut of this dropped `audio` on the
 * first wedge and kept it dropped for 24h — so Chrome's own "Also share tab
 * audio" checkbox vanished from the picker for a whole day, silently, on the
 * strength of a guess about which option wedges. That is the one rule that
 * does not bend: a fix may not remove a working feature. So each wedge steps
 * DOWN one rung, and the rungs are ordered so the thing the user can see goes
 * last:
 *
 *   0  full request — constraints, surface hints, explicit systemAudio, audio
 *   1  drop what the user cannot see: size/fps constraints, selfBrowserSurface,
 *      surfaceSwitching, the explicit systemAudio flag (its spec default is
 *      'include' anyway, so nothing is lost). Audio still requested → Chrome
 *      still shows the checkbox.
 *   2  the bare request: `{ video: true, audio: true }`. No constraints object
 *      at all, plain audio — still the checkbox, minus our raw-capture asks.
 *   3  last resort: `{ video: true, audio: false }`. THIS is the only rung
 *      where tab audio disappears, it is reached only after three consecutive
 *      wedges, and it is ONE-SHOT: a success steps back up to rung 2, so the
 *      checkbox is back on the very next take.
 *
 * Lifecycle: a wedge steps down · a rung-0 success clears the mark entirely
 * (healthy machine, nothing stays degraded) · a rung-1/2 success keeps the
 * rung (invisible to the user, and this machine proved it chokes on the one
 * above) · a rung-3 success steps back up · everything expires 24h after the
 * last wedge, so a Chrome fix restores the full request by itself.
 *
 * Same storage discipline as grants.ts: localStorage with an in-memory
 * fallback, and the browser remains the only authority — this mark only ever
 * shapes the next REQUEST, never what we believe about permissions.
 */

const KEY = 'inout.displayWedge.v1'
const WEDGE_TTL_MS = 24 * 60 * 60 * 1000

/** 0 = full request. Higher = fewer options; see the ladder above. */
export type DisplayRequestLevel = 0 | 1 | 2 | 3
export const MAX_DISPLAY_LEVEL = 3
/** The only rung that drops the audio request — i.e. Chrome's checkbox. */
export const SILENT_DISPLAY_LEVEL = 3

interface WedgeState {
  /** Last display timeout, ms since epoch. 0 = never / cleared. */
  wedgedAt: number
  /** Which rung the next request uses. */
  level: DisplayRequestLevel
  count: number
}

let mem: WedgeState | null = null

function clamp(n: number): DisplayRequestLevel {
  const v = Math.max(0, Math.min(MAX_DISPLAY_LEVEL, n | 0))
  return v as DisplayRequestLevel
}

function load(): WedgeState {
  if (mem) return mem
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '')
    if (parsed && typeof parsed === 'object' && typeof (parsed as WedgeState).wedgedAt === 'number') {
      const s = parsed as Partial<WedgeState>
      mem = {
        wedgedAt: s.wedgedAt ?? 0,
        // Written by the first, audio-dropping cut of safe mode: a marked
        // machine with no rung recorded lands on rung 1, not on the silent
        // one. Anyone stuck without the tab-audio checkbox gets it back on
        // their next click instead of waiting out the TTL.
        level: typeof s.level === 'number' ? clamp(s.level) : 1,
        count: (s.count ?? 0) | 0,
      }
      return mem
    }
  } catch {
    /* absent, corrupt, or storage refused — memory-only is fine */
  }
  mem = { wedgedAt: 0, level: 0, count: 0 }
  return mem
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem))
  } catch {
    /* memory-only */
  }
}

/** Which rung the next getDisplayMedia should use. 0 on a healthy machine. */
export function displayRequestLevel(now = Date.now()): DisplayRequestLevel {
  const s = load()
  if (s.wedgedAt === 0 || now - s.wedgedAt >= WEDGE_TTL_MS) return 0
  return s.level
}

/** A display acquisition hit its deadline with the share taken but never delivered. */
export function rememberDisplayWedge(now = Date.now()): void {
  const s = load()
  s.level = clamp(displayRequestLevel(now) + 1)
  s.wedgedAt = now
  s.count += 1
  save()
}

/**
 * The screen arrived. Rung 0 means the machine is healthy — clear the mark so
 * nothing stays degraded. Rung 3 is one-shot (tab audio returns next take).
 * Rungs 1–2 are invisible to the user and stay until the TTL.
 */
export function rememberDisplaySuccess(usedLevel: DisplayRequestLevel): void {
  const s = load()
  if (s.wedgedAt === 0) return
  if (usedLevel === 0) {
    s.wedgedAt = 0
    s.level = 0
    save()
    return
  }
  if (usedLevel >= SILENT_DISPLAY_LEVEL) {
    s.level = clamp(usedLevel - 1)
    save()
  }
}

/** How many times this machine has wedged — telemetry, not behaviour. */
export function displayWedgeCount(): number {
  return load().count
}

/** Test seam — module state outlives test cases. */
export function resetDisplayWedgeForTests(): void {
  // null, not a clean object: the next load() re-reads storage, which is what
  // lets a test plant a legacy record and see how it is interpreted.
  mem = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* memory-only */
  }
}
