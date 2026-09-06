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
 *   node scripts/proto-app.mjs                    # capture from the live build
 *   node scripts/proto-app.mjs --rebuild          # design change only: ~1 s, records nothing
 *   node scripts/proto-app.mjs --url=http://localhost:5174
 *   node scripts/proto-app.mjs --headed           # watch it drive
 *
 * CAPTURE ONCE, REBUILD OFTEN. The capture is the slow half — three real takes,
 * an export, minutes of a headed Chrome on the screen — and none of it changes
 * when the edit is to proto/app-design.css or proto/app-design.js. So every
 * capture is cached in proto/.app-capture.json and `--rebuild` writes the page
 * again from it in about a second. Re-recording to try a font size is waste,
 * and it is waste the person watching the screen has to sit through.
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
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromeRetrying, resolveChrome, quitChrome, removeProfile, sleep } from './lib/chrome.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/* TWO FILES OUT OF ONE CAPTURE (Robert, 2026-09-06: "as it ships make as
   separate fourth proto"). app.html is the proposal — the design layer applied
   over the frozen markup — and ships.html is the same capture with no layer at
   all, so the control is a tab of its own rather than a switch inside the
   proposal. Neither is hand-edited; both are rewritten by --rebuild. */
const OUT = join(HERE, '..', 'proto', 'app.html')
const OUT_SHIPS = join(HERE, '..', 'proto', 'ships.html')
const FRAME = { w: 1040, h: 660 }
const CACHE = join(HERE, '..', 'proto', '.app-capture.json')
const DESIGN_CSS = join(HERE, '..', 'proto', 'app-design.css')
const DESIGN_JS = join(HERE, '..', 'proto', 'app-design.js')
const SIM_JS = join(HERE, '..', 'proto', 'app-sim.js')
const NEON = join(HERE, '..', 'proto', 'neon.html')

/**
 * THE FONT AND THE GLYPHS COME OUT OF proto/neon.html, NOT OUT OF A SECOND COPY.
 * Robert asked for the neon prototype's type and icons on the app proto's chips.
 * Two embedded Barlow faces are ~30 KB of base64 each; committing them twice
 * would mean two things to keep in step, and the second one silently going
 * stale. So they are lifted at generation time from the file that owns them,
 * along with the icon sprite the <use href="#i-..."> references need.
 * Barlow Condensed is OFL 1.1 — the notice is in neon.html's header, and it
 * rides along with these bytes.
 */
