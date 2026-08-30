import { useEffect, useState } from 'react'
import type { Recording } from '@core/types'

/**
 * ONE FRAME PER TAKE, for the cards on the record screen (UI1).
 *
 * Robert: "dont change how inside card look, just add preview picture left to
 * it." So this is the smallest possible version of the filmstrip that already
 * exists — `buildFilmstrip` with a single instant, which is one seek to a
 * keyframe and one short decode (F8's rig measured that path at 65 ms).
 *
 * THREE RULES, all of them the ones useLaneArt already follows and all of them
 * about not paying for a decoration:
 *
 * 1. LAZY IMPORT. The decoder is pulled only when there are takes to draw, so
 *    a first visit with an empty list never touches mediabunny (O7's
 *    first-paint rule).
 * 2. ONE AT A TIME, newest first. Several decoders racing for the same GPU on
 *    the screen whose whole job is to start a recording instantly is exactly
 *    the wrong trade; and the take you are most likely to want is the one at
 *    the top.
 * 3. EVERY FAILURE IS SILENT. No picture, and the card looks like it did
 *    before this existed — which is the correct behaviour for something the
 *    screen does not need in order to work.
 *
 * The frame is taken from the MIDDLE of the take (Robert: "mid record
 * screenshot on image"). Not the first frame, which on a screen capture is very
 * often a blank desktop or a half-painted window — every card would look the
 * same — and not a fixed offset either, which is the same mistake on a longer
 * take. The middle is where a recording is actually doing the thing it is of.
 */
const THUMB_W = 160
const THUMB_H = 120

export function useTakeThumbs(takes: Recording[] | null): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  // The ids, not the array: the list re-renders on every unrelated state change
  // and re-decoding a take because an object identity moved is the cost this
  // hook is written to avoid.
  const key = (takes ?? []).map((t) => t.id).join('|')

  useEffect(() => {
    if (!key) return
    let alive = true
    const made: string[] = []
    const abort = new AbortController()
    void (async () => {
      const rows = takes ?? []
      const { blobStore } = await import('@core/store')
      const { buildFilmstrip } = await import('@core/compose/filmstrip')
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      for (const take of rows) {
        if (!alive || abort.signal.aborted) return
        // The composite is what the take LOOKS like; without one the screen is
        // the take's subject, and without a screen the camera is.
        const video = take.channels.filter((c) => c.media === 'video')
        const source =
          take.composite?.blobKey ??
          video.find((c) => c.kind === 'screen')?.blobKey ??
          video[0]?.blobKey
        if (!source) continue
        try {
          const blob = await blobStore.read(source)
          const lenSec = Math.max(0, take.durationMs / 1000)
          const at = lenSec / 2
          const strip = await buildFilmstrip(
            blob,
            [at],
            Math.round(THUMB_W * dpr),
            Math.round(THUMB_H * dpr),
            { signal: abort.signal },
          )
          if (!alive || abort.signal.aborted) return
          if (!strip || strip.decoded === 0) continue
          const url = URL.createObjectURL(strip.blob)
          made.push(url)
          setThumbs((prev) => ({ ...prev, [take.id]: url }))
        } catch {
          // no picture for this take; the card is fine without one
        }
      }
    })()
    return () => {
      alive = false
      abort.abort()
      for (const u of made) URL.revokeObjectURL(u)
      setThumbs({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return thumbs
}
