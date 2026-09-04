import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditState, ExportSettings, Recording } from '@core/types'

/**
 * J5's RULES, PINNED — the door between an edit and a background render.
 *
 * J3 gated the same question with a SOURCE scan (no `setTimeout(startPrerender)`
 * anywhere in the app), because the thing it was protecting was an ABSENCE and
 * one line is what comes back by accident. J5 replaces that absence with a rule,
 * so these are behavioural: the first one is still the absence Robert asked for
 * — an untouched editor renders nothing — and it is the one that must never go
 * green by accident.
 *
 * `startPrerender` is mocked; the KEY is the real one, so a change to what the
 * key covers is a change these tests read.
 */
const started: { key: string; origin: string }[] = []

vi.mock('./prerender', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('./prerender')
  return {
    ...actual,
    startPrerender: (input: Parameters<typeof actual.startPrerender>[0], origin = 'edit') => {
      started.push({ key: actual.prerenderKey(input), origin })
    },
  }
})

const { EDIT_SETTLE_MS, cancelEditRender, editRenderPending, noteEditorEdit, resetEditRenderForTests } =
  await import('./editRender')
const { setEditRenderOverrideForTests } = await import('./editRenderFlag')

const recording = { id: 'rec1', createdAt: 0, durationMs: 30_000, channels: [] } as unknown as Recording
const opened = { channels: [], segments: [{ startMs: 0, endMs: 30_000 }] } as unknown as EditState
const trimmed = { channels: [], segments: [{ startMs: 500, endMs: 30_000 }] } as unknown as EditState
const settings = { width: 1920, height: 1080, fps: 30 } as unknown as ExportSettings

/** The editor mounting: the effect fires once with the take as it opened. */
function open(edit: EditState = opened): void {
  noteEditorEdit({ recording, edit, settings, wouldRender: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  setEditRenderOverrideForTests(true)
})

afterEach(() => {
  vi.useRealTimers()
  resetEditRenderForTests()
  setEditRenderOverrideForTests(null)
  started.length = 0
})

describe('J5 — the export is made while he edits', () => {
  it('an untouched editor renders NOTHING, however long it sits there', () => {
    open()
    // The same edit arriving again is a React re-render, not a touch.
    open()
    open()
    vi.advanceTimersByTime(10 * 60_000)
    expect(editRenderPending()).toBe(false)
    expect(started).toEqual([])
  })

  it('a real edit starts one render, after it settles and not before', () => {
    open()
    const decision = noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    expect(decision.scheduled).toBe(true)
    vi.advanceTimersByTime(EDIT_SETTLE_MS - 1)
    expect(started).toEqual([])
    vi.advanceTimersByTime(1)
    expect(started.length).toBe(1)
    expect(started[0]!.origin).toBe('edit')
  })

  it('a drag is ONE render: every edit in it pushes the settle out, and the last one wins', () => {
    open()
    for (let i = 1; i <= 20; i++) {
      noteEditorEdit({
        recording,
        edit: { ...trimmed, segments: [{ startMs: i * 10, endMs: 30_000 }] } as unknown as EditState,
        settings,
        wouldRender: true,
      })
      vi.advanceTimersByTime(100)
    }
    expect(started).toEqual([])
    vi.advanceTimersByTime(EDIT_SETTLE_MS)
    expect(started.length).toBe(1)
    // The one it rendered is the edit the hand stopped on, not the one it started from.
    expect(started[0]!.key).toContain('"startMs":200')
  })

  it('a re-render with the same edit does not push the settle away', () => {
    open()
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    vi.advanceTimersByTime(EDIT_SETTLE_MS - 100)
    // Three effect runs with nothing changed: React, not a hand.
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    vi.advanceTimersByTime(100)
    expect(started.length).toBe(1)
  })

  it('an UNDO back to the take as it opened cancels the schedule and starts nothing', () => {
    open()
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    expect(editRenderPending()).toBe(true)
    noteEditorEdit({ recording, edit: opened, settings, wouldRender: true })
    expect(editRenderPending()).toBe(false)
    vi.advanceTimersByTime(10 * EDIT_SETTLE_MS)
    expect(started).toEqual([])
  })

  it('an export that would NOT render starts nothing — instant is already instant', () => {
    open()
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: false })
    vi.advanceTimersByTime(10 * EDIT_SETTLE_MS)
    expect(started).toEqual([])
  })

  it('?bgrender=0 is J3 exactly: an edit schedules nothing', () => {
    setEditRenderOverrideForTests(false)
    open()
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    expect(editRenderPending()).toBe(false)
    vi.advanceTimersByTime(10 * EDIT_SETTLE_MS)
    expect(started).toEqual([])
  })

  it('OPENING ANOTHER TAKE is not an edit, even when its edit differs from the last one', () => {
    open()
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    vi.advanceTimersByTime(EDIT_SETTLE_MS)
    expect(started.length).toBe(1)
    // A second take, opened with an edit of its own (a take edited yesterday).
    const other = { ...recording, id: 'rec2' } as Recording
    noteEditorEdit({ recording: other, edit: trimmed, settings, wouldRender: true })
    vi.advanceTimersByTime(10 * EDIT_SETTLE_MS)
    expect(started.length).toBe(1)
    // ...and now it IS touched.
    noteEditorEdit({ recording: other, edit: opened, settings, wouldRender: true })
    vi.advanceTimersByTime(EDIT_SETTLE_MS)
    expect(started.length).toBe(2)
  })

  it('leaving the editor drops the schedule — the next take never inherits a render', () => {
    open()
    noteEditorEdit({ recording, edit: trimmed, settings, wouldRender: true })
    cancelEditRender()
    expect(editRenderPending()).toBe(false)
    vi.advanceTimersByTime(10 * EDIT_SETTLE_MS)
    expect(started).toEqual([])
  })

  it('a quality step the user chose is a touch, and renders what he chose', () => {
    open()
    noteEditorEdit({
      recording,
      edit: opened,
      settings: { ...settings, width: 2560, height: 1440 } as unknown as ExportSettings,
      wouldRender: true,
    })
    vi.advanceTimersByTime(EDIT_SETTLE_MS)
    expect(started.length).toBe(1)
    expect(started[0]!.key).toContain('2560')
  })
})
