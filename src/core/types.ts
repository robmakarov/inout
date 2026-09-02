/**
 * INOUT core contracts. All modules implement against these types.
 *
 * Time model:
 * - A recording session has one epoch (t=0). All channel offsets are relative to it.
 * - A channel occupies [startOffsetMs, startOffsetMs + durationMs) on the recording timeline.
 * - ChannelEdit trims are in CHANNEL-LOCAL time: keep [trimStartMs, trimEndMs).
 *   Trimming a channel does NOT shift it in time — it blanks it outside the kept window
 *   (video: not drawn; audio: silent).
 * - Global trim [globalTrimStartMs, globalTrimEndMs) is on the RECORDING timeline and
 *   defines the output bounds. Output t=0 corresponds to recording t=globalTrimStartMs.
 * - KEPT SEGMENTS (optional, task F1) cut material out of the MIDDLE. When
 *   `segments` is present the output timeline is the ordered concatenation of
 *   those recording-timeline spans, so output time maps piecewise rather than
 *   by a single offset. Absent (or a single span covering the whole global
 *   trim) is exactly the old behaviour, which is why every take recorded
 *   before F1 keeps behaving identically.
 * - A channel is active at output time t iff:
 *     enabled
 *     && recordingT = t + globalTrimStartMs is within the channel's span
 *     && localT = recordingT - startOffsetMs is within [trimStartMs, trimEndMs).
 */

export type ChannelKind = 'screen' | 'camera' | 'mic' | 'system-audio'
export type MediaKind = 'video' | 'audio'

/**
 * Capture-time witnesses persisted per channel (additive, 2026-08-26). The
 * console dies with the tab and no field report has ever arrived with one, so
 * the take carries its own evidence: what the track/context did, how much
 * silence the wall-clock hold inserted, how the channel's input ended, and
 * whether the dead-tap revival ran.
 */
export interface ChannelDiagnostics {
  /** Silence inserted to hold the timeline against the wall clock, ms. */
  paddedMs?: number
  /**
   * Time REMOVED to hold the timeline against the wall clock, ms (Robert
   * 2026-08-29). >0 means this channel's audio clock ran FASTER than the
   * system clock, which without the trim is heard as the sound falling
   * progressively behind the picture — about a second per hour at 278 ppm.
   * The two are mutually exclusive in practice: a clock is fast or slow.
   */
  trimmedMs?: number
  /** Input was pure digital silence for this long when the segment ended, ms. */
  silentTailMs?: number
  /** Times the audio source tap was rebuilt after sustained digital silence. */
  revivals?: number
  /** Track/context life events (mute, unmute, ended, ctx state, revive…), ms from epoch. */
  events?: { atMs: number; type: string }[]
  /**
   * B7 — THE ALIGNMENT INPUTS, IN THE FILE, SO THE NEXT FIELD REPORT ARRIVES
   * WITH NUMBERS INSTEAD OF AN ADJECTIVE.
   *
   * "mic/camera unsynch in beggining of video seems to be smaller on other try"
   * is the whole of what is known about a constant start-of-take offset that
   * varies take to take. It cannot be chased from a synthetic rig: a canvas
   * delivers its first frame instantly and a synthetic mic has no device
   * buffer, so both of the errors below are exactly zero there. They are only
   * ever visible on real hardware, on the take the user complained about — and
   * until now that take carried none of them.
   *
   * Every field is DESCRIPTIVE. Nothing here changes an offset; compensating
   * from theory is what has failed at this seam before.
   */
  anchor?: ChannelAnchor
  /**
   * B13 — WHAT THE PLATFORM ACTUALLY DELIVERED ON THIS AUDIO TRACK.
   *
   * Robert heard a 124.8-minute take as "less bass" with "some small noises",
   * and the first suspect is Chrome's voice processing (AEC/NS/AGC) having
   * survived on a display-audio track: it high-passes the bottom, gates quiet
   * passages into artefacts and downmixes to mono. acquire.ts asks for all
   * three OFF on every wedge rung and re-applies them to the delivered track,
   * so the question is whether one of those two belts SLIPPED — and that
   * question could not be answered about his take, because the answer was only
   * ever a console line on a machine that had since been closed.
   *
   * Written for every measured audio channel, mic included. Audio only.
   */
  audioTrack?: DeliveredAudioSettings
}

/**
 * B13. The delivered audio track's own settings, read off `getSettings()` at
 * the moment capture starts and again at stop.
 *
 * `null` is not `false`: a track that never reported `echoCancellation` and one
 * that reported it OFF are different findings, and a boolean cannot hold both.
 * Chromium routinely omits these for display audio, which is precisely the
 * source B13 is about.
 */
export interface DeliveredAudioSettings {
  /** Voice processing, as DELIVERED. null = the platform reported no value. */
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
  /** 1 here on a music source is the "mono warble" Robert reported 2026-08-26. */
  channelCount: number | null
  sampleRate: number | null
  /** Platform-reported input latency in ms — the number the anchor subtracts. */
  latencyMs: number | null
  /**
   * Settings at STOP, present ONLY when something moved during the take. A
   * track that was repaired at arm and re-processed at minute 40 (a device
   * change, crbug 344876285) is otherwise indistinguishable from a clean one.
   */
  atStop?: {
    echoCancellation: boolean | null
    noiseSuppression: boolean | null
    autoGainControl: boolean | null
    channelCount: number | null
  }
}

