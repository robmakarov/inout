/**
 * THE RENDER REMEMBERS — the plan, and it is pure (task J1).
 *
 * THE RULING FIRST, because it deletes the cheap answers. Robert, 2026-09-02
 * (DECISIONS robert (14)): "i feel like its all bullshit way to try to guess
 * for render, we need to expect and be ready for any lenght take and any edits
 * after". So: no length heuristic, no predicted-duration budget, no policy that
 * behaves differently at 2 minutes and at 2 hours. Work is proportional to WHAT
 * CHANGED. Nothing in this file may read the take's length to decide anything —
 * the plan's SIZE follows the output, the plan's CONTENT never does.
 *
 * WHAT IS BROKEN WITHOUT IT: the at-stop pre-render renders the whole take,
 * `editBindsPrerender` cancels it on any edit, and `startPrerender` begins again
 * from zero 1.2 s later. A frame preset and a zoom cost two discarded hour-long
 * renders before Export is even pressed. The work was never wrong — it was
 * thrown away.
 *
 * THE SHAPE. The OUTPUT timeline is cut into GOP-aligned chunks at the export
 * keyframe interval, counted in exact output FRAME indices:
 *
 *     chunk i = output frames [i·gop·fps, (i+1)·gop·fps)
 *
 * `gop·fps` is a whole number at both rates this product exports (5×30, 5×60),
 * so the grid is exact and a concatenated file's frame timestamps are the
 * unbroken render's own k/fps. There is no drift to bound because there is none.
 *
 * THE KEY IS THE WHOLE POINT. Each chunk is identified by its CONTENT: the
 * recording, the settings, and THE EDIT RESTRICTED TO THAT CHUNK'S OUTPUT SPAN.
 * `firstEditDivergenceMs` (prerender.ts) answers "where do two edits first
 * differ" and is the wrong granularity for this; the question that makes an edit
 * cheap is "does THIS chunk differ", asked chunk by chunk. A zoom keyframe at
 * 40:00 invalidates the seconds it covers and nothing else. A background change
 * invalidates all of them, because it changes every pixel — and that is a fact,
 * not a guess.
 *
 * CONSERVATIVE IN ONE DIRECTION ONLY. A key that summarised the edit would
 * eventually serve one take's pixels for another take's edit — prerender.ts
 * says so about its own key and it is the single worst thing this module could
 * do. So every restriction here is exact or over-inclusive: it may re-render a
 * chunk that did not need it, never skip one that did. `KEY_VERSION` is the
 * blanket: any change to the draw, the layout, the codec choice or this file
 * bumps it and every cached chunk on every machine becomes garbage.
 *
 * WHAT IT DOES NOT PRETEND TO DO. A TIME SHIFT — a cut or a delete — moves every
 * later chunk's output span onto different source instants, and the shift is not
 * generally a whole number of frames, so those chunks' pixels genuinely differ
 * at sub-frame phase. Exact reuse across a shift is not achievable and claiming
 * it would be the guess the ruling forbids. It also costs nothing real: a
 * PIXEL-DEFAULT time edit never reaches the render at all (compose/choose.ts
 * takes smart cut), and where a shift happens to be a whole number of frames the
 * content key hits for free without anyone asking it to.
 */
import {
  cameraPoseAt,
  keptSegments,
  outputDurationMs,
  segmentSpeed,
  viewportAt,
} from '@core/timeline'
import {
  DEFAULT_EXPORT_SETTINGS,
  type ChannelRecording,
  type EditState,
  type ExportSettings,
  type Recording,
} from '@core/types'
import { KEYFRAME_INTERVAL_SEC } from './codecs'

/**
 * Bump on ANY change that can move a pixel or a byte: the draw (layout.ts,
 * background.ts), the codec ladder, the frame geometry, the descriptor built
 * below. A stale chunk decoded into a new file is silent corruption; a version
 * bump is a re-render. There is only ever one right way to be wrong here.
 */
export const KEY_VERSION = 'j1-v1'

/** Everything the draw reads that is not the recording, the edit or the settings. */
export interface RenderFlagPrint {
  /** Constant-quality QP, or null for the bitrate target. */
  cq: number | null
  /** 'peak' | 'r128' — changes the audio, not the picture; carried by both keys. */
  loudness: string
  /** F13's `?sourceframe=` — silently drew the camera with a different fit. */
  sourceFrame: boolean
}

export interface ChunkPlanInput {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
  flags: RenderFlagPrint
}

