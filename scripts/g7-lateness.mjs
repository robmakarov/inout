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
const COST_PERIODS = arg('periods', '16,32,64').split(',').map(Number)
const DRAG_SEC = Number(arg('drag', '13'))
/** B10's gate is the drag WITHOUT the wait — `--waitprobe` puts the wait back
 *  (the control editor-drag-cost.mjs takes today). */
const WAIT_PROBE = args.includes('--waitprobe')
const EXTERNAL = arg('url', '')
/** Measure on the PRODUCTION bundle. The dev server serves ~500 unbundled ES
 *  modules and an HMR client; a cost number read there is not the cost a take
 *  pays. `npm run build` then `vite preview`. */
const BUILD = args.includes('--build')
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
/**
 * THE CONTROL: a bare `setInterval(16)` that does NOTHING. If waking a parked
 * renderer 62 times a second costs about what the sampler costs, then the price
 * is the wake-up and not the instrument — and the number that matters is the
 * one measured while a take is already running, where the thread is awake
 * anyway. That is `costtake` below.
 */
const BARE_TIMER = (ms, periodMs) => `
(async () => {
  let n = 0
  const iv = setInterval(() => { n++ }, ${periodMs})
  await new Promise((r) => setTimeout(r, ${ms}))
  clearInterval(iv)
  return { summary: null, ticks: n }
})()
`

/**
 * THE SECOND CONTROL: a worker posting the same beat at the same rate, with an
 * EMPTY main-thread handler. Whatever this costs is the floor of ANY worker-clock
 * design — it is the price of waking the main thread, not of measuring anything —
 * and the difference between it and the sampler is the only part I can optimise.
 */
const BARE_BEAT = (ms, periodMs) => `
(async () => {
  const src = 'let s=0,t=null,p=' + ${periodMs} + ';onmessage=(e)=>{if(e.data.go){const b=performance.now();' +
    '(function tick(){const n=performance.now();s++;postMessage(performance.timeOrigin+b+s*p);' +
    'let x=b+(s+1)*p; if(x<=n){s=Math.ceil((n-b)/p);x=b+(s+1)*p} t=setTimeout(tick,x-n)})()}else{clearTimeout(t);close()}}'
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
  let n = 0
  w.onmessage = () => { n++ }
  w.postMessage({ go: true })
  await new Promise((r) => setTimeout(r, ${ms}))
  w.postMessage({ go: false })
  w.terminate()
  return { summary: null, beats: n }
})()
`

