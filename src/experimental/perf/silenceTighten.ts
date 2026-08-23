/**
 * EXPERIMENTAL — F5a evidence: silence tightening.
 *
 * The gate is a KNOWN silence map, so the rig builds the audio itself: speech
 * bursts at exact instants over a constant room tone, with gaps of known
 * length — including one deliberately SHORT gap that must survive, because
 * "cuts everything quiet" is not the feature.
 *
 * Then it runs the production analyser, checks every proposed cut against the
 * map (recall on the long gaps, and zero cuts landing inside speech), applies
 * the proposal through the same F1 machinery the editor would, exports, and
 * measures the joins for clicks the way the F1 harness does.
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { exportRecording } from '@core/compose'
import { analyzeSilence } from '@core/compose/analyzeSilence'
import { SILENCE_DEFAULTS, defaultEditState, keptSegments, segmentJoinsMs } from '@core/timeline'
import type { ChannelRecording, EditState, Recording } from '@core/types'

interface Segment {
  /** Speech from startMs to endMs; everything else is room tone. */
  startMs: number
  endMs: number
}

/** Speech spans of the rig, in ms. The gaps between them are the answer key. */
const SPEECH: Segment[] = [
  { startMs: 0, endMs: 2000 },
  { startMs: 3200, endMs: 5000 },
  // 500 ms gap — deliberately UNDER minSilenceMs, must survive.
  { startMs: 5500, endMs: 7500 },
  { startMs: 9000, endMs: 12_000 },
]

/**
 * The envelope is scheduled AFTER the recorder is already running, by a fixed
 * lead-in — otherwise the answer key and the file disagree about t=0 by however
 * long it took to open a write stream, and the harness reports the detector
 * cutting "speech" that the file never contained. (It did: 760 ms of it.)
 */
const LEAD_IN_MS = 300

/** Speech spans in FILE time. */
function speechInFile(): Segment[] {
  return SPEECH.map((s) => ({ startMs: s.startMs + LEAD_IN_MS, endMs: s.endMs + LEAD_IN_MS }))
}

function knownGaps(takeMs: number): Segment[] {
  const speech = speechInFile()
  const gaps: Segment[] = []
  if (speech[0]!.startMs > 0) gaps.push({ startMs: 0, endMs: speech[0]!.startMs })
  for (let i = 1; i < speech.length; i++) {
    gaps.push({ startMs: speech[i - 1]!.endMs, endMs: speech[i]!.startMs })
  }
  const last = speech[speech.length - 1]!
  if (takeMs > last.endMs + 50) gaps.push({ startMs: last.endMs, endMs: takeMs })
  return gaps
}

const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2']

/**
 * Speech-like bursts over room tone, recorded exactly as a raw audio channel.
 * "Speech-like" only has to mean "loud, and modulated enough that its window
 * RMS never dips into the silence threshold" — the analyser is a level
 * detector, not a voice detector, and pretending otherwise would test nothing.
 */
