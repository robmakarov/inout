import { describe, expect, it } from 'vitest'
import type { EditState, Recording } from '@core/types'
import { defaultEditState } from '@core/timeline'
import { isCameraFull, pipRect, sceneAt, type SceneContext } from './scene'

function rec(overrides?: Partial<Recording>): Recording {
  return {
    id: 'rec_1',
    createdAt: 0,
    durationMs: 10_000,
    channels: [
      {
        id: 'ch_screen',
        kind: 'screen',
        media: 'video',
        mimeType: 'video/webm',
        blobKey: 'a',
        startOffsetMs: 0,
        durationMs: 10_000,
        width: 1280,
        height: 720,
      },
      {
        id: 'ch_cam',
        kind: 'camera',
        media: 'video',
        mimeType: 'video/webm',
        blobKey: 'b',
        startOffsetMs: 2000,
        durationMs: 6000,
        width: 640,
        height: 480,
      },
      {
        id: 'ch_mic',
        kind: 'mic',
        media: 'audio',
        mimeType: 'audio/webm',
        blobKey: 'c',
        startOffsetMs: 0,
        durationMs: 10_000,
      },
    ],
    ...overrides,
  }
}

const CTX: SceneContext = { cameraFull: false, aspect: 16 / 9, cameraAspect: 4 / 3 }

describe('sceneAt — decision #11 semantics as data', () => {
  it('screen + camera => screen full contain, camera PiP bottom-right', () => {
    const r = rec()
    const e = defaultEditState(r)
    const f = sceneAt(r, e, 3000, { ...CTX, cameraFull: isCameraFull(r, e) })
    expect(f.mode).toBe('video')
    expect(f.placements.map((p) => p.kind)).toEqual(['screen', 'camera'])
    const [screen, cam] = f.placements
    expect(screen.rect).toBeNull()
    expect(screen.fit).toBe('contain')
    expect(cam.rect).not.toBeNull()
    expect(cam.rect!.w).toBeCloseTo(0.24, 6)
    // Anchored bottom-right with margins.
    expect(cam.rect!.x + cam.rect!.w).toBeLessThan(1)
    expect(cam.rect!.y + cam.rect!.h).toBeLessThan(1)
    expect(cam.z).toBeGreaterThan(screen.z)
    // Camera-local sample time honors startOffset: 3000 - 2000.
    expect(cam.sourceMs).toBe(1000)
  })

  it('momentary screen gap: camera stays in PiP slot over background (no slot jump)', () => {
    const r = rec()
    const e = defaultEditState(r)
    // Blank the screen for [4000, 5000) via channel trim while it still
    // contributes elsewhere — composition-level cameraFull stays false.
    const e2: EditState = {
      ...e,
      channels: e.channels.map((c) =>
        c.channelId === 'ch_screen' ? { ...c, trimStartMs: 5000 } : c,
      ),
    }
    const cameraFull = isCameraFull(r, e2)
    expect(cameraFull).toBe(false)
    const f = sceneAt(r, e2, 3000, { ...CTX, cameraFull })
    expect(f.placements.map((p) => p.kind)).toEqual(['camera'])
    expect(f.placements[0].rect).not.toBeNull() // PiP, not full
    expect(f.background).toBe('#0a0a0c')
  })

  it('camera-only composition: camera covers full frame', () => {
    const r = rec()
    const e = defaultEditState(r)
    const disabledScreen: EditState = {
      ...e,
      channels: e.channels.map((c) =>
        c.channelId === 'ch_screen' ? { ...c, enabled: false } : c,
      ),
    }
    const cameraFull = isCameraFull(r, disabledScreen)
    expect(cameraFull).toBe(true)
    const f = sceneAt(r, disabledScreen, 3000, { ...CTX, cameraFull })
    expect(f.placements.map((p) => p.kind)).toEqual(['camera'])
    expect(f.placements[0].rect).toBeNull()
    expect(f.placements[0].fit).toBe('cover')
  })

  it('no video anywhere => waveform mode', () => {
    const r = rec()
    const e = defaultEditState(r)
    const audioOnly: EditState = {
      ...e,
      channels: e.channels.map((c) =>
        c.channelId === 'ch_mic' ? c : { ...c, enabled: false },
      ),
    }
    const f = sceneAt(r, audioOnly, 1000, { ...CTX, cameraFull: isCameraFull(r, audioOnly) })
    expect(f.mode).toBe('waveform')
    expect(f.placements).toHaveLength(0)
  })

  it('pip geometry matches layout.ts constants at 1920x1080', () => {
    // layout.ts: pipW = 0.24*1920 = 460.8, margin 24, radius 16.
    const rect = pipRect(CTX)
    const W = 1920
    const H = 1080
    expect(rect.w * W).toBeCloseTo(460.8, 3)
    const pipH = (rect.w * W) / (4 / 3)
    expect(rect.h * H).toBeCloseTo(pipH, 3)
    expect((1 - rect.x - rect.w) * W).toBeCloseTo(24, 3)
    expect((1 - rect.y - rect.h) * H).toBeCloseTo(24, 3)
  })
})