function borrowFromNeon() {
  const neon = readFileSync(NEON, 'utf8')
  const faces = neon.match(/@font-face \{ font-family: 'Barlow Condensed';[^\n]*\n/g)
  if (!faces || faces.length < 2) throw new Error('proto-app: could not find the Barlow faces in proto/neon.html')
  const open = neon.indexOf('<svg hidden')
  const close = neon.indexOf('</svg>', open)
  if (open < 0 || close < 0) throw new Error('proto-app: could not find the icon sprite in proto/neon.html')
  return { faces: faces.join(''), sprite: neon.slice(open, close + 6) }
}

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
const opts = { url: 'https://inout-kappa.vercel.app', headed: false, take: 14_000, takes: 3, rebuild: false }
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--url=')) opts.url = a.slice(6).replace(/\/$/, '')
  else if (a === '--headed') opts.headed = true
  else if (a.startsWith('--take=')) opts.take = Number(a.slice(7))
  // HOW MANY TAKES END UP IN THE LIST. The main screen is the takes list, and a
  // list with one card is not what the screen looks like in use. The extra ones
  // are shorter so the cards differ in length the way real ones do.
  else if (a.startsWith('--takes=')) opts.takes = Number(a.slice(8))
  /* REBUILD WITHOUT RECORDING ANYTHING. The capture is the slow half — three
     real takes, an export, a headed Chrome on screen for minutes — and it does
     not change when the only edit is to proto/app-design.css or .js. Every
     capture is cached beside the proto, so a design iteration is a file read
     and a write, about a second. Use it for anything that is not a question
     about the app's own markup; a plain run still drives the live build. */
  else if (a === '--rebuild') opts.rebuild = true
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

const shots = {}
let css = ''
let room = null
let capturedAt = null
const log = (m) => process.stderr.write(`proto-app: ${m}\n`)

if (opts.rebuild) {
  if (!existsSync(CACHE)) {
    console.error('proto-app: --rebuild needs a cached capture, and there is none. Run it once without --rebuild.')
    process.exit(1)
  }
  const c = JSON.parse(readFileSync(CACHE, 'utf8'))
  Object.assign(shots, c.shots)
  css = c.css
  room = c.room
  capturedAt = c.capturedAt
  log(`rebuilt from the capture of ${capturedAt} — nothing was recorded`)
}

const bin = opts.rebuild ? null : resolveChrome()
if (!opts.rebuild && !bin) {
  console.error('proto-app: no Chrome found (set CHROME_BIN)')
  process.exit(1)
}
const profile = opts.rebuild ? null : mkdtempSync(join(tmpdir(), 'inout-proto-app-'))
let session = null

if (!opts.rebuild) try {
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
  /* THE CARD'S CLOCK IS ONLY A CLOCK — the app prints "08:24" because the take
     is from today. The proposed card shows the whole date, and that is data the
     frozen DOM does not carry, so it is stamped on from each take's OWN record
     rather than invented. Cards and records are both newest-first, so they zip. */
  const stamped = await evaluate(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('inout')
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res, rej) => {
      const r = db.transaction('recordings').objectStore('recordings').getAll()
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const recs = all.sort((a, b) => b.createdAt - a.createdAt)
    const cards = [...document.querySelectorAll('.takecard .takecard__when')]
    const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    cards.forEach((el, i) => { if (recs[i]) el.dataset.whenFull = fmt.format(new Date(recs[i].createdAt)) })
    return cards.length
  })()`)
  log(`stamped the full date onto ${stamped} card(s)`)
  /* And the real room left where these takes are kept — the proposed bar is a
     measurement, not a drawing of one. */
  room = await evaluate(`(async () => {
    try { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 } } catch { return null }
  })()`)
  if (room) log(`storage: ${(room.usage / 1e6).toFixed(0)} MB used of ${(room.quota / 1e9).toFixed(1)} GB`)
  shots.main = await evaluate('window.__proto.snap()')
  log(`main captured — the record screen with ${cards} take card(s) on it${thumbs ? ', thumbnails decoded' : ''}`)
} finally {
  if (session) {
    try { await quitChrome(session) } catch { /* already gone */ }
  }
  if (profile) removeProfile(profile)
}

if (!opts.rebuild) {
  capturedAt = new Date().toISOString()
  writeFileSync(CACHE, JSON.stringify({ capturedAt, url: APP, css, room, shots }), 'utf8')
  log(`capture cached — next design change rebuilds with --rebuild, no recording`)
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

function readTemplate(design) {
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
  const stamp = `${APP} · ${(capturedAt || new Date().toISOString()).slice(0, 10)}`
  const neon = borrowFromNeon()
  const designCss = design ? readFileSync(DESIGN_CSS, 'utf8') : ''
  const designJs = design ? readFileSync(DESIGN_JS, 'utf8') : ''
  const protoTabs = design
    ? `        <button class="tab" role="tab" aria-selected="true">App new UI</button>
        <a class="tab" role="tab" href="ships.html" aria-selected="false">As it ships &#8599;</a>`
    : `        <a class="tab" role="tab" href="app.html" aria-selected="false">App new UI &#8599;</a>
        <button class="tab" role="tab" aria-selected="true">As it ships</button>`
  const what = design
    ? `The shipping app with the PROPOSED design over it. Every surface below the layer
is the real one &#8212; the app&#8217;s own markup, inline styles and stylesheet, captured
from the deployed build. The layer changes type, geometry and the takes bar; it
changes no colour.

Captured /*STAMP*/.

The control is the &#8220;As it ships&#8221; tab: the same capture, no layer.`
    : `The shipping app, frozen, with NOTHING added. Its markup, its inline styles and
its own stylesheet, captured from the deployed build &#8212; not a drawing of it, and
not the proposal. This is the control the other tabs are judged against.

Captured /*STAMP*/.`
  const designPanel = design
    ? `      <div class="panel__group">
        <div class="panel__label">The layer</div>
        <div class="note">Chips in the neon type and glyphs, the length on the picture, a
card stripped to date &#183; size &#183; inputs, a rebuilt takes bar and a segmented
quality rail. Colours are the app&#8217;s own, untouched.</div>
      </div>`
    : ''
  const simJs = readFileSync(SIM_JS, 'utf8')
  return TEMPLATE.replace('/*SIM_JS*/', () => esc(simJs))
    .replace('/*PROTO_TABS*/', () => protoTabs)
    .replace('/*WHAT*/', () => what)
    .replace('/*DESIGN_PANEL*/', () => designPanel)
    .replace('/*NEON_FACES*/', () => neon.faces)
    .replace('/*NEON_SPRITE*/', () => neon.sprite)
    .replace('/*DESIGN_CSS*/', () => designCss)
    .replace('/*DESIGN_JS*/', () => esc(designJs))
    .replace('/*ROOM*/', () => JSON.stringify(room))
    .replace('/*STATE_TABS*/', () => tabs)
    .replace('/*STATE_NOTES*/', () => notes)
    .replace('/*APP_CSS*/', () => rehang(css))
    .replace('/*SNAPSHOTS*/', () => esc(snaps))
    .replace(/\/\*STAMP\*\//g, () => stamp)
    .replace(/\/\*FRAME_W\*\//g, () => String(FRAME.w))
    .replace(/\/\*FRAME_H\*\//g, () => String(FRAME.h))
}

/* ---------- the file itself: the same harness the other tabs wear ----------
   NO BACKTICKS BELOW THIS LINE, in code OR in a comment: the whole page is one
   String.raw template literal and a stray backtick ends it. It has cost three
   runs; when a comment wants to quote a CSS property, write its name in words. */
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
/* the borrowed icon sprite is <svg hidden>, and the UA's [hidden] rule is
   namespaced to HTML — an SVG element ignores it, so the sprite lays out a
   blank band and pushes the whole tool down the page. Same bug, same fix, as
   proto/neon.html. */
svg[hidden] { display: none; }

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

/* capture-studio__resize, copied verbatim from proto/style.html (which lifted it
   from inout copy 2) — 44px corner hit target, corner-weighted glow, three-dot
   grip, aqua on hover / white while dragging. It sits on .slot (the scaled box)
   so the grip keeps its size at any zoom. All three protos carry the same one:
   Robert, 2026-09-06, "all three protos must share same ui of testing". */
.fresize {
  position: absolute; right: 0; bottom: 0; width: 44px; height: 44px;
  padding: 0; margin: 0; border: none;
  border-radius: 10px 0 var(--corner, 14px) 0;
  z-index: 60; cursor: nwse-resize; touch-action: none;
  -webkit-tap-highlight-color: transparent;
  background: radial-gradient(ellipse 115% 115% at 100% 100%, rgba(95, 255, 212, 0.14) 0%, rgba(120, 200, 255, 0.06) 42%, transparent 68%);
  opacity: 0.5;
  transition: opacity 0.2s var(--ease-h), background 0.22s ease, transform 0.2s var(--ease-h);
}
.fresize:hover:not(.fresize--dragging), .fresize:focus-visible:not(.fresize--dragging) {
  opacity: 0.92;
  background: radial-gradient(ellipse 115% 115% at 100% 100%, rgba(80, 220, 255, 0.28) 0%, rgba(120, 175, 255, 0.16) 46%, transparent 74%);
  outline: none;
}
.fresize:active, .fresize--dragging {
  opacity: 1; transition-duration: 0.1s;
  background: radial-gradient(ellipse 115% 115% at 100% 100%, rgba(255, 255, 255, 0.42) 0%, rgba(235, 242, 255, 0.2) 48%, transparent 78%);
}
.fresize::after {
  content: ''; position: absolute; right: 10px; bottom: 10px;
  width: 3.5px; height: 3.5px; border-radius: 50%;
  background: rgba(230, 245, 255, 0.92);
  box-shadow: -5px 0 0 0 rgba(230, 245, 255, 0.72), 0 -5px 0 0 rgba(230, 245, 255, 0.52);
  pointer-events: none;
  transition: transform 0.2s var(--ease-h), opacity 0.2s ease;
}
.fresize:hover::after, .fresize:focus-visible::after { transform: scale(1.08); }
.fresize--dragging::after { opacity: 1; transition: none; animation: resizeDotsBreathe 1.15s ease-in-out infinite; }
@keyframes resizeDotsBreathe {
  0%, 100% { opacity: 0.82; transform: scale(1.06); }
  50% { opacity: 1; transform: scale(1.13); }
}
.zonebar__step { border: 1px solid #2b2b31; border-radius: 5px; padding: 3px 7px; color: #85858f; font: inherit; }
.zonebar__step:hover { background: #212126; color: #fff; }
/* the app's own viewport: every 100vh/100dvh/100vw in its stylesheet reads these */
.app-proto {
  position: relative; width: 100%; height: 100%; overflow: hidden;
  --app-w: /*FRAME_W*/px;
  --app-h: /*FRAME_H*/px;
}
.app-proto img { display: block; }
/* THE "1 changed" PILL IS THE HARNESS'S OWN FOOTPRINT, NOT THE APP'S. The app
   draws it because the capture ran with ?synthetic=1, which is one switch off
   its default — true of this capture and of no user's session. Hidden in both
   tabs, like the install prompt the capture dismisses, so a screenshot of the
   proto is a screenshot of the product. */
.app-proto .swline { display: none !important; }

/* THE TAKE LIST SCROLLS INSIDE THE FRAME. The proto's frame is a fixed size, so
   a list long enough to be worth testing would otherwise run off the bottom of
   it with no way to reach the end. This is the proto's own affordance, in both
   tabs, so "add a take" until it overflows is a thing you can actually do. */
.app-proto .takes__list { overflow-y: auto; max-height: calc(var(--app-h) * 0.46); scrollbar-width: thin; }
/* the list is a flex column, so a max-height made every card SHRINK to fit and
   swallow its own second and third lines — the kinds and the action row were in
   the DOM the whole time, just clipped. Cards keep their height; the list scrolls. */
.app-proto .takes__list > * { flex: none; }
/* An author's own display rule beats the UA's [hidden] rule — the same trap the
   <svg hidden> sprite set. The app styles .takes as a flex column, so hiding it
   for the empty state has to say so louder. */
.app-proto .takes[hidden] { display: none !important; }

/* Barlow Condensed 600/700, lifted from proto/neon.html so the two protos share
   one copy of the faces. SIL Open Font License 1.1 — Copyright 2017 The Barlow
   Project Authors (https://github.com/jpt/barlow), http://scripts.sil.org/OFL */
/*NEON_FACES*/

/* ==========================================================================
   1. THE APP'S OWN STYLESHEET — captured from /*STAMP*/, with :root, html,
   body and #root re-hung on .app-proto and the viewport units pointed at the
   frame. Nothing else is touched.
   ========================================================================== */
/*APP_CSS*/
</style>
<style id="dz">
/*DESIGN_CSS*/
</style>
</head>
<body>

<!-- the icon sprite, lifted from proto/neon.html with the faces above -->
/*NEON_SPRITE*/

<div class="cluster">
 <div class="row">

  <div class="col col-filters">
    <aside class="panel filters">
      <div class="panel__title"><em>INOUT</em> proto</div>
      <div class="panel__group" role="tablist" aria-label="Prototype">
        <div class="panel__label">Proto</div>
        <a class="tab" role="tab" href="style.html" aria-selected="false">Style &#8599;</a>
        <a class="tab" role="tab" href="neon.html" aria-selected="false">Neon &#8599;</a>
/*PROTO_TABS*/
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
        <div class="panel__label">Simulate inputs</div>
        <div id="sim-inputs"></div>
      </div>
      <div class="panel__group">
        <div class="panel__label">Takes</div>
        <div class="rowbtns">
          <button class="btn-h" id="takeAdd">+ take</button>
          <button class="btn-h" id="takeDel">&#8722; take</button>
        </div>
        <button class="btn-h" id="takeNone" style="margin-top:6px">Empty &#8212; nothing kept</button>
        <div class="readout" id="takeN" style="margin-top:6px"></div>
      </div>
      <div class="panel__group">
        <div class="panel__label">Account</div>
        <select id="simAcct">
          <option value="out">signed out</option>
          <option value="in">signed in</option>
        </select>
      </div>
      <div class="panel__group">
        <div class="panel__label">On the editor</div>
        <select id="simLost">
          <option value="none">nothing went wrong</option>
          <option value="screen">screen never connected</option>
          <option value="camera">camera never connected</option>
          <option value="mic">mic never connected</option>
          <option value="tab audio">tab audio never connected</option>
          <option value="stalled">a source froze mid-take</option>
        </select>
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
        <button class="zonebar__step" id="zfill">fill</button>
        <span class="zonebar__hint">drag the corner</span>
      </div>

      <div class="slot" id="slot">
        <button class="fresize" id="resize" aria-label="Resize the screen zone — double-click for min or max"></button>
        <div class="frame" id="frameEl"><div class="app-proto" id="app"></div></div>
      </div>
    </main>
  </div>

  <div class="col col-detail">
    <aside class="panel detail">
      <div class="panel__title">The app</div>
      <div class="panel__group">
        <div class="panel__label">What this tab is</div>
        <div class="note">/*WHAT*/</div>
      </div>
/*DESIGN_PANEL*/
      <div class="panel__group">
        <div class="panel__label">Refresh it</div>
        <div class="readout">node scripts/proto-app.mjs</div>
      </div>
    </aside>
  </div>

 </div>
</div>

<script>
window.PROTO_ROOM = /*ROOM*/
/* What the panel is simulating right now. Read by app-sim.js, which is in BOTH
   tabs, so the shipping tab is drivable too. */
window.PROTO_SIM = { inputs: { screen: 'ok', camera: 'ok', mic: 'ok', 'tab audio': 'ok' }, on: {}, takes: null, account: 'out', lost: 'none' }
/*SIM_JS*/
/*DESIGN_JS*/
</script>

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

/* The proposal is applied to the markup each time a state is injected. In
   ships.html there is no layer inlined at all, so this is a no-op there and the
   control is the file rather than a switch inside the proposal. */
function paint() {
  if (window.applySim) window.applySim($('#app'), window.PROTO_SIM)
  if (window.applyDesign) window.applyDesign($('#app'))
  const n = $('#app').querySelectorAll('.takecard').length
  const takesEl = $('#app').querySelector('.takes')
  $('#takeN').textContent = !takesEl || takesEl.hidden
    ? 'empty — nothing kept'
    : n + (n === 1 ? ' take in the list' : ' takes in the list')
}
/* one way back in for anything that changes the simulation */
window.protoRefresh = () => { show(S.id) }

const KINDS = ['screen', 'camera', 'mic', 'tab audio']
function buildSim() {
  $('#sim-inputs').innerHTML = KINDS.map(
    (k) =>
      '<div class="perm"><label>' + (k === 'tab audio' ? 'sound' : k) + '</label>' +
      '<select data-input="' + k + '"><option value="ok">ok</option>' +
      '<option value="denied">denied</option><option value="unavailable">unavailable</option></select></div>',
  ).join('')
  for (const sel of document.querySelectorAll('[data-input]')) {
    sel.value = window.PROTO_SIM.inputs[sel.dataset.input] || 'ok'
    sel.addEventListener('change', () => {
      window.PROTO_SIM.inputs[sel.dataset.input] = sel.value
      show(S.id)
      save()
    })
  }
  const nowTakes = () => $('#app').querySelectorAll('.takecard').length
  $('#takeAdd').addEventListener('click', () => { window.PROTO_SIM.takes = nowTakes() + 1; show(S.id); save() })
  $('#takeDel').addEventListener('click', () => { window.PROTO_SIM.takes = Math.max(0, nowTakes() - 1); show(S.id); save() })
  $('#takeNone').addEventListener('click', () => { window.PROTO_SIM.takes = 0; show(S.id); save() })
  $('#simAcct').value = window.PROTO_SIM.account
  $('#simAcct').addEventListener('change', (e) => { window.PROTO_SIM.account = e.target.value; show(S.id); save() })
  $('#simLost').value = window.PROTO_SIM.lost
  $('#simLost').addEventListener('change', (e) => { window.PROTO_SIM.lost = e.target.value; show(S.id); save() })
}
function show(id) {
  if (!SNAP[id]) return
  S.id = id
  $('#app').innerHTML = SNAP[id]
  paint()
  $('#note').textContent = NOTE[id] || ''
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === id)))
  save()
}

/* The screen zone is DRAGGABLE, the same one the other two protos have — one
   tool, one way of testing (Robert, 2026-09-06). Frame presets set the size;
   the corner grip and the fill button change it from there. (No backticks in
   this comment: it lives inside a template literal.) */
const MIN_W = 320, MIN_H = 260, MAX_W = 3840, MAX_H = 2400
let FRAME_W = SIZES.desktop[0], FRAME_H = SIZES.desktop[1], SCALE = 1
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
function fitBox() {
  const box = $('#canvas').getBoundingClientRect()
  // never negative: a collapsed pane must not flip or zero the frame. 76 = padding + zone bar.
  return { w: Math.max(120, box.width - 48), h: Math.max(120, box.height - 76) }
}
function fit() {
  const { w, h } = fitBox()
  const s = Math.min(1, w / FRAME_W, h / FRAME_H)
  SCALE = s
  const f = $('#frameEl')
  f.style.width = FRAME_W + 'px'
  f.style.height = FRAME_H + 'px'
  f.style.transform = 'scale(' + s + ')'
  $('#slot').style.width = FRAME_W * s + 'px'
  $('#slot').style.height = FRAME_H * s + 'px'
  // the grip's corner must match the screen's rounding as drawn, i.e. scaled
  const r = document.documentElement.dataset.frame === 'phone' ? 36 : 14
  $('#slot').style.setProperty('--corner', (r * s).toFixed(1) + 'px')
  // the app's stylesheet reads these two for every 100vh/100vw it had
  f.style.setProperty('--app-w', FRAME_W + 'px')
  f.style.setProperty('--app-h', FRAME_H + 'px')
  $('#zsize').textContent = FRAME_W + ' × ' + FRAME_H
  $('#zfit').textContent = Math.round(s * 100) + '%'
}

/* corner grip — capture-studio__resize's drag, copied from proto/style.html.
   Scale is snapshotted at pointerdown because the frame rescales as it grows,
   and reading it per move fights the drag. */
const grip = $('#resize')
let gripId = null, gx = 0, gy = 0, gw = 0, gh = 0, gs = 1, gRaf = null, gPend = null
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  gripId = e.pointerId
  gx = e.clientX; gy = e.clientY
  gw = FRAME_W; gh = FRAME_H; gs = SCALE || 1
  grip.classList.add('fresize--dragging')
  try { grip.setPointerCapture(e.pointerId) } catch (err) { /* synthetic pointer */ }
})
grip.addEventListener('pointermove', (e) => {
  if (e.pointerId !== gripId) return
  gPend = [
    clamp(Math.round(gw + (e.clientX - gx) / gs), MIN_W, MAX_W),
    clamp(Math.round(gh + (e.clientY - gy) / gs), MIN_H, MAX_H),
  ]
  if (gRaf != null) return
  gRaf = requestAnimationFrame(() => {
    gRaf = null
    if (!gPend) return
    FRAME_W = gPend[0]; FRAME_H = gPend[1]
    gPend = null
    fit(); save()
  })
})
function endGrip(e) {
  if (gripId == null || e.pointerId !== gripId) return
  gripId = null
  grip.classList.remove('fresize--dragging')
  try { grip.releasePointerCapture(e.pointerId) } catch (err) { /* already released */ }
}
grip.addEventListener('pointerup', endGrip)
grip.addEventListener('pointercancel', endGrip)
function fillZone() {
  const { w, h } = fitBox()
  FRAME_W = clamp(Math.round(w), MIN_W, MAX_W)
  FRAME_H = clamp(Math.round(h), MIN_H, MAX_H)
  fit(); save()
}
grip.addEventListener('dblclick', (e) => {
  e.preventDefault()
  const { w } = fitBox()
  if (FRAME_W > (MIN_W + w) / 2) { FRAME_W = MIN_W; FRAME_H = MIN_H; fit(); save() }
  else fillZone()
})
$('#zfill').addEventListener('click', fillZone)
addEventListener('resize', fit)
new ResizeObserver(fit).observe($('#canvas')) // keeps the fit honest while a panel slides

