import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditState, ExportResult, Recording } from '@core/types'

/**
 * F16's core contract: the export is made before it is asked for, and NOTHING
 * about the file a user gets changes. These pin the three properties that make
 * that safe — the key, the join, and the fallback.
 */

let renderCalls = 0
let settle: ((r: ExportResult) => void) | null = null
let reject: ((e: unknown) => void) | null = null
let progress: ((p: { phase: string; ratio: number }) => void) | null = null

let lastPace: unknown = undefined

vi.mock('./pipeline', () => ({
  exportRecording: (opts: {
    signal?: AbortSignal
    onProgress?: (p: { phase: string; ratio: number }) => void
    pace?: unknown
  }) => {
    renderCalls += 1
    progress = opts.onProgress ?? null
    lastPace = opts.pace
    return new Promise<ExportResult>((res, rej) => {
      settle = res
      reject = rej
      opts.signal?.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        rej(e)
      })
    })
  },
}))

const written = new Map<string, number>()
vi.mock('@core/store', () => ({
  persistBlobCopy: (blob: Blob, key: string) => {
    written.set(key, blob.size)
    return Promise.resolve({ size: blob.size, type: blob.type } as unknown as Blob)
  },
  blobStore: {
    read: (key: string) =>
      Promise.resolve({
        size: written.get(key) ?? 0,
        type: 'video/mp4',
        slice: (_s: number, _e: number, type: string) => ({ size: written.get(key) ?? 0, type }),
      } as unknown as Blob),
    remove: (key: string) => {
      written.delete(key)
      return Promise.resolve()
    },
    list: () => Promise.resolve([...written.keys()].map((key) => ({ key, size: 1 }))),
  },
  createPositionedWriter: (key: string) =>
    Promise.resolve({
      write: (data: Uint8Array) => {
        written.set(key, (written.get(key) ?? 0) + data.byteLength)
        return Promise.resolve()
      },
      close: () => Promise.resolve(),
    }),
}))

const {
  cancelPrerender,
  editBindsPrerender,
  firstEditDivergenceMs,
  prerenderKey,
  prerenderShape,
  prerenderStatus,
  resetPrerenderForTests,
  startPrerender,
  takePrerender,
} = await import('./prerender')
const { noteTakeActive, resetBackgroundWorkForTests } = await import('@core/backgroundWork')
const { setConstantQualityOverride } = await import('./constantQuality')
const { setSourceFrame } = await import('@core/frame')
const { setFullColourOverride } = await import('./fullColour')
const { setLoudnessMode } = await import('./loudnessMode')

/** Every render flag back to what ships, so one case cannot leak into the next. */
function resetFlags(): void {
  setConstantQualityOverride(undefined)
  setSourceFrame(null)
  setFullColourOverride(null)
  setLoudnessMode(null)
}

const recording = { id: 'rec1', createdAt: 0, durationMs: 1000, channels: [] } as unknown as Recording
const edit = { channels: [], segments: [{ startMs: 0, endMs: 1000 }] } as unknown as EditState
const settings = { width: 1920, height: 1080, fps: 60 }

function fakeResult(): ExportResult {
  return {
    blob: {
      size: 10,
      type: 'video/mp4',
      stream: () => ({
        getReader: () => {
          let done = false
          return {
            read: () =>
              done
                ? Promise.resolve({ done: true, value: undefined })
                : ((done = true), Promise.resolve({ done: false, value: new Uint8Array(10) })),
          }
        },
      }),
    } as unknown as Blob,
  } as unknown as ExportResult
}

afterEach(() => {
  cancelPrerender()
  resetPrerenderForTests()
  resetBackgroundWorkForTests()
  lastPace = undefined
  renderCalls = 0
  settle = null
  reject = null
  progress = null
  written.clear()
})

