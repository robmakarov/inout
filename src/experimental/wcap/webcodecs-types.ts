/**
 * EXPERIMENTAL — minimal declarations for Chromium APIs missing from the
 * project's TS lib set (MediaStreamTrackProcessor is a W3C mediacapture-
 * transform draft; Chromium has shipped it for years). Scoped to the
 * experiment; nothing production imports this.
 */

export interface TrackProcessor<T> {
  readable: ReadableStream<T>
}

export interface TrackProcessorCtor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): TrackProcessor<VideoFrame>
}

export function getVideoTrackProcessor(): TrackProcessorCtor | null {
  const ctor = (globalThis as Record<string, unknown>).MediaStreamTrackProcessor
  return typeof ctor === 'function' ? (ctor as unknown as TrackProcessorCtor) : null
}

export function hasWebCodecsCapture(): boolean {
  return (
    getVideoTrackProcessor() !== null &&
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined'
  )
}