/** One GOP-aligned piece of the output, and the content that identifies it. */
export interface PlannedChunk {
  /** Position in the plan. NOT part of the key — a chunk is its content. */
  index: number
  /** Output frame indices, [startFrame, endFrame). */
  startFrame: number
  endFrame: number
  /** Output seconds, exactly startFrame/fps and endFrame/fps. */
  startSec: number
  endSec: number
  /** The content descriptor, before hashing. Hashed by chunkStore. */
  descriptor: string
}

export interface ChunkPlan {
  chunks: PlannedChunk[]
  /** Output frames in the whole export — the sum of the chunks', by construction. */
  totalFrames: number
  fps: number
  /** Seconds per chunk (the export keyframe interval). */
  gopSec: number
  /** The audio artifact's descriptor: ONE continuous encode, never chunked. */
  audioDescriptor: string
  /** False when the take has no video to chunk (waveform mode) — do not chunk. */
  chunkable: boolean
  /** Why not, when not. Evidence, never UI. */
  unchunkableReason: string | null
}

/** Rounding used everywhere a time becomes a frame index. Half a frame is the
 *  only tolerance that can matter and this is far inside it. */
const EPS = 1e-9

/** A number in the descriptor, rounded so float noise cannot invent a miss. */
const n6 = (v: number): number => Math.round(v * 1e6) / 1e6

/**
 * The output→recording mapping over one output span, as its continuous pieces.
 *
 * This is what "the edit restricted to this span" MEANS for time: which source
 * material the span shows and how fast. Two edits that map this span onto the
 * same source at the same speed draw the same frames from it, whatever they did
 * elsewhere.
 */
export interface SpanPiece {
  /** Output seconds, relative to the CHUNK's start — so the same material at
   *  the same offset inside a chunk is the same chunk wherever it sits. */
  atSec: number
  /** Recording ms this piece begins at. */
  recStartMs: number
  /** Recording ms this piece ends at. */
  recEndMs: number
  speed: number
}

export function spanPieces(edit: EditState, outStartSec: number, outEndSec: number): SpanPiece[] {
  const pieces: SpanPiece[] = []
  let acc = 0
  const a = outStartSec * 1000
  const b = outEndSec * 1000
  for (const seg of keptSegments(edit)) {
    const speed = segmentSpeed(seg)
    const lenOut = (seg.endMs - seg.startMs) / speed
    const from = Math.max(a, acc)
    const to = Math.min(b, acc + lenOut)
    if (to > from + EPS) {
      pieces.push({
        atSec: n6((from - a) / 1000),
        recStartMs: n6(seg.startMs + (from - acc) * speed),
        recEndMs: n6(seg.startMs + (to - acc) * speed),
        speed: n6(speed),
      })
    }
    acc += lenOut
    if (acc >= b) break
  }
  return pieces
}

/**
 * The keyframes that can move a pixel inside [recFromMs, recToMs] — every one
 * inside it, PLUS the nearest on each side, because the value at the edge is an
 * interpolation between a keyframe inside and one outside. Dropping the
 * bracketing pair is the classic way a cache like this serves a stale frame.
 */
function bracketingKeyframes<T extends { atMs: number }>(
  keyframes: readonly T[] | undefined,
  recFromMs: number,
  recToMs: number,
): T[] {
  if (!keyframes || keyframes.length === 0) return []
  const sorted = [...keyframes].sort((x, y) => x.atMs - y.atMs)
  const out: T[] = []
  let before: T | null = null
  for (const k of sorted) {
    if (k.atMs < recFromMs) {
      before = k
      continue
    }
    if (before) {
      out.push(before)
      before = null
    }
    out.push(k)
    if (k.atMs > recToMs) break
  }
  // Everything sits before the window: the last one still decides the value.
  if (before) out.push(before)
  return out
}