/** B7. What each channel's start offset was BUILT from. Instrumentation only. */
export interface ChannelAnchor {
  /**
   * This channel's offset from the session epoch BEFORE the take-wide shift
   * that makes the earliest channel t=0. `startOffsetMs` is relative to the
   * take; this is relative to when the session started, which is the only
   * frame in which "the camera was 233 ms late" is a statement about a device.
   */
  rawAnchorMs?: number
  /**
   * AUDIO. The platform-reported input latency subtracted from the raw anchor
   * (measuredAudio bounds it at 200 ms). A Bluetooth headset's real 100-300 ms
   * is INVISIBLE here — Chrome reports the part it knows and no more — so a
   * take whose sound is late with this reading ~10 ms is the evidence that the
   * unreported part is what is left.
   */
  reportedInputLatencyMs?: number
  /**
   * B13. Whether `reportedInputLatencyMs` was actually SUBTRACTED from the raw
   * anchor. It always was until B13; `?looplat=0` stops it on loopback sources
   * (tab / system audio), which have no microphone and no physical input
   * latency to remove. False with a non-zero latency above means the platform
   * reported one and this take deliberately kept it — the reading that makes a
   * pair of takes comparable without reading the URL they were made under.
   */
  inputLatencyApplied?: boolean
  /**
   * VIDEO. How long after this channel started pulling frames the FIRST one
   * arrived. A canvas answers in ~0 ms; a real getDisplayMedia surface does
   * not — the composite's own first frame took 233 ms in one measured run. The
   * MediaRecorder lane cannot see its first frame at all and reports the
   * start()→onstart gap instead, flagged by `firstFrameDelayIsStartGap`.
   */
  firstFrameDelayMs?: number
  /** True when `firstFrameDelayMs` is the recorder's start→onstart gap rather
   *  than a real first frame — the MediaRecorder lane has no frame stamp. */
  firstFrameDelayIsStartGap?: boolean
}

export interface ChannelRecording {
  id: string
  kind: ChannelKind
  media: MediaKind
  /** MediaRecorder mime, e.g. video/webm;codecs=vp9 */
  mimeType: string
  /** Key into the blob store (OPFS). */
  blobKey: string
  /** Offset from session epoch to this channel's first media, ms. */
  startOffsetMs: number
  durationMs: number
  width?: number
  height?: number
  /**
   * The rate this channel's file was WRITTEN at (task F15). Absent means 30 and
   * not "unknown": until F15 capture asked every source for `max: 30`, so every
   * take made before this field existed is a 30 fps take. See core/rate.ts.
   */
  fps?: number
  /**
   * Encoded size on disk. Lets a packet-copying step quote the file instead of
   * a model (O3c). Absent on takes recorded before it was kept — consumers
   * fall back to estimating, exactly as they did.
   */
  bytes?: number
  diagnostics?: ChannelDiagnostics
}

/** Default-layout composite recorded live alongside the channels (instant export). */
export interface CompositeRecording {
  blobKey: string
  mimeType: string
  durationMs: number
  width: number
  height: number
  /**
   * The rate this file was ENCODED at (task F15) — the cadence gate's rate, not
   * the rate any source delivered. Absent means 30, which is a fact about every
   * composite written before F15 and not a guess: both engines painted at a
   * hardcoded 30 and capture could not hand them more. The copy fence in
   * compose/copySource.ts reads this, so a 60 fps composite can never be handed
   * over under a 30 fps step's label. See core/rate.ts.
   */
  fps?: number
  /**
   * WHAT A COMPOSITE TIMESTAMP MEANS (P0-instant-sync, 2026-08-25).
   *
   * The composite is a SECOND file with its OWN clock, and that clock does not
   * start when the take does: v1's file begins when its MediaRecorder starts
   * (after the <video> elements, the canvas, the audio graph and the write
   * stream exist), v2's begins at whichever of audio/video reached the worker
   * first. Composite time `t` is therefore recording time `t + startOffsetMs`,
   * exactly as ChannelRecording.startOffsetMs places a channel.
   *
   * Both packet-copying export paths used to assume this was 0 — the type had
   * no way to say otherwise — so every copied packet landed early against
   * audio mixed from the raw channels: measured 97-102 ms of A/V offset on v2
   * and 244.8 ms on v1, against the same take's render at 52-64 ms.
   *
   * ABSENT means 0, which is the old (wrong) assumption preserved on takes
   * recorded before this field existed: nothing can recover their origin now,
   * and guessing would be worse than the behaviour they were exported with.
   *
   * SIGNED (B9, 2026-09-02). NEGATIVE means the composite's clock started
   * BEFORE the earliest raw channel delivered — routine, not noise: the
   * composite's origin is whatever reached its worker first (the mix), a raw
   * video channel's is its own first frame, and the second waits on a
   * VideoEncoder configuring. Measured 64-198 ms of lead on five of seven
   * takes. The stop path used to clamp it at 0 and both packet-copy paths then
   * wrote the copied picture that much late against their own sound.
   */
  startOffsetMs?: number
  /**
   * WHICH CAPTURE ENGINE WROTE THIS FILE. v2 encodes with a VideoEncoder we
   * configure, so smart cut may re-encode a cut boundary and splice it into the
   * copied packets — the two halves share one avcC and we can prove it. v1 is
   * MediaRecorder's own encoder: its decoder description is not ours to
   * reproduce, so a boundary splice can only fail the byte-for-byte check that
   * keeps that path honest. Absent on takes recorded before the field existed —
   * those still try and are still caught by the check.
   */
  engine?: 'v1' | 'v2'
  /** Encoded size. Lets the export size estimate use THIS take's own
   *  compressibility instead of guessing from the bitrate target. */
  bytes?: number
  /**
   * The composite's encoder was STILL behind when the drain budget ran out at
   * stop (task P0-tail), so this file is missing an unknown amount of its end.
   * An unedited export must not packet-copy it — the raw channels are rendered
   * instead, which is slower and correct. Absent on every healthy take.
   */
  tailIncomplete?: boolean
}

/**
 * Loudness of the certified mix, accumulated DURING capture (task O2) so
 * export does not have to decode every audio channel a second time just to
 * measure it. Same statistics as compose/audio measureMixLoudness, taken on
 * the UNITY sum of the listed channels: per-channel mix gain is a constant
 * factor, so a consumer scales all three fields by its own baseGain.
 *
 * Only valid for a mix of EXACTLY `channelIds` — a consumer mixing a different
 * set (channel disabled, channel failed to open) must fall back to the probe.
 * Absent on takes recorded before O2 and on browsers without the measured
 * audio path (Apple WebKit records audio via MediaRecorder).
 */
