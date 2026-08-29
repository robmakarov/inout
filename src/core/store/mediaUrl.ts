/**
 * A BLOB URL A MEDIA ELEMENT WILL ACTUALLY PLAY.
 *
 * THE BUG THIS EXISTS FOR, and it is the whole of iPhone Safari's behaviour
 * that Robert reported (2026-08-29: "mic dont work in iphone safari too … recorded
 * mic beatrate is shown on editing but no sound hearable"):
 *
 * A channel's bytes are written to OPFS under a key whose EXTENSION was chosen
 * from the path that records it — `.mp4` for the WebCodecs path, `.webm` for
 * everything else. But "everything else" is MediaRecorder, and MediaRecorder on
 * Safari does not produce WebM at all: it produces MP4, because Safari has no
 * WebM encoder. So on an iPhone every channel is an MP4 stored under a `.webm`
 * name. `File.type` comes from that name, `URL.createObjectURL` hands the
 * element a blob labelled `video/webm`, and Safari — which trusts the type
 * rather than sniffing the bytes — refuses it. The element is silent and
 * blank; the file is perfectly fine.
 *
 * That split is exactly what Robert saw: the WAVEFORM is decoded from the raw bytes
 * (mediabunny sniffs the container, so it is right) while the ELEMENT beside it
 * plays nothing. It also blinds the editor to the camera's real shape, because
 * an element that will not load reports videoWidth 0.
 *
 * So the recorder's own `mimeType` — which the session stores on every channel
 * and which is the only statement of what the bytes ARE — re-types the blob
 * before it reaches an element. `slice` re-types without copying the bytes.
 * This repairs takes that were ALREADY recorded, which renaming could not.
 */
import { blobStore } from './blobStore'

/** True when this type is one a media element can be given honestly. */
function usable(type: string | undefined | null): type is string {
  return !!type && type !== 'application/octet-stream'
}

/**
 * The channel's bytes, typed by what recorded them rather than by the name they
 * were stored under. `declaredType` is `ChannelRecording.mimeType` (or
 * `CompositeRecording.mimeType`); absent — takes made before it was kept — the
 * stored file is handed over exactly as it was.
 */
export function typedBlob(blob: Blob, declaredType: string | undefined): Blob {
  if (!usable(declaredType)) return blob
  if (blob.type === declaredType) return blob
  return blob.slice(0, blob.size, declaredType)
}

/** Read a stored blob and hand back a URL a media element will accept. */
export async function mediaUrlFor(blobKey: string, declaredType: string | undefined): Promise<string> {
  const blob = await blobStore.read(blobKey)
  return URL.createObjectURL(typedBlob(blob, declaredType))
}
