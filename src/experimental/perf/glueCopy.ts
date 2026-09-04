/**
 * EXPERIMENTAL — J6's GATES, on a take with a CAMERA in it.
 *
 * o3b already prices the screen-only half (bytes on disk per second, the colour
 * of the copy, the routing of every export lane). This rig is the other half,
 * and it is the half the ruling is actually about: a take with two video
 * channels is the one that used to open THREE hardware encoders and is the one
 * whose unedited export loses its packet copy when the composite stops being
 * written. Robert 2026-09-04 (27): "kill the glued copy encoding and do
 * background render while editing".
 *
 * Every gate here was named in the task row before a line of J6 was written:
 *
 *   THE ENCODER      the take's own encoder plan, off the capture console, must
 *                    lose the composite and keep everything else.
 *   THE PREVIEW      unchanged. `attachCompositePreview` must still hand the
 *                    compositor's own canvas over and paint into it — the paint
 *                    is what Robert kept ("we need preview") and a rig that did
 *                    not press this button would not have noticed it going.
 *   THE LIVENESS     a screen that delivers NOTHING (`?dead=screen`, H4's own
 *                    drill) must still be called dead, and the take must still
 *                    carry the loss. The detector lives on the compositor's
 *                    AudioWorklet tick, which is the thing most easily lost when
 *                    an engine stops encoding.
 *   THE PRESS        an UNEDITED camera take has nothing to packet-copy any
 *                    more, so it must be served by the file J5/F16b makes at
 *                    stop. The control is the same press with the cache
 *                    cleared, which is the wait a user would have felt.
 *   THE FILES        the take's own channels — kinds, containers, geometry,
 *                    rate — identical to the `?glue=record` control.
 *
 * THE CONTROL IS `?glue=record`, i.e. the take that was recorded yesterday, and
 * it is recorded in the same process against the same synthetic sources. Every
 * number below is a difference between two takes, not a number against memory.
 */
import { createCaptureSession } from '@core/capture/session'
import { setSyntheticScreenSize, setSyntheticScreenContent } from '@core/capture/synthetic'
import { setGlueRung, glueRung, type GlueRung } from '@core/glue'
import { captureQualityMode, setCaptureQualityMode } from '@core/capture/captureQuality'
import { exportByBestPath } from '@core/compose/choose'
import {
  cancelPrerender,
  prerenderKey,
  prerenderStatus,
  startPrerender,
  takePrerender,
} from '@core/compose/prerender'
import { exportWouldRender } from '@core/compose'
import { defaultTierForTake, resolveTier, settingsForTier, isDefaultTier } from '@core/compose/quality'
import { frameAspectFor } from '@core/frame'
import { takeRate } from '@core/rate'
import { defaultEditState } from '@core/timeline'
import { blobStore } from '@core/store'
import { warmRigEncoder } from '../rigWarm'
import type { EditState, Recording, ExportSettings } from '@core/types'

const W = 1280
const H = 720

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const r1 = (n: number): number => Math.round(n * 10) / 10

export interface GlueLane {
  rung: GlueRung
  /** `?dead=screen` lanes only — H4's drill runs on the shipped rung. */
  dead: boolean
  durationMs: number
  /** Did a composite FILE survive to be offered to the export? */
  hasComposite: boolean
  compositeBytes: number
  /** stopStats.glue — what the compositor says it did, on a take with no file. */
  glue: { recorded: boolean; engine: string; intake?: string; painter?: string; framesPainted?: number } | null
  /** THE ENCODER PLAN, off the capture console: `[capture] encoder plan — …`. */
  encoderPlan: string | null
  encoderCount: number | null
  /** Did the compositor's own canvas take the recording preview over? */
  previewFromCompositor: boolean
  /** H4: what the take says it lost, and what the console said about it. */
  lost: { kind: string; reason: string }[]
  livenessLines: string[]
  channels: { kind: string; media: string; mimeType: string; width: number | null; height: number | null; fps: number | null; bytes: number }[]
  bytesPerSec: number
  /** The unedited export: which path, and how long the press took. */
  pressPath: string
  pressMs: number
  pressBytes: number
  /** The same press with the pre-made file cleared — the wait without J5. */
  coldPressMs: number | null
  captureLog: string[]
}

