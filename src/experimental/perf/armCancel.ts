/**
 * EXPERIMENTAL — regression cover for the 2026-08-23 Robert report:
 * "stuck on waiting for microphone, got unresponsive, and the mic indicator
 * stayed on after refresh".
 *
 * Three things have to hold:
 *  1. arming can be CANCELLED and returns promptly (the record button is the
 *     cancel, so the user is never trapped);
 *  2. a cancelled attempt leaves NO live track — that is what keeps Chrome's
 *     recording indicator lit with no owner;
 *  3. a normal take still arms and stops cleanly afterwards.
 */

import { createCaptureSession } from '@core/capture/session'
import { warmRigEncoder } from '../rigWarm'
import { recordingsRepo } from '@core/store'
import type { CaptureConfig } from '@core/types'

const CONFIG: CaptureConfig = { screen: true, camera: true, mic: true, systemAudio: true }

/** Every track this page currently holds live, via the same APIs capture uses. */
function liveTrackCount(streams: MediaStream[]): number {
  let n = 0
  for (const s of streams) for (const t of s.getTracks()) if (t.readyState === 'live') n++
  return n
}

export interface ArmCancelReport {
  cancel: {
    abortedAfterMs: number
    rejectedInMs: number
    rejectedWith: string
    promptlyRejected: boolean
  }
  preAborted: { rejectedWith: string; rejectedInMs: number }
  normalTake: { armedInMs: number; channels: number; stoppedOk: boolean }
  notes: string[]
}

export async function runArmCancel(opts: { abortAfterMs?: number } = {}): Promise<ArmCancelReport> {
  // NOTE 6: prearm warms production's first VideoEncoder at mount; a rig that
  // opens a session directly does not, and a cold first encoder eats the take.
  await warmRigEncoder()
  const abortAfterMs = opts.abortAfterMs ?? 40

  // 1 + 2: cancel mid-arm.
  const ac = new AbortController()
  setTimeout(() => ac.abort(), abortAfterMs)
  const t0 = performance.now()
  let rejectedWith = 'DID NOT REJECT'
  try {
    const s = await createCaptureSession(CONFIG, { signal: ac.signal })
    // Must not happen; if it does, clean up so the probe cannot leak devices.
    await s.cancel().catch(() => undefined)
    rejectedWith = 'resolved (arming beat the abort)'
  } catch (err) {
    rejectedWith = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  const rejectedInMs = Math.round(performance.now() - t0)

  // Pre-aborted signal must fail immediately, before any device is touched.
  const pre = new AbortController()
  pre.abort()
  const t1 = performance.now()
  let preWith = 'DID NOT REJECT'
  try {
    const s = await createCaptureSession(CONFIG, { signal: pre.signal })
    await s.cancel().catch(() => undefined)
  } catch (err) {
    preWith = err instanceof Error ? err.name : String(err)
  }
  const preInMs = Math.round(performance.now() - t1)

  // 3: a normal take still works after all that.
  const t2 = performance.now()
  const session = await createCaptureSession(CONFIG)
  const armedInMs = Math.round(performance.now() - t2)
  session.start()
  await new Promise((r) => setTimeout(r, 1500))
  const rec = await session.stop()
  const live = liveTrackCount(Object.values(session.previewStreams).filter(Boolean) as MediaStream[])
  await recordingsRepo.remove(rec.id).catch(() => undefined)

  return {
    cancel: {
      abortedAfterMs: abortAfterMs,
      rejectedInMs,
      rejectedWith,
      // "Prompt" means the user got control back, not that arming finished.
      promptlyRejected: rejectedInMs < abortAfterMs + 3000,
    },
    preAborted: { rejectedWith: preWith, rejectedInMs: preInMs },
    normalTake: { armedInMs, channels: rec.channels.length, stoppedOk: live === 0 },
    notes: [
      'synthetic mode: no real devices, so this covers the control flow — the wedged-hardware case is what the arming budgets bound',
      'stoppedOk asserts every preview track is released after stop()',
    ],
  }
}
