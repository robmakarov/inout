/**
 * EXPERIMENTAL — F16b's gate: DOES A BACKGROUND RENDER BESIDE A LIVE TAKE COST
 * THE TAKE ANYTHING, AND DOES THE BRAKE ACTUALLY REACH IT?
 *
 * Robert's ruling (2026-09-01, DECISIONS (3)): "render can be parallel to
 * record, it just must not fuck up ... make it elastic too". PERFECT = PARALLEL
 * AND PROVABLY HARMLESS. Provably is this file. Two questions, and neither can
 * be answered by reading the code:
 *
 *   1. THREE-WAY, on the same machine in the same run, over the same take:
 *        no-job        the control — a take with nothing else running.
 *        elastic       the same take with the shipped background render beside
 *                      it, obeying core/backgroundWork.ts.
 *        unthrottled   the same take with the same render and NO brake — the
 *                      POSITIVE CONTROL, i.e. exactly what this task would have
 *                      shipped if the elasticity were decoration. A gate whose
 *                      positive control also passes has measured nothing.
 *      Compared on what the take itself says: delivered fps out of the
 *      composite's own file, the audio counters (padded, silent tail, revivals)
 *      and S1's report card verdict.
 *
 *   2. UNDER INDUCED PRESSURE: with a job working beside a take, load the
 *      machine (pressureLead's own load, the one E1's bands were read from) and
 *      time the brake — how long from the detector first saying `serious` to
 *      the job being fully shed, and from the load lifting to the job climbing
 *      back. Both events come off the broker's own subscription, not off a log
 *      line, so a pace that never changed cannot read as one that did.
 *
 * THE SOURCE THE JOB RENDERS IS A REAL TAKE, recorded by lane 1 through the
 * production session. That is the point: the job in lanes 2-4 is the render a
 * max+camera take actually needs, not a stand-in for it.
 *
 *   node scripts/exp.mjs f16b '{"takeMs":40000}' --query=qstep=max --timeout=1200
 */
import { blobStore, recordingsRepo } from '@core/store'
import { createCaptureSession } from '@core/capture/session'
import {
  resetSyntheticPaintStats,
  setSyntheticScreenSize,
  syntheticPaintStats,
} from '@core/capture/synthetic'
import { buildReportCard, type ReportCard } from '@core/report'
import { onBackgroundWorkChange, type WorkPace } from '@core/backgroundWork'
import { cancelPrerender, prerenderKey, prerenderStatus, startPrerender } from '@core/compose/prerender'
import { exportRecording } from '@core/compose'
import { defaultTierForTake, resolveTier, settingsForTier } from '@core/compose/quality'
import { frameAspectFor } from '@core/frame'
import { takeRate } from '@core/rate'
import { defaultEditState, clampEditState } from '@core/timeline'
import type { Recording } from '@core/types'
import { warmRigEncoder } from '../rigWarm'
import { probeComposite } from './compositorEngine'
import { startLoad } from './pressureLead'

export type LaneId = 'no-job' | 'elastic' | 'unthrottled' | 'no-job-again'

export interface TakeVitals {
  lane: LaneId
  takeMs: number
  /** Frames the composite's own FILE holds, and the rate that works out to. */
  compositeFrames: number | null
  compositeDeliveredFps: number | null
  /** What the synthetic screen managed to paint — a starved source makes every
   *  lane look the same and the comparison worthless, so it is on the record. */
  sourcePaints: number | null
  /** Per audio channel, the counters the report card grades. */
  audio: {
    kind: string
    paddedMs: number | null
    trimmedMs: number | null
    silentTailMs: number | null
    revivals: number | null
    durationMs: number
  }[]
  channelDurationsMs: Record<string, number>
  /**
   * WHAT THE COMPOSITE ITSELF SAID at stop, out of the production console line
   * rather than re-derived here: frames in, frames dropped, peak queue. The
   * delivered-fps comparison above is a ratio of two big numbers and moves for
   * reasons that have nothing to do with a background job; a DROP is the take
   * losing something, which is the thing this gate is actually about.
   */
  compositeSaid: { frames: number | null; dropped: number | null; peakQueue: number | null }
  verdict: ReportCard['verdict']
  reportLine: string
  failedDimensions: string[]
  /** R1's rule: an unmeasured dimension is never a passed one, and it is never
   *  a failed one either. Named, so a verdict can be read honestly. */
  incompleteDimensions: string[]
  /** What the background job did while this take ran. */
  job: {
    ran: boolean
    finished: boolean
    ratioAtStop: number | null
    /** Pace changes seen during the take, in order. */
    paces: { atMs: number; pace: WorkPace; why: string }[]
  }
}

