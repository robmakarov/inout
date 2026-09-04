/**
 * EXPERIMENTAL — B1b: WHY IS THE SIZE PROBE'S DELTA 1.9x THE RENDER'S ON STILL
 * TEXT? One cell, and it splits the two answers the handoff left open.
 *
 * The probe encodes 300 frames from ONE 10-second window in the middle of the
 * take; the file has thousands. So either
 *   (a) the WINDOW is not representative — the probe's ten seconds cost more
 *       than the take's average ten seconds, or
 *   (b) the ENCODE differs — the probe charges more for the very same seconds
 *       than the render does.
 * Nothing written so far separates them, because every comparison has been the
 * probe's window against the WHOLE file's mean. This measures the file's own
 * mean delta INSIDE the probe's window, from the file's packets, and the two
 * ratios then say which it is:
 *   deltaVsWholeFile ~= deltaVsWindow   → (a) is empty, the encode differs
 *   deltaVsWindow ~= 1                  → the encode is right and the window is
 *                                         atypical, i.e. a sampling question
 * A per-10 s profile of the file comes with it, so "atypical" is readable
 * rather than inferred, and the keyframe count is checked against the cadence,
 * because a render that inserts keyframes of its own moves its OWN delta mean
 * down and would look like a probe error.
 *
 * Everything here is production code doing its production job: `calibrateSteps`
 * is the shipped probe, `exportRecording` is the shipped export, and the file is
 * the witness — every byte counted below is demuxed back out of it.
 */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { newId } from '@core/id'
import { exportRecording } from '@core/compose'
import { KEYFRAME_INTERVAL_SEC } from '@core/compose/codecs'
import { calibrateSteps, estimateFromCalibration } from '@core/compose/sizeProbe'
import {
  copySourceForTier,
  estimateExportBytes,
  QUALITY_TIERS,
  settingsForTier,
  tiersForTake,
  type QualityTier,
} from '@core/compose/quality'
import { drawTextScreen } from '@core/capture/synthetic'
import { defaultEditState } from '@core/timeline'
import type { ChannelRecording, Recording } from '@core/types'
import { cameraSource, motionSource, recordChannels, screenLikeSource, type Source } from './bitsAudit'
import { paintLoop } from '../rigPaint'

/**
 * THE FIXTURE B1b'S GATE NAMES, and it is not `screenLikeSource`: the 159.6 s
 * take was "the code-editor synthetic page", i.e. the page a `?synthetic=1`
 * take carries — `drawTextScreen`, the production function, so the pixels the
 * probe is scored on are the pixels a real synthetic take has.
 */
function textScreenSource(width: number, height: number): Source {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')!
  const loop = paintLoop(() => drawTextScreen(g, width, height), 30)
  return { canvas, stop: loop.stop }
}

/**
 * A TAKE WHOSE MIDDLE IS NOT ITS AVERAGE — the case the probe's single window
 * cannot see, built on purpose.
 *
 * Still text for most of the take, with a band of full-frame motion straddling
 * the exact instant the probe samples. The file is cheap; the probe's ten
 * seconds are expensive; an uncorrected probe therefore prices the whole take
 * at the busy rate, which is the 1.50x shape this task was authored on. Nothing
 * here is a trick: a screen recording that is still while someone reads and
 * busy while they scroll is this, and Robert's own takes are that.
 */
function burstSource(width: number, height: number, takeMs: number): Source {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')!
  const t0 = performance.now()
  const midSec = takeMs / 2000
  const draw = (): void => {
    const t = (performance.now() - t0) / 1000
    drawTextScreen(g, width, height)
    if (Math.abs(t - midSec) > 8) return
    const hue = (t * 90) % 360
    const grad = g.createLinearGradient(0, 0, width, height)
    grad.addColorStop(0, `hsl(${hue}, 60%, 20%)`)
    grad.addColorStop(1, `hsl(${(hue + 120) % 360}, 60%, 40%)`)
    g.globalAlpha = 0.85
    g.fillStyle = grad
    g.fillRect(0, 0, width, height)
    g.globalAlpha = 1
    g.fillStyle = '#ffffff'
    g.fillRect(((t * width) / 2) % (width + 200) - 200, 0, 200, height)
  }
  const loop = paintLoop(draw, 30)
  return { canvas, stop: loop.stop }
}

