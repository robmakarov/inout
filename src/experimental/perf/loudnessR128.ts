/**
 * EXPERIMENTAL — O10(a) evidence: what do INOUT's exports actually read in
 * LUFS, and what would R128 targeting change?
 *
 * O10(a) asks for "EBU R128 loudness targeting (−14 LUFS integrated) as an
 * ADDITIVE mode first". Before building a mode, the question worth answering is
 * where the shipped path already lands: the export normalises the 90th
 * percentile of 100 ms window RMS, which is a reasonable speech statistic and
 * is not a loudness standard — no frequency weighting, no gating. If that
 * happens to land near −14 LUFS on ordinary material, the mode is a refinement.
 * If it lands far away, or scatters, the mode is a fix.
 *
 * SO THE RIG MEASURES THE FILE, not the intention: it records takes through the
 * real capture session, exports them through the real exporter, DECODES the
 * result and runs BS.1770 over the decoded PCM. Three shapes, because the
 * shipped statistic's blind spots are shape-dependent:
 *
 *   speech-like    bursts with pauses — where GATING matters
 *   bass-heavy     the frequency weighting's whole point
 *   bright         the high shelf's half of the same point
 *
 * The scatter across those three is the number that decides O10(a): a single
 * offset can be dialled in, but a spread cannot, and only a weighted+gated
 * measure can close a spread.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { exportRecording } from '@core/compose'
import { defaultEditState } from '@core/timeline'
import { AUDIO_SAMPLE_RATE } from '@core/compose/codecs'
import {
  DEFAULT_TARGET_LUFS,
  gainForTargetLufs,
  measureIntegratedLufs,
} from '@core/compose/lufs'
import { setLoudnessMode } from '@core/compose/loudnessMode'
import type { ChannelRecording, Recording } from '@core/types'

type Shape = 'speech' | 'bass' | 'bright'

/**
 * Programme with a known character, recorded through a real MediaRecorder so
 * the codec is in the loop — a loudness number taken on the PCM we synthesised
 * would not be a number about the file a user gets.
 */
function paint(shape: Shape, ctx: AudioContext): { node: AudioNode; stop: () => void } {
  const gain = ctx.createGain()
  gain.gain.value = 0.22
  const oscs: OscillatorNode[] = []
  const freqs = shape === 'bass' ? [70, 110, 165] : shape === 'bright' ? [2400, 3800, 6200] : [180, 420, 900]
  for (const f of freqs) {
    const o = ctx.createOscillator()
    o.frequency.value = f
    o.type = shape === 'speech' ? 'sawtooth' : 'sine'
    o.connect(gain)
    o.start()
    oscs.push(o)
  }
  // Speech-shaped material is bursty, and the pauses are the point: they are
  // what the relative gate exists to discount and what the shipped p90 does not.
  if (shape === 'speech') {
    const t0 = ctx.currentTime
    for (let i = 0; i < 40; i++) {
      const on = t0 + i * 0.75
      gain.gain.setValueAtTime(0.0001, on)
      gain.gain.exponentialRampToValueAtTime(0.22, on + 0.05)
      gain.gain.setValueAtTime(0.22, on + 0.45)
      gain.gain.exponentialRampToValueAtTime(0.0001, on + 0.5)
    }
  }
  return {
    node: gain,
    stop: () => {
      for (const o of oscs) {
        try {
          o.stop()
        } catch {
          /* already stopped */
        }
      }
    },
  }
}

