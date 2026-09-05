#!/usr/bin/env node
/**
 * SHORTTAKE — DOES A SHORT TAKE LOSE ITS RAW VIDEO CHANNEL, AND IS IT THE
 * PRODUCT OR THE RIG?
 *
 * The observation (2026-09-05, building proto/app.html): a 3.6 s `?synthetic=1`
 * take on prod grades RED — "screen was requested and never delivered a byte" —
 * and the editor opens on "Missing from this take: Screen, Camera", while the
 * same drive at 13.7 s grades GREEN. Every failing run also carries `a recorder
 * did not stop in budget ... stop timed out after 5000ms`, which is a stop-path
 * signature, not an acquisition one. Robert's question is the only one that
 * decides whether it matters: **does a REAL four-second take lose video too?**
 *
 * A synthetic source cannot answer it. The synthetic screen is a canvas the
 * harness paints, so a short synthetic take is measuring the rig as much as the
 * product (BACKLOG's own standing warning about `?synthetic=1` as an
 * instrument). So this runs both, at the same lengths, with the same chips, and
 * prints them side by side — the synthetic lane is the CONTROL that says
 * whether the real lane's answer is about length or about the rig.
 *
 *   node scripts/shorttake.mjs                        # both lanes, 4 s and 14 s, 3 each
 *   node scripts/shorttake.mjs --lanes=real --n=5
 *   node scripts/shorttake.mjs --lengths=2000,4000,8000,14000 --n=2
 *
 * THE REAL LANE CAPTURES A TAB, NOT THE SCREEN, and that is the only real
 * capture this machine can drive unattended: a whole-screen share hangs on the
 * macOS system picker for the full 30 s, or is refused by the OS in 641 ms with
 * ScreenCaptureKit disabled (measured 2026-09-03, fps-check.mjs's header). Tab
 * capture is a different TCC surface, needs no grant, is answered by a switch
 * Chrome still honours, and is the case Robert reports anyway. Same product
 * path either way: a real getDisplayMedia, no canvas this rig paints.
 *
 * WHICH INPUTS, AND WHY IT TURNED OUT TO BE THE AXIS. The first sweep ran
 * SCREEN ONLY in both lanes and came back 12 of 12 green at 4 s and 14 s — so
 * length alone does not lose a channel. The observation was an ALL FOUR take:
 * two video encoders plus two audio channels ("encoder plan — 2 encoder(s):
 * camera 640x480@30 + screen 1280x720@30"). `--chips=all` records that.
 * The real lane can only offer screen: the camera needs a permission grant a
 * throwaway profile cannot give, and the real mic on this machine is AirPods
 * over Bluetooth, measured at a 122 s arm timeout that would eat the take.
 *
 * HEADED, ALWAYS. Headless Chrome has no GPU here: the raw channel's WebCodecs
 * path times out and falls back to MediaRecorder, which is a different encoder
 * answering a different question — and the encoder's stop is the suspect.
 *
 * Exit 0 when it measured; the verdict is the table, not the code.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, resolveChrome, quitChrome, removeProfile, sleep } from './lib/chrome.mjs'

const PROD = 'https://inout-kappa.vercel.app/'

/** The tab the real lane captures: a title the auto-select switch matches on,
 *  and content that MOVES every frame so the source has frames to give. */
const TAB_TITLE = 'inout-capture-target'
const MOVING_TAB =
  'data:text/html,' +
  encodeURIComponent(
    `<title>${TAB_TITLE}</title><style>html,body{margin:0;height:100%;background:#111;overflow:hidden}` +
      `#b{position:absolute;width:18vw;height:18vw;border-radius:50%;background:#4af}</style>` +
      `<div id=b></div><script>const b=document.getElementById('b');let n=0;` +
      `function f(t){n++;b.style.transform='translate('+(50+45*Math.sin(t/300))+'vw,'+(40+35*Math.cos(t/370))+'vh)';` +
      `b.style.background='hsl('+(n*3%360)+',80%,60%)';requestAnimationFrame(f)}requestAnimationFrame(f)<\/script>`,
  )

