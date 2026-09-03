#!/usr/bin/env node
/**
 * G7's RIG: does the lateness instrument read the machine, and what does it cost?
 *
 * Four questions, in this order because each is only worth asking if the one
 * before it answered:
 *
 *   clamp   THE DESIGN. A take runs with the tab HIDDEN. Chrome clamps a hidden
 *           page's timers to ~1 Hz, so a main-thread ticker reads the throttle
 *           as a stall — E1 measured 984 ms of it at idle. The instrument
 *           therefore puts its clock in a WORKER and stamps arrivals on the main
 *           thread. This lane runs BOTH clocks in one hidden page and prints
 *           them side by side. It is the only lane that launches Chrome with
 *           background throttling LEFT ON (`throttled: true`) — every other rig
 *           in this repo disables it, and none of them can see this.
 *           MEASURED 2026-09-02: timer 1.2 Hz / p50 983.6 ms late, worker beat
 *           63.3 Hz / p50 0.0 ms, on the same hidden page.
 *   cost    THE BUDGET (< 1 ms of main thread per second of capture). Two equal
 *           windows on one idle page, one with a sampler and one without, read
 *           through CDP's `Performance.getMetrics` — the renderer's own
 *           main-thread busy time. A throughput A/B cannot see this: the
 *           workload's spread is ±0.7 % and the quantity is ~0.03 %.
 *   take    THE CARD. Record a real take through the product, stop it, and read
 *           the `lateness` dimension off `__inoutReport()`.
 *   editor  THE EDITOR'S CARD. The editor samples its own first 15 s on mount
 *           and stops itself; `__inoutEditorReport()` grades it.
 *   drag    B10, AS A NUMBER. The editor's own 15 s window with a DRAG running
 *           through it — B10's stalls (35-201 ms) are drag stalls: the size
 *           probe encodes 300 frames on the main thread while the person is
 *           moving the playhead, and a probe measured without a drag
 *           interleaves and hides. Same pointer cadence as
 *           scripts/editor-drag-cost.mjs, so the two rigs are comparable.
 *
 *   node scripts/g7-lateness.mjs                      # all four, own dev server
 *   node scripts/g7-lateness.mjs --lanes=editor
 *   node scripts/g7-lateness.mjs --url=https://inout-kappa.vercel.app
 *
 * ALWAYS THROUGH THE GATE — it is a headed browser and a real take:
 *   scripts/gate.sh node scripts/g7-lateness.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const LANES = arg('lanes', 'clamp,cost,take,drag').split(',')
const TAKE_SEC = Number(arg('take', '20'))
const CLAMP_SEC = Number(arg('clamp', '20'))
const COST_REPS = Number(arg('reps', '3'))
const COST_SEC = Number(arg('costsec', '8'))
const DRAG_SEC = Number(arg('drag', '13'))
const EXTERNAL = arg('url', '')
const QUERY = arg('query', 'synthetic=1')

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const r1 = (n) => Math.round(n * 10) / 10
const r3 = (n) => Math.round(n * 1000) / 1000

/* ───────────────────────────── the lanes ───────────────────────────── */

/**
 * BOTH CLOCKS, ONE HIDDEN PAGE. The worker is written out here rather than
 * imported from the app on purpose: this lane has to be able to say the app's
 * design is WRONG, and a lane that measures the app's own worker could only
 * ever agree with it.
 */
