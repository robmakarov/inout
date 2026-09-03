/**
 * EXPERIMENTAL — M1's gate: DOES THE EMERGENCY FLOOR CATCH A MAX TAKE, AND DOES
 * IT COST A CALM ONE ANYTHING?
 *
 * The task's gates, in the order they are answered here, and none of them can
 * be read off the code:
 *
 *   1. WITHOUT THE SPIKE, NOTHING ENGAGES. A calm max take with the floor armed
 *      must take no rung at all — the flag's whole promise is that it is inert
 *      until the detector says starvation is coming. `calm` lane.
 *   2. WITH THE SPIKE: audio silentTail 0, picture loss bounded, recovery
 *      automatic, every event in the take's own ledger. `floor` lane.
 *   3. AND THE POSITIVE CONTROL. The same spike on the same machine with the
 *      floor OFF — max as it ships today. A gate whose control also passes has
 *      measured nothing, so this lane is what says whether the floor did
 *      anything at all. `off` lane.
 *
 * WHY IT DRIVES THE PRODUCTION SESSION rather than the raw worker directly: at
 * max the session opens two raw encoders and NO composite, and the whole
 * question is what that arrangement does under load. A rig that drove the
 * worker alone would be measuring a different program.
 *
 * THE FLAGS ARE SET THROUGH THEIR SETTERS, NOT THE URL, because `?quality=` and
 * `?floor=` take precedence over the sticky value and a lane could then not turn
 * its own subject off.
 *
 *   node scripts/exp.mjs floor '{"takeMs":40000}' --headed --timeout=1200 \\
 *     --query='screenfps=60&camfps=60'      <- REQUIRED for a 60 fps source
 *
 * HEAVY: it saturates the machine on purpose, three times.
 */
import { createCaptureSession } from '@core/capture/session'
import { setCompositeFault } from '@core/capture/liveCompositeV2'
import {
  resetSyntheticPaintStats,
  setSyntheticCameraFps,
  setSyntheticScreenFps,
  setSyntheticScreenSize,
  syntheticPaintStats,
} from '@core/capture/synthetic'
import { buildReportCard, type ReportCard } from '@core/report'
import { captureQualityMode, setCaptureQualityMode } from '@core/capture/captureQuality'
import { loadQualityStep, setQualityStep } from '@core/qualityStep'
import { emergencyFloorEnabled, setEmergencyFloor } from '@core/capture/emergencyFloor'
import type { DoorDecision, Recording } from '@core/types'
import { warmRigEncoder } from '../rigWarm'
import { captureRateCeiling, sourceRateEnabled } from '@core/rate'
import { startLoad } from './pressureLead'

export type FloorLaneId = 'calm' | 'floor' | 'off' | 'composite-drop'

export interface FloorLaneReport {
  lane: FloorLaneId
  floorArmed: boolean
  loaded: boolean
  takeMs: number
  loadOnAtMs: number | null
  loadOffAtMs: number | null
  /** THE DOOR'S LEDGER, as the take persisted it. */
  decisions: DoorDecision[]
  /** Only the ones the floor itself took. */
  floorDecisions: DoorDecision[]
  /** ms from the load starting to the floor's first shed. Null if it never engaged. */
  engagedAfterLoadMs: number | null
  /** ms from the load lifting to the last restore. Null if nothing came back. */
  recoveredAfterLoadOffMs: number | null
  /** Every audio channel's continuity — the gate is silentTail 0. */
  audio: { kind: string; durationMs: number; silentTailMs: number | null; paddedMs: number | null; revivals: number | null }[]
  /** Every video channel as the take wrote it, in order: a resolution rung
   *  SEGMENTS the screen, so a second screen row here is the seam. */
  video: { kind: string; width?: number; height?: number; fps?: number; startOffsetMs: number; durationMs: number }[]
  /** The unrecorded gap between consecutive screen segments, ms — O16's band is
   *  a 30 ms step and a 69 ms seam. */
  screenSeamsMs: number[]
  /** What the synthetic source managed to paint. A starved source makes every
   *  lane look alike and the comparison worthless, so it is on the record. */
  sourcePaints: number | null
  /** THE SETTINGS THIS LANE ACTUALLY RAN UNDER, read from the product's own
   *  answers rather than from what the rig meant to set. */
  env: { qualityStep: string; qualityMode: string; sourceRate: boolean; rateCeiling: number; floorFlag: boolean } | null
  /** What the LIVE TRACKS said they were delivering, 300 ms into the take. */
  sourceTracks: { screen: { fps: number | null; width: number | null } | null; camera: { fps: number | null; width: number | null } | null } | null
  /** WHAT THE TAKE WAS ACTUALLY MADE AT, read off the take rather than assumed:
   *  the first run of this rig reported a "max" lane that recorded 1920x1080@30
   *  because the quality STEP was still 1080p, and nothing in the report said so. */
  recordedAt: { width?: number; height?: number; fps?: number } | null
  card: { verdict: ReportCard['verdict']; line: string; dimensions: { id: string; status: string; detail: string }[] }
  error?: string
}

