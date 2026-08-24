/**
 * THE ONE OWNER OF EVERY LIVE DEVICE IN THIS TAB.
 *
 * Four separate leaks have been fixed in this family already (ledger
 * 2026-08-23 entries 4, 5, 6) and the indicators kept coming back, because
 * every one of those fixes released devices from somewhere DOWNSTREAM of the
 * acquisition: the session's channel list, then its `acquiredStreams`, then
 * the undelivered tracks of the picker result. Each new code path — a resume,
 * a cancel landing mid-arm, a picker that hands back an extra track — is a new
 * chance to forget one, and forgetting one is not a cosmetic bug: the browser
 * keeps the device claimed, so the NEXT take's getUserMedia sits there and the
 * app reads as "stuck waiting for mic".
 *
 * This module ends that class of bug by inverting the ownership. Every stream
 * the platform hands over is registered HERE, at the three call sites that can
 * possibly produce one (acquire.ts), the instant it exists and before any
 * await. Whatever else happens afterwards — cancel, stop, throw, refresh, a
 * branch nobody thought about — `releaseAllDevices()` can still find it and
 * turn it off. Registration is the only thing a future call site has to
 * remember, and it is one line next to the getUserMedia/getDisplayMedia call.
 *
 * Releasing is idempotent and cheap: stopping an already-stopped track is a
 * no-op, so an over-eager release costs nothing while a missed one costs the
 * user their next recording.
 */

/** Every stream taken from a device that has not been released yet. */
const guarded = new Set<MediaStream>()
let unloadInstalled = false

function stopTracks(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop()
    } catch {
      /* already stopped — releasing is idempotent by design */
    }
  }
}

function hasLiveTrack(stream: MediaStream): boolean {
  return stream.getTracks().some((t) => t.readyState !== 'ended')
}

/**
 * A refresh mid-take, or mid-ARM, must not leave a device running. The session
 * installs its own pagehide guard, but only once arming has RETURNED — and the
 * whole complaint is about takes that never get that far, where the picker has
 * already closed (screen live, Chrome's indicator lit) and a slow device is
 * still outstanding. Registering here installs the net at the first device
 * instead, so the window with a live device and no unload guard is closed.
 * Track stopping is synchronous, which is what makes it safe in pagehide.
 */
function installUnloadNet(): void {
  if (unloadInstalled || typeof window === 'undefined') return
  unloadInstalled = true
  window.addEventListener('pagehide', () => releaseAllDevices('pagehide'))
}

/** Register a stream the platform just handed us. Call BEFORE any await. */
export function guardStream(stream: MediaStream | null | undefined): void {
  if (!stream) return
  installUnloadNet()
  // Cheap hygiene so the set cannot grow across a long session of takes.
  for (const s of guarded) if (!hasLiveTrack(s)) guarded.delete(s)
  guarded.add(stream)
}

/**
 * Turn every device this tab holds off, now. Synchronous on purpose: it is
 * called from pagehide and from the FIRST line of cancel, where nothing may be
 * allowed to await in front of it.
 */
export function releaseAllDevices(reason: string): void {
  if (guarded.size === 0) return
  let released = 0
  for (const s of guarded) {
    if (hasLiveTrack(s)) released++
    stopTracks(s)
  }
  guarded.clear()
  if (released > 0) console.info(`[capture] released ${released} device stream(s) — ${reason}`)
}

/** Streams still holding at least one live track. Diagnostics and tests. */
export function liveDeviceStreamCount(): number {
  let n = 0
  for (const s of guarded) if (hasLiveTrack(s)) n++
  return n
}

/** Test seam only — the module-level set outlives individual test cases. */
export function resetDeviceGuardForTests(): void {
  guarded.clear()
}
