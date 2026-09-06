#!/usr/bin/env node
/**
 * PROTO-APP — the proto UI's third tab, GENERATED FROM THE SHIPPING APP.
 *
 * WHY IT IS GENERATED. proto/style.html and proto/neon.html are hand-built
 * mocks: they say what the app COULD look like. The third tab has to say what
 * it DOES look like, and a hand-built copy of the app is a copy that drifts —
 * within a week it is a fourth opinion rather than the control. So this script
 * drives the deployed build, walks it through its real states, and freezes the
 * real DOM and the real stylesheet into proto/app.html. Nothing in that file is
 * drawn by hand; when the app changes, run this again.
 *
 *   node scripts/proto-app.mjs                    # from the live build
 *   node scripts/proto-app.mjs --url=http://localhost:5174
 *   node scripts/proto-app.mjs --headed           # watch it drive
 *
 * WHAT IS FROZEN AND WHAT IS NOT. The snapshots carry the app's own markup, its
 * own classes, its own inline styles and its own stylesheet, so every surface is
 * the shipping one. They do not carry its behaviour: nothing inside the frame
 * reacts to a click, because the app's script is not in the file (proto files
 * are opened off disk with file://, where modules, workers and a service worker
 * are all refused). Switching state is the harness's job, as in the other tabs.
 *
 * THE THREE REWRITES the capture needs, and why each one is forced:
 *   :root / html / body / #root   the app is a div inside a frame here, not the
 *                                 document, so its token block and its page
 *                                 rules are re-hung on .app-proto.
 *   100vh / 100dvh / 100vw        the frame IS the app's viewport in the proto;
 *                                 left alone these read the tool's own window
 *                                 and the stage sizes itself wrong.
 *   <canvas> / <video>            a cloned canvas has no bitmap and a cloned
 *                                 video has no stream, so each is frozen to its
 *                                 own current pixels as a data: URL.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromeRetrying, resolveChrome, quitChrome, removeProfile, sleep } from './lib/chrome.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'proto', 'app.html')
const FRAME = { w: 1040, h: 660 }

/**
 * THE MAIN TAKE IS 14 SECONDS SO ITS TIMELINE HAS SOMETHING TO SHOW — not
 * because short takes are unsafe. Takes made by this rig did come back RED
 * ("screen was requested and never delivered a byte") three times, and that was
 * first written up here as a length threshold; `scripts/shorttake.mjs` then put
 * 17 takes against it — real capture and synthetic, 4 s and 14 s, screen-only
 * and all four inputs — and lost nothing. It is contention, not length. The
 * check below stands either way: a take short of a channel is discarded and
 * recorded again, so an error banner can never be frozen into the proto.
 */
const opts = { url: 'https://inout-kappa.vercel.app', headed: false, take: 14_000, takes: 3 }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--url=')) opts.url = a.slice(6).replace(/\/$/, '')
  else if (a === '--headed') opts.headed = true
  else if (a.startsWith('--take=')) opts.take = Number(a.slice(7))
  // HOW MANY TAKES END UP IN THE LIST. The main screen is the takes list, and a
  // list with one card is not what the screen looks like in use. The extra ones
  // are shorter so the cards differ in length the way real ones do.
  else if (a.startsWith('--takes=')) opts.takes = Number(a.slice(8))
  else {
    console.error(`proto-app: unknown flag ${a}`)
    process.exit(1)
  }
}
const APP = `${opts.url}/?synthetic=1`

