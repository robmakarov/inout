#!/usr/bin/env node
/**
 * B13(3) — FIND THE SMALL NOISES, WITHOUT ASSUMING WHAT THEY ARE.
 *
 * Robert on the two A/B files this task produced: "a more noises, b still small
 * noises". That kills the explanation the spectrum gave. A is the RAW-flag take
 * — spectrally clean to 1.1 dB across ten octaves — and it has MORE of them
 * than the voice-processed one. So the noises are not the voice processing;
 * the voice processing was HIDING them (noise suppression gates, automatic gain
 * pulls the whole take down 15 dB, and a mono downmix averages two channels).
 * And `ChannelDiagnostics.paddedMs` is 0 on both takes, so they are not B2's
 * fade/silence/fade splices either — the file lost no time.
 *
 * WHAT THIS MEASURES. Not a spectrum: a spectrum averages over seconds and a
 * click is a millisecond. This looks for EVENTS.
 *
 *   · high-pass by first difference — a click is broadband, the tones are not;
 *   · envelope in 1 ms blocks;
 *   · the run's own MEDIAN block level is the reference, so nothing has to be
 *     assumed about the content, the gain, or the codec;
 *   · every block above median x THRESH is an event, reported with its time,
 *     its height in dB over median, and its width.
 *
 * It also reports the same for the DIFFERENCE BETWEEN CHANNELS (L-R). Our
 * signal is two decorrelated channels, so L-R is not silent — but a click that
 * appears in only ONE channel is a different defect from one in both, and the
 * two are worth telling apart.
 *
 * Runs on any file ffmpeg can decode, so it can be pointed at a take Robert
 * complained about as easily as at a rig's output.
 *
 *   node scripts/b13-noise.mjs ~/Downloads/inout-b13/A-raw-flags-GOOD.mp4
 *   node scripts/b13-noise.mjs a.mp4 b.mp4          # compare two files
 *   node scripts/b13-noise.mjs --thresh=6 a.mp4     # dB over median
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const opts = { thresh: 8, files: [], top: 12, program: false, notches: false }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--thresh=')) opts.thresh = Number(a.slice(9))
  else if (a.startsWith('--top=')) opts.top = Number(a.slice(6))
  else if (a === '--program') opts.program = true
  else if (a === '--notches') opts.notches = true
  else opts.files.push(a.replace(/^~/, process.env.HOME))
}
if (opts.files.length === 0) {
  console.error('usage: node scripts/b13-noise.mjs <file.mp4> [more files]')
  process.exit(2)
}

/** Decode to interleaved float32 stereo at 48 kHz through ffmpeg. */
function decode(path) {
  const buf = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-map', 'a:0', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 },
  )
  const inter = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4))
  const n = Math.floor(inter.length / 2)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    L[i] = inter[2 * i]
    R[i] = inter[2 * i + 1]
  }
  return { L, R, rate: 48000 }
}

const BLOCK_MS = 1

/**
 * Block envelope of the first difference. The first difference is a 6 dB/octave
 * high-pass: it leaves the top tone dominant and stationary, and it makes a
 * step discontinuity — which is what a splice, a dropout or a buffer seam IS —
 * into a single large sample. Nothing here is tuned to this signal.
 */
function events(x, rate, thresh) {
  const block = Math.max(1, Math.round((BLOCK_MS / 1000) * rate))
  const nb = Math.floor((x.length - 1) / block)
  const env = new Float64Array(nb)
  for (let b = 0; b < nb; b++) {
    let peak = 0
    const from = b * block + 1
    for (let i = from; i < from + block; i++) {
      const d = Math.abs(x[i] - x[i - 1])
      if (d > peak) peak = d
    }
    env[b] = peak
  }
  const sorted = Float64Array.from(env).sort()
  const median = sorted[Math.floor(nb / 2)] || 1e-12
  const db = (v) => 20 * Math.log10(Math.max(v, 1e-12) / median)
  const over = []
  let run = null
  for (let b = 0; b < nb; b++) {
    const d = db(env[b])
    if (d >= thresh) {
      if (run) {
        run.blocks++
        run.peakDb = Math.max(run.peakDb, d)
      } else run = { atMs: (b * block * 1000) / rate, blocks: 1, peakDb: d }
    } else if (run) {
      over.push(run)
      run = null
    }
  }
  if (run) over.push(run)
  return {
    durationS: x.length / rate,
    medianDbfs: Math.round(20 * Math.log10(Math.max(median, 1e-12)) * 10) / 10,
    p999OverMedianDb: Math.round(db(sorted[Math.floor(nb * 0.999)]) * 10) / 10,
    maxOverMedianDb: Math.round(db(sorted[nb - 1]) * 10) / 10,
    count: over.length,
    perMinute: Math.round((over.length / (x.length / rate / 60)) * 10) / 10,
    worst: over
      .slice()
      .sort((a, b) => b.peakDb - a.peakDb)
      .slice(0, opts.top)
      .map((e) => ({
        atS: Math.round(e.atMs) / 1000,
        ms: e.blocks * BLOCK_MS,
        overMedianDb: Math.round(e.peakDb * 10) / 10,
      })),
  }
}

