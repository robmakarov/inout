/**
 * EXPERIMENTAL — X6 evidence: a raw channel on WebCodecs against the same raw
 * channel on MediaRecorder, through the REAL createCaptureSession.
 *
 * THE GATE THIS EXISTS FOR IS O3a's, and it is the reason O3a refused to move
 * the raw channels to MP4 in the first place: "kill at 50 %, the prefix DECODES
 * to within the tail band". O3a measured Chrome's MediaRecorder MP4 leaving 753
 * bytes — the init box — halfway through an 8 s take, against 1.09 MB of
 * decodable WebM, i.e. the whole file arrives at stop and a tab kill loses the
 * take. X6 claims the fragmented-MP4 + per-chunk-flush pattern answers that.
 *
 * HOW THE KILL IS SIMULATED, and why this is the honest form. The worker holds
 * an EXCLUSIVE SyncAccessHandle while recording, so the file cannot be read
 * from this thread mid-take — which is also true of the live composite, and is
 * fine, because a real tab kill drops the lock. What a kill leaves on disk is
 * exactly the bytes flushed so far, so the test is: record the take, then
 * TRUNCATE a copy of the file at the halfway byte and decode that. A container
 * that only becomes valid at finalize decodes to nothing; one that streams
 * decodes to about half the take.
 *
 * BOTH ENCODERS RUN THE SAME TAKE SHAPE through the same session, and the
 * MediaRecorder lane is not a straw man — it is the shipped path, selected by
 * the same preference the product reads.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { blobStore } from '@core/store'
import { createCaptureSession } from '@core/capture/session'
import { warmVideoEncoder } from '@core/capture/encoderWarm'
import { setRawVideoCodec, rawVideoCodec, type RawVideoCodec } from '@core/capture/rawCodec'
import type { Recording } from '@core/types'

/** O8's shipped tail band — the same one P0-tail-raw is gated on. */
const TAIL_BAND_MS = 400
/** Where the simulated kill lands, as a fraction of the file's bytes. */
const KILL_AT = 0.5

export interface ChannelProbe {
  kind: string
  mimeType: string
  blobKey: string
  bytes: number
  /** What the session declared for this channel. */
  declaredDurationMs: number
  /** Packet-computed duration of the WHOLE file. */
  fileDurationMs: number | null
  codec: string | null
  frames: number | null
  /** declared − last decodable frame: the tail band (O8, ≤400 ms). */
  tailGapMs: number | null
  /** THE O3a TEST: decode a copy truncated at KILL_AT of its bytes. */
  kill: {
    atBytes: number
    /** Duration the truncated prefix decodes to, ms. null = undecodable. */
    prefixDurationMs: number | null
    prefixFrames: number | null
    /** prefixDuration / fileDuration — 0 means a tab kill loses the take. */
    keptFraction: number | null
  }
}

/**
 * Frames of one channel at given take-relative instants, at a fixed size.
 *
 * THE FIRST VERSION OF THE QUALITY LANE COMPARED THESE DIRECTLY AND WAS WRONG.
 * Two lanes are two separate takes of a MOVING synthetic source, started at
 * different wall-clock moments, so the frame at t=3.0 s in one is not the same
 * PICTURE as the frame at t=3.0 s in the other — it is the same clock reading
 * of a different phase. That read 21.9 dB and would have been reported as a
 * quality regression. The tell was in the numbers: the CAMERA lane, at 0.75× the
 * bytes, scored WORSE-ish (24.4 dB) than it had any right to if PSNR were
 * tracking bitrate, while the SCREEN at 0.22× scored 21.9 — no ordering at all.
 * So the comparison searches a WINDOW and keeps the best match, which removes
 * the phase and leaves the encoding difference.
 */
async function framesOf(blob: Blob, times: number[], w: number, h: number): Promise<(ImageData | null)[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return times.map(() => null)
    const sink = new VideoSampleSink(track)
    const out: (ImageData | null)[] = []
    for (const t of times) {
      const sample = await sink.getSample(t)
      if (!sample) {
        out.push(null)
        continue
      }
      ctx.clearRect(0, 0, w, h)
      sample.draw(ctx, 0, 0, w, h)
      sample.close()
      out.push(ctx.getImageData(0, 0, w, h))
    }
    return out
  } catch {
    return times.map(() => null)
  } finally {
    input.dispose()
  }
}

function psnrOf(a: ImageData, b: ImageData): number {
  let sum = 0
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c]! - b.data[i + c]!
      sum += d * d
      n++
    }
  }
  const mse = sum / Math.max(1, n)
  return mse === 0 ? 99 : Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10
}

