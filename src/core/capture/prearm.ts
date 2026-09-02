/**
 * Pipeline prewarm (no device access). Product decision 2026-07-15: camera
 * and mic must never activate before the record click — device acquisition
 * happens in acquire.ts, concurrently with the screen picker when permission
 * is already granted.
 */

import { noteBootPhase } from './wedgeJournal'

let warmed = false

/**
 * Resolves once the browser's media path answers a harmless asynchronous
 * question. On every healthy machine that is ~10 ms; on a machine whose
 * browser process is stuck behind a wedged screen share it never resolves,
 * and never resolving is the point — see the caller. A missing or refused API
 * counts as an answer. Enumerates only; acquires nothing, lights nothing.
 */
async function mediaPathAnswers(): Promise<boolean> {
  const md = navigator.mediaDevices
  if (!md || typeof md.enumerateDevices !== 'function') return true
  try {
    await md.enumerateDevices()
  } catch {
    /* refused (insecure context, policy) is still an answer */
  }
  return true
}

/**
 * Compile-and-spin the capture pipeline before the first record click:
 * capture-engine chunk + worklet module + durable writer worker + OPFS dir.
 * Kills the first-use stall (chunk fetch, worker/worklet compilation,
 * dev-server transform latency). Called at mount; touches no device.
 *
 * Every awaited step names itself to the wedge journal (noteBootPhase), so a
 * main-thread block after a wedge reload is written down WITH the step it
 * happened in, not just its length. The encoder warm runs alongside rather
 * than in this sequence, so a block inside it lands on whichever awaited
 * phase was current.
 */
export function warmCapturePipeline(): void {
  if (warmed) return
  warmed = true
  void (async () => {
    try {
      noteBootPhase('warm:encoder')
      // THE ENCODER MEASUREMENT GOES FIRST, and that ordering is the point
      // (2026-08-30). encoderWarm both pays the per-launch VideoEncoder init
      // AND measures what this machine's encoder can carry, and capDisplayTrack
      // reads that measurement to decide whether a take may attempt 60 fps at
      // the source's own size. Kicked off behind four other awaits, it landed
      // AFTER the first take had already armed — measured on the rig, which
      // uses a cold profile every run: the number printed, and the take had
      // already fallen back to the constant. It is cached across launches, so
      // this only ever cost the FIRST take of a fresh profile; it costs it no
      // longer. Deliberately not awaited — nothing here may delay a record.
      //
      // O4's original reason still stands and is why the warm exists at all: a
      // Chrome process's FIRST VideoEncoder pays a multi-second init, per
      // LAUNCH (see encoderWarm.ts). X6 added a second: the raw channels own
      // VideoEncoders too and need the init paid whether or not the COMPOSITE
      // is v2 — measured cold on the rig, they dropped 45-65 % of their frames.
      // Gated on whether anything will USE one, so a session that will not
      // spends nothing.
      void (async () => {
        const [{ preferredCompositeEngine }, { warmVideoEncoder }, { canMeasureVideoCapture }] =
          await Promise.all([import('./engine'), import('./encoderWarm'), import('./measuredVideo')])
        if (preferredCompositeEngine() === 'v2' || canMeasureVideoCapture()) void warmVideoEncoder()
      })()
      // Ask the browser which devices are already ours, NOW — minutes before
      // the click, with no picker on screen to delay the answer. It is a
      // permission lookup, not an acquisition, so the no-idle-device rule
      // above is untouched; what it buys is that the record click can fire
      // getUserMedia in the same tick as the screen picker instead of behind
      // an IPC the picker can hold up (see grants.ts).
      noteBootPhase('warm:grants')
      void (await import('./grants')).primeGrants()
      noteBootPhase('warm:chunks')
      const { loadCaptureEngine, loadRecovery } = await import('./lazy')
      // Fetch the split chunks now so the record click never waits on a
      // network round-trip (O7).
      void loadRecovery()
      const [{ prewarmWorkletModule }, { blobStore }] = await Promise.all([
        import('./measuredAudio'),
        import('@core/store'),
        loadCaptureEngine(),
      ])
      noteBootPhase('warm:opfs')
      const w = await blobStore.createWriteStream('__warmup.bin')
      await w.abort()
      await blobStore.remove('__warmup.bin').catch(() => undefined)
      // THE AUDIO PREWARM GOES LAST, AND ONLY ONCE THE BROWSER'S MEDIA PATH HAS
      // ANSWERED. `new AudioContext()` is synchronous, and inside it Chromium
      // waits for the output device's authorization from the browser process:
      // AudioOutputDevice::GetOutputDeviceInfo() → did_receive_auth_.Wait(),
      // capped by kMaxAuthorizationTimeout = 10 s (media/audio/
      // audio_output_device.cc, blink modules/media/audio/audio_device_factory.cc).
      // After a wedged screen share that path does not answer, and the wait is
      // paid twice. Read off Robert's machine 2026-09-02: EVERY boot after the
      // wedge reload froze the main thread for 19.6–19.9 s, starting within
      // 500 ms of mount — six for six across two days — which is "after it
      // refreshed after wedge it goes unresponsive without any actions"
      // (reported twice, unconvicted twice), and it was OURS. This prewarm
      // saves ~100 ms of worklet compile on the first take; it must not cost
      // 20 s of a dead app at the one moment the user is about to press again.
      //
      // enumerateDevices() rides the same browser-side media path and is
      // asynchronous, so it is the pre-flight: on a healthy machine it answers
      // in ~10 ms and the prewarm runs at mount exactly as before; on a stuck
      // one it never answers and the prewarm never runs — nothing blocks, and
      // the take pays the compile at arm, where prewarmMeasuredAudio pays it
      // anyway. It enumerates, it acquires nothing: no indicator, no prompt.
      noteBootPhase('warm:devices')
      if (await mediaPathAnswers()) {
        noteBootPhase('warm:worklet')
        await prewarmWorkletModule()
      }
      noteBootPhase('warm:done')
    } catch {
      warmed = false
    }
  })()
}
