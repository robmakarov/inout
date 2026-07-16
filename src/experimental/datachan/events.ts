/**
 * EXPERIMENTAL — Timed Data Channels (Experiment 6).
 *
 * A data channel is a sequence of timestamped interaction events sharing the
 * recording's epoch, so any event can later be mapped to output time with the
 * SAME timeline math media uses. This module provides:
 *   - the event schema (deliberately content-free for keys: modifiers and
 *     counts only, never keystrokes — privacy is a schema property, not a
 *     policy promise);
 *   - a recorder that captures pointer/click/key/visibility/resize events in
 *     the app's own tab;
 *   - NDJSON persistence as a sidecar (never inside Recording);
 *   - a replay cursor + output-time mapping through TimeMap.
 *
 * Browser reality, recorded honestly: events are observable in THIS tab only.
 * When the captured surface is another window, cursor data requires
 * CaptureController/Region APIs — out of scope, noted in RESEARCH.md.
 */

import type { EditState, Recording } from '@core/types'
import { channelTimeMap, invert, sourceAt } from '../timemap/timemap'
import { expWritable } from '../shared/opfs'

export const DATA_CHANNEL_VERSION = 1
export const POINTER_SAMPLE_MS = 50 // 20Hz is plenty for zoom/highlight heuristics

export type DataEvent =
  | { t: number; kind: 'pointer'; x: number; y: number }
  | { t: number; kind: 'click'; x: number; y: number; button: number }
  | { t: number; kind: 'key'; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }
  | { t: number; kind: 'visibility'; visible: boolean }
  | { t: number; kind: 'resize'; width: number; height: number }

export interface DataChannelSidecar {
  v: number
  recordingId: string | null
  /** epoch used for t (performance.now() at recorder start). */
  epochAbsMs: number
  events: DataEvent[]
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

export interface DataChannelRecorder {
  readonly events: readonly DataEvent[]
  /** Bind the sidecar to a recording id once known (at stop). */
  stop(recordingId: string | null): Promise<DataChannelSidecar>
}

/**
 * Start observing. `epochAbsMs` should be performance.now() at the moment the
 * capture session's recording started, so t aligns with the media timeline.
 */
export function startDataChannel(epochAbsMs: number, opts?: { persist?: boolean }): DataChannelRecorder {
  const events: DataEvent[] = []
  const now = (): number => performance.now() - epochAbsMs
  let lastPointerT = -Infinity

  const onPointer = (e: PointerEvent): void => {
    const t = now()
    if (t - lastPointerT < POINTER_SAMPLE_MS) return
    lastPointerT = t
    events.push({ t, kind: 'pointer', x: e.clientX, y: e.clientY })
  }
  const onClick = (e: MouseEvent): void => {
    events.push({ t: now(), kind: 'click', x: e.clientX, y: e.clientY, button: e.button })
  }
  const onKey = (e: KeyboardEvent): void => {
    // Schema-level privacy: no key identity, only modifier state.
    events.push({
      t: now(),
      kind: 'key',
      alt: e.altKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
    })
  }
  const onVisibility = (): void => {
    events.push({ t: now(), kind: 'visibility', visible: document.visibilityState === 'visible' })
  }
  const onResize = (): void => {
    events.push({ t: now(), kind: 'resize', width: innerWidth, height: innerHeight })
  }

  window.addEventListener('pointermove', onPointer, { passive: true })
  window.addEventListener('click', onClick, true)
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', onResize)

  return {
    events,
    async stop(recordingId: string | null): Promise<DataChannelSidecar> {
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      const sidecar: DataChannelSidecar = {
        v: DATA_CHANNEL_VERSION,
        recordingId,
        epochAbsMs,
        events,
      }
      if (opts?.persist ?? true) {
        const w = await expWritable(`${recordingId ?? 'unbound'}.datachan.ndjson`)
        await w.write(events.map((e) => JSON.stringify(e) + '\n').join(''))
        await w.close()
      }
      return sidecar
    },
  }
}

// ---------------------------------------------------------------------------
// replay + alignment
// ---------------------------------------------------------------------------

/** Events overlapping output window [fromMs, toMs) for a given edit. */
export function eventsInOutputWindow(
  sidecar: DataChannelSidecar,
  r: Recording,
  e: EditState,
  fromMs: number,
  toMs: number,
): { outMs: number; event: DataEvent }[] {
  // Data events live on the RECORDING timeline; reuse a video channel's map
  // where possible, else fall back to the global-trim-only mapping.
  const refChannel = r.channels.find((c) => c.media === 'video') ?? r.channels[0]
  if (!refChannel) return []
  // recording time -> output time: build from the channel map (output->local),
  // shifted to recording coordinates via startOffsetMs.
  const outToLocal = channelTimeMap(r, e, refChannel.id)
  const localToOut = invert(outToLocal)
  const out: { outMs: number; event: DataEvent }[] = []
  for (const ev of sidecar.events) {
    const localT = ev.t - refChannel.startOffsetMs
    const outMs = sourceAt(localToOut, localT)
    if (outMs !== null && outMs >= fromMs && outMs < toMs) out.push({ outMs, event: ev })
  }
  return out.sort((a, b) => a.outMs - b.outMs)
}

/** Simple derived signal demo: click moments as chapter candidates. */
export function clickTimesOnOutput(
  sidecar: DataChannelSidecar,
  r: Recording,
  e: EditState,
  durationMs: number,
): number[] {
  return eventsInOutputWindow(sidecar, r, e, 0, durationMs)
    .filter((x) => x.event.kind === 'click')
    .map((x) => x.outMs)
}
