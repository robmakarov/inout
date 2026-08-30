/**
 * SELF-HEALING FOR A WEDGED SCREEN SHARE — the "never happens to users" layer.
 *
 * The wedge itself (Robert 2026-08-24, twice, incl. a fresh Chrome): the user
 * picks a surface, Chrome lights the indicator, and getDisplayMedia neither
 * resolves nor rejects. It lives in Chrome's browser process / the macOS
 * native picker, survives tab close, and no page code can release a track the
 * page never received. What the app CAN do is stop presenting the same
 * request to a browser that just choked on it.
 *
 * THE RULE THIS FILE OBEYS (Robert 2026-08-25, after the first cut of it took the
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
 *      processing, which turns music into mono warble (heard by Robert 2026-08-26
 *      after the game wedges parked this machine on rung 2 for a day).
 *
 * THE LADDER GOES BOTH WAYS — W1, 2026-08-29, and it did not before. Robert hit
 * the wedge three times in one evening, reached rung 2, and found that the ONLY
 * exit was a 24 h timer: a success cleared the mark from rung 0 only, so a
 * machine degraded by a cause that was already GONE (his was the macOS
 * screen-recording grant, which needs a Chrome relaunch) stayed degraded for a
 * day. The one exit anyone found was a localStorage line in a console, and
 * being handed it he answered "what the fuck is this?". He is right: a ladder
 * with no way up is not self-healing, it is a ratchet.
 *
 *   ONE GOOD TAKE IS STRONGER EVIDENCE THAN ONE OLD BAD ONE.
 *
 * So a success now climbs exactly ONE rung, whichever rung it happened on, and
 * reaching 0 clears the mark entirely. One rung at a time and not straight to
 * 0, because the rung above this one HAS choked once and a single success is
 * not proof it is cured — two good takes walk a floored machine all the way
 * home, which is the gate W1 was written against. The 24 h TTL stays as the
 * backstop it always was, and is now the slow path rather than the only one.
 *
 * A STALL IS NOT ALWAYS A WEDGE — the second half of W1. When macOS has not
 * granted Chrome screen recording, Chrome's picker opens, SAYS SO on screen,
 * and getDisplayMedia never settles: from the page that is byte-for-byte the
 * wedge, so the ladder escalated against a permission no constraint of ours
 * can fix, and the app reported "the device never connected" while Chrome was
 * displaying the actual answer. The discriminator is recorded fact, not a
 * guess: `everDelivered` — has this browser profile EVER been handed a screen
 * track? The macOS grant is per-application and permanent once given, so a
 * profile that has delivered a share has the grant, and a stall there is
 * Chrome's wedge. A profile that never has, on macOS, is the case where the
 * missing grant is live and must be named. It is not a perfect oracle — a
 * genuine first-take wedge on a fresh profile reads as 'permission' — and it
 * is deliberately biased that way: the cost of that miss is one unescalated
 * rung and a message that names both causes, against a cost of parking a
 * machine on the floor for 24 h over a permission toggle.
 *
 * Lifecycle: a wedge steps down · any success climbs one rung · rung 0 clears
 * the mark · a permission stall does neither (it is not evidence about our
 * options) · everything expires 24h after the last wedge, so a Chrome fix
 * restores the full request by itself · and resetDisplayWedge() is the user's
 * own way out, wired to a button rather than a console.
 *
 * Same storage discipline as grants.ts: localStorage with an in-memory
 * fallback, and the browser remains the only authority — this mark only ever
 * shapes the next REQUEST, never what we believe about permissions.
 */
import { BROWSER_LABEL } from '../platform'
import type { BrowserName, OSName } from '../platform'

const KEY = 'inout.displayWedge.v1'

/**
 * How many consecutive good takes a rung must carry before the request climbs
 * back toward the full one. Three: enough that a climb is not triggered by the
 * single take that happened to work, few enough that a machine whose cause is
 * gone is back at full quality within a minute of ordinary use.
 */