const opts = { url: PROD, lanes: ['real', 'synthetic'], lengths: [4000, 14_000], n: 3, chips: 'screen', viewport: null }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--url=')) opts.url = a.slice(6)
  else if (a.startsWith('--lanes=')) opts.lanes = a.slice(8).split(',')
  else if (a.startsWith('--lengths=')) opts.lengths = a.slice(10).split(',').map(Number)
  else if (a.startsWith('--n=')) opts.n = Number(a.slice(4))
  // WHICH INPUTS ARE ON, because the first sweep showed length is not the axis.
  // Screen-only came back 12 of 12 green at both lengths in both lanes, while
  // the original observation was an ALL FOUR take: two video encoders plus two
  // audio channels ("encoder plan — 2 encoder(s): camera 640x480@30 + screen
  // 1280x720@30"). `--chips=all` is the configuration that actually failed.
  // The real lane can only offer `screen` — the camera needs a permission grant
  // a throwaway profile has not got, and the real mic here arms in 122 s.
  else if (a.startsWith('--chips=')) opts.chips = a.slice(8)
  // THE VIEWPORT THE OBSERVATION WAS MADE THROUGH. proto-app.mjs drives the app
  // with Emulation.setDeviceMetricsOverride at 1040x660 (the proto's frame), and
  // that is the last difference between the rig that saw channels vanish and
  // this one, which has not. `--viewport=1040x660` puts it back.
  else if (a.startsWith('--viewport=')) {
    const [w, h] = a.slice(11).split('x').map(Number)
    if (w > 0 && h > 0) opts.viewport = { w, h }
  }
  else {
    console.error(`shorttake: unknown flag ${a}`)
    process.exit(1)
  }
}

const log = (m) => process.stdout.write(`${m}\n`)
const bin = resolveChrome()
if (!bin) {
  console.error('shorttake: no Chrome found (set CHROME_BIN)')
  process.exit(1)
}

/* ---------- the page-side drive ---------- */
const HELPERS = String.raw`
window.__st = {
  wait: async (test, ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (test()) return true; await new Promise((r) => setTimeout(r, 60)) }
    return false
  },
  /* Screen only, both lanes: the camera needs a grant a throwaway profile has
     not got, and the real mic on this machine arms in 122 s. */
  chips: async (which) => {
    const want =
      which === 'all'
        ? { Screen: true, Camera: true, Mic: true, 'Tab Audio': true }
        : which === 'screen+camera'
          ? { Screen: true, Camera: true, Mic: false, 'Tab Audio': false }
          : { Screen: true, Camera: false, Mic: false, 'Tab Audio': false }
    const name = (b) => b.getAttribute('title') || b.textContent.trim()
    const read = () => {
      const out = {}
      for (const b of document.querySelectorAll('.chips button')) out[name(b)] = b.getAttribute('aria-pressed') === 'true'
      return out
    }
    for (let i = 0; i < 8; i++) {
      const now = read()
      let clicked = false
      for (const b of document.querySelectorAll('.chips button')) {
        const k = name(b)
        if (!(k in want) || now[k] === want[k] || b.disabled) continue
        b.click()
        clicked = true
        break
      }
      if (!clicked) break
      await new Promise((r) => setTimeout(r, 250))
    }
    return read()
  },
  /* What the take says about itself: the card's own channels verdict, and the
     stored record's missing list — the field the editor's banner is built from.
     (No backticks in these comments: they live INSIDE a template literal and
     one would end the string. fps-check.mjs learned the same thing.) */
  verdict: async () => {
    const out = { missing: null, channels: null, verdict: null, durationMs: null, chan: null }
    try {
      const card = typeof __inoutReport === 'function' ? await __inoutReport() : null
      if (card) {
        out.verdict = card.verdict
        const d = (card.dimensions ?? []).find((x) => x.id === 'channels')
        if (d) out.channels = d.status + (d.detail ? ' — ' + d.detail : '')
      }
    } catch (e) { out.channels = 'card threw: ' + e }
    try {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('inout')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const all = await new Promise((res, rej) => {
        const r = db.transaction('recordings').objectStore('recordings').getAll()
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0]
      if (rec) {
        out.missing = rec.missing ?? []
        out.durationMs = rec.durationMs
        out.chan = rec.channels.map((c) => c.kind + ':' + Math.round(c.durationMs) + 'ms')
      }
    } catch (e) { out.missing = ['read failed: ' + e] }
    return out
  },
}
`