const CLAMP = (ms, period) => `
(() => {
  const src = \`
    let seq = 0, start = 0, period = ${period}, t = null
    onmessage = (e) => {
      if (e.data.type === 'start') { start = performance.now(); seq = 0; t = setTimeout(tick, period) }
      else { clearTimeout(t); close() }
    }
    function tick() {
      const now = performance.now()
      seq++
      const due = start + seq * period
      postMessage({ due: performance.timeOrigin + due, workerLate: Math.max(0, now - due), seq })
      let next = start + (seq + 1) * period
      if (next <= now) { seq = Math.ceil((now - start) / period); next = start + (seq + 1) * period }
      t = setTimeout(tick, next - now)
    }\`
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
  const beat = { late: [], missed: 0, lastSeq: 0 }
  w.onmessage = (e) => {
    const now = performance.timeOrigin + performance.now()
    const d = e.data
    if (beat.lastSeq && d.seq > beat.lastSeq + 1) beat.missed += d.seq - beat.lastSeq - 1
    beat.lastSeq = d.seq
    beat.late.push(Math.max(0, now - d.due - d.workerLate))
  }
  w.postMessage({ type: 'start' })

  const timer = { late: [] }
  let last = performance.now()
  const iv = setInterval(() => {
    const now = performance.now()
    timer.late.push(Math.max(0, now - last - ${period}))
    last = now
  }, ${period})

  // What the page WAS while this ran — sampled, because the whole lane is about
  // a state the page enters after the measurement starts.
  const vis = []
  const visIv = setInterval(() => vis.push(document.visibilityState), 1000)

  const stat = (xs) => {
    if (!xs.length) return { n: 0 }
    const s = [...xs].sort((a, b) => a - b)
    const q = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10
    return { n: xs.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1] * 10) / 10 }
  }
  window.__g7clamp = new Promise((res) => {
    setTimeout(() => {
      clearInterval(iv)
      clearInterval(visIv)
      w.postMessage({ type: 'stop' })
      w.terminate()
      const secs = ${ms} / 1000
      res({
        periodMs: ${period},
        windowMs: ${ms},
        visibility: [...new Set(vis)],
        timer: { ...stat(timer.late), hz: Math.round((timer.late.length / secs) * 10) / 10 },
        worker: {
          ...stat(beat.late),
          hz: Math.round((beat.late.length / secs) * 10) / 10,
          missed: beat.missed,
        },
      })
    }, ${ms})
  })
  return 'started'
})()
`

/**
 * THE COST, MEASURED WITH CHROME'S OWN MAIN-THREAD CLOCK.
 *
 * The first two cuts of this lane were a THROUGHPUT A/B — the same workload run
 * with and without a sampler — and both were the wrong instrument, which the
 * numbers said plainly: 209.5 vs 210.9 work units/s, i.e. the sampled run came
 * out FASTER, because the workload's own run-to-run spread (±0.7 %) is an order
 * of magnitude larger than the thing being measured (~0.03 % of a second). No
 * number of repetitions fixes a signal that far under the noise.
 *
 * So ask the browser instead. CDP's `Performance.getMetrics` exposes the
 * renderer's cumulative `TaskDuration` and `ScriptDuration` — the main thread's
 * own busy time, in seconds, at microsecond resolution. Two equal windows on
 * ONE idle page, one without a sampler and one with, and the difference in
 * TaskDuration divided by the window IS the cost per second of wall clock. No
 * workload, no throughput arithmetic, nothing to be swamped by.
 */
const IDLE = (ms, sampling) => `
(async () => {
  ${sampling ? 'const run = await window.__inoutLatenessStart()' : ''}
  await new Promise((r) => setTimeout(r, ${ms}))
  ${sampling ? 'const summary = run.stop()' : 'const summary = null'}
  return { summary }
})()
`

async function laneClamp(chrome, out) {
  const started = await chrome.evaluate(CLAMP(CLAMP_SEC * 1000, 16))
  if (started !== 'started') throw new Error('clamp lane did not start')
  // HIDE THE TAB — which is the whole lane. A second tab in the foreground is
  // exactly what a take looks like: Robert presses record and switches to the
  // thing he is recording.
  const created = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, {
    method: 'PUT',
  })
    .then((r) => r.json())
    .catch(() => null)
  out.hidTab = Boolean(created?.id)
  await sleep((CLAMP_SEC + 3) * 1000)
  if (created?.id) {
    await fetch(`http://127.0.0.1:${chrome.port}/json/close/${created.id}`).catch(() => undefined)
    await sleep(1000)
  }
  const res = await chrome.evaluate('window.__g7clamp', 60_000)
  out.clamp = res
  out.clampVerdict =
    `hidden page (${(res?.visibility ?? []).join('/')}): main-thread timer ${res?.timer?.hz} Hz, ` +
    `p50 ${res?.timer?.p50} / max ${res?.timer?.max} ms late — worker beat ${res?.worker?.hz} Hz, ` +
    `p50 ${res?.worker?.p50} / max ${res?.worker?.max} ms late, ${res?.worker?.missed} missed`
  console.error(`g7: ${out.clampVerdict}`)
}