/**
 * WHAT THE RENDER ACTUALLY DRAWS IN THIS CHUNK — not which keyframes exist.
 *
 * This distinction is the difference between a cache that works and one that
 * does not, and a test found it rather than an argument (2026-09-03). Listing
 * the bracketing keyframes is EXACT, but it is exact about the wrong question:
 * a zoom keyframe placed at 40:00 becomes "the nearest keyframe before" for
 * every chunk after it, so every one of them changed its description while
 * drawing pixel for pixel what it drew before. Measured on a 120 s take: 24
 * chunks planned, 24 invalidated by one zoom. That is the feature failing at
 * its own headline.
 *
 * So the descriptor holds the RESOLVED value — `viewportAt` and `cameraPoseAt`,
 * the functions the render itself calls — and collapses the constant case:
 *
 *  · no keyframe strictly inside the chunk AND the resolved value equal at both
 *    edges ⇒ the value is constant across it, and that constant is the whole
 *    description. The proof is the interpolation: between one pair of keyframes
 *    the value is `a + (b−a)·ease(u)` with `ease` strictly increasing, so equal
 *    values at two distinct instants force a === b.
 *  · anything else ⇒ the value MOVES inside this chunk, and the keyframes that
 *    shape it go in whole. The eased curve between a pair is not recoverable
 *    from its endpoints — it depends on where those keyframes sit — so what is
 *    recorded is the keyframes, never samples of the result.
 *
 * The collapse is also what makes an ABSENT track and a track resting at the
 * default the same key, which they must be: `cameraPoseAt(undefined, …)`
 * returns `defaultCameraPose` and `viewportAt(undefined, …)` returns
 * DEFAULT_VIEWPORT, so those two takes draw the same frame and now say so.
 */
function trackPrint<K extends { atMs: number }>(
  keyframes: readonly K[] | undefined,
  recFromMs: number,
  recToMs: number,
  resolve: (recMs: number) => number[],
): unknown[] {
  const bracket = bracketingKeyframes(keyframes, recFromMs, recToMs)
  const inside = bracket.filter((k) => k.atMs > recFromMs && k.atMs < recToMs)
  const at0 = resolve(recFromMs).map(n6)
  const at1 = resolve(recToMs).map(n6)
  if (inside.length === 0 && at0.every((v, i) => v === at1[i])) return ['=', at0]
  return ['~', at0, at1, bracket.map((k) => keyframePrint(k))]
}

/** A keyframe as numbers, field order fixed so two equal ones hash the same. */
function keyframePrint(k: Record<string, unknown> & { atMs: number }): unknown[] {
  return Object.keys(k)
    .sort()
    .map((name) => {
      const v = k[name]
      return [name, typeof v === 'number' ? n6(v) : v]
    })
}


/**
 * What a VIDEO channel contributes to this span: whether it is on, and where its
 * trim edges fall RELATIVE TO THE SPAN. A trim edge outside the span clamps to
 * the boundary, so moving a trim somewhere else does not invalidate this chunk,
 * and moving it INTO this chunk does. Exact both ways.
 */
function channelPrint(
  channel: ChannelRecording,
  edit: EditState,
  recFromMs: number,
  recToMs: number,
): (string | number | boolean)[] {
  const ce = edit.channels.find((c) => c.channelId === channel.id)
  const enabled = ce ? ce.enabled : true
  const trimStart = ce ? ce.trimStartMs : 0
  const trimEnd = ce ? ce.trimEndMs : channel.durationMs
  // Channel-local window of this output span.
  const localFrom = recFromMs - channel.startOffsetMs
  const localTo = recToMs - channel.startOffsetMs
  const clamp = (v: number): number => n6(Math.min(Math.max(v, localFrom), localTo))
  return [
    channel.id,
    channel.kind,
    channel.width ?? 0,
    channel.height ?? 0,
    channel.blobKey,
    enabled,
    clamp(trimStart),
    clamp(trimEnd),
  ]
}

/**
 * WHICH CHANNELS EXIST AT ALL, and it is global on purpose. The render decides
 * `cameraFull` — does the camera fill the frame — from whether ANY screen
 * channel contributes ANYWHERE in the output (render.ts). A channel that is
 * disabled outside this chunk still changes what this chunk draws, so this goes
 * into every chunk's key. Over-inclusive, and correctly so.
 */
function globalLayoutPrint(recording: Recording, edit: EditState): string {
  const dur = outputDurationMs(edit)
  const contributes = (c: ChannelRecording): boolean => {
    if (c.media !== 'video') return false
    const ce = edit.channels.find((x) => x.channelId === c.id)
    if (ce && !ce.enabled) return false
    return dur > 0
  }
  return JSON.stringify(
    recording.channels.filter(contributes).map((c) => [c.kind, c.id]),
  )
}

/** The camera's own aspect, needed to resolve a pose exactly as the render does. */
function cameraAspectOf(recording: Recording): number {
  const cam = recording.channels.find((c) => c.media === 'video' && c.kind === 'camera')
  if (cam && cam.width && cam.height) return cam.width / cam.height
  return 16 / 9
}

