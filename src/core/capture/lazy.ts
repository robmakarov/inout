/**
 * Lazy entry points for the heavy capture modules (task O7).
 *
 * session.ts pulls the live compositor, the measured-audio worklet path and
 * mediabunny; recovery.ts pulls mediabunny to probe salvaged blobs. None of it
 * is needed to paint the capture screen, and every byte of it stands between
 * the user and the record button.
 *
 * Latency is protected by warming, not by luck: warmCapturePipeline() (called
 * at mount, before any device is touched) resolves both of these, so by the
 * time a record click happens the code is already fetched and parsed. Each
 * loader caches its promise, so the click never starts a second fetch.
 */

let engine: Promise<typeof import('./session')> | null = null
let recovery: Promise<typeof import('./recovery')> | null = null

export function loadCaptureEngine(): Promise<typeof import('./session')> {
  return (engine ??= import('./session'))
}

export function loadRecovery(): Promise<typeof import('./recovery')> {
  return (recovery ??= import('./recovery'))
}
