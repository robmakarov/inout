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
 * WARM THE DISK, HOLD NOTHING — B2's fix, rebuilt on Robert's 2026-09-02 rule
 * "no waiting, we are trying to fix all waiting, not tolerate it".
 *
 * `blobStore.read` hands back an OPFS-BACKED File. The bytes are on disk, so
 * the first pass a media element makes over any region pays a disk read
 * whatever `preload` says — and that stall is what the preview's own sync
 * correction then reacts to, which is the noise. It is the whole of Robert's
 * report: "a lot of minor noises in tab audio, but after some time editing
 * noises almost completly stops IN SAME PLACES they were in begining". The
 * second pass is warm; nothing stalls; nothing is corrected.
 *
 * B2's answer was to copy the file into the heap, capped at 64 MB so a long
 * take could not be pulled in. An opus channel is ~16 KB/s, so that cap is 68
 * minutes — and the takes that stall most were the ones it refused to protect.
 * Robert's was 124 minutes.
 *
 * MEASURED on a real 124-minute, 117 MB opus channel (`exp previewstarve`,
 * eight jumps into regions the element had never touched, worst time until it
 * was actually playing):
 *
 *     cold, as shipped        191 ms      holds 0 MB
 *     read through, discarded   4 ms      holds 0 MB, costs 108 ms once
 *     copied into memory        8 ms      holds 117 MB, costs 166 ms once
 *
 * So the disk was the stall, the OS page cache is the fix, and holding the
 * bytes ourselves buys nothing — it is slower than warming and costs 117 MB.
 * Reading the file through and throwing every byte away removes the class at
 * ANY length, with no cap to fall off and no heap to run out of.
 *
 * Never awaited by the caller: the element gets its URL immediately and the
 * warm runs beside it, so this cannot add a millisecond to opening a take.
 * Every failure is silent — the file-backed URL is what shipped before B2 and
 * always works.
 */
/** Read size per pass. One `arrayBuffer()` over the whole file is the very
 *  allocation this avoids. */
const WARM_CHUNK_BYTES = 4 << 20

async function warmThrough(blob: Blob): Promise<void> {
  try {
    for (let at = 0; at < blob.size; at += WARM_CHUNK_BYTES) {
      const slice = blob.slice(at, Math.min(blob.size, at + WARM_CHUNK_BYTES))
      // The result goes out of scope immediately; what is kept is the OS page
      // cache entry the read created on the way.
      await slice.arrayBuffer()
    }
  } catch {
    /* a read that failed leaves the file exactly as cold as it was */
  }
}

export async function mediaUrlFor(
  blobKey: string,
  declaredType: string | undefined,
  opts?: { warm?: boolean },
): Promise<string> {
  const blob = await blobStore.read(blobKey)
  if (opts?.warm && blob.size > 0) void warmThrough(blob)
  return URL.createObjectURL(typedBlob(blob, declaredType))
}
