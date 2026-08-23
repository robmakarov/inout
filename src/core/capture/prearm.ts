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