function settingsPrint(s: ExportSettings, flags: RenderFlagPrint): (string | number | boolean | null)[] {
  return [
    s.width,
    s.height,
    s.fps,
    s.videoBitrate ?? null,
    s.keyFrameIntervalSec ?? null,
    flags.cq,
    flags.sourceFrame,
  ]
}

/**
 * THE AUDIO IS ONE ARTIFACT, NEVER CHUNKS, and the reason is physical: AAC and
 * opus both carry encoder priming, so concatenating separately-encoded audio
 * splices a discontinuity into every chunk boundary — a click every five
 * seconds, which is not a bounded difference, it is a broken file. So audio is
 * one continuous encode, cached under its own key.
 *
 * It is still proportional to what changed, in KIND rather than in time: a
 * zoom, a camera move, a background — every pixel edit there is — does not
 * appear in this descriptor at all, so a re-export after one of them does ZERO
 * audio work. A cut, a trim, a speed change or a channel toggle rewrites it
 * once, which is exactly the work that actually changed.
 */
export function audioDescriptorOf(input: ChunkPlanInput): string {
  const { recording, edit, flags } = input
  const settings = input.settings ?? DEFAULT_EXPORT_SETTINGS
  const audio = recording.channels
    .filter((c) => c.media === 'audio')
    .map((c) => {
      const ce = edit.channels.find((x) => x.channelId === c.id)
      return [
        c.id,
        c.kind,
        c.blobKey,
        n6(c.startOffsetMs),
        n6(c.durationMs),
        ce ? ce.enabled : true,
        ce ? n6(ce.trimStartMs) : 0,
        ce ? n6(ce.trimEndMs) : n6(c.durationMs),
      ]
    })
  return JSON.stringify([
    KEY_VERSION,
    'audio',
    recording.id,
    // The mix follows the kept spans and their speeds (time-stretched, F5b),
    // and the join fade sits at every boundary between them.
    keptSegments(edit).map((s) => [n6(s.startMs), n6(s.endMs), n6(segmentSpeed(s))]),
    n6(outputDurationMs(edit)),
    audio,
    flags.loudness,
    // The CONTAINER decides the audio codec (aac in mp4, opus in webm), and the
    // container is chosen from the video geometry — so it belongs here too.
    [settings.width, settings.height],
  ])
}

/**
 * The plan. Pure: no I/O, no clock, no storage, no browser.
 *
 * NOTHING HERE READS THE TAKE'S LENGTH TO DECIDE ANYTHING. `totalFrames` sets
 * how MANY chunks there are, which is arithmetic, not policy; every other
 * decision in this file — the grid, the key, the audio split — is identical at
 * two seconds and at two hours. `chunkPlan.test.ts` pins that as a property.
 */
