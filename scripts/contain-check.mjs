#!/usr/bin/env node
/**
 * H1 — IS A COMPONENT DEATH A SEAM, OR A DEAD TAKE?
 *
 * Kill the thing UNDER a live channel — the encoder, or the worker that owns
 * it — in the middle of a real take on the deployed build, and read out of the
 * FILES whether the take survived it: two segments where there was one, the
 * hole between them, every other channel full length, and the seam certified
 * where a person can find it.
 *
 * WHY IT IS A RIG AND NOT A UNIT TEST. Everything the answer depends on is
 * outside the module: whether a VideoEncoder that has reported failure can
 * still be flushed, whether OPFS lets a second SyncAccessHandle open for the
 * same channel while the first is closing, whether the compositor notices its
 * source's recorder was swapped underneath it, and how long the drain of a
 * DYING encoder actually takes — which is the number the seam is made of. A
 * fake encoder answers none of them.
 *
 * WHY HEADED, and it is crash-bound's reason: headless Chrome has no GPU here,
 * the raw channel's WebCodecs path times out and falls back to MediaRecorder,
 * and a run that never opened a VideoEncoder cannot test killing one.
 *
 *   node scripts/contain-check.mjs                     the four gate cells
 *   node scripts/contain-check.mjs --only=killenc      one cell
 *   node scripts/contain-check.mjs --url=http://localhost:5174
 *
 * Exit 0 only when every cell passes. QA only: changes no product code, and
 * the product cannot tell it from a user who had a very bad minute.
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeProfile, launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'

const PROD_URL = 'https://inout-kappa.vercel.app/'

/**
 * THE BAND, AND IT IS NOT A ROUND NUMBER PULLED OUT OF THE AIR. F6 measured
 * the same close-and-reopen move on the deployed build at 99 / 101 / 207 /
 * 218 ms across four kinds (a pause), and O16 measured it at 69 ms (a
 * resolution step, video only). A contained death has strictly more to do than
 * either — the segment it drains is one whose encoder has just failed — so the
 * band is F6's worst plus room, and anything past it is a drain that did not
 * finish rather than a seam.
 */
const SEAM_BAND_MS = 250

/** How long each take runs, and when the fault lands inside it. */
const TAKE_MS = 16_000
const FAULT_AT_MS = 6_000

/** How late a held stop reply is, for the H5 cells. Past STOP_BUDGET_MS (5 s)
 *  by enough that the budget is certainly what expires. */
const SLOW_STOP_MS = 9_000

const CELLS = ['healthy', 'killenc', 'killworker', 'killenc-audio', 'slowstop', 'slowstop-empty']

function parseArgs(argv) {
  const o = { url: PROD_URL, headed: true, only: null, out: null, keepProfile: false }
  for (const a of argv) {
    if (a === '--headed') o.headed = true
    else if (a === '--headless') o.headed = false
    else if (a === '--keep-profile') o.keepProfile = true
    else if (a.startsWith('--url=')) o.url = a.slice(6)
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else if (a.startsWith('--only=')) o.only = a.slice(7).split(',')
    else {
      console.error(`contain-check: unknown argument ${a}`)
      process.exit(2)
    }
  }
  if (o.only) {
    for (const c of o.only) {
      if (!CELLS.includes(c)) {
        console.error(`contain-check: unknown cell ${c} (have: ${CELLS.join(', ')})`)
        process.exit(2)
      }
    }
  }
  return o
}

const opts = parseArgs(process.argv.slice(2))
const bin = resolveChrome()
if (!bin) {
  console.error('contain-check: Chrome not found — set CHROME_BIN')
  process.exit(2)
}

const START_BTN = `document.querySelector('button[aria-label="Start recording"]')`
const STOP_BTN = `document.querySelector('button[aria-label="Stop recording"]')`

/** Screen + camera + mic, synthetic, at a size the raw AVC encoder is happy at. */
function takeUrl(fault) {
  const u = new URL(opts.url)
  u.searchParams.set('synthetic', '1')
  u.searchParams.set('screensize', '1920x1080')
  if (fault) u.searchParams.set(fault.knob, `${fault.kind}:${fault.atMs ?? FAULT_AT_MS}`)
  for (const [k, v] of fault?.extra ?? []) u.searchParams.set(k, v)
  return u.toString()
}

async function waitForCaptureScreen(s, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await s.evaluate(`!!${START_BTN}`)) return true
    await sleep(500)
  }
  return false
}