export interface CaptureLoudness {
  channelIds: string[]
  /** Max |sample| of the unity sum. */
  peak: number
  /**
   * p99 of per-window peaks of the unity sum — the take's SUSTAINED ceiling,
   * which is what bounds the makeup gain (one transient must not define a
   * whole take's headroom). Optional: takes recorded before this statistic
   * existed fall back to `peak`, i.e. to the behaviour they were made under.
   */
  peakRobust?: number
  /** p90 of 100 ms window RMS of the unity sum. */
  loudRms: number
  /** p20 of 100 ms window RMS of the unity sum. */
  floorRms: number
  /** Frames folded into the statistic (0 ⇒ unusable). */
  frames: number
  /**
   * The envelope the percentiles above were taken from, IN TIME ORDER (X1).
   *
   * Capture already computes it — `finish()` used to sort it and throw the
   * order away, so an EDITED export had to decode every audio channel a second
   * time purely to rebuild windows that had already been measured. Keeping it
   * costs ~144 KB per 30 minutes and lets an edit re-percentile the windows it
   * KEEPS: a percentile is a statistic of a multiset, so selection is enough
   * and no re-windowing is needed.
   *
   * Absent on takes recorded before X1 (and wherever the stats themselves are
   * absent) — those keep probing, exactly as they did.
   */
  envelope?: CaptureEnvelope
}

/**
 * The unity-sum mix's 100 ms window envelope on the RECORDING timeline.
 *
 * Both arrays are in time order and the same length; window i covers
 * `[startMs + i*windowMs, startMs + (i+1)*windowMs)`. The final window may be
 * short — it is the remainder the take ended on.
 */
export interface CaptureEnvelope {
  /** RMS of the mid (mono-fold) signal per window. */
  windowRms: Float32Array
  /** Max |sample| per window — what p99 of gives `peakRobust`. */
  windowPeak: Float32Array
  /** Window length in ms (100, matching compose/audio's loudness window). */
  windowMs: number
  /** Recording-timeline ms at which window 0 starts (post-rebase, so ≥ 0
   *  unless audio began before the earliest channel, which cannot happen —
   *  the rebase puts the earliest channel at 0). */
  startMs: number
}

export interface Recording {
  id: string
  createdAt: number
  /** Recording-timeline end: max over channels of startOffsetMs + durationMs. */
  durationMs: number
  channels: ChannelRecording[]
  /** Capture-time loudness of the certified mix — lets export skip its probe. */
  loudness?: CaptureLoudness
  /** Present when the live composite succeeded; unedited export = this file. */
  composite?: CompositeRecording
  /** Requested channels that never delivered media — surface loudly in the UI. */
  missing?: ChannelKind[]
  /** Video channels whose source froze for seconds mid-take (shared window
   * hidden / on another Space, full-screen app took over, track died). Those
   * stretches are a still image in the file — say so instead of shipping it
   * silently. */
  stalled?: ChannelKind[]
  /**
   * H4 — WHAT THIS TAKE LOST WHILE IT RAN, AND WHEN.
   *
   * `stalled` says WHICH channel went bad and nothing else; a take that lost
   * its mic at minute 40 of an hour is not the same take as one that lost it
   * at second 3, and the file cannot be told apart from a healthy one by
   * looking. Each entry is a channel that stopped being a source mid-take —
   * its track ended, or it never delivered a frame at all — stamped at the
   * instant it happened on the SAME timeline as `channels[].startOffsetMs`.
   * Absent on every take that lost nothing, and on every take made before H4.
   */
  lost?: ChannelLoss[]
  /**
   * H1 — WHERE THE TAKE SURVIVED A COMPONENT DEATH, AND WHAT IT COST.
   *
   * `lost` is for a channel that is GONE. This is for one that came back: an
   * encoder that failed, a worker that died, a recorder that errored — the
   * segment was closed on the spot and the next one opened on the same live
   * device, so the kind runs the whole take with a hole in it instead of
   * stopping dead. One entry per seam, stamped on the same timeline as
   * `channels[].startOffsetMs`, carrying the unrecorded gap. Absent on every
   * take that never had to do it, which is every healthy take.
   */
  seams?: SegmentSeam[]
  /**
   * UI1 — WHERE THE CAMERA PiP WAS WHEN THE TAKE STOPPED, if it was moved
   * during capture. The composite holds this pose, so the editor has to open
   * with it or the preview stops predicting the file (the default export
   * packet-copies that composite). Absent = the default corner, which is every
   * take made before the PiP could be moved during a take.
   */
  cameraPose?: CameraPose
  /**
   * UI1 — THE QUALITY CEILING THIS TAKE WAS RECORDED UNDER (`QualityStepId`).
   *
   * Robert: "make it not possible to choose higher quality that was choosen
   * before start of record". The export ladder is capped here, and it has to be
   * capped by the take's OWN choice rather than by wherever the slider sits
   * when the take is reopened — a take from last night is not re-recordable at
   * a step it was never captured at.
   *
   * Absent = uncapped, which is every take made before this field existed and
   * exactly the behaviour those files were made under. Typed as a string so
   * `core/types.ts` stays the leaf it is.
   */
  qualityStep?: string
  /**
   * S1 — WHAT ONLY THE LIVE SESSION COULD KNOW, SAMPLED AT STOP.
   *
   * The take report card grades memory, storage headroom and whether anything
   * had to be given up to keep the frames coming. None of that survives the
   * page, and none of it is worth one instruction while the recorder runs — so
   * it is read ONCE, after the last byte is written, out of numbers the session
   * already had. Absent on every take made before S1, which is why every
   * dimension that reads this reports `unmeasured` rather than passing.
   */
  stopStats?: TakeStopStats
}

/**
 * H4. One channel's death, certified. Descriptive only — the take already
 * continued without it; this is what says so afterwards.
 */
