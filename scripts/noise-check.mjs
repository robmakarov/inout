#!/usr/bin/env node
/**
 * B2 — THE DISCRIMINATOR, AND IT RUNS BEFORE ANY FIX.
 *
 * Robert: "when video recorded and edit starts a lot of minor noises in tab
 * audio, but after some time editing noises almost completly stops in same
 * places they were in begining, but not completly."
 *
 * That shape says there are TWO defects, and chasing them as one is how this
 * stays open. A noise that HEALS with repetition is not in the file — it is the
 * preview's own correction (a cold decode stalls, `usePlayback.sync` hard-seeks
 * or slews playbackRate, and the browser's pitch-preserving time-stretcher is
 * what is heard). A noise that survives every repetition IS in the file — the
 * ~1.3 ms fade/silence/fade notch capture splices in for every starved audio
 * quantum, deliberately, so the sample-counted timeline stays honest.
 *
 * SO THE FIRST QUESTION IS NOT "how do we fix it" BUT "how much of it is in the
 * file", and `ChannelDiagnostics.paddedMs` answers it before anyone listens.
 * Zero there means the file is clean and the preview is the whole story.
 *
 * This drives the DEPLOYED build under deliberate load (a 4K synthetic screen,
 * which is what starves an audio worklet), records, and reports:
 *   · paddedMs / trimmedMs per audio channel, out of the product's own storage;
 *   · the pad NOTCHES actually present in the exported file, counted and
 *     measured in dB by decoding it — the numeric half of "export and listen".
 *
 *   node scripts/noise-check.mjs
 *   node scripts/noise-check.mjs --takeMs=40000 --headed
 *   node scripts/noise-check.mjs --url=http://localhost:4173/
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9355
const PROD_URL = 'https://inout-kappa.vercel.app/'
const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
}

const opts = { url: PROD_URL, takeMs: 30000, headed: false, screen: '3840x2160', load: 0, playMs: 12000 }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--url=')) opts.url = a.slice(6)
  else if (a.startsWith('--takeMs=')) opts.takeMs = Number(a.slice(9))
  else if (a.startsWith('--screen=')) opts.screen = a.slice(9)
  else if (a.startsWith('--load=')) opts.load = Number(a.slice(7))
  else if (a.startsWith('--playMs=')) opts.playMs = Number(a.slice(9))
  else if (a === '--headed') opts.headed = true
}

/**
 * `--load=N` SPINS N BUSY CORES FOR THE DURATION OF THE TAKE, and it exists
 * because the first version of this script could not fail.
 *
 * The synthetic screen is set to 4K — but `capDisplayTrack` constrains a
 * display track to 1920x1080 before the session ever sees it (acquire.ts, the
 * 08-22 freeze fix), so asking for 4K here buys almost no load at all. The take
 * read `paddedMs: 0` and that was a fact about an idle machine, not about
 * capture. An audio worklet starves when the MACHINE is starved, so the machine
 * has to actually be starved: real competing work, announced, for exactly as
 * long as the take.
 */
function startCpuLoad(n) {
  if (!n) return () => undefined
  const kids = []
  for (let i = 0; i < n; i++) {
    kids.push(
      spawn(process.execPath, ['-e', 'let x=0;for(;;){x=(x+Math.random())%1e9}'], {
        stdio: 'ignore',
      }),
    )
  }
  return () => {
    for (const k of kids) {
      try {
        k.kill('SIGKILL')
      } catch {
        /* already dead */
      }
    }
  }
}
// A 4K synthetic screen is the load: it is what starves an AudioContext, and a
// take that never starves cannot answer this question either way.
const pageUrl =
  opts.url + (opts.url.includes('?') ? '&' : '?') + `synthetic=1&screensize=${opts.screen}`

let bin = process.env.CHROME_BIN
for (const c of CHROME[process.platform] ?? []) if (!bin && existsSync(c)) bin = c
if (!bin) {
  console.error('noise-check: no Chrome found (set CHROME_BIN)')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'inout-noise-'))
const report = { url: pageUrl, takeMs: opts.takeMs, captureLog: [], gates: {} }
let browser
let exitCode = 1

/**
 * Count pad notches in decoded PCM.
 *
 * A pad is fade-to-zero, silence, fade-from-zero. So it shows up as a run of
 * samples at (or extremely near) digital zero, bounded by audio on both sides.
 * Real content reaching exact zero for a millisecond does not happen on a
 * continuous source, which is what tab audio is. Depth is reported against the
 * local level either side, in dB, because that is what "how audible" means.
 */
