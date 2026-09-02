#!/usr/bin/env node
/**
 * H2 — THE CRASH-LOSS BOUND: kill it anywhere, and how much is gone?
 *
 * Salvage exists (`core/capture/recovery.ts`) and has never been priced. This
 * states the price: SIGKILL real Chrome mid-take at a sampled instant, relaunch
 * it on the SAME profile, let the product's own boot recovery run, and read how
 * far behind the crash the salvaged take ends.
 *
 * WHY A REAL SIGKILL AND NOT A SIMULATION. Everything the bound depends on sits
 * outside the page: whether OPFS keeps bytes a SyncAccessHandle flushed, whether
 * localStorage kept the pending manifest the whole salvage hangs off, and
 * whether a fragmented MP4 whose last fragment never closed still demuxes. A
 * rig that terminates a worker (src/experimental/recovery) answers none of the
 * three. `kill -9` on Chrome's whole process group answers all three at once,
 * and it is the harshest crash short of pulling the power.
 *
 * THE GROUND TRUTH IS THE DRIVER'S CLOCK, not the page's. The page dies with
 * nothing to say, so the two instants that define the loss are both taken here:
 *   startWall  the value Date.now() returned in the page as the click landed
 *   killWall   the value Date.now() returned here as SIGKILL was sent
 * and the loss is (killWall - startWall) - the salvaged take's own durationMs.
 * `recording.createdAt` is NOT used as the epoch, and that is deliberate: the
 * manifest is rewritten during a take (session.ts writeManifest, every channel
 * arrival plus a 2.5 s follow-up) and re-stamps createdAt each time, so it is
 * the time of the last rewrite rather than the start of the take.
 *
 * WHAT PRICES THE OFFSET. A clean take does not recover its full wall time
 * either — arming takes a moment and stop is not instant — so `--control` runs
 * the identical take and STOPS it properly. Its (elapsed - durationMs) is the
 * no-crash offset, and every crash number is reported both raw and net of it.
 * Without that control a few hundred ms of arming would be reported as crash
 * loss, which it is not.
 *
 *   node scripts/crash-bound.mjs --control=300000 --killAt=60000,300000,720000,1200000,1860000
 *   node scripts/crash-bound.mjs --killAt=60000 --export
 *   node scripts/crash-bound.mjs --killAt=60000 --screen=2560x1440 --keep-profile
 *
 * The playbook, and the numbers this last produced: docs/CRASH_BOUND.md.
 *
 * HEADED BY DEFAULT, for camera-check.mjs's reason: headless Chrome has no GPU
 * here, the raw channel's WebCodecs path times out and falls back to
 * MediaRecorder VP9 — a different file with a different salvage story, so a
 * headless run answers a question nobody asked. The report says which it was.
 *
 * QA only: changes no product code, and the product cannot tell it from a user.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launchChromeRetrying,
  quitChrome,
  resolveChrome,
  sigkillChrome,
  sleep,
} from './lib/chrome.mjs'

const PROD_URL = 'https://inout-kappa.vercel.app/'

function parseArgs(argv) {
  const o = {
    url: PROD_URL,
    killAt: [],
    control: 0,
    headed: true,
    out: null,
    keepProfile: false,
    // 1920x1080@60 is the DEFAULT because it is the heaviest max60 take this
    // machine actually holds: at 2560x1440@60 the take collapses mid-run (see
    // docs/CRASH_BOUND.md) and a dead take prices nothing.
    screen: '1920x1080',
    screenFps: 60,
    settleMs: 12_000,
    /**
     * HOW LONG THE APP IS LEFT ALONE BEFORE RECORD IS PRESSED — and it is a
     * MEASUREMENT decision, added 2026-09-02 by H2b.
     *
     * This rig used to press the instant the button appeared, ~200 ms after the
     * page's first paint. No user does that, and it changes what the early kill
     * points measure: a Chrome process's first VideoEncoder pays a multi-second
     * init (rawVideo.worker.ts, note 6), and the app's own encoder-warm probe
     * is still running at that moment. Measured on prod that day, pressing
     * immediately: NOTHING was on disk for any video channel at 2/3/4/5 s, and
     * at 7 s all three files appeared at once carrying the whole take. Pressing
     * ten seconds in, on the identical build: 1.0 s of decodable picture at a
     * 2 s kill and 4.0 s at 5 s. The floor was Chrome warming up, not salvage.
     *
     * --settleBeforeRecordMs=0 reproduces the old, colder cell.
     */
    settleBeforeRecordMs: 10_000,
    exportCheck: false,
  }
  for (const a of argv) {
    if (a === '--headed') o.headed = true
    else if (a === '--headless') o.headed = false
    else if (a === '--keep-profile') o.keepProfile = true
    else if (a === '--export') o.exportCheck = true
    else if (a.startsWith('--url=')) o.url = a.slice(6)
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else if (a.startsWith('--screen=')) o.screen = a.slice(9)
    else if (a.startsWith('--screenfps=')) o.screenFps = Number(a.slice(12))
    else if (a.startsWith('--settleMs=')) o.settleMs = Number(a.slice(11))
    else if (a.startsWith('--settleBeforeRecordMs=')) o.settleBeforeRecordMs = Number(a.slice(23))
    else if (a.startsWith('--control=')) o.control = Number(a.slice(10))
    else if (a.startsWith('--killAt=')) o.killAt = a.slice(9).split(',').map(Number).filter((n) => n > 0)
    else {
      console.error(`crash-bound: unknown argument ${a}`)
      process.exit(2)
    }
  }
  if (!o.killAt.length && !o.control) {
    console.error('crash-bound: nothing to do — pass --killAt=<ms,...> and/or --control=<ms>')
    process.exit(2)
  }
  return o
}