async function recordKnownAudio(takeMs: number): Promise<ChannelRecording> {
  const ctx = new AudioContext({ sampleRate: 48000 })
  await ctx.resume()
  const dest = ctx.createMediaStreamDestination()

  // Room tone: constant, quiet, and always present — this is what the
  // threshold has to stay above.
  const tone = new OscillatorNode(ctx, { frequency: 2200, type: 'sine' })
  const toneGain = new GainNode(ctx, { gain: 0.0009 })
  tone.connect(toneGain).connect(dest)
  tone.start()

  // Voice: a low carrier with a 6 Hz wobble, gated to the speech spans.
  const voice = new OscillatorNode(ctx, { frequency: 190, type: 'sawtooth' })
  const wobble = new OscillatorNode(ctx, { frequency: 6, type: 'sine' })
  const wobbleDepth = new GainNode(ctx, { gain: 0.06 })
  const voiceGain = new GainNode(ctx, { gain: 0 })
  wobble.connect(wobbleDepth).connect(voiceGain.gain)
  voice.connect(voiceGain).connect(dest)
  const mime = AUDIO_MIMES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('no supported audio recorder mime')
  const blobKey = `exp-f5a-${newId('a')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  let chain = Promise.resolve()
  const recorder = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 128_000 })
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return
    chain = chain.then(() => writer.write(e.data).catch(() => undefined))
  }
  // Recorder first, envelope second: everything above this line costs unknown
  // wall time, and only what follows it is in the file.
  recorder.start(1000)
  const t0 = ctx.currentTime + LEAD_IN_MS / 1000
  for (const s of SPEECH) {
    // Ramps, not steps: a hard gate would click and the click would be signal.
    voiceGain.gain.setValueAtTime(0, t0 + s.startMs / 1000)
    voiceGain.gain.linearRampToValueAtTime(0.22, t0 + s.startMs / 1000 + 0.02)
    voiceGain.gain.setValueAtTime(0.22, t0 + s.endMs / 1000 - 0.02)
    voiceGain.gain.linearRampToValueAtTime(0, t0 + s.endMs / 1000)
  }
  voice.start()
  wobble.start()

  await new Promise((r) => setTimeout(r, takeMs))
  await new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    recorder.requestData()
    recorder.stop()
  })
  await chain
  await writer.close().catch(() => undefined)
  for (const t of dest.stream.getTracks()) t.stop()
  try {
    voice.stop()
    wobble.stop()
    tone.stop()
  } catch {
    /* already stopped */
  }
  await ctx.close().catch(() => undefined)
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

/** Largest single-sample jump near a join vs anywhere else (the F1 metric). */
async function jointDiscontinuity(
  blob: Blob,
  joinsMs: number[],
): Promise<{ joinMaxDelta: number; baselineMaxDelta: number; ratio: number } | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const sink = new AudioBufferSink(track)
    let joinMax = 0
    let baseMax = 0
    const WINDOW_SEC = 0.01
    for await (const { buffer, timestamp } of sink.buffers()) {
      const ch = buffer.getChannelData(0)
      const rate = buffer.sampleRate
      for (let i = 1; i < ch.length; i++) {
        const d = Math.abs(ch[i]! - ch[i - 1]!)
        const t = timestamp + i / rate
        if (joinsMs.some((j) => Math.abs(t - j / 1000) < WINDOW_SEC)) {
          if (d > joinMax) joinMax = d
        } else if (d > baseMax) baseMax = d
      }
    }
    return {
      joinMaxDelta: Math.round(joinMax * 1e5) / 1e5,
      baselineMaxDelta: Math.round(baseMax * 1e5) / 1e5,
      ratio: baseMax > 0 ? Math.round((joinMax / baseMax) * 100) / 100 : 0,
    }
  } finally {
    input.dispose()
  }
}

export interface F5aReport {
  takeMs: number
  /** The answer key: every gap in the rig, and whether it was long enough. */
  gaps: { startMs: number; endMs: number; lengthMs: number; long: boolean; detected: boolean }[]
  proposedCuts: { startMs: number; endMs: number; insideSpeechMs: number }[]
  /** Long gaps detected ÷ long gaps present. Gate: ≥95 %. */
  recallLongPct: number
  /** Total proposed cut time that lands inside a known speech span. Gate: 0. */
  speechCutMs: number
  shortGapPreserved: boolean
  removedMs: number
  outputMsBefore: number
  outputMsAfter: number
  joints: { joinMaxDelta: number; baselineMaxDelta: number; ratio: number } | null
  joinsMs: number[]
  analysis: { loudRms: number; floorRms: number; thresholdRms: number; usable: boolean }
  passed: boolean
  notes: string[]
}

const overlapMs = (a: Segment, b: Segment): number =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs))

export async function runSilenceTighten(opts: { takeMs?: number } = {}): Promise<F5aReport> {
  const takeMs = opts.takeMs ?? 12_000
  const channel = await recordKnownAudio(takeMs)
  const recording: Recording = {
    id: newId('rec'),
    createdAt: Date.now(),
    durationMs: takeMs,
    channels: [channel],
  }
  try {
    const edit: EditState = defaultEditState(recording)
    const result = await analyzeSilence(recording, edit)
    const proposal = result.proposal
    const cuts = (proposal?.cutSpans ?? []).map((c) => ({
      startMs: Math.round(c.startMs),
      endMs: Math.round(c.endMs),
      insideSpeechMs: Math.round(
        speechInFile().reduce(
          (sum, s) => sum + overlapMs({ startMs: c.startMs, endMs: c.endMs }, s),
          0,
        ),
      ),
    }))
    const speech = speechInFile()
    const gaps = knownGaps(takeMs).map((g) => {
      const lengthMs = g.endMs - g.startMs
      return {
        startMs: g.startMs,
        endMs: g.endMs,
        lengthMs,
        long: lengthMs >= 800,
        // Detected = a proposed cut sits inside this gap and covers the part of
        // it that padding leaves cuttable.
        detected: cuts.some(
          (c) =>
            overlapMs({ startMs: c.startMs, endMs: c.endMs }, g) >=
            Math.max(1, lengthMs - 2 * SILENCE_DEFAULTS.paddingMs - 150),
        ),
      }
    })
    const long = gaps.filter((g) => g.long)
    const recallLongPct = long.length
      ? Math.round((long.filter((g) => g.detected).length / long.length) * 1000) / 10
      : 100
    const speechCutMs = cuts.reduce((sum, c) => sum + c.insideSpeechMs, 0)
    // The lead-in gap is short by construction; the answer key's short gap is
    // the 500 ms one in the middle.
    const shortGap = gaps.find((g) => !g.long && g.startMs > 1000)
    void speech
    const outputMsBefore = keptSegments(edit).reduce((s, g) => s + (g.endMs - g.startMs), 0)

    let joints: F5aReport['joints'] = null
    let joinsMs: number[] = []
    let outputMsAfter = outputMsBefore
    if (proposal) {
      const applied: EditState = { ...edit, segments: proposal.segments }
      outputMsAfter = keptSegments(applied).reduce((s, g) => s + (g.endMs - g.startMs), 0)
      joinsMs = segmentJoinsMs(applied)
      const exported = await exportRecording({
        recording,
        edit: applied,
        settings: { width: 960, height: 540, fps: 30 },
      })
      joints = await jointDiscontinuity(exported.blob, joinsMs)
    }

    const analysis = {
      loudRms: Math.round((proposal?.analysis.loudRms ?? 0) * 1e5) / 1e5,
      floorRms: Math.round((proposal?.analysis.floorRms ?? 0) * 1e5) / 1e5,
      thresholdRms: Math.round((proposal?.analysis.thresholdRms ?? 0) * 1e5) / 1e5,
      usable: proposal?.analysis.usable ?? false,
    }
    return {
      takeMs,
      gaps,
      proposedCuts: cuts,
      recallLongPct,
      speechCutMs,
      shortGapPreserved: !!shortGap && !shortGap.detected,
      removedMs: Math.round(proposal?.removedMs ?? 0),
      outputMsBefore,
      outputMsAfter,
      joints,
      joinsMs,
      analysis,
      passed:
        recallLongPct >= 95 &&
        speechCutMs === 0 &&
        !!shortGap &&
        !shortGap.detected &&
        !!joints &&
        joints.joinMaxDelta <= Math.max(0.02, joints.baselineMaxDelta * 1.5),
      notes: [
        'the rig gates a wobbling saw over a constant room tone, so the analyser is measuring level exactly as it does on a real take — no voice detection anywhere',
        'a 500 ms gap is in the map on purpose: tightening must leave the pauses that make speech sound like speech',
        'joins are measured the F1 way — the largest sample-to-sample step within 10 ms of a join against the largest anywhere else',
        'the proposal is applied here through the same segments field the editor writes; nothing in the analyser touches an edit',
      ],
    }
  } finally {
    await blobStore.remove(channel.blobKey).catch(() => undefined)
  }
}