export function planChunks(input: ChunkPlanInput): ChunkPlan {
  const { recording, edit, flags } = input
  const settings = input.settings ?? DEFAULT_EXPORT_SETTINGS
  const fps = settings.fps
  const gopSec = settings.keyFrameIntervalSec ?? KEYFRAME_INTERVAL_SEC
  const durationMs = outputDurationMs(edit)
  const durationSec = durationMs / 1000
  const totalFrames = Math.max(1, Math.ceil(durationSec * fps - EPS))
  const audioDescriptor = audioDescriptorOf(input)

  const hasVideo = recording.channels.some((c) => {
    if (c.media !== 'video') return false
    const ce = edit.channels.find((x) => x.channelId === c.id)
    return !ce || ce.enabled
  })

  const framesPerChunk = Math.round(gopSec * fps)
  // The grid must land on whole frames or a chunk boundary is not a frame
  // boundary and the concatenated file's timestamps drift. Both rates this
  // product exports are whole multiples; anything else falls back, loudly.
  const gridIsWhole = Math.abs(gopSec * fps - framesPerChunk) < 1e-6 && framesPerChunk >= 1

  let unchunkableReason: string | null = null
  if (durationMs <= 0) unchunkableReason = 'the export window is empty'
  else if (!hasVideo) unchunkableReason = 'the take has no video (waveform mode) — nothing to chunk'
  else if (!gridIsWhole) {
    unchunkableReason = `keyframe interval ${gopSec}s at ${fps} fps is not a whole number of frames`
  }

  const chunks: PlannedChunk[] = []
  if (!unchunkableReason) {
    const frameAspect = settings.width / settings.height
    const cameraAspect = cameraAspectOf(recording)
    const layout = globalLayoutPrint(recording, edit)
    const settingsKey = settingsPrint(settings, flags)
    const videoChannels = recording.channels.filter((c) => c.media === 'video')
    const hasCamera = videoChannels.some((c) => {
      if (c.kind !== 'camera') return false
      const ce = edit.channels.find((x) => x.channelId === c.id)
      return !ce || ce.enabled
    })

    // outputToRecordingMs walks the spans on every call; over a two-hour take
    // that is quadratic. The chunk's own pieces already hold the mapping, so
    // resolve against them — same answer, one pass.
    for (let index = 0; index * framesPerChunk < totalFrames; index++) {
      const startFrame = index * framesPerChunk
      const endFrame = Math.min(totalFrames, startFrame + framesPerChunk)
      const startSec = startFrame / fps
      const endSec = endFrame / fps
      const pieces = spanPieces(edit, startSec, endSec)
      const recFromMs = pieces.length ? pieces[0]!.recStartMs : 0
      const recToMs = pieces.length ? pieces[pieces.length - 1]!.recEndMs : 0
      const geometry = { frameAspect, cameraAspect }
      const descriptor = JSON.stringify([
        KEY_VERSION,
        recording.id,
        settingsKey,
        layout,
        // Frames, not seconds: the chunk renders this many, at this cadence.
        endFrame - startFrame,
        pieces,
        videoChannels.map((c) => channelPrint(c, edit, recFromMs, recToMs)),
        // The zoom/pan the render will resolve over this span.
        trackPrint(edit.viewport?.keyframes, recFromMs, recToMs, (ms) => {
          const v = viewportAt(edit.viewport, ms)
          return [v.xFrac, v.yFrac, v.widthFrac]
        }),
        // The camera PiP's pose, and ONLY when a camera is drawn at all: a take
        // with no camera channel draws none, so its track cannot move a pixel
        // and must not be allowed to invalidate a chunk.
        hasCamera
          ? trackPrint(edit.camera?.keyframes, recFromMs, recToMs, (ms) => {
              const p = cameraPoseAt(edit.camera, ms, geometry)
              return [p.xFrac, p.yFrac, p.widthFrac]
            })
          : null,
        edit.background ?? null,
      ])

      chunks.push({ index, startFrame, endFrame, startSec, endSec, descriptor })
    }
  }

  return {
    chunks,
    totalFrames,
    fps,
    gopSec,
    audioDescriptor,
    chunkable: unchunkableReason === null && chunks.length > 0,
    unchunkableReason,
  }
}

/**
 * Which chunks of `before`'s plan survive into `after`'s — the number the
 * evidence line has to carry, because "an edit landed" without a COUNT is not
 * proof of anything. Pure set arithmetic over the descriptors.
 */
export function planReuse(before: ChunkPlan, after: ChunkPlan): {
  reused: number
  rerendered: number
  audioReused: boolean
} {
  const have = new Set(before.chunks.map((c) => c.descriptor))
  let reused = 0
  for (const c of after.chunks) if (have.has(c.descriptor)) reused++
  return {
    reused,
    rerendered: after.chunks.length - reused,
    audioReused: before.audioDescriptor === after.audioDescriptor,
  }
}

/**
 * WILL THIS EXPORT HAVE AN AUDIO TRACK? Asked without opening a single file,
 * and it must give the SAME answer the render's own mixer set gives, because
 * the codec ladder consults it (codecs.ts) and one track carries one decoder
 * description. Mirrors openAudioMixers' filter exactly: an audio channel with
 * an enabled ChannelEdit overlapping some kept span. A MISSING edit means no
 * mixer there, which is why a bare `?? true` would be wrong here.
 */
export function audioPresent(recording: Recording, edit: EditState): boolean {
  for (const seg of keptSegments(edit)) {
    for (const channel of recording.channels) {
      if (channel.media !== 'audio') continue
      const ce = edit.channels.find((c) => c.channelId === channel.id)
      if (!ce || !ce.enabled) continue
      const recStart = channel.startOffsetMs + Math.max(0, ce.trimStartMs)
      const recEnd = channel.startOffsetMs + Math.min(channel.durationMs, ce.trimEndMs)
      if (Math.min(recEnd, seg.endMs) > Math.max(recStart, seg.startMs)) return true
    }
  }
  return false
}