const opts = parseArgs(process.argv.slice(2))
const bin = resolveChrome()
if (!bin) {
  console.error('crash-bound: Chrome not found — set CHROME_BIN')
  process.exit(2)
}

/** The take under test: the `max` quality step, which is what turns the source's
 *  own resolution and 60 fps on (docs/FLAGS.md), on a synthetic 60 fps source. */
function takeUrl(url) {
  const u = new URL(url)
  u.searchParams.set('synthetic', '1')
  u.searchParams.set('qstep', 'max')
  u.searchParams.set('screensize', opts.screen)
  u.searchParams.set('screenfps', String(opts.screenFps))
  return u.toString()
}

// ---------------------------------------------------------------------------
// what the page is asked
// ---------------------------------------------------------------------------

const START_BTN = `document.querySelector('button[aria-label="Start recording"]')`
const STOP_BTN = `document.querySelector('button[aria-label="Stop recording"]')`

async function waitForCaptureScreen(s, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await s.evaluate(`!!${START_BTN}`)) return true
    await sleep(500)
  }
  return false
}

/** Press record, and return the page's own Date.now() at the instant it landed. */
async function pressRecord(s) {
  const startWall = await s.evaluate(`(() => { const b = ${START_BTN}; if (!b) return null; b.click(); return Date.now() })()`)
  if (!startWall) throw new Error('no record button to press')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await s.evaluate(`!!${STOP_BTN}`)) return startWall
    await sleep(200)
  }
  throw new Error('the take never reached recording (no stop button)')
}

/** Everything the product wrote down about the newest take, plus the bytes. */
const READ_TAKE = `(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('inout')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const all = await new Promise((res, rej) => {
    const r = db.transaction('recordings').objectStore('recordings').getAll()
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  const files = []
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('blobs')
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue
      files.push({ name, bytes: (await h.getFile()).size })
    }
  } catch (e) { /* no blobs dir */ }
  return JSON.stringify({
    takeCount: all.length,
    files: files.sort((a, b) => b.bytes - a.bytes),
    pendingLeft: localStorage.getItem('inout.pending') !== null,
    recording: rec && {
      id: rec.id,
      createdAt: rec.createdAt,
      durationMs: rec.durationMs,
      channels: rec.channels.map((c) => ({
        id: c.id, kind: c.kind, media: c.media, mimeType: c.mimeType,
        blobKey: c.blobKey, startOffsetMs: c.startOffsetMs, durationMs: c.durationMs,
        width: c.width ?? null, height: c.height ?? null,
      })),
      composite: rec.composite ? { blobKey: rec.composite.blobKey, width: rec.composite.width, height: rec.composite.height } : null,
    },
  })
})()`

