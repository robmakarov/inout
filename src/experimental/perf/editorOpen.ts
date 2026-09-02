/**
 * EXPERIMENTAL — WHY THE EDITOR IS BLACK FOR A LONG TIME AFTER A LONG TAKE.
 *
 * Robert, 2026-09-02, on a 124-minute take: "when edit was open after long take
 * there was black screen for long time until it loaded".
 *
 * The editor's stage is `<video>` elements over the take's own channel files,
 * and a raw channel is a FRAGMENTED MP4 (rawVideo.worker.ts,
 * `fastStart: 'fragmented'`) written continuously for the length of the take.
 * A fragmented file carries no sample table: the index is spread across one
 * `moof` per fragment — one every ~2 s, so ~3,700 of them in a take that long —
 * plus an `mfra` box the muxer appends at the end. Whether the element can use
 * that index or has to walk the fragments decides whether opening the editor
 * costs milliseconds or minutes, and nothing in this project had ever asked.
 *
 * So this asks, at several lengths, in the browser that has the bug:
 *   · how long from `src` to `loadedmetadata` (the duration is known)
 *   · how long to `canplay` and to a first painted frame
 *   · how long to seek to the MIDDLE of the take and paint that frame — the
 *     one an editor pays as soon as anybody touches the timeline
 *   · the same three against a NON-fragmented file of identical content, which
 *     is the discriminator: if the plain file opens instantly and the
 *     fragmented one does not, the container is the bug and not the size.
 *
 * The answer is a SHAPE, not one number — a cost that is flat in length is a
 * fixed parse, and one that grows with length is a scan, and only the second
 * gets worse the longer Robert records.
 *
 *   node scripts/exp.mjs editoropen '{"lengths":[30,120,300]}' --headed --timeout=3600
 *
 * Fixtures are cached in OPFS under their own keys, so a second run is cheap.
 */
import { buildChannelFile, existingFixture } from './nativeRender'
import { blobStore } from '@core/store'

export interface OpenSample {
  seconds: number
  fragmented: boolean
  sizeMB: number
  /** src set → 'loadedmetadata'. */
  metadataMs: number
  /** src set → 'canplay'. */
  canPlayMs: number
  /** src set → a frame is actually on the element (readyState >= 2 and a paint). */
  firstFrameMs: number
  /** A seek to the middle, from the moment it is asked for. */
  midSeekMs: number
  /** What the element says the file is, as a sanity check on the fixture. */
  reported: { durationSec: number; width: number; height: number }
  error: string | null
}

export interface EditorOpenReport {
  samples: OpenSample[]
  notes: string[]
  verdict: string
}

const MB = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

function fixtureKeyFor(seconds: number, mbps: number, fragmented: boolean): string {
  return `eo-v1-${fragmented ? 'frag' : 'plain'}-${seconds}s-${mbps}mbps`
}