export const GOOD_TAKES_TO_CLIMB = 3
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
  /** Consecutive good takes at the CURRENT rung — see rememberDisplaySuccess. */
  goodRun: number
  /**
   * CONSECUTIVE STALLS WITH NO SCREEN IN BETWEEN — how the advice knows what
   * has already been tried and failed. 1 = the refresh ritual. 2 = the refresh
   * AND ⌘Q. From 3 the app has spent every remedy that lives in the browser,
   * and the only thing left is the macOS grant, so that is what it must say
   * instead of repeating ⌘Q at a user who has already done it twice (Robert,
   * 2026-08-30: four stalls, two Chrome relaunches, "make this shit gone
   * completly"). Cleared by a delivered screen, never by time.
   */
  stalls: number
  /**
   * Has this browser profile ever been handed a screen track? The macOS
   * screen-recording grant is per-application and permanent once given, so
   * one delivery proves it exists — which is what separates Chrome's wedge
   * from an ungranted OS permission (both are a promise that never settles).
   * Never cleared, not even by resetDisplayWedge: it is evidence, not a
   * penalty.
   */
  everDelivered: boolean
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
        goodRun: (s.goodRun ?? 0) | 0,
        stalls: (s.stalls ?? 0) | 0,
        // A record written before W1 carries no delivery flag, and the honest
        // reading of that is FALSE: we have no evidence this profile was ever
        // handed a share. The only consequence is that its next stall names
        // the macOS grant alongside the wedge instead of silently escalating
        // — which is the right way round, since the grant is exactly what was
        // wrong on the evening this task was written. One success flips it.
        everDelivered: s.everDelivered === true,
      }
      return mem
    }
  } catch {
    /* absent, corrupt, or storage refused — memory-only is fine */
  }
  mem = { wedgedAt: 0, level: 0, count: 0, goodRun: 0, stalls: 0, everDelivered: false }
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
  // A wedge ends whatever good run was accumulating: the evidence for climbing
  // is consecutive successes, and this is not one.
  s.goodRun = 0
  save()
}

/**
 * A SCREEN REQUEST STALLED — of any kind, and this is the counter the ADVICE
 * reads. Separate from rememberDisplayWedge, which only fires for the wedge
 * classification and only shapes the next REQUEST: a permission stall must not
 * touch the ladder (W1) but it absolutely counts as "the last thing we told
 * them to do did not work". Call it for every stall, once.
 */
export function rememberDisplayStall(): void {
  const s = load()
  s.stalls += 1
  save()
}

/** How many stalls in a row, with no screen delivered since. */
export function consecutiveDisplayStalls(): number {
  return load().stalls
}

/**
 * THE SCREEN ARRIVED — and until W1 (2026-08-29) that only counted at rung 0.
 * A success at rung 1 or 2 changed nothing, so the only exit from the floor
 * was the 24 h TTL, and the only exit anyone actually found was editing
 * localStorage from a console. Robert reached rung 2 in one evening on a cause
 * that was already gone and had to be handed that line.
 *
 * Now every success climbs exactly one rung, and reaching 0 clears the mark.
 * ONE rung, not straight to 0: the rung above did choke once and a single good
 * take is not proof it is cured — but two of them are enough to walk a floored
 * machine all the way back, which is W1's own gate. Compare with a wedge,
 * which still steps down one rung and re-stamps the TTL, so a machine that is
 * genuinely sick cannot ratchet itself up out of safe mode.
 *
 * It also records `everDelivered` — see classifyDisplayStall. That is the only
 * part that runs on a machine which never wedged at all, and it is why this no
 * longer returns early on a clean record.
 */
