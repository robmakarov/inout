/**
 * EXPERIMENTAL — X4's verdict, as a re-runnable measurement.
 *
 * THE IDEA X4 WAS WRITTEN ON: the render's floor is decode (note 13), the
 * expensive part of decode is JS on the render's own thread, and note 13 only
 * ever retired SINGLE-THREAD rescheduling — so shard the JS across threads, one
 * decoder worker per channel, and the floor should fall towards core count.
 *
 * IT WAS BUILT, MEASURED, AND DELETED. The farm produced a byte-identical file
 * (SHA-equal output across nine lanes) at 0.99-1.08× the speed, against a gate
 * asking for ≥2×. What survives is this: the three numbers that say WHY, so the
 * idea is refuted with data rather than remembered as a hunch.
 *
 *   inThreadMs        the render's own decodeFloor for these frames
 *   workerAloneMs     the same schedule, in a worker, nothing else running
 *   workerDuringMs    the same schedule, in a worker, WHILE an export of the
 *                     same take runs on another thread
 *
 * A worker decodes at 0.93-1.04× the main thread when it is alone — so the SITE
 * is free. It decodes 3.7-5× more slowly while the render is encoding beside it
 * — so the work is competing for something a second thread does not create.
 * That is also why step 2 (GOP-range sharding WITHIN a channel) is not the next
 * lever: it adds more concurrent decoders against the same contended resource.
 *
 * The picture handoff was measured separately before the farm was deleted and
 * is not the cost: 57-117 ms of an 18-26 s render, 0.4 %.
 */
import { exportRecording } from '@core/compose'
import { blobStore } from '@core/store'
import { channelSourceTimeAt, outputDurationMs } from '@core/timeline'
import { openVideoChannel } from '@core/compose/video'
import type { ChannelRecording, EditState, Recording } from '@core/types'
import type { DecodeSiteIn, DecodeSiteOut } from './decodeSite.worker'

export interface DecodeSiteRow {
  channelKind: string
  frames: number
  /** decodeFloor for this one channel, on the calling thread. */
  inThreadMs: number
  /** The same schedule in a worker, with nothing else running. */
  workerAloneMs: number
  /** The same schedule in a worker, while an export of the take runs. */
  workerDuringMs: number
  /** workerAlone / inThread — is a worker intrinsically slower? (≈1 = no) */
  siteRatio: number
  /** workerDuring / workerAlone — what contention with the render costs. */
  contentionRatio: number
}

function scheduleFor(
  recording: Recording,
  edit: EditState,
  channel: ChannelRecording,
  fps: number,
): Float64Array {
  const totalFrames = Math.max(1, Math.ceil((outputDurationMs(edit) / 1000) * fps - 1e-9))
  const times = new Float64Array(totalFrames)
  for (let f = 0; f < totalFrames; f++) {
    const localMs = channelSourceTimeAt(recording, edit, channel.id, (f / fps) * 1000)
    times[f] = localMs === null ? -1 : localMs / 1000
  }
  return times
}

function decodeInWorker(
  channel: ChannelRecording,
  times: Float64Array,
): Promise<{ decodeMs: number; runMs: number; frames: number } | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./decodeSite.worker.ts', import.meta.url), {
      type: 'module',
    })
    const finish = (v: { decodeMs: number; runMs: number; frames: number } | null): void => {
      worker.terminate()
      resolve(v)
    }
    worker.onmessage = (ev: MessageEvent<DecodeSiteOut>) => {
      const msg = ev.data
      if (msg.type === 'end') {
        finish({ decodeMs: Math.round(msg.decodeMs), runMs: Math.round(msg.runMs), frames: msg.frames })
      } else if (msg.type === 'error') {
        finish(null)
      }
    }
    worker.onerror = () => finish(null)
    worker.postMessage({
      type: 'start',
      blobKey: channel.blobKey,
      channelId: channel.id,
      kind: channel.kind,
      localEndSec: channel.durationMs / 1000,
      times,
    } satisfies DecodeSiteIn)
  })
}

async function decodeInThread(
  recording: Recording,
  edit: EditState,
  channel: ChannelRecording,
  fps: number,
): Promise<{ frames: number; wallMs: number }> {
  const blob = await blobStore.read(channel.blobKey)
  const reader = await openVideoChannel(blob, channel.id, channel.kind, channel.durationMs / 1000)
  if (!reader) return { frames: 0, wallMs: 0 }
  const totalFrames = Math.max(1, Math.ceil((outputDurationMs(edit) / 1000) * fps - 1e-9))
  const t0 = performance.now()
  let frames = 0
  try {
    for (let f = 0; f < totalFrames; f++) {
      const localMs = channelSourceTimeAt(recording, edit, channel.id, (f / fps) * 1000)
      if (localMs === null) continue
      if (await reader.sampleAt(localMs / 1000)) frames++
    }
  } finally {
    reader.dispose()
  }
  return { frames, wallMs: Math.round(performance.now() - t0) }
}

export async function measureDecodeSite(
  recording: Recording,
  edit: EditState,
  fps = 30,
): Promise<DecodeSiteRow[]> {
  const rows: DecodeSiteRow[] = []
  for (const channel of recording.channels.filter((c) => c.media === 'video')) {
    const times = scheduleFor(recording, edit, channel, fps)
    const inThread = await decodeInThread(recording, edit, channel, fps)
    const alone = await decodeInWorker(channel, times)
    if (!alone) continue
    // The contention lane: start the decode and an export of the same take at
    // once, and read what the decode cost. This is the number the farm was
    // actually paying, and the reason it did not pay off.
    const during = await Promise.all([
      decodeInWorker(channel, times),
      exportRecording({ recording, edit }).catch(() => null),
    ]).then(([d]) => d)
    rows.push({
      channelKind: channel.kind,
      frames: alone.frames,
      inThreadMs: inThread.wallMs,
      workerAloneMs: alone.decodeMs,
      workerDuringMs: during?.decodeMs ?? 0,
      siteRatio: Math.round((alone.decodeMs / Math.max(1, inThread.wallMs)) * 100) / 100,
      contentionRatio:
        during && alone.decodeMs > 0
          ? Math.round((during.decodeMs / alone.decodeMs) * 100) / 100
          : 0,
    })
  }
  return rows
}
