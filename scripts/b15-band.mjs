#!/usr/bin/env node
/**
 * B15 — DOES THE BAND ACTUALLY APPEAR? End to end, on prod, in a real browser.
 *
 * The engine half is proved by `npm run exp -- tabaudio --keep-audio` (the live
 * detector fired at +18.06 s after 10.008 s of zeros and cleared 186 ms after
 * the sound came back). This proves the rest of the chain — measuredAudio →
 * session → CaptureScreen — by reading the SCREEN: a real take of a real tab
 * that really goes quiet, and the sentence the user would be looking at.
 *
 *   node scripts/b15-band.mjs            # ~70 s, headed, makes a sound
 *
 * The captured tab is ours and is answered by title, which is the only tab
 * capture a switch can select; the app is the deployed build. HEARD → SILENT →
 * HEARD, and the band must appear in the middle stretch and be gone by the end.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchChrome, removeProfile, resolveChrome, sleep } from './lib/chrome.mjs'

const PROD = 'https://inout-kappa.vercel.app/'
const TAB_TITLE = 'INOUT B15 TONE'
const START = `document.querySelector('button[aria-label="Start recording"]')`
const STOP = `document.querySelector('button[aria-label="Stop recording"]')`
/** The band the user would be reading. Empty string when there is none. */
const BAND = `(document.querySelector('.capture__stalled')?.textContent ?? '').trim()`

const TONE_PAGE = (
    `<title>${TAB_TITLE}</title><body style="background:#111"><script>
    const c = new AudioContext()
    const g = c.createGain(); g.gain.value = 0.06; g.connect(c.destination)
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 440; o.connect(g); o.start()
    // The page paints, so the captured tab is not a still frame.
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 360
    document.body.appendChild(cv)
    const x = cv.getContext('2d'); let t = 0
    setInterval(() => { t += 8; x.fillStyle = '#000'; x.fillRect(0,0,640,360)
      x.fillStyle = '#0f0'; x.fillRect((t % 640), 0, 80, 360) }, 33)
    window.__tone = (on) => { g.gain.setValueAtTime(on ? 0.06 : 0, c.currentTime); return g.gain.value }
    </script></body>`
  )

