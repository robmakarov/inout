/**
 * EXPERIMENTAL — the encoder warm every rig that drives a real take needs, in
 * ONE place (R1 fix 11).
 *
 * NOTE 6, AND ITS NINTH INSTANCE. Production warms the first VideoEncoder at
 * MOUNT (app/prearm.ts — and since X6 it warms for the raw channels too), so a
 * real take never pays the initialization. A rig that calls
 * `createCaptureSession` directly bypasses prearm entirely, and the first
 * VideoEncoder of a fresh Chrome PROCESS costs multiple seconds — long enough
 * to eat most of a 10 s take. X15(c) measured what that looks like from the
 * outside: 200 of 283 frames DROPPED, "encoder behind", which reads exactly
 * like a throughput defect on the newly-default WebCodecs raw path and is not
 * one. Warmed, the identical take dropped zero.
 *
 * The warm was then pasted into that rig, and into rawCodecTake, and nowhere
 * else — eleven rigs that drive `createCaptureSession` were still cold, each
 * one able to invent the same mirage independently. This function is the one
 * copy; every such rig calls it before it opens a session.
 *
 * IT DOES NOT BELONG INSIDE `createCaptureSession`. That would be a change to
 * production capture, which needs PO's explicit yes — and prearm already does
 * the job for every real user. This is a harness concern: rigs skip the mount
 * that production always performs.
 *
 * Failure is swallowed on purpose: a warm that cannot run costs nothing but
 * the initialization the take would have paid anyway, and a rig that dies
 * because its warm-up failed reports nothing at all.
 */
import { warmVideoEncoder } from '@core/capture/encoderWarm'

export async function warmRigEncoder(): Promise<void> {
  await warmVideoEncoder().catch(() => undefined)
}