/** One element, timed from the moment it is given a source. */
async function timeOpen(blob: Blob, seconds: number, fragmented: boolean): Promise<OpenSample> {
  const url = URL.createObjectURL(blob)
  const el = document.createElement('video')
  el.preload = 'auto'
  el.muted = true
  el.playsInline = true
  // Off-screen but IN the document: a detached element is not guaranteed to be
  // given a decoder, and a decoder is what is being timed.
  el.style.cssText = 'position:fixed;left:-9999px;width:160px;height:90px'
  document.body.append(el)

  const sample: OpenSample = {
    seconds,
    fragmented,
    sizeMB: MB(blob.size),
    metadataMs: -1,
    canPlayMs: -1,
    firstFrameMs: -1,
    midSeekMs: -1,
    reported: { durationSec: 0, width: 0, height: 0 },
    error: null,
  }
  const t0 = performance.now()
  const since = (): number => Math.round(performance.now() - t0)
  const once = (name: string, budgetMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        el.removeEventListener(name, hit)
        resolve(false)
      }, budgetMs)
      const hit = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      el.addEventListener(name, hit, { once: true })
    })

  try {
    const metadata = once('loadedmetadata', 600_000)
    el.src = url
    if (!(await metadata)) {
      sample.error = 'loadedmetadata never fired within 600 s'
      return sample
    }
    sample.metadataMs = since()
    sample.reported = {
      durationSec: Math.round(el.duration * 10) / 10,
      width: el.videoWidth,
      height: el.videoHeight,
    }
    if (await once('canplay', 600_000)) sample.canPlayMs = since()
    // A frame on the element, which is what "the editor is black" is about.
    // requestVideoFrameCallback is the honest signal; it needs the element to
    // be actually producing, so nudge it with a play/pause.
    const painted = new Promise<number>((resolve) => {
      const anyEl = el as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number
      }
      if (typeof anyEl.requestVideoFrameCallback === 'function') {
        anyEl.requestVideoFrameCallback(() => resolve(since()))
      } else {
        void once('loadeddata', 600_000).then(() => resolve(since()))
      }
    })
    await el.play().catch(() => undefined)
    sample.firstFrameMs = await painted
    el.pause()

    // The seek an editor pays the moment anybody touches the timeline.
    const tSeek = performance.now()
    const seeked = once('seeked', 600_000)
    el.currentTime = el.duration / 2
    sample.midSeekMs = (await seeked) ? Math.round(performance.now() - tSeek) : -1
  } catch (err) {
    sample.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  } finally {
    el.removeAttribute('src')
    el.load()
    el.remove()
    URL.revokeObjectURL(url)
  }
  return sample
}

export async function runEditorOpen(
  opts: { lengths?: number[]; width?: number; height?: number; fps?: number; mbps?: number; rebuild?: boolean } = {},
): Promise<EditorOpenReport> {
  // Small frames on purpose: this measures the CONTAINER, and a 3024x1964
  // fixture would spend the whole budget being built. The fragment count is
  // what scales with length, and it does not care how big a frame is.
  const width = opts.width ?? 960
  const height = opts.height ?? 540
  const fps = opts.fps ?? 30
  const mbps = opts.mbps ?? 4
  const lengths = opts.lengths ?? [30, 120, 300]
  const notes: string[] = []
  const samples: OpenSample[] = []

  for (const seconds of lengths) {
    for (const fragmented of [true, false]) {
      const key = fixtureKeyFor(seconds, mbps, fragmented)
      if (opts.rebuild || (await existingFixture(key)) === null) {
        await blobStore.remove(key).catch(() => undefined)
        const built = await buildChannelFile({
          key,
          width,
          height,
          fps,
          seconds,
          mbps,
          budgetSec: 1800,
          label: `${fragmented ? 'fragmented' : 'plain'} ${seconds}s`,
          fragmented,
        })
        notes.push(`built ${key}: ${built.frames} frames, ${MB(built.bytes)} MB, ${built.ms} ms`)
      }
      const blob = await blobStore.read(key)
      samples.push(await timeOpen(blob, seconds, fragmented))
    }
  }

  // The verdict is the SHAPE: does the fragmented cost grow with length while
  // the plain one does not?
  const frag = samples.filter((s) => s.fragmented && s.firstFrameMs >= 0)
  const plain = samples.filter((s) => !s.fragmented && s.firstFrameMs >= 0)
  const slope = (rows: OpenSample[], pick: (s: OpenSample) => number): number | null => {
    if (rows.length < 2) return null
    const a = rows[0]!
    const b = rows[rows.length - 1]!
    if (b.seconds === a.seconds) return null
    return Math.round(((pick(b) - pick(a)) / (b.seconds - a.seconds)) * 1000) / 1000
  }
  const fragSlope = slope(frag, (s) => s.firstFrameMs)
  const plainSlope = slope(plain, (s) => s.firstFrameMs)
  const verdict =
    fragSlope === null || plainSlope === null
      ? 'not enough lengths to read a slope'
      : `first frame grows ${fragSlope} ms per second of take when FRAGMENTED and ` +
        `${plainSlope} ms per second when not. At 124 minutes that is ` +
        `${Math.round((fragSlope * 7440) / 100) / 10} s against ` +
        `${Math.round((plainSlope * 7440) / 100) / 10} s.`

  return { samples, notes, verdict }
}
