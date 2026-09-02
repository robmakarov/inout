import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { mediaUrlFor } from '@core/store'
import { channelSourceTimeAt, outputDurationMs, speedAtOutputMs } from '@core/timeline'
import { measureRecordingMakeup, mixGainForChannels, softLimitSample } from '@core/compose'
import { isAppleWebKit } from '@core/capabilities'

/** Beyond this the element is lost — hard seek (audible/visible jump). */
const RESYNC_HARD_MS = 250
/**
 * AUDIO GETS A WIDER ONE, AND IS MUTED ACROSS IT (task B2, Robert: "a lot of
 * minor noises in tab audio ... after some time editing noises almost
 * completly stops in same places they were in begining").
 *
 * That shape — noises that HEAL with repetition, in the same places — is the
 * signature of the preview's own correction, not of the file. The discriminator
 * says so with a number: on an idle machine a 34 s take on prod recorded
 * `paddedMs: 0` on every audio channel and its export decoded with one 0.7 ms
 * notch in 34 s. There is nothing there to heal from; what heals is a COLD
 * DECODE. Channel blobs reach the player as OPFS-backed Files, so the first
 * pass over any region pays a disk read and a cold decode however `preload` is
 * set. The element stalls, drift crosses 250 ms, and this code hard-seeked a
 * PLAYING element — a click — and below that slewed playbackRate by -20/+25 %,
 * which engages the browser's pitch-preserving TIME-STRETCHER. On tab audio,
 * usually music or continuous speech, stretch artefacts have nowhere to hide.
 * Second pass, the region is warm, the stall never happens, and the noise is
 * "almost completly" gone.
 *
 * So audio stops being corrected the way video is. The rule is: NEVER STRETCH
 * AUDIBLY, AND NEVER CLICK. Slew is capped at 4 %, a rate the stretcher cannot
 * make audible; past 300 ms the element is seeked instead of stretched, MUTED
 * ACROSS THE SEEK, because the click is the seek's transient and not its
 * arrival.
 *
 * MEASURED, and the first attempt at this was worse: with the cap at 4 % and
 * the seek threshold at a full second, 4 % of authority could not close the
 * drift a cold decode opens, so drift accumulated and the element seeked TWICE
 * in twelve seconds anyway — later and further out than before. Prompt and
 * silent beats late and silent. 300 ms is close to the 250 ms this always
 * used, which keeps the A/V bound where it was.
 */
const RESYNC_HARD_AUDIO_MS = 300
/** Inside this the element counts as in sync — no correction (avoids hunting). */
const SYNC_DEADBAND_MS = 15
/** Drift is closed over ~this horizon via playbackRate slewing. */
const SLEW_HORIZON_MS = 500
/**
 * How far playbackRate may stray, per media kind.
 *
 * VIDEO keeps what it had: a frame shown 20 % early is not an artefact, it is a
 * frame, and closing drift fast is what keeps the picture on the sound.
 * AUDIO is the whole of this bug. 4 % is under a semitone of resampling and is
 * inaudible on speech and music alike; it closes a 250 ms drift in ~6 s instead
 * of 1 s, which is the trade this task exists to make.
 */
const SLEW_LIMIT = { video: { down: 0.8, up: 1.25 }, audio: { down: 0.96, up: 1.04 } }
/**
 * Paused/scrub seeks snap the frame once drift exceeds this.
 *
 * 40 ms was ABOVE one frame (33.3 ms at 30 fps), so a paused scrub could move
 * the playhead a whole frame and leave the picture where it was — the "scrub
 * granularity" F8 set out to fix with a second decoder. It is not a decoder
 * problem: measured on an off-grid 5-instant probe (`npm run exp -- f8`), a
 * <video> seek and the export's own random-access reader land on the SAME frame
 * every time, 0 ms apart, and the element is the FASTER of the two (29 ms mean
 * against 65). What was coarse was this number. Half a frame instead, so any
 * scrub of one frame or more repaints, and the element still is not asked to
 * seek for sub-frame jitter.
 */
const PAUSED_SEEK_MS = 15
/** ~10ms gain ramps — no zipper noise when loudness lands. */
const GAIN_RAMP_S = 0.01