describe('the pre-rendered export', () => {
  it('keys on everything that changes the bytes, and nothing else', () => {
    const a = prerenderKey({ recording, edit, settings })
    expect(prerenderKey({ recording, edit, settings })).toBe(a)
    expect(prerenderKey({ recording, edit, settings: { ...settings, width: 1280 } })).not.toBe(a)
    expect(prerenderKey({ recording, edit: { ...edit, segments: [] } as EditState, settings })).not.toBe(a)
    expect(prerenderKey({ recording: { ...recording, id: 'rec2' }, edit, settings })).not.toBe(a)
  })

  /**
   * THE HOLE THIS CLOSES, and it is why the test above was not enough: the key
   * carried the recording, the edit and the settings, and NO render flag — so a
   * file made before a switch was flipped was served for an export made after
   * it and the switch silently did nothing. `?cq=` and `?sourceframe=` lived
   * with that; O9(b) could only refuse the pre-render outright. Each flag gets
   * its own case, because a key that happens to move for one of them is not
   * evidence about the others.
   */
  it('a render flag changes the key — every one of them', () => {
    const a = prerenderKey({ recording, edit, settings })
    const shapeA = prerenderShape({ recording, edit, settings })
    for (const [name, set] of [
      // qp20 is what ships, so asking for 20 is not a change — 28 is. And the
      // OVERRIDE is the seam that works here: `setConstantQuality` writes
      // localStorage, which a worker has none of and this environment has none
      // of either, which is the very hole its own header describes.
      ['cq', () => setConstantQualityOverride(28)],
      // F13's frame follows the take by DEFAULT, so `true` is not a change.
      ['sourceframe', () => setSourceFrame(false)],
      // The OVERRIDE again: `setFullColourEnabled` writes storage, and
      // `fullColourActive` is what the key reads.
      ['colour', () => setFullColourOverride(true)],
      ['loudness', () => setLoudnessMode('r128')],
    ] as [string, () => void][]) {
      set()
      expect(prerenderKey({ recording, edit, settings }), name).not.toBe(a)
      expect(prerenderShape({ recording, edit, settings }), name).not.toBe(shapeA)
      resetFlags()
      expect(prerenderKey({ recording, edit, settings }), name).toBe(a)
    }
  })

  it('starts ONE render, and asking again for the same output does not start another', () => {
    startPrerender({ recording, edit, settings })
    startPrerender({ recording, edit, settings })
    startPrerender({ recording, edit, settings })
    expect(renderCalls).toBe(1)
  })

  it('a different output supersedes the first — the machine is never spent on both', () => {
    startPrerender({ recording, edit, settings })
    startPrerender({ recording, edit, settings: { ...settings, width: 1280, height: 720 } })
    expect(renderCalls).toBe(2)
    // The superseded job is gone: its key no longer answers.
    expect(prerenderStatus(prerenderKey({ recording, edit, settings }))).toBeNull()
  })

  /**
   * THE JOIN, which is the property that makes pressing export early safe.
   * Without it, an export pressed at 90 % would start the same render again
   * and the user would wait twice.
   */
  it('an export pressed mid-job JOINS it rather than starting a second render', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    const taken = takePrerender(key)
    expect(taken).not.toBeNull()
    expect(renderCalls).toBe(1)
    settle!(fakeResult())
    await expect(taken!.promise).resolves.toBeTruthy()
    expect(renderCalls).toBe(1)
  })

  /**
   * THE JOIN IS HONEST NOW (2026-08-30). The first version reported a flat
   * "finalizing 99%" and ignored the claimer's cancel: Robert watched 99% for
   * five minutes and his cancel reached nothing. A claimed job forwards its
   * real progress and its abort controller is the claimer's to pull.
   */
  it('a claimed job keeps reporting its real progress to the claimer', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    const taken = takePrerender(key)!
    const seen: number[] = []
    taken.onProgress((p) => seen.push(p.ratio))
    progress?.({ phase: 'rendering', ratio: 0.4 })
    progress?.({ phase: 'rendering', ratio: 0.6 })
    expect(seen).toEqual([0.4, 0.6])
    settle!(fakeResult())
    await taken.promise
  })

  it('aborting a claimed job aborts the render underneath', async () => {
    startPrerender({ recording, edit, settings })
    const taken = takePrerender(prerenderKey({ recording, edit, settings }))!
    taken.abort.abort()
    await expect(taken.promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('handing it out retires the job, so nothing deletes a file being downloaded', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    const first = takePrerender(key)
    expect(first).not.toBeNull()
    expect(takePrerender(key)).toBeNull()
    settle!(fakeResult())
    await first!.promise
    // The settle handler must KEEP the claimed file: the claimer's blob reads
    // from it. (It used to drop it whenever the job was already retired.)
    await new Promise((r) => setTimeout(r, 0))
    expect([...written.keys()].some((k) => k.startsWith('prerender-'))).toBe(true)
  })

  it('a MISS is silent — the caller renders on demand exactly as before', () => {
    expect(takePrerender('no such key')).toBeNull()
    startPrerender({ recording, edit, settings })
    expect(takePrerender(prerenderKey({ recording, edit, settings: { ...settings, fps: 30 } }))).toBeNull()
  })

  it('a FAILED job is never served — it falls through to the on-demand render', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    reject!(new Error('encoder died'))
    await new Promise((r) => setTimeout(r, 0))
    expect(prerenderStatus(key)?.state).toBe('failed')
    expect(takePrerender(key)).toBeNull()
  })

  /**
   * F16b — A BACKGROUND JOB IS ELASTIC, a user-visible export is not. The
   * priority order is absolute (CAPTURE > EDITING > BACKGROUND RENDER) and
   * this is the only place in the product that hands a render a brake.
   */
  it('hands the render the elastic brake, which no user-visible export gets', () => {
    startPrerender({ recording, edit, settings })
    expect(lastPace).toBeTruthy()
  })

  /**
   * E3 — AND THE BRAKE COMES OFF AT THE PRESS.
   *
   * `takePrerender` turns this job into the export a person is waiting for, and
   * until E3 nothing told the render that. The press itself made it worse than
   * a coincidence: the Export button lives inside the editor element carrying
   * `onPointerDownCapture={noteEditingActivity}`, so the claim arrived as a
   * `trickle`. Measured on prod at default flags: 65.6 s against 23.1 s for the
   * same export (2.84x) — a joined pre-render finishing LATER than no
   * pre-render at all, against F16's promise that it "may only ever SAVE time".
   */
  it('a claimed job leaves the brake behind — its deadline is now', () => {
    startPrerender({ recording, edit, settings })
    const pace = lastPace as { level(): string; deadline(): string }
    expect(pace.deadline()).toBe('background')
    noteTakeActive(true)
    expect(pace.level()).toBe('paused')
    takePrerender(prerenderKey({ recording, edit, settings }))
    expect(pace.deadline()).toBe('now')
    expect(pace.level()).toBe('full')
    noteTakeActive(false)
  })

  it('cancelling aborts the render rather than letting it finish unwanted', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    cancelPrerender()
    expect(prerenderStatus(key)).toBeNull()
    expect(takePrerender(key)).toBeNull()
  })
})

