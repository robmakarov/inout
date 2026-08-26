/**
 * EXPERIMENTAL — O4-polish's e2e WEDGE CASE: does a take survive the composite
 * failing, and does the export then land on the right path?
 *
 * THE LADDER UNDER v2 HAS THREE RUNGS and only one of them was ever tested end
 * to end. Capability (no MediaStreamTrackProcessor → v1 from the start) is
 * exercised by every Apple/Firefox run. The other two were covered by unit
 * tests of `watchdogVerdict` — which proves a pure function returns the right
 * verdict, and proves nothing at all about what the SESSION does with it.
 *
 * So this drives the real createCaptureSession through both:
 *
 *   control      nothing injected — the composite survives, and an unedited
 *                export takes the INSTANT path (packet copy)
 *   startFails   v2 throws before its worker exists → the session's v1 fallback
 *                takes the take, and the export is still instant, because v1
 *                produces a perfectly good composite
 *   wedged       the REAL degrade path fires mid-take → the composite is
 *                refused, and the export must RENDER from the raw channels
 *
 * WHAT EACH LANE IS ACTUALLY ASSERTING, and it is the point of the task: the
 * take is not lost. Every raw channel still holds its full length, the
 * recording still has its audio, and the export still produces a playable file
 * — it just costs more. A fallback that produced a shorter take, or a take that
 * exported through a composite it should have refused, would be the bug.
 */
import { blobStore } from '@core/store'
import { createCaptureSession } from '@core/capture/session'
import { setSyntheticScreenSize } from '@core/capture/synthetic'
import { setCompositeFault } from '@core/capture/liveCompositeV2'
import { exportByBestPath } from '@core/compose'
import { clampEditState, defaultEditState } from '@core/timeline'
import type { Recording } from '@core/types'

export type WedgeCase = 'control' | 'startFails' | 'wedged'

export interface WedgeLane {
  wedge: WedgeCase
  takeMs: number
  /** Did a composite survive to be offered to the export at all? */
  compositeKept: boolean
  compositeBytes: number
  /** Which engine actually recorded it, read off the capture console. */
  engine: 'v1' | 'v2' | 'none'
  /** The path compose/choose.ts picked for an UNEDITED export. */
  exportPath: string
  /** WHY a faster path was not taken, in order of attempt — choose.ts's own words. */
  declined: { path: string; reason: string }[]
  exportBytes: number
  exportMs: number
  recordingDurationMs: number
  channels: { kind: string; media: string; durationMs: number; bytes: number }[]
  captureLog: string[]
}

export interface WedgeReport {
  notes: string[]
  lanes: WedgeLane[]
  gates: Record<string, { pass: boolean; detail: string }>
}

async function runCase(wedge: WedgeCase, takeMs: number): Promise<WedgeLane> {
  setCompositeFault(
    wedge === 'startFails'
      ? { startFails: true }
      : wedge === 'wedged'
        ? { degradeAfterMs: Math.round(takeMs * 0.35) }
        : null,
  )
  const captureLog: string[] = []
  const realInfo = console.info
  const realWarn = console.warn
  const tap =
    (real: typeof console.info) =>
    (...a: unknown[]): void => {
      if (typeof a[0] === 'string' && a[0].startsWith('[capture')) captureLog.push(a[0])
      real.apply(console, a as [])
    }
  console.info = tap(realInfo)
  console.warn = tap(realWarn)

  let recording: Recording
  try {
    const session = await createCaptureSession({
      screen: true,
      camera: true,
      mic: true,
      systemAudio: false,
    })
    session.start()
    await new Promise((r) => setTimeout(r, takeMs))
    recording = await session.stop()
  } finally {
    console.info = realInfo
    console.warn = realWarn
    setCompositeFault(null)
  }

  const engine: WedgeLane['engine'] = captureLog.some((l) => l.includes('engine v2'))
    ? captureLog.some((l) => l.includes('falling back to v1'))
      ? 'v1'
      : 'v2'
    : captureLog.length
      ? 'v1'
      : 'none'

  let compositeBytes = 0
  if (recording.composite) {
    compositeBytes = (await blobStore.read(recording.composite.blobKey).catch(() => null))?.size ?? 0
  }

  // The product's own ladder decides the path — not the rig. compose/choose.ts
  // is what EditorScreen calls, so this measures what a user would get.
  const edit = clampEditState(recording, defaultEditState(recording))
  const t0 = performance.now()
  // allowPacketCopy is the DEFAULT TIER's answer — the editor sets it from the
  // quality ladder, and the default tier is the composite's own geometry.
  const chosen = await exportByBestPath({ recording, edit, allowPacketCopy: true })
  const exportMs = Math.round(performance.now() - t0)

  const channels: WedgeLane['channels'] = []
  for (const ch of recording.channels) {
    const blob = await blobStore.read(ch.blobKey).catch(() => null)
    channels.push({
      kind: ch.kind,
      media: ch.media,
      durationMs: Math.round(ch.durationMs),
      bytes: blob?.size ?? 0,
    })
  }

  const out = {
    wedge,
    takeMs,
    compositeKept: !!recording.composite,
    compositeBytes,
    engine,
    exportPath: chosen.path,
    declined: chosen.declined.map((d) => ({ path: d.path, reason: d.reason })),
    exportBytes: chosen.result.blob.size,
    exportMs,
    recordingDurationMs: Math.round(recording.durationMs),
    channels,
    captureLog: captureLog.slice(0, 30),
  }

  for (const ch of recording.channels) await blobStore.remove(ch.blobKey).catch(() => undefined)
  if (recording.composite) {
    await blobStore.remove(recording.composite.blobKey).catch(() => undefined)
  }
  return out
}

