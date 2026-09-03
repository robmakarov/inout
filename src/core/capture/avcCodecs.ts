/**
 * AVC PROFILE/LEVEL CANDIDATES, IN ASCENDING CAPACITY — one owner (B14).
 *
 * A LEVEL IS A FRAME-SIZE LIMIT, and Chrome enforces it: `isConfigSupported`
 * REFUSES a frame the level cannot hold rather than clamping it. The old list
 * stopped at 4.2 (8704 macroblocks, i.e. about 1920x1088), which was invisible
 * for as long as capture was pinned to 1080p — and became a lost channel the
 * morning native-res capture went default, because the raw channel is now
 * configured at the MONITOR's own size. Reproduced on prod:
 * `?synthetic=1&screensize=2560x1441` returns `no supported AVC VideoEncoder
 * config` and the take comes back "Missing from this take: Screen", with the
 * preview having shown the screen throughout. Every display bigger than 1080p
 * was in that hole: 1440p is 14400 macroblocks and 4K is 32400.
 *
 * 5.0 (22080 MB) covers 1440p, 5.1/5.2 (36864 MB) cover 4K, 6.0 covers what
 * comes after. APPENDED, never reordered: the loop returns the first supported
 * config, so every frame that already had one keeps exactly the encoder it had
 * — a 1080p take is untouched, which is the whole safety net.
 *
 * IT LIVES HERE RATHER THAN IN rawVideo.worker.ts BECAUSE THE METER NEEDS IT
 * TOO, and B14 is what a second copy would have cost. encoderWarm.ts measured
 * this machine's encoder with `avc1.4D402A` hard-coded — level 4.2, which
 * CANNOT BE CONFIGURED above 1080p at all. So the meter was pinned to a frame
 * size the take never uses, and rate.ts compared that reading against a
 * 3024x1964 demand. Measured on prod 2026-09-03, same machine, same 40-frame
 * meter, this codec ladder instead of the constant: 330 Mpx/s at 1920x1080 and
 * 398/406/412 at 3024x1964 — the reading the decision needs is 23 % higher than
 * the one it was getting, and 3024x1964@60 wants 356.
 */
export const AVC_CODEC_CANDIDATES = [
  'avc1.42E01E',
  'avc1.4D402A',
  'avc1.640028',
  'avc1.640032',
  'avc1.640033',
  'avc1.640034',
  'avc1.640040',
] as const

/**
 * The first candidate this browser will actually configure at this geometry, or
 * null when none will. Pure apart from the platform query, and it asks the
 * platform rather than deriving a level from the size: the macroblock
 * arithmetic is the browser's to do, and a machine with no hardware AVC at all
 * answers honestly instead of being predicted at.
 */
export async function pickAvcConfig(
  base: Omit<VideoEncoderConfig, 'codec'>,
): Promise<VideoEncoderConfig | null> {
  for (const codec of AVC_CODEC_CANDIDATES) {
    const config: VideoEncoderConfig = { ...base, codec }
    const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
    if (support?.supported) return config
  }
  return null
}
