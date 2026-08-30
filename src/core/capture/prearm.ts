/**
 * Pipeline prewarm (no device access). Product decision 2026-07-15: camera
 * and mic must never activate before the record click — device acquisition
 * happens in acquire.ts, concurrently with the screen picker when permission
 * is already granted.
 */

let warmed = false

/**
 * Compile-and-spin the capture pipeline before the first record click:
 * capture-engine chunk + worklet module + durable writer worker + OPFS dir.
 * Kills the first-use stall (chunk fetch, worker/worklet compilation,
 * dev-server transform latency). Called at mount; touches no device.
 */
export function warmCapturePipeline(): void {
  if (warmed) return
  warmed = true
  void (async () => {
    try {
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
      void (await import('./grants')).primeGrants()
      const { loadCaptureEngine, loadRecovery } = await import('./lazy')
      // Fetch the split chunks now so the record click never waits on a
      // network round-trip (O7).
      void loadRecovery()
      const [{ prewarmWorkletModule }, { blobStore }] = await Promise.all([
        import('./measuredAudio'),
        import('@core/store'),
        loadCaptureEngine(),
      ])
      await prewarmWorkletModule()
      const w = await blobStore.createWriteStream('__warmup.bin')
      await w.abort()
      await blobStore.remove('__warmup.bin').catch(() => undefined)
    } catch {
      warmed = false
    }
  })()
}
