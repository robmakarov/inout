/**
 * J13's switch — "same as last frame", off by default until Robert has seen it.
 *
 * IT CHANGES THE FILE'S BYTES, not what the file shows: a slot whose picture is
 * identical to the one before it is written as the format's own "identical to
 * the previous picture" instead of being encoded again. The pixels, the
 * duration, the timestamps and the frame count are the same either way — but
 * the bytes are not, and a default a user could ever see or measure is his
 * (the frozen rule). So it ships opt-in and the flip is his after the A/B.
 *
 * THE ROW SAYS WHAT HE GETS. Nobody says "all-skip P slice" about their own
 * recording; the panel says the render stops making the same picture twice.
 *
 *   ?sameaslast=on | off       this load only
 *   localStorage['inout.compose.sameaslast']   (sticky, the /?test row)
 *
 * ON, AND THERE IS NO KNOB — Robert 2026-09-08 ruled the picture question
 * ("ship it — exactness is to the SOURCE"), and his other standing rule is that
 * the switch count only ever goes DOWN. A `?sameaslast=` row would have put it
 * back to 50 the same day `?bgrender=` took it to 49, which `switch-gate.mjs`
 * refuses. So this ships ON with no parameter and no storage key: what remains
 * is the OVERRIDE, which only the gate rig uses to render the same take both
 * ways. The fallback the frozen rule asks for is the CAPABILITY decline — an
 * export that is not in quantizer mode, or whose stream is CABAC or has no
 * explicit picture order, gets today's render and pays nothing.
 * Read on the MAIN thread and forwarded (pipeline.ts → export.worker.ts): the
 * render worker has no `localStorage` and a `location` of its own script URL —
 * the trap that left `?cq=`, `?loudness=` and `?sourceframe=` dead on the
 * shipped path for weeks.
 */

export function sameAsLastEnabled(): boolean {
  return override ?? true
}

/** The worker has neither location nor storage: it is TOLD. */
let override: boolean | null = null
export function setSameAsLastOverride(value: boolean | null): void {
  override = value
}

export function sameAsLastActive(): boolean {
  return override ?? true
}