/** The take's own report card, when the build carries S1's globals. */
const READ_CARD = `(async () => {
  if (typeof __inoutReport !== 'function') return JSON.stringify(null)
  try { const c = await __inoutReport(); return JSON.stringify(c && { verdict: c.verdict, line: c.line ?? c.summary ?? null }) }
  catch (e) { return JSON.stringify({ error: String(e) }) }
})()`


// ---------------------------------------------------------------------------
// the number this task exists to state
// ---------------------------------------------------------------------------

/**
 * HOW FAR BEHIND THE CRASH EACH CHANNEL ENDS.
 *
 * The recording's own `durationMs` is the MAX over channels and hides exactly
 * the case that matters: audio surviving to the crash while the picture stops
 * seconds earlier still costs the user those seconds of picture. So the bound
 * is read per channel and the worst one is the answer.
 *
 * The offsets are taken from the PENDING MANIFEST, not from the salvaged
 * recording: salvage subtracts the smallest offset from all of them
 * (recovery.ts), so the salvaged numbers are relative to the first channel to
 * arrive rather than to the press, and using them would credit every channel
 * with the arming time of the earliest one.
 *
 * Raw, and deliberately not net of the clean-stop control: a crash has no stop
 * click to wait for, so subtracting the control's own trailing gap would
 * flatter the number. This over-reports rather than under-reports, which is
 * what a bound is for.
 */
function channelLosses({ elapsedMs, pending, recording }) {
  const rawOffset = new Map((pending?.channels ?? []).map((c) => [c.id, c.startOffsetMs ?? 0]))
  const minRaw = rawOffset.size ? Math.min(...rawOffset.values()) : 0
  const salvaged = new Map((recording?.channels ?? []).map((c) => [c.id, c]))
  const rows = []
  const ids = new Set([...rawOffset.keys(), ...salvaged.keys()])
  for (const id of ids) {
    const ch = salvaged.get(id) ?? null
    const manifest = (pending?.channels ?? []).find((c) => c.id === id) ?? null
    const offset = rawOffset.has(id) ? rawOffset.get(id) : (ch?.startOffsetMs ?? 0) + minRaw
    rows.push({
      id,
      kind: ch?.kind ?? manifest?.kind ?? null,
      media: ch?.media ?? manifest?.media ?? null,
      offsetMs: Math.round(offset),
      durationMs: ch?.durationMs ?? null,
      // A channel in the manifest with nothing salvaged lost the WHOLE take,
      // and says so as a loss of everything after its own first sample.
      lossMs: Math.round(elapsedMs - offset - (ch?.durationMs ?? 0)),
      salvaged: !!ch,
    })
  }
  rows.sort((a, b) => b.lossMs - a.lossMs)
  return {
    rows,
    worstMs: rows.length ? rows[0].lossMs : null,
    worstVideoMs: Math.max(...rows.filter((r) => r.media === 'video').map((r) => r.lossMs), -Infinity),
    worstAudioMs: Math.max(...rows.filter((r) => r.media === 'audio').map((r) => r.lossMs), -Infinity),
    channelsLost: rows.filter((r) => !r.salvaged).length,
  }
}



/** Sleep, unless Chrome dies first. A 31-minute take on an 8 GB machine can end
 *  itself; that is a crash of the exact kind this task prices, so it is
 *  recorded as one rather than reported as a broken run. */