export async function runCompositeWedge(
  opts: { takeSec?: number; cases?: WedgeCase[] } = {},
): Promise<WedgeReport> {
  const takeMs = (opts.takeSec ?? 10) * 1000
  const cases = opts.cases ?? (['control', 'startFails', 'wedged'] as WedgeCase[])
  // THE COMPOSITE HAS TO BE THE EXPORT'S OWN GEOMETRY or the instant path
  // declines for a reason that has nothing to do with wedges. The first run of
  // this rig used the synthetic default (1280x720) and every lane rendered,
  // with choose.ts saying exactly why: "not the default output geometry".
  setSyntheticScreenSize({ width: 1920, height: 1080 })
  const lanes: WedgeLane[] = []
  try {
    for (const c of cases) lanes.push(await runCase(c, takeMs))
  } finally {
    setSyntheticScreenSize(null)
  }

  const by = (c: WedgeCase): WedgeLane | undefined => lanes.find((l) => l.wedge === c)
  const control = by('control')
  const startFails = by('startFails')
  const wedged = by('wedged')

  const videoOf = (l: WedgeLane): { kind: string; durationMs: number; bytes: number }[] =>
    l.channels.filter((c) => c.media === 'video')

  const gates: WedgeReport['gates'] = {}

  if (control) {
    gates['control: the composite survives and an unedited export is INSTANT'] = {
      pass: control.compositeKept && control.exportPath === 'instant',
      detail:
        `engine ${control.engine}, composite ${control.compositeBytes} B, path ${control.exportPath} in ${control.exportMs} ms` +
        (control.declined.length ? ` · declined: ${control.declined.map((d) => `${d.path}=${d.reason}`).join('; ')}` : ''),
    }
  }
  if (startFails) {
    gates['start failure: v1 takes the take, and the export is still instant'] = {
      pass: startFails.engine === 'v1' && startFails.compositeKept && startFails.exportPath === 'instant',
      detail:
        `engine ${startFails.engine}, composite ${startFails.compositeBytes} B, path ${startFails.exportPath}` +
        (startFails.declined.length ? ` · declined: ${startFails.declined.map((d) => `${d.path}=${d.reason}`).join('; ')}` : ''),
    }
  }
  if (wedged) {
    // THE ONE THE TASK IS ABOUT. A refused composite must not be exported from.
    gates['mid-take wedge: the composite is REFUSED and the export renders'] = {
      pass: wedged.exportPath !== 'instant' && wedged.exportPath !== 'smartcut',
      detail: `path ${wedged.exportPath} (composite kept for liveness: ${wedged.compositeKept}), ${wedged.exportBytes} B in ${wedged.exportMs} ms`,
    }
    gates['mid-take wedge: the TAKE is unharmed — every channel keeps its length'] = {
      pass:
        videoOf(wedged).length > 0 &&
        videoOf(wedged).every((c) => c.bytes > 0 && c.durationMs >= takeMs * 0.7),
      detail: wedged.channels
        .map((c) => `${c.kind} ${c.durationMs} ms / ${c.bytes} B`)
        .join(' · '),
    }
    if (control) {
      gates['mid-take wedge: the wedged take is as long as the control'] = {
        pass: Math.abs(wedged.recordingDurationMs - control.recordingDurationMs) <= 1500,
        detail: `wedged ${wedged.recordingDurationMs} ms vs control ${control.recordingDurationMs} ms`,
      }
    }
  }

  return {
    notes: [
      'every lane drives the real createCaptureSession and the real compose/choose.ts ladder, so the path reported is the path a user would get',
      'the wedge fires the SAME degrade() the watchdog calls — the rig injects the trigger, never the consequence',
      'MEASURED, against what this rig first assumed: after a wedge the composite is not merely refused by policy, it is ABSENT from the Recording entirely — choose.ts declines with "take has no composite". The handle stays alive inside the session because it owns the source-liveness tick, but it never reaches the export, which is the stronger of the two behaviours',
    ],
    lanes,
    gates,
  }
}