export interface PressureLaneReport {
  loadOnAtMs: number
  loadOffAtMs: number
  /** Whether there was still a job to shed when the load arrived. Without one
   *  this lane measures nothing, and says so rather than reading as a failure. */
  jobStillRunningAtLoad: boolean
  paces: { atMs: number; pace: WorkPace; why: string }[]
  /** First moment the brake was fully shed after the load went on. */
  pausedAfterLoadMs: number | null
  /** First moment it climbed back off `paused` after the load came off. */
  resumedAfterLoadOffMs: number | null
  jobRatioBefore: number | null
  jobRatioAfter: number | null
  verdict: string
}

export interface BackgroundElasticReport {
  takeMs: number
  screen: [number, number]
  source: { recordingId: string; durationMs: number; channels: string[] } | null
  renderSettings: { width: number; height: number; fps: number } | null
  lanes: TakeVitals[]
  pressure: PressureLaneReport | null
  verdict: string[]
}

const round = (x: number, p = 1): number => Math.round(x * 10 ** p) / 10 ** p

/** One take through the PRODUCTION session, exactly as CaptureScreen drives it. */
async function recordTake(takeMs: number): Promise<{ recording: Recording; captureLog: string[] }> {
  resetSyntheticPaintStats()
  const session = await createCaptureSession({
    screen: true,
    camera: true,
    mic: true,
    systemAudio: false,
  })
  const log = tapCaptureLog()
  try {
    session.start()
    await new Promise((r) => setTimeout(r, takeMs))
    const recording = await session.stop()
    return { recording, captureLog: log.lines }
  } finally {
    log.stop()
  }
}

/** The composite's own stop line, parsed rather than re-derived. */
function readCompositeLine(lines: string[]): TakeVitals['compositeSaid'] {
  const line = lines.find((l) => l.includes('composite v2') && l.includes('frames ('))
  if (!line) return { frames: null, dropped: null, peakQueue: null }
  const m = /([\d]+) frames \((\d+) dropped, \d+ keep-alive, peak queue ([\d.]+)\)/.exec(line)
  if (!m) return { frames: null, dropped: null, peakQueue: null }
  return { frames: Number(m[1]), dropped: Number(m[2]), peakQueue: Number(m[3]) }
}

async function vitals(
  lane: LaneId,
  recording: Recording,
  job: TakeVitals['job'],
  captureLog: string[] = [],
): Promise<TakeVitals> {
  let compositeFrames: number | null = null
  let compositeDeliveredFps: number | null = null
  if (recording.composite) {
    try {
      const file = await blobStore.read(recording.composite.blobKey)
      const probe = await probeComposite(file)
      compositeFrames = probe?.frameCount ?? null
      if (compositeFrames !== null && recording.composite.durationMs > 0) {
        compositeDeliveredFps = round((compositeFrames / recording.composite.durationMs) * 1000, 2)
      }
    } catch {
      compositeFrames = null
    }
  }
  const card = buildReportCard(recording)
  return {
    lane,
    takeMs: Math.round(recording.durationMs),
    compositeFrames,
    compositeDeliveredFps,
    sourcePaints: syntheticPaintStats().screen?.paints ?? null,
    audio: recording.channels
      .filter((c) => c.media === 'audio')
      .map((c) => ({
        kind: c.kind,
        paddedMs: c.diagnostics?.paddedMs ?? null,
        trimmedMs: c.diagnostics?.trimmedMs ?? null,
        silentTailMs: c.diagnostics?.silentTailMs ?? null,
        revivals: c.diagnostics?.revivals ?? null,
        durationMs: Math.round(c.durationMs),
      })),
    channelDurationsMs: Object.fromEntries(
      recording.channels.map((c) => [c.kind, Math.round(c.durationMs)]),
    ),
    compositeSaid: readCompositeLine(captureLog),
    verdict: card.verdict,
    reportLine: card.line,
    failedDimensions: card.dimensions.filter((d) => d.status === 'fail').map((d) => d.id),
    incompleteDimensions: card.dimensions.filter((d) => d.status === 'unmeasured').map((d) => d.id),
    job,
  }
}

