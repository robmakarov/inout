import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { blobStore } from '@core/store'
import { channelSourceTimeAt, outputDurationMs, speedAtOutputMs } from '@core/timeline'
import { measureRecordingMakeup, mixGainForChannels, softLimitSample } from '@core/compose'
import { isAppleWebKit } from '@core/capabilities'

/** Beyond this the element is lost — hard seek (audible/visible jump). */
const RESYNC_HARD_MS = 250
/** Inside this the element counts as in sync — no correction (avoids hunting). */
const SYNC_DEADBAND_MS = 15
/** Drift is closed over ~this horizon via playbackRate slewing. */
const SLEW_HORIZON_MS = 500
/** Paused/scrub seeks snap the frame once drift exceeds this. */
const PAUSED_SEEK_MS = 40
/** ~10ms gain ramps — no zipper noise when loudness lands. */
const GAIN_RAMP_S = 0.01

/**
 * Preview loudness parity: what you hear in the editor is what the export will
 * sound like. Audio elements route through element → channelGain (the export's
 * 1/N multi-source headroom) → makeup (the export's loudness normalization) →
 * soft-limit WaveShaper (sampled from the export's softLimitSample; 0.5×
 * pre-scale so the curve covers the ≤2× overdrive the makeup bound allows) →
 * speakers. Element volume alone cannot express makeup > 1 (it caps at 1.0) —
 * that is exactly why WebAudio is required. On Apple WebKit
 * (MediaElementSource on blob media has a history of double-output/silence
 * bugs) we fall back to el.volume = min(1, gain): headroom exact, boost capped.
 */
interface PreviewGraph {
  ctx: AudioContext
  makeup: GainNode
}

