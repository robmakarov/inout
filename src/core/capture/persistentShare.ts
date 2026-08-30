/**
 * KEEP THE SCREEN SHARE ALIVE BETWEEN TAKES — task O12, built 2026-08-30
 * because Robert was blocked by the thing it prevents: "i got screen permissions
 * wedges after first record … cant test further until chrome wedge is gone".
 *
 * THE WEDGE IS CHROME'S AND CANNOT BE CURED FROM A PAGE. docs/SCREEN_WEDGE.md
 * is the case file: `getDisplayMedia` neither resolves nor rejects, the claim
 * lives in the browser process, it survives a refresh and a tab close, and only
 * quitting Chrome reliably clears it. Every mitigation this project has shipped
 * bounds the damage. NONE of them reduce the number of times the page asks.
 *
 * This one does, and it is the only lever that does: a take that reuses the
 * share it already has makes NO getDisplayMedia call, so there is no second
 * request to wedge. The case file has said so since 2026-08-25 — "one share for
 * the whole session removes the picker from every take after the first and the
 * create/teardown churn the wedge accumulates on" — and it is Robert's own
 * field evidence, since the ordering that avoids the wedge for him (share
 * first, load the game after) is exactly the state this makes permanent.
 *
 * WHAT IT COSTS, and it is why this ships OFF and is his to turn on: the macOS
 * screen-sharing indicator STAYS LIT between takes. That is real idle device
 * access, and "no idle camera/mic" is a frozen product rule — which is why O12
 * has always been Robert-gated rather than something a session may decide.
 * The rule's reason is a camera watching a room; a screen share the user
 * explicitly picked, in a tab they are recording with, is a different bargain —
 * but it is still his bargain to make, so nothing here is on by default.
 *
 * WHAT IS NOT GIVEN UP: the release paths. The held stream stays registered
 * with deviceGuard, so `releaseAllDevices` on pagehide, on cancel, and on the
 * unload net still turns it off — the guarantee that no device outlives the tab
 * is untouched. It is also dropped the moment the user stops sharing from
 * Chrome's own bar, turns the Screen chip off, or presses the control that
 * hands it back.
 *
 *   ?keepshare=1     (this load only)
 *   localStorage['inout.capture.keepshare']   (sticky)
 */

interface HeldShare {
  stream: MediaStream
  video: MediaStreamTrack
  /** The system/tab audio track that came with it, when the user asked for one. */
  audio: MediaStreamTrack | null
}

let held: HeldShare | null = null

const STORAGE_KEY = 'inout.capture.keepshare'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('keepshare')
  return v === '1' ? true : v === '0' ? false : null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let override: boolean | null = null

export function keepShareEnabled(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? false
}

export function setKeepShare(on: boolean | null): void {
  override = on
  try {
    if (on === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

/**
 * Keep this take's screen share for the next one. Called at STOP and never at
 * cancel: a cancelled arm is the one case where the user may be trying to get
 * out of a share that is already going wrong.
 */
export function holdShare(
  stream: MediaStream,
  video: MediaStreamTrack,
  audio: MediaStreamTrack | null,
): void {
  if (!keepShareEnabled() || video.readyState !== 'live') return
  held = { stream, video, audio }
  // The user pressing Chrome's own "Stop sharing" ends the track without
  // telling the page anything else. Drop the hold there and then, so the next
  // record asks for a fresh share instead of handing out a dead one.
  video.addEventListener('ended', () => releaseHeldShare('the user stopped sharing'), { once: true })
  console.info(
    '[capture] keeping the screen share for the next take — no picker, and no second ' +
      'getDisplayMedia to wedge. The macOS sharing indicator stays lit until you stop it (O12)',
  )
}

/** The live share this session is holding, or null. Never returns a dead one. */
export function heldShare(): HeldShare | null {
  if (!held) return null
  if (held.video.readyState !== 'live') {
    held = null
    return null
  }
  return held
}

/** True for a track the holder owns — the stop path must not stop these. */
export function isHeldTrack(track: MediaStreamTrack): boolean {
  const h = heldShare()
  return !!h && (track === h.video || track === h.audio)
}

export function releaseHeldShare(reason: string): void {
  const h = held
  held = null
  if (!h) return
  for (const t of [h.video, h.audio]) {
    if (t && t.readyState === 'live') t.stop()
  }
  console.info(`[capture] screen share released (${reason})`)
}

/** Test seam. */
export function resetPersistentShareForTests(): void {
  held = null
  override = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* memory-only */
  }
}