const COUNT_NOTCHES = `(pcm, sampleRate) => {
  const FLOOR = 1e-4
  const MIN_RUN = Math.max(8, Math.round(sampleRate * 0.0005))
  const notches = []
  let run = 0
  const localRms = (centre, half) => {
    const a = Math.max(0, centre - half), b = Math.min(pcm.length, centre + half)
    let s = 0, n = 0
    for (let i = a; i < b; i++) { s += pcm[i] * pcm[i]; n++ }
    return n ? Math.sqrt(s / n) : 0
  }
  for (let i = 0; i <= pcm.length; i++) {
    const quiet = i < pcm.length && Math.abs(pcm[i]) < FLOOR
    if (quiet) { run++; continue }
    if (run >= MIN_RUN) {
      const start = i - run
      // Ignore leading/trailing silence: a notch is bounded by audio.
      if (start > sampleRate * 0.05 && i < pcm.length - sampleRate * 0.05) {
        const around = localRms(start, Math.round(sampleRate * 0.05))
        notches.push({
          atMs: Math.round((start / sampleRate) * 1000),
          ms: Math.round((run / sampleRate) * 10000) / 10,
          depthDb: around > 0 ? Math.round(20 * Math.log10(FLOOR / around) * 10) / 10 : null,
        })
      }
    }
    run = 0
  }
  return notches
}`