export interface ChannelLoss {
  kind: ChannelKind
  /**
   * Recording-timeline ms at which the channel stopped delivering. Rebased
   * with the channels, so it is directly comparable to `startOffsetMs`.
   * `0` on a 'never-delivered' channel: it was never there.
   */
  atMs: number
  /**
   * 'ended' — the track fired `ended` mid-take (unplugged, Bluetooth dropped,
   * the shared window's owner quit, "Stop sharing").
   * 'never-delivered' — the track stayed live and unmuted for the whole take
   * and produced no frames at all (B4's sensor-off camera).
   */
  reason: 'ended' | 'never-delivered'
  /** How long the take ran on after the loss. */
  lostMs: number
}

/**
 * H1. One contained component death: the boundary between the segment that
 * died and the one that replaced it. Descriptive only — the take already
 * continued; this is what says where the hole is.
 */
export interface SegmentSeam {
  kind: ChannelKind
  /**
   * Recording-timeline ms at which the closed segment's last sample sits.
   * Rebased with the channels, so it is directly comparable to `startOffsetMs`.
   */
  atMs: number
  /**
   * The unrecorded gap, ms: how long this kind had no file open. O16 measured
   * the same move at 69 ms and F6's pause seams at 99-218 ms; anything much
   * larger is a drain that did not finish in budget and is worth reading as a
   * defect rather than as a seam.
   */
  gapMs: number
  /**
   * 'encoder-error'  — the encoder reported failure (VideoEncoder's own `error`
   *                    callback, a muxer write that threw, measuredAudio's
   *                    `fatal`). The worker, if there is one, is alive.
   * 'worker-death'   — `worker.onerror`: the worker itself is gone.
   * 'recorder-error' — the MediaRecorder fallback lane fired `error`.
   */
  cause: 'encoder-error' | 'worker-death' | 'recorder-error'
}

/** S1. Descriptive only — nothing here changes a capture decision. */
export interface TakeStopStats {
  /** `performance.memory.usedJSHeapSize` at stop (Chromium only). A point
   *  sample at the end of the take, NOT a high-water mark: nothing samples
   *  during a take and nothing should (the hour-scale slope is task H3). */
  heapBytes?: number
  heapLimitBytes?: number
  /** The last `navigator.storage.estimate()` the disk guard took while this
   *  take ran (B5 already polls it — this keeps the answer instead of
   *  discarding it). */
  storageUsageBytes?: number
  storageQuotaBytes?: number
  /** The frame rate this take asked its sources for (core/rate.ts ceiling). */
  requestedFps?: number
  /** Set when the take had to give something up to keep up — the rate ladder
   *  stepped, or the live composite degraded. Absent on a take that carried
   *  its plan the whole way. */
  degradedWhy?: string
  /**
   * E2 — every shed and every recovery this take made, in order, on the take's
   * own clock (core/elasticLog.ts). Absent on a take that gave up nothing, and
   * on every take made before E2. The report card's `elastic` dimension grades
   * the ORDER: the ruling of 2026-09-02 is that unseen work goes first, the
   * burst absorber second and the picture last, and only a ledger can say
   * whether that held.
   */
  elastic?: ElasticEvent[]
  /** Ledger lines dropped off the front of the ring (bounded at 400). 0 or
   *  absent on every ordinary take. */
  elasticDropped?: number
}

export interface ChannelEdit {
  channelId: string
  enabled: boolean
  /** Channel-local, ms. Keep [trimStartMs, trimEndMs). */
  trimStartMs: number
  trimEndMs: number
}

/** A kept span of the RECORDING timeline. Ordered, disjoint, ascending. */
export interface KeptSegment {
  startMs: number
  endMs: number
  /**
   * Playback rate for this span (task F5b). Absent or 1 = normal, which is what
   * every take recorded before F5b has and what an untouched take must keep —
   * a span carrying `speed: 1` and one carrying nothing have to be the same
   * thing to every consumer, or an untouched take loses the instant path.
   * Above 1 the span plays FASTER and occupies proportionally less output time;
   * the audio is time-stretched (pitch preserved), never resampled.
   */
  speed?: number
}

/**
 * Where the camera PiP sits, as fractions of the output frame (task F4).
 * Centre-anchored so a resize keeps the box where the user put it, and
 * resolution-independent so the same pose renders identically at 720p and
 * 1440p — and identically in the editor preview, which is the parity gate.
 */
export interface CameraPose {
  /** Centre of the PiP, 0..1 across the frame. */
  xFrac: number
  yFrac: number
  /** PiP width as a fraction of frame width; height follows the camera aspect. */
  widthFrac: number
}

/** A pose the camera holds at a RECORDING-timeline instant (task F4). */
export interface CameraKeyframe extends CameraPose {
  atMs: number
}

/**
 * Timed camera motion. On the RECORDING timeline, like KeptSegment — so a cut
 * made later never drags the motion out from under the moment it belongs to.
 * Absent (or empty) = the fixed bottom-right PiP every take had before F4.
 */
export interface CameraTrack {
  keyframes: CameraKeyframe[]
}

/**
 * The visible region of the composed frame (task F2) — a camera on the output,
 * not on any one channel. Everything the frame contains (screen, camera PiP,
 * background) is inside it, so a zoom magnifies the composition rather than
 * re-laying it out.
 *
 * Fractions of the frame, centre-anchored, exactly like CameraPose. The visible
 * region always keeps the output's aspect, which is why one number describes
 * its size: a rect of the same aspect has heightFrac === widthFrac in FRACTION
 * terms. widthFrac 1 = the whole frame = no zoom.
 */
export interface Viewport {
  xFrac: number
  yFrac: number
  widthFrac: number
}

/** A viewport the output holds at a RECORDING-timeline instant (task F2). */
export interface ViewportKeyframe extends Viewport {
  atMs: number
}

/**
 * Timed zoom/pan. On the RECORDING timeline like CameraTrack and KeptSegment,
 * so a cut made later never drags a zoom off the moment it belongs to. Absent
 * (or empty) = the whole frame, which is what every take did before F2.
 */