export function rememberDisplaySuccess(usedLevel: DisplayRequestLevel): void {
  const s = load()
  const first = !s.everDelivered
  s.everDelivered = true
  // The screen arrived: every remedy the advice was escalating through is moot.
  const hadStalls = s.stalls > 0
  s.stalls = 0
  if (s.wedgedAt === 0) {
    // Healthy machine. Nothing to climb; write only if this is the delivery
    // that proves the OS grant (or the one that ends a stall run), so a normal
    // take does not touch storage.
    if (first || hadStalls) save()
    return
  }
  if (usedLevel === 0) {
    // A FULL request that worked is the strongest evidence there is — nothing
    // of ours was dropped and the screen still arrived.
    s.level = 0
    s.wedgedAt = 0
    s.goodRun = 0
    save()
    return
  }
  // ONE GOOD TAKE IS NOT READY, AND THE FIRST CUT OF THIS CLIMBED ON ONE.
  //
  // W1 shipped "any success climbs one rung", which walks a machine straight
  // back onto the request that had just wedged it. Robert, 2026-08-30: "chrome
  // screen and mic wedges happend every second record after reopening chrome".
  // That is this, deterministically: wedge → rung 1 → good take → climb to rung
  // 0 → rung 0 is the request that wedges → wedge. Every other record, forever.
  // The old pre-W1 behaviour never oscillated because it never climbed at all;
  // it just stayed degraded for a day, which is the bug W1 was written to fix.
  // Both were wrong in the same place: how much evidence a climb needs.
  //
  // So a rung has to be EARNED CLEAR: consecutive good takes at the rung it is
  // standing on. A machine whose cause is gone comes back on its own in a few
  // takes, and a machine that genuinely chokes on the rung above settles where
  // it works instead of rediscovering that every second take.
  s.goodRun += 1
  if (s.goodRun < GOOD_TAKES_TO_CLIMB) {
    save()
    return
  }
  s.goodRun = 0
  s.level = clamp(s.level - 1)
  if (s.level === 0) s.wedgedAt = 0
  save()
}

/**
 * THE USER'S OWN WAY OUT, wired to a button instead of a console (W1, item 4).
 * Clears the degradation and the TTL. `everDelivered` survives: it is a
 * recorded fact about this machine's OS grant, and forgetting it would make
 * the very next stall misread a granted machine as an ungranted one.
 */
export function resetDisplayWedge(): void {
  const s = load()
  s.wedgedAt = 0
  s.level = 0
  s.count = 0
  s.goodRun = 0
  s.stalls = 0
  save()
}

/**
 * Why a display request never settled. 'permission' and 'wedge' look identical
 * from the page and are told apart by classifyDisplayStall. 'stale' is neither
 * — it is the request we REFUSED to make because this document already had one
 * stuck in it (displayInflight.ts), so it is known rather than inferred.
 */
export type DisplayStall = 'permission' | 'wedge' | 'stale'

/**
 * WHICH OF THE TWO NEVER-SETTLING FAILURES THIS IS (W1, item 3).
 *
 * With macOS screen recording ungranted for Chrome, the picker opens, Chrome
 * puts the real answer on screen, and getDisplayMedia hangs exactly as it does
 * in the wedge. Before W1 every such stall escalated the safe-mode ladder
 * against a permission no request of ours can satisfy, and told the user "the
 * device never connected" — blaming their hardware for an OS toggle.
 *
 * The discriminator is recorded fact: the macOS grant is per-application and
 * permanent once given, so a profile that has ever been handed a screen track
 * HAS it, and a stall there is Chrome's wedge. A profile on macOS that never
 * has is where the missing grant is live and must be named.
 *
 * Deliberately biased: a genuine first-take wedge on a fresh profile reads as
 * 'permission'. That costs one unescalated rung and a message naming both
 * causes. The other way round costs a machine 24 h on the floor over a
 * checkbox, which is the bug this exists to kill.
 */