/**
 * The take's own console, captured. rawTail's precedent: the production path
 * reports itself on the console and nowhere else, and a rig that asked for the
 * same numbers through a second channel would be measuring its own copy.
 */
function tapCaptureLog(): { lines: string[]; stop: () => void } {
  const lines: string[] = []
  const realInfo = console.info
  const realWarn = console.warn
  const tap =
    (real: typeof console.info) =>
    (...a: unknown[]): void => {
      if (typeof a[0] === 'string' && a[0].startsWith('[capture]')) lines.push(a[0])
      real.apply(console, a as [])
    }
  console.info = tap(realInfo)
  console.warn = tap(realWarn)
  return {
    lines,
    stop: () => {
      console.info = realInfo
      console.warn = realWarn
    },
  }
}

/** Free the take's files — four 40 s takes at 60 fps is real disk. */
async function dropTake(recording: Recording): Promise<void> {
  for (const c of recording.channels) await blobStore.remove(c.blobKey).catch(() => undefined)
  if (recording.composite) await blobStore.remove(recording.composite.blobKey).catch(() => undefined)
  await recordingsRepo.remove(recording.id).catch(() => undefined)
}

export async function runBackgroundElastic(
  opts: {
    takeMs?: number
    width?: number
    height?: number
    /** Skip the induced-pressure lane (the three-way alone is ~3 takes). */
    pressureLane?: boolean
    load?: 'cpu' | 'encode' | 'all'
    /** When the load goes on, and for how long, inside the pressure lane. */
    loadAtMs?: number
    loadMs?: number
  } = {},
): Promise<BackgroundElasticReport> {
  const takeMs = opts.takeMs ?? 40_000
  const width = opts.width ?? 1920
  const height = opts.height ?? 1080
  const wantPressureLane = opts.pressureLane !== false
  setSyntheticScreenSize({ width, height })
  // The first VideoEncoder init on a cold page reads 1246 ms of latency and
  // would land inside lane 1 alone (pressureLead's own measurement).
  await warmRigEncoder()

  const report: BackgroundElasticReport = {
    takeMs,
    screen: [width, height],
    source: null,
    renderSettings: null,
    lanes: [],
    pressure: null,
    verdict: [],
  }

  // ---- lane 1: the control, which also becomes the job's source ------------
  const first = await recordTake(takeMs)
  const control = first.recording
  report.lanes.push(
    await vitals('no-job', control, { ran: false, finished: false, ratioAtStop: null, paces: [] }, first.captureLog),
  )
  report.source = {
    recordingId: control.id,
    durationMs: Math.round(control.durationMs),
    channels: control.channels.map((c) => c.kind),
  }

  // The job renders exactly what this take's export panel would ask for.
  const edit = clampEditState(control, defaultEditState(control))
  const aspect = frameAspectFor(control)
  const settings = settingsForTier(resolveTier(defaultTierForTake(control, aspect), aspect, takeRate(control)))
  report.renderSettings = { width: settings.width, height: settings.height, fps: settings.fps }

  /** Watch the broker for the whole of a lane. */
  function watchPaces(t0: number): { paces: TakeVitals['job']['paces']; stop: () => void } {
    const paces: TakeVitals['job']['paces'] = []
    const off = onBackgroundWorkChange((s) => {
      const last = paces[paces.length - 1]
      if (last && last.pace === s.pace) return
      paces.push({ atMs: Math.round(performance.now() - t0), pace: s.pace, why: s.why })
    })
    return { paces, stop: off }
  }

  // ---- lane 2: the same take with the ELASTIC job beside it ----------------
  {
    const t0 = performance.now()
    const watch = watchPaces(t0)
    startPrerender({ recording: control, edit, settings }, 'stop')
    const key = prerenderKey({ recording: control, edit, settings })
    const { recording: take, captureLog } = await recordTake(takeMs)
    const status = prerenderStatus(key)
    watch.stop()
    report.lanes.push(
      await vitals(
        'elastic',
        take,
        {
          ran: true,
          finished: status?.state === 'done',
          ratioAtStop: status ? round(status.ratio, 3) : null,
          paces: watch.paces,
        },
        captureLog,
      ),
    )
    cancelPrerender()
    await dropTake(take)
  }

  // ---- lane 3: THE POSITIVE CONTROL — the same render, no brake ------------
  {
    const t0 = performance.now()
    const watch = watchPaces(t0)
    const abort = new AbortController()
    let ratio = 0
    let finished = false
    // No `pace`: this is exportRecording exactly as a user-visible export runs
    // it, which is what a background job WITHOUT F16b's brake would be.
    const unthrottled = exportRecording({
      recording: control,
      edit,
      settings,
      signal: abort.signal,
      onProgress: (p) => {
        ratio = p.ratio
      },
    })
      .then((r) => {
        finished = true
        if (r.scratchKey) void blobStore.remove(r.scratchKey).catch(() => undefined)
      })
      .catch(() => undefined)
    const { recording: take, captureLog } = await recordTake(takeMs)
    watch.stop()
    report.lanes.push(
      await vitals(
        'unthrottled',
        take,
        { ran: true, finished, ratioAtStop: round(ratio, 3), paces: watch.paces },
        captureLog,
      ),
    )
    abort.abort()
    await unthrottled
    await dropTake(take)
  }

  // ---- lane 4: the brake under INDUCED pressure ----------------------------
  if (wantPressureLane) {
    const loadAtMs = opts.loadAtMs ?? 8000
    const loadMs = opts.loadMs ?? 14_000
    const t0 = performance.now()
    const watch = watchPaces(t0)
    // THE JOB HAS TO OUTLIVE THE LOAD or this lane measures nothing. The first
    // run of this cell shed nothing and reported it as a failure, when what had
    // actually happened is that a 40 s take's render finished at 24 s — before
    // the load was even lifted. A render of the SOURCE step is the longest job
    // this take can produce, and the lane now says outright whether one was
    // still running when the load arrived.
    startPrerender({ recording: control, edit, settings }, 'stop')
    const key = prerenderKey({ recording: control, edit, settings })
    resetSyntheticPaintStats()
    const session = await createCaptureSession({ screen: true, camera: true, mic: true, systemAudio: false })
    session.start()
    await new Promise((r) => setTimeout(r, loadAtMs))
    const before = prerenderStatus(key)
    const loadOnAtMs = Math.round(performance.now() - t0)
    const load = startLoad(opts.load ?? 'all')
    await new Promise((r) => setTimeout(r, loadMs))
    const loadOffAtMs = Math.round(performance.now() - t0)
    load.stop()
    await new Promise((r) => setTimeout(r, Math.max(3000, takeMs - loadAtMs - loadMs)))
    const after = prerenderStatus(key)
    const take = await session.stop()
    watch.stop()
    cancelPrerender()
    const pausedAt = watch.paces.find((p) => p.atMs >= loadOnAtMs && p.pace === 'paused')
    const resumedAt = watch.paces.find(
      (p) => pausedAt !== undefined && p.atMs > pausedAt.atMs && p.pace !== 'paused',
    )
    const stillRunning = before?.state === 'running'
    report.pressure = {
      loadOnAtMs,
      loadOffAtMs,
      jobStillRunningAtLoad: stillRunning,
      paces: watch.paces,
      pausedAfterLoadMs: pausedAt ? pausedAt.atMs - loadOnAtMs : null,
      resumedAfterLoadOffMs: resumedAt ? resumedAt.atMs - loadOffAtMs : null,
      jobRatioBefore: before ? round(before.ratio, 3) : null,
      jobRatioAfter: after ? round(after.ratio, 3) : null,
      verdict: !stillRunning
        ? 'INCONCLUSIVE — the job had already finished when the load arrived, so there was nothing to shed'
        : pausedAt === undefined
          ? 'THE BRAKE NEVER FIRED — a job was running and the detector never called the load serious'
          : `shed ${pausedAt.atMs - loadOnAtMs} ms after the load went on` +
            (resumedAt
              ? `, back to ${resumedAt.pace} ${resumedAt.atMs - loadOffAtMs} ms after it lifted`
              : ', and never came back'),
    }
    await dropTake(take)
  }

  // ---- lane 5: the control AGAIN, last -------------------------------------
  // Four takes apart, on a page that has since run two renders and a load: if
  // the two controls disagree, the differences between the lanes above are
  // drift and not a background job, and the run says so instead of ranking
  // noise.
  {
    const again = await recordTake(takeMs)
    report.lanes.push(
      await vitals(
        'no-job-again',
        again.recording,
        { ran: false, finished: false, ratioAtStop: null, paces: [] },
        again.captureLog,
      ),
    )
    await dropTake(again.recording)
  }

  await dropTake(control)

  // ---- the verdict --------------------------------------------------------
  const byLane = new Map(report.lanes.map((l) => [l.lane, l]))
  const control0 = byLane.get('no-job')
  const controlAgain = byLane.get('no-job-again')
  if (control0 && controlAgain && control0.compositeDeliveredFps !== null && controlAgain.compositeDeliveredFps !== null) {
    report.verdict.push(
      `control drift: ${control0.compositeDeliveredFps} fps first, ${controlAgain.compositeDeliveredFps} fps last ` +
        `(${round(controlAgain.compositeDeliveredFps - control0.compositeDeliveredFps, 2)}) · ` +
        `dropped ${control0.compositeSaid.dropped ?? '?'} then ${controlAgain.compositeSaid.dropped ?? '?'} — ` +
        'any lane difference smaller than this is drift',
    )
  }
  for (const lane of ['elastic', 'unthrottled'] as LaneId[]) {
    const l = byLane.get(lane)
    if (!l || !control0) continue
    /**
     * AGAINST THE MEAN OF THE TWO CONTROLS THAT BRACKET IT, not against the
     * first one. Measured over four runs 2026-09-02: the two control takes in
     * one run differ by -1.6, +2.6, +6.5 and -9.5 fps — the page gets faster
     * or slower across five takes for reasons that have nothing to do with a
     * background job, and any single-control comparison is reading that drift.
     * The bracketing mean cancels the monotone part of it, and it is what made
     * this run separate: elastic -0.69 fps on average, unthrottled -4.16, the
     * worst lane in all four runs.
     */
    const controlFps =
      control0.compositeDeliveredFps !== null && controlAgain?.compositeDeliveredFps != null
        ? (control0.compositeDeliveredFps + controlAgain.compositeDeliveredFps) / 2
        : control0.compositeDeliveredFps
    const dFps =
      l.compositeDeliveredFps !== null && controlFps !== null
        ? round(l.compositeDeliveredFps - controlFps, 2)
        : null
    const tail = l.audio.reduce((m, a) => Math.max(m, a.silentTailMs ?? 0), 0)
    const controlTail = control0.audio.reduce((m, a) => Math.max(m, a.silentTailMs ?? 0), 0)
    const revivals = l.audio.reduce((m, a) => m + (a.revivals ?? 0), 0)
    const controlRevivals = control0.audio.reduce((m, a) => m + (a.revivals ?? 0), 0)
    report.verdict.push(
      `${lane}: dropped ${l.compositeSaid.dropped ?? '?'} vs ${control0.compositeSaid.dropped ?? '?'} · ` +
        `delivered ${l.compositeDeliveredFps ?? 'unmeasured'} fps vs ${controlFps === null ? 'unmeasured' : round(controlFps, 2)} bracketing control ` +
        `(${dFps === null ? 'unmeasured' : dFps > 0 ? `+${dFps}` : dFps}) · silentTail ${tail} vs ${controlTail} ms · ` +
        `revivals ${revivals} vs ${controlRevivals} · report ${l.verdict}${l.failedDimensions.length ? ` (${l.failedDimensions.join(', ')})` : ''} · ` +
        `job ${l.job.finished ? 'finished' : `${Math.round((l.job.ratioAtStop ?? 0) * 100)}%`}`,
    )
  }
  if (report.pressure) report.verdict.push(`pressure lane: ${report.pressure.verdict}`)
  return report
}
