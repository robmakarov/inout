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
 * - A channel is active at output time t iff:
 *     enabled
 *     && recordingT = t + globalTrimStartMs is within the channel's span
 *     && localT = recordingT - startOffsetMs is within [trimStartMs, trimEndMs).
 */

export type ChannelKind = 'screen' | 'camera' | 'mic' | 'system-audio'
export type MediaKind = 'video' | 'audio'

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
}

/** Default-layout composite recorded live alongside the channels (instant export). */
export interface CompositeRecording {
  blobKey: string
  mimeType: string
  durationMs: number
  width: number
  height: number
}

export interface Recording {
  id: string
  createdAt: number
  /** Recording-timeline end: max over channels of startOffsetMs + durationMs. */
  durationMs: number
  channels: ChannelRecording[]
  /** Present when the live composite succeeded; unedited export = this file. */
  composite?: CompositeRecording
  /** Requested channels that never delivered media — surface loudly in the UI. */
  missing?: ChannelKind[]
}

export interface ChannelEdit {
  channelId: string
  enabled: boolean
  /** Channel-local, ms. Keep [trimStartMs, trimEndMs). */
  trimStartMs: number
  trimEndMs: number
}

export interface EditState {
  recordingId: string
  /** Recording-timeline, ms. Output covers [globalTrimStartMs, globalTrimEndMs). */
  globalTrimStartMs: number
  globalTrimEndMs: number
  channels: ChannelEdit[]
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

export type CaptureState = 'armed' | 'recording' | 'stopping' | 'stopped'

export type CaptureEvent =
  | { type: 'tick'; elapsedMs: number; remainingMs: number }
  | { type: 'state'; state: CaptureState }
  /** A channel died mid-flight (e.g. user hit the browser's "stop sharing"). */
  | { type: 'channel-ended'; kind: ChannelKind }
  | { type: 'channel-error'; kind: ChannelKind; message: string }
  /** A slow device delivered media after recording had already begun. */
  | { type: 'channel-late-join'; kind: ChannelKind }
  /** Session hit MAX_RECORDING_MS (or lost its last channel) and began stopping
   *  itself. UI should call stop() to collect the Recording — stop() is
   *  idempotent and always returns the same promise. */
  | { type: 'auto-stopped' }

export interface CaptureSession {
  readonly state: CaptureState
  readonly config: CaptureConfig
  /** Live streams for UI preview, keyed by channel kind. Available while armed/recording. */
  readonly previewStreams: Partial<Record<ChannelKind, MediaStream>>
  start(): void
  /** Stops all recorders, flushes to the blob store, persists metadata. */
  stop(): Promise<Recording>
  /** Abort and discard everything. */
  cancel(): Promise<void>
  /** Live-mute/unmute an audio channel while recording (mic / system-audio only). */
  setAudioEnabled(kind: ChannelKind, enabled: boolean): void
  on(cb: (e: CaptureEvent) => void): () => void
}

/** Hard cap per product decision. */
export const MAX_RECORDING_MS = 30 * 60 * 1000

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
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { width: 1920, height: 1080, fps: 30 }

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finalizing'
  /** 0..1 across the whole export. */
  ratio: number
}

export interface ExportResult {
  blob: Blob
  mimeType: string
  fileName: string
  durationMs: number
  width: number
  height: number
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
  | 'app_error'

export class CaptureError extends Error {
  constructor(
    public readonly kind: ChannelKind | 'none',
    public readonly reason: 'denied' | 'unavailable' | 'no-channels',
    message: string,
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}
