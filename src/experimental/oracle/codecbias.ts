/**
 * EXPERIMENTAL — Step 3(c2): codec-chain bias micro-test.
 *
 * The localization step leaves a ~+30–40 ms residual that capture bookkeeping
 * does not explain (measured export sync minus raw-decode prediction). Two
 * different mechanisms could produce it, and they demand different fixes:
 *
 *   (c2-mux)    the export's AAC audio genuinely sits late in the MP4
 *               (encoder priming / missing edit list) — users hear it;
 *   (d2-oracle) the audio is placed correctly but the ORACLE's decode path
 *               (mediabunny AudioBufferSink over WebCodecs) re-introduces the
 *               delay when analyzing — users do NOT hear it, and the
 *               instrument must be corrected instead.
 *
 * This micro-test removes capture entirely: synthesize a click track with
 * exactly known click positions -> mediabunny AudioBufferSource -> mp4/aac
 * (the exact toolchain and codec pickEncodingTarget prefers) -> decode the
 * SAME file two independent ways:
 *   1. mediabunny AudioBufferSink (the oracle's path, WebCodecs decoder);
 *   2. AudioContext.decodeAudioData (Chromium's media stack, the same code
 *      path <audio>/<video> playback uses).
 * Shift(1) ≈ shift(2) ≈ residual  => c2-mux (real, audible).
 * Shift(1) ≈ residual, shift(2) ≈ 0 => d2-oracle (instrument artifact).
 * Both ≈ 0                          => residual lives elsewhere (mixer math).
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from 'mediabunny'
import { feedOnsetDetector, newOnsetDetector } from './fiducial'

const SR = 48_000
const CLICKS_SEC = [0.5, 1.5, 2.5, 3.5]
const DUR_SEC = 4.5

function makeClickChunkSec(chunkIndex: number): AudioBuffer {
  const frames = SR // 1s chunks, mirrors the production writeAudioChunk shape
  const left = new Float32Array(frames)
  for (const c of CLICKS_SEC) {
    const s0 = Math.round(c * SR) - chunkIndex * SR
    if (s0 < 0 || s0 >= frames) continue
    const s1 = Math.min(frames, s0 + Math.round(0.05 * SR))
    for (let s = s0; s < s1; s++) left[s] = 0.6 * Math.sin((2 * Math.PI * 880 * (s - s0)) / SR)
  }
  const buffer = new AudioBuffer({ length: frames, numberOfChannels: 2, sampleRate: SR })
  buffer.copyToChannel(left, 0)
  buffer.copyToChannel(left, 1)
  return buffer
}

async function encodeClicks(codec: 'aac' | 'opus'): Promise<Blob> {
  const format = codec === 'aac' ? new Mp4OutputFormat() : new WebMOutputFormat()
  const output = new Output({ format, target: new BufferTarget() })
  const source = new AudioBufferSource({ codec, bitrate: 128_000 })
  output.addAudioTrack(source)
  await output.start()
  const chunks = Math.ceil(DUR_SEC)
  for (let c = 0; c < chunks; c++) await source.add(makeClickChunkSec(c))
  source.close()
  await output.finalize()
  const buffer = output.target.buffer
  if (!buffer) throw new Error('muxer produced no output')
  return new Blob([buffer], { type: format.mimeType })
}

async function onsetsViaMediabunny(blob: Blob): Promise<number[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return []
    const det = newOnsetDetector()
    const sink = new AudioBufferSink(track)
    for await (const { buffer, timestamp } of sink.buffers()) {
      feedOnsetDetector(det, buffer.getChannelData(0), timestamp, buffer.sampleRate)
    }
    return det.onsetsSec
  } finally {
    input.dispose()
  }
}

async function onsetsViaDecodeAudioData(blob: Blob): Promise<number[]> {
  const ctx = new OfflineAudioContext(1, 1, SR)
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
  const det = newOnsetDetector()
  feedOnsetDetector(det, decoded.getChannelData(0), 0, decoded.sampleRate)
  return det.onsetsSec
}

function meanShiftMs(onsets: number[]): number | null {
  const shifts: number[] = []
  for (const o of onsets) {
    let best = Infinity
    for (const c of CLICKS_SEC) {
      const d = (o - c) * 1000
      if (Math.abs(d) < Math.abs(best)) best = d
    }
    if (Math.abs(best) <= 250) shifts.push(best)
  }
  return shifts.length ? shifts.reduce((a, b) => a + b, 0) / shifts.length : null
}

export interface CodecBiasReport {
  clicksSec: number[]
  results: {
    codec: string
    container: string
    fileBytes: number
    /** Oracle decode path (mediabunny/WebCodecs): mean click shift, ms. */
    mediabunnyShiftMs: number | null
    mediabunnyOnsets: number
    /** Playback-representative path (decodeAudioData): mean click shift, ms. */
    decodeAudioDataShiftMs: number | null
    decodeAudioDataOnsets: number
  }[]
  interpretation: string
}

export async function runCodecBias(): Promise<CodecBiasReport> {
  const results: CodecBiasReport['results'] = []
  for (const codec of ['aac', 'opus'] as const) {
    const blob = await encodeClicks(codec)
    const viaMb = await onsetsViaMediabunny(blob)
    const viaDad = await onsetsViaDecodeAudioData(blob)
    results.push({
      codec,
      container: codec === 'aac' ? 'mp4' : 'webm',
      fileBytes: blob.size,
      mediabunnyShiftMs: meanShiftMs(viaMb),
      mediabunnyOnsets: viaMb.length,
      decodeAudioDataShiftMs: meanShiftMs(viaDad),
      decodeAudioDataOnsets: viaDad.length,
    })
  }
  const aac = results[0]
  let interpretation = 'inconclusive'
  if (aac.mediabunnyShiftMs !== null && aac.decodeAudioDataShiftMs !== null) {
    const mb = aac.mediabunnyShiftMs
    const dad = aac.decodeAudioDataShiftMs
    if (Math.abs(mb) < 10 && Math.abs(dad) < 10) {
      interpretation = 'both decode paths clean: residual does NOT come from the aac codec chain'
    } else if (Math.abs(mb - dad) < 10) {
      interpretation = `c2-mux: aac audio is genuinely late by ~${mb.toFixed(1)}ms in the MP4 (both decoders agree) — audible in playback`
    } else {
      interpretation = `d2-oracle: oracle decode path shows ${mb.toFixed(1)}ms but playback path shows ${dad.toFixed(1)}ms — instrument artifact, correct the oracle`
    }
  }
  return { clicksSec: CLICKS_SEC, results, interpretation }
}