export function classifyDisplayStall(os: OSName): DisplayStall {
  // Nowhere else gates getDisplayMedia behind an OS switch that hangs rather
  // than rejects: Windows has no such grant, and the Wayland portal REFUSES,
  // which arrives as a rejection and never reaches this path at all.
  if (os !== 'macos') return 'wedge'
  return load().everDelivered ? 'wedge' : 'permission'
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

/**
 * WHAT TO SAY ABOUT A SCREEN REQUEST THAT IS NOT COMING BACK — W1 item 3,
 * and the escalation this evening forced onto it.
 *
 * Two phases, because they are answering different questions. 'waiting' is
 * spoken while the request is STILL ALIVE and most of them still land: it may
 * not claim anything failed, and it must be the thing Chrome is already
 * showing on screen, since the user is looking at the picker. 'failed' is
 * spoken after the budget, when nothing was recorded.
 *
 * THE ADVICE HAS TO KNOW WHAT IT HAS ALREADY TOLD THIS USER. Until 2026-08-30
 * every wedge said the same sentence — quit Chrome, reopen — because the
 * classifier reads `everDelivered` and a profile that has ever been handed a
 * screen is, by that rule, forever in "Chrome's transient wedge". Robert did
 * exactly what it said, twice, and stalled four times: for him the sentence
 * was not advice, it was a loop. A stall that survives the refresh AND a
 * relaunch has FALSIFIED the browser-process story, and the remaining cause is
 * the one below the browser — macOS is not handing the screen to it. So from
 * the third stall in a row the text names that instead, with the toggle that
 * clears it. (macOS re-asks for screen recording periodically; the prompt can
 * open behind a full-screen window and never be seen, which looks from the
 * page exactly like a wedge and survives every ⌘Q.)
 *
 * The permission text names the browser the user is actually in. Sending
 * someone in Edge to switch Chrome on in System Settings is the same
 * blame-the-wrong-thing this task removes, one layer up.
 */
export function displayStallMessage(
  stall: DisplayStall,
  browser: BrowserName,
  phase: 'waiting' | 'failed',
  /** Consecutive stalls including this one — see rememberDisplayStall. */
  stalls: number = consecutiveDisplayStalls(),
): string {
  const name = BROWSER_LABEL[browser]
  const grant =
    `Open System Settings → Privacy & Security → Screen & System Audio Recording, ` +
    `turn ${name} on, then quit ${name} completely (⌘Q) and reopen it.`
  // The request we declined to make because one was already stuck here. The
  // app reloads on this, so the text is a status line, not a set of steps.
  if (stall === 'stale') {
    return `${name} still has the last screen request open, so a new one cannot get through. ` +
      `Refreshing the app to clear it…`
  }
  if (phase === 'waiting') {
    return stall === 'permission'
      ? `Still waiting for the screen. If ${name} is asking for screen-recording permission, ` +
          `macOS has not granted it yet — ${grant}`
      : `Still waiting for the screen. ${name} has the share but has not handed it over — ` +
          `if nothing happens, nothing is being recorded and you can press record again.`
  }
  // THE THIRD ONE IN A ROW IS NOT A BROWSER PROBLEM ANY MORE. Refresh (stall 1)
  // and ⌘Q (stall 2) have both been spent, and neither produced a screen.
  if (stalls >= 3) {
    return `macOS is not handing the screen to ${name} — the share has stalled ${stalls} times in ` +
      `a row and restarting ${name} did not change it, so the block is below the browser. ` +
      `Open System Settings → Privacy & Security → Screen & System Audio Recording and turn ` +
      `${name} OFF and then ON again (a stale grant looks exactly like this), then quit ${name} ` +
      `with ⌘Q and reopen. Also check for a macOS permission dialog hiding behind your windows: ` +
      `it re-asks every so often, and an unanswered one stalls every share.`
  }
  if (stall === 'permission') {
    // NOT "the device never connected", which is what this said until W1
    // while Chrome was displaying the real answer on screen.
    return `macOS has not granted ${name} permission to record the screen, so the share never ` +
      `arrived and nothing was recorded. ${grant} If it is already on, the share is stuck ` +
      `instead — quit ${name} (⌘Q), reopen, and try again.`
  }
  return `${name} accepted the share but never delivered the screen — nothing was recorded, even ` +
    `after a refresh. Quit ${name} completely (⌘Q), reopen, and try again.`
}