const results = []
for (const f of opts.files) {
  if (!existsSync(f)) {
    console.error(`b13-noise: no such file ${f}`)
    process.exit(2)
  }
  const { L, R, rate } = decode(f)
  const side = new Float32Array(L.length)
  for (let i = 0; i < L.length; i++) side[i] = L[i] - R[i]
  results.push({
    file: f.split('/').pop(),
    left: events(L, rate, opts.thresh),
    right: events(R, rate, opts.thresh),
    side: events(side, rate, opts.thresh),
  })
}

console.log(`\n── B13(3) noise events · 1 ms blocks · >= ${opts.thresh} dB over each run's own median ──`)
console.log(
  'file'.padEnd(30) + 'sec'.padStart(7) + 'events'.padStart(8) + '/min'.padStart(8) + 'worst dB'.padStart(10) + '  p99.9 dB',
)
for (const r of results) {
  console.log(
    r.file.padEnd(30) +
      String(Math.round(r.left.durationS)).padStart(7) +
      String(r.left.count).padStart(8) +
      String(r.left.perMinute).padStart(8) +
      String(r.left.maxOverMedianDb).padStart(10) +
      `  ${r.left.p999OverMedianDb}`,
  )
}
for (const r of results) {
  console.log(`\n${r.file}`)
  for (const [name, e] of [['left', r.left], ['right', r.right], ['L-R (one channel only)', r.side]]) {
    console.log(
      `  ${name.padEnd(24)} ${String(e.count).padStart(5)} events · ${e.perMinute}/min · worst ${e.maxOverMedianDb} dB over median · median block ${e.medianDbfs} dBFS`,
    )
  }
  if (r.left.worst.length) {
    console.log(`  worst in LEFT: ${r.left.worst.map((w) => `${w.atS}s ${w.overMedianDb}dB/${w.ms}ms`).join(' · ')}`)
  }
}
console.log('')

/**
 * THE MEASUREMENT THE FIRST PASS COULD NOT MAKE, and the reason it could not.
 *
 * B13's spectrum reads the level of each of the twelve tones. A LIMITER DOES
 * NOT MOVE THOSE LEVELS. It clips the peaks between them, and everything it
 * adds lands at frequencies that are not tones — sums and differences of the
 * twelve, thousands of them, spread across the band. So a take could be
 * "within 0.1 dB at every octave" and be audibly dirty, and the first pass
 * would have called it clean. It did.
 *
 * This measures what is NOT a tone. Blackman-Harris window (sidelobes -92 dB,
 * so a 0 dB tone eight bins away contributes nothing), 65536-point FFT, every
 * tone masked out with +-8 bins, and the surviving energy from 20 Hz to 20 kHz
 * reported against the tone energy. On a clean chain this is the codec floor.
 * On a chain that is limiting, it is the distortion.
 *
 * It is expressed as THD+N in dB: -60 is clean, -30 is audible, -20 is dirty.
 */