export interface GlueReport {
  notes: string[]
  takeMs: number
  lanes: GlueLane[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}

function tapConsole(sink: string[]): () => void {
  const realInfo = console.info
  const realWarn = console.warn
  const tap =
    (real: typeof console.info) =>
    (...a: unknown[]): void => {
      if (typeof a[0] === 'string' && (a[0].startsWith('[capture') || a[0].startsWith('[compose')))
        sink.push(a[0])
      real.apply(console, a as [])
    }
  console.info = tap(realInfo)
  console.warn = tap(realWarn)
  return () => {
    console.info = realInfo
    console.warn = realWarn
  }
}

async function sizeOf(key: string | undefined): Promise<number> {
  if (!key) return 0
  return (await blobStore.read(key).catch(() => null))?.size ?? 0
}

/**
 * THE PREVIEW BUTTON, PRESSED THE WAY THE APP PRESSES IT.
 *
 * `attachCompositePreview` transfers a real canvas to the worker and resolves
 * TRUE only once a frame has actually landed on it — so a true here is not
 * "the call returned", it is "the compositor painted onto the page". That
 * distinction is the whole reason this gate is worth running: a paint-only
 * engine that had quietly stopped painting would still answer the message.
 */
async function pressPreview(session: { attachCompositePreview(c: HTMLCanvasElement): Promise<boolean> }): Promise<boolean> {
  const canvas = document.createElement('canvas')
  canvas.width = 960
  canvas.height = 540
  // Off-screen but in the document: transferControlToOffscreen does not need
  // layout, and a detached canvas is what a rig would accidentally test.
  canvas.style.position = 'fixed'
  canvas.style.left = '-10000px'
  document.body.appendChild(canvas)
  try {
    return await session.attachCompositePreview(canvas)
  } finally {
    canvas.remove()
  }
}

/**
 * WHAT THE APP DOES AT STOP, and nothing more: CaptureScreen asks whether this
 * take's export would RENDER, and if so starts F16b's job. The rig calls the
 * same two functions rather than reaching into the screen, so what is proven is
 * the path a real stop takes.
 */
async function prerenderAtStop(
  recording: Recording,
  edit: EditState,
): Promise<{ settings: ExportSettings; allowPacketCopy: boolean; started: boolean }> {
  const aspect = frameAspectFor(recording)
  const chosen = defaultTierForTake(recording, aspect)
  const settings = settingsForTier(resolveTier(chosen, aspect, takeRate(recording)))
  const allowPacketCopy = isDefaultTier(chosen)
  const wouldRender = exportWouldRender({ recording, edit, settings, allowPacketCopy })
  if (wouldRender) startPrerender({ recording, edit, settings }, 'stop')
  return { settings, allowPacketCopy, started: wouldRender }
}

async function waitForPrerender(key: string, timeoutMs: number): Promise<string> {
  const until = performance.now() + timeoutMs
  for (;;) {
    const st = prerenderStatus(key)
    if (st && st.state !== 'running') return st.state
    if (performance.now() > until) return st?.state ?? 'never-started'
    await sleep(200)
  }
}

async function runLane(rung: GlueRung, dead: boolean, takeMs: number): Promise<GlueLane> {
  setGlueRung(rung)
  const captureLog: string[] = []
  const untap = tapConsole(captureLog)
  let recording: Recording
  let previewFromCompositor = false
  try {
    const session = await createCaptureSession({
      screen: true,
      camera: true,
      mic: true,
      systemAudio: false,
    })
    session.start()
    // Let the compositor come up before asking it for the preview — the same
    // race the capture screen runs (its canvas mounts while the take starts),
    // and `attachCompositePreview` awaits `compositeStarting` for exactly this.
    await sleep(Math.min(1500, takeMs / 3))
    previewFromCompositor = await pressPreview(session)
    await sleep(Math.max(0, takeMs - Math.min(1500, takeMs / 3)))
    recording = await session.stop()
  } finally {
    untap()
  }

  const edit = defaultEditState(recording)
  const { settings, allowPacketCopy, started } = await prerenderAtStop(recording, edit)
  const key = prerenderKey({ recording, edit, settings })
  if (started) await waitForPrerender(key, 10 * 60_000)

  const tPress = performance.now()
  const chosen = await exportByBestPath({ recording, edit, settings, allowPacketCopy })
  const pressMs = r1(performance.now() - tPress)
  const pressBytes = chosen.result.blob.size

  // THE CONTROL FOR THE PRESS: the same export with nothing pre-made. This is
  // the wait the user would feel if J5 had not landed first, and the ORDER of
  // the two tasks was part of the ruling — so the rig measures the pair rather
  // than asserting the order was obeyed.
  let coldPressMs: number | null = null
  if (started) {
    cancelPrerender()
    // Take whatever is still held so a second call cannot be served from it.
    takePrerender(key)
    const tCold = performance.now()
    await exportByBestPath({ recording, edit, settings, allowPacketCopy })
    coldPressMs = r1(performance.now() - tCold)
  }

  const compositeBytes = await sizeOf(recording.composite?.blobKey)
  const channels: GlueLane['channels'] = []
  for (const c of recording.channels) {
    channels.push({
      kind: c.kind,
      media: c.media,
      mimeType: c.mimeType,
      width: c.width ?? null,
      height: c.height ?? null,
      fps: c.fps ?? null,
      bytes: await sizeOf(c.blobKey),
    })
  }
  const total = compositeBytes + channels.reduce((a, c) => a + c.bytes, 0)
  const planLine = captureLog.find((l) => l.startsWith('[capture] encoder plan —')) ?? null
  return {
    rung,
    dead,
    durationMs: recording.durationMs,
    hasComposite: !!recording.composite,
    compositeBytes,
    glue: (recording.stopStats?.glue as GlueLane['glue']) ?? null,
    encoderPlan: planLine,
    // `describePlan` lists the encoders it planned; counting them is what the
    // gate is about and the string is the evidence beside it.
    encoderCount: planLine ? (planLine.match(/\d+x\d+/g)?.length ?? null) : null,
    previewFromCompositor,
    lost: (recording.lost ?? []).map((l) => ({ kind: l.kind, reason: l.reason })),
    livenessLines: captureLog.filter((l) => /source (dead|stalled|resumed)/.test(l)),
    channels,
    bytesPerSec: Math.round(total / Math.max(0.001, recording.durationMs / 1000)),
    pressPath: chosen.path,
    pressMs,
    pressBytes,
    coldPressMs,
    captureLog,
  }
}

export async function runGlueCopy(
  opts: { takeSec?: number; width?: number; height?: number; max?: boolean } = {},
): Promise<GlueReport> {
  const takeMs = (opts.takeSec ?? 10) * 1000
  const notes: string[] = []
  const previousGlue = glueRung()
  const previousQuality = captureQualityMode()
  /**
   * `{"max":true}` ASKS THE GATE'S OWN QUESTION: the task row says to measure
   * the freed encoder on a MAX + camera take. Max is not a screen size, it is a
   * mode, and the mode is what decides whether a compositor opens at all — so
   * the rig sets the mode and a screen bigger than the composite frame, which
   * is what a max take is.
   */
  if (opts.max) setCaptureQualityMode('max')
  const screen = { width: opts.width ?? W, height: opts.height ?? H }
  setSyntheticScreenSize(screen)
  notes.push(`asked for screen ${screen.width}x${screen.height}, quality ${captureQualityMode()}`)
  setSyntheticScreenContent('text')
  await warmRigEncoder()

  const lanes: GlueLane[] = []
  try {
    // The control FIRST, so the shipped rung is never the one that pays for a
    // cold anything.
    lanes.push(await runLane('record', false, takeMs))
    lanes.push(await runLane('paint', false, takeMs))
  } finally {
    setGlueRung(previousGlue === 'paint' ? null : previousGlue)
    setCaptureQualityMode(previousQuality === 'auto' ? null : previousQuality)
    setSyntheticScreenSize(null)
    setSyntheticScreenContent(null)
  }

  const rec = lanes.find((l) => l.rung === 'record')!
  const paint = lanes.find((l) => l.rung === 'paint')!
  const gates: GlueReport['gates'] = {}

  /**
   * A CONFIGURATION THAT ALREADY HAD NO COMPOSITE IS A FINDING, NOT A FAILURE.
   *
   * `singleGenerationTake` refuses to open a compositor at all when the raw
   * screen channel is already bigger than the composite would be, and in MAX
   * mode it refuses on any screen at or above that size — so a max take has
   * had no glued copy, no composited preview and no frozen-screen detector
   * since 2026-08-30, and there is nothing here for J6 to free. That is worth
   * measuring rather than arguing (the task row asks for the freed encoder on a
   * max + camera take), and it is not something the gates below can express:
   * every one of them is a DIFFERENCE between two takes that are identical.
   */
  if (!rec.hasComposite && !paint.hasComposite) {
    gates['THIS CONFIGURATION ALREADY HAD NO COMPOSITE BEFORE J6 — nothing to free, and nothing changed'] = {
      pass:
        rec.encoderPlan === paint.encoderPlan &&
        rec.previewFromCompositor === paint.previewFromCompositor &&
        !rec.previewFromCompositor,
      detail:
        `both rungs: ${paint.encoderPlan ?? 'no plan logged'} · composited preview ${paint.previewFromCompositor} on both ` +
        `· ${(rec.bytesPerSec / 1e6).toFixed(2)} against ${(paint.bytesPerSec / 1e6).toFixed(2)} MB/s. The composite was ` +
        `refused by singleGenerationTake before the glue rung was ever consulted.`,
    }
    return {
      notes,
      takeMs,
      lanes,
      gates,
      verdict: Object.values(gates)[0]!.pass
        ? 'MAX ALREADY HAD NO GLUED COPY. J6 frees an encoder on every take that still opened one — which is every take below max — and changes nothing here, including the preview and the frozen-screen detector, which max gave up in 2026-08-30 and J6 did not give back.'
        : 'THE TWO RUNGS DIFFER ON A CONFIGURATION THAT OPENS NO COMPOSITOR AT ALL — J6 reached a take it should not have.',
    }
  }

  gates['THE FILE: the shipped rung writes no composite, and the control does'] = {
    pass: !paint.hasComposite && paint.compositeBytes === 0 && rec.hasComposite && rec.compositeBytes > 0,
    detail:
      `?glue=paint: composite ${paint.hasComposite ? 'PRESENT' : 'absent'}, ${paint.compositeBytes} B · ` +
      `?glue=record: ${rec.hasComposite ? 'present' : 'ABSENT — the control did not record one'}, ${rec.compositeBytes} B`,
  }

  gates['THE ENCODER: the plan loses the composite and keeps every raw channel'] = {
    pass:
      rec.encoderCount !== null &&
      paint.encoderCount !== null &&
      paint.encoderCount === rec.encoderCount - 1 &&
      !/composite/i.test(paint.encoderPlan ?? '') &&
      /composite/i.test(rec.encoderPlan ?? ''),
    detail: `?glue=record plan: ${rec.encoderPlan ?? 'not logged'} · ?glue=paint plan: ${paint.encoderPlan ?? 'not logged'}`,
  }

  gates['THE PAINT: it happened, and it is on the take’s own record'] = {
    pass: !!paint.glue && paint.glue.recorded === false && (paint.glue.framesPainted ?? 0) > 0,
    detail: paint.glue
      ? `stopStats.glue: recorded=${paint.glue.recorded} engine=${paint.glue.engine} intake=${paint.glue.intake ?? '—'} painter=${paint.glue.painter ?? '—'} framesPainted=${paint.glue.framesPainted}`
      : 'the take carries no glue record at all',
  }

  gates['THE PREVIEW: unchanged — the compositor’s own canvas still takes it over'] = {
    pass: paint.previewFromCompositor && rec.previewFromCompositor,
    detail: `?glue=paint preview from the compositor: ${paint.previewFromCompositor} · ?glue=record: ${rec.previewFromCompositor} (both must be true — the paint is what Robert kept)`,
  }

  gates['THE FILES: the take’s own channels are the same take'] = (() => {
    const key = (l: GlueLane): string =>
      l.channels
        .map((c) => `${c.kind}/${c.media}/${c.mimeType}/${c.width}x${c.height}@${c.fps}`)
        .sort()
        .join(' · ')
    const same = key(rec) === key(paint)
    return {
      pass: same,
      detail: same
        ? `identical: ${key(paint)}`
        : `DIFFERENT — control: ${key(rec)} · shipped: ${key(paint)}`,
    }
  })()

  gates['WRITE BANDWIDTH: the composite was a real share of it'] = {
    pass: paint.bytesPerSec < rec.bytesPerSec,
    detail: `${(rec.bytesPerSec / 1e6).toFixed(2)} MB/s with the composite · ${(paint.bytesPerSec / 1e6).toFixed(2)} MB/s without — ${Math.round((1 - paint.bytesPerSec / rec.bytesPerSec) * 1000) / 10} % less written per second of take`,
  }

  gates['THE PRESS: an UNEDITED camera take still exports without a wait'] = {
    pass: paint.coldPressMs !== null && paint.pressMs < paint.coldPressMs,
    detail:
      `?glue=paint press ${paint.pressMs} ms via ${paint.pressPath}` +
      (paint.coldPressMs === null
        ? ' — nothing was pre-made, so this take did not need J5 at all'
        : ` against ${paint.coldPressMs} ms with the pre-made file cleared (the wait without J5)`) +
      ` · the control pressed ${rec.pressMs} ms via ${rec.pressPath}`,
  }

  notes.push(
    'The camera take is the one this ruling is about: it opens three encoders and its unedited ' +
      'export has nothing to packet-copy once the composite stops being written.',
  )


  const verdict = Object.values(gates).every((g) => g.pass)
    ? `THE GLUED COPY IS PAINTED AND NEVER ENCODED, AND NOTHING THE PAINT CARRIES WAS LOST. ` +
      `The camera take drops from ${rec.encoderCount} encoders to ${paint.encoderCount} and from ` +
      `${(rec.bytesPerSec / 1e6).toFixed(2)} to ${(paint.bytesPerSec / 1e6).toFixed(2)} MB/s, the compositor's own ` +
      `canvas still paints the preview, and the unedited press costs ${paint.pressMs} ms against ` +
      `${paint.coldPressMs ?? '—'} ms with nothing pre-made.`
    : `NOT PROVEN: ${Object.entries(gates)
        .filter(([, g]) => !g.pass)
        .map(([k]) => k)
        .join(' · ')}`
  return { notes, takeMs, lanes, gates, verdict }
}

/**
 * H4's OWN DRILL, on the shipped rung, as its own run: `?dead=screen` has to be
 * in the URL before the session is built, so it cannot share a page with the
 * lanes above. `npm run exp -- j6dead --query='synthetic=1&dead=screen'`.
 */
export async function runGlueLiveness(opts: { takeSec?: number } = {}): Promise<{
  lane: GlueLane
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}> {
  const takeMs = (opts.takeSec ?? 10) * 1000
  const previousGlue = glueRung()
  setSyntheticScreenSize({ width: W, height: H })
  setSyntheticScreenContent('text')
  await warmRigEncoder()
  let lane: GlueLane
  try {
    lane = await runLane('paint', true, takeMs)
  } finally {
    setGlueRung(previousGlue === 'paint' ? null : previousGlue)
    setSyntheticScreenSize(null)
    setSyntheticScreenContent(null)
  }
  const saidDead = lane.livenessLines.some((l) => l.includes('screen source dead'))
  const carried = lane.lost.some((l) => l.kind === 'screen')
  const gates = {
    'THE LIVENESS: a screen that delivers nothing is still called dead': {
      pass: saidDead,
      detail: saidDead
        ? `console said: ${lane.livenessLines.join(' · ')}`
        : `NOTHING — the detector never fired. Lines seen: ${lane.livenessLines.join(' · ') || '(none)'}`,
    },
    'THE TAKE CARRIES IT: Recording.lost names the screen (H4)': {
      pass: carried,
      detail: carried
        ? `lost: ${lane.lost.map((l) => `${l.kind}/${l.reason}`).join(', ')}`
        : 'the take carries no loss for the screen',
    },
    'AND THE COMPOSITE STILL WAS NOT WRITTEN': {
      pass: !lane.hasComposite && lane.compositeBytes === 0,
      detail: `composite ${lane.hasComposite ? 'PRESENT' : 'absent'}, ${lane.compositeBytes} B`,
    },
  }
  const verdict = Object.values(gates).every((g) => g.pass)
    ? 'THE FROZEN-SCREEN DETECTOR SURVIVES J6. It lives on the compositor’s AudioWorklet tick, and the tick is upstream of the encode that was removed.'
    : `NOT PROVEN: ${Object.entries(gates)
        .filter(([, g]) => !g.pass)
        .map(([k]) => k)
        .join(' · ')}`
  return { lane, gates, verdict }
}
