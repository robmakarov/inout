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

vi.mock('./pipeline', () => ({
  exportRecording: (opts: { signal?: AbortSignal }) => {
    renderCalls += 1
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

const { cancelPrerender, prerenderKey, prerenderStatus, resetPrerenderForTests, startPrerender, takePrerender } =
  await import('./prerender')

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
  renderCalls = 0
  settle = null
  reject = null
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
    await expect(taken!).resolves.toBeTruthy()
    expect(renderCalls).toBe(1)
  })

  it('handing it out retires the job, so nothing deletes a file being downloaded', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    const first = takePrerender(key)
    expect(first).not.toBeNull()
    expect(takePrerender(key)).toBeNull()
    settle!(fakeResult())
    await first
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

  it('cancelling aborts the render rather than letting it finish unwanted', async () => {
    startPrerender({ recording, edit, settings })
    const key = prerenderKey({ recording, edit, settings })
    cancelPrerender()
    expect(prerenderStatus(key)).toBeNull()
    expect(takePrerender(key)).toBeNull()
  })
})
