/**
 * WHICH PCM TAP A MEASURED AUDIO CHANNEL READS THROUGH — and why there are two.
 *
 * MEASURED, not argued (task A1, `npm run exp -- tapstarve`, 180 s cells, three
 * taps on ONE captured display-audio track under the same load):
 *
 *   load     worklet tap            track tap
 *   none     180.0 s, padded 0      180.0 s, padded 0
 *   encode   179.9 s, padded 0      180.1 s, padded 0     ← both hw encoders flat out
 *   cpu      161.5 s, padded 18396  179.9 s, padded 0     ← every core busy
 *   all      165.9 s, padded 14028  179.9 s, padded 0
 *
 * The worklet tap loses TEN PER CENT of a take's audio time when the machine's
 * cores are saturated, and the loss is not in our code: main-thread lateness in
 * that cell read p99 5.8 ms, the track never muted, and the SAME track read
 * through MediaStreamTrackProcessor in the SAME seconds lost nothing. What
 * starves is Chromium's WebAudio render thread — with the default 'interactive'
 * latency hint it renders on a ~2.7 ms deadline, and a quantum it misses is a
 * quantum the context never renders at all, which a sample-counted timeline
 * cannot see (that is what WallClockHold's padding is repaying). Robert's
 * 50-minute max take carries the same signature: paddedMs 5,647, no mute, no
 * ended, and sound he described as lagging before the tap died outright.
 *
 * The track tap has no render deadline to miss. Audio is pushed from the
 * capture path into a stream and a late reader simply gets its chunk later, so
 * nothing is dropped — and it arrives SOONER, not later (delivery gap p50 3 ms
 * against the worklet's 22.5), so the anchor pays nothing for the change.
 *
 * THE WORKLET PATH IS UNCHANGED AND STAYS THE FALLBACK (frozen rule): a
 * platform without MediaStreamTrackProcessor, or without a sample rate on the
 * track, records exactly as it did before. `?audiotap=worklet` forces it.
 *
 * MEASURED AND NOT SHIPPED: `new AudioContext({latencyHint:'playback'})` fixes
 * the same starvation nearly as well (0 ms under cpu, 84 ms under all) and is
 * one line — but it buys the margin by enlarging the output buffer, which moves
 * when samples arrive and therefore moves the anchor. The track tap removes the
 * thread instead of widening its deadline, and moves the anchor earlier. If the
 * fallback path ever needs the same rescue, that is the lever, and it needs a
 * sync gate run before it ships.
 *
 * Force either way:
 *   ?audiotap=worklet   |   ?audiotap=track
 *   localStorage['inout.capture.audiotap'] = 'worklet'   (sticky)
 * A URL parameter wins, then storage, then the default.
 */

export type AudioTap = 'worklet' | 'track'

const STORAGE_KEY = 'inout.capture.audiotap'

function isTap(v: string | null): v is AudioTap {
  return v === 'worklet' || v === 'track'
}

function fromSearch(): AudioTap | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('audiotap')
  return isTap(v) ? v : null
}

function fromStorage(): AudioTap | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isTap(v) ? v : null
  } catch {
    return null
  }
}

/** What this take should ASK for; capability still decides. */
export function audioTapChoice(): AudioTap {
  return fromSearch() ?? fromStorage() ?? 'track'
}

/**
 * The track tap needs the rate BEFORE the first chunk arrives — the encoder,
 * the wall-clock hold and the revive ladder are all built from it, and a take
 * cannot wait for audio to configure itself (instant start). The platform
 * reports it on the track; a platform that does not gets the worklet, whose
 * AudioContext answers the same question.
 */
export function trackPcmSampleRate(track: MediaStreamTrack): number {
  const rate = track.getSettings().sampleRate
  return typeof rate === 'number' && rate > 0 ? rate : 0
}

export function canReadTrackPcm(track: MediaStreamTrack): boolean {
  return (
    typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor !==
      'undefined' &&
    typeof AudioData !== 'undefined' &&
    trackPcmSampleRate(track) > 0
  )
}

/** Narrow handle on the Chromium-only constructor (absent from the TS lib). */
export function trackPcmReader(track: MediaStreamTrack): ReadableStreamDefaultReader<AudioData> {
  const Processor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => {
        readable: ReadableStream<AudioData>
      }
    }
  ).MediaStreamTrackProcessor
  return new Processor({ track }).readable.getReader()
}
