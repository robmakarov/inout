import { useEffect, useRef, useState } from 'react'
import type { Recording } from '@core/types'
import { blobStore } from '@core/store'
import { planFilmstrip } from '@app/lib/filmstripPlan'

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
 */
export interface LaneArt {
  url: string
  kind: 'film' | 'wave'
  /** Reported, because F8's gate asks what generation costs. */
  wallMs: number
  /** Frames or columns that actually decoded. */
  decoded: number
}

/** Width buckets, CSS px — see note 2 above. */
const WIDTH_BUCKET = 48
/** How tall an audio lane's waveform is drawn, CSS px (the lane is 24). */
const WAVE_HEIGHT_PX = 22

export function useLaneArt(
  recording: Recording,
  trackWidthPx: number,
  thumbHeightPx: number,
): Record<string, LaneArt> {
  const [art, setArt] = useState<Record<string, LaneArt>>({})
  // Revoked on unmount and on every rebuild; an object URL that outlives its
  // take is a leak nobody sees until a long session runs out of them.
  const urls = useRef<string[]>([])

  const bucket = Math.round(trackWidthPx / WIDTH_BUCKET)
  const totalMs = Math.max(1, recording.durationMs)
  const channelKey = recording.channels.map((c) => `${c.id}:${c.media}:${c.durationMs}`).join('|')

  useEffect(() => {
    let alive = true
    const abort = new AbortController()
    const widthPx = bucket * WIDTH_BUCKET
    if (widthPx <= 0 || !channelKey) return
    void (async () => {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      const publish = (id: string, art: LaneArt): void => {
        urls.current.push(art.url)
        setArt((prev) => ({ ...prev, [id]: art }))
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
        const barPx = (ch.durationMs / totalMs) * widthPx
        const durationSec = ch.durationMs / 1000
        if (!(barPx > 0) || !(durationSec > 0)) continue
        let blob: Blob
        try {
          blob = await blobStore.read(ch.blobKey)
        } catch {
          continue
        }
        if (ch.media === 'video') {
          const plan = planFilmstrip(barPx, durationSec, thumbHeightPx)
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
          })
        } else {
          lanewave ??= (await import('@core/compose/lanewave')).buildLaneWave
          const wave = await lanewave(
            blob,
            durationSec,
            Math.round(barPx * dpr),
            Math.round(WAVE_HEIGHT_PX * dpr),
            { signal: abort.signal },
          )
          if (!alive || abort.signal.aborted) return
          if (!wave) continue
          console.info(
            `[timeline] waveform ${ch.kind}: ${wave.decoded}/${wave.columns} columns in ` +
              `${wave.wallMs} ms, peak ${wave.peak.toFixed(3)}`,
          )
          publish(ch.id, {
            url: URL.createObjectURL(wave.blob),
            kind: 'wave',
            wallMs: wave.wallMs,
            decoded: wave.decoded,
          })
        }
      }
    })()
    return () => {
      alive = false
      abort.abort()
      for (const u of urls.current) URL.revokeObjectURL(u)
      urls.current = []
      setArt({})
    }
    // `recording` itself is deliberately not a dependency: the object identity
    // changes whenever anything upstream re-renders, and re-decoding a take on
    // an unrelated state change is exactly the cost this hook is written to
    // avoid. The channels' ids, media and lengths ARE the take, for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey, bucket, thumbHeightPx, totalMs])

  return art
}
