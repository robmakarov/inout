import { useEffect, useRef, useState } from 'react'
import type { Recording } from '@core/types'
import { blobStore } from '@core/store'
import { planFilmstrip } from '@app/lib/filmstripPlan'

/**
 * The timeline's picture (task F8), fetched once per take and kept out of the
 * render path.
 *
 * THREE THINGS THIS HOOK EXISTS TO GET RIGHT, all of them about not paying for
 * a decoration:
 *
 * 1. IT IS DYNAMIC-IMPORTED. The strip builder pulls mediabunny's demuxer and a
 *    video decoder; the editor already carries them, but the import stays lazy
 *    so a take with no video channel never touches them at all.
 * 2. IT DOES NOT RE-DECODE ON EVERY RESIZE. Width is rounded into buckets, so
 *    dragging a window edge redraws the CSS and re-runs the decoder only when
 *    the lane has actually changed size by a thumbnail's worth.
 * 3. IT DECODES ONE CHANNEL AT A TIME. Two decoders racing for the same GPU
 *    while the editor is trying to hold 60 fps is how a nicety becomes a jank
 *    report; the strips land one after another and each appears as it lands.
 *
 * Every failure is silent and total: no strip, and the lane looks exactly as it
 * did before F8. That is the correct behaviour for something the editor does
 * not need.
 */
export interface Strip {
  url: string
  count: number
  /** Reported, because F8's gate asks what generation costs. */
  wallMs: number
  decoded: number
}

/** Width buckets, CSS px — see note 2 above. */
const WIDTH_BUCKET = 48

export function useFilmstrips(
  recording: Recording,
  trackWidthPx: number,
  thumbHeightPx: number,
): Record<string, Strip> {
  const [strips, setStrips] = useState<Record<string, Strip>>({})
  // Revoked on unmount and on every rebuild; an object URL that outlives its
  // take is a leak nobody sees until a long session runs out of them.
  const urls = useRef<string[]>([])

  const bucket = Math.round(trackWidthPx / WIDTH_BUCKET)
  const totalMs = Math.max(1, recording.durationMs)
  const videoKey = recording.channels
    .filter((c) => c.media === 'video')
    .map((c) => `${c.id}:${c.durationMs}`)
    .join('|')

  useEffect(() => {
    let alive = true
    const abort = new AbortController()
    const widthPx = bucket * WIDTH_BUCKET
    if (widthPx <= 0 || !videoKey) return
    void (async () => {
      const { buildFilmstrip } = await import('@core/compose/filmstrip')
      if (!alive) return
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      for (const ch of recording.channels) {
        if (!alive || abort.signal.aborted) return
        if (ch.media !== 'video') continue
        const barPx = (ch.durationMs / totalMs) * widthPx
        const plan = planFilmstrip(barPx, ch.durationMs / 1000, thumbHeightPx)
        if (!plan) continue
        let blob: Blob
        try {
          blob = await blobStore.read(ch.blobKey)
        } catch {
          continue
        }
        const strip = await buildFilmstrip(
          blob,
          plan.atSec,
          Math.round(plan.thumbWidthPx * dpr),
          Math.round(thumbHeightPx * dpr),
          { signal: abort.signal },
        )
        if (!alive || abort.signal.aborted) return
        if (!strip) continue
        const url = URL.createObjectURL(strip.blob)
        urls.current.push(url)
        console.info(
          `[timeline] filmstrip ${ch.kind}: ${strip.decoded}/${strip.count} frames in ${strip.wallMs} ms`,
        )
        setStrips((prev) => ({
          ...prev,
          [ch.id]: { url, count: strip.count, wallMs: strip.wallMs, decoded: strip.decoded },
        }))
      }
    })()
    return () => {
      alive = false
      abort.abort()
      for (const u of urls.current) URL.revokeObjectURL(u)
      urls.current = []
      setStrips({})
    }
    // `recording` itself is deliberately not a dependency: the object identity
    // changes whenever anything upstream re-renders, and re-decoding a take on
    // an unrelated state change is exactly the cost this hook is written to
    // avoid. The channels' ids and lengths ARE the take, for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey, bucket, thumbHeightPx, totalMs])

  return strips
}
