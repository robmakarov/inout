/**
 * The keyframe interval is also J1's chunk grid, so moving it moves two things.
 * Two properties are pinned here because both were live defects when the number
 * moved 5 s → 2.5 s on Robert's ruling (2026-09-04, J7):
 *
 *   1 the default IS the ruling, and `?gop=` puts the previous behaviour back;
 *   2 a chunk key made under one grid can never match a chunk made under
 *     another — the descriptor printed the UNSET settings field, so before this
 *     it printed `null` for every export on the shipped path and yesterday's
 *     5 s chunks would have been concatenated onto a 2.5 s grid.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { planChunks } from './chunkPlan'
import {
  KEYFRAME_INTERVAL_DEFAULT_SEC,
  KEYFRAME_INTERVAL_PREVIOUS_SEC,
  keyframeIntervalSec,
  setKeyframeIntervalOverride,
} from './keyframeInterval'
import { defaultEditState } from '@core/timeline'
import type { ExportSettings, Recording } from '@core/types'

const FLAGS = { cq: 20, loudness: 'peak', sourceFrame: false, fullColour: false } as const
/** Deliberately WITHOUT keyFrameIntervalSec — that is what the app passes. */
const SETTINGS: ExportSettings = { width: 1920, height: 1080, fps: 30 }

function take(durationMs: number): Recording {
  return {
    id: 'rec_gop',
    createdAt: 0,
    durationMs,
    channels: [
      {
        id: 'ch_screen',
        kind: 'screen',
        media: 'video',
        mimeType: 'video/mp4',
        blobKey: 'blob_screen',
        startOffsetMs: 0,
        durationMs,
        width: 1920,
        height: 1080,
        fps: 30,
      },
    ],
  }
}

afterEach(() => setKeyframeIntervalOverride(undefined))

describe('the keyframe interval', () => {
  it('defaults to Robert 2026-09-04 (J7): 2.5 s, not the 5 s that shipped before it', () => {
    setKeyframeIntervalOverride(undefined)
    expect(KEYFRAME_INTERVAL_DEFAULT_SEC).toBe(2.5)
    expect(KEYFRAME_INTERVAL_PREVIOUS_SEC).toBe(5)
    expect(keyframeIntervalSec()).toBe(2.5)
  })

  it('the override wins, which is how `?gop=5` reaches the render worker', () => {
    setKeyframeIntervalOverride(5)
    expect(keyframeIntervalSec()).toBe(5)
  })

  it('halving the grid doubles the chunks of the same take', () => {
    const rec = take(30_000)
    const edit = defaultEditState(rec)
    setKeyframeIntervalOverride(5)
    const coarse = planChunks({ recording: rec, edit, settings: SETTINGS, flags: FLAGS })
    setKeyframeIntervalOverride(2.5)
    const fine = planChunks({ recording: rec, edit, settings: SETTINGS, flags: FLAGS })
    expect(coarse.gopSec).toBe(5)
    expect(fine.gopSec).toBe(2.5)
    expect(fine.chunks.length).toBe(coarse.chunks.length * 2)
  })

  it('NO CHUNK KEY SURVIVES A GRID CHANGE — the descriptor carries the resolved grid', () => {
    const rec = take(30_000)
    const edit = defaultEditState(rec)
    setKeyframeIntervalOverride(5)
    const coarse = planChunks({ recording: rec, edit, settings: SETTINGS, flags: FLAGS })
    setKeyframeIntervalOverride(2.5)
    const fine = planChunks({ recording: rec, edit, settings: SETTINGS, flags: FLAGS })
    // The first chunk of each starts at 0 and covers real output either way, so
    // if the grid were absent from the print these two would collide.
    const coarseKeys = new Set(coarse.chunks.map((c) => c.descriptor))
    for (const c of fine.chunks) expect(coarseKeys.has(c.descriptor)).toBe(false)
  })
})