export interface CodecLane {
  codec: RawVideoCodec
  /** What the session ACTUALLY used — capability can override the preference. */
  effective: string
  takeMs: number
  recordingDurationMs: number
  channels: ChannelProbe[]
  /** Console lines the capture path emitted, so the lane names its own engine. */
  captureLog: string[]
  /** Kept alive across lanes so the two can be compared pixel to pixel. */
  keptKeys?: Record<string, string>
}

export interface QualityRow {
  kind: string
  /** PSNR between the two lanes' frames at the same take-relative instants. */
  psnrDb: number | null
  webcodecsBytes: number
  mediarecorderBytes: number
  bytesRatio: number
}

export interface X6Report {
  notes: string[]
  lanes: CodecLane[]
  /** Is the smaller file also a worse picture? The gate nobody wrote. */
  quality: QualityRow[]
  gates: Record<string, { pass: boolean; detail: string }>
}

async function probeFile(
  blob: Blob,
): Promise<{ durationMs: number | null; frames: number | null; codec: string | null; lastFrameMs: number | null }> {
  let input: Input | null = null
  try {
    input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { durationMs: null, frames: null, codec: null, lastFrameMs: null }
    const durationSec = await input.computeDuration()
    let frames = 0
    let lastTs = 0
    const { EncodedPacketSink } = await import('mediabunny')
    const sink = new EncodedPacketSink(track)
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
      frames++
      lastTs = p.timestamp
    }
    return {
      durationMs: Math.round(durationSec * 1000),
      frames,
      codec: (await track.getCodecParameterString()) ?? track.codec ?? null,
      lastFrameMs: Math.round(lastTs * 1000),
    }
  } catch {
    return { durationMs: null, frames: null, codec: null, lastFrameMs: null }
  } finally {
    input?.dispose()
  }
}

async function runLane(codec: RawVideoCodec, takeMs: number): Promise<CodecLane> {
  setRawVideoCodec(codec)
  const captureLog: string[] = []
  const realInfo = console.info
  const realWarn = console.warn
  const tap =
    (real: typeof console.info) =>
    (...a: unknown[]): void => {
      if (typeof a[0] === 'string' && a[0].startsWith('[capture')) captureLog.push(a[0])
      real.apply(console, a as [])
    }
  console.info = tap(realInfo)
  console.warn = tap(realWarn)

  let recording: Recording
  try {
    const session = await createCaptureSession({
      screen: true,
      camera: true,
      mic: true,
      systemAudio: false,
    })
    session.start()
    await new Promise((r) => setTimeout(r, takeMs))
    recording = await session.stop()
  } finally {
    console.info = realInfo
    console.warn = realWarn
  }

  const channels: ChannelProbe[] = []
  for (const ch of recording.channels) {
    if (ch.media !== 'video') continue
    const blob = await blobStore.read(ch.blobKey)
    const whole = await probeFile(blob)
    const atBytes = Math.max(1, Math.floor(blob.size * KILL_AT))
    const prefix = await probeFile(blob.slice(0, atBytes))
    channels.push({
      kind: ch.kind,
      mimeType: ch.mimeType,
      blobKey: ch.blobKey,
      bytes: blob.size,
      declaredDurationMs: Math.round(ch.durationMs),
      fileDurationMs: whole.durationMs,
      codec: whole.codec,
      frames: whole.frames,
      tailGapMs:
        whole.lastFrameMs !== null ? Math.round(ch.durationMs - whole.lastFrameMs) : null,
      kill: {
        atBytes,
        prefixDurationMs: prefix.durationMs,
        prefixFrames: prefix.frames,
        keptFraction:
          prefix.durationMs !== null && whole.durationMs
            ? Math.round((prefix.durationMs / whole.durationMs) * 100) / 100
            : prefix.durationMs === null
              ? 0
              : null,
      },
    })
  }
  // The VIDEO channels are kept until the quality comparison has run; the
  // caller sweeps them. Everything else goes now.
  const keptKeys: Record<string, string> = {}
  for (const c of channels) keptKeys[c.kind] = c.blobKey
  for (const ch of recording.channels) {
    if (ch.media === 'video') continue
    await blobStore.remove(ch.blobKey).catch(() => undefined)
  }
  if (recording.composite) {
    await blobStore.remove(recording.composite.blobKey).catch(() => undefined)
  }

  return {
    codec,
    effective: channels.map((c) => `${c.kind}:${c.mimeType}/${c.codec ?? '?'}`).join(' '),
    takeMs,
    recordingDurationMs: Math.round(recording.durationMs),
    channels,
    captureLog: captureLog.slice(0, 40),
    keptKeys,
  }
}

