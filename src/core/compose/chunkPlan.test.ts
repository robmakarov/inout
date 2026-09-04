/**
 * J1's gates that are arithmetic rather than wall clock.
 *
 * The expensive gates (a chunked export byte-comparable to the unbroken one, an
 * edit re-rendering only the chunks it touches IN WALL CLOCK, a killed tab
 * resuming) need a real encoder and live in the rig — `scripts/exp.mjs
 * chunkrender`. What is provable here is what decides whether those gates CAN
 * pass: the grid lands on whole frames, the key is exact in one direction and
 * conservative in the other, and nothing reads the take's length to choose a
 * strategy.
 */
import { describe, expect, it } from 'vitest'
import { audioDescriptorOf, audioPresent, planChunks, planReuse, spanPieces } from './chunkPlan'
import { defaultCameraPose, defaultEditState } from '@core/timeline'
import type { EditState, ExportSettings, Recording } from '@core/types'

const FLAGS = { cq: 20, loudness: 'peak', sourceFrame: false, fullColour: false }
const SETTINGS: ExportSettings = { width: 1920, height: 1080, fps: 30, keyFrameIntervalSec: 5 }

function take(durationMs: number, opts: { camera?: boolean; audio?: boolean } = {}): Recording {
  const channels: Recording['channels'] = [
    {
      id: 'ch_screen',
      kind: 'screen',
      media: 'video',
      mimeType: 'video/mp4',
      blobKey: 'blob_screen',
      startOffsetMs: 0,
      durationMs,
      width: 3024,
      height: 1964,
      fps: 60,
    },
  ]
  if (opts.camera) {
    channels.push({
      id: 'ch_cam',
      kind: 'camera',
      media: 'video',
      mimeType: 'video/mp4',
      blobKey: 'blob_cam',
      startOffsetMs: 0,
      durationMs,
      width: 1920,
      height: 1080,
      fps: 60,
    })
  }
  if (opts.audio) {
    channels.push({
      id: 'ch_mic',
      kind: 'mic',
      media: 'audio',
      mimeType: 'audio/webm;codecs=opus',
      blobKey: 'blob_mic',
      startOffsetMs: 0,
      durationMs,
    })
  }
  return { id: 'rec_test', createdAt: 1_700_000_000_000, durationMs, channels }
}

function plan(recording: Recording, edit: EditState, settings: ExportSettings = SETTINGS) {
  return planChunks({ recording, edit, settings, flags: FLAGS })
}

describe('the grid', () => {
  it('cuts the output into whole-frame, GOP-length chunks', () => {
    const r = take(62_000)
    const p = plan(r, defaultEditState(r))
    expect(p.chunkable).toBe(true)
    expect(p.gopSec).toBe(5)
    // 62 s at 30 fps = 1860 frames = 12 chunks of 150 plus a 60-frame tail.
    expect(p.totalFrames).toBe(1860)
    expect(p.chunks.length).toBe(13)
    for (const c of p.chunks.slice(0, -1)) expect(c.endFrame - c.startFrame).toBe(150)
    expect(p.chunks.at(-1)!.endFrame - p.chunks.at(-1)!.startFrame).toBe(60)
  })

  it('partitions the output exactly — no frame twice, none missing', () => {
    const r = take(37_400)
    const p = plan(r, defaultEditState(r))
    expect(p.chunks[0]!.startFrame).toBe(0)
    for (let i = 1; i < p.chunks.length; i++) {
      expect(p.chunks[i]!.startFrame).toBe(p.chunks[i - 1]!.endFrame)
    }
    expect(p.chunks.at(-1)!.endFrame).toBe(p.totalFrames)
  })

  it('a chunk boundary is an exact output instant at 60 fps too', () => {
    const r = take(20_000)
    const p = plan(r, defaultEditState(r), { ...SETTINGS, fps: 60 })
    for (const c of p.chunks) {
      expect(c.startSec * 60).toBe(c.startFrame)
      expect(Number.isInteger(c.startFrame)).toBe(true)
    }
  })

  it('refuses a grid that would not land on whole frames', () => {
    const r = take(20_000)
    const p = plan(r, defaultEditState(r), { ...SETTINGS, keyFrameIntervalSec: 0.05 })
    expect(p.chunkable).toBe(false)
    expect(p.unchunkableReason).toContain('whole number of frames')
  })

  it('refuses a take with no video — audio-only is waveform mode, not chunks', () => {
    const r: Recording = {
      id: 'rec_audio',
      createdAt: 1,
      durationMs: 20_000,
      channels: [
        {
          id: 'ch_mic',
          kind: 'mic',
          media: 'audio',
          mimeType: 'audio/webm;codecs=opus',
          blobKey: 'b',
          startOffsetMs: 0,
          durationMs: 20_000,
        },
      ],
    }
    const p = plan(r, defaultEditState(r))
    expect(p.chunkable).toBe(false)
    expect(p.unchunkableReason).toContain('no video')
  })
})