async function sleepUnlessDead(session, ms, watch) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(Math.min(5000, Math.max(0, deadline - Date.now())))
    try {
      await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(2000) })
    } catch {
      return { alive: false, atMs: Date.now(), reason: 'browser gone' }
    }
    // A LIVE BROWSER IS NOT A LIVE TAKE, and the difference is the whole
    // measurement: a renderer that died, or a take that stopped itself, leaves
    // a file that ends long before the crash — and reporting that as crash
    // loss would blame the salvage path for a take that was already over. The
    // stop button is the take's own witness that it is still recording.
    if (watch) {
      let recording = null
      try {
        recording = await session.evaluate(`!!${STOP_BTN}`, 10_000)
      } catch (err) {
        return { alive: false, atMs: Date.now(), reason: `page unresponsive: ${err}` }
      }
      watch.push({ atMs: Date.now(), recording })
      if (!recording) return { alive: false, atMs: Date.now(), reason: 'the take stopped itself' }
    }
  }
  return { alive: true, atMs: Date.now() }
}

/** One OPFS file's size, as an expression the page can be asked for. */
function sizeOfExpr(name) {
  return `(async () => {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('blobs')
      const h = await dir.getFileHandle(${JSON.stringify(name)})
      return JSON.stringify({ bytes: (await h.getFile()).size })
    } catch (e) { return JSON.stringify(null) }
  })()`
}

/**
 * A DURATION PROBE IS NOT A USABLE TAKE. `computeDuration` reads packet
 * timestamps; it does not prove the file survives the export path. With
 * `--export` the salvaged take is exported through the product's own buttons
 * and the run waits for the file to appear in OPFS.
 */
async function verifyExport(s, budgetMs = 600_000) {
  const out = { pressed: false, file: null }
  out.pressed = !!(await s.evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
  ))
  if (!out.pressed) return out
  await sleep(1500)
  await s.evaluate(`(() => { const b=document.querySelector('.quality .btn--primary'); if(!b) return false; b.click(); return true })()`)
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const f = await s.evalJson(
      `(async () => {
        try {
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('blobs')
          for await (const [name, h] of dir.entries()) {
            if (h.kind === 'file' && name.startsWith('xport-')) {
              const file = await h.getFile()
              if (file.size > 0) return JSON.stringify({ name, bytes: file.size })
            }
          }
        } catch (e) {}
        return JSON.stringify(null)
      })()`,
    )
    if (f) {
      // A file that exists is not a file that is finished — wait until it stops
      // growing, so the size reported is the export and not a snapshot of one.
      let last = -1
      let settled = false
      for (let i = 0; i < 300; i++) {
        last = f.bytes
        await sleep(2000)
        const again = await s.evalJson(sizeOfExpr(f.name))
        if (again?.bytes) f.bytes = again.bytes
        if (last === f.bytes) {
          settled = true
          break
        }
      }
      out.file = f
      // False means the export was still growing when the budget ran out, so
      // the size below is a snapshot rather than the file. Say which.
      out.settled = settled
      return out
    }
    await sleep(2000)
  }
  return out
}

// ---------------------------------------------------------------------------
// WHERE THE MANIFEST IS, READ WITHOUT ASKING THE APP  (H2b)
// ---------------------------------------------------------------------------
// The manifest has two homes now: the localStorage one that shipped, and the
// IndexedDB one H2b added because localStorage has no commit. Both are read
// here with the page's scripts DISABLED, which is the whole point of this
// rig — a crash state described by the app that survived it proves nothing.

/** The durable copy, via CDP. `IndexedDB.requestData` hands back a RemoteObject,
 *  and a STRING's value comes through whole — which is why the row is the same
 *  JSON string localStorage holds rather than a structured-cloned object. */
