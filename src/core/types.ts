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
   * Time REMOVED to hold the timeline against the wall clock, ms (PO
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
 * Duration cap, or null for none. PO 2026-08-23: NONE — takes run until the
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
}

export interface ExportOptions {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
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
     * can run its recovery ritual (auto-refresh) for exactly this case. */
    public readonly reason: 'denied' | 'unavailable' | 'no-channels' | 'wedged',
    message: string,
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}