export interface FloorSpikeReport {
  takeMs: number
  loadMs: number
  screen: { width: number; height: number }
  lanes: FloorLaneReport[]
  verdicts: {
    compositeDropRecorded: boolean | null
    calmTookNoRung: boolean | null
    floorEngaged: boolean | null
    audioNeverSacrificed: boolean | null
    orderHeld: boolean | null
    recoveredAutomatically: boolean | null
    line: string
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function laneReport(lane: FloorLaneId, opts: { floorArmed: boolean; loaded: boolean; takeMs: number }): FloorLaneReport {
  return {
    lane,
    floorArmed: opts.floorArmed,
    loaded: opts.loaded,
    takeMs: opts.takeMs,
    loadOnAtMs: null,
    loadOffAtMs: null,
    decisions: [],
    floorDecisions: [],
    engagedAfterLoadMs: null,
    recoveredAfterLoadOffMs: null,
    audio: [],
    video: [],
    screenSeamsMs: [],
    sourcePaints: null,
    env: null,
    sourceTracks: null,
    recordedAt: null,
    card: { verdict: 'incomplete', line: '', dimensions: [] },
  }
}

function readTake(rec: Recording, out: FloorLaneReport): void {
  const decisions = rec.stopStats?.decisions ?? []
  out.decisions = decisions
  out.floorDecisions = decisions.filter((d) => d.decidedBy === 'floor')
  const firstShed = out.floorDecisions.find((d) => d.action === 'shed' && d.outcome === 'applied')
  const lastRestore = [...out.floorDecisions].reverse().find((d) => d.action === 'restore' && d.outcome === 'applied')
  if (firstShed && out.loadOnAtMs !== null) out.engagedAfterLoadMs = Math.round(firstShed.atMs - out.loadOnAtMs)
  if (lastRestore && out.loadOffAtMs !== null) {
    out.recoveredAfterLoadOffMs = Math.round(lastRestore.atMs - out.loadOffAtMs)
  }
  out.audio = rec.channels
    .filter((c) => c.media === 'audio')
    .map((c) => ({
      kind: c.kind,
      durationMs: Math.round(c.durationMs),
      silentTailMs: c.diagnostics?.silentTailMs ?? null,
      paddedMs: c.diagnostics?.paddedMs ?? null,
      revivals: c.diagnostics?.revivals ?? null,
    }))
  out.video = rec.channels
    .filter((c) => c.media === 'video')
    .map((c) => ({
      kind: c.kind,
      ...(c.width ? { width: c.width } : null),
      ...(c.height ? { height: c.height } : null),
      ...(c.fps ? { fps: c.fps } : null),
      startOffsetMs: Math.round(c.startOffsetMs),
      durationMs: Math.round(c.durationMs),
    }))
  const screens = rec.channels
    .filter((c) => c.media === 'video' && c.kind === 'screen')
    .sort((a, b) => a.startOffsetMs - b.startOffsetMs)
  for (let i = 1; i < screens.length; i++) {
    const prev = screens[i - 1]!
    const next = screens[i]!
    out.screenSeamsMs.push(Math.round(next.startOffsetMs - (prev.startOffsetMs + prev.durationMs)))
  }
  const screen0 = screens[0]
  out.recordedAt = screen0
    ? {
        ...(screen0.width ? { width: screen0.width } : null),
        ...(screen0.height ? { height: screen0.height } : null),
        ...(screen0.fps ? { fps: screen0.fps } : null),
      }
    : null
  const card = buildReportCard(rec)
  out.card = {
    verdict: card.verdict,
    line: card.line,
    dimensions: card.dimensions.map((d) => ({ id: d.id, status: d.status, detail: d.detail })),
  }
}

async function runLane(opts: {
  lane: FloorLaneId
  floorArmed: boolean
  loaded: boolean
  takeMs: number
  loadAtMs: number
  loadMs: number
  load: 'none' | 'cpu' | 'encode' | 'all'
}): Promise<FloorLaneReport> {
  const out = laneReport(opts.lane, opts)
  /**
   * THE COMPOSITE-DROP LANE — the third path S1's folded-in gate names by hand
   * ("a rate step, a composite drop and a codec fallback each append an entry
   * THROUGH THE DOOR"). It is the only one of the three that needs a composite,
   * so this lane leaves `auto` alone and injects the REAL watchdog degrade the
   * o4wedge rig uses — the same call the watchdog makes, not a stand-in.
   */
  if (opts.lane === 'composite-drop') {
    setQualityStep(null)
    setCaptureQualityMode('auto')
    setEmergencyFloor(false)
    setCompositeFault({ degradeAfterMs: Math.round(opts.takeMs * 0.35) })
  }
  // MAX IS THE SUBJECT, AND IT IS TWO SETTINGS, NOT ONE — a distinction that
  // cost this rig its first run (a "max" take that recorded 1920x1080@30 and
  // was never under any strain at all):
  //   · the quality STEP is the pixel budget and the rate. `max` = the take's
  //     own long edge at 60 fps, which is what makes it a max60 take.
  //   · the quality MODE is the protection: `max` opens no composite, refuses
  //     nothing in advance, and runs no ladder — which is what makes an
  //     emergency floor necessary in the first place.
  if (opts.lane !== 'composite-drop') {
    setQualityStep('max')
    setCaptureQualityMode('max')
    setEmergencyFloor(opts.floorArmed)
  }
  resetSyntheticPaintStats()
  out.env = {
    qualityStep: loadQualityStep(),
    qualityMode: captureQualityMode(),
    sourceRate: sourceRateEnabled(),
    rateCeiling: captureRateCeiling(),
    floorFlag: emergencyFloorEnabled(),
  }
  const session = await createCaptureSession({ screen: true, camera: true, mic: true, systemAudio: true })
  const t0 = performance.now()
  try {
    session.start()
    // WHAT THE SOURCE ITSELF SAYS IT IS DELIVERING, read off the live track a
    // moment after the press. The take's own `fps` field is what the CHANNEL
    // recorded, and when the two disagree the rig has been measuring a
    // different take than it thought it was.
    await sleep(300)
    const screenTrack = session.previewStreams.screen?.getVideoTracks()[0]
    const cameraTrack = session.previewStreams.camera?.getVideoTracks()[0]
    out.sourceTracks = {
      screen: screenTrack ? { fps: screenTrack.getSettings().frameRate ?? null, width: screenTrack.getSettings().width ?? null } : null,
      camera: cameraTrack ? { fps: cameraTrack.getSettings().frameRate ?? null, width: cameraTrack.getSettings().width ?? null } : null,
    }
    if (opts.loaded) {
      await sleep(Math.max(0, opts.loadAtMs - 300))
      out.loadOnAtMs = Math.round(performance.now() - t0)
      const load = startLoad(opts.load)
      await sleep(opts.loadMs)
      out.loadOffAtMs = Math.round(performance.now() - t0)
      load.stop()
      await sleep(Math.max(4000, opts.takeMs - opts.loadAtMs - opts.loadMs))
    } else {
      await sleep(Math.max(0, opts.takeMs - 300))
    }
    const rec = await session.stop()
    out.sourcePaints = syntheticPaintStats().screen?.paints ?? null
    readTake(rec, out)
  } catch (err) {
    out.error = String(err)
    try {
      await session.cancel()
    } catch {
      /* already gone */
    }
  } finally {
    setEmergencyFloor(null)
    setCaptureQualityMode(null)
    setQualityStep(null)
    setCompositeFault(null)
  }
  return out
}

export async function runFloorSpike(opts?: {
  takeMs?: number
  loadAtMs?: number
  loadMs?: number
  width?: number
  height?: number
  load?: 'none' | 'cpu' | 'encode' | 'all'
  lanes?: FloorLaneId[]
}): Promise<FloorSpikeReport> {
  const takeMs = opts?.takeMs ?? 40_000
  const loadAtMs = opts?.loadAtMs ?? 12_000
  const loadMs = opts?.loadMs ?? 14_000
  // A max-class surface: the point of the floor is a take whose pixels per
  // second are what the machine cannot hold.
  const width = opts?.width ?? 2560
  const height = opts?.height ?? 1440
  /**
   * `encode`, NOT `all`, AND THE FIRST RUN OF THIS RIG IS THE ARGUMENT.
   *
   * `all` spins every core and paints 4K on the main thread — which is where
   * the SYNTHETIC SOURCE paints. The take then starves at the source, arrivals
   * fall to nothing, and captureLadder's rule 4 correctly refuses to step for a
   * source that sent nothing ("a document nobody is scrolling delivers 0 fps
   * and that is health, not collapse"). Measured here: pressure went critical
   * on encode latency, layer one shed 800 ms later, and no picture rung moved
   * because there was no demand to measure against — the floor behaving exactly
   * as designed, and a gate that proves nothing.
   *
   * `encode` puts real 1440p encoders beside the take's own, which is what
   * E1 measured as the only thing that contends with a hardware encoder on this
   * machine (six spinning cores moved encode latency 11.0 → 13.4 ms; one more
   * encoder of comparable weight is what moves it).
   */
  const load = opts?.load ?? 'encode'
  const wanted = opts?.lanes ?? ['calm', 'floor', 'off', 'composite-drop']

  setSyntheticScreenSize({ width, height })
  /**
   * A MAX60 TAKE NEEDS A 60 fps SOURCE, AND THE URL IS THE ONLY PLACE THAT CAN
   * SAY SO — a trap that cost this rig two runs and is worth writing down.
   *
   * `createSyntheticChannels` calls `applySyntheticSizeParams(location.search)`
   * on EVERY take, and that function sets the fps unconditionally from the URL
   * (absent → the 30 fps default) while setting the SIZE only when the param
   * exists. So a rig's `setSyntheticScreenFps(60)` is silently undone at the
   * next press, and the run reports a "max60" lane that recorded 30 fps.
   *
   *   node scripts/exp.mjs floor '{...}' --headed --query='screenfps=60&camfps=60'
   *
   * These calls stay as the fallback for a caller driving the module directly;
   * `env.sourceTracks` in the report is what says which rate actually arrived.
   */
  setSyntheticScreenFps(60)
  setSyntheticCameraFps(60)
  // The first VideoEncoder init on a cold page reads over a second of latency
  // and would land inside the first lane alone (pressureLead's measurement).
  await warmRigEncoder()

  const lanes: FloorLaneReport[] = []
  for (const lane of wanted) {
    lanes.push(
      await runLane({
        lane,
        floorArmed: lane === 'calm' || lane === 'floor',
        loaded: lane === 'floor' || lane === 'off',
        takeMs,
        loadAtMs,
        loadMs,
        load,
      }),
    )
    // Let the machine come back to itself between lanes, or lane N+1 measures
    // lane N's heat.
    await sleep(3000)
  }

  const calm = lanes.find((l) => l.lane === 'calm')
  const floor = lanes.find((l) => l.lane === 'floor')
  const audioOk = (l: FloorLaneReport): boolean =>
    l.audio.length > 0 && l.audio.every((a) => (a.silentTailMs ?? 0) <= 0)
  const elasticDim = (l: FloorLaneReport): string =>
    l.card.dimensions.find((d) => d.id === 'elastic')?.status ?? 'unmeasured'

  const dropLane = lanes.find((l) => l.lane === 'composite-drop')
  const verdicts = {
    /** S1's gate: the composite drop appended THROUGH the door. */
    compositeDropRecorded: dropLane
      ? dropLane.decisions.some((d) => d.dial === 'channels' && d.decidedBy === 'watchdog')
      : null,
    calmTookNoRung: calm ? calm.floorDecisions.length === 0 : null,
    floorEngaged: floor ? floor.floorDecisions.some((d) => d.action === 'shed') : null,
    audioNeverSacrificed: floor
      ? audioOk(floor) && floor.decisions.every((d) => !/audio/i.test(d.what) || d.action !== 'shed')
      : null,
    orderHeld: floor ? elasticDim(floor) !== 'fail' : null,
    recoveredAutomatically: floor ? floor.recoveredAfterLoadOffMs !== null : null,
    line: '',
  }
  verdicts.line =
    `calm took ${calm?.floorDecisions.length ?? '?'} rungs · ` +
    `floor took ${floor?.floorDecisions.length ?? '?'} (engaged +${floor?.engagedAfterLoadMs ?? '?'} ms, ` +
    `recovered +${floor?.recoveredAfterLoadOffMs ?? '?'} ms) · ` +
    `audio silentTail ${floor?.audio.map((a) => a.silentTailMs ?? 'null').join('/') ?? '?'}`

  return { takeMs, loadMs, screen: { width, height }, lanes, verdicts }
}