/* ---------- the page-side helpers, injected once per load ---------- */
const HELPERS = String.raw`
window.__proto = {
  wait: async (test, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (test()) return true; await new Promise((r) => setTimeout(r, 80)) }
    return false
  },
  /* One state, frozen. The live canvases and videos are read BEFORE the clone,
     because a clone of either is an empty box. */
  snap: () => {
    const root = document.getElementById('root').firstElementChild
    if (!root) return null
    const paint = (el, w, h, draw) => {
      if (!w || !h) return null
      try {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        draw(c.getContext('2d'))
        // photographic frames as jpeg (a 1040x660 png frame is megabytes), flat
        // vector-ish canvases as png so a waveform stays crisp
        const png = c.toDataURL('image/png')
        const jpg = c.toDataURL('image/jpeg', 0.86)
        return png.length <= jpg.length * 1.3 ? png : jpg
      } catch { return null }
    }
    const cans = [...root.querySelectorAll('canvas')].map((c) => paint(c, c.width, c.height, (g) => g.drawImage(c, 0, 0)))
    const vids = [...root.querySelectorAll('video')].map((v) => paint(v, v.videoWidth, v.videoHeight, (g) => g.drawImage(v, 0, 0)))
    /* AND THE IMAGES, because a take card's thumbnail is an <img> on a blob: URL
       (TakesList.tsx) and a blob dies with the page that made it — the first
       main-screen shot had three broken-image boxes where the previews go. Only
       ones that are NOT already data: URLs, and only when they have decoded. */
    const imgs = [...root.querySelectorAll('img')].map((im) =>
      (im.getAttribute('src') || '').startsWith('data:') || !im.naturalWidth
        ? null
        : paint(im, im.naturalWidth, im.naturalHeight, (g) => g.drawImage(im, 0, 0)),
    )
    const clone = root.cloneNode(true)
    const swap = (el, src) => {
      const img = document.createElement('img')
      img.setAttribute('class', el.getAttribute('class') || '')
      const st = el.getAttribute('style')
      if (st) img.setAttribute('style', st)
      if (src) img.setAttribute('src', src)
      img.setAttribute('alt', '')
      el.replaceWith(img)
    }
    ;[...clone.querySelectorAll('canvas')].forEach((c, i) => swap(c, cans[i]))
    ;[...clone.querySelectorAll('video')].forEach((v, i) => swap(v, vids[i]))
    ;[...clone.querySelectorAll('img')].forEach((im, i) => { if (imgs[i]) im.setAttribute('src', imgs[i]) })
    // the export dock is a fixed overlay that may live outside the app root
    const dock = document.querySelector('.xdock')
    const extra = dock && !root.contains(dock) ? dock.outerHTML : ''
    return clone.outerHTML + extra
  },
  /* The stylesheet the build actually serves, rule by rule — cssText normalises
     the minifier's output back into something a selector rewrite can trust. */
  css: () => {
    const out = []
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules && r.conditionText !== undefined) {
          out.push(r.cssText.slice(0, r.cssText.indexOf('{') + 1))
          walk(r.cssRules)
          out.push('}')
        } else out.push(r.cssText)
      }
    }
    for (const s of document.styleSheets) {
      try { walk(s.cssRules) } catch { /* cross-origin sheet */ }
    }
    return out.join('\n')
  },
}
`

/* ---------- the states the app really has ----------
   MAIN IS FIRST AND IT HAS TAKES ON IT. The record screen renders the takes
   list whenever nothing is recording (CaptureScreen.tsx: `{!session && !arming
   && <TakesList />}`), so the empty screen is only ever the first run — landing
   the proto on it showed the app as nobody sees it after their first minute.
   The empty one is kept, as its own state, because a first run is real too. */
const STATES = [
  { id: 'main', label: 'Main', note: 'the record screen as it is after a few takes — the kept takes are on it' },
  { id: 'recording', label: 'Recording', note: 'mid-take, the timer running' },
  { id: 'editor', label: 'Editor', note: 'the take, its timeline and its tools' },
  { id: 'exporting', label: 'Exporting', note: 'the export dock, mid-render' },
  { id: 'saved', label: 'Saved', note: 'the finished file and where it can go' },
  { id: 'firstrun', label: 'First run', note: 'the record screen before anything has been recorded' },
]

const bin = resolveChrome()
if (!bin) {
  console.error('proto-app: no Chrome found (set CHROME_BIN)')
  process.exit(1)
}
const profile = mkdtempSync(join(tmpdir(), 'inout-proto-app-'))
let session = null
const shots = {}
let css = ''
const log = (m) => process.stderr.write(`proto-app: ${m}\n`)

