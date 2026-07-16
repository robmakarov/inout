import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { blobStore } from '@core/store'
import { channelSourceTimeAt, outputDurationMs } from '@core/timeline'

const RESYNC_THRESHOLD_MS = 120

export interface Playback {
  playing: boolean
  /** Output-domain time, ms. */
  timeMs: number
  durationMs: number
  ready: boolean
  /** channelId -> object URL, once blobs are loaded. */
  urls: Record<string, string>
  play(): void
  pause(): void
  toggle(): void
  seek(ms: number): void
  seekBy(deltaMs: number): void
  /** Stable ref callback for the channel's media element. */
  elementRef(channelId: string): (el: HTMLMediaElement | null) => void
}

export function usePlayback(recording: Recording, edit: EditState): Playback {
  const [urls, setUrls] = useState<Record<string, string> | null>(null)
  const [playing, setPlaying] = useState(false)
  const [timeMs, setTimeMs] = useState(0)

  const els = useRef(new Map<string, HTMLMediaElement>())
  const refCbs = useRef(new Map<string, (el: HTMLMediaElement | null) => void>())
  const playingRef = useRef(false)
  const timeRef = useRef(0)
  const editRef = useRef(edit)
  const durRef = useRef(outputDurationMs(edit))

  const sync = useCallback(
    (outMs: number) => {
      for (const ch of recording.channels) {
        const el = els.current.get(ch.id)
        if (!el) continue
        const src = channelSourceTimeAt(recording, editRef.current, ch.id, outMs)
        if (src === null) {
          el.muted = true
          if (!el.paused) el.pause()
        } else {
          el.muted = false
          if (Math.abs(el.currentTime * 1000 - src) > RESYNC_THRESHOLD_MS) {
            el.currentTime = src / 1000
          }
          if (playingRef.current) {
            if (el.paused) void el.play().catch(() => {})
          } else if (!el.paused) {
            el.pause()
          }
        }
      }
    },
    [recording],
  )

  // Load blobs -> object URLs; revoke on unmount / recording change.
  useEffect(() => {
    let cancelled = false
    const created: string[] = []
    void (async () => {
      const entries = await Promise.all(
        recording.channels.map(async (ch) => {
          const blob = await blobStore.read(ch.blobKey)
          const url = URL.createObjectURL(blob)
          created.push(url)
          return [ch.id, url] as const
        }),
      )
      if (!cancelled) setUrls(Object.fromEntries(entries))
    })().catch((err) => {
      console.error('failed to load recording blobs', err)
    })
    return () => {
      cancelled = true
      for (const url of created) URL.revokeObjectURL(url)
      setUrls(null)
    }
  }, [recording])

  // Edit changed: keep clock in bounds, re-evaluate channel activity.
  useEffect(() => {
    editRef.current = edit
    const dur = outputDurationMs(edit)
    durRef.current = dur
    if (timeRef.current > dur) {
      timeRef.current = dur
      setTimeMs(dur)
    }
    sync(timeRef.current)
  }, [edit, sync])

  // Master clock.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const t = Math.min(durRef.current, timeRef.current + (now - last))
      last = now
      timeRef.current = t
      setTimeMs(t)
      sync(t)
      if (t >= durRef.current) {
        playingRef.current = false
        setPlaying(false)
        return
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, sync])

  const play = useCallback(() => {
    if (timeRef.current >= durRef.current) {
      timeRef.current = 0
      setTimeMs(0)
    }
    playingRef.current = true
    setPlaying(true)
    sync(timeRef.current)
  }, [sync])

  const pause = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    sync(timeRef.current)
  }, [sync])

  const toggle = useCallback(() => {
    if (playingRef.current) pause()
    else play()
  }, [play, pause])

  const seek = useCallback(
    (ms: number) => {
      const t = Math.min(durRef.current, Math.max(0, ms))
      timeRef.current = t
      setTimeMs(t)
      sync(t)
    },
    [sync],
  )

  const seekBy = useCallback(
    (deltaMs: number) => {
      seek(timeRef.current + deltaMs)
    },
    [seek],
  )

  const elementRef = useCallback(
    (channelId: string) => {
      let cb = refCbs.current.get(channelId)
      if (!cb) {
        cb = (el: HTMLMediaElement | null) => {
          if (el) {
            els.current.set(channelId, el)
            sync(timeRef.current)
          } else {
            els.current.delete(channelId)
          }
        }
        refCbs.current.set(channelId, cb)
      }
      return cb
    },
    [sync],
  )

  return {
    playing,
    timeMs,
    durationMs: outputDurationMs(edit),
    ready: urls !== null,
    urls: urls ?? {},
    play,
    pause,
    toggle,
    seek,
    seekBy,
    elementRef,
  }
}