/** Bytes of one bucket of the file's timeline, so "atypical window" is a number. */
export interface Bucket {
  fromSec: number
  packets: number
  keyframes: number
  meanDeltaBytes: number
}

export type Content = 'text' | 'screen' | 'motion' | 'burst'

export interface ResidualCell {
  content: Content
  camera: boolean
  tierId: string
  takeSec: number
  /** What the export produced, bytes on disk. */
  producedBytes: number
  /** What the panel would have promised from the probe. */
  probeBytes: number | null
  /** probe ÷ produced. 1.00 is the target; the gate is ±20 %. */
  residual: number | null
  /** The model the probe replaced, scored on the same take. */
  modelBytes: number | null
  modelResidual: number | null

  probeWallMs: number
  probeComposeMs: number
  probeEncodeMs: number
  /** The window correction the probe applied, and what it was worth. */
  activity: number
  chosenBy: string
  activityMs: number
  /** The same probe reading ONE GOP instead of two — half the encode. */
  oneGopBytes: number | null
  oneGopResidual: number | null
  oneGopWallMs: number
  oneGopEncodeMs: number
  probeSampledAtSec: number
  probeWindowSec: number
  probeKeyBytes: number
  probeDeltaBytes: number

  /** The file's own packets. */
  fileKeyframes: number
  fileKeyframesExpected: number
  fileMeanKeyBytes: number
  fileMeanDeltaBytes: number
  /** The file's packets INSIDE the probe's window — the discriminator. */
  windowPackets: number
  windowKeyframes: number
  windowMeanDeltaBytes: number

  /** probe delta ÷ the file's, whole file and in the probe's own seconds. */
  deltaVsWholeFile: number | null
  deltaVsWindow: number | null
  /** Every step the panel would show, priced by this one probe run. */
  ladder: LadderRung[]
  /** B1's gate: does the ladder rise with pixel count on its own? */
  ladderMonotonic: boolean
  buckets: Bucket[]
}

/** One rung of the ladder the panel would show, from the SAME probe run. */
export interface LadderRung {
  tierId: string
  pixels: number
  /** null where the step packet-copies: its size is the file, not a guess. */
  estimateBytes: number | null
  exact: boolean
}

export interface SizeResidualReport {
  takeMs: number
  cells: ResidualCell[]
  notes: string[]
}

/** Every byte from the file, bucketed on the timeline and windowed. */
async function readPackets(
  blob: Blob,
  window: { fromSec: number; toSec: number },
  bucketSec: number,
): Promise<{
  keyframes: number
  keyframeBytes: number
  deltas: number
  deltaBytes: number
  windowPackets: number
  windowKeyframes: number
  windowDeltas: number
  windowDeltaBytes: number
  buckets: Bucket[]
  durationSec: number
}> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    const durationSec = await input.computeDuration()
    const acc = {
      keyframes: 0,
      keyframeBytes: 0,
      deltas: 0,
      deltaBytes: 0,
      windowPackets: 0,
      windowKeyframes: 0,
      windowDeltas: 0,
      windowDeltaBytes: 0,
      buckets: [] as Bucket[],
      durationSec,
    }
    if (!track) return acc
    const raw = new Map<number, { packets: number; keyframes: number; deltas: number; deltaBytes: number }>()
    const sink = new EncodedPacketSink(track)
    for await (const p of sink.packets()) {
      const isKey = p.type === 'key'
      if (isKey) {
        acc.keyframes++
        acc.keyframeBytes += p.byteLength
      } else {
        acc.deltas++
        acc.deltaBytes += p.byteLength
      }
      if (p.timestamp >= window.fromSec && p.timestamp < window.toSec) {
        acc.windowPackets++
        if (isKey) acc.windowKeyframes++
        else {
          acc.windowDeltas++
          acc.windowDeltaBytes += p.byteLength
        }
      }
      const b = Math.floor(p.timestamp / bucketSec)
      const row = raw.get(b) ?? { packets: 0, keyframes: 0, deltas: 0, deltaBytes: 0 }
      row.packets++
      if (isKey) row.keyframes++
      else {
        row.deltas++
        row.deltaBytes += p.byteLength
      }
      raw.set(b, row)
    }
    acc.buckets = [...raw.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, r]) => ({
        fromSec: b * bucketSec,
        packets: r.packets,
        keyframes: r.keyframes,
        meanDeltaBytes: r.deltas ? Math.round(r.deltaBytes / r.deltas) : 0,
      }))
    return acc
  } finally {
    input.dispose()
  }
}