async function laneCost(chrome, out) {
  const ready = await chrome.evaluate('typeof window.__inoutLatenessStart === "function"')
  if (!ready) throw new Error('__inoutLatenessStart is not on this build — cost cannot be measured')
  await chrome.send('Performance.enable')
  const metrics = async () => {
    const r = await chrome.send('Performance.getMetrics')
    const get = (name) => r.metrics.find((m) => m.name === name)?.value ?? 0
    return { task: get('TaskDuration'), script: get('ScriptDuration'), layout: get('LayoutDuration') }
  }
  const windowMs = COST_SEC * 1000
  const on = []
  const off = []
  for (let i = 0; i < COST_REPS; i++) {
    // Alternating, always off first, so a machine that warms or throttles over
    // the run cannot masquerade as the cost of sampling.
    for (const sampling of [false, true]) {
      const before = await metrics()
      const r = await chrome.evaluate(IDLE(windowMs, sampling), windowMs + 60_000)
      const after = await metrics()
      const busyMsPerSec = ((after.task - before.task) / (windowMs / 1000)) * 1000
      ;(sampling ? on : off).push(busyMsPerSec)
      if (sampling && r?.summary) out.costSummary = r.summary
    }
  }
  const mOn = median(on)
  const mOff = median(off)
  const perSec = mOn - mOff
  out.cost = {
    method: 'CDP Performance.getMetrics TaskDuration, idle page, equal windows',
    windowMs,
    reps: COST_REPS,
    offBusyMsPerSec: off.map(r3),
    onBusyMsPerSec: on.map(r3),
    medianOffMsPerSec: r3(mOff),
    medianOnMsPerSec: r3(mOn),
    costMsPerSec: r3(perSec),
    selfReportedMsPerSec: out.costSummary?.selfCostMsPerSec ?? null,
    samplesSeen: out.costSummary?.samples ?? null,
    periodMs: out.costSummary?.periodMs ?? null,
  }
  out.costVerdict =
    `sampling costs ${r3(perSec)} ms of main thread per second ` +
    `(idle page busy ${r3(mOff)} → ${r3(mOn)} ms/s, median of ${COST_REPS} × ${COST_SEC} s); ` +
    `the sampler's own reading: ${out.costSummary?.selfCostMsPerSec ?? '?'} ms/s over ` +
    `${out.costSummary?.samples ?? '?'} samples at ${out.costSummary?.periodMs ?? '?'} ms`
  console.error(`g7: ${out.costVerdict}`)
}

async function laneTake(chrome, out) {
  const started = await chrome.evaluate(
    `(() => { const b = document.querySelector('button.recbtn'); if (!b) return 'no record button'; b.click(); return 'ok' })()`,
  )
  if (started !== 'ok') throw new Error(`could not start a take: ${started}`)
  await sleep(TAKE_SEC * 1000)
  await chrome.evaluate(`(() => { document.querySelector('button.recbtn')?.click(); return 'ok' })()`)
  for (let i = 0; i < 90; i++) {
    const done = await chrome.evaluate(`!!document.querySelector('.tl__ruler')`)
    if (done) break
    await sleep(500)
  }
  const card = await chrome.evalJson(`(async () => JSON.stringify(await window.__inoutReport()))()`)
  const dim = (card?.dimensions ?? []).find((d) => d.id === 'lateness')
  out.take = { verdict: card?.verdict, line: card?.line, lateness: dim }
  out.takeVerdict = `take card ${card?.verdict}: lateness ${dim?.status} — ${dim?.detail}`
  console.error(`g7: ${out.takeVerdict}`)
}

/**
 * THE DRAG, as the timeline's own handler sees one: pointerdown on the ruler,
 * a stream of pointermove at pointer cadence, pointerup. Copied in shape from
 * scripts/editor-drag-cost.mjs so the two rigs measure the same gesture — that
 * script found B10's 35-201 ms stalls with its own in-page ticker, and this one
 * reads them off the PRODUCT'S instrument instead.
 */
const DRAG = (ms) => `
(async () => {
  const el = document.querySelector('.tl__ruler')
  if (!el) return { error: 'no timeline ruler — is the editor open?' }
  const r = el.getBoundingClientRect()
  const y = r.top + r.height / 2
  const x0 = r.left + 8
  const x1 = r.right - 8
  const pd = (type, x) =>
    el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true }))
  pd('pointerdown', x0)
  const t0 = performance.now()
  let moves = 0
  while (performance.now() - t0 < ${ms}) {
    const phase = ((performance.now() - t0) % 4000) / 4000
    pd('pointermove', x0 + (x1 - x0) * (phase < 0.5 ? phase * 2 : 2 - phase * 2))
    moves++
    await new Promise((res) => setTimeout(res, 16))
  }
  pd('pointerup', x1)
  return { moves, ms: Math.round(performance.now() - t0) }
})()
`