export interface ViewportTrack {
  keyframes: ViewportKeyframe[]
}

/**
 * The frame around the screen surface (task F3): a painted background, an inset,
 * rounded corners and a drop shadow.
 *
 * Fractions, never pixels, so the frame renders identically at 540p and 1440p
 * and identically in the editor preview, which is the parity gate. Absent =
 * full-bleed, which is what every take did before F3 and what an untouched take
 * keeps doing.
 */
export interface BackgroundStyle {
  /** Which painted backdrop; 'none' paints nothing (the old black frame). */
  preset: string
  /** Inset of the screen surface, fraction of each axis. 0 = full bleed. */
  padFrac: number
  /** Corner radius of the screen surface, fraction of frame HEIGHT. */
  radiusFrac: number
  shadow: boolean
}

export interface EditState {
  recordingId: string
  /** Recording-timeline, ms. Output covers [globalTrimStartMs, globalTrimEndMs). */
  globalTrimStartMs: number
  globalTrimEndMs: number
  channels: ChannelEdit[]
  /**
   * Kept spans inside the global trim, in order. Absent = one span covering
   * the whole trim (today's behaviour). Output duration is their total length.
   */
  segments?: KeptSegment[]
  /**
   * Timed camera motion (F4). Absent = the fixed bottom-right PiP, which is
   * what every take recorded before F4 keeps doing.
   */
  camera?: CameraTrack
  /**
   * Background frame (F3). Absent = full bleed on black, today's default.
   */
  background?: BackgroundStyle
  /**
   * Timed zoom/pan (F2). Absent = the whole frame, always.
   */
  viewport?: ViewportTrack
}

// ---------------------------------------------------------------------------
// capture (src/core/capture) — required exports:
//   loadCapturePrefs(): CaptureConfig
//   saveCapturePrefs(c: CaptureConfig): void
//   createCaptureSession(config: CaptureConfig, opts?: { onArming? }): Promise<CaptureSession>
//     - PROGRESSIVE arming (instant is law): resolves as soon as the PRIMARY
//       channel is armed (screen when requested, else camera, else first audio).
//       Remaining devices acquire in the background (per-step ~5s timeout) and
//       late-join the running take with correct startOffsetMs, emitting
//       'channel-late-join'. A late join invalidates the live composite (unedited
//       export falls back to render — correctness over instant). Requested
//       channels that never deliver are listed in Recording.missing.
//       onArming reports which permission is pending. Rejects with CaptureError
//       only when nothing could be acquired. Failures emit 'channel-error'.
//     - audio channels (mic/system-audio): AudioWorklet → WebCodecs opus →
//       mediabunny webm with startOffsetMs from getOutputTimestamp (measured).
//     - video channels: MediaRecorder (unchanged; file epoch ≈ startCall).

//   isSyntheticMode(): boolean  — true when location.search contains 'synthetic';
//     in that mode streams are generated (canvas animations + oscillators), no
//     permissions needed. Used for automated testing.
// ---------------------------------------------------------------------------

export interface CaptureConfig {
  screen: boolean
  camera: boolean
  mic: boolean
  systemAudio: boolean
  cameraDeviceId?: string
  micDeviceId?: string
}

/**
 * 'paused' is F6's addition and it is NOT a stop: the devices stay armed, the
 * camera light stays on, and no permission is asked again on resume. What ends
 * at a pause is each channel's current SEGMENT — its file is closed there — and
 * a resume opens segment N+1 on the very same track with its own epoch anchor.
 */
export type CaptureState = 'armed' | 'recording' | 'paused' | 'stopping' | 'stopped'

/**
 * What the user actually picked in the screen picker. 'monitor' means THIS
 * window is inside the recorded frame whenever it is in front — which is what
 * makes the browser's own sharing bar able to spoil a take by pulling focus
 * here. Null when no screen channel is in the take (or the browser doesn't say).
 */
export type DisplaySurfaceKind = 'monitor' | 'window' | 'browser'

export type CaptureEvent =
  /** `remainingMs` is null when the take is uncapped, which it is by default. */
  | { type: 'tick'; elapsedMs: number; remainingMs: number | null }
  | { type: 'state'; state: CaptureState }
  /** A channel died mid-flight (e.g. user hit the browser's "stop sharing"). */
  | { type: 'channel-ended'; kind: ChannelKind }
  | { type: 'channel-error'; kind: ChannelKind; message: string }
  /** Non-fatal quality warning for a live channel (e.g. Bluetooth headset mic
   *  captured in telephone-quality HFP mode). Channel still records. */
  | { type: 'channel-notice'; kind: ChannelKind; message: string }
  /** A slow device delivered media after recording had already begun. */
  | { type: 'channel-late-join'; kind: ChannelKind }
  /** A live video source stopped delivering frames — everything recorded from
   *  here is a still image until 'channel-resumed'. The take keeps running (the
   *  audio and the other channels are still good) but the UI must say so, and
   *  it must stay said: the user is in another tab when this happens. */
  | { type: 'channel-stalled'; kind: ChannelKind }
  | { type: 'channel-resumed'; kind: ChannelKind }
  /**
   * H4 — A VIDEO SOURCE THAT HAS NEVER DELIVERED ONE FRAME. Not the same event
   * as 'channel-stalled' and not the same sentence: a stall is a source that
   * was working and stopped, and the fix for it is on the user's screen
   * ("re-share your whole screen"). This is a source that was never alive —
   * B4's closed-lid camera, live and unmuted and negotiated at 1920x1080@30,
   * writing a 28-byte file — and nothing the user does to the shared surface
   * changes it. Fires once per channel per take; 'channel-resumed' still
   * closes it if frames ever start.
   */
  | { type: 'channel-dead'; kind: ChannelKind }
  /**
   * H1 — A COMPONENT UNDER A LIVE CHANNEL DIED AND THE CHANNEL WAS REOPENED.
   *
   * Not `channel-error`, which is the sentence for a channel that is over
   * ("saved up to this point only"), and not `channel-ended`, which is a
   * device that is gone. The device here is still live and still recording:
   * what happened is a hole of tens of milliseconds and a new file. The UI
   * says so because the take is no longer one continuous file per kind, and
   * because a user who is told nothing has no way to know that a hole exists.
   */
  | { type: 'channel-contained'; kind: ChannelKind; cause: SegmentSeam['cause']; gapMs: number }
  /** Session lost its last channel (or hit MAX_RECORDING_MS, if a cap is ever
   *  set again) and began stopping itself. UI should call stop() to collect the
   *  Recording — stop() is idempotent and always returns the same promise. */
  | { type: 'auto-stopped' }
  /**
   * The compositor was painting the recording preview and has stopped (its
   * watchdog degraded it, or a late join tore it down), so a preview fed from
   * it would freeze on its last frame. The UI must go back to its own source
   * preview. Only ever emitted with live:false — the TRUE answer is the
   * resolved value of attachCompositePreview().
   */
  | { type: 'composite-preview'; live: false }
  /**
   * The live composite has settled the shape it is writing (task F13). Fired
   * once per take, and it is not always what capture ASKED for: the request is
   * built from `track.getSettings()`, which reports the sensor's landscape
   * dimensions on a phone held portrait, so the engines correct it from the
   * first picture they actually receive. The recording preview follows this.
   */
  | { type: 'composite-geometry'; width: number; height: number }

