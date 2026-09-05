import { useEffect, useRef, useState } from 'react'
import type { Recording } from '@core/types'
import { holdEditorAhead } from '@core/backgroundWork'
import { blobStore } from '@core/store'
import { planFilmstrip } from '@app/lib/filmstripPlan'
import type { LaneWave } from '@core/compose/lanewave'
import type { LaneWaveReply, LaneWaveRequest } from '@core/compose/laneWave.worker'

/**
 * What each timeline lane SHOWS (task F8): the take's own frames on a video
 * lane, its own sound on an audio one. Fetched once per take and kept out of
 * the render path.
 *
 * FOUR THINGS THIS HOOK EXISTS TO GET RIGHT, all of them about not paying for
 * a decoration:
 *
 * 1. IT IS DYNAMIC-IMPORTED. The builders pull mediabunny's demuxer and a
 *    decoder; the editor already carries them, but the import stays lazy so a
 *    take that needs neither never touches them.
 * 2. IT DOES NOT RE-DECODE ON EVERY RESIZE. Width is rounded into buckets, so
 *    dragging a window edge redraws the CSS and re-runs a decoder only when a
 *    lane has actually changed size by a thumbnail's worth.
 * 3. IT DECODES ONE CHANNEL AT A TIME, and VIDEO FIRST. Several decoders
 *    racing for the same GPU while the editor is trying to hold 60 fps is how
 *    a nicety becomes a jank report; and the picture is what a user looks for
 *    first, so it should not queue behind four audio tracks.
 * 4. EVERY FAILURE IS SILENT AND TOTAL. No art, and the lane looks exactly as
 *    it did before F8 — which is the correct behaviour for something the
 *    editor does not need in order to work.
 * 5. E3 — IT HOLDS THE BACKGROUND RENDER BEHIND IT WHILE IT DECODES. Both of
 *    these are decode, and at the end of a take whose export must render they
 *    are decode against the at-stop pre-render, which by then is at FULL
 *    because the preview has already painted. MEASURED on prod, 40 s take,
 *    four lanes: the art landed 628 ms after the editor opened with nothing
 *    else running and 4,133 ms beside that pre-render — 654 ms of decode
 *    against 3,405 (screen filmstrip 152 -> 1,218 ms, mic waveform 52 -> 558).
 *    The two jobs do not have the same deadline: this is what the person is
 *    looking at, and the pre-render has until the export press. So it takes a
 *    hold of the editor-ahead window (backgroundWork.ts) for as long as it is
 *    decoding, exactly as the preview does, and lets go when the last lane has
 *    its picture — or when it is aborted, or when nothing could be built.
 */
export interface LaneArt {
  url: string
  kind: 'film' | 'wave'
  /** Reported, because F8's gate asks what generation costs. */
  wallMs: number
  /** Frames or columns that actually decoded. */
  decoded: number
  /**
   * THE STRETCH OF THE TAKE THIS PICTURE IS OF, in recording ms — without it a
   * lane cannot draw a windowed strip in the right place, and it is what lets
   * the OLD picture keep being drawn correctly (stretched) while the new one
   * for a closer window is still decoding.
   */
  fromMs: number
  toMs: number
}

/** The stretch of the take the timeline is showing, in recording ms. */
export interface ArtWindow {
  fromMs: number
  toMs: number
}

/**
 * B10 — ONE WAVEFORM, BUILT IN A WORKER.
 *
 * Returns `{ wave }` when a worker answered (its `wave` may itself be null:
 * a silent or undecodable channel), and `null` only when there was no worker
 * to ask. The caller needs that difference: a fallback that cannot tell them
 * apart decodes every silent channel twice, on the thread this exists to keep
 * free.
 *
 * A worker per call, torn down with the answer. A waveform is built once per
 * channel per width bucket, so the pool this does not have would spend more
 * lines than it saves — and a worker that outlives the take is a decoder
 * holding a file the user has moved on from.
 */
