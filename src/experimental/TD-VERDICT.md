# TD review verdict — exp/research (2026-07-14)

Review method: 9 adversarial code reviews (one per experiment + isolation audit) + full harness
run in real Chromium (EE's environment had no browser; this one does). Runtime numbers below
are measured, not predicted. RESEARCH.md remains the author's doc; where it conflicts with this
file, this file rules.

## Measured results (Chromium, this hardware, 2026-07-14)

- **Durability A/B (Exp 3): CONFIRMED.** createWritable path: 0/1,048,576 bytes recovered after
  simulated crash. SyncAccessHandle+flush: 1,048,576/1,048,576. A mid-recording crash today loses
  ALL media. Highest-severity reliability finding of the audit.
- **Oracle (Exp 2): ran after a 1-line fix (analyze.ts CanvasSink `fit` — committed 7d6a44a) and
  immediately caught a real production defect: A/V sync FAIL, ~171 ms mean offset** (170.7 full /
  173.4 trimmed export — systematic, not noise; threshold 80 ms). Drift 1.46 ms/s PASS, trim
  accuracy 3.1 ms PASS (caveat: probed only at a frame-aligned 1500 ms), readability 100 %,
  export 3.83× realtime (streamx baseline). Corroboration: session-log run measured recorder
  start skew screen=76 ms vs mic=0 ms — video channels start late relative to audio.
- Session Log (Exp 1): shadow diff 0 mismatches; the five-gap list verified line-by-line against
  session.ts internals; replay-from-disk consistent.
- wcap (Exp 4): forced GOP ≈2 s confirmed vs MediaRecorder's opaque 3.4 s (smart-cut precondition
  established). 11/153 frames dropped to backpressure on THIS machine — caution flag. Rig bugs:
  timestamps not rebased (5 s capture reports firstPacketSec=5, durationSec=10), mux backpressure
  never awaited, main-thread self-interference biases B.
- streamx (Exp 5): runs; at 20 s/1.4 MB output the heap gap is in noise. Memory claim stands on
  library semantics (BufferTarget holds file + finalize copy in RAM), not on this run.
- datachan (Exp 6): works — 90 events, clean 20 Hz sampling.

## The meta-finding (answer to "missing fundamental primitives")

One primitive, hit independently by four experiments: **a measured per-channel time base.**
Production start offsets come from the `recorder.onstart` heuristic; the oracle measures the
resulting error (~171 ms A/V sync), the session log lists real first-media timestamps as gap #1,
wcap demonstrates measured `VideoFrame.timestamp` exists, and datachan's alignment breaks on the
epoch it can't obtain. One additive capture-side event (per-channel measured start + epoch
handoff + chunk facts) closes all four. That, plus the durable writer, are the only production
items this research justifies today.

## Per-experiment rulings

| # | Experiment | Ruling |
|---|---|---|
| 7 | TimeMap | **Merge `timemap/` module as-is** (equivalence with production genuinely proven; pure; 2 consumers). Scene: **keep dormant** — "consumed by 6 and 8" is false for scene (zero consumers), can't express the PiP border, silent 4/3 aspect fallback; merging it now creates a 3rd hand-synced layout copy. Scene merges only inside its first renderer-migration PR. |
| 2 | Oracle | **Keep; promote to CI after hardening** (list below). Already paid for itself (sync defect). Never merges into src/core — it is an instrument. |
| 3 | Recovery | **Finding accepted → production work item (durable writer).** The folder's journal→orphan→salvage flow is a mirage as built (journal can't join to blobs — recordingId unobservable; marks 'closed' on 'stopping' before writers close; today's crash leaves 0 bytes so there is nothing to salvage). Merge NOTHING from the folder; keep as reference. |
| 1 | Session Log | **Keep.** Real deliverable = the verified gap list + the additive CaptureEvent proposal. The persistence/integrity machinery is NOT deliverable: the shadow log itself writes through createWritable (self-contradicts Exp 3 — post-crash log is EMPTY, not a prefix), and the hash chain doesn't cover `relMs`, which the fold trusts (tamper "detection" is theater). |
| 5 | Streamx | **Direction accepted, merge pitch rejected as written.** "Byte-level equivalence via oracle" gate is unsatisfiable by construction (production emits fast-start MP4; any StreamTarget build is fMP4/moov-at-end — a user-visible container decision nobody has made). Real adoption plan required: chunked StreamTarget, container decision, pipeline error-path cleanup, app-layer file lifecycle, oracle decode-level verification, memory sweep at real bitrate/duration. Scheduled after items 1–2 below. |
| 4 | wcap | **Keep as rig only.** Trust the cadence table; treat cost/drop/timestamp columns as directional until rig fixes (await add() backpressure, rebase timestamps, worker placement). No migration talk before oracle-baselined clean runs incl. audio on mid-tier hardware. |
| 6 | datachan | **Keep dormant.** Privacy-by-schema verified real. Alignment semantics wrong twice: epoch never receives production's t=0 rebase (events map ~minOffset late, silently), and mapping through an arbitrary reference channel deletes events during blanks/disabled channels — correct map is global-trim-only. Both blocked on the same epoch-handoff API as the Session Log gap list. Note: keydown timing is itself a side channel — future consent copy must cover timing, not just "no key identity". |
| 8 | Semantic | **Keep dormant.** Channel-local word schema + TimeMap reuse = the right lock. Transcriber interface is explicitly NOT locked (whole-buffer 115 MB call contradicts the streaming rule; no abort/progress/streaming). silenceGaps→cutRanges has a channel-local vs output domain mismatch — do not wire without a conversion through the channel TimeMap. Depends on timemap merge (imports it). |

## Hygiene (applies before any further harness runs)

Three experiments write real production storage (session-log, recovery, oracle staging), only
happy-path cleaned; add try/finally around every production-storage touch, and run the harness
on a throwaway browser profile until then. Misc: needsSynthetic is dead, streamx leaks its heap
sampler on throw, shadow logs accumulate unboundedly.

## EE build order (nothing else; nothing merges without TD sign-off)

1. **A/V sync root cause + fix proposal.** Use the oracle: vary channel mixes, synthetic + real
   capture, non-frame-aligned trims. Hypothesis to test first: audio-vs-video first-media
   asymmetry vs onstart heuristic. Deliverable: diagnosis note + candidate patch on a branch +
   oracle before/after. The fix itself lands only after TD review.
2. **Durable write path — production PR.** Per-channel worker, SyncAccessHandle + flush cadence
   (measure cost at 4-channel load), behind the existing blobStore contract. Existing tests +
   oracle green. Recovery UX explicitly out of scope (product decision, PO owns).
3. **Oracle hardening + CI.** fit fix (done, 7d6a44a); non-aligned trim param (e.g. 1483 ms);
   outlier rejection in fitClock; gate maxAbs alongside |mean|; failure-path cleanup incl. stale
   exp-oracle-* sweep; headless-Chromium CI job storing baseline artifacts.
4. (gated on 1–3) Streamx adoption plan per ruling above; additive capture-event API design doc
   (closes Session Log gaps + datachan epoch + recovery journal join) for TD review.