function createPreviewGraph(): PreviewGraph | null {
  try {
    const ctx = new AudioContext()
    const makeup = ctx.createGain()
    const pre = ctx.createGain()
    pre.gain.value = 0.5
    const shaper = ctx.createWaveShaper()
    const N = 4097
    const curve = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1 // [-1, 1] after 0.5× pre-scale = ±2 signal
      curve[i] = softLimitSample(2 * x)
    }
    shaper.curve = curve
    shaper.oversample = 'none' // export shapes per-sample without oversampling
    makeup.connect(pre)
    pre.connect(shaper)
    shaper.connect(ctx.destination)
    return { ctx, makeup }
  } catch (err) {
    console.warn('preview: WebAudio graph unavailable, element volume fallback', err)
    return null
  }
}

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

  // ---- preview loudness parity (see PreviewGraph note above) ----
  const graphRef = useRef<PreviewGraph | null>(null)
  const graphTried = useRef(false)
  const sourcesRef = useRef(new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>())
  const chGainsRef = useRef(new WeakMap<HTMLMediaElement, GainNode>())
  const makeupRef = useRef(1)
  const appleWebKit = useRef(isAppleWebKit())

  /** Apply export-parity gains to every attached audio element. */
  const applyGains = useCallback(() => {
    const audioIds = recording.channels.filter((c) => c.media === 'audio').map((c) => c.id)
    const attached = audioIds.filter((id) => els.current.has(id))
    if (attached.length === 0) return
    const base = mixGainForChannels(attached.length)
    const g = graphRef.current
    if (g) {
      g.makeup.gain.setTargetAtTime(makeupRef.current, g.ctx.currentTime, GAIN_RAMP_S)
      for (const id of attached) {
        const el = els.current.get(id)!
        const gain = chGainsRef.current.get(el)
        if (gain) gain.gain.setTargetAtTime(base, g.ctx.currentTime, GAIN_RAMP_S)
      }
    } else {
      // Fallback (Apple WebKit / no WebAudio): element volume — headroom exact,
      // makeup capped at 1.0 by the platform.
      const v = Math.min(1, base * makeupRef.current)
      for (const id of attached) {
        const el = els.current.get(id)
        if (el) el.volume = v
      }
    }
  }, [recording])

  /** Route an audio element into the parity graph (once per element, ever). */
  const wireAudioElement = useCallback(
    (el: HTMLMediaElement) => {
      if (appleWebKit.current) return
      if (!graphTried.current) {
        graphTried.current = true
        graphRef.current = createPreviewGraph()
      }
      const g = graphRef.current
      if (!g || sourcesRef.current.has(el)) return
      try {
        const src = g.ctx.createMediaElementSource(el)
        const chGain = g.ctx.createGain()
        src.connect(chGain)
        chGain.connect(g.makeup)
        sourcesRef.current.set(el, src)
        chGainsRef.current.set(el, chGain)
      } catch (err) {
        console.warn('preview: element wiring failed, native output kept', err)
      }
    },
    [],
  )

  // Measure the export's loudness makeup once per recording (background) so
  // preview loudness matches the file the user will get. Unity until it lands.
  useEffect(() => {
    let cancelled = false
    makeupRef.current = 1
    void measureRecordingMakeup(recording).then((m) => {
      if (cancelled) return
      makeupRef.current = m
      applyGains()
    })
    return () => {
      cancelled = true
    }
  }, [recording, applyGains])

  // Close the graph with the playback it belongs to.
  useEffect(() => {
    return () => {
      const g = graphRef.current
      graphRef.current = null
      graphTried.current = false
      if (g && g.ctx.state !== 'closed') void g.ctx.close().catch(() => {})
    }
  }, [recording])

  const sync = useCallback(
    (outMs: number) => {
      // F5b: inside a sped span the element's BASE rate is the span's speed —
      // the slew below is a correction around it, not a replacement for it.
      // Browsers preserve pitch on playbackRate by default, so the preview
      // sounds like the export's WSOLA stretch without reimplementing it here.
      const base = speedAtOutputMs(editRef.current, outMs)
      for (const ch of recording.channels) {
        const el = els.current.get(ch.id)
        if (!el) continue
        const src = channelSourceTimeAt(recording, editRef.current, ch.id, outMs)
        if (src === null) {
          el.muted = true
          if (!el.paused) el.pause()
        } else {
          el.muted = false
          const drift = el.currentTime * 1000 - src
          if (playingRef.current) {
            // A/V sync: hard-seeking only past a ±120ms deadband let audio and
            // video elements sit up to ~240ms APART (the reported "audio not
            // synced"). Instead every element is continuously slewed onto the
            // master clock via playbackRate — inaudible, no seek stutter —
            // with hard seeks reserved for genuine jumps.
            if (Math.abs(drift) > RESYNC_HARD_MS) {
              el.currentTime = src / 1000
              el.playbackRate = base
            } else if (Math.abs(drift) <= SYNC_DEADBAND_MS) {
              el.playbackRate = base
            } else {
              const rate = base * (1 - drift / SLEW_HORIZON_MS)
              el.playbackRate = Math.min(base * 1.25, Math.max(base * 0.8, rate))
            }
            if (el.paused) void el.play().catch(() => {})
          } else {
            el.playbackRate = base
            if (Math.abs(drift) > PAUSED_SEEK_MS) el.currentTime = src / 1000
            if (!el.paused) el.pause()
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

  // Master clock. rAF alone FREEZES in a hidden tab while the audio elements
  // play on — the clock and the sync loop stop, audio walks many seconds ahead
  // of the frozen video, and on return everything is hard-yanked back ("audio
  // not synced", "playback stops"). A parallel interval (throttled to ~1 Hz
  // when hidden — enough) keeps the clock true whenever rAF is not ticking.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const step = (now: number): boolean => {
      const t = Math.min(durRef.current, timeRef.current + (now - last))
      last = now
      timeRef.current = t
      setTimeMs(t)
      sync(t)
      if (t >= durRef.current) {
        playingRef.current = false
        setPlaying(false)
        return false
      }
      return true
    }
    const loop = (now: number) => {
      if (step(now)) raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const iv = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'hidden') {
        if (!step(performance.now())) clearInterval(iv)
      }
    }, 500)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(iv)
    }
  }, [playing, sync])

  const play = useCallback(() => {
    if (timeRef.current >= durRef.current) {
      timeRef.current = 0
      setTimeMs(0)
    }
    // User gesture: the parity graph's context may start suspended — resume it
    // here or the whole preview would be silent under autoplay policy.
    const g = graphRef.current
    if (g && g.ctx.state !== 'running') void g.ctx.resume().catch(() => {})
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
        const isAudio = recording.channels.find((c) => c.id === channelId)?.media === 'audio'
        cb = (el: HTMLMediaElement | null) => {
          if (el) {
            els.current.set(channelId, el)
            if (isAudio) {
              wireAudioElement(el)
              applyGains()
            }
            sync(timeRef.current)
          } else {
            els.current.delete(channelId)
            if (isAudio) applyGains()
          }
        }
        refCbs.current.set(channelId, cb)
      }
      return cb
    },
    [sync, recording, wireAudioElement, applyGains],
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