describe('the key is the edit restricted to the chunk', () => {
  it('a zoom keyframe at 40 s invalidates the seconds it covers and nothing else', () => {
    const r = take(120_000)
    const before = defaultEditState(r)
    const after: EditState = {
      ...before,
      viewport: {
        keyframes: [
          { xFrac: 0.5, yFrac: 0.5, widthFrac: 1, atMs: 38_000 },
          { xFrac: 0.4, yFrac: 0.4, widthFrac: 0.5, atMs: 40_000 },
          { xFrac: 0.4, yFrac: 0.4, widthFrac: 0.5, atMs: 42_000 },
          { xFrac: 0.5, yFrac: 0.5, widthFrac: 1, atMs: 44_000 },
        ],
      },
    }
    const p = plan(r, after)
    const use = planReuse(plan(r, before), p)
    // 120 s = 24 chunks of 5 s. The zoom lives inside 38-44 s, so only the
    // chunks covering 35-45 s may move: chunks 7 and 8.
    expect(p.chunks.length).toBe(24)
    expect(use.rerendered).toBe(2)
    expect(use.reused).toBe(22)
    // …and it changes no audio at all.
    expect(use.audioReused).toBe(true)
  })

  it('a background change invalidates every chunk, and says so honestly', () => {
    const r = take(60_000)
    const before = defaultEditState(r)
    const after: EditState = {
      ...before,
      background: { preset: 'dusk', padFrac: 0.06, radiusFrac: 0.02, shadow: true },
    }
    const p = plan(r, after)
    const use = planReuse(plan(r, before), p)
    expect(use.reused).toBe(0)
    expect(use.rerendered).toBe(p.chunks.length)
    // A background is a picture change: the audio is untouched.
    expect(use.audioReused).toBe(true)
  })

  it('the same edit twice is the same plan — a re-export renders nothing', () => {
    const r = take(60_000, { camera: true, audio: true })
    const e = defaultEditState(r)
    const use = planReuse(plan(r, e), plan(r, e))
    expect(use.rerendered).toBe(0)
    expect(use.audioReused).toBe(true)
  })

  it('a track resting at the default is the same key as no track at all', () => {
    // Otherwise "the user opened the zoom tool and changed nothing" would cost
    // a whole re-render, and an undo could never be a hit.
    const r = take(30_000, { camera: true })
    const base = defaultEditState(r)
    const inert: EditState = {
      ...base,
      viewport: { keyframes: [{ xFrac: 0.5, yFrac: 0.5, widthFrac: 1, atMs: 10_000 }] },
    }
    expect(planReuse(plan(r, base), plan(r, inert)).rerendered).toBe(0)
  })

  it('AN UNDO IS A CACHE HIT — the disk still holds what the edit came back to', () => {
    // The store is content-addressed, so this is exactly a set of descriptors
    // that only grows. Render base, edit, then undo: the third export finds
    // every chunk it needs already on disk.
    const r = take(60_000)
    const base = defaultEditState(r)
    const zoomed: EditState = {
      ...base,
      viewport: {
        keyframes: [
          { xFrac: 0.5, yFrac: 0.5, widthFrac: 1, atMs: 18_000 },
          { xFrac: 0.5, yFrac: 0.5, widthFrac: 0.5, atMs: 20_000 },
          { xFrac: 0.5, yFrac: 0.5, widthFrac: 1, atMs: 22_000 },
        ],
      },
    }
    const disk = new Set<string>()
    const exportOnce = (edit: EditState): number => {
      let rendered = 0
      for (const c of plan(r, edit).chunks) {
        if (disk.has(c.descriptor)) continue
        disk.add(c.descriptor)
        rendered++
      }
      return rendered
    }
    expect(exportOnce(base)).toBe(12) // 60 s / 5 s
    expect(exportOnce(zoomed)).toBe(2) // only the seconds the zoom covers
    expect(exportOnce(base)).toBe(0) // the undo costs nothing at all
  })

  it('a keyframe outside the chunk still counts when it shapes the value inside', () => {
    // The value at a chunk edge interpolates from a keyframe OUTSIDE it. A key
    // that ignored the bracketing pair would serve a stale chunk.
    const r = take(60_000)
    const base = defaultEditState(r)
    const ramp = (endWidth: number): EditState => ({
      ...base,
      viewport: {
        keyframes: [
          { xFrac: 0.5, yFrac: 0.5, widthFrac: 1, atMs: 0 },
          { xFrac: 0.5, yFrac: 0.5, widthFrac: endWidth, atMs: 30_000 },
        ],
      },
    })
    // The chunk covering 20-25 s contains NEITHER keyframe, yet the ramp
    // through it differs, so its descriptor must differ.
    const a = plan(r, ramp(0.5)).chunks.find((c) => c.startSec === 20)!
    const b = plan(r, ramp(0.25)).chunks.find((c) => c.startSec === 20)!
    expect(a.descriptor).not.toBe(b.descriptor)
  })

  it('a camera move costs the move and everything after it, which is the truth', () => {
    // A drag at 60 s leaves the PiP somewhere else for the rest of the take —
    // so every later chunk really does draw different pixels, and the ones
    // before it really do not.
    const r = take(120_000, { camera: true })
    const base = defaultEditState(r)
    // The drag writes a PAIR: an anchor holding the pose the PiP was already
    // resting at, and the target (F4, cameraTrack.ts). The anchor IS the
    // default slot, which is why everything before it can hit.
    const rest = defaultCameraPose({ frameAspect: 1920 / 1080, cameraAspect: 1920 / 1080 })
    const moved: EditState = {
      ...base,
      camera: {
        keyframes: [
          { ...rest, atMs: 60_000 },
          { xFrac: 0.2, yFrac: 0.2, widthFrac: 0.24, atMs: 61_000 },
        ],
      },
    }
    const use = planReuse(plan(r, base), plan(r, moved))
    expect(use.reused).toBe(12) // 0-60 s, untouched
    expect(use.rerendered).toBe(12) // 60-120 s, genuinely moved
  })

  it('a camera track cannot invalidate a take that draws no camera', () => {
    const r = take(60_000) // screen only
    const base = defaultEditState(r)
    const moved: EditState = {
      ...base,
      camera: { keyframes: [{ xFrac: 0.2, yFrac: 0.2, widthFrac: 0.24, atMs: 10_000 }] },
    }
    expect(planReuse(plan(r, base), plan(r, moved)).rerendered).toBe(0)
  })

  it('a settings change invalidates everything, because every pixel is different', () => {
    const r = take(30_000)
    const e = defaultEditState(r)
    const use = planReuse(plan(r, e), plan(r, e, { ...SETTINGS, width: 1280, height: 720 }))
    expect(use.reused).toBe(0)
  })

  it("a different take never reuses another take's chunks", () => {
    const a = take(30_000)
    const b = { ...take(30_000), id: 'rec_other' }
    const use = planReuse(plan(a, defaultEditState(a)), plan(b, defaultEditState(b)))
    expect(use.reused).toBe(0)
  })

  it('a video channel disabled changes the layout, and every chunk with it', () => {
    const r = take(30_000, { camera: true })
    const base = defaultEditState(r)
    const off: EditState = {
      ...base,
      channels: base.channels.map((c) => (c.channelId === 'ch_cam' ? { ...c, enabled: false } : c)),
    }
    expect(planReuse(plan(r, base), plan(r, off)).reused).toBe(0)
  })

  it('a trim moved OUTSIDE a chunk does not invalidate it; moved INTO it does', () => {
    const r = take(60_000, { camera: true })
    const base = defaultEditState(r)
    const trimTo = (ms: number): EditState => ({
      ...base,
      channels: base.channels.map((c) =>
        c.channelId === 'ch_cam' ? { ...c, trimStartMs: ms } : c,
      ),
    })
    const at30 = plan(r, trimTo(30_000)).chunks
    const at31 = plan(r, trimTo(31_000)).chunks
    // The chunk covering 0-5 s sees neither trim edge: unchanged.
    expect(at30[0]!.descriptor).toBe(at31[0]!.descriptor)
    // The chunk covering 30-35 s sees both, differently.
    expect(at30[6]!.descriptor).not.toBe(at31[6]!.descriptor)
  })
})