export interface CaptureSession {
  readonly state: CaptureState
  readonly config: CaptureConfig
  /** Live streams for UI preview, keyed by channel kind. Available while armed/recording. */
  readonly previewStreams: Partial<Record<ChannelKind, MediaStream>>
  /** Surface the screen channel is capturing, once it is known. */
  readonly displaySurface: DisplaySurfaceKind | null
  start(): void
  /** Stops all recorders, flushes to the blob store, persists metadata. */
  stop(): Promise<Recording>
  /** Abort and discard everything. */
  cancel(): Promise<void>
  /** Live-mute/unmute an audio channel while recording (mic / system-audio only).
   *  Reversible, and the channel keeps recording — silence, at full length. */
  setAudioEnabled(kind: ChannelKind, enabled: boolean): void
  /**
   * Turn ONE input off, or back on, mid-take. This is a real stop, not a mute:
   *
   *  OFF — the device is released (camera light out, mic handle returned) and
   *    that channel's file closes at this instant, so its timeline bar ENDS
   *    here instead of running frozen (video) or silent (audio) to the end of
   *    the take. Same teardown the browser's own "Stop sharing" takes, so a
   *    user-stopped channel and a browser-stopped one are one code path and
   *    one file shape. Turning off the last live channel auto-stops the
   *    session, exactly as losing it would.
   *
   *  ON — the device is re-acquired and late-joins as a NEW channel of the
   *    same kind, with its own startOffsetMs. The off stretch therefore stays
   *    a real hole on the timeline rather than being papered over, and a kind
   *    can appear as several non-overlapping segments in Recording.channels.
   *    Every consumer already resolves channels by id and window, so exactly
   *    one segment of a kind is ever active at a given instant.
   *
   * Asynchronous by nature: success arrives as 'channel-late-join', failure as
   * 'channel-error'. Screen resume re-opens the browser's picker — no API can
   * re-share a surface silently, and pretending otherwise would be a lie.
   * A kind that was never armed can be turned on the same way.
   */
  setChannelActive(kind: ChannelKind, active: boolean): void
  /**
   * UI1 — MOVE THE CAMERA PiP WHILE THE TAKE RUNS. Null restores the default
   * corner. It is the ONE place during capture where the composition is the
   * user's to change, and it is here rather than only in the editor because the
   * thing you are trying not to cover is on screen while you record, not after.
   *
   * The pose is written into the COMPOSITE, so it is in the recorded file, and
   * it is carried on the finished Recording so the editor opens with the PiP
   * where it was put — see Recording.cameraPose. Without that second half the
   * editor would show the default corner over a file that has the moved one,
   * which is the badge-disagrees-with-the-path bug in a different costume.
   */
  setCameraPose(pose: CameraPose | null): void
  /**
   * F6 — pause the take without releasing anything. Every live channel closes
   * its current segment; the tracks, the streams and the wake lock stay. A
   * paused take's composite is invalidated (a live composite is ONE continuous
   * file and cannot represent a gap), so a paused take exports through the
   * render — which is the same fallback a late join already takes.
   * No-op unless recording.
   */
  pause(): void
  /**
   * F6 — open segment N+1 on the SAME tracks. No re-acquisition, no prompt, no
   * picker: that is the whole difference between this and setChannelActive.
   * No-op unless paused.
   */
  resume(): void
  /**
   * Ask the live compositor to paint the recording preview into this canvas
   * (O4-polish), instead of the UI decoding the same sources a second time into
   * <video> elements. The canvas is TRANSFERRED to the compositor's worker, so
   * it must be a fresh element and nothing else may draw into it.
   *
   * Resolves TRUE only once a composited frame has actually landed on it, so
   * the caller can drop its own preview without a blank flash. FALSE is a
   * normal answer — the v1 engine composites on the main thread from the very
   * elements the UI is showing and has nothing to hand over — and means "keep
   * the preview you have". A later 'composite-preview' event with live:false
   * means the compositor stopped painting and the UI must switch back.
   */
  attachCompositePreview(canvas: HTMLCanvasElement): Promise<boolean>
  on(cb: (e: CaptureEvent) => void): () => void
}

/**
 * Duration cap, or null for none. Robert 2026-08-23: NONE — takes run until the
 * user stops them or the last channel dies. The 30-min cap of 2026-07-13 was
 * retired once the two things it was hiding were gone: capture already streams
 * every channel to OPFS as it records (no RAM growth with length), and O1 put
 * export on a chunked disk target (flat 4 MB held by the muxer at any length).
 * What length costs now is DISK, and nothing here guards that — see BACKLOG.
 */