async function cellFor(
  content: Content,
  tier: QualityTier,
  takeMs: number,
  withCamera: boolean,
  withRender: boolean,
): Promise<ResidualCell | null> {
  const source =
    content === 'text'
      ? textScreenSource(1920, 1080)
      : content === 'burst'
        ? burstSource(1920, 1080, takeMs)
        : content === 'screen'
          ? screenLikeSource(1920, 1080)
          : motionSource(1920, 1080)
  const cam = withCamera ? cameraSource() : null
  try {
    // The gate's fixture carries a camera, and a camera inset is where a still
    // page's deltas actually come from — pricing one without it is a different
    // question wearing the same name. Recorded TOGETHER, both because a take
    // records them together and because recording them in turn would cost the
    // cell twice its wall.
    const [screenLane, camLane] = await Promise.all([
      recordChannels(source, 'screen', takeMs, [8_000_000]),
      cam ? recordChannels(cam, 'camera', takeMs, [4_000_000]) : Promise.resolve([]),
    ])
    const channels: ChannelRecording[] = [screenLane[0]!, ...camLane]
    const recording: Recording = {
      id: newId('rec'),
      createdAt: Date.now(),
      durationMs: takeMs,
      channels,
    }
    const edit = defaultEditState(recording)

    // The shipped probe, exactly as the quality panel runs it — EVERY step it
    // would show, because the ladder's monotonicity and the probe's wall are
    // both properties of the whole run, not of one tier.
    const tiers = tiersForTake(recording)
    const calibration = await calibrateSteps(recording, edit, tiers)
    // HALF THE FRAMES, SCORED ON THE SAME TAKE. The wall is the encoder and the
    // encoder is hardware-bound, so the only way under the budget is to encode
    // less — and one GOP is half of two. Whether that costs accuracy is a
    // measurement, not an opinion, and it has to be made on the SAME recording
    // or a few points of run-to-run spread read as a difference between models.
    const oneGop = await calibrateSteps(recording, edit, tiers, { warmPass: false })
    const probe = calibration ? estimateFromCalibration(recording, tier, takeMs, calibration) : null
    const step = calibration?.steps[tier.id] ?? null

    // The shipped export, exactly as the export button runs it. `render:false`
    // skips it: the WALL question needs no file, and a render is most of a
    // cell's minutes.
    const produced = withRender
      ? await exportRecording({ recording, edit, settings: settingsForTier(tier, recording) })
      : { blob: new Blob([]) }

    // The window the probe actually encoded: two GOPs from `sampledAtSec`.
    const fromSec = calibration?.sampledAtSec[0] ?? 0
    const windowSec = 2 * KEYFRAME_INTERVAL_SEC
    const bits = produced.blob.size
      ? await readPackets(produced.blob, { fromSec, toSec: fromSec + windowSec }, 10)
      : {
          keyframes: 0, keyframeBytes: 0, deltas: 0, deltaBytes: 0,
          windowPackets: 0, windowKeyframes: 0, windowDeltas: 0, windowDeltaBytes: 0,
          buckets: [] as Bucket[], durationSec: takeMs / 1000,
        }

    const ladder: LadderRung[] = tiers
      .map((t) => {
        const exact = !!copySourceForTier(recording, t)
        const est = exact ? null : estimateFromCalibration(recording, t, takeMs, calibration)
        return { tierId: t.id, pixels: t.width * t.height, estimateBytes: est?.bytes ?? null, exact }
      })
      .sort((a, b) => a.pixels - b.pixels)
    let ladderMonotonic = true
    let prev = 0
    for (const rung of ladder) {
      if (rung.estimateBytes === null) continue
      if (rung.estimateBytes < prev) ladderMonotonic = false
      prev = Math.max(prev, rung.estimateBytes)
    }

    const oneGopProbe = oneGop ? estimateFromCalibration(recording, tier, takeMs, oneGop) : null
    const model = estimateExportBytes(recording, tier, takeMs)
    const fileMeanDeltaBytes = bits.deltas ? Math.round(bits.deltaBytes / bits.deltas) : 0
    const windowMeanDeltaBytes = bits.windowDeltas
      ? Math.round(bits.windowDeltaBytes / bits.windowDeltas)
      : 0
    const r2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100)
    return {
      content,
      camera: withCamera,
      tierId: tier.id,
      takeSec: Math.round((takeMs / 1000) * 10) / 10,
      producedBytes: produced.blob.size,
      probeBytes: probe?.bytes ?? null,
      residual: probe && produced.blob.size ? r2(probe.bytes / produced.blob.size) : null,
      modelBytes: model?.bytes ?? null,
      modelResidual: model && produced.blob.size ? r2(model.bytes / produced.blob.size) : null,
      probeWallMs: calibration?.wallMs ?? 0,
      probeComposeMs: calibration?.composeMs ?? 0,
      probeEncodeMs: calibration?.encodeMs ?? 0,
      activity: calibration?.activity ?? 1,
      chosenBy: calibration?.chosenBy ?? 'middle',
      activityMs: calibration?.activityMs ?? 0,
      oneGopBytes: oneGopProbe?.bytes ?? null,
      oneGopResidual:
        oneGopProbe && produced.blob.size ? r2(oneGopProbe.bytes / produced.blob.size) : null,
      oneGopWallMs: oneGop?.wallMs ?? 0,
      oneGopEncodeMs: oneGop?.encodeMs ?? 0,
      probeSampledAtSec: fromSec,
      probeWindowSec: windowSec,
      probeKeyBytes: step?.meanKeyframeBytes ?? 0,
      probeDeltaBytes: step?.meanDeltaBytes ?? 0,
      fileKeyframes: bits.keyframes,
      fileKeyframesExpected: Math.max(1, Math.ceil(bits.durationSec / KEYFRAME_INTERVAL_SEC)),
      fileMeanKeyBytes: bits.keyframes ? Math.round(bits.keyframeBytes / bits.keyframes) : 0,
      fileMeanDeltaBytes,
      windowPackets: bits.windowPackets,
      windowKeyframes: bits.windowKeyframes,
      windowMeanDeltaBytes,
      deltaVsWholeFile: fileMeanDeltaBytes ? r2((step?.meanDeltaBytes ?? 0) / fileMeanDeltaBytes) : null,
      deltaVsWindow: windowMeanDeltaBytes ? r2((step?.meanDeltaBytes ?? 0) / windowMeanDeltaBytes) : null,
      ladder,
      ladderMonotonic,
      buckets: bits.buckets,
    }
  } finally {
    source.stop()
    cam?.stop()
  }
}