/**
 * ONE TAKE, ONE CHROME, AND THAT IS THE MEASUREMENT DESIGN, not a workaround.
 *
 * Reusing a profile across takes was tried first and does not survive its own
 * second run: a reload after a take lands in the EDITOR (the app reopens the
 * take it has), and the app's own "Back to capture" did not return within 15 s
 * when it was clicked from automation. More importantly, a second take is made
 * against a profile that has already measured this machine's encoder, so the
 * takes in a run would not be comparable to each other — and comparability
 * across lengths is the entire question. A fresh profile per take makes every
 * cell the SAME case (a first take, cold), so a difference between cells is a
 * difference in length and nothing else. It is also exactly the condition the
 * original observation was made under.
 */
async function oneTake(lane, ms) {
  const real = lane === 'real'
  const appUrl = real ? opts.url : `${opts.url}?synthetic=1`
  const profile = mkdtempSync(join(tmpdir(), `inout-shorttake-${lane}-`))
  let session = null
  try {
    session = await launchChromeRetrying({
      bin,
      profile,
      url: 'about:blank',
      headed: true,
      scriptsOff: true,
      extraArgs: real
        ? [
            // Chrome's own automation hook for the picker. Without it
            // getDisplayMedia opens a dialog nothing can answer and the take
            // never arms. ONE spelling only — a repeated switch is last-wins.
            `--auto-select-tab-capture-source-by-title=${TAB_TITLE}`,
            '--auto-accept-this-tab-capture',
          ]
        : [],
    })
    const { send, evaluate, consoleLines } = session
    if (opts.viewport) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: opts.viewport.w,
        height: opts.viewport.h,
        deviceScaleFactor: 1,
        mobile: false,
      })
    }
    if (real) {
      // The captured tab must EXIST before the record press; it stays in the
      // background, where a captured tab keeps rendering because it is captured.
      await send('Target.createTarget', { url: MOVING_TAB, background: true })
      await sleep(800)
    }
    await send('Page.navigate', { url: appUrl })
    for (let k = 0; k < 200; k++) {
      if ((await evaluate(`document.readyState`, 5000)) === 'complete') break
      await sleep(100)
    }
    await send('Page.bringToFront').catch(() => undefined)
    await sleep(2500)
    await evaluate(HELPERS)
    const chips = await evaluate(`window.__st.chips(${JSON.stringify(opts.chips)})`)
    if (!chips || chips.Screen !== true) {
      const where = await evaluate(
        `(() => { const r = document.getElementById('root'); return r ? r.innerHTML.replace(/\\s+/g, ' ').slice(0, 400) : 'no root' })()`,
      )
      return { lane, ms, lost: null, note: `never reached screen-only — showing: ${where}` }
    }

    await evaluate(`document.querySelector('.recbtn').click()`)
    if (!(await evaluate(`window.__st.wait(() => !!document.querySelector('.recbtn__inner--stop'), 40000)`, 50_000))) {
      return { lane, ms, lost: null, note: 'never armed' }
    }
    await sleep(ms)
    await evaluate(`document.querySelector('.recbtn').click()`)
    if (!(await evaluate(`window.__st.wait(() => !!document.querySelector('.editor'), 90000)`, 100_000))) {
      return { lane, ms, lost: null, note: 'never reached the editor' }
    }
    await sleep(2500)
    const v = await evaluate('window.__st.verdict()')
    const banner = await evaluate(`[...document.querySelectorAll('.editor__missing')].map((e) => e.textContent).join(' | ')`)
    // the stop-path signature the observation came with
    const stopWarn = consoleLines.some((l) => l.includes('did not stop in budget'))
    /* A TAKE FAR SHORTER THAN THE PRESS IS NOT A MEASUREMENT OF LENGTH. The
       first run of this rig reported a 4000 ms press as a 1 ms take and called
       it green — which would have answered the question with a number about the
       rig. A take under half what was asked is invalid and prints the capture
       log, because the reason it is short is the only interesting thing left. */
    const tooShort = typeof v.durationMs === 'number' && v.durationMs < ms * 0.5
    const lost = (v.missing ?? []).length > 0
    const logLines = tooShort || lost
      ? consoleLines.filter((x) => /capture|arming|take report|recorder|getDisplayMedia|Error/i.test(x)).map((x) => x.slice(0, 240))
      : []
    return { lane, ms, lost: tooShort ? null : lost, missing: v.missing, verdict: v.verdict, channels: v.channels, chan: v.chan, dur: v.durationMs, stopWarn, banner, tooShort, logLines, note: tooShort ? `the take is ${v.durationMs} ms` : null }
  } finally {
    if (session) {
      try { await quitChrome(session) } catch { /* already gone */ }
    }
    removeProfile(profile)
  }
}