export const MAX_RECORDING_MS: number | null = null

// ---------------------------------------------------------------------------
// store (src/core/store) — required exports:
//   blobStore: {
//     createWriteStream(key: string): Promise<WritableStream<Uint8Array | Blob>>
//     read(key: string): Promise<Blob>
//     remove(key: string): Promise<void>
//     usageBytes(): Promise<number>
//   }
//   recordingsRepo: {
//     save(r: Recording): Promise<void>
//     get(id: string): Promise<Recording | undefined>
//     list(): Promise<Recording[]>            // newest first
//     remove(id: string): Promise<void>       // also removes channel blobs
//   }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// timeline (src/core/timeline) — pure functions, unit-tested:
//   defaultEditState(r: Recording): EditState
//   clampEditState(r: Recording, e: EditState): EditState
//   outputDurationMs(e: EditState): number
//   channelSourceTimeAt(r, e, channelId, outputMs): number | null
//     -> channel-local ms to sample, or null if inactive at that output time
//   activeChannelsAt(r, e, outputMs): ChannelRecording[]
//   hasEnabledVideo(r, e): boolean
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// compose (src/core/compose) — required exports:
//   exportRecording(opts: ExportOptions): Promise<ExportResult>
//
// Layout rules (product decision, fixed for MVP):
// - Output default 1920x1080 @ 30fps, MP4 h264+aac; fallback chain
//   avc+aac -> avc+opus -> vp9+opus webm, chosen by encoder capability probing.
// - screen active: screen letterboxed full-frame; camera (if active) is a PiP,
//   bottom-right, width = 24% of output width, margin 24px, corner radius 16px.
// - camera only: camera full-frame (cover).
// - no video channels active anywhere: waveform visualization of the mixed audio
//   on a dark gradient background (this is the audio-only -> video promise).
// - Audio: all enabled audio channels mixed. Must stream/mix incrementally —
//   never decode a full 30-min track into one buffer.
// ---------------------------------------------------------------------------

export interface ExportSettings {
  width: number
  height: number
  fps: number
  /** Video bitrate target; falls back to the compose default when absent. */
  videoBitrate?: number
  /**
   * Keyframe cadence in seconds (task O11b). Absent = the compose default.
   * Changes no pixel — only how coarsely a player can seek — but keyframes are
   * where a static screen recording spends most of its bytes.
   */
  keyFrameIntervalSec?: number
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { width: 1920, height: 1080, fps: 30 }

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finalizing'
  /** 0..1 across the whole export. */
  ratio: number
}

/**
 * What an AI export IS, for a UI that must not describe a PDF as a video
 * (task AI1). Absent on every ordinary export; present means the blob is the
 * one-file, no-video-track document an agent reads — so `width`/`height` are
 * one keyframe's dimensions, not a picture the user will watch.
 */
export interface AiExportFacts {
  /** Total pages: the index, then one per keyframe. */
  pages: number
  keyframes: number
  /** What this file costs an agent to read: pixels/750 + text/4. */
  approxTokens: number
}

export interface ExportResult {
  blob: Blob
  mimeType: string
  fileName: string
  durationMs: number
  width: number
  height: number
  /** Present only for the "For AI" export (task AI1). */
  ai?: AiExportFacts
  /**
   * OPFS key of the scratch file backing `blob`, when the muxer streamed to
   * disk (task O1). Present so a caller that finished with the bytes — copied
   * them, or delivered nothing because the user cancelled — can free the
   * scratch precisely instead of waiting for an age sweep.
   */
  scratchKey?: string
}

/**
 * F16b — WHAT A BACKGROUND JOB MAY SPEND RIGHT NOW.
 *
 * `duty` is the fraction of wall clock the job may work for; `paused` is the
 * fully-shed rung. A USER-VISIBLE export never has one of these: the person is
 * waiting for it, so it runs flat out. Only a job nobody asked for yet paces
 * itself. The levels and the policy behind them live in `core/backgroundWork.ts`.
 */
export type WorkPace = 'full' | 'half' | 'trickle' | 'paused'

/**
 * E1's pressure vocabulary — Compute Pressure's own words, on purpose (see
 * core/pressure.ts). Here rather than there because a take PERSISTS them: an
 * ElasticEvent below carries the level that decided it, so the contract file
 * owns the spelling and `core/pressure.ts` re-exports it.
 */
export type PressureLevel = 'nominal' | 'fair' | 'serious' | 'critical'

/**
 * E2 — the hardware blocks a take contends for, and the unit it sheds by. A
 * block is something that can be unloaded independently of the others: on Apple
 * silicon the video encoder is its own block and CPU load does not reach it,
 * which is why "the machine is busy" is not an answer to "what should stop".
 */
export type HardwareBlock = 'encoder' | 'cpu' | 'gpu' | 'disk'

/**
 * E2 — the three layers of the order of defence, cheapest to give up first.
 * `unseen` = work nobody is looking at (background render, prerender,
 * filmstrips, UI effects). `burst` = the encoder's memory-bounded absorber.
 * `picture` = the frame rate, which is the LAST dial that may move.
 */
export type ElasticLayer = 'unseen' | 'burst' | 'picture'

/**
 * One line of a take's elastic ledger (core/elasticLog.ts), persisted in
 * `stopStats.elastic`. Robert's 2026-09-02 ruling gave elastic an ORDER, and an
 * order is a claim about what happened — this is what makes it readable after
 * the fact instead of asserted.
 */
export interface ElasticEvent {
  /** ms since the take started. */
  atMs: number
  layer: ElasticLayer
  action: 'shed' | 'restore'
  /** What moved, in a few words — `background work full → paused`, `60 → 30 fps`. */
  what: string
  /** Why, quoting the signal that decided it. */
  why: string
  /** The hardware block the deciding signal was about, when there was one. */
  block?: HardwareBlock
  level?: PressureLevel
}