async function readDurableViaCdp(s, origin) {
  try {
    await s.send('IndexedDB.enable')
  } catch {
    return null
  }
  // Chrome moved this domain from securityOrigin to storageKey; accept either,
  // rather than pinning the rig to one Chrome.
  for (const scope of [{ storageKey: `${origin}/` }, { securityOrigin: origin }]) {
    try {
      const res = await s.send('IndexedDB.requestData', {
        ...scope,
        databaseName: 'inout-pending',
        objectStoreName: 'pending',
        indexName: '',
        skipCount: 0,
        pageSize: 10,
      })
      const raw = (res?.objectStoreDataEntries ?? [])[0]?.value?.value
      if (typeof raw === 'string') return JSON.parse(raw)
    } catch {
      /* try the other scope */
    }
  }
  return null
}

/**
 * THE SAME ROW, READ OFF THE PLATTER WITH NO BROWSER INVOLVED.
 *
 * The independent check: Chrome's IndexedDB is LevelDB in the profile
 * directory, and a manifest that reached it is sitting in those files as ASCII.
 * If CDP and this disagree, CDP is describing a cache and this is describing
 * the disk — which is the distinction the whole task turns on.
 */
function readDurableFromProfile(profile, origin) {
  const host = new URL(origin).host
  const base = join(profile, 'Default', 'IndexedDB')
  let dirs = []
  try {
    dirs = readdirSync(base).filter((d) => d.includes(host) && d.endsWith('.leveldb'))
  } catch {
    return null
  }
  for (const d of dirs) {
    let files = []
    try {
      files = readdirSync(join(base, d))
    } catch {
      continue
    }
    for (const f of files) {
      const full = join(base, d, f)
      let text
      try {
        if (statSync(full).size > 64 * 1024 * 1024) continue
        text = readFileSync(full, 'latin1')
      } catch {
        continue
      }
      const at = text.lastIndexOf('{"v":1,"recordingId"')
      if (at < 0) continue
      // Balance the braces rather than guessing where the value ends.
      let depth = 0
      for (let i = at; i < text.length; i++) {
        if (text[i] === '{') depth++
        else if (text[i] === '}') {
          depth--
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(at, i + 1))
            } catch {
              break
            }
          }
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// the two cells
// ---------------------------------------------------------------------------

function newProfile(tag) {
  const dir = join(tmpdir(), `inout-h2-${tag}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A take that is stopped properly. Its (elapsed - durationMs) is the offset
 *  every crash number is read against — arming and stop, not crash loss. */
async function runControl(ms) {
  const profile = newProfile('control')
  const out = { cell: 'control', requestedMs: ms }
  let s
  try {
    s = await launchChromeRetrying({ bin, profile, url: takeUrl(opts.url), headed: opts.headed })
    if (!(await waitForCaptureScreen(s))) throw new Error('the app never reached the capture screen')
    await sleep(opts.settleBeforeRecordMs)
    const startWall = await pressRecord(s)
    out.startWall = startWall
    // The manifest, read while the take is alive — the control needs the same
    // un-normalized offsets the crash cells read off disk afterwards.
    await sleep(Math.min(ms, 6000))
    out.pending = await s.evalJson(`localStorage.getItem('inout.pending')`)
    // H2b: the same manifest, from the home that has a commit — read while the
    // take is alive, which is the only moment a control can see it.
    out.pendingDurable = await readDurableViaCdp(s, new URL(opts.url).origin)
    await sleep(Math.max(0, ms - 6000))
    const stopWall = await s.evaluate(`(() => { const b = ${STOP_BTN}; if (!b) return null; b.click(); return Date.now() })()`)
    if (!stopWall) throw new Error('no stop button to press')
    out.stopWall = stopWall
    out.elapsedMs = stopWall - startWall
    // The editor opens when the take is written; poll rather than guess.
    const deadline = Date.now() + 120_000
    let take = null
    while (Date.now() < deadline) {
      take = await s.evalJson(READ_TAKE)
      if (take?.recording) break
      await sleep(1000)
    }
    out.take = take
    out.card = await s.evalJson(READ_CARD)
    out.durationMs = take?.recording?.durationMs ?? null
    out.offsetMs = out.durationMs === null ? null : out.elapsedMs - out.durationMs
    out.channels = channelLosses({ elapsedMs: out.elapsedMs, pending: out.pending, recording: take?.recording })
    out.consoleTail = s.consoleLines.slice(-40)
  } catch (err) {
    out.error = String(err)
  } finally {
    if (s) await quitChrome(s)
    if (!opts.keepProfile) rmSync(profile, { recursive: true, force: true })
  }
  return out
}

/** A take that is SIGKILLed at `killAtMs`, then salvaged from the same profile. */
async function runKillPoint(killAtMs) {
  const profile = newProfile(`kill${killAtMs}`)
  const out = { cell: 'kill', killAtMs }
  let s
  try {
    s = await launchChromeRetrying({ bin, profile, url: takeUrl(opts.url), headed: opts.headed })
    if (!(await waitForCaptureScreen(s))) throw new Error('the app never reached the capture screen')
    // Not a convenience: see settleBeforeRecordMs. A cell that presses record
    // into a cold encoder measures Chrome's warm-up, not the crash floor.
    await sleep(opts.settleBeforeRecordMs)
    const startWall = await pressRecord(s)
    out.startWall = startWall
    // The take's own account of itself, taken while it still can speak. Nothing
    // is asked of the page inside the last 5 s, so no evaluate can perturb what
    // the kill is about to interrupt.
    const watch = []
    let live = await sleepUnlessDead(s, Math.max(0, killAtMs - 5_000), watch)
    {
      const cap = s.consoleLines.filter((l) => /\[capture/.test(l))
      // Both ends: the head says what the take armed as, the tail says what it
      // was doing as the crash arrived — and a take that was already dying says
      // so here rather than in the loss number.
      out.midTakeConsole = cap.slice(0, 30)
      out.lateTakeConsole = cap.slice(-30)
    }
    if (live.alive) live = await sleepUnlessDead(s, Math.min(5_000, killAtMs))
    out.stillRecordingAtKill = live.alive
    out.diedReason = live.alive ? null : live.reason
    // Only the last instant the take was SEEN recording, not every poll.
    const lastSeen = [...watch].reverse().find((w) => w.recording)
    out.lastSeenRecordingAtMs = lastSeen?.atMs ?? null
    out.watchPolls = watch.length
    let killWall
    if (live.alive) {
      const k = await sigkillChrome(s)
      killWall = k.killWall
      out.killUncertaintyMs = k.killWallAfter - k.killWall
      out.diedOnItsOwn = false
    } else {
      // Chrome was already gone. The instant is the first poll that found it
      // dead, so this cell's elapsed time is an UPPER bound (the death was at
      // some point in the preceding 5 s) and the loss it reports is therefore
      // conservative in the same direction as everything else here.
      killWall = live.atMs
      out.diedOnItsOwn = true
      out.killUncertaintyMs = 5000
    }
    out.killWall = killWall
    out.elapsedMs = killWall - startWall
    s = null

    // ---- what survived, read BEFORE the app runs -------------------------
    // Scripts off, so boot recovery cannot fire and clear the manifest: this is
    // the one look at the state the crash actually left on disk.
    const s2 = await launchChromeRetrying({ bin, profile, url: takeUrl(opts.url), headed: opts.headed, scriptsOff: true })
    await s2.send('Emulation.setScriptExecutionDisabled', { value: true })
    await s2.send('Page.navigate', { url: takeUrl(opts.url) })
    await sleep(4000)
    const origin = new URL(opts.url).origin
    const ls = await s2
      .send('DOMStorage.enable')
      .then(() => s2.send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage: true } }))
      .catch((e) => ({ error: String(e) }))
    const entries = Array.isArray(ls?.entries) ? ls.entries : []
    const pendingRaw = entries.find((e) => e[0] === 'inout.pending')?.[1] ?? null
    const durableCdp = await readDurableViaCdp(s2, origin)
    const durableDisk = readDurableFromProfile(profile, origin)
    out.pendingHomes = {
      localStorage: pendingRaw !== null,
      indexedDbViaCdp: durableCdp !== null,
      indexedDbOnDisk: durableDisk !== null,
    }
    // ANY home is a survival: salvage reads whichever one is there.
    out.pendingSurvived = pendingRaw !== null || durableCdp !== null || durableDisk !== null
    out.pending = pendingRaw ? JSON.parse(pendingRaw) : (durableCdp ?? durableDisk)

    // ---- and now let the product salvage it ------------------------------
    await s2.send('Emulation.setScriptExecutionDisabled', { value: false })
    await s2.send('Page.reload', { ignoreCache: false })
    const deadline = Date.now() + opts.settleMs + 120_000
    let take = null
    while (Date.now() < deadline) {
      take = await s2.evalJson(READ_TAKE).catch(() => null)
      if (take?.recording) break
      await sleep(1000)
    }
    out.take = take
    out.card = await s2.evalJson(READ_CARD).catch(() => null)
    out.durationMs = take?.recording?.durationMs ?? null
    out.rawLossMs = out.durationMs === null ? null : out.elapsedMs - out.durationMs
    out.channels = channelLosses({ elapsedMs: out.elapsedMs, pending: out.pending, recording: take?.recording })
    out.worstChannelLossMs = out.channels.worstMs
    out.salvaged = !!take?.recording
    if (opts.exportCheck && take?.recording) out.export = await verifyExport(s2)
    out.recoveryConsole = s2.consoleLines.slice(-40)
    await quitChrome(s2)
  } catch (err) {
    out.error = String(err)
    if (s) await quitChrome(s)
  } finally {
    if (!opts.keepProfile) rmSync(profile, { recursive: true, force: true })
  }
  return out
}

// ---------------------------------------------------------------------------

const report = {
  task: 'H2',
  url: takeUrl(opts.url),
  headed: opts.headed,
  settleBeforeRecordMs: opts.settleBeforeRecordMs,
  startedAt: new Date().toISOString(),
  chrome: bin,
  control: null,
  points: [],
}

const totalMs = (opts.control || 0) + opts.killAt.reduce((a, b) => a + b, 0)
console.error(
  `crash-bound: ${opts.killAt.length} kill point(s)${opts.control ? ' + control' : ''} · ` +
    `${(totalMs / 60_000).toFixed(1)} min of recording, plus ~1.5 min of launch/salvage each · ` +
    `${opts.headed ? 'HEADED' : 'HEADLESS'} · ${report.url}`,
)

if (opts.control) {
  console.error(`crash-bound: control take, ${(opts.control / 1000).toFixed(0)} s, stopped properly…`)
  report.control = await runControl(opts.control)
  console.error(
    `crash-bound: control ${report.control.error ?? `elapsed ${report.control.elapsedMs} ms, duration ${report.control.durationMs} ms, offset ${report.control.offsetMs} ms`}`,
  )
}

for (const killAt of opts.killAt) {
  console.error(`crash-bound: kill point at ${(killAt / 1000).toFixed(0)} s…`)
  const r = await runKillPoint(killAt)
  report.points.push(r)
  console.error(
    `crash-bound: ${(killAt / 1000).toFixed(0)} s → ` +
      (r.error
        ? `ERROR ${r.error}`
        : `salvaged=${r.salvaged} manifest=${r.pendingSurvived} · elapsed ${(r.elapsedMs / 1000).toFixed(1)} s · ` +
          `worst channel trail ${r.worstChannelLossMs} ms (video ${r.channels?.worstVideoMs} / audio ${r.channels?.worstAudioMs})` +
          ` · manifest ${Object.entries(r.pendingHomes ?? {}).filter(([, v]) => v).map(([k]) => k).join('+') || 'NOWHERE'}` +
          (r.channels?.channelsLost ? ` · ${r.channels.channelsLost} CHANNEL(S) LOST WHOLE` : '')),
  )
}

// ---- the bound ------------------------------------------------------------
// THE BOUND IS THE WORST CHANNEL AT THE WORST KILL POINT. Not the average, not
// the recording's own duration: a take whose picture stops four seconds before
// its audio has lost four seconds of picture, whatever the row says.
// A POINT ONLY PRICES A CRASH IF THE TAKE WAS STILL RECORDING WHEN IT CAME.
// One whose take had already stopped is measuring a dead take's tail, which is
// H1/H4's subject and not a bound on salvage — it is kept in the report, named,
// and left out of the bound.
const usable = report.points.filter(
  (p) => !p.error && p.stillRecordingAtKill && p.worstChannelLossMs !== null && p.worstChannelLossMs !== undefined,
)
report.notCrashPoints = report.points
  .filter((p) => !p.error && !p.stillRecordingAtKill)
  .map((p) => ({ killAtMs: p.killAtMs, diedReason: p.diedReason, lastSeenRecordingAtMs: p.lastSeenRecordingAtMs, startWall: p.startWall }))
report.control_trailMs = report.control?.channels?.worstMs ?? null
report.bound = {
  points: usable.length,
  worstMs: usable.length ? Math.max(...usable.map((p) => p.worstChannelLossMs)) : null,
  worstVideoMs: usable.length ? Math.max(...usable.map((p) => p.channels.worstVideoMs)) : null,
  worstAudioMs: usable.length ? Math.max(...usable.map((p) => p.channels.worstAudioMs)) : null,
  perPoint: usable.map((p) => ({ killAtMs: p.killAtMs, elapsedMs: p.elapsedMs, worstMs: p.worstChannelLossMs })),
  // What a take that was stopped PROPERLY trails its own stop click on this
  // machine — the reference the crash numbers are read against, and not
  // subtracted from them.
  cleanStopTrailMs: report.control_trailMs,
  allSalvaged: report.points.length > 0 && report.points.every((p) => p.salvaged),
  everyChannelSalvaged: report.points.length > 0 && report.points.every((p) => p.channels?.channelsLost === 0),
  manifestAlwaysSurvived: report.points.length > 0 && report.points.every((p) => p.pendingSurvived),
}
/**
 * H2b — PICTURE, NOT ONLY SOUND, FROM A YOUNG TAKE.
 *
 * H2's floor probe salvaged a 5.4 s take as AUDIO ONLY: no video fragment had
 * closed. This asks every kill point for a VIDEO channel with material in it,
 * and it is the gate the early first fragment exists to pass. Reported per
 * point so a failure names the instant rather than the run.
 */
report.picture = report.points
  .filter((p) => !p.error && p.stillRecordingAtKill)
  .map((p) => ({
    killAtMs: p.killAtMs,
    videoChannels: (p.take?.recording?.channels ?? []).filter((c) => c.media === 'video').length,
    videoMs: Math.max(
      0,
      ...(p.take?.recording?.channels ?? [])
        .filter((c) => c.media === 'video')
        .map((c) => c.durationMs ?? 0),
    ),
  }))
report.gates = {
  fivePoints: usable.length >= 5,
  everyKillSalvaged: report.bound.allSalvaged && report.bound.everyChannelSalvaged,
  manifestSurvived: report.bound.manifestAlwaysSurvived,
  worstUnder5s: report.bound.worstMs !== null && report.bound.worstMs < 5000,
  pictureAtEveryKill: report.picture.length > 0 && report.picture.every((p) => p.videoMs > 0),
}

const outPath = opts.out ?? join(tmpdir(), `crash-bound-${Date.now()}.json`)
writeFileSync(outPath, JSON.stringify(report, null, 2))
console.error(`crash-bound: report → ${outPath}`)
console.log(JSON.stringify({ bound: report.bound, gates: report.gates }, null, 2))
process.exit(Object.values(report.gates).every(Boolean) ? 0 : 1)
