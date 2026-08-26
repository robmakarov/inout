/**
 * How a RAW screen/camera channel is encoded (task X6).
 *
 * `mediarecorder` is the shipped path: Chromium encodes VP8/VP9 in SOFTWARE,
 * which O3a measured as the largest single CPU cost of a take, paid once per
 * raw video channel while the live composite beside it encodes AVC in hardware.
 * `webcodecs` is the X6 path: MediaStreamTrackProcessor → VideoEncoder (AVC) →
 * fragmented MP4 → the worker's own SyncAccessHandle.
 *
 * THE DEFAULT IS `mediarecorder`, AND THAT IS THE TASK'S OWN INSTRUCTION, not
 * caution for its own sake. X6 says "additive per the frozen rule, MediaRecorder
 * stays the ladder", and the frozen rule reads: every new engine ships
 * capability-gated with the current path as runtime fallback, DEFAULTS UNCHANGED
 * unless the task says otherwise. A capture default is PO's to flip on evidence,
 * exactly as O4's v2 flip was a separate step with its own measurements.
 *
 * Capability still has the last word after the preference: see
 * measuredVideo.ts's canMeasureVideoCapture(), which also fails closed on Apple
 * WebKit and Firefox, neither of which has MediaStreamTrackProcessor in the
 * shape this needs.
 *
 *   ?rawcodec=webcodecs   (this load only)
 *   localStorage['inout.capture.rawcodec'] = 'webcodecs'   (sticky)
 * A URL parameter wins, then storage, then the default.
 */

export type RawVideoCodec = 'mediarecorder' | 'webcodecs'

const STORAGE_KEY = 'inout.capture.rawcodec'

function isCodec(v: string | null): v is RawVideoCodec {
  return v === 'mediarecorder' || v === 'webcodecs'
}

function fromSearch(): RawVideoCodec | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('rawcodec')
  return isCodec(v) ? v : null
}

function fromStorage(): RawVideoCodec | null {
  try {
    return isCodec(localStorage.getItem(STORAGE_KEY)) ? (localStorage.getItem(STORAGE_KEY) as RawVideoCodec) : null
  } catch {
    return null
  }
}

/** What this take should ASK for; capability still decides. */
export function rawVideoCodec(): RawVideoCodec {
  return fromSearch() ?? fromStorage() ?? 'mediarecorder'
}

export function setRawVideoCodec(codec: RawVideoCodec): void {
  try {
    localStorage.setItem(STORAGE_KEY, codec)
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