/**
 * NOTHING WAITS — Robert 2026-09-02: "no waiting, we are trying to fix all
 * waiting, not tolerate it."
 *
 * A hold lived here for a few hours on 2026-09-02: while any element that
 * should be playing had nothing to play, the clock stopped and everything was
 * paused, so no drift opened and nothing had to be corrected audibly. It was
 * the wrong answer to the right question. Waiting for a starved element is
 * tolerating the starvation; the fix is that the element is never starved.
 *
 * It is not, now. The stall was the DISK: a channel blob reaches the element as
 * an OPFS-backed File and the first pass over any region pays a read
 * (store/mediaUrl.ts has the measurement — 191 ms worst on a real 124-minute
 * channel). Reading the file through once and discarding every byte puts it in
 * the OS page cache and takes that to 4 ms, at any length, holding nothing. 4 ms
 * never reaches the ±4 % slew, let alone a seek, so there is nothing to hear
 * and nothing to wait for.
 */


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
  /**
   * A SCRUB GESTURE IS A GESTURE, not a stream of seeks (Robert 2026-08-29: "a lot
   * of noises when i drag video point on player"). Dragging the scrubber fires
   * a pointermove per frame — up to 120 Hz on a trackpad — and while playing
   * every one of those landed past RESYNC_HARD_MS, so `sync` hard-seeked each
   * element and called play() again: a fresh burst of audio per pointer event,
   * which is the noise. Between these two calls the elements are held paused,
   * so the picture still scrubs and nothing is heard.
   */
  scrubStart(): void
  scrubEnd(): void
  /** Stable ref callback for the channel's media element. */
  elementRef(channelId: string): (el: HTMLMediaElement | null) => void
}

/**
 * Mute an element across a seek and restore it when the seek lands (task B2).
 *
 * The click a listener hears at a hard seek is the discontinuity at the moment
 * the element jumps, not the audio it arrives in. Muting for the duration
 * removes it, and `seeked` is what ends it — a timer would be guessing at a
 * duration that depends on the decode. Re-entrant: a second seek during the
 * first keeps the ORIGINAL muted value, so a burst of corrections cannot leave
 * the element muted forever.
 */
const seekMuted = new WeakMap<HTMLMediaElement, boolean>()

function muteAcrossSeek(el: HTMLMediaElement): void {
  if (seekMuted.has(el)) return
  seekMuted.set(el, el.muted)
  el.muted = true
  let done = false
  const restore = (): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    el.removeEventListener('seeked', restore)
    const was = seekMuted.get(el)
    seekMuted.delete(el)
    // `sync` owns `muted` for channel activity; only give back what we took,
    // and never un-mute a channel it has since decided is inactive.
    if (was === false && !el.paused) el.muted = false
  }
  // THE SAFETY NET, AND IT IS NOT OPTIONAL. `seeked` is the honest signal, but
  // an element that never fires it — a decode that fails, a source that ends
  // mid-seek — would leave this channel muted for the rest of the session, and
  // silent audio is a far worse bug than the click this removes. Never break a
  // working path: after a second the mute comes off whatever happened.
  const timer = setTimeout(restore, 1000)
  el.addEventListener('seeked', restore, { once: true })
}