async function laneDrag(chrome, out) {
  // The editor's sampler started on its own mount, so the drag has to begin
  // INSIDE that window — which is the point: B10 is the size probe and a drag
  // on the same thread at the same time.
  for (let i = 0; i < 60; i++) {
    if (await chrome.evaluate(`!!document.querySelector('.tl__ruler')`)) break
    await sleep(250)
  }
  out.drag = await chrome.evaluate(DRAG(DRAG_SEC * 1000), 120_000)
  await laneEditor(chrome, out)
  out.dragVerdict = out.editorVerdict
}

async function laneEditor(chrome, out) {
  // The editor's own sampler started on its mount and stops itself at 15 s.
  // Poll rather than sleep: the auto-stop is a timer like any other.
  for (let i = 0; i < 60; i++) {
    const card = await chrome.evalJson(
      `(async () => JSON.stringify(await window.__inoutEditorReport()))()`,
    )
    if (card?.dimensions?.[0]?.status !== 'unmeasured') {
      out.editor = card
      break
    }
    await sleep(1000)
  }
  out.sizeProbe = chrome.consoleLines.filter((l) => l.includes('size probe')).slice(-2)
  const dim = out.editor?.dimensions?.[0]
  out.editorVerdict = `editor card ${out.editor?.verdict}: ${dim?.status} — ${dim?.detail}`
  console.error(`g7: ${out.editorVerdict}`)
}

/* ───────────────────────────── the run ───────────────────────────── */

function allocatePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

async function waitForHttp(url, until) {
  while (Date.now() < until) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  throw new Error(`server never came up at ${url}`)
}

async function main() {
  const bin = resolveChrome()
  const out = { lanes: LANES, takeSec: TAKE_SEC }
  let vite = null
  let base = EXTERNAL
  if (!base) {
    const port = await allocatePort()
    // Vite binds `localhost`, which on this machine is ::1 ALONE — a 127.0.0.1
    // URL is refused and reads as "the server never came up".
    base = `http://localhost:${port}`
    vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
      cwd: ROOT,
      stdio: 'pipe',
    })
    await waitForHttp(`${base}/index.html`, Date.now() + 90_000)
    console.error(`g7: dev server on ${base} (this worktree)`)
  }
  out.url = `${base}/?${QUERY}`

  const profiles = []
  const openChrome = async (throttled) => {
    const profile = mkdtempSync(join(tmpdir(), 'inout-g7-'))
    profiles.push(profile)
    return launchChromeRetrying({ bin, profile, url: out.url, headed: true, throttled })
  }

  let chrome = null
  try {
    // THE CLAMP LANE NEEDS ITS OWN CHROME, and that is the point of it: every
    // other lane runs with background throttling disabled (the rigs' default,
    // because a throttled compositor measures a take nobody records), and this
    // one has to run with it ON.
    if (LANES.includes('clamp')) {
      chrome = await openChrome(true)
      await sleep(2500)
      await laneClamp(chrome, out)
      await quitChrome(chrome).catch(() => undefined)
      chrome = null
    }
    if (LANES.some((l) => ['cost', 'take', 'editor', 'drag'].includes(l))) {
      chrome = await openChrome(false)
      await sleep(2500)
      const visible = await chrome.evaluate('document.visibilityState')
      out.visibility = visible
      if (visible !== 'visible') {
        throw new Error(`the page is ${visible} — every number here would be the clamp`)
      }
      if (LANES.includes('cost')) await laneCost(chrome, out)
      if (LANES.includes('take')) await laneTake(chrome, out)
      // `drag` runs the editor lane itself — asking for both would grade the
      // second 15 s window, which nothing sampled.
      if (LANES.includes('drag')) await laneDrag(chrome, out)
      else if (LANES.includes('editor')) await laneEditor(chrome, out)
    }
    console.log(JSON.stringify(out, null, 2))
  } finally {
    if (chrome) await quitChrome(chrome).catch(() => undefined)
    for (const p of profiles) rmSync(p, { recursive: true, force: true })
    if (vite) {
      vite.kill('SIGTERM')
      setTimeout(() => vite.kill('SIGKILL'), 3000).unref?.()
    }
  }
}

main().catch((err) => {
  console.error(`g7: ${err.message}`)
  process.exit(1)
})
