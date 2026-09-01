/**
 * IS THERE ROOM FOR THE TAKE ABOUT TO BE MADE — asked before the record press,
 * answered in minutes of recording (task B5).
 *
 * The in-take guard (core/capture/diskGuard.ts) is measured and cannot speak
 * until 8 s of a take exist; it gives two minutes' notice, which is enough to
 * finish a thought and useless for planning. This is the other half: on the
 * idle capture screen, ask the machine how much room it has and translate it
 * into the only unit that answers the question — how long you could record.
 *
 * IT IS NEVER ON THE RECORD PATH. Instant record start is a frozen constraint,
 * so nothing here runs from the press: the read happens while the screen sits
 * idle, on mount and whenever the choice that changes the answer changes
 * (quality step, channels, a finished take that just consumed the space).
 *
 * THE RATE IS THIS MACHINE'S OWN. A model would have to guess how compressible
 * the content is — the same guess that made the export size panel wrong by
 * 2.15x (B1) — and the machine has better evidence lying around: the takes it
 * already made. Their measured byte rate at the same quality step is the
 * prediction; the configured bitrates are the fallback for a profile with no
 * history, and the verdict says which one it used.
 */
import { plannedBytesPerSec } from '@core/capture/captureBitrate'
import { preflightVerdict, type PreflightVerdict } from '@core/capture/diskGuard'
import type { CaptureConfig, Recording } from '@core/types'

/** Ignore takes too short to have a meaningful rate — the first seconds of a
 *  take are the encoder waking up, not its steady write rate (the same reason
 *  diskGuard refuses to judge under 8 s). */
const MIN_TAKE_MS = 8_000
/** How many recent takes the median is taken over. Enough to shrug off one
 *  unusual take, short enough to follow a change in what is being recorded. */
const HISTORY_TAKES = 5

/** Everything a take wrote: its channels plus the composite beside them. */
export function takeBytes(r: Recording): number {
  return r.channels.reduce((n, c) => n + (c.bytes ?? 0), 0) + (r.composite?.bytes ?? 0)
}

/** The measured byte rate of one take, or null when it cannot be read (a take
 *  recorded before the sizes were kept, or one too short to judge). */
export function takeBytesPerSec(r: Recording): number | null {
  const bytes = takeBytes(r)
  if (!(bytes > 0) || r.durationMs < MIN_TAKE_MS) return null
  return bytes / (r.durationMs / 1000)
}

/**
 * The median rate of this machine's recent takes at this quality step.
 *
 * Same step only: the step binds what capture asks for, so a 540p take says
 * nothing about a max one. Median rather than mean because one 60 fps game tab
 * would drag a mean up and keep it there.
 */
export function measuredBytesPerSec(
  takes: readonly Recording[],
  step: string | undefined,
  limit = HISTORY_TAKES,
): number | null {
  const rates = [...takes]
    .filter((t) => (step === undefined ? true : t.qualityStep === step))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map(takeBytesPerSec)
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b)
  if (!rates.length) return null
  const mid = Math.floor(rates.length / 2)
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2
}

export interface RatePrediction {
  bytesPerSec: number
  /** 'measured' = this machine's own takes at this step · 'planned' = the
   *  configured bitrates, because there are no such takes to read. */
  source: 'measured' | 'planned'
  takesRead: number
}

export function predictBytesPerSec(
  takes: readonly Recording[],
  step: string | undefined,
  config: CaptureConfig & { composite?: boolean },
): RatePrediction {
  const sameStep = takes.filter((t) => t.qualityStep === step)
  const measured = measuredBytesPerSec(takes, step)
  if (measured !== null) {
    return {
      bytesPerSec: measured,
      source: 'measured',
      takesRead: Math.min(sameStep.length, HISTORY_TAKES),
    }
  }
  return { bytesPerSec: plannedBytesPerSec(config), source: 'planned', takesRead: 0 }
}

export interface Preflight extends PreflightVerdict {
  source: RatePrediction['source']
}

/**
 * The whole answer: ask the machine for its storage estimate, price a second of
 * this take, and say how long that leaves. Null whenever anything is unknown —
 * a browser without `storage.estimate`, a quota of zero, a rate of zero. An
 * instrument that cannot measure says nothing rather than guessing.
 */
export async function readPreflight(
  takes: readonly Recording[],
  step: string | undefined,
  config: CaptureConfig & { composite?: boolean },
): Promise<Preflight | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  if (!config.screen && !config.camera && !config.mic && !config.systemAudio) return null
  let est: StorageEstimate
  try {
    est = await navigator.storage.estimate()
  } catch {
    return null
  }
  const rate = predictBytesPerSec(takes, step, config)
  const verdict = preflightVerdict({
    usageBytes: est.usage ?? 0,
    quotaBytes: est.quota ?? 0,
    bytesPerSec: rate.bytesPerSec,
  })
  return verdict ? { ...verdict, source: rate.source } : null
}