const TONES = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 3000, 5000]

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function thdPlusN(x, rate) {
  const N = 65536
  if (x.length < N * 2) return null
  // Blackman-Harris 4-term.
  const w = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / (N - 1)
    w[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t)
  }
  const starts = []
  const usable = x.length - N - rate // leave a second at the end
  for (let k = 0; k < 8; k++) starts.push(rate + Math.floor((usable * k) / 8))
  const ratios = []
  let toneDbfs = 0
  for (const s of starts) {
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = x[s + i] * w[i]
    fft(re, im)
    const half = N / 2
    const mag2 = new Float64Array(half)
    for (let i = 0; i < half; i++) mag2[i] = re[i] * re[i] + im[i] * im[i]
    const mask = new Uint8Array(half)
    for (const f of TONES) {
      const c = Math.round((f * N) / rate)
      for (let b = Math.max(0, c - 8); b <= Math.min(half - 1, c + 8); b++) mask[b] = 1
    }
    const lo = Math.round((20 * N) / rate)
    const hi = Math.min(half - 1, Math.round((20000 * N) / rate))
    let tone = 0
    let rest = 0
    for (let b = lo; b <= hi; b++) (mask[b] ? (tone += mag2[b]) : (rest += mag2[b]))
    if (tone > 0) ratios.push(10 * Math.log10(Math.max(rest, 1e-30) / tone))
    toneDbfs = tone
  }
  ratios.sort((a, b) => a - b)
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length
  return {
    windows: ratios.length,
    thdPlusNdB: Math.round(mean * 10) / 10,
    bestdB: Math.round(ratios[0] * 10) / 10,
    worstdB: Math.round(ratios[ratios.length - 1] * 10) / 10,
  }
}

/** The method's own floor: the reference signal, synthesised, measured the same way. */
function referenceSignal(rate, seconds) {
  const LOOP = 4
  const n = Math.round(LOOP * rate)
  const L = new Float64Array(n)
  const all = 11
  for (let k = 0; k < 10; k++) {
    const f = TONES[k]
    const wv = (2 * Math.PI * f) / rate
    const p = (Math.PI * k * k) / all
    for (let i = 0; i < n; i++) L[i] += Math.sin(wv * i + p)
  }
  const wv = (2 * Math.PI * 3000) / rate
  const p = (Math.PI * 100) / all
  for (let i = 0; i < n; i++) L[i] += Math.sin(wv * i + p)
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]))
  const g = 0.8 / peak
  const out = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < out.length; i++) out[i] = L[i % n] * g
  return out
}

/**
 * THD+N ONLY MEANS ANYTHING ON THE TONE SIGNAL. On program material there are
 * no tones to mask out and the number is the whole spectrum divided by twelve
 * arbitrary bins — printing it would be inventing a measurement.
 */
if (!opts.program) {
console.log('── THD+N: everything that is NOT one of the twelve tones, 20 Hz - 20 kHz ──')
const refFloor = thdPlusN(referenceSignal(48000, 30), 48000)
console.log(`  ${'the reference itself (method floor)'.padEnd(34)} ${refFloor.thdPlusNdB} dB`)
for (const f of opts.files) {
  const { L, rate } = decode(f)
  const t = thdPlusN(L, rate)
  console.log(
    `  ${f.split('/').pop().padEnd(34)} ${t === null ? 'too short' : `${t.thdPlusNdB} dB  (best ${t.bestdB}, worst ${t.worstdB}, ${t.windows} windows)`}`,
  )
}
console.log('')
}

/**
 * PROGRAM MATERIAL, MEASURED IN BANDS (`--program`).
 *
 * The tone ruler cannot judge music and the THD+N number understates the
 * resampler fix, for a reason worth writing down: opus puts its own noise at
 * about -30 dB on a multitone, and that noise is placed UNDER the masking
 * threshold on purpose — it is inaudible by construction. The resampler's is
 * not: it is an image of the signal landing wherever arithmetic puts it. Two
 * chains with the same THD+N are not equally clean.
 *
 * So for program material this compares long-term octave-band power against
 * the reference the page actually played. No alignment is needed for a power
 * spectrum, and the bands above 8 kHz are where the export's Hermite path
 * leaves its companion.
 */