describe('the audio artifact', () => {
  it('is untouched by every picture edit', () => {
    const r = take(60_000, { camera: true, audio: true })
    const base = defaultEditState(r)
    const before = audioDescriptorOf({ recording: r, edit: base, settings: SETTINGS, flags: FLAGS })
    const pictureEdits: EditState[] = [
      { ...base, viewport: { keyframes: [{ xFrac: 0.5, yFrac: 0.5, widthFrac: 0.5, atMs: 10_000 }] } },
      { ...base, camera: { keyframes: [{ xFrac: 0.2, yFrac: 0.2, widthFrac: 0.24, atMs: 10_000 }] } },
      { ...base, background: { preset: 'dusk', padFrac: 0.06, radiusFrac: 0.02, shadow: true } },
    ]
    for (const edit of pictureEdits) {
      expect(audioDescriptorOf({ recording: r, edit, settings: SETTINGS, flags: FLAGS })).toBe(before)
    }
  })

  it('is rewritten by a cut, a trim and a speed change — the work that changed', () => {
    const r = take(60_000, { audio: true })
    const base = defaultEditState(r)
    const before = audioDescriptorOf({ recording: r, edit: base, settings: SETTINGS, flags: FLAGS })
    const cut: EditState = {
      ...base,
      segments: [
        { startMs: 0, endMs: 20_000 },
        { startMs: 30_000, endMs: 60_000 },
      ],
    }
    const sped: EditState = { ...base, segments: [{ startMs: 0, endMs: 60_000, speed: 2 }] }
    const trimmed: EditState = {
      ...base,
      channels: base.channels.map((c) =>
        c.channelId === 'ch_mic' ? { ...c, trimStartMs: 5_000 } : c,
      ),
    }
    for (const edit of [cut, sped, trimmed]) {
      expect(audioDescriptorOf({ recording: r, edit, settings: SETTINGS, flags: FLAGS })).not.toBe(
        before,
      )
    }
  })

  it('answers whether there is audio the same way the mixers will', () => {
    const withAudio = take(30_000, { audio: true })
    expect(audioPresent(withAudio, defaultEditState(withAudio))).toBe(true)
    const withoutAudio = take(30_000)
    expect(audioPresent(withoutAudio, defaultEditState(withoutAudio))).toBe(false)
    // A channel with no ChannelEdit opens no mixer — the `!ce` branch of
    // openAudioMixers, which a bare default of `true` would get wrong.
    expect(audioPresent(withAudio, { ...defaultEditState(withAudio), channels: [] })).toBe(false)
  })
})

