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

/**
 * WARM IT, IF IT IS SMALL ENOUGH TO BE WORTH IT (task B2).
 *
 * `blobStore.read` hands back an OPFS-BACKED File. The bytes are on disk, so
 * the first pass a media element makes over any region pays a disk read
 * whatever `preload` says — and that stall is what the preview's own sync
 * correction then reacts to. It is the mechanism behind the whole of Robert's
 * report: "a lot of minor noises in tab audio, but after some time editing
 * noises almost completly stops IN SAME PLACES they were in begining". The
 * second pass is warm; nothing stalls; nothing is corrected; the noise is gone.
 *
 * Reading the file into memory once removes the class rather than bounding it.
 * It is only worth doing where the file is small, which audio is and video is
 * not: a 30-minute opus channel is ~28 MB, the same length of screen video is
 * hundreds. Above the cap the OPFS file is handed over exactly as before, so a
 * two-hour take cannot be pulled into the heap by this.
 */
const DEFAULT_WARM_LIMIT_BYTES = 64 * 1024 * 1024

export async function mediaUrlFor(
  blobKey: string,
  declaredType: string | undefined,
  opts?: { warmUpToBytes?: number },
): Promise<string> {
  const blob = await blobStore.read(blobKey)
  const limit = opts?.warmUpToBytes ?? 0
  if (limit > 0 && blob.size > 0 && blob.size <= Math.min(limit, DEFAULT_WARM_LIMIT_BYTES)) {
    try {
      const bytes = await blob.arrayBuffer()
      const type = usable(declaredType) ? declaredType : blob.type
      return URL.createObjectURL(new Blob([bytes], type ? { type } : undefined))
    } catch {
      // Out of memory, or a read that failed: fall through to the file-backed
      // URL, which is what shipped before this and always works.
    }
  }
  return URL.createObjectURL(typedBlob(blob, declaredType))
}