/**
 * AN EDIT BINDS THE ONGOING JOB — Robert, 2026-09-01 (DECISIONS (4)). Key
 * supersession already stopped a stale file being SERVED; these pin the
 * stronger half, that the stale WORK stops. Before this the job kept rendering
 * a file nobody could ever be given, for the whole of the editor's debounce and
 * for as long as a drag lasted.
 */
describe('an edit that lands while a job works', () => {
  const cut = {
    ...edit,
    segments: [
      { startMs: 0, endMs: 400 },
      { startMs: 700, endMs: 1000 },
    ],
  } as unknown as EditState

  it('stops the job where it is', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    expect(editBindsPrerender({ recording, edit: cut, settings })).toBe(true)
    expect(prerenderStatus(key)).toBeNull()
    expect(takePrerender(key)).toBeNull()
    // And the render underneath is aborted, not left running.
    expect(renderCalls).toBe(1)
  })

  /**
   * A SPLIT IS NOT A CUT. The editor holds two adjacent spans; the engine
   * merges them straight back (timeline.ts). Measured on 2026-09-02 before
   * this existed: splitting before cutting killed a render that was 20 %
   * through, for a file that would have been byte-identical.
   */
  it('a split with nothing removed keeps its job and re-aims it', () => {
    startPrerender({ recording, edit, settings })
    const split = {
      ...edit,
      segments: [
        { startMs: 0, endMs: 400 },
        { startMs: 400, endMs: 1000 },
      ],
    } as unknown as EditState
    expect(editBindsPrerender({ recording, edit: split, settings })).toBe(false)
    expect(renderCalls).toBe(1)
    // …and it now answers to the edit the editor is holding, so the export
    // that follows the split JOINS the work instead of starting it again.
    expect(prerenderStatus(prerenderKey({ recording, edit: split, settings }))?.state).toBe('running')
  })

  it('does nothing when the output has not changed', () => {
    startPrerender({ recording, edit, settings })
    expect(editBindsPrerender({ recording, edit, settings })).toBe(false)
    expect(prerenderStatus(prerenderKey({ recording, edit, settings }))?.state).toBe('running')
  })

  it('names WHERE the edit landed, on the take\'s own timeline', () => {
    expect(firstEditDivergenceMs(edit, cut)).toBe(400)
    expect(firstEditDivergenceMs(cut, edit)).toBe(400)
    expect(firstEditDivergenceMs(edit, edit)).toBeNull()
  })

  it('an export pressed after the cut can never join the pre-cut job', () => {
    startPrerender({ recording, edit, settings })
    editBindsPrerender({ recording, edit: cut, settings })
    expect(takePrerender(prerenderKey({ recording, edit: cut, settings }))).toBeNull()
    expect(takePrerender(prerenderKey({ recording, edit, settings }))).toBeNull()
  })
})
