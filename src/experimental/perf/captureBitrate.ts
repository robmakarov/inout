/**
 * EXPERIMENTAL — X12 evidence: what CAPTURE writes, and what each part of it
 * buys. Measurement only; this rig changes no product behaviour and no bitrate.
 *
 * THE CLAIM UNDER TEST, from the task: capture writes ~18.5 Mbps across three
 * artifacts (raw screen 8 + raw camera 2.5 + composite 8), ~2.3 GB/hour, to
 * ship an 8 Mbps file. Both artifacts are needed GIVEN THE FEATURES — the raw
 * channels are what every EDITED export renders from, the composite is what the
 * instant path copies and what smart cut copies most of — but the SPLIT has
 * never been priced, so nobody knows what a cheaper rung would actually cost.
 *
 * TWO LANES, and the second is the one that turns a number into a decision:
 *
 *   (a) THE BILL. A production-shaped take (screen 1080p + camera 720p + a mic
 *       channel + the live composite) recorded through the SAME engines
 *       production uses, then every artifact weighed ON DISK and divided by the
 *       take's own length. The reported figure is bytes that were written, not
 *       the ceilings that were requested — O11a's whole lesson is that a
 *       requested bitrate and an achieved one are different numbers, and on
 *       still screen content they differ by a lot.
 *
 *   (b) WHAT A CHEAPER RAW SCREEN COSTS THE FILE. O11c already ran this play
 *       once on the camera channel (4 → 2.5 Mbps: −29.3 % on disk, +0.2 % on
 *       the exported file, PiP PSNR 52.1 dB) and it is the only honest way to
 *       price a capture rung: record the SAME stream into several files at
 *       once, render each through the production exporter, and compare the
 *       renders. One stream, so an A/B of the encoder setting is not also an
 *       A/B of what was on screen.
 *
 * The raw SCREEN channel is the expensive one and the one nobody has priced:
 * it is 8 Mbps of the ~18.5, it is never packet-copied (only the composite is),
 * and every pixel it holds is re-encoded by the render at the export's own
 * ceiling. So the question the rig asks is exactly: how far can that rung come
 * down before the RENDERED file gets worse?
 */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny'
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { exportRecording } from '@core/compose'
import { canLiveCompositeV2, startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import { canLiveComposite, startLiveComposite } from '@core/capture/liveComposite'
import { preferredCompositeEngine } from '@core/capture/engine'
import { defaultEditState } from '@core/timeline'
import type { ChannelRecording, Recording } from '@core/types'
import { motionSource, screenLikeSource, recordChannels, type Source } from './bitsAudit'
import { proposeScreenRung } from './screenRung'

/** The shipped raw-screen ceiling, and the rungs below it this rig prices. */
const SCREEN_BITRATES = [8_000_000, 6_000_000, 4_000_000, 2_500_000]
/** The shipped raw-camera ceiling (O11c). Weighed, not swept — O11c swept it. */
const CAMERA_BITRATE = 2_500_000
const AUDIO_BITRATE = 128_000

const PSNR_W = 960
const PSNR_H = 540

export interface Artifact {
  name: string
  /** What this file is FOR — which export path reads it. */
  buys: string
  bytes: number
  mbps: number
  gbPerHour: number
  /** The ceiling capture asked for, where there is one. */
  requestedMbps: number | null
  /** achieved / requested — how much of the ceiling this content actually used. */
  ceilingUsedPct: number | null
}

export interface ScreenRung {
  requestedMbps: number
  /** What the RAW channel cost on disk — the only thing this lever saves. */
  channelBytes: number
  channelMbps: number
  channelSavingPct: number | null
  /** The RENDER of that channel: what the user's file becomes. */
  exportBytes: number
  exportDeltaPct: number | null
  /** PSNR of the rendered frames against the 8 Mbps channel's render. */
  renderPsnrDb: number | null
}

export interface ContentBill {
  content: 'screen' | 'motion'
  takeSec: number
  artifacts: Artifact[]
  totalMbps: number
  totalGbPerHour: number
  /** What the take's own default export weighs, for the ratio the task states. */
  deliveredExportBytes: number
  deliveredMbps: number
  writeAmplification: number
  screenRungs: ScreenRung[]
}

export interface X12Report {
  notes: string[]
  contents: ContentBill[]
  proposal: string[]
}

async function weigh(blobKey: string): Promise<number> {
  try {
    return (await blobStore.read(blobKey)).size
  } catch {
    return 0
  }
}

async function framesAt(blob: Blob, times: number[]): Promise<(ImageData | null)[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const canvas = new OffscreenCanvas(PSNR_W, PSNR_H)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return times.map(() => null)
    const sink = new VideoSampleSink(track)
    const out: (ImageData | null)[] = []
    for (const t of times) {
      const s = await sink.getSample(t)
      if (!s) {
        out.push(null)
        continue
      }
      ctx.clearRect(0, 0, PSNR_W, PSNR_H)
      s.draw(ctx, 0, 0, PSNR_W, PSNR_H)
      s.close()
      out.push(ctx.getImageData(0, 0, PSNR_W, PSNR_H))
    }
    return out
  } finally {
    input.dispose()
  }
}