try {
  session = await launchChromeRetrying({ bin, profile, url: APP, headed: opts.headed, scriptsOff: true })
  const { send, evaluate } = session
  await send('Emulation.setDeviceMetricsOverride', { width: FRAME.w, height: FRAME.h, deviceScaleFactor: 1, mobile: false })

  const load = async () => {
    await send('Page.navigate', { url: APP })
    for (let i = 0; i < 200; i++) {
      if ((await evaluate(`location.href !== 'about:blank' && document.readyState`, 5000)) === 'complete') break
      await sleep(100)
    }
    await sleep(1500)
    await evaluate(HELPERS)
    // The install prompt is Chrome's, not the app's, and it only appears on a
    // fresh profile — a snapshot of the harness's browser, not of the app.
    await evaluate(`(() => { const x = document.querySelector('.capture__install-x'); if (x) x.click(); return !!x })()`)
    await sleep(400)
  }

  /* BACK TO THE RECORD SCREEN THE WAY A PERSON GOES BACK, and the middle step is
     the reason a straight click on the chevron never returned: the back button
     opens "Leave this recording?" (EditorScreen.tsx), whose KEEP button is what
     resets to capture with the take kept on disk. Discard would delete it, and
     the takes list is the whole point of the main screen. */
  const backToCapture = async () => {
    await evaluate(`document.querySelector('.transport__back').click()`)
    if (!(await evaluate(`window.__proto.wait(() => !!document.querySelector('.dialog'), 10000)`, 15_000))) {
      throw new Error('the back button did not raise the leave-this-recording dialog')
    }
    await evaluate(`(() => {
      const keep = [...document.querySelectorAll('.dialog__actions button')].find((b) => /keep/i.test(b.textContent || ''))
      if (!keep) throw new Error('no Keep button in the dialog')
      keep.click()
    })()`)
    if (!(await evaluate(`window.__proto.wait(() => !!document.querySelector('.recbtn'), 20000)`, 25_000))) {
      throw new Error('Keep did not return to the record screen')
    }
    await sleep(1200)
  }

  /* ONE TAKE, AND IT HAS TO BE A WHOLE ONE. A take on this rig comes back
     missing its two video channels perhaps one run in four ("screen was
     requested and never delivered a byte"). It did not reproduce in 17 takes
     under a quiet machine (scripts/shorttake.mjs, BACKLOG), so it is contention
     rather than length — but it happens while THIS rig runs, the editor then
     opens on an error banner, and a proto that freezes that is a proto that
     says the app is broken. So every take is checked and, when it is short of a
     channel, thrown away and recorded again. Nothing incomplete is written. */
  const ATTEMPTS = 4
  const recordTake = async (ms) => {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      await evaluate(`document.querySelector('.recbtn').click()`)
      if (!(await evaluate(`window.__proto.wait(() => !!document.querySelector('.recbtn__inner--stop'), 30000)`, 40_000))) {
        throw new Error('the record press never reached a running take')
      }
      await sleep(ms)
      const rolling = await evaluate('window.__proto.snap()')
      await evaluate(`document.querySelector('.recbtn').click()`)
      if (!(await evaluate(`window.__proto.wait(() => !!document.querySelector('.editor'), 60000)`, 70_000))) {
        throw new Error('stop never reached the editor')
      }
      await sleep(2500)
      const missing = await evaluate(`[...document.querySelectorAll('.editor__missing')].map((e) => e.textContent)`)
      if (!missing.length) return { rolling }
      if (attempt === ATTEMPTS) {
        throw new Error(`${ATTEMPTS} takes in a row came back incomplete, so nothing was written:\n  ${missing.join('\n  ')}`)
      }
      log(`  a take came back short of a channel (${missing.join(' ')}) — discarding it and recording another`)
      // Discard, so a broken take never reaches the list the main screen shows.
      await evaluate(`document.querySelector('.transport__back').click()`)
      await evaluate(`window.__proto.wait(() => !!document.querySelector('.dialog'), 10000)`, 15_000)
      await evaluate(`(() => {
        const d = [...document.querySelectorAll('.dialog__actions button')].find((b) => /discard/i.test(b.textContent || ''))
        if (d) d.click()
      })()`)
      await evaluate(`window.__proto.wait(() => !!document.querySelector('.recbtn'), 30000)`, 35_000)
      await sleep(1500)
    }
    throw new Error('unreachable')
  }

  await load()
  css = await evaluate('window.__proto.css()')
  log(`stylesheet: ${(css.length / 1024).toFixed(0)} KB`)
  shots.firstrun = await evaluate('window.__proto.snap()')
  log('first run captured — the record screen with no takes yet')

  /* The filler takes come FIRST and are shorter, so by the time the main take
     is made the list already has cards of different lengths on it — which is
     what the record screen looks like to anyone who has used the app twice. */
  const fillers = Math.max(0, opts.takes - 1)
  for (let i = 0; i < fillers; i++) {
    const ms = 6000 + i * 3000
    await recordTake(ms)
    await backToCapture()
    log(`take ${i + 1} of ${opts.takes} kept (${(ms / 1000).toFixed(0)} s)`)
  }

  /* THE MAIN TAKE — the one the editor, the export and the saved strip are all
     shots of. It is the longest, so its timeline has something to show. */
  const { rolling } = await recordTake(opts.take)
  /* THE PLAYHEAD IS MOVED OFF ZERO BEFORE THE SHOT, and that is not cosmetic
     licence. The editor parks at 0, which is inside the arming hole — the video
     surfaces carry `.is-hidden` there and the stage is black (Player.tsx,
     HEAD_GRACE_MS). A still of that says the app shows nothing. Play, pause a
     couple of seconds in, and the shot is the editor as it is actually used. */
  await evaluate(`document.querySelector('.transport__play').click()`)
  await sleep(2200)
  await evaluate(`(() => { const b = document.querySelector('.transport__play'); if (b && b.getAttribute('aria-label') === 'Pause') b.click() })()`)
  await sleep(900)
  if (await evaluate(`!!document.querySelector('.stage__screen.is-hidden')`)) {
    log('WARNING: the stage is still hidden — the editor shot will be black')
  }
  shots.recording = rolling
  shots.editor = await evaluate('window.__proto.snap()')
  log('recording and editor captured — every channel delivered, playhead off zero')

  /* AN EXPORT THAT ACTUALLY RENDERS, so the Exporting state is not a coin toss.
     At the take's own step the press is served by the at-stop pre-render and is
     over in a frame or two — real, and the reason two runs of this script came
     back with no progress strip at all. A step ABOVE the take is not offered
     (a 1080p take cannot be upscaled, and the higher labels are locked), so the
     lever is a step BELOW: asking for a smaller file is the ordinary reason a
     person changes it, the copy path cannot serve a different geometry, and the
     render that follows is a real render of the real take. The picture does not
     change, so the Exporting and Saved shots stay the same take the Editor shot
     is of. If no other step is offered the press goes in at the default and the
     state is simply absent, as it was. */
  const restep = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('.editor .qs__label')]
    if (!labels.length) return null
    const on = labels.findIndex((l) => l.className.includes('qs__label--on'))
    if (on <= 0) return null
    const pick = labels[on - 1]
    if (!pick || pick.disabled || pick.className.includes('qs__label--locked')) return null
    pick.click()
    return (pick.textContent || '').trim().split('~')[0]
  })()`)
  if (restep) {
    await sleep(1200)
    log(`export asked for ${restep}, a step below the take — so the press renders instead of being served by the pre-render`)
  }

  // the export control, found by its own text rather than a class that moves
  const pressed = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^\\s*export\\b/i.test(x.textContent || ''))
    if (!b) return false
    b.click()
    return true
  })()`)
  if (!pressed) log('WARNING: no Export button found — exporting and saved will be missing')
  else {
    /* THE PROGRESS STRIP IS CAUGHT FROM INSIDE THE PAGE, not polled from here.
       The take is pre-rendered at stop, so the export can be over in a frame or
       two; a driver that polls over CDP every 80 ms and then sleeps 600 ms
       before reading has already missed it, which is how the first run of this
       came back with no Exporting state at all. This watches every animation
       frame and takes the shot the instant the strip exists. */
    shots.exporting = await evaluate(
      `(async () => {
        const t0 = performance.now()
        while (performance.now() - t0 < 30000) {
          if (document.querySelector('.xstrip--progress')) return window.__proto.snap()
          if (document.querySelector('.xstrip--saved')) return null
          await new Promise(requestAnimationFrame)
        }
        return null
      })()`,
      40_000,
    )
    if (shots.exporting) log('exporting captured')
    else log('the export never showed a progress strip — the pre-render made it instant')
    if (await evaluate(`window.__proto.wait(() => !!document.querySelector('.xstrip--saved'), 180000)`, 190_000)) {
      await sleep(500)
      shots.saved = await evaluate('window.__proto.snap()')
      log('saved captured')
    } else log('WARNING: the export never finished')
  }

  /* AND FINALLY THE MAIN SCREEN, which is only itself once there are takes on
     it. Every take made above is kept, so this is the record screen carrying
     the real cards — the state the app is in every time it is opened after the
     first. It is captured LAST because it needs the takes to exist. */
  await backToCapture()
  const cards = await evaluate(`document.querySelectorAll('.takecard').length`)
  if (!cards) throw new Error('the record screen came back with no take cards on it, so the main shot would be the empty one')
  // The thumbnails are decoded per card after the list mounts; snapping before
  // they land freezes three empty boxes.
  const thumbs = await evaluate(
    `window.__proto.wait(() => {
      const t = [...document.querySelectorAll('.takecard__thumb img')]
      return t.length >= ${cards} && t.every((i) => i.complete && i.naturalWidth > 0)
    }, 20000)`,
    25_000,
  )
  if (!thumbs) log('WARNING: not every take card decoded a thumbnail — some previews will be empty')
  // The export strip is a real surface but it belongs to the SAVED shot; left
  // up, the main screen reads as the moment after an export rather than as the
  // screen the app opens on. Dismiss it the way its own × does.
  await evaluate(`document.querySelectorAll('.xstrip__x').forEach((b) => b.click())`)
  await sleep(700)
  shots.main = await evaluate('window.__proto.snap()')
  log(`main captured — the record screen with ${cards} take card(s) on it${thumbs ? ', thumbnails decoded' : ''}`)
} finally {
  if (session) {
    try { await quitChrome(session) } catch { /* already gone */ }
  }
  removeProfile(profile)
}