$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]')
  if (t) show(t.dataset.tab)
})
$('#frame').addEventListener('change', (e) => {
  S.frame = e.target.value
  document.documentElement.dataset.frame = S.frame
  FRAME_W = SIZES[S.frame][0]; FRAME_H = SIZES[S.frame][1]
  fit(); save()
})

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
    document.documentElement.dataset.frame = S.frame
    FRAME_W = SIZES[S.frame][0]; FRAME_H = SIZES[S.frame][1]
    fit(); save()
  } else if (e.key === '[') togglePanel('f')
  else if (e.key === ']') togglePanel('d')
})

/* remember every choice: the fragment first, storage second — a file:// origin
   is allowed to refuse localStorage outright, the fragment survives everywhere */
const STORE = 'inout-proto/app/v1'
function save() {
  const z = (document.body.classList.contains('f') ? 'f' : '') + (document.body.classList.contains('d') ? 'd' : '')
  const sim = window.PROTO_SIM
  const s = 'p=' + S.id + '&f=' + S.frame + '&w=' + FRAME_W + 'x' + FRAME_H + '&z=' + (z || '-') +
    '&a=' + KINDS.map((k) => sim.inputs[k]).join(',') +
    '&n=' + (sim.takes == null ? '-' : sim.takes) + '&acc=' + sim.account + '&l=' + encodeURIComponent(sim.lost)
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
  if (SIZES[st.f]) { S.frame = st.f; FRAME_W = SIZES[st.f][0]; FRAME_H = SIZES[st.f][1] }
  if (st.w) {
    const wh = st.w.split('x').map(Number)
    if (wh.length === 2 && wh.every((n) => n > 0)) { FRAME_W = clamp(wh[0], MIN_W, MAX_W); FRAME_H = clamp(wh[1], MIN_H, MAX_H) }
  }
  if (st.z) {
    document.body.classList.toggle('f', st.z.indexOf('f') >= 0)
    document.body.classList.toggle('d', st.z.indexOf('d') >= 0)
  }
  if (st.a) st.a.split(',').forEach((v, i) => {
    if (KINDS[i] && ['ok', 'denied', 'unavailable'].includes(v)) window.PROTO_SIM.inputs[KINDS[i]] = v
  })
  if (st.n === '-') window.PROTO_SIM.takes = null
  else if (st.n !== undefined && !isNaN(+st.n)) window.PROTO_SIM.takes = +st.n
  if (st.acc === 'in' || st.acc === 'out') window.PROTO_SIM.account = st.acc
  if (st.l) window.PROTO_SIM.lost = decodeURIComponent(st.l)
}

document.body.classList.add('f', 'd')
restore()
$('#frame').value = S.frame
document.documentElement.dataset.frame = S.frame
buildSim()
show(S.id)
fit()
</script>
</body>
</html>
`

for (const [file, design] of [[OUT, true], [OUT_SHIPS, false]]) {
  const page = readTemplate(design)
  writeFileSync(file, page, 'utf8')
  log(`wrote ${file} — ${(page.length / 1024).toFixed(0)} KB, ${got.length} states: ${got.map((x) => x.id).join(', ')}`)
}