function psnr(a: ImageData, b: ImageData): number {
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
  if (mse === 0) return Infinity
  return Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10
}

/** A mic channel recorded off an oscillator — capture writes one per take. */
async function recordAudioChannel(takeMs: number): Promise<ChannelRecording | null> {
  const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m),
  )
  if (!mime) return null
  const ctx = new AudioContext({ sampleRate: 48_000 })
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const dest = ctx.createMediaStreamDestination()
  osc.frequency.value = 220
  gain.gain.value = 0.12
  osc.connect(gain).connect(dest)
  osc.start()
  const blobKey = `exp-x12-${newId('aud')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  let chain = Promise.resolve()
  const recorder = new MediaRecorder(dest.stream, {
    mimeType: mime,
    audioBitsPerSecond: AUDIO_BITRATE,
  })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  recorder.start(1000)
  await new Promise((r) => setTimeout(r, takeMs))
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.requestData()
    recorder.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  osc.stop()
  await ctx.close()
  return {
    id: newId('ch'),
    kind: 'mic',
    media: 'audio',
    mimeType: mime,
    blobKey,
    startOffsetMs: 0,
    durationMs: takeMs,
  }
}

/**
 * The live composite over the same sources, through the SHIPPED engine ladder
 * (v2 by default). This is the third artifact a take writes and the one the
 * instant path copies, so it has to be the real one and not a stand-in.
 */
async function recordComposite(
  screen: Source,
  camera: Source | null,
  takeMs: number,
): Promise<{ bytes: number; durationSec: number; keyframeSharePct: number } | null> {
  const screenStream = screen.canvas.captureStream(30)
  const cameraStream = camera ? camera.canvas.captureStream(30) : undefined
  const key = `exp-x12-comp-${newId('c')}.mp4`
  try {
    const inputs = { screen: screenStream, camera: cameraStream, audio: [] }
    const wantV2 = preferredCompositeEngine() === 'v2' && canLiveCompositeV2(inputs)
    const handle = wantV2
      ? await startLiveCompositeV2(inputs, key)
      : canLiveComposite(inputs)
        ? await startLiveComposite(inputs, key)
        : null
    if (!handle) return null
    await new Promise((r) => setTimeout(r, takeMs))
    const composite = await handle.stop()
    if (!composite) return null
    const blob = await blobStore.read(key)
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    try {
      const track = await input.getPrimaryVideoTrack()
      const durationSec = await input.computeDuration()
      let keyframeBytes = 0
      let total = 0
      if (track) {
        const sink = new EncodedPacketSink(track)
        for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
          total += p.byteLength
          if (p.type === 'key') keyframeBytes += p.byteLength
        }
      }
      return {
        bytes: blob.size,
        durationSec: Math.round(durationSec * 1000) / 1000,
        keyframeSharePct: total > 0 ? Math.round((keyframeBytes / total) * 1000) / 10 : 0,
      }
    } finally {
      input.dispose()
    }
  } catch {
    return null
  } finally {
    for (const t of screenStream.getTracks()) t.stop()
    if (cameraStream) for (const t of cameraStream.getTracks()) t.stop()
    await blobStore.remove(key).catch(() => undefined)
  }
}

function rate(bytes: number, sec: number): { mbps: number; gbPerHour: number } {
  const mbps = sec > 0 ? Math.round(((bytes * 8) / sec / 1e6) * 1000) / 1000 : 0
  return { mbps, gbPerHour: Math.round(((bytes / sec) * 3600) / 1e9 * 1000) / 1000 }
}

async function billFor(content: 'screen' | 'motion', takeMs: number): Promise<ContentBill> {
  const takeSec = takeMs / 1000
  const screenSource = content === 'motion' ? motionSource(1920, 1080) : screenLikeSource(1920, 1080)
  const cameraSource = motionSource(1280, 720)
  const cleanup: string[] = []
  try {
    // (b) The raw SCREEN rungs — one stream into four files at once, so the
    // comparison is of encoder settings and not of content.
    const screenChannels = await recordChannels(screenSource, 'screen', takeMs, SCREEN_BITRATES)
    for (const c of screenChannels) cleanup.push(c.blobKey)
    const cameraChannel = (await recordChannels(cameraSource, 'camera', takeMs, [CAMERA_BITRATE]))[0]!
    cleanup.push(cameraChannel.blobKey)
    const audioChannel = await recordAudioChannel(takeMs)
    if (audioChannel) cleanup.push(audioChannel.blobKey)

    const sampleTimes = [0.5, takeSec / 2, Math.max(0.5, takeSec - 0.5)]
    const screenRungs: ScreenRung[] = []
    let baseFrames: (ImageData | null)[] = []
    let baseChannelBytes = 0
    let baseExportBytes = 0
    let deliveredExportBytes = 0
    for (let i = 0; i < screenChannels.length; i++) {
      const channel = screenChannels[i]!
      const recording: Recording = {
        id: newId('rec'),
        createdAt: Date.now(),
        durationMs: takeMs,
        channels: [channel, cameraChannel, ...(audioChannel ? [audioChannel] : [])],
      }
      const result = await exportRecording({
        recording,
        edit: defaultEditState(recording),
        settings: { width: 1920, height: 1080, fps: 30, videoBitrate: 8_000_000 },
      })
      const channelBytes = await weigh(channel.blobKey)
      const frames = await framesAt(result.blob, sampleTimes)
      const isBase = i === 0
      if (isBase) {
        baseFrames = frames
        baseChannelBytes = channelBytes
        baseExportBytes = result.blob.size
        deliveredExportBytes = result.blob.size
      }
      const vals: number[] = []
      if (!isBase) {
        for (let k = 0; k < frames.length; k++) {
          const a = frames[k]
          const b = baseFrames[k]
          if (a && b) vals.push(Math.min(99, psnr(a, b)))
        }
      }
      screenRungs.push({
        requestedMbps: SCREEN_BITRATES[i]! / 1e6,
        channelBytes,
        channelMbps: rate(channelBytes, takeSec).mbps,
        channelSavingPct: isBase
          ? null
          : Math.round(((channelBytes - baseChannelBytes) / baseChannelBytes) * 1000) / 10,
        exportBytes: result.blob.size,
        exportDeltaPct: isBase
          ? null
          : Math.round(((result.blob.size - baseExportBytes) / baseExportBytes) * 1000) / 10,
        renderPsnrDb: vals.length
          ? Math.round((vals.reduce((x, v) => x + v, 0) / vals.length) * 10) / 10
          : null,
      })
    }

    // (a) The bill. The composite is recorded LAST so the four raw recorders
    // are not competing with it for the encoder while it measures its own rate.
    const composite = await recordComposite(screenSource, cameraSource, takeMs)

    const shippedScreenBytes = screenRungs[0]!.channelBytes
    const cameraBytes = await weigh(cameraChannel.blobKey)
    const audioBytes = audioChannel ? await weigh(audioChannel.blobKey) : 0
    const artifacts: Artifact[] = [
      {
        name: 'raw screen 1080p',
        buys: 'every EDITED export renders from it; smart cut does not read it; the instant path never does',
        bytes: shippedScreenBytes,
        ...rate(shippedScreenBytes, takeSec),
        requestedMbps: SCREEN_BITRATES[0]! / 1e6,
        ceilingUsedPct: Math.round(
          (rate(shippedScreenBytes, takeSec).mbps / (SCREEN_BITRATES[0]! / 1e6)) * 1000,
        ) / 10,
      },
      {
        name: 'raw camera 720p',
        buys: 'the PiP in an edited export, and the F4 camera track; priced once already (O11c)',
        bytes: cameraBytes,
        ...rate(cameraBytes, takeSec),
        requestedMbps: CAMERA_BITRATE / 1e6,
        ceilingUsedPct:
          Math.round((rate(cameraBytes, takeSec).mbps / (CAMERA_BITRATE / 1e6)) * 1000) / 10,
      },
      {
        name: 'raw audio (mic)',
        buys: 'EVERY export path mixes audio from the raw channels — including the instant copy (note 14)',
        bytes: audioBytes,
        ...rate(audioBytes, takeSec),
        requestedMbps: AUDIO_BITRATE / 1e6,
        ceilingUsedPct:
          audioBytes > 0
            ? Math.round((rate(audioBytes, takeSec).mbps / (AUDIO_BITRATE / 1e6)) * 1000) / 10
            : null,
      },
      ...(composite
        ? [
            {
              name: 'live composite 1080p',
              buys: 'the INSTANT export copies its video packets; smart cut copies most of them. Nothing else reads it',
              bytes: composite.bytes,
              ...rate(composite.bytes, composite.durationSec || takeSec),
              requestedMbps: 8,
              ceilingUsedPct:
                Math.round(
                  (rate(composite.bytes, composite.durationSec || takeSec).mbps / 8) * 1000,
                ) / 10,
            },
          ]
        : []),
    ]
    const totalBytes = artifacts.reduce((a, x) => a + x.bytes, 0)
    const total = rate(totalBytes, takeSec)
    return {
      content,
      takeSec,
      artifacts,
      totalMbps: total.mbps,
      totalGbPerHour: total.gbPerHour,
      deliveredExportBytes,
      deliveredMbps: rate(deliveredExportBytes, takeSec).mbps,
      writeAmplification:
        deliveredExportBytes > 0
          ? Math.round((totalBytes / deliveredExportBytes) * 100) / 100
          : 0,
      screenRungs,
    }
  } finally {
    screenSource.stop()
    cameraSource.stop()
    for (const key of cleanup) await blobStore.remove(key).catch(() => undefined)
  }
}

export async function runCaptureBitrate(
  opts: { takeSec?: number; contents?: ('screen' | 'motion')[] } = {},
): Promise<X12Report> {
  const takeMs = (opts.takeSec ?? 12) * 1000
  const contents = opts.contents ?? (['screen', 'motion'] as const).slice()
  const bills: ContentBill[] = []
  for (const content of contents) bills.push(await billFor(content, takeMs))

  const screenBill = bills.find((b) => b.content === 'screen')
  const motionBill = bills.find((b) => b.content === 'motion')
  const proposal: string[] = []
  for (const bill of bills) {
    // THE RULE IS A TESTED PURE FUNCTION (screenRung.ts), not a line of
    // arithmetic here, because its first version recommended a rung that made
    // the delivered file 31.5 % BIGGER — see that file's header.
    const p = proposeScreenRung(bill.screenRungs)
    proposal.push(
      `${bill.content}: capture writes ${bill.totalMbps} Mbps (${bill.totalGbPerHour} GB/hour) to ship ` +
        `${bill.deliveredMbps} Mbps — ${bill.writeAmplification}× write amplification. Raw-screen rung: ${p.reason}`,
    )
  }
  if (screenBill && motionBill) {
    proposal.push(
      'CONTENT DECIDES THIS LEVER, as it decided the GOP one (O11b): the two bills above are the ' +
        'bounds a real take sits between, and a UI take sits much closer to the screen row. A single ' +
        'fixed rung would be tuned for whichever content the tuner had in mind.',
    )
  }
  proposal.push(
    'NOT PROPOSED HERE, and deliberately: the COMPOSITE rung. It is the file the instant path copies ' +
      'verbatim, so its bitrate IS the delivered quality of an unedited take — lowering it is not a ' +
      'capture saving, it is an export quality change, and belongs to F7 and to Robert.',
  )
  proposal.push(
    'ANY ACTUAL CHANGE IS ITS OWN Robert-GATED TASK (X12 is measurement only). What this run licenses is a ' +
      'proposal with numbers under it, not a flip.',
  )

  return {
    notes: [
      'every byte is weighed ON DISK after the take, not derived from the requested ceiling',
      'the four raw screen rungs are recorded from ONE canvas stream simultaneously, so the comparison is of encoder settings and not of content',
      'each rung is RENDERED through the production exporter at the shipped 1080p/8 Mbps settings, and the PSNR is between those renders — which is the file a user gets, not the intermediate',
      'the composite is recorded through the shipped engine ladder (v2 where available) and weighed the same way',
      'screen content = a still editor page that scrolls one line every 2.5 s; motion content = a full-frame gradient that changes everywhere every frame. A real take sits between them and much closer to the first',
    ],
    contents: bills,
    proposal,
  }
}