async function runLane(lane, lengths, n) {
  const rows = []
  for (const ms of lengths) {
    for (let i = 1; i <= n; i++) {
      /* A DEAD RENDERER IS A ROW, NOT THE END OF THE SWEEP. One 14 s all-four
         cell closed its CDP connection mid-take and took the whole run with it,
         losing the cells that had already passed. A crash is itself a finding
         about a take this size, so it is recorded and the sweep goes on. */
      let r
      try {
        r = await oneTake(lane, ms)
      } catch (err) {
        r = { lane, ms, lost: null, note: `the run died: ${err.message}` }
      }
      rows.push(r)
      log(
        `  ${lane} ${ms} ms #${i}: ` +
          (r.lost === null
            ? `INVALID — ${r.note}`
            : r.lost
              ? `LOST ${r.missing.join('+')}`
              : 'kept every channel') +
          ` · card ${r.verdict ?? '?'} · take ${r.dur ?? '?'} ms · ${(r.chan ?? []).join(' ')}` +
          (r.stopWarn ? ' · STOP-BUDGET WARNING' : ''),
      )
      if (r.banner) log(`      banner: ${r.banner}`)
      for (const l of r.logLines ?? []) log(`      ${l}`)
    }
  }
  return rows
}

const all = []
for (const lane of opts.lanes) {
  log(`\n== ${lane} lane ==${lane === 'real' ? '  (real getDisplayMedia of a tab, screen only)' : '  (?synthetic=1, screen only — the control)'}`)
  all.push(...(await runLane(lane, opts.lengths, opts.n)))
}

log(`\n== how often a take lost a video channel (inputs: ${opts.chips}) ==`)
log('lane        length     lost / takes   stop-budget warnings')
for (const lane of opts.lanes) {
  for (const ms of opts.lengths) {
    const cell = all.filter((r) => r.lane === lane && r.ms === ms && r.lost !== null)
    const lost = cell.filter((r) => r.lost).length
    const warn = cell.filter((r) => r.stopWarn).length
    log(`${lane.padEnd(11)} ${String(ms + ' ms').padEnd(10)} ${String(lost + ' / ' + cell.length).padEnd(14)} ${warn}`)
  }
}
const realRows = all.filter((r) => r.lane === 'real' && r.lost !== null)
if (realRows.length) {
  const shortReal = realRows.filter((r) => r.ms === Math.min(...opts.lengths))
  const lostShort = shortReal.filter((r) => r.lost).length
  log(
    `\nANSWER — a REAL ${Math.min(...opts.lengths)} ms take lost a video channel in ${lostShort} of ${shortReal.length} runs.`,
  )
}