const IDLE = (ms, opts) => `
(async () => {
  ${opts ? `const run = await window.__inoutLatenessStart(${JSON.stringify(opts)})` : ''}
  await new Promise((r) => setTimeout(r, ${ms}))
  ${opts ? 'const summary = run.stop()' : 'const summary = null'}
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
  // THE SWEEP, because "what does it cost" has two knobs and the answer has to
  // say which one is spending: the beat rate (a task per beat) and the
  // long-animation-frame observer (which reports nothing on a hidden document
  // and so is pure cost during a take).
  const configs = [
    { label: 'off', opts: null },
    { label: `control: bare setInterval(${COST_PERIODS[0]})`, bare: COST_PERIODS[0] },
    { label: `control: bare worker beat ${COST_PERIODS[0]}ms`, bareBeat: COST_PERIODS[0] },
    ...COST_PERIODS.map((periodMs) => ({ label: `${periodMs}ms`, opts: { periodMs, owners: false } })),
    { label: `${COST_PERIODS[0]}ms+owners`, opts: { periodMs: COST_PERIODS[0], owners: true } },
  ]
  const busy = new Map(configs.map((c) => [c.label, []]))
  for (let i = 0; i < COST_REPS; i++) {
    for (const c of configs) {
      const before = await metrics()
      const r = await chrome.evaluate(
        c.bare
          ? BARE_TIMER(windowMs, c.bare)
          : c.bareBeat
            ? BARE_BEAT(windowMs, c.bareBeat)
            : IDLE(windowMs, c.opts),
        windowMs + 60_000,
      )
      const after = await metrics()
      busy.get(c.label).push(((after.task - before.task) / (windowMs / 1000)) * 1000)
      if (c.opts && r?.summary) out.costSummary = r.summary
    }
  }
  const idle = median(busy.get('off'))
  const rows = configs
    .filter((c) => c.label !== 'off')
    .map((c) => ({
      config: c.label,
      busyMsPerSec: r3(median(busy.get(c.label))),
      costMsPerSec: r3(median(busy.get(c.label)) - idle),
      samples: busy.get(c.label).map(r3),
    }))
  out.cost = {
    method: 'CDP Performance.getMetrics TaskDuration, idle page, equal windows',
    build: BUILD ? 'production bundle (vite preview)' : 'dev server',
    windowMs,
    reps: COST_REPS,
    idleBusyMsPerSec: r3(idle),
    rows,
    selfReportedMsPerSec: out.costSummary?.selfCostMsPerSec ?? null,
  }
  out.costVerdict =
    `idle page ${r3(idle)} ms/s busy; ` +
    rows.map((r) => `${r.config} +${r.costMsPerSec} ms/s`).join(' · ') +
    ` (${BUILD ? 'built bundle' : 'dev server'}, ${COST_REPS} × ${COST_SEC} s)`
  console.error(`g7: ${out.costVerdict}`)
}

/**
 * THE GATE'S OWN CONDITION: "< 1 ms per second OF CAPTURE".
 *
 * The idle-page lane measures what it costs to wake a renderer that is parked;
 * a recording take does not park. So this alternates equal windows INSIDE ONE
 * RUNNING TAKE — sampler off, sampler on — and reads the renderer's main-thread
 * busy time across each. Same take, same encoders, same preview: the only
 * difference between the two windows is the instrument.
 */
async function laneCostTake(chrome, out) {
  await chrome.send('Performance.enable')
  const metrics = async () => {
    const r = await chrome.send('Performance.getMetrics')
    const get = (name) => r.metrics.find((m) => m.name === name)?.value ?? 0
    return { task: get('TaskDuration'), script: get('ScriptDuration') }
  }
  const started = await chrome.evaluate(
    `(() => { const b = document.querySelector('button.recbtn'); if (!b) return 'no record button'; b.click(); return 'ok' })()`,
  )
  if (started !== 'ok') throw new Error(`could not start a take: ${started}`)
  await sleep(4000) // let arming settle: the first seconds are not steady state
  const windowMs = COST_SEC * 1000
  const on = []
  const off = []
  const onScript = []
  const offScript = []
  for (let i = 0; i < COST_REPS; i++) {
    for (const sampling of [false, true]) {
      const before = await metrics()
      const r = await chrome.evaluate(
        IDLE(windowMs, sampling ? { periodMs: COST_PERIODS[0], owners: false } : null),
        windowMs + 60_000,
      )
      const after = await metrics()
      const perSec = (x) => ((x / (windowMs / 1000)) * 1000)
      ;(sampling ? on : off).push(perSec(after.task - before.task))
      ;(sampling ? onScript : offScript).push(perSec(after.script - before.script))
      if (sampling && r?.summary) out.costTakeSummary = r.summary
    }
  }
  await chrome.evaluate(`(() => { document.querySelector('button.recbtn')?.click(); return 'ok' })()`)
  const cost = median(on) - median(off)
  out.costTake = {
    method: 'CDP TaskDuration, alternating windows INSIDE one running take',
    periodMs: COST_PERIODS[0],
    windowMs,
    reps: COST_REPS,
    offBusyMsPerSec: off.map(r3),
    onBusyMsPerSec: on.map(r3),
    offScriptMsPerSec: offScript.map(r3),
    onScriptMsPerSec: onScript.map(r3),
    costMsPerSec: r3(cost),
    costScriptMsPerSec: r3(median(onScript) - median(offScript)),
    samplesSeen: out.costTakeSummary?.samples ?? null,
  }
  // RESOLUTION, STATED WITH THE NUMBER. A take's own main thread runs at
  // 460-565 ms/s busy and swings ±100 ms/s between 8 s windows, so a 1 ms/s
  // effect is not in this lane's reach — one run of it read −103 ms/s, i.e. the
  // sampled window was "cheaper" than the unsampled one. Quote the spread so
  // nobody reads the delta as a measurement when it is not one.
  const spread = Math.max(...off, ...on) - Math.min(...off, ...on)
  out.costTake.spreadMsPerSec = r3(spread)
  out.costTake.resolvable = Math.abs(cost) > spread / 2
  out.costTakeVerdict =
    `DURING CAPTURE at ${COST_PERIODS[0]} ms: main thread busy ${r3(median(off))} → ${r3(median(on))} ms/s ` +
    `(${cost >= 0 ? '+' : ''}${r3(cost)}), script ${r3(median(offScript))} → ${r3(median(onScript))} ms/s; ` +
    `${COST_REPS} × ${COST_SEC} s windows inside one take; window-to-window spread ${r3(spread)} ms/s — ` +
    `${Math.abs(cost) > spread / 2 ? 'resolvable' : 'NOT RESOLVABLE at this load, read the idle-page lane instead'}`
  console.error(`g7: ${out.costTakeVerdict}`)
}

async function laneTake(chrome, out) {
  const started = await chrome.evaluate(
    `(() => { const b = document.querySelector('button.recbtn'); if (!b) return 'no record button'; b.click(); return 'ok' })()`,
    120_000,
  )
  if (started !== 'ok') throw new Error(`could not start a take: ${started}`)
  await sleep(TAKE_SEC * 1000)
  await chrome.evaluate(`(() => { document.querySelector('button.recbtn')?.click(); return 'ok' })()`)
  for (let i = 0; i < 90; i++) {
    const done = await chrome.evaluate(`!!document.querySelector('.tl__ruler')`, 120_000)
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
    if (await chrome.evaluate(`!!document.querySelector('.tl__ruler')`, 120_000)) break
    await sleep(250)
  }
  out.drag = await chrome.evaluate(DRAG(DRAG_SEC * 1000), 120_000)
  await laneEditor(chrome, out)
  out.dragVerdict = out.editorVerdict
}

/**
 * THE TWO INSTRUMENTS, ONE DRAG — and this lane exists because they disagreed.
 *
 * editor-drag-cost.mjs measured 35-201 ms stalls with a MAIN-THREAD
 * `setInterval(16)` ticker (`now - last - period`); the product's sampler, on
 * the same shape of take and the same drag, read a worst second of 16.2 ms. One
 * of those is wrong and no amount of reasoning settles which, so both run in the
 * SAME page over the SAME drag and the answer is the pair.
 *
 * The two are not measuring quite the same thing, which is the hypothesis under
 * test: an interval ticker measures the gap between ITS OWN callbacks (a task
 * that is itself queued behind the drag handlers), and the worker beat measures
 * how long the main thread took to accept an arrival it did not schedule.
 */
const DRAGCMP = (ms) => `
(async () => {
  const el = document.querySelector('.tl__ruler')
  if (!el) return { error: 'no timeline ruler — is the editor open?' }
  const r = el.getBoundingClientRect()
  const y = r.top + r.height / 2
  const x0 = r.left + 8
  const x1 = r.right - 8

  // (1) the product's own instrument, driven for exactly this window
  const run = await window.__inoutLatenessStart({ periodMs: 16 })

  // (2) editor-drag-cost.mjs's ticker, verbatim in shape
  const period = 16
  const late = []
  const spikes = []
  const t00 = performance.now()
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const l = Math.max(0, now - last - period)
    late.push(l)
    if (l > 30) spikes.push({ atMs: Math.round(now - t00), lateMs: Math.round(l) })
    last = now
  }, period)

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
  clearInterval(timer)
  const summary = run.stop()

  late.sort((a, b) => a - b)
  const at = (q) => (late.length ? Math.round(late[Math.min(late.length - 1, Math.floor(q * late.length))] * 10) / 10 : null)
  return {
    moves,
    ticker: {
      ticks: late.length,
      hz: Math.round((late.length / (${ms} / 1000)) * 10) / 10,
      p50LateMs: at(0.5),
      p95LateMs: at(0.95),
      maxLateMs: late.length ? Math.round(late[late.length - 1] * 10) / 10 : null,
      totalLateMs: Math.round(late.reduce((a, b) => a + b, 0)),
      spikes,
    },
    sampler: summary,
  }
})()
`

async function laneDragCmp(chrome, out) {
  for (let i = 0; i < 60; i++) {
    if (await chrome.evaluate(`!!document.querySelector('.tl__ruler')`, 120_000)) break
    await sleep(250)
  }
  // Wait out the size probe or not — B10's gate is the run WITHOUT the wait,
  // which is the window its stalls were measured in.
  if (WAIT_PROBE) {
    for (let i = 0; i < 120; i++) {
      if (chrome.consoleLines.some((l) => l.includes('size probe'))) break
      await sleep(500)
    }
    await sleep(1000)
  }
  const probeBefore = chrome.consoleLines.filter((l) => l.includes('size probe')).length
  const r = await chrome.evaluate(DRAGCMP(DRAG_SEC * 1000), 180_000)
  out.dragcmp = r
  // Did B10's own suspect actually run inside the window this measured?
  const probes = chrome.consoleLines.filter((l) => l.includes('size probe'))
  out.sizeProbe = probes.slice(-2)
  out.sizeProbeInsideDrag = probes.length > probeBefore
  const t = r?.ticker
  const sm = r?.sampler
  out.dragcmpVerdict =
    `same drag, two instruments — interval ticker: p50 ${t?.p50LateMs} / p95 ${t?.p95LateMs} / max ` +
    `${t?.maxLateMs} ms over ${t?.ticks} ticks (${t?.spikes?.length ?? 0} spikes > 30 ms); ` +
    `worker beat: p50 ${sm?.p50Ms} / p95 ${sm?.p95Ms} / max ${sm?.maxMs} ms over ${sm?.samples} samples, ` +
    `worst second ${sm?.worstWindows?.[0]?.maxMs} ms at ${(sm?.worstWindows?.[0]?.startMs ?? 0) / 1000}s`
  console.error(`g7: ${out.dragcmpVerdict}`)
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
    if (BUILD) {
      console.error('g7: building the production bundle (npm run build) …')
      await new Promise((res, rej) => {
        const b = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
        b.on('exit', (code) => (code === 0 ? res() : rej(new Error(`build failed (${code})`))))
      })
    }
    vite = spawn(
      'npm',
      BUILD
        ? ['run', 'preview', '--', '--port', String(port), '--strictPort']
        : ['run', 'dev', '--', '--port', String(port), '--strictPort'],
      { cwd: ROOT, stdio: 'pipe' },
    )
    await waitForHttp(`${base}/index.html`, Date.now() + 120_000)
    console.error(`g7: ${BUILD ? 'preview (built bundle)' : 'dev server'} on ${base}`)
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
    if (LANES.some((l) => ['cost', 'costtake', 'take', 'editor', 'drag', 'dragcmp'].includes(l))) {
      chrome = await openChrome(false)
      await sleep(2500)
      const visible = await chrome.evaluate('document.visibilityState')
      out.visibility = visible
      if (visible !== 'visible') {
        throw new Error(`the page is ${visible} — every number here would be the clamp`)
      }
      if (LANES.includes('cost')) await laneCost(chrome, out)
      if (LANES.includes('costtake')) await laneCostTake(chrome, out)
      if (LANES.includes('take')) await laneTake(chrome, out)
      // `drag` runs the editor lane itself — asking for both would grade the
      // second 15 s window, which nothing sampled.
      if (LANES.includes('dragcmp')) await laneDragCmp(chrome, out)
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