const got = STATES.filter((s) => shots[s.id])
if (!got.length) {
  console.error('proto-app: nothing captured')
  process.exit(1)
}

/* ---------- rewrite 1 and 2: re-hang the page rules, un-anchor the viewport ---------- */
function rehang(cssText) {
  return cssText
    .split('\n')
    .map((line) => {
      const brace = line.indexOf('{')
      if (brace <= 0 || line.startsWith('@')) return line
      const sel = line
        .slice(0, brace)
        .split(',')
        .map((s) => s.trim())
        .map((s) => s.replace(/(^|[\s>+~])(:root|html|body|#root)\b/g, (_m, pre) => `${pre}.app-proto`))
        .map((s) => s.replace(/\.app-proto(\s+\.app-proto)+/g, '.app-proto'))
        .join(', ')
      return sel + line.slice(brace)
    })
    .join('\n')
    .replace(/\b100(?:d|s|l)?vh\b/g, 'var(--app-h)')
    .replace(/\b100vw\b/g, 'var(--app-w)')
}

const esc = (s) => s.replace(/<\/script>/gi, '<\\/script>')

function readTemplate() {
  const tabs = got
    .map(
      (s, i) =>
        `        <button class="tab" role="tab" data-tab="${s.id}" aria-selected="${i === 0}" title="${s.note}">${s.label}<kbd>${i + 1}</kbd></button>`,
    )
    .join('\n')
  const notes = got.map((s) => `  ${s.id}: ${JSON.stringify(s.note)},`).join('\n')
  const snaps = got.map((s) => `  ${s.id}: ${JSON.stringify(shots[s.id])},`).join('\n')
  // every replacement is a FUNCTION: a `$&` or `$1` in the captured stylesheet
  // or in a snapshot is text, not a pattern, and string replacements read them.
  const stamp = `${APP} · ${new Date().toISOString().slice(0, 10)}`
  return TEMPLATE.replace('/*STATE_TABS*/', () => tabs)
    .replace('/*STATE_NOTES*/', () => notes)
    .replace('/*APP_CSS*/', () => rehang(css))
    .replace('/*SNAPSHOTS*/', () => esc(snaps))
    .replace(/\/\*STAMP\*\//g, () => stamp)
    .replace(/\/\*FRAME_W\*\//g, () => String(FRAME.w))
    .replace(/\/\*FRAME_H\*\//g, () => String(FRAME.h))
}

/* ---------- the file itself: the same harness the other two tabs wear ---------- */
const TEMPLATE = String.raw`<!doctype html>
<html lang="en" data-frame="desktop">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>INOUT — the app</title>
<!--
  THE APP — the proto UI's third tab, and the control the other two are judged
  against. GENERATED, NEVER EDITED BY HAND: every byte below the harness came
  out of the shipping build at /*STAMP*/ — its DOM, its inline styles and its
  own stylesheet, captured by scripts/proto-app.mjs. Edit that script, run it,
  and this file is rewritten. A hand edit here is a lie about what ships.

  Self-contained and opened off disk with file://, like proto/style.html and
  proto/neon.html: no <script src>, no <link>, no fetch, no modules, no external
  assets — the frames of video are data: URLs. The app's own script is NOT here,
  so nothing inside the frame reacts to a press; the Screen tabs on the left
  switch between the real states instead, exactly as the other two tabs do.
-->
<style>
/* ==========================================================================
   0. HARNESS CHROME — the tool, not the app. Copied verbatim from
   proto/style.html so the three tabs are one tool with one shell.
   squeeze-panels (org lib): side panels that take REAL width, centre shrinks.
   ========================================================================== */
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body {
  background: #141416;
  color: #d8d8dc;
  font: 13px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
select { font: inherit; }
a { color: inherit; text-decoration: none; }

:root { --ease-h: cubic-bezier(0.22, 1, 0.36, 1); --dur: 0.34s; --fw: 0px; --dw: 0px; }
body.f { --fw: 228px; }
body.d { --dw: 268px; }

.cluster { width: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.row { flex: 1; min-height: 0; display: flex; align-items: stretch; }
.col { min-height: 0; overflow: hidden; }
.col-list { flex: 1; min-width: 0; }
.col-filters { width: var(--fw); flex: none; transition: width var(--dur) var(--ease-h); }
.col-detail { width: var(--dw); flex: none; transition: width var(--dur) var(--ease-h); }
.col-filters .panel { width: 228px; }
.col-detail .panel { width: 268px; }
/* the app has a .panel of its own, so every harness panel rule is scoped to its column */
:is(.col-filters, .col-detail) .panel {
  height: 100%; overflow-y: auto; opacity: 0; transition: opacity 0.2s var(--ease-h);
  background: #101012; padding: 14px 14px 20px;
}
.col-filters .panel { border-right: 1px solid #232327; }
.col-detail .panel { border-left: 1px solid #232327; }
body.f .filters, body.d .detail { opacity: 1; }

.panel__title { font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: #6a6a74; white-space: nowrap; margin-bottom: 12px; }
.panel__title em { font-style: normal; color: #d8d8dc; }
.panel__group { margin-bottom: 18px; }
.panel__label { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: #55555e; margin-bottom: 6px; }
:is(.col-filters, .col-detail) .panel :is(select, .btn-h) {
  width: 100%; background: #17171a; color: #d8d8dc; border: 1px solid #2b2b31;
  border-radius: 6px; padding: 6px 8px; font: inherit; text-align: left;
}
:is(.col-filters, .col-detail) .panel .btn-h { text-align: center; cursor: pointer; }
:is(.col-filters, .col-detail) .panel .btn-h:hover { background: #212126; color: #fff; }
.tab {
  display: block; width: 100%; text-align: left; padding: 7px 10px; border-radius: 6px;
  color: #85858f; font-size: 12px; transition: background 120ms, color 120ms;
}
.tab:hover { color: #d8d8dc; background: #17171a; }
.tab[aria-selected='true'] { background: #2b2b31; color: #fff; }
.tab kbd { float: right; font: 10px/1.5 ui-monospace, monospace; color: #55555e; }
.readout { font: 11px/1.5 ui-monospace, monospace; color: #55555e; white-space: pre-line; }
.note { font: 11px/1.5 ui-monospace, monospace; color: #6a6a74; }

/* edge handles — the only chrome left when both panels are shut */
.edge {
  position: absolute; top: 50%; z-index: 20; width: 16px; height: 54px;
  transform: translateY(-50%); display: grid; place-items: center;
  background: #1b1b20; border: 1px solid #2b2b31; color: #85858f; font-size: 10px;
  transition: background 140ms, color 140ms;
}
.edge:hover { background: #2b2b31; color: #fff; }
.edge--l { left: 0; border-left: none; border-radius: 0 8px 8px 0; }
.edge--r { right: 0; border-right: none; border-radius: 8px 0 0 8px; }

.zonebar { flex: none; display: flex; align-items: center; gap: 10px; font: 11px/1 ui-monospace, monospace; color: #6a6a74; }
.zonebar select { background: #17171a; color: #d8d8dc; border: 1px solid #2b2b31; border-radius: 6px; padding: 4px 7px; font: inherit; }
.zonebar__size { color: #d8d8dc; }
.zonebar__hint { color: #4b4b54; }

.canvas {
  position: relative; height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; padding: 18px 24px 24px;
  overflow: hidden;
  background: repeating-conic-gradient(#141416 0% 25%, #17171a 0% 50%) 50% / 22px 22px;
}
/* The frame keeps its true pixel size and is scaled to fit, so the app is always
   judged at the size it will really have. */
.slot { position: relative; flex: none; }
.frame {
  position: absolute; top: 0; left: 0; transform-origin: top left; overflow: hidden;
  border-radius: 14px; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
}
[data-frame='phone'] .frame { border-radius: 36px; }
/* the app's own viewport: every 100vh/100dvh/100vw in its stylesheet reads these */
.app-proto {
  position: relative; width: 100%; height: 100%; overflow: hidden;
  --app-w: /*FRAME_W*/px;
  --app-h: /*FRAME_H*/px;
}
.app-proto img { display: block; }

/* ==========================================================================
   1. THE APP'S OWN STYLESHEET — captured from /*STAMP*/, with :root, html,
   body and #root re-hung on .app-proto and the viewport units pointed at the
   frame. Nothing else is touched.
   ========================================================================== */
/*APP_CSS*/
</style>
</head>
<body>

<div class="cluster">
 <div class="row">

  <div class="col col-filters">
    <aside class="panel filters">
      <div class="panel__title"><em>INOUT</em> proto</div>
      <div class="panel__group" role="tablist" aria-label="Prototype">
        <div class="panel__label">Proto</div>
        <a class="tab" role="tab" href="style.html" aria-selected="false">Style &#8599;</a>
        <a class="tab" role="tab" href="neon.html" aria-selected="false">Neon &#8599;</a>
        <button class="tab" role="tab" aria-selected="true">App</button>
      </div>
      <div class="panel__group" role="tablist" id="tabs">
        <div class="panel__label">Screen</div>
/*STATE_TABS*/
      </div>
      <div class="panel__group">
        <div class="panel__label">What you are looking at</div>
        <div class="note" id="note"></div>
      </div>
      <div class="panel__group">
        <div class="panel__label">Keys</div>
        <div class="readout">1&#8211;5  screen
F    frame
[ ]  panels</div>
      </div>
    </aside>
  </div>

  <div class="col col-list">
    <main class="canvas" id="canvas">
      <button class="edge edge--l" id="tgl-l" aria-label="Toggle left panel">&#9704;</button>
      <button class="edge edge--r" id="tgl-r" aria-label="Toggle right panel">&#9705;</button>

      <div class="zonebar">
        <select id="frame">
          <option value="desktop">desktop</option>
          <option value="wide">wide</option>
          <option value="laptop">laptop</option>
          <option value="phone">phone</option>
        </select>
        <span class="zonebar__size" id="zsize">/*FRAME_W*/ &#215; /*FRAME_H*/</span>
        <span class="zonebar__hint" id="zfit">100%</span>
      </div>

      <div class="slot" id="slot"><div class="frame" id="frameEl"><div class="app-proto" id="app"></div></div></div>
    </main>
  </div>

  <div class="col col-detail">
    <aside class="panel detail">
      <div class="panel__title">The app</div>
      <div class="panel__group">
        <div class="panel__label">What this tab is</div>
        <div class="note">The shipping app, frozen. Its markup, its inline styles and its own
stylesheet, captured from the deployed build &#8212; not a drawing of it.

Captured /*STAMP*/.

Nothing inside the frame reacts to a press: the app&#8217;s script is not in this file.
Switch state on the left.</div>
      </div>
      <div class="panel__group">
        <div class="panel__label">Refresh it</div>
        <div class="readout">node scripts/proto-app.mjs</div>
      </div>
    </aside>
  </div>

 </div>
</div>

<script>
const $ = (s) => document.querySelector(s)
const SIZES = { desktop: [/*FRAME_W*/, /*FRAME_H*/], wide: [1440, 900], laptop: [820, 520], phone: [390, 800] }
const SNAP = {
/*SNAPSHOTS*/
}
const NOTE = {
/*STATE_NOTES*/
}
const IDS = Object.keys(SNAP)
const S = { id: IDS[0], frame: 'desktop' }

function show(id) {
  if (!SNAP[id]) return
  S.id = id
  $('#app').innerHTML = SNAP[id]
  $('#note').textContent = NOTE[id] || ''
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === id)))
  save()
}

function fit() {
  const [w, h] = SIZES[S.frame]
  const box = $('#canvas').getBoundingClientRect()
  // never negative: a collapsed pane must not flip or zero the frame. 76 = padding + zone bar.
  const s = Math.min(1, Math.max(120, box.width - 48) / w, Math.max(120, box.height - 76) / h)
  const f = $('#frameEl')
  f.style.width = w + 'px'
  f.style.height = h + 'px'
  f.style.transform = 'scale(' + s + ')'
  $('#slot').style.width = w * s + 'px'
  $('#slot').style.height = h * s + 'px'
  // the app's stylesheet reads these two for every 100vh/100vw it had
  f.style.setProperty('--app-w', w + 'px')
  f.style.setProperty('--app-h', h + 'px')
  $('#zsize').textContent = w + ' × ' + h
  $('#zfit').textContent = Math.round(s * 100) + '%'
  document.documentElement.dataset.frame = S.frame
}
addEventListener('resize', fit)
new ResizeObserver(fit).observe($('#canvas')) // keeps the fit honest while a panel slides

$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')
  if (t) show(t.dataset.tab)
})
$('#frame').addEventListener('change', (e) => { S.frame = e.target.value; fit(); save() })

/* panels: squeeze-panels' whole JS contract is body.classList.toggle('f' | 'd') */
const togglePanel = (c) => { document.body.classList.toggle(c); save() }
$('#tgl-l').addEventListener('click', () => togglePanel('f'))
$('#tgl-r').addEventListener('click', () => togglePanel('d'))

addEventListener('keydown', (e) => {
  if (['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
  const n = Number(e.key)
  if (n >= 1 && n <= IDS.length) show(IDS[n - 1])
  else if (e.key === 'f' || e.key === 'F') {
    const k = Object.keys(SIZES)
    S.frame = k[(k.indexOf(S.frame) + 1) % k.length]
    $('#frame').value = S.frame
    fit()
    save()
  } else if (e.key === '[') togglePanel('f')
  else if (e.key === ']') togglePanel('d')
})

/* remember every choice: the fragment first, storage second — a file:// origin
   is allowed to refuse localStorage outright, the fragment survives everywhere */
const STORE = 'inout-proto/app/v1'
function save() {
  const z = (document.body.classList.contains('f') ? 'f' : '') + (document.body.classList.contains('d') ? 'd' : '')
  const s = 'p=' + S.id + '&f=' + S.frame + '&z=' + (z || '-')
  let wrote = false
  try { history.replaceState(null, '', '#' + s); wrote = true } catch (err) { /* try the next one */ }
  if (!wrote) { try { location.hash = s } catch (err) { /* nowhere left to write */ } }
  try { localStorage.setItem(STORE, s) } catch (err) { /* storage refused */ }
}
function restore() {
  let raw = ''
  try { raw = decodeURIComponent(location.hash.slice(1)) } catch (err) { raw = '' }
  if (!raw) { try { raw = localStorage.getItem(STORE) || '' } catch (err) { raw = '' } }
  if (!raw) return
  const st = {}
  raw.split('&').forEach((pair) => { const i = pair.indexOf('='); if (i > 0) st[pair.slice(0, i)] = pair.slice(i + 1) })
  if (SNAP[st.p]) S.id = st.p
  if (SIZES[st.f]) S.frame = st.f
  if (st.z) {
    document.body.classList.toggle('f', st.z.indexOf('f') >= 0)
    document.body.classList.toggle('d', st.z.indexOf('d') >= 0)
  }
}

document.body.classList.add('f', 'd')
restore()
$('#frame').value = S.frame
show(S.id)
fit()
</script>
</body>
</html>
`

const page = readTemplate()
writeFileSync(OUT, page, 'utf8')
log(`wrote ${OUT} — ${(page.length / 1024).toFixed(0)} KB, ${got.length} states: ${got.map((x) => x.id).join(', ')}`)