export function usePlayback(recording: Recording, edit: EditState): Playback {
  const [urls, setUrls] = useState<Record<string, string> | null>(null)
  const [playing, setPlaying] = useState(false)
  const [timeMs, setTimeMs] = useState(0)

  const els = useRef(new Map<string, HTMLMediaElement>())
  const refCbs = useRef(new Map<string, (el: HTMLMediaElement | null) => void>())
  const playingRef = useRef(false)
  /** True for the life of a scrubber drag — see Playback.scrubStart. */
  const scrubbingRef = useRef(false)
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
    // Pausing the elements is what actually silences a scrub; this ramp is the
    // other half — it takes out the few ms already in flight when the drag
    // starts, which would otherwise be the one click pausing cannot prevent.
    const scrubMute = scrubbingRef.current ? 0 : 1
    const g = graphRef.current
    if (g) {
      g.makeup.gain.setTargetAtTime(makeupRef.current * scrubMute, g.ctx.currentTime, GAIN_RAMP_S)
      for (const id of attached) {
        const el = els.current.get(id)!
        const gain = chGainsRef.current.get(el)
        if (gain) gain.gain.setTargetAtTime(base, g.ctx.currentTime, GAIN_RAMP_S)
      }
    } else {
      // Fallback (Apple WebKit / no WebAudio): element volume — headroom exact,
      // makeup capped at 1.0 by the platform.
      const v = Math.min(1, base * makeupRef.current) * scrubMute
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
      // A scrub takes the PAUSED branch even mid-playback: each element is
      // seeked and held, so the picture follows the drag and no element is
      // ever asked to play a fragment from a position the drag already left.
      const live = playingRef.current && !scrubbingRef.current
      for (const ch of recording.channels) {
        const el = els.current.get(ch.id)
        if (!el) continue
        const src = channelSourceTimeAt(recording, editRef.current, ch.id, outMs)
        if (src === null) {
          el.muted = true
          if (!el.paused) el.pause()
        } else {
          // NOT while a seek-mute is outstanding: `sync` runs every frame, so
          // an unconditional unmute here would undo the mute ~16 ms later and
          // the click it exists to hide would come back.
          if (!seekMuted.has(el)) el.muted = false
          const drift = el.currentTime * 1000 - src
          if (live) {
            // A/V sync: hard-seeking only past a ±120ms deadband let audio and
            // video elements sit up to ~240ms APART (the reported "audio not
            // synced"). Instead every element is continuously slewed onto the
            // master clock via playbackRate — inaudible, no seek stutter —
            // with hard seeks reserved for genuine jumps.
            const isAudio = ch.media === 'audio'
            const hardMs = isAudio ? RESYNC_HARD_AUDIO_MS : RESYNC_HARD_MS
            const limit = isAudio ? SLEW_LIMIT.audio : SLEW_LIMIT.video
            if (Math.abs(drift) > hardMs) {
              // A seek of a PLAYING element is heard as a click — it is the
              // transient, not the arrival. Muted across it, and unmuted by the
              // element's own `seeked`, so nothing guesses at the duration.
              if (isAudio) muteAcrossSeek(el)
              el.currentTime = src / 1000
              el.playbackRate = base
            } else if (Math.abs(drift) <= SYNC_DEADBAND_MS) {
              el.playbackRate = base
            } else {
              const rate = base * (1 - drift / SLEW_HORIZON_MS)
              el.playbackRate = Math.min(base * limit.up, Math.max(base * limit.down, rate))
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
          // The recorder's own mime, not the stored file's name (core/store/
          // mediaUrl.ts): on Safari every MediaRecorder channel is an MP4 under
          // a `.webm` key, and an element handed `video/webm` bytes it cannot
          // parse plays nothing at all — silent mic, blank camera.
          // AUDIO is warmed through the OS page cache so the first pass over a
          // region does not pay a disk read — that stall is what the sync
          // correction reacts to, and the correction is the noise. It costs no
          // memory and has no length cap (store/mediaUrl.ts carries the
          // measurement). Video is left cold: it is orders of magnitude bigger
          // than any cache, and a stalled video frame is not a sound.
          const url = await mediaUrlFor(
            ch.blobKey,
            ch.mimeType,
            ch.media === 'audio' ? { warm: true } : undefined,
          )
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
      // A held scrub owns the playhead. Without this the clock keeps advancing
      // between pointer events and fights the drag for the position.
      if (scrubbingRef.current) {
        last = now
        return true
      }
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

  const scrubStart = useCallback(() => {
    if (scrubbingRef.current) return
    scrubbingRef.current = true
    applyGains() // ramp the in-flight few ms out
    sync(timeRef.current) // …and park every element where the drag starts
  }, [applyGains, sync])

  const scrubEnd = useCallback(() => {
    if (!scrubbingRef.current) return
    scrubbingRef.current = false
    applyGains()
    sync(timeRef.current) // resumes the elements iff play() was never released
  }, [applyGains, sync])

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
    scrubStart,
    scrubEnd,
    elementRef,
  }
}