if (opts.program) {
  const { buildProgram } = await import('./b13-signal.mjs')
  const BANDS = [
    [31, 63], [63, 125], [125, 250], [250, 500], [500, 1000],
    [1000, 2000], [2000, 4000], [4000, 8000], [8000, 12000], [12000, 16000], [16000, 20000],
  ]
  const bandPower = (x, rate) => {
    const N = 32768
    const w = new Float64Array(N)
    for (let i = 0; i < N; i++) {
      const t = (2 * Math.PI * i) / (N - 1)
      w[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t)
    }
    const acc = new Float64Array(BANDS.length)
    let windows = 0
    for (let s = rate; s + N < x.length - rate; s += N) {
      const re = new Float64Array(N)
      const im = new Float64Array(N)
      for (let i = 0; i < N; i++) re[i] = x[s + i] * w[i]
      fft(re, im)
      for (let b = 0; b < BANDS.length; b++) {
        const lo = Math.round((BANDS[b][0] * N) / rate)
        const hi = Math.min(N / 2 - 1, Math.round((BANDS[b][1] * N) / rate))
        let p = 0
        for (let k = lo; k <= hi; k++) p += re[k] * re[k] + im[k] * im[k]
        acc[b] += p
      }
      windows++
    }
    return Array.from(acc, (v) => 10 * Math.log10(Math.max(v / Math.max(1, windows), 1e-30)))
  }
  const prog = buildProgram(48000)
  const tiled = new Float32Array(48000 * 30)
  for (let i = 0; i < tiled.length; i++) tiled[i] = prog.L[i % prog.n]
  const ref = bandPower(tiled, 48000)
  console.log('── program material · octave-band power vs the reference that was played (dB) ──')
  console.log('band'.padEnd(14) + opts.files.map((f) => f.split('/').pop().slice(0, 22).padStart(24)).join(''))
  const rows = opts.files.map((f) => bandPower(decode(f).L, 48000))
  for (let b = 0; b < BANDS.length; b++) {
    // Each file is offset so its 1-2 kHz band matches the reference: this is a
    // comparison of SHAPE, not of how loud the export chose to be.
    const line = rows.map((r) => (r[b] - r[5] - (ref[b] - ref[5])).toFixed(1).padStart(24)).join('')
    console.log(`${BANDS[b][0]}-${BANDS[b][1]} Hz`.padEnd(14) + line)
  }
  console.log('')
}

/**
 * PAD NOTCHES (`--notches`) — the OTHER shape a noise has, and the one every
 * detector above is blind to.
 *
 * When the audio graph loses time, capture splices in a ~1.3 ms
 * fade/silence/fade so the sample-counted timeline stays honest
 * (`ChannelDiagnostics.paddedMs`). That is a DIP, not a spike, and a detector
 * built around "louder than its neighbours" cannot see one. Measured across
 * this task's own takes, paddedMs ran 0, 0, 91 and 366 ms on the same rig
 * depending on what else the machine was doing — 366 ms is roughly 280 splices
 * in twenty seconds, which is what "a lot of small noises" sounds like.
 */
if (opts.notches) {
  /**
   * VALIDATED AGAINST A CONTROL, because the first cut of this was not and it
   * was measuring the music. Run on the reference material itself — which has
   * zero splices by construction — the loose version below reported 178 per
   * minute, MORE than the real takes. A detector that fires on a hi-hat decay
   * cannot count splices.
   *
   * The splice has a shape nothing musical has: capture fades to TRUE ZERO,
   * holds, and fades back, inside about 1.3 ms. So the test is a run of
   * essentially-zero samples, 0.2-3 ms long, with real level on both sides —
   * not "quieter than its neighbours", which is what music does all day.
   */
  console.log('── pad splices: runs of true silence with audio either side ──')
  for (const f of opts.files) {
    const { L, rate } = decode(f)
    const SILENT = 3e-4          // -70 dBFS: a splice writes zeros, music does not
    const MIN = Math.round(0.0002 * rate)
    const MAX = Math.round(0.003 * rate)
    const GUARD = Math.round(0.004 * rate)
    const LOUD = 0.02            // real level either side, or it is just a quiet bar
    const splices = []
    let run = 0
    for (let i = 1; i < L.length; i++) {
      if (Math.abs(L[i]) < SILENT) { run++; continue }
      if (run >= MIN && run <= MAX) {
        const from = i - run
        let before = 0, after = 0
        for (let k = Math.max(0, from - GUARD); k < from; k++) before = Math.max(before, Math.abs(L[k]))
        for (let k = i; k < Math.min(L.length, i + GUARD); k++) after = Math.max(after, Math.abs(L[k]))
        if (before > LOUD && after > LOUD) splices.push({ atS: from / rate, ms: (run / rate) * 1000 })
      }
      run = 0
    }
    const minutes = L.length / rate / 60
    console.log(
      `  ${f.split('/').pop().padEnd(34)} ${String(splices.length).padStart(5)} splices · ` +
        `${(splices.length / minutes).toFixed(0)}/min · total ${splices.reduce((a, s) => a + s.ms, 0).toFixed(0)} ms · ` +
        `first: ${splices.slice(0, 6).map((n) => n.atS.toFixed(2) + 's').join(' ') || '—'}`,
    )
  }
  console.log('')
}