async function waveInWorker(
  blob: Blob,
  /** The stretch to draw, seconds — a whole channel or one zoomed window of it. */
  durationSec: number,
  width: number,
  height: number,
  signal: AbortSignal,
  fromSec = 0,
  reference?: number,
): Promise<{ wave: LaneWave | null } | null> {
  if (typeof Worker === 'undefined') return null
  let worker: Worker
  try {
    worker = new Worker(new URL('../../core/compose/laneWave.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch {
    return null
  }
  try {
    return await new Promise<{ wave: LaneWave | null } | null>((resolve) => {
      const done = (v: { wave: LaneWave | null } | null): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      }
      // An aborted build resolves as "the worker answered with nothing", not as
      // "there is no worker": re-running it inline is the last thing an
      // unmounting editor needs.
      function onAbort(): void {
        done({ wave: null })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      worker.onmessage = (ev: MessageEvent<LaneWaveReply>) => done({ wave: ev.data.wave })
      worker.onerror = () => done(null)
      const req: LaneWaveRequest = {
        id: 'wave',
        blob,
        durationSec,
        width,
        height,
        fromSec,
        reference,
      }
      worker.postMessage(req)
    })
  } finally {
    worker.terminate()
  }
}

/** Width buckets, CSS px — see note 2 above. */
const WIDTH_BUCKET = 48
/** How tall an audio lane's waveform is drawn, CSS px (the lane is 24). */
const WAVE_HEIGHT_PX = 22

/**
 * ART FOR A ZOOMED WINDOW — Robert 2026-09-05: "frames and beatrate stretches,
 * must adapt smoothly, to show more frames or details".
 *
 * The strip and the waveform were built once, for the whole channel, at the
 * lane's width. Zooming in therefore magnified a picture instead of drawing a
 * closer one: 48 thumbnails of a 90-minute take stay 48 thumbnails however
 * close you get, and at a two-second window one of them is smeared across the
 * screen. So the picture is now made for the WINDOW, and three rules keep it
 * from costing anything:
 *
 * 1. IT COVERS MORE THAN THE SCREEN. The art spans the window plus a quarter of
 *    one either side, so small pans need no new picture at all — and the drawn
 *    bars are clipped tighter than that, so a bar can never reach past the
 *    picture it is showing a slice of.
 * 2. IT ONLY REBUILDS WHEN IT HAS TO: when the window leaves what was built, or
 *    when the zoom has moved by half again. A settle delay swallows the rest of
 *    a pinch, and an in-flight build is aborted the moment it is superseded.
 * 3. THE OLD PICTURE STAYS UP UNTIL THE NEW ONE LANDS. Each art carries the
 *    stretch it is of, so the lane keeps drawing the right slice of the old one
 *    — magnified, exactly as before — and swaps to the sharp one when it
 *    arrives. Nothing ever blanks, which is what "smoothly" has to mean.
 *
 * A SHORTER WINDOW IS CHEAPER, NOT DEARER: the same 48 seeks land within
 * seconds of each other instead of across an hour.
 */
/** How much beyond the window the picture reaches, in window widths, each side. */
const ART_SLACK = 0.25
/** A zoom that has moved by this factor is a new picture. */
const ZOOM_TOLERANCE = 1.5
/** A pinch is many events; wait for the hand to stop before decoding. */
const SETTLE_MS = 260

/** The window the art should cover for a given view — the view plus its slack. */
function artWindowFor(view: ArtWindow | null, totalMs: number): ArtWindow {
  if (!view) return { fromMs: 0, toMs: totalMs }
  const span = Math.max(1, view.toMs - view.fromMs)
  return {
    fromMs: Math.max(0, view.fromMs - span * ART_SLACK),
    toMs: Math.min(totalMs, view.toMs + span * ART_SLACK),
  }
}

/** Is the picture that was built still the right one for this view? */
function artHolds(built: ArtWindow | null, view: ArtWindow | null, totalMs: number): boolean {
  if (!built) return false
  const want = artWindowFor(view, totalMs)
  const shown = view ?? { fromMs: 0, toMs: totalMs }
  // It must still COVER what is on screen...
  if (shown.fromMs < built.fromMs - 0.5 || shown.toMs > built.toMs + 0.5) {
    // ...unless it already reaches the ends of the take, where there is no more
    // to cover and a pan against the edge must not rebuild forever.
    if (!(built.fromMs <= 0.5 && built.toMs >= totalMs - 0.5)) return false
  }
  // ...and be of roughly the right closeness.
  const builtSpan = Math.max(1, built.toMs - built.fromMs)
  const wantSpan = Math.max(1, want.toMs - want.fromMs)
  const ratio = Math.max(builtSpan / wantSpan, wantSpan / builtSpan)
  return ratio <= ZOOM_TOLERANCE
}

export function useLaneArt(
  recording: Recording,
  trackWidthPx: number,
  thumbHeightPx: number,
  /** What the timeline is showing. `null` (or absent) is the whole take, which
   *  is the identity: every number below is what it was before the zoom. */
  view: ArtWindow | null = null,
): Record<string, LaneArt> {
  const [art, setArt] = useState<Record<string, LaneArt>>({})
  // Revoked on unmount and when a take is replaced; an object URL that outlives
  // its take is a leak nobody sees until a long session runs out of them.
  const urls = useRef<string[]>([])

  const bucket = Math.round(trackWidthPx / WIDTH_BUCKET)
  const totalMs = Math.max(1, recording.durationMs)
  const channelKey = recording.channels.map((c) => `${c.id}:${c.media}:${c.durationMs}`).join('|')

  /**
   * WHAT IS BEING BUILT, and the only thing the build effect depends on. Held
   * as state (not read from `view` directly) so a drag that moves the window
   * every frame cannot restart a decoder every frame: the check below runs on
   * every render, the request changes only when the answer does.
   */
  const [request, setRequest] = useState<ArtWindow>(() => artWindowFor(view, totalMs))
  const builtRef = useRef<ArtWindow | null>(null)
  /**
   * EACH CHANNEL'S OWN LEVEL, learnt from the first picture — the one of the
   * whole channel, which the editor always draws before anything is zoomed.
   * Every later window is drawn against it, so the height of a lane means the
   * same thing however close you are. Without this a quiet passage would stand
   * up the moment you looked at it closely, and the same second of audio would
   * change height as the window slid over it.
   */
  const waveRefs = useRef<Record<string, number>>({})
  const viewFrom = view?.fromMs ?? null
  const viewTo = view?.toMs ?? null
  useEffect(() => {
    const now: ArtWindow | null = viewFrom === null || viewTo === null ? null : { fromMs: viewFrom, toMs: viewTo }
    if (artHolds(builtRef.current, now, totalMs)) return
    const want = artWindowFor(now, totalMs)
    // Already asked for this one and it has not landed yet.
    if (Math.abs(want.fromMs - request.fromMs) < 0.5 && Math.abs(want.toMs - request.toMs) < 0.5) return
    const t = setTimeout(() => setRequest(want), SETTLE_MS)
    return () => clearTimeout(t)
  }, [viewFrom, viewTo, totalMs, request.fromMs, request.toMs])

  // A different take starts from nothing — the old take's pictures are of
  // material that is no longer on the screen.
  useEffect(() => {
    builtRef.current = null
    waveRefs.current = {}
    setArt({})
    for (const u of urls.current) URL.revokeObjectURL(u)
    urls.current = []
  }, [channelKey])

  useEffect(() => {
    let alive = true
    const abort = new AbortController()
    const widthPx = bucket * WIDTH_BUCKET
    if (widthPx <= 0 || !channelKey) return
    const artFrom = Math.max(0, Math.min(request.fromMs, totalMs))
    const artTo = Math.max(artFrom + 1, Math.min(request.toMs, totalMs))
    /** What one ms of the take is worth on screen right now. */
    const pxPerMs = widthPx / Math.max(1, artTo - artFrom)
    const release = holdEditorAhead('the timeline lane art')
    void (async () => {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      /**
       * The new picture goes up and the one it replaces is let go a moment
       * later — not in the same breath, because the browser may still be
       * painting the frame that used it, and a background that vanishes for one
       * frame is exactly the flicker this whole hook is trying not to cause.
       */
      const publish = (id: string, next: LaneArt): void => {
        urls.current.push(next.url)
        setArt((prev) => {
          const old = prev[id]
          if (old) {
            setTimeout(() => {
              URL.revokeObjectURL(old.url)
              urls.current = urls.current.filter((u) => u !== old.url)
            }, 1000)
          }
          return { ...prev, [id]: next }
        })
      }
      // Video first — see note 3.
      const ordered = [
        ...recording.channels.filter((c) => c.media === 'video'),
        ...recording.channels.filter((c) => c.media !== 'video'),
      ]
      let filmstrip: typeof import('@core/compose/filmstrip').buildFilmstrip | null = null
      let lanewave: typeof import('@core/compose/lanewave').buildLaneWave | null = null

      for (const ch of ordered) {
        if (!alive || abort.signal.aborted) return
        /**
         * THE PART OF THIS CHANNEL THE PICTURE IS OF — the requested window
         * intersected with the file's own place in the take. A channel that
         * starts at minute 40 is not asked for its first second when the window
         * is at minute 41, and a channel nowhere near the window is not decoded
         * at all: at a close zoom, most of a take is not drawn.
         */
        const chStart = ch.startOffsetMs
        const chEnd = chStart + ch.durationMs
        const fromMs = Math.max(chStart, artFrom)
        const toMs = Math.min(chEnd, artTo)
        if (!(toMs > fromMs)) continue
        const barPx = (toMs - fromMs) * pxPerMs
        const spanSec = (toMs - fromMs) / 1000
        const fromSec = (fromMs - chStart) / 1000
        if (!(barPx > 0) || !(spanSec > 0)) continue
        let blob: Blob
        try {
          blob = await blobStore.read(ch.blobKey)
        } catch {
          continue
        }
        if (ch.media === 'video') {
          const plan = planFilmstrip(barPx, spanSec, thumbHeightPx, fromSec)
          if (!plan) continue
          filmstrip ??= (await import('@core/compose/filmstrip')).buildFilmstrip
          const strip = await filmstrip(
            blob,
            plan.atSec,
            Math.round(plan.thumbWidthPx * dpr),
            Math.round(thumbHeightPx * dpr),
            { signal: abort.signal },
          )
          if (!alive || abort.signal.aborted) return
          if (!strip) continue
          console.info(
            `[timeline] filmstrip ${ch.kind}: ${strip.decoded}/${strip.count} frames in ${strip.wallMs} ms`,
          )
          publish(ch.id, {
            url: URL.createObjectURL(strip.blob),
            kind: 'film',
            wallMs: strip.wallMs,
            decoded: strip.decoded,
            fromMs,
            toMs,
          })
        } else {
          // B10 — THE AUDIO DECODER GOES TO A WORKER, THE VIDEO ONE DOES NOT.
          // G7 named the blocking task: `output() via AudioDataOutputCallback`,
          // 192.7 ms of blocking in a 269 ms frame, while the filmstrip's video
          // callback blocks 0 ms because it yields. A waveform built here is a
          // frame the editor does not get to draw.
          const offThread = await waveInWorker(
            blob,
            spanSec,
            Math.round(barPx * dpr),
            Math.round(WAVE_HEIGHT_PX * dpr),
            abort.signal,
            fromSec,
            waveRefs.current[ch.id],
          )
          // `null` here means NO WORKER (an old browser, a blocked
          // construction, a test environment) — not "no waveform". A worker
          // that answered with nothing has already decided, and decoding the
          // same channel a second time on this thread is the very cost B10 is
          // about.
          const wave =
            offThread === null
              ? await (lanewave ??= (await import('@core/compose/lanewave')).buildLaneWave)(
                  blob,
                  spanSec,
                  Math.round(barPx * dpr),
                  Math.round(WAVE_HEIGHT_PX * dpr),
                  { signal: abort.signal, fromSec, reference: waveRefs.current[ch.id] },
                )
              : offThread.wave
          if (!alive || abort.signal.aborted) return
          if (!wave) continue
          // The whole-channel picture sets the level for every window after it.
          if (fromMs <= chStart + 0.5 && toMs >= chEnd - 0.5) waveRefs.current[ch.id] = wave.reference
          console.info(
            `[timeline] waveform ${ch.kind}: ${wave.decoded}/${wave.columns} columns in ` +
              `${wave.wallMs} ms, peak ${wave.peak.toFixed(3)}, ref ${wave.reference.toFixed(3)}`,
          )
          publish(ch.id, {
            url: URL.createObjectURL(wave.blob),
            kind: 'wave',
            wallMs: wave.wallMs,
            decoded: wave.decoded,
            fromMs,
            toMs,
          })
        }
      }
    })()
      .then(() => {
        // What is on the screen now, so the next render can tell whether it
        // still holds. Only on a build that ran to the end: a superseded one
        // must not claim a window it never finished drawing.
        if (alive && !abort.signal.aborted) builtRef.current = { fromMs: artFrom, toMs: artTo }
      })
      .finally(release)
    return () => {
      alive = false
      abort.abort()
      // The build may still be inside a decode it cannot interrupt; letting go
      // here as well means an editor that closes never leaves the render held
      // down waiting for art nobody will see. Releasing twice is a no-op.
      release()
      // THE PICTURES ARE NOT THROWN AWAY HERE ANY MORE. This effect re-runs
      // every time the window moves far enough to want a closer picture, and
      // clearing the art on the way out is what would make every zoom step
      // blink through an empty lane. They are released with the TAKE (the
      // effect above) and replaced one at a time by `publish`.
    }
    // `recording` itself is deliberately not a dependency: the object identity
    // changes whenever anything upstream re-renders, and re-decoding a take on
    // an unrelated state change is exactly the cost this hook is written to
    // avoid. The channels' ids, media and lengths ARE the take, for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey, bucket, thumbHeightPx, totalMs, request.fromMs, request.toMs])

  return art
}