const bin = resolveChrome()
if (!bin) {
  console.error('b15-band: no Chrome found')
  process.exit(2)
}
const profile = mkdtempSync(join(tmpdir(), `inout-b15band-${process.pid}-`))
const marks = []
const mark = (m) => {
  marks.push({ atMs: Math.round(performance.now() - t0), what: m })
  console.log(`  +${((performance.now() - t0) / 1000).toFixed(1)}s ${m}`)
}
let t0 = performance.now()
let sess = null
let tone = null
try {
  sess = await launchChrome({
    bin,
    profile,
    url: PROD,
    headed: true,
    muteAudio: false, // the whole cell is about sound; muted, it is vacuous
    extraArgs: [
      // Both switches, as memory-slope's tab lane does: the tab-specific one is
      // newer and is what actually answers a tab pick on current Chrome, and an
      // unknown switch is ignored.
      `--auto-select-desktop-capture-source=${TAB_TITLE}`,
      `--auto-select-tab-capture-source-by-title=${TAB_TITLE}`,
      '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=InfiniteSessionRestore,ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac',
    ],
  })
  t0 = performance.now()

  // The tone tab must exist and have its title up before the press: the switch
  // matches by title, and a tab that is not there yet matches nothing.
  // A file, not a data: URL — the tab lane that is known to work uses one, and
  // a data: tab is not a page Chrome's picker offers the same way.
  const tonePath = join(profile, 'b15-tone.html')
  writeFileSync(tonePath, TONE_PAGE)
  const created = await sess.send('Target.createTarget', {
    url: pathToFileURL(tonePath).href,
    background: true,
  })
  const list = await (await fetch(`http://127.0.0.1:${sess.port}/json/list`)).json()
  const t = list.find((x) => x.id === created.targetId)
  if (!t) throw new Error('tone tab never appeared in the target list')
  tone = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    tone.addEventListener('open', res, { once: true })
    tone.addEventListener('error', () => rej(new Error('tone tab cdp failed')), { once: true })
  })
  let seq = 0
  const toneEval = (expr) =>
    new Promise((res, rej) => {
      const id = ++seq
      const on = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id !== id) return
        tone.removeEventListener('message', on)
        m.error ? rej(new Error(m.error.message)) : res(m.result?.result?.value)
      }
      tone.addEventListener('message', on)
      tone.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
      setTimeout(() => rej(new Error('tone tab eval timed out')), 10_000)
    })
  await sleep(1500)
  mark('tone tab up and sounding')

  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    ready = !!(await sess.evaluate(`!!${START}`))
    if (!ready) await sleep(500)
  }
  if (!ready) throw new Error('the app never reached the capture screen')
  // Camera and mic OFF: the only audio channel in this take must be the one
  // whose source we control, and a real device would also want a permission
  // prompt no switch here answers.
  /**
   * CAMERA AND MIC OFF THROUGH THE PREFS, NOT THE CHIPS. The only audio channel
   * in this take must be the one whose source this rig controls, and a real
   * camera in a throwaway profile has no permission and hangs the arm on
   * `camera start` forever (measured: three runs, no take at all). The chips are
   * the user's route and toggling them from CDP proved unreliable; the stored
   * prefs are the same setting one layer down, read at boot.
   */
  await sess.evaluate(
    `(() => { localStorage.setItem('inout.capture.prefs', JSON.stringify({ screen: true, camera: false, mic: false, systemAudio: true })); return 1 })()`,
  )
  await sess.send('Page.reload', { ignoreCache: false })
  for (let i = 0; i < 60; i++) {
    if (await sess.evaluate(`!!${START}`).catch(() => false)) break
    await sleep(500)
  }
  mark(`chips: ${await sess.evaluate(
    `[...document.querySelectorAll('.chip')].map((c) => (c.title || '') + '=' + c.getAttribute('aria-pressed')).join(' ')`,
  )}`)
  await sess.evaluate(`(() => { ${START}.click(); return 1 })()`)
  mark('record pressed')
  await sleep(3000)
  mark(`recording=${await sess.evaluate(`!!${STOP}`)}`)
  await sleep(7000)
  const heardBand = await sess.evaluate(BAND)
  mark(`sound has been recorded for 10s — band is ${heardBand ? `"${heardBand}"` : 'absent (correct)'}`)

  mark(`tone gain before silencing: ${await toneEval('window.__tone(true), document.title')}`)
  mark(`silencing → gain now ${await toneEval('window.__tone(false)')}`)
  const silencedAt = performance.now()
  mark('TONE SILENCED — the captured tab now makes no sound at all')

  let appearedMs = null
  let text = ''
  for (let i = 0; i < 40 && appearedMs === null; i++) {
    await sleep(1000)
    text = await sess.evaluate(BAND)
    if (text) appearedMs = Math.round(performance.now() - silencedAt)
    if (i % 5 === 4) mark(`  …${i + 1}s silent, band=${text ? 'YES' : 'no'}`)
  }
  if (appearedMs === null) mark('NO BAND after 40s of silence — FAIL')
  else mark(`BAND APPEARED ${(appearedMs / 1000).toFixed(1)}s after the sound stopped: "${text}"`)

  await toneEval('window.__tone(true)')
  const restoredAt = performance.now()
  mark('tone restored')
  let clearedMs = null
  for (let i = 0; i < 20 && clearedMs === null; i++) {
    await sleep(500)
    if (!(await sess.evaluate(BAND))) clearedMs = Math.round(performance.now() - restoredAt)
  }
  mark(clearedMs === null ? 'BAND NEVER CLEARED — FAIL' : `band cleared ${(clearedMs / 1000).toFixed(1)}s after sound returned`)

  await sess.evaluate(`(() => { const b = ${STOP}; if (b) b.click(); return 1 })()`)
  await sleep(6000)
  const card = await sess.evaluate(
    `(async () => { const r = window.__inoutReport ? await window.__inoutReport() : null; return r ? r.line : null })()`,
    30_000,
  )
  console.log('\ncard:', card)
  const ok = appearedMs !== null && clearedMs !== null
  console.log(`\nb15-band: ${ok ? 'PASS' : 'FAIL'} — appeared=${appearedMs}ms cleared=${clearedMs}ms`)
  console.log(JSON.stringify({ marks, appearedMs, clearedMs, card }, null, 2))
  console.log('\nconsole (all):')
  for (const l of sess.consoleLines.slice(-60)) console.log('  ', l)
  process.exitCode = ok ? 0 : 1
} finally {
  try { tone?.close() } catch { /* gone */ }
  try { sess?.kill() } catch { /* gone */ }
  await sleep(800)
  removeProfile(profile)
}
