/**
 * O4 — force the renderer's first-VideoEncoder initialization while nobody is
 * recording.
 *
 * Measured 2026-08-24: the first VideoEncoder of a Chrome PROCESS pays a
 * multi-second initialization — per LAUNCH, not per profile (a reused profile
 * in a new process still measured 13-16 fps / 177-260 ms latency on its first
 * take against ~28 fps / 13 ms warm). Without this, the v2 engine's first take
 * after every browser launch drops its opening seconds while the encoder wakes
 * up. Five 1080p frames through a throwaway encoder at mount move that cost to
 * app load, off every critical path. No device is touched (the frozen
 * no-idle-device-access rule); the input is a blank OffscreenCanvas.
 *
 * The warm runs on the MAIN thread while the engine encodes in a WORKER — that
 * this still works is measured, not assumed (the init lives in the GPU
 * process, shared across threads): `npm run exp -- o4worker
 * {"cells":["mainwarm"],"warmup":false}` runs exactly this function cold and
 * then the production worker.
 */

let started: Promise<void> | null = null

export function warmVideoEncoder(): Promise<void> {
  started ??= (async () => {
    try {
      if (typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return
      const config: VideoEncoderConfig = {
        codec: 'avc1.4D402A',
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 30,
        latencyMode: 'realtime',
        hardwareAcceleration: 'prefer-hardware',
      }
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
      if (!support?.supported) return
      const canvas = new OffscreenCanvas(config.width, config.height)
      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) return
      const encoder = new VideoEncoder({ output: () => undefined, error: () => undefined })
      encoder.configure(config)
      for (let i = 0; i < 5; i++) {
        // Content is irrelevant; the flush below is what forces the
        // initialization to actually complete rather than merely queue.
        ctx.fillStyle = i % 2 ? '#202028' : '#303038'
        ctx.fillRect(0, 0, config.width, config.height)
        const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30) })
        try {
          encoder.encode(frame, { keyFrame: i === 0 })
        } finally {
          frame.close()
        }
      }
      await encoder.flush()
      encoder.close()
    } catch {
      /* a failed warm costs nothing — the take pays the init instead */
    }
  })()
  return started
}