async function pressRecord(s) {
  const at = await s.evaluate(
    `(() => { const b = ${START_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
  )
  if (!at) throw new Error('no record button to press')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await s.evaluate(`!!${STOP_BTN}`)) return at
    await sleep(200)
  }
  throw new Error('the take never reached recording (no stop button)')
}

/**
 * The take as the PRODUCT wrote it, plus the bytes on disk. The seams and the
 * loss ledger are read from the stored recording rather than from the console,
 * because a line that is only ever printed is a line a user never sees.
 */
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
  const files = {}
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('blobs')
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file') files[name] = (await h.getFile()).size
    }
  } catch (e) { /* no blobs dir */ }
  return JSON.stringify({
    files,
    recording: rec && {
      id: rec.id, durationMs: rec.durationMs,
      channels: rec.channels.map((c) => ({
        id: c.id, kind: c.kind, media: c.media, blobKey: c.blobKey,
        startOffsetMs: c.startOffsetMs, durationMs: c.durationMs,
        width: c.width ?? null, height: c.height ?? null, bytes: c.bytes ?? null,
      })),
      seams: rec.seams ?? null,
      lost: rec.lost ?? null,
      missing: rec.missing ?? null,
      composite: rec.composite ? { blobKey: rec.composite.blobKey } : null,
    },
  })
})()`

const READ_CARD = `(async () => {
  if (typeof __inoutReport !== 'function') return JSON.stringify(null)
  try {
    const c = await __inoutReport()
    const ch = (c.dimensions ?? []).find((d) => d.id === 'channels') ?? null
    return JSON.stringify({ verdict: c.verdict, line: c.line ?? null, channels: ch })
  } catch (e) { return JSON.stringify({ error: String(e) }) }
})()`

/** The live band, read off the DOM while the take is still running. */
const READ_BAND = `(() => {
  const el = document.querySelector('.capture__stalled')
  return el ? el.innerText : ''
})()`

function newProfile(tag) {
  const dir = join(tmpdir(), `inout-h1-${tag}-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

const segmentsOf = (rec, kind) => (rec?.channels ?? []).filter((c) => c.kind === kind)
const endOf = (c) => c.startOffsetMs + c.durationMs
const lastEnd = (rec, kind) => Math.max(0, ...segmentsOf(rec, kind).map(endOf))

/** One cell: run a take, with or without a fault in it, and read everything. */
async function runCell(name, fault) {
  const profile = newProfile(name)
  const out = { cell: name, fault: fault ? `${fault.knob}=${fault.kind}:${FAULT_AT_MS}` : null }
  let s
  try {
    s = await launchChromeRetrying({ bin, profile, url: takeUrl(fault), headed: opts.headed })
    if (!(await waitForCaptureScreen(s))) throw new Error('the app never reached the capture screen')
    const startWall = await pressRecord(s)
    // Read the live band AFTER the fault instant and while the take is still
    // running: a sentence that only appears in the editor is not "said live".
    await sleep(FAULT_AT_MS + 3_000)
    out.bandAtFault = await s.evaluate(READ_BAND)
    await sleep(Math.max(0, TAKE_MS - FAULT_AT_MS - 3_000))
    const stopWall = await s.evaluate(
      `(() => { const b = ${STOP_BTN}; if (!b) return null; b.click(); return Date.now() })()`,
    )
    if (!stopWall) throw new Error('no stop button to press — the take died')
    out.elapsedMs = stopWall - startWall
    const deadline = Date.now() + 120_000
    let take = null
    while (Date.now() < deadline) {
      take = await s.evalJson(READ_TAKE)
      if (take?.recording) break
      await sleep(1000)
    }
    if (!take?.recording) throw new Error('the take never reached the store')
    out.recording = take.recording
    out.files = take.files
    out.card = await s.evalJson(READ_CARD)
    out.consoleTail = s.consoleLines.filter((l) => /contain|H1 seams|H4 losses|H5 |slowstop|did not stop in budget|did not drain/.test(l))
  } catch (err) {
    out.error = String(err)
  } finally {
    if (s) await quitChrome(s)
    if (!opts.keepProfile) removeProfile(profile)
  }
  return out
}

/** Every gate this cell has to meet, as pass/fail lines with their numbers. */
function judge(out) {
  const checks = []
  const ok = (label, pass, detail) => checks.push({ label, pass: !!pass, detail })
  if (out.error) {
    ok('the cell ran', false, out.error)
    return checks
  }
  const rec = out.recording
  const seams = rec.seams ?? []
  const contained = out.cell !== 'healthy' && !out.cell.startsWith('slowstop')
  const kind = out.cell === 'killenc-audio' ? 'mic' : 'screen'

  ok('the take completed and reached the store', rec.durationMs > 0, `${rec.durationMs} ms`)

  /**
   * H5 — THE STOP REPLY WAS LATE AND THE FILE WAS NOT. `?slowstop=` holds the
   * reply past doStop's 5 s budget with the take written exactly as a healthy
   * one is, which is the failure H1's rig hit by accident under load: `bytes`
   * still 0 when the budget expired, read as "recorded nothing", and megabytes
   * deleted under a warning that said "keeping what reached disk".
   */
  if (out.cell === 'slowstop') {
    const held = segmentsOf(rec, 'screen')
    ok('the held channel is IN the take at all', held.length > 0,
      (rec.channels ?? []).map((c) => c.kind).join(' ') || 'nothing')
    ok('it has its true length', held.length > 0 && rec.durationMs - lastEnd(rec, 'screen') < 1_500,
      `screen ends at ${Math.round(lastEnd(rec, 'screen'))} of ${rec.durationMs} ms`)
    ok('it has its bytes', held.some((c) => (c.bytes ?? 0) > 100_000),
      held.map((c) => `${c.bytes ?? '?'}B`).join(' '))
    ok('its file is still on disk', held.every((c) => (out.files?.[c.blobKey] ?? 0) > 100_000),
      held.map((c) => `${c.blobKey}=${out.files?.[c.blobKey] ?? 'GONE'}`).join(' '))
    ok('the take does NOT report it missing', !rec.missing?.includes('screen'),
      JSON.stringify(rec.missing ?? []))
    ok('every other channel is full length',
      ['camera', 'mic'].every((k) => segmentsOf(rec, k).length > 0 && rec.durationMs - lastEnd(rec, k) < 1_500),
      ['camera', 'mic'].map((k) => `${k} ${Math.round(lastEnd(rec, k))}`).join(' · '))
    ok('a late reply is NOT certified as a loss', !rec.lost?.some((l) => l.kind === 'screen'),
      JSON.stringify(rec.lost ?? []))
    ok('the rescue said so on the console',
      (out.consoleTail ?? []).some((l) => /H5 screen never answered its stop/.test(l)),
      (out.consoleTail ?? []).find((l) => /H5/.test(l)) ?? 'nothing said')
    return checks
  }

  /**
   * H5, THE OTHER HALF: a channel that genuinely recorded nothing is STILL
   * removed. `?dead=camera` delivers zero frames — its file is a 28-byte `ftyp`
   * and nothing else — and holding its reply too must not turn a header into a
   * channel, nor leave the header on the disk.
   */
  if (out.cell === 'slowstop-empty') {
    ok('the empty channel is NOT in the take', segmentsOf(rec, 'camera').length === 0,
      (rec.channels ?? []).map((c) => c.kind).join(' '))
    ok('the take says the camera delivered nothing',
      !!rec.missing?.includes('camera') || !!rec.lost?.some((l) => l.kind === 'camera'),
      JSON.stringify({ missing: rec.missing ?? [], lost: rec.lost ?? [] }))
    const tiny = Object.entries(out.files ?? {}).filter(([, n]) => n < 1024)
    ok('its header was removed, not orphaned', tiny.length === 0, JSON.stringify(tiny))
    ok('every other channel is full length',
      ['screen', 'mic'].every((k) => segmentsOf(rec, k).length > 0 && rec.durationMs - lastEnd(rec, k) < 1_500),
      ['screen', 'mic'].map((k) => `${k} ${Math.round(lastEnd(rec, k))}`).join(' · '))
    return checks
  }

  if (!contained) {
    // NOTHING ENGAGES ON A HEALTHY TAKE. This is the gate that keeps the rest
    // honest: a containment that fires when nothing died is a defect that
    // would show up as a green run everywhere else.
    ok('no seam was written', seams.length === 0, JSON.stringify(seams))
    ok('nothing was lost', !rec.lost?.length, JSON.stringify(rec.lost ?? []))
    ok(
      'one segment per kind',
      ['screen', 'camera', 'mic'].every((k) => segmentsOf(rec, k).length <= 1),
      (rec.channels ?? []).map((c) => `${c.kind}x1`).join(' '),
    )
    ok('no live band', !out.bandAtFault, JSON.stringify(out.bandAtFault))
    ok('the report card grades it clean', out.card?.channels?.status === 'pass', out.card?.line)
    return checks
  }

  const segs = segmentsOf(rec, kind).sort((a, b) => a.startOffsetMs - b.startOffsetMs)
  ok(`${kind} was reopened (two segments)`, segs.length === 2,
    segs.map((c) => `${Math.round(c.startOffsetMs)}+${Math.round(c.durationMs)}ms/${c.bytes ?? '?'}B`).join(' · '))

  const seam = seams.find((sm) => sm.kind === kind) ?? null
  const wantCause = out.cell === 'killworker' ? 'worker-death' : 'encoder-error'
  ok('the seam is certified with its cause', seam?.cause === wantCause, JSON.stringify(seam))
  ok(
    `the seam is inside the band (<= ${SEAM_BAND_MS} ms)`,
    seam !== null && seam.gapMs >= 0 && seam.gapMs <= SEAM_BAND_MS,
    seam ? `${seam.gapMs} ms at ${seam.atMs} ms` : 'no seam',
  )
  // The certified instant must be where the fault was asked for. Loose to a
  // second: the encoder is drained to its last frame, and arming is not free.
  ok(
    'the seam names the instant the fault landed',
    seam !== null && Math.abs(seam.atMs - FAULT_AT_MS) < 2_000,
    seam ? `${seam.atMs} ms vs ${FAULT_AT_MS} ms asked` : 'no seam',
  )
  // The point of containment: the kind runs to the end of the take.
  ok(
    `${kind} runs to the end of the take`,
    rec.durationMs - lastEnd(rec, kind) < 1_500,
    `${kind} ends at ${Math.round(lastEnd(rec, kind))} of ${rec.durationMs} ms`,
  )
  const others = ['screen', 'camera', 'mic'].filter((k) => k !== kind)
  ok(
    'every other channel is full length',
    others.every((k) => segmentsOf(rec, k).length > 0 && rec.durationMs - lastEnd(rec, k) < 1_500),
    others.map((k) => `${k} ${Math.round(lastEnd(rec, k))}`).join(' · '),
  )
  ok('the channel is NOT certified lost — it came back', !rec.lost?.some((l) => l.kind === kind),
    JSON.stringify(rec.lost ?? []))
  ok('it was said live, while the take ran', /restarted itself/.test(out.bandAtFault ?? ''),
    JSON.stringify(out.bandAtFault))
  ok('the report card refuses to grade it clean', out.card?.channels?.status === 'fail',
    out.card?.channels?.detail)
  return checks
}

const plan = [
  ['healthy', null],
  ['killenc', { knob: 'killenc', kind: 'screen' }],
  ['killworker', { knob: 'killworker', kind: 'screen' }],
  ['killenc-audio', { knob: 'killenc', kind: 'mic' }],
  ['slowstop', { knob: 'slowstop', kind: 'screen', atMs: SLOW_STOP_MS }],
  ['slowstop-empty', { knob: 'slowstop', kind: 'camera', atMs: SLOW_STOP_MS, extra: [['dead', 'camera']] }],
].filter(([name]) => !opts.only || opts.only.includes(name))

const results = []
for (const [name, fault] of plan) {
  process.stdout.write(`\ncontain-check: ${name}${fault ? ` (?${fault.knob}=${fault.kind}:${fault.atMs ?? FAULT_AT_MS}${(fault.extra ?? []).map(([k, v]) => `&${k}=${v}`).join('')})` : ''} …\n`)
  const out = await runCell(name, fault)
  out.checks = judge(out)
  results.push(out)
  for (const c of out.checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  if (out.consoleTail?.length) for (const l of out.consoleTail) console.log(`        ${l}`)
}

const failed = results.filter((r) => r.checks.some((c) => !c.pass))
if (opts.out) writeFileSync(opts.out, JSON.stringify(results, null, 2))
console.log(
  `\ncontain-check: ${results.length - failed.length}/${results.length} cells pass` +
    (failed.length ? ` — FAILED: ${failed.map((f) => f.cell).join(', ')}` : ''),
)
process.exit(failed.length ? 1 : 0)