export async function runRawCodecTake(
  opts: { takeSec?: number; codecs?: RawVideoCodec[] } = {},
): Promise<X6Report> {
  const takeMs = (opts.takeSec ?? 10) * 1000
  const wanted = opts.codecs ?? (['mediarecorder', 'webcodecs'] as RawVideoCodec[])
  const previous = rawVideoCodec()
  const lanes: CodecLane[] = []
  const notes: string[] = []
  // NOTE 6, FOR THE THIRD TIME IN THIS PROJECT. A fresh Chrome process's FIRST
  // VideoEncoder pays a multi-second init — per launch — and every rig take
  // fits inside it. Production pays it at mount (prearm.ts → encoderWarm.ts);
  // a rig that calls createCaptureSession directly does not, and measured cold
  // these raw channels dropped 45-65 % of their frames and looked like a
  // throughput wall. Warm first, then measure.
  await warmVideoEncoder()
  notes.push(
    'the VideoEncoder is WARMED before any lane runs (note 6): cold, the raw WebCodecs channels dropped 45-65 % of frames and read as a throughput ceiling that is not there',
  )
  try {
    for (const codec of wanted) lanes.push(await runLane(codec, takeMs))
  } finally {
    setRawVideoCodec(previous)
  }

  const laneOf = (c: RawVideoCodec): CodecLane | undefined => lanes.find((l) => l.codec === c)
  const wc = laneOf('webcodecs')
  const mr = laneOf('mediarecorder')

  // --- IS THE SMALLER FILE A WORSE PICTURE? -------------------------------
  // X6's written gates do not ask this, and they should: the first run came
  // back with the WebCodecs channels at ~28 % of the MediaRecorder bytes at the
  // SAME requested ceiling, which is either a large free saving or a quality
  // regression wearing one. Both lanes recorded the same deterministic
  // synthetic source, so their frames at matching instants are comparable.
  const quality: QualityRow[] = []
  if (wc && mr) {
    const at = [2, 4, 6]
    /** ± this much, stepped by a frame, is searched for the matching picture. */
    const SEARCH_S = 0.6
    const STEP_S = 1 / 30
    for (const c of wc.channels) {
      const m = mr.channels.find((x) => x.kind === c.kind)
      if (!m) continue
      let psnrDb: number | null = null
      let alignMs: number[] = []
      try {
        const wcBlob = await blobStore.read(c.blobKey)
        const mrBlob = await blobStore.read(m.blobKey)
        const w = 640
        const h = 360
        const A = await framesOf(wcBlob, at, w, h)
        const window: number[] = []
        for (const t of at) {
          for (let d = -SEARCH_S; d <= SEARCH_S + 1e-9; d += STEP_S) {
            window.push(Math.max(0, Math.round((t + d) * 1000) / 1000))
          }
        }
        const B = await framesOf(mrBlob, window, w, h)
        const per = window.length / at.length
        const vals: number[] = []
        for (let i = 0; i < at.length; i++) {
          const a = A[i]
          if (!a) continue
          let best = -Infinity
          let bestAt = 0
          for (let j = 0; j < per; j++) {
            const b = B[i * per + j]
            if (!b) continue
            const v = psnrOf(a, b)
            if (v > best) {
              best = v
              bestAt = window[i * per + j]!
            }
          }
          if (best > -Infinity) {
            vals.push(best)
            alignMs.push(Math.round((bestAt - at[i]!) * 1000))
          }
        }
        if (vals.length) psnrDb = Math.round(Math.min(...vals) * 10) / 10
      } catch {
        psnrDb = null
      }
      if (alignMs.length) {
        notes.push(
          `quality alignment for ${c.kind}: best match found at ${alignMs.join('/')} ms from the nominal instant — the phase this search exists to remove`,
        )
      }
      quality.push({
        kind: c.kind,
        psnrDb,
        webcodecsBytes: c.bytes,
        mediarecorderBytes: m.bytes,
        bytesRatio: m.bytes > 0 ? Math.round((c.bytes / m.bytes) * 100) / 100 : 0,
      })
    }
  }
  // Now the files can go.
  for (const lane of lanes) {
    for (const key of Object.values(lane.keptKeys ?? {})) {
      await blobStore.remove(key).catch(() => undefined)
    }
    delete lane.keptKeys
  }

  const gates: X6Report['gates'] = {}

  if (wc) {
    const tookIt = wc.channels.every((c) => c.mimeType === 'video/mp4')
    gates['the WebCodecs path actually ran (mp4 on every raw video channel)'] = {
      pass: tookIt && wc.channels.length > 0,
      detail: wc.channels.length
        ? wc.channels.map((c) => `${c.kind} ${c.mimeType} ${c.codec ?? '?'} ${c.bytes} B`).join(' · ')
        : 'no video channels recorded',
    }
    gates['every raw channel DECODES, with the frames the take should have'] = {
      pass: wc.channels.every((c) => (c.frames ?? 0) > 0 && (c.fileDurationMs ?? 0) > 0),
      detail: wc.channels
        .map((c) => `${c.kind} ${c.frames ?? 0} frames / ${c.fileDurationMs ?? 0} ms`)
        .join(' · '),
    }
    gates[`the tail survives (declared − last frame ≤ ${TAIL_BAND_MS} ms)`] = {
      pass: wc.channels.every((c) => c.tailGapMs !== null && Math.abs(c.tailGapMs) <= TAIL_BAND_MS),
      detail: wc.channels.map((c) => `${c.kind} ${c.tailGapMs ?? 'n/a'} ms`).join(' · '),
    }
    // THE O3a GATE. A prefix that decodes to nothing is what O3a refused MP4
    // capture for; a prefix that decodes to about half the take is the claim.
    gates['O3a: a kill at 50 % of the bytes leaves a DECODABLE prefix'] = {
      pass: wc.channels.every((c) => (c.kill.keptFraction ?? 0) >= 0.3),
      detail: wc.channels
        .map(
          (c) =>
            `${c.kind}: prefix of ${c.kill.atBytes} B decodes to ${c.kill.prefixDurationMs ?? 'NOTHING'} ms ` +
            `of ${c.fileDurationMs ?? '?'} (${((c.kill.keptFraction ?? 0) * 100).toFixed(0)} %)`,
        )
        .join(' · '),
    }
  }
  if (wc && mr) {
    gates['the two paths record the same take length'] = {
      pass:
        Math.abs(wc.recordingDurationMs - mr.recordingDurationMs) <= 1000 &&
        wc.recordingDurationMs > 0,
      detail: `webcodecs ${wc.recordingDurationMs} ms vs mediarecorder ${mr.recordingDurationMs} ms`,
    }
    const bytesOf = (l: CodecLane): number => l.channels.reduce((a, c) => a + c.bytes, 0)
    notes.push(
      `raw video bytes on disk: webcodecs ${bytesOf(wc)} B vs mediarecorder ${bytesOf(mr)} B ` +
        `(same requested ceilings — videoBitsFor() is shared by both encoders)`,
    )
    notes.push(
      `MediaRecorder's own 50 % prefix, for the comparison O3a made: ` +
        mr.channels
          .map((c) => `${c.kind} ${c.kill.prefixDurationMs ?? 'NOTHING'} ms of ${c.fileDurationMs ?? '?'}`)
          .join(' · '),
    )
  }

  notes.push(
    'both lanes drive the real createCaptureSession (synthetic sources), so the engine ladder, the stop path and the manifest are the production ones',
  )
  notes.push(
    'the kill is simulated by truncating a COPY at 50 % of the file bytes — the worker holds an exclusive SyncAccessHandle while recording, exactly as the live composite does, so a real mid-take read is not possible from this thread and a real tab kill drops the lock anyway',
  )
  notes.push(
    'the quality bar is a LOWER BOUND, not the encoder difference: the alignment search steps by one frame (1/30 s), so a best match can still sit up to half a frame off, and on a moving source that costs real dB. Read it as "at least this close"',
  )
  notes.push(
    'CPU is NOT measured here: it is whole-browser and belongs to the process sampler — run this rig twice under `npm run exp -- x6 --cpu --query=rawcodec=…`',
  )

  if (quality.length) {
    gates['the smaller file is not a worse picture (≥35 dB between the lanes)'] = {
      // Two independently encoded takes of the same source can never be
      // identical, so this is a "same picture" bar and not a parity one — the
      // same 35-40 dB region O11 uses for "visually the same".
      pass: quality.every((q) => (q.psnrDb ?? 0) >= 35),
      detail: quality
        .map(
          (q) =>
            `${q.kind}: ${q.psnrDb ?? 'n/a'} dB, ${q.webcodecsBytes} B vs ${q.mediarecorderBytes} B (${q.bytesRatio}×)`,
        )
        .join(' · '),
    }
  }

  return { notes, lanes, quality, gates }
}