describe('spanPieces — the time half of the restriction', () => {
  it('reports the source material a chunk shows', () => {
    const r = take(60_000)
    const pieces = spanPieces(defaultEditState(r), 10, 15)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]!.recStartMs).toBe(10_000)
    expect(pieces[0]!.recEndMs).toBe(15_000)
    expect(pieces[0]!.speed).toBe(1)
  })

  it('splits a chunk that straddles a cut into its two sources', () => {
    const r = take(60_000)
    const edit: EditState = {
      ...defaultEditState(r),
      segments: [
        { startMs: 0, endMs: 12_000 },
        { startMs: 30_000, endMs: 60_000 },
      ],
    }
    const pieces = spanPieces(edit, 10, 15)
    expect(pieces).toHaveLength(2)
    expect(pieces[0]!.recEndMs).toBe(12_000)
    expect(pieces[1]!.recStartMs).toBe(30_000)
  })
})

describe('THE RULING — no length heuristic anywhere in the export', () => {
  /**
   * Robert 2026-09-02 (DECISIONS robert (14)): "we need to expect and be ready
   * for any lenght take and any edits after". A gate that cannot fail is not a
   * gate (note 17), so this one is written to fail on the exact shape that used
   * to be in render.ts — `jobPixels > PACE_ABOVE_PIXELS` — and on anything of
   * the same family that comes back. A comparison against ZERO is not that
   * shape: "is there any output at all" is a question about emptiness, and
   * every module here asks it.
   */
  // Read through the bundler rather than `node:fs`: this project has no node
  // types, and a gate that needs a devDependency to compile is a gate that gets
  // deleted the first time it is inconvenient.
  const sources = Object.entries(
    import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >,
  )
    .filter(([file]) => !file.endsWith('.test.ts'))
    .map(([file, text]) => ({ file, text }))

  it('actually reads the modules it is gating', () => {
    // A file list that came back empty would make the gate below pass by
    // reading nothing at all — note 17, a gate that cannot fail is not a gate.
    expect(sources.length).toBeGreaterThan(20)
    expect(sources.map((s) => s.file)).toContain('./render.ts')
    expect(sources.find((s) => s.file === './render.ts')!.text).toContain('PACE_EVERY_FRAMES')
  })

  it('no compose module compares a duration or a frame count against a threshold', () => {
    const banned =
      /\b(durationMs|durationSec|totalFrames|takeSec|lengthMs|lengthSec|jobPixels|outputDurationMs\(\w*\))\s*[<>]=?\s*(?!0\b)[\d_]/
    const offenders: string[] = []
    for (const { file, text } of sources) {
      // Comments and strings first: these files argue about this at length, and
      // the argument must not read as the crime.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      const hit = banned.exec(code)
      if (hit) offenders.push(`${file}: ${hit[0].trim()}`)
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it is meant to catch', () => {
    // Born red against the deleted code, so the gate is known to be able to
    // fail rather than merely believed to be.
    const banned =
      /\b(durationMs|durationSec|totalFrames|takeSec|lengthMs|lengthSec|jobPixels)\s*[<>]=?\s*(?!0\b)[\d_]/
    expect(banned.test('const paceEvery = jobPixels > 14929920000 ? 30 : 0')).toBe(true)
    expect(banned.test('if (durationSec > 600) return "long"')).toBe(true)
    expect(banned.test('if (durationMs <= 0) throw new Error("empty")')).toBe(false)
  })

  it('the plan is the same shape at 2 minutes and at 2 hours', () => {
    const short = take(120_000)
    const long = take(7_200_000)
    const a = plan(short, defaultEditState(short))
    const b = plan(long, defaultEditState(long))
    expect(a.gopSec).toBe(b.gopSec)
    expect(a.chunkable).toBe(b.chunkable)
    const lens = (p: typeof a): Set<number> =>
      new Set(p.chunks.slice(0, -1).map((c) => c.endFrame - c.startFrame))
    expect(lens(a)).toEqual(lens(b))
    // The COUNT is arithmetic, not policy.
    expect(b.chunks.length).toBe(Math.ceil(b.totalFrames / 150))
  })

  it('a two-hour take plans in a blink — the planner is not the new cost', () => {
    const r = take(7_200_000, { camera: true, audio: true })
    const edit: EditState = {
      ...defaultEditState(r),
      viewport: {
        keyframes: Array.from({ length: 200 }, (_, i) => ({
          xFrac: 0.5,
          yFrac: 0.5,
          widthFrac: i % 2 ? 1 : 0.5,
          atMs: i * 36_000,
        })),
      },
    }
    const t0 = performance.now()
    const p = plan(r, edit)
    const ms = performance.now() - t0
    expect(p.chunks.length).toBe(1440)
    expect(ms).toBeLessThan(4000)
  })
})