export async function runSizeResidual(
  opts: { takeMs?: number; tier?: string; contents?: Content[]; camera?: boolean; render?: boolean } = {},
): Promise<SizeResidualReport> {
  const takeMs = opts.takeMs ?? 60_000
  const tier = QUALITY_TIERS.find((t) => t.id === (opts.tier ?? '1440p')) ?? QUALITY_TIERS[0]!
  const contents = opts.contents ?? ['text', 'motion']
  const withCamera = opts.camera !== false
  const withRender = opts.render !== false
  const cells: ResidualCell[] = []
  for (const content of contents) {
    const cell = await cellFor(content, tier, takeMs, withCamera, withRender)
    if (cell) cells.push(cell)
  }
  const notes: string[] = []
  for (const c of cells) {
    notes.push(
      `${c.content}${c.camera ? '+camera' : ''} ${c.tierId}: probe ${c.residual}x of the file (window at ${c.probeSampledAtSec}s by ${c.chosenBy}, take ${c.activity.toFixed(2)}x as busy, ${c.activityMs} ms) · delta ${c.probeDeltaBytes} B vs file ${c.fileMeanDeltaBytes} B ` +
        `(${c.deltaVsWholeFile}x) and vs its own window ${c.windowMeanDeltaBytes} B (${c.deltaVsWindow}x) · ` +
        `keyframes ${c.fileKeyframes} of ${c.fileKeyframesExpected} expected · ladder ${c.ladderMonotonic ? 'monotonic' : 'INVERTED'} ` +
        `(${c.ladder.map((r) => `${r.tierId} ${r.estimateBytes === null ? 'exact' : Math.round(r.estimateBytes / 1e5) / 10 + 'MB'}`).join(' < ')}) · ` +
        `probe wall ${c.probeWallMs} ms (compose ${c.probeComposeMs} + encode ${c.probeEncodeMs}) · ` +
        `ONE GOP: ${c.oneGopResidual}x in ${c.oneGopWallMs} ms (encode ${c.oneGopEncodeMs})`,
    )
  }
  return { takeMs, cells, notes }
}
