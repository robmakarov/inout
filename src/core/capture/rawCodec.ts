/**
 * How a RAW screen/camera channel is encoded (task X6).
 *
 * `mediarecorder` is the shipped path: Chromium encodes VP8/VP9 in SOFTWARE,
 * which O3a measured as the largest single CPU cost of a take, paid once per
 * raw video channel while the live composite beside it encodes AVC in hardware.
 * `webcodecs` is the X6 path: MediaStreamTrackProcessor → VideoEncoder (AVC) →
 * fragmented MP4 → the worker's own SyncAccessHandle.
 *
 * THE DEFAULT IS `webcodecs` SINCE 2026-08-26 — Robert's ruling, given on his own
 * field evidence, exactly the flip X6 reserved for him. The deciding take pair
 * (black-boxed): the same recording regime starved the audio clocks 1.6 % of
 * wall time on MediaRecorder and 0.16 % on WebCodecs — a 10× CPU relief that
 * Robert heard ("music sounds shitty / goes faster" → "yes now it okay with
 * ?rawcodec=webcodecs"). The known cost, stated when X6 shipped and accepted
 * with the flip: at the same requested ceiling the AVC screen channel writes
 * ~0.21× the VP9 bytes on screen content (rate-control undershoot, 27.9 dB
 * agreement) — the bitrateMode sweep is the standing follow-up, and an
 * unedited take's INSTANT export is untouched either way (it copies the
 * composite, not the raw channels). MediaRecorder remains the full ladder
 * underneath: capability fallback, start-failure fallback, and
 * `?rawcodec=mediarecorder` / localStorage revert it outright.
 *
 * Capability still has the last word after the preference: see
 * measuredVideo.ts's canMeasureVideoCapture(), which also fails closed on Apple
 * WebKit and Firefox, neither of which has MediaStreamTrackProcessor in the
 * shape this needs.
 *
 *   ?rawcodec=mediarecorder   (this load only)
 *   localStorage['inout.capture.rawcodec'] = 'mediarecorder'   (sticky)
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
  return fromSearch() ?? fromStorage() ?? 'webcodecs'
}

export function setRawVideoCodec(codec: RawVideoCodec): void {
  try {
    localStorage.setItem(STORAGE_KEY, codec)
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}