/**
 * The throttle a background render reads. A function pair rather than a value
 * because the render outlives any single reading: it asks at every chunk
 * boundary, and a PAUSED job has to be woken by the change rather than by
 * polling it awake.
 */
export interface PaceSource {
  level(): WorkPace
  /** Called on every change. Returns the unsubscribe. */
  subscribe(cb: (level: WorkPace) => void): () => void
}

export interface ExportOptions {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
  /**
   * F16b: present only for a BACKGROUND render (the pre-render started at stop
   * or beside an edit). Absent — every user-visible export — means "spend the
   * machine", which is what an export the user is waiting for must do.
   */
  pace?: PaceSource
}

// ---------------------------------------------------------------------------
// export jobs (src/core/compose/exportJobs.ts) — the export as a BACKGROUND
// JOB (Robert, 2026-08-30): visible in a dock at the bottom of every screen,
// running while the user edits or records something else, surviving a page
// refresh (the job restarts from its persisted spec — sources and edit are
// already durable), several at once. jobsRepo (IndexedDB) holds the records;
// the finished file is copied to an OPFS key the job owns so "Save again" and
// the cloud button survive the refresh too.
// ---------------------------------------------------------------------------

export type ExportJobKind = 'video' | 'ai'
export type ExportJobState = 'running' | 'done' | 'failed'

/** What survives of an ExportResult in IndexedDB — everything but the Blob. */
export interface ExportJobResultMeta {
  fileName: string
  mimeType: string
  bytes: number
  durationMs: number
  width: number
  height: number
  /** OPFS key of the job's own copy; null until the copy lands (the download
   *  itself never waits on it). */
  blobKey: string | null
  ai?: AiExportFacts
}

export interface ExportJobRecord {
  id: string
  kind: ExportJobKind
  recordingId: string
  /** Snapshotted at press — later edits never leak into a running job. */
  edit: EditState
  /** Absent for 'ai' (that artefact has no tier). */
  settings?: ExportSettings
  allowPacketCopy: boolean
  createdAt: number
  /** How many times this job has started — a refresh restarts it, and a job
   *  that keeps killing the page must not restart forever. */
  runs: number
  state: ExportJobState
  progress: ExportProgress
  error?: string
  result?: ExportJobResultMeta
}

// ---------------------------------------------------------------------------
// share (src/core/share) — required exports:
//   saveToFile(result: ExportResult): void        // triggers browser download
//   listShareTargets(): ShareTarget[]             // file always; cloud when configured
// cloud (src/core/cloud) — required exports:
//   getCloudProvider(): CloudProvider | null      // null when env not configured
//   Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
// ---------------------------------------------------------------------------

export interface ShareTarget {
  id: 'file' | 'cloud'
  label: string
  available: boolean
  /** Why it's unavailable, for UI hint. */
  reason?: string
}

export interface CloudUser {
  id: string
  email: string | null
  name: string | null
  avatarUrl: string | null
}

export interface CloudShare {
  id: string
  fileName: string
  sizeBytes: number
  url: string
  createdAt: number
  expiresAt: number
}

export interface CloudUploadProgress {
  ratio: number
}

export interface CloudProvider {
  signInWithGoogle(): Promise<void>
  signOut(): Promise<void>
  getUser(): Promise<CloudUser | null>
  onAuthChange(cb: (u: CloudUser | null) => void): () => void
  /** Uploads a finished export; enforces quota; returns a share with signed URL. */
  upload(result: ExportResult, onProgress?: (p: CloudUploadProgress) => void): Promise<CloudShare>
  listShares(): Promise<CloudShare[]>
  deleteShare(id: string): Promise<void>
  /** Deletes every object + row this user owns. */
  deleteAllData(): Promise<void>
  quota: { maxTotalBytes: number; shareTtlDays: number }
}

// ---------------------------------------------------------------------------
// analytics (src/core/analytics)
// ---------------------------------------------------------------------------

export type AnalyticsEvent =
  | 'signup'
  | 'record_start'
  | 'record_complete'
  | 'export_start'
  | 'export_complete'
  | 'export_error'
  | 'share_upload_success'
  | 'share_upload_error'
  // Screen share taken by the browser but never delivered (the Chrome/macOS
  // picker wedge). Tracked because "users never hit this" is checkable only
  // if we can see how often the safe-mode retry is saving them.
  | 'display_wedge'
  | 'app_error'

export class CaptureError extends Error {
  constructor(
    public readonly kind: ChannelKind | 'none',
    /** 'wedged': the browser took the share/device and never delivered it —
     * the Chrome/macOS picker wedge. Distinct from 'unavailable' so the UI
     * can run its recovery ritual (auto-refresh) for exactly this case.
     * 'permission': the SAME never-settling promise, but because macOS has not
     * granted this browser screen recording (W1). It looks identical from the
     * page and is a different thing entirely: the auto-refresh ritual must NOT
     * run for it — a fresh renderer does not change a TCC grant, it only hides
     * the one message that would fix the problem.
     * 'stale': no request was made at all. This document still had a stuck one
     * outstanding (displayInflight.ts), and a second one dispatched into the
     * same frame is what turns one wedge into every-press-wedges. The UI must
     * ALWAYS refresh on this one — unlike 'wedged', it is not a diagnosis that
     * a refresh might fail to cure, it is a document that is known to be
     * unusable and a refresh is the only thing that replaces it.
     * 'busy': no request was made either, and this one is NOT a diagnosis at
     * all — a screen request from this document is still pending, so Chrome's
     * capture queue is already occupied and a second dispatch is the exact
     * collision that hangs it (Robert, 2026-08-30: two tabs recording at once
     * wedged it on demand). The UI must NOT refresh on this: the pending
     * request can still settle, and replacing the document is what orphans it
     * beyond anyone's reach. */
    public readonly reason: 'denied' | 'unavailable' | 'no-channels' | 'wedged' | 'permission' | 'stale' | 'busy',
    message: string,
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}
