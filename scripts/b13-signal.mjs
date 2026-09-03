#!/usr/bin/env node
/**
 * B13 — THE SIGNAL, IN ONE PLACE.
 *
 * Two things need this code and they must never drift: the rig injects it into
 * the page to PLAY, and the analyser runs it in node to know what SHOULD have
 * been recorded. Keeping the source as a string that both sides share is what
 * makes "the reference" and "the thing that was played" the same object rather
 * than two implementations that agree until they do not.
 */
/** Octave centres, then the two channel markers. All integer-cycle in 4 s. */
const TONES = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
const MARK_L = 3000
const MARK_R = 5000

export const SIGNAL_SRC = `
  const TONES = ${JSON.stringify(TONES)}
  const MARK_L = ${MARK_L}, MARK_R = ${MARK_R}
  const LOOP_S = 4
  function buildSignal(rate) {
    const n = Math.round(LOOP_S * rate)
    const L = new Float32Array(n), R = new Float32Array(n)
    const all = TONES.length + 1
    const phase = (k) => (Math.PI * k * k) / all      // Schroeder
    const add = (buf, f, k, amp) => {
      const w = (2 * Math.PI * f) / rate
      const p = phase(k)
      for (let i = 0; i < n; i++) buf[i] += amp * Math.sin(w * i + p)
    }
    TONES.forEach((f, k) => { add(L, f, k, 1); add(R, f, k, 1) })
    add(L, MARK_L, TONES.length, 1)
    add(R, MARK_R, TONES.length, 1)
    let peak = 0
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
    const g = 0.8 / peak
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g }
    return { L, R, rate, n }
  }
  /**
   * PROGRAM MATERIAL, because tones cannot be judged by ear.
   *
   * The twelve-tone signal is the right ruler and the wrong thing to listen to:
   * it is harsh by construction, and Robert's report on the first A/B pair —
   * "a more noises, b still small noises" — was partly a verdict on the
   * stimulus. It is also the wrong stimulus for the defect, because opus puts
   * its own masking noise at -30 dB on a multitone and buries the very thing
   * being compared.
   *
   * So this builds something musical and deterministic: a four-chord phrase of
   * plucked tones, a kick on each bar, and a hi-hat every half-beat. The hi-hat
   * is the point — it is filtered noise reaching past 16 kHz, which is exactly
   * where the export's Hermite resampler leaves a companion 11 dB down. Quiet
   * gaps between phrases are the other half: gating and pumping only show where
   * the signal is small.
   *
   * Seeded LCG, so the same eight seconds every run and the same file to compare.
   */
  function buildProgram(rate) {
    const LOOP = 8
    const n = Math.round(LOOP * rate)
    const L = new Float32Array(n), R = new Float32Array(n)
    let seed = 12345
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
    const add = (buf, at, dur, f, amp, harm) => {
      const start = Math.round(at * rate), len = Math.round(dur * rate)
      for (let i = 0; i < len && start + i < n; i++) {
        const t = i / rate
        const env = Math.exp(-t * (3 / dur))
        let v = 0
        for (let h = 1; h <= harm; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h)
        buf[start + i] += v * amp * env
      }
    }
    // Four bars of two seconds: a chord, a kick, and eight hats.
    const CHORDS = [[220, 277.18, 329.63], [196, 246.94, 293.66], [174.61, 220, 261.63], [164.81, 207.65, 246.94]]
    for (let bar = 0; bar < 4; bar++) {
      const at = bar * 2
      CHORDS[bar].forEach((f, k) => {
        add(L, at + k * 0.02, 1.6, f, 0.16, 6)
        add(R, at + k * 0.02 + 0.01, 1.6, f, 0.16, 6)
      })
      // kick: a short low sweep
      for (let i = 0; i < Math.round(0.18 * rate); i++) {
        const t = i / rate
        const f = 110 * Math.exp(-t * 30) + 45
        const v = Math.sin(2 * Math.PI * f * t) * 0.5 * Math.exp(-t * 14)
        const idx = Math.round(at * rate) + i
        if (idx < n) { L[idx] += v; R[idx] += v }
      }
      // hats: filtered noise, the part that lives above 8 kHz
      for (let h = 0; h < 8; h++) {
        const start = Math.round((at + h * 0.25 + 0.125) * rate)
        let hp = 0, prev = 0
        for (let i = 0; i < Math.round(0.06 * rate); i++) {
          const t = i / rate
          const w = rnd()
          hp = 0.82 * (hp + w - prev)   // one-pole high-pass -> mostly top octaves
          prev = w
          const v = hp * 0.22 * Math.exp(-t * 55)
          const idx = start + i
          if (idx < n) { L[idx] += v * (h % 2 ? 0.8 : 1); R[idx] += v * (h % 2 ? 1 : 0.8) }
        }
      }
    }
    // A quiet bar: the phrase breathes, and gating shows only in the gaps.
    const gapFrom = Math.round(7.2 * rate)
    for (let i = gapFrom; i < n; i++) { L[i] *= 0.06; R[i] *= 0.06 }
    let peak = 0
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]))
    const g = 0.7 / peak
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g }
    return { L, R, rate, n }
  }

  /**
   * Goertzel magnitude, in dBFS, of one frequency over one window. Exact for a
   * tone that completes whole cycles in the window, which every tone here does,
   * so no FFT and no window function is needed and none is used.
   */
  function toneDb(buf, from, len, f, rate) {
    const k = Math.round((len * f) / rate)
    const w = (2 * Math.PI * k) / len
    const c = 2 * Math.cos(w)
    let s1 = 0, s2 = 0
    for (let i = 0; i < len; i++) { const s = buf[from + i] + c * s1 - s2; s2 = s1; s1 = s }
    const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w)
    const mag = (2 * Math.sqrt(re * re + im * im)) / len
    return 20 * Math.log10(Math.max(mag, 1e-12))
  }
  /**
   * Average each tone over windows spread through the whole signal.
   *
   * THE WINDOW IS THE LOOP, 4 s, and that is not a round number chosen for
   * comfort. Goertzel is exact only when the tone completes a whole number of
   * cycles in the window: at a 1 s window, 31.25 Hz lands a quarter of a bin
   * off and reads 1.0 dB low, 62.5 Hz reads 4.0 dB low — scalloping loss, an
   * artefact of the ruler. Those two tones ARE the bass this task is about, so
   * a ruler that mis-reads them by 4 dB cannot be used to judge a complaint
   * about bass. At 4 s every tone here is an exact bin and the loss is zero.
   *
   * skipS seconds are dropped from each end because a take's edges are their
   * own subject (H5, B12); the reference passes 0, having no edges.
   */
  function spectrum(L, R, rate, skipS) {
    const skip = Math.round((skipS === undefined ? 1 : skipS) * rate)
    const win = LOOP_S * rate
    const usable = Math.min(L.length, R.length) - 2 * skip
    if (usable < win) return null
    const count = Math.max(1, Math.min(20, Math.floor(usable / win)))
    // Spread the windows across the usable span without running off its end.
    const step = count > 1 ? Math.floor((usable - win) / (count - 1)) : 0
    const acc = {}
    const names = [...TONES, MARK_L, MARK_R]
    for (const f of names) acc[f] = { l: [], r: [] }
    for (let i = 0; i < count; i++) {
      const at = skip + i * step
      for (const f of names) {
        acc[f].l.push(toneDb(L, at, win, f, rate))
        acc[f].r.push(toneDb(R, at, win, f, rate))
      }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
    const out = {}
    for (const f of names) out[f] = { l: Math.round(mean(acc[f].l) * 10) / 10, r: Math.round(mean(acc[f].r) * 10) / 10 }
    let sum = 0, peak = 0
    for (let i = 0; i < L.length; i++) { sum += L[i] * L[i]; peak = Math.max(peak, Math.abs(L[i])) }
    out.__rmsDb = Math.round(20 * Math.log10(Math.max(Math.sqrt(sum / L.length), 1e-12)) * 10) / 10
    out.__peak = Math.round(peak * 1000) / 1000
    out.__windows = count
    out.__rate = rate
    return out
  }`

const built = new Function(
  SIGNAL_SRC + '\nreturn { buildSignal, buildProgram, spectrum, toneDb }',
)()
export const { buildSignal, buildProgram, spectrum, toneDb } = built
export { TONES, MARK_L, MARK_R }
