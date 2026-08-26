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
 * THE RULE THIS FILE OBEYS (PO 2026-08-25, after the first cut of it took the
 * tab-audio checkbox out of Chrome's picker for a day: "i need this shit never
 * happen to user, always fucking clean"):
 *
 *   SAFE MODE MAY ONLY DROP OPTIONS THE USER NEVER CHOSE.
 *   NEVER ONE THEY DID. NO EXCEPTIONS, NO "JUST THIS TAKE".
 *
 * `audio` is chosen — it is the Tab Audio chip, lit, on screen. Constraints,
 * surface hints and spec-default flags are not: nobody asked for them, nobody
 * can see them go. So the ladder only ever descends through OUR options, and
 * it bottoms out with the user's ask still intact:
 *
 *   0  full request — constraints, surface hints, explicit systemAudio, audio
 *   1  drop what the user cannot see: size/fps constraints, selfBrowserSurface,
 *      surfaceSwitching, the explicit systemAudio flag (its spec default is
 *      'include' anyway, so nothing is lost). Audio still requested → Chrome
 *      still shows the checkbox.
 *   2  the bare request: `{ video: true, audio: <raw> }` — nothing of ours left
 *      to drop, and the checkbox is STILL there. This is the floor. There is
 *      no rung below it and there must never be one: a wedge we cannot fix by
 *      dropping our own options is Chrome's to fix, not the user's to pay for.
 *      `<raw>` = the AEC/NS/AGC-off flags, on EVERY rung: dropping those does
 *      not shrink the request, it hands the user's tab audio to Chrome's voice
 *      processing, which turns music into mono warble (heard by PO 2026-08-26
 *      after the game wedges parked this machine on rung 2 for a day).
 *
 * Lifecycle: a wedge steps down · a rung-0 success clears the mark entirely
 * (healthy machine, nothing stays degraded) · a rung-1/2 success keeps the
 * rung, which costs the user nothing they can see · everything expires 24h
 * after the last wedge, so a Chrome fix restores the full request by itself.
 *
 * Same storage discipline as grants.ts: localStorage with an in-memory
 * fallback, and the browser remains the only authority — this mark only ever
 * shapes the next REQUEST, never what we believe about permissions.
 */

const KEY = 'inout.displayWedge.v1'
const WEDGE_TTL_MS = 24 * 60 * 60 * 1000

/** 0 = full request. Higher = fewer of OUR options; see the ladder above. */
export type DisplayRequestLevel = 0 | 1 | 2
/** The floor. Every rung, this one included, still asks for the user's audio. */
export const MAX_DISPLAY_LEVEL = 2

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
 * nothing stays degraded. A lower rung keeps it until the TTL: it costs the
 * user nothing they can see, and the rung above it has already choked once.
 */
export function rememberDisplaySuccess(usedLevel: DisplayRequestLevel): void {
  const s = load()
  if (s.wedgedAt === 0 || usedLevel !== 0) return
  s.wedgedAt = 0
  s.level = 0
  save()
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