async function recordAudio(shape: Shape, takeMs: number): Promise<ChannelRecording | null> {
  const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) return null
  const ctx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE })
  const dest = ctx.createMediaStreamDestination()
  const src = paint(shape, ctx)
  src.node.connect(dest)
  const blobKey = `exp-o10-${newId('aud')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  let chain = Promise.resolve()
  const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 128_000 })
  rec.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  rec.start(1000)
  await new Promise((r) => setTimeout(r, takeMs))
  await new Promise<void>((resolve) => {
    rec.onstop = () => resolve()
    rec.requestData()
    rec.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  src.stop()
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

/** The exported file's own audio, decoded back to PCM. */
async function decodePcm(blob: Blob): Promise<{ left: Float32Array; right: Float32Array } | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return null
    const sink = new AudioBufferSink(track)
    const chunks: { l: Float32Array; r: Float32Array }[] = []
    let total = 0
    for await (const { buffer } of sink.buffers()) {
      const l = buffer.getChannelData(0)
      const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l
      chunks.push({ l: new Float32Array(l), r: new Float32Array(r) })
      total += l.length
    }
    const left = new Float32Array(total)
    const right = new Float32Array(total)
    let at = 0
    for (const c of chunks) {
      left.set(c.l, at)
      right.set(c.r, at)
      at += c.l.length
    }
    return { left, right }
  } catch {
    return null
  } finally {
    input.dispose()
  }
}

export interface LoudnessRow {
  shape: Shape
  /** The SHIPPED path's file. */
  integratedLufs: number | null
  /** The same take exported with ?loudness=r128 — the additive mode. */
  r128Lufs: number | null
  blocks: number
  aboveAbsoluteGate: number
  aboveRelativeGate: number
  /** What R128 targeting would ask for, in dB. */
  offsetToTargetDb: number | null
  gainToTarget: number
}

export interface O10Report {
  notes: string[]
  targetLufs: number
  rows: LoudnessRow[]
  /** The number that decides the task: how far apart the three shapes land. */
  spreadDb: number | null
  /** The same spread with the additive mode on — does it actually close it? */
  r128SpreadDb: number | null
  verdict: string
}

export async function runLoudnessR128(opts: { takeSec?: number } = {}): Promise<O10Report> {
  const takeMs = (opts.takeSec ?? 20) * 1000
  const shapes: Shape[] = ['speech', 'bass', 'bright']
  const rows: LoudnessRow[] = []
  for (const shape of shapes) {
    const channel = await recordAudio(shape, takeMs)
    if (!channel) continue
    try {
      const recording: Recording = {
        id: newId('rec'),
        createdAt: Date.now(),
        durationMs: takeMs,
        channels: [channel],
      }
      // The REAL exporter, so the shipped makeup gain and limiter are in the
      // loop — this is a measurement of the file a user gets.
      const result = await exportRecording({ recording, edit: defaultEditState(recording) })
      const pcm = await decodePcm(result.blob)
      if (!pcm) continue
      const m = measureIntegratedLufs(pcm.left, pcm.right, AUDIO_SAMPLE_RATE)
      // The SAME take through the R128 mode, so the two are comparable rather
      // than two takes of different material.
      setLoudnessMode('r128')
      let r128Lufs: number | null = null
      try {
        const r128 = await exportRecording({ recording, edit: defaultEditState(recording) })
        const p2 = await decodePcm(r128.blob)
        if (p2) r128Lufs = measureIntegratedLufs(p2.left, p2.right, AUDIO_SAMPLE_RATE).integratedLufs
      } finally {
        setLoudnessMode(null)
      }
      rows.push({
        r128Lufs,
        shape,
        integratedLufs: m.integratedLufs,
        blocks: m.blocks,
        aboveAbsoluteGate: m.aboveAbsoluteGate,
        aboveRelativeGate: m.aboveRelativeGate,
        offsetToTargetDb:
          m.integratedLufs === null
            ? null
            : Math.round((DEFAULT_TARGET_LUFS - m.integratedLufs) * 100) / 100,
        gainToTarget: Math.round(gainForTargetLufs(m.integratedLufs) * 1000) / 1000,
      })
    } finally {
      await blobStore.remove(channel.blobKey).catch(() => undefined)
    }
  }

  const measured = rows.map((r) => r.integratedLufs).filter((v): v is number => v !== null)
  const spreadDb =
    measured.length >= 2 ? Math.round((Math.max(...measured) - Math.min(...measured)) * 100) / 100 : null
  const r128Measured = rows.map((r) => r.r128Lufs).filter((v): v is number => v !== null)
  const r128SpreadDb =
    r128Measured.length >= 2
      ? Math.round((Math.max(...r128Measured) - Math.min(...r128Measured)) * 100) / 100
      : null

  const verdict =
    spreadDb !== null && r128SpreadDb !== null
      ? `shipped p90 scatters ${spreadDb} dB across content; R128 mode scatters ${r128SpreadDb} dB. ` +
        (r128SpreadDb < spreadDb
          ? `The mode closes ${Math.round((spreadDb - r128SpreadDb) * 100) / 100} dB of it.`
          : `THE MODE IS A NO-OP HERE, and the reason is not the statistic — it is the direction. ` +
            `Every shape asks for a gain BELOW 1 (${rows.map((r) => r.gainToTarget).join(', ')}), because these exports are ` +
            `ALREADY LOUDER than the −14 LUFS convention, and the shipped bounding never attenuates ` +
            `(Math.max(1, …) in makeupGainForTargetLufs, inherited from the p90 path). So R128 can only ` +
            `close this spread if it is allowed to turn takes DOWN — which is a change to how every ` +
            `export sounds, and therefore Robert's.`)
      : spreadDb === null
      ? 'not measured'
      : spreadDb > 3
        ? `THE SHIPPED MAKEUP SCATTERS BY ${spreadDb} dB ACROSS CONTENT. A single offset cannot close a spread — only a weighted, gated measure can, which is what O10(a) is for. Exports of the same nominal level land ${spreadDb} dB apart depending only on what is in them.`
        : `The shipped makeup already lands the three shapes within ${spreadDb} dB of each other, so R128 targeting would be a re-centring (offset ${rows.map((r) => r.offsetToTargetDb).join('/')} dB to −14) rather than a fix for scatter.`

  return {
    notes: [
      'every number is measured on the DECODED EXPORT, so the codec, the shipped makeup gain and the limiter are all in the loop',
      'three content shapes on purpose: the shipped statistic is unweighted and ungated, and both blind spots are content-dependent — a single take could not show either',
      'BS.1770 implementation is src/core/compose/lufs.ts, 14 unit tests, calibrated against the standard’s own 1 kHz reference to 0.15 dB and pinned to give the same answer chunked as whole',
      'the r128 column is the SAME take exported again through the additive mode, so shipped-vs-mode is not also a comparison of two recordings',
    ],
    targetLufs: DEFAULT_TARGET_LUFS,
    rows,
    spreadDb,
    r128SpreadDb,
    verdict,
  }
}