try {
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--mute-audio',
    '--window-size=1280,900',
  ]
  if (!opts.headed) args.unshift('--headless=new')
  args.push(pageUrl)
  browser = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  let ws = null
  for (let i = 0; i < 200 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((x) => x.type === 'page' && x.url.startsWith(new URL(opts.url).origin))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {
      /* not up */
    }
    if (!ws) await sleep(200)
  }
  if (!ws) throw new Error('Chrome never exposed a debuggable page')

  const sock = new WebSocket(ws)
  await new Promise((r, j) => {
    sock.addEventListener('open', r, { once: true })
    sock.addEventListener('error', () => j(new Error('cdp connect failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (text.startsWith('[capture') || text.startsWith('[compose')) report.captureLog.push(text)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      ?.value
  const evalJson = async (e) => {
    const v = await evaluate(e)
    try {
      return typeof v === 'string' ? JSON.parse(v) : v
    } catch {
      return null
    }
  }

  await sleep(2500)
  if (!(await evaluate(`!!document.querySelector('button[aria-label="Start recording"]')`))) {
    throw new Error('the app did not reach the capture screen')
  }
  // Screen + tab audio + mic: tab audio is the channel Robert names, and the
  // screen is the load that starves it.
  report.chips = await evalJson(`(async () => {
    const want = { Screen: true, 'Tab Audio': true, Mic: true, Camera: false }
    const label = (c) => (c.querySelector('.chip__label')?.textContent ?? c.textContent ?? '').trim()
    const read = () => Object.fromEntries([...document.querySelectorAll('.chip')].map((c) =>
      [label(c), c.getAttribute('aria-pressed') === 'true' || c.classList.contains('chip--on')]))
    for (let i = 0; i < 10; i++) {
      const now = read(); let clicked = false
      for (const [name, on] of Object.entries(want)) {
        const el = [...document.querySelectorAll('.chip')].find((c) => label(c) === name)
        if (el && now[name] !== on && !el.disabled) { el.click(); clicked = true; break }
      }
      if (!clicked) break
      await new Promise((r) => setTimeout(r, 250))
    }
    return JSON.stringify(read())
  })()`)

  await sleep(600)
  const stopLoad = startCpuLoad(opts.load)
  report.cpuLoadProcesses = opts.load
  if (opts.load) console.error(`noise-check: ${opts.load} busy cores for the take`)
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(opts.takeMs + 4000)
  stopLoad()
  await evaluate(
    `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
  )
  for (let i = 0; i < 120; i++) {
    if (await evaluate(`!!document.querySelector('.editor')`)) break
    await sleep(500)
  }
  report.gates.reachedEditor = !!(await evaluate(`!!document.querySelector('.editor')`))
  await sleep(1500)

  // ---- HALF ONE: what capture says is in the file --------------------------
  report.channels = await evalJson(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('inout', 2)
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res, rej) => {
      const r = db.transaction('recordings').objectStore('recordings').getAll()
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!rec) return JSON.stringify(null)
    return JSON.stringify({
      id: rec.id,
      durationMs: Math.round(rec.durationMs),
      channels: rec.channels.map((c) => ({
        kind: c.kind, media: c.media, durationMs: Math.round(c.durationMs),
        paddedMs: c.diagnostics?.paddedMs ?? 0,
        trimmedMs: c.diagnostics?.trimmedMs ?? 0,
        silentTailMs: c.diagnostics?.silentTailMs ?? 0,
        revivals: c.diagnostics?.revivals ?? 0,
      })),
    })
  })()`)

  // ---- HALF ONE-B: WHAT THE PREVIEW DOES TO THE SAME TAKE, TWICE ----------
  /**
   * Defect (A) is the preview correcting itself, and its signature is that it
   * HEALS: the first pass over a region pays a cold decode off OPFS, the
   * element stalls, and `sync` corrects — a hard seek (a click) or a
   * playbackRate slew (the browser's time-stretcher). The second pass is warm
   * and none of it happens. So the measurement is the same seconds played
   * TWICE, and the fix is that the first pass stops differing.
   *
   * Instrumented from OUTSIDE the product: `seeking` events counted per element
   * and playbackRate sampled at 50 ms. Nothing in the app is changed to measure
   * it, so this reads the shipped behaviour and not a version of it built for
   * the rig.
   */
  const INSTALL_PROBE = `(() => {
    const els = [...document.querySelectorAll('video, audio')]
    window.__b2 = { passes: [], els: els.length }
    window.__b2start = (label) => {
      const pass = { label, seeks: 0, samples: 0, maxRateDev: 0, sumRateDev: 0, perEl: [] }
      window.__b2.passes.push(pass)
      // SPLIT BY KIND, and that is not a nicety: the fix changes AUDIO only
      // (video keeps its 25 % slew on purpose — a frame shown early is a
      // frame, not an artefact). Pooling the two made a noisy video lane read
      // as a regression in the audio one, which is what the first version of
      // this probe reported.
      pass.audio = { seeks: 0, samples: 0, maxRateDev: 0, sumRateDev: 0 }
      pass.video = { seeks: 0, samples: 0, maxRateDev: 0, sumRateDev: 0 }
      const bucket = (el) => (el.tagName === 'AUDIO' ? pass.audio : pass.video)
      pass._stop = els.map((el) => {
        const onSeek = () => { pass.seeks++; bucket(el).seeks++ }
        el.addEventListener('seeking', onSeek)
        return () => el.removeEventListener('seeking', onSeek)
      })
      pass._timer = setInterval(() => {
        for (const el of els) {
          if (el.paused) continue
          const dev = Math.abs(el.playbackRate - 1)
          const b = bucket(el)
          pass.samples++; pass.sumRateDev += dev
          b.samples++; b.sumRateDev += dev
          if (dev > pass.maxRateDev) pass.maxRateDev = dev
          if (dev > b.maxRateDev) b.maxRateDev = dev
        }
      }, 50)
      return true
    }
    window.__b2stop = () => {
      const pass = window.__b2.passes[window.__b2.passes.length - 1]
      if (!pass) return false
      clearInterval(pass._timer)
      for (const off of pass._stop) off()
      delete pass._timer; delete pass._stop
      for (const b of [pass, pass.audio, pass.video]) {
        b.meanRateDev = b.samples ? Math.round((b.sumRateDev / b.samples) * 1e5) / 1e5 : 0
        b.maxRateDev = Math.round(b.maxRateDev * 1e5) / 1e5
      }
      return true
    }
    return els.length
  })()`
  report.previewElements = await evaluate(INSTALL_PROBE)
  const playPass = async (label) => {
    await evaluate(`window.__b2start(${JSON.stringify(label)})`)
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/^(play)$/i.test((x.getAttribute('aria-label')||x.textContent||'').trim())); if(b) b.click(); return !!b })()`,
    )
    await sleep(opts.playMs)
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/^(pause)$/i.test((x.getAttribute('aria-label')||x.textContent||'').trim())); if(b) b.click(); return !!b })()`,
    )
    await evaluate(`window.__b2stop()`)
    await sleep(400)
  }
  await playPass('first')
  // Back to the very start, so pass two covers the SAME seconds — a second pass
  // over different material would be measuring the material.
  await evaluate(
    `(() => { const el=document.querySelector('.scrubber input[type=range], input[type=range]'); if(!el) return false
       const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
       set.call(el,'0'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true })()`,
  )
  await sleep(800)
  await playPass('second')
  report.preview = await evalJson(`JSON.stringify(window.__b2)`)

  // ---- HALF TWO: what is ACTUALLY in the exported file ---------------------
  await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
  )
  await sleep(1200)
  await evaluate(
    `(() => { const b=document.querySelector('.quality .btn--primary'); if(!b) return false; b.click(); return true })()`,
  )
  let meta = null
  for (let i = 0; i < 300 && !meta; i++) {
    await sleep(500)
    meta = await evaluate(`document.querySelector('.xp__meta')?.textContent ?? null`)
  }
  report.exportMeta = meta
  report.gates.exported = !!meta
  await sleep(1500)

  // Decode the biggest OPFS mp4 (the export) and count notches in its audio.
  report.exportAudio = await evalJson(`(async () => {
    const countNotches = ${COUNT_NOTCHES};
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('blobs')
    let best = null
    for await (const [name, handle] of dir.entries()) {
      if (!/\\.(mp4|webm)$/.test(name)) continue
      const f = await handle.getFile()
      if (!name.startsWith('xport') && !name.startsWith('exp')) {
        if (!best || f.size > best.size) best = { name, file: f, size: f.size }
      }
    }
    // Prefer an explicit export file when one is present.
    for await (const [name, handle] of dir.entries()) {
      if (!name.startsWith('xport')) continue
      const f = await handle.getFile()
      if (!best || f.size > best.size || best.name.indexOf('xport') !== 0) best = { name, file: f, size: f.size }
    }
    if (!best) return JSON.stringify(null)
    const buf = await best.file.arrayBuffer()
    const ctx = new OfflineAudioContext(1, 1, 48000)
    let decoded
    try { decoded = await ctx.decodeAudioData(buf) } catch (e) { return JSON.stringify({ name: best.name, error: String(e) }) }
    const pcm = decoded.getChannelData(0)
    const notches = countNotches(pcm, decoded.sampleRate)
    let sum = 0
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
    return JSON.stringify({
      name: best.name, bytes: best.size,
      durationSec: Math.round(decoded.duration * 10) / 10,
      sampleRate: decoded.sampleRate,
      rms: Math.round(Math.sqrt(sum / pcm.length) * 1e5) / 1e5,
      notchCount: notches.length,
      notchesPerMinute: Math.round((notches.length / (decoded.duration / 60)) * 10) / 10,
      totalNotchMs: Math.round(notches.reduce((a, n) => a + n.ms, 0) * 10) / 10,
      notches: notches.slice(0, 40),
    })
  })()`)

  const audio = (report.channels?.channels ?? []).filter((c) => c.media === 'audio')
  report.paddedTotalMs = audio.reduce((a, c) => a + c.paddedMs, 0)
  report.padNotchesPerMinute =
    report.channels?.durationMs > 0
      ? Math.round((report.paddedTotalMs / 61 / (report.channels.durationMs / 60000)) * 10) / 10
      : null
  report.gates.measuredAudioChannels = audio.length > 0
  report.gates.decodedExport = !!report.exportAudio && !report.exportAudio.error

  report.verdict =
    report.paddedTotalMs === 0
      ? 'THE FILE IS CLEAN — paddedMs is 0 on every audio channel, so defect (B) did not occur in this take and (A), the preview, is the whole story here.'
      : `paddedMs ${report.paddedTotalMs} ms across ${audio.length} audio channel(s) — defect (B) IS present in this take and is in the FILE.`

  console.log(JSON.stringify(report, null, 2))
  console.error(`noise-check: ${report.verdict}`)
  const failed = Object.entries(report.gates).filter(([, v]) => !v)
  if (failed.length === 0) exitCode = 0
  else console.error(`noise-check: could not measure — ${failed.map(([k]) => k).join(', ')}`)
} catch (err) {
  console.error('noise-check:', err instanceof Error ? err.message : String(err))
  console.log(JSON.stringify(report, null, 2))
} finally {
  try {
    browser?.kill('SIGKILL')
  } catch {
    /* already dead */
  }
  rmSync(profile, { recursive: true, force: true })
  process.exit(exitCode)
}
