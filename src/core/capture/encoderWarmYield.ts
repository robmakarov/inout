/**
 * THE WARM MUST NEVER COMPETE WITH THE THING IT EXISTS TO HELP.
 *
 * `encoderWarm.ts` pays the renderer's first-VideoEncoder cost at mount so a
 * take does not pay it. Measured 2026-09-02 on prod: that cost is ~3.2 s and it
 * is a PROCESS cost, not a size one — a 320x240 first encoder pays 3.28 s and a
 * 1920x1080 one 3.12 s, while the SECOND encoder in the same process costs
 * 47-77 ms. So the warm cannot be made cheaper; it can only be made not to
 * overlap the take.
 *
 * And it did overlap. The warm finishes ~4.2 s after page start with nobody
 * recording; press record the moment the app is usable and it finishes at
 * 5.0-8.6 s instead, because the take's three encoders and the warm's two are
 * fighting over the same hardware. For that whole window nothing encoded exists
 * anywhere, so the take has no picture on disk — measured as exactly that: at a
 * 2/3/4/5 s kill, three video files each holding a 28-byte header and nothing
 * else, on a build where a settled app had 1.0-4.0 s of decodable picture.
 *
 * This is the one bit of state the two sides share. It is its own module so
 * session.ts can set it SYNCHRONOUSLY at the record press without importing the
 * encoderWarm chunk (which would drag it into first paint, against O7).
 */

let yielded = false

/** A take is committing. Everything optional in the warm stands down. */
export function yieldEncoderWarmToTake(): void {
  yielded = true
}

/** The take is over; the warm may finish what it owes. */
export function releaseEncoderWarmYield(): void {
  yielded = false
}

export function encoderWarmYielded(): boolean {
  return yielded
}
