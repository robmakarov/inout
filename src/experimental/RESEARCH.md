# INOUT — experimental research branch (`exp/research`)

Status: **research only — nothing here ships**. The Technical Director decides per
experiment: **keep / merge / discard**. Every experiment is deletable by removing
its folder; none is imported by production code.

## Isolation guarantees (verified)

- Zero changes to production source. `git diff main -- src/core src/app src/main.tsx
  index.html package.json vite.config.ts tsconfig.json` is empty.
- No new dependencies. Everything builds on the existing toolchain + mediabunny.
- Production bundle byte-identical: `dist/assets/index-BSPE9TYe.js` has the same
  content hash before and after the branch (vite hashes content; unchanged name ⇒
  unchanged bytes).
- Experiments import FROM `@core/*` (read-only consumption of public module
  indexes); nothing imports from `src/experimental/`.
- Browser experiments run only from the dev-only page **`/experimental.html?synthetic=1`**
  (served by `vite dev`; not part of `vite build`). Storage side effects are confined
  to the OPFS `experimental/` directory + one localStorage key (`exp:inout:journal`);
  the two documented exceptions that touch production storage (oracle blob staging,
  recovery's deliberate orphan) clean up after themselves and never write Recording
  rows without an explicit demo action.
- Verification: `npm run typecheck` clean; `npm test` = 66 passing (27 production,
  unchanged + 39 new experimental).

## How to review

```
npm run dev
open http://localhost:5173/experimental.html?synthetic=1   # browser experiments
npm test                                                    # pure-math experiments
```

---

## Experiment 1 — Session Log (shadow mode)

**Purpose.** Prove that a capture session can be modeled as an append-only log of
timestamped facts, observed WITHOUT modifying `CaptureSession`, such that a pure
fold over the log reproduces the `Recording` — and enumerate exactly which facts
the public surface cannot provide (the promotion gap list).

**Architecture.** `session-log/`
- `facts.ts` — versioned fact schema (`log-opened`, `channel-armed`, `state`,
  `tick`, `channel-ended`, `channel-error`, `auto-stopped`, `stop-returned`,
  `data-event`) with a per-fact chained integrity hash (FNV-1a placeholder for
  incremental SHA-256; chain verification included).
- `shadow.ts` — observer attached via the public `on()`/`previewStreams` surface
  only; buffered NDJSON appends to OPFS `experimental/<id>.slog.ndjson` (line
  boundaries = crash recovery points).
- `fold.ts` — pure `foldSession(facts)` + `diffAgainstRecording()` classifying every
  Recording field as **matched / approximate / mismatched / unobservable**.
- `replay.ts` — re-fold from disk, tolerant of a torn final line (crash prefix).
- `run.ts` — full loop against the production capture path in synthetic mode;
  deletes the produced Recording afterwards (no library residue).

**Implementation status.** Complete as a shadow-mode prototype. Unit-tested fold +
diff + chain verification (5 tests). Browser loop wired in the harness.

**Measurements.** From the harness run (synthetic, 4s):
`matched` = channel set + video dimensions; `approximate` = durationMs (observer
sees the stopping transition; production subtracts recorder-startup normalization —
expected error ≲ tick interval + startup spread, reported per run as `errorMs`);
`unobservable` = all `startOffsetMs` values. Replay-from-disk equals in-memory fold
(`replayConsistent: true` field). Chain verification detects any tampered fact
(unit-tested).

**Documented gaps** (what promotion to a primary log needs, all additive):
per-channel recorder-start timestamps, chunk facts (`ondataavailable` time+bytes),
per-channel stop timing, blobKey assignment, exact epoch instant. One additive
`CaptureEvent` variant would close all five.

**Risks.** Shadow writes add I/O during recording (metadata-only, ~100 B/fact,
flushed at 2 Hz — negligible but unmeasured under real 4-channel load). The fact
schema is v1 and will churn; version field + fold tolerance mitigate. Biggest risk
is scope creep toward premature promotion — this branch deliberately contains no
capture-side changes.

**Recommendation.** **Keep.** Cheapest experiment with the largest downstream
surface (recovery, provenance, data channels, multi-writer all hang off it). Next
step if funded: propose the single additive capture event to close the gap list,
then run shadow diff across the full synthetic e2e matrix for N sessions.

---

## Experiment 2 — Pipeline Oracle

**Purpose.** Make media correctness a number. Today "the export looks right" is
human-verified; every pipeline experiment (4, 5, smart-cut…) is unreviewable
without quantified A/V sync, drift, frame loss, and trim accuracy.

**Architecture.** `oracle/`
- `fiducial.ts` (pure) — 24-bit + parity barcode codec with adaptive thresholding
  (white/black reference blocks; rejects washed-out or corrupted reads rather than
  guessing); least-squares clock fit (`rigMs = α + β·outMs` → α offset, β drift,
  RMS jitter); duplicate/gap frame-flow stats; envelope-based audio onset detector
  (~3 ms accuracy, chunk-boundary safe); A/V sync from beep-grid deviation.
- `rig.ts` — records a fiducial canvas (barcode strip + motion) and beeps scheduled
  at exact rig-clock multiples via WebAudio, through the SAME MediaRecorder
  settings and epoch heuristic production uses. Stages blobs via production
  blobStore under `exp-oracle-*` keys (exportRecording reads through blobStore —
  documented exception), removed on cleanup; never touches recordingsRepo.
- `analyze.ts` — demux any export (mediabunny CanvasSink at rig resolution — 16:9
  in, 16:9 out, so contain-fit is pixel-exact), decode every frame's barcode +
  detect onsets.
- `run.ts` — record once, export TWICE through the untouched production
  `exportRecording` (full + trimmed); trim accuracy = α(trimmed) − α(full) − trim,
  requiring no absolute clock knowledge. Emits pass/fail verdicts with starting
  thresholds: sync ≤ 80 ms, drift ≤ 2 ms/s, trim error ≤ 50 ms, readability ≥ 90 %.

**Implementation status.** Complete. Pure math unit-tested (10 tests: barcode
roundtrip under noise, parity rejection, drift recovery, onset accuracy, sync
measurement). Full browser loop wired in the harness.

**Measurements.** The instrument itself is validated in CI (unit tests above).
Pipeline numbers must come from a Chromium run of the harness (this environment has
no browser): expect first-run findings around the `startOffsetMs` heuristic —
the oracle measures exactly the error that heuristic introduces. Export speed is
also reported (baseline for Experiment 5).

**Risks.** Barcode survivability at low bitrates untested below 8 Mbps (mitigated:
readability is itself a reported metric; thresholds tightened only after baseline
runs). Beep scheduling maps rig-clock→AudioContext-clock once (drift over long runs
would bias sync; runs are ≤ 10 s). Sync beyond ±500 ms aliases to the wrong beep —
acceptable for a pass/fail instrument.

**Recommendation.** **Keep, and run first.** This is the instrument that makes
every other pipeline decision evidence-based. Wire it into CI (headless Chromium)
before any capture/export change is considered.

---

## Experiment 3 — Crash-proof sessions

**Purpose.** A recording must survive interruption. Establish what today's stack
actually loses on a crash, and prototype the journal → orphan detection → salvage
recovery flow.

**Architecture.** `recovery/`
- `journal.ts` — heartbeat manifest in localStorage (synchronous writes survive
  hard tab kills), updated from the public tick event; `recording`/`closed` states
  make orphan detection O(1).
- `salvage.ts` — read-only orphan scan (production `blobs/` names vs Recording
  rows), grouping by the production key scheme, per-blob probe via mediabunny
  `computeDuration()` (packet-derived — works on un-finalized webm), Recording
  reassembly with explicit, never-auto-called `commit()`.
- `durable-worker.ts` + durability A/B in `run.ts` — **the key finding**: the
  production blob path (`createWritable`) stages bytes in a swap file that only
  commits on `close()`; a mid-recording crash loses the MEDIA, not just metadata.
  The A/B proves it: write 1 MiB via each path, simulate a crash (never close /
  terminate the worker), read back. Expected: createWritable recovers 0 bytes;
  `FileSystemSyncAccessHandle.flush()` recovers all bytes.

**Implementation status.** Complete as a prototype. Orphan grouping unit-tested;
journal, durability A/B, orphan scan, and salvage-of-a-deliberate-orphan wired in
the harness (the deliberate orphan is created, salvaged, and deleted in one run).

**Measurements.** Durability A/B returns `bytesRecoveredAfterCrash` per path —
this single number is the experiment's headline. Salvage reports packet-computed
durations of partial blobs. Known salvage limits, stated in code: channel KIND and
`startOffsetMs` are unrecoverable from blobs alone (journal/Session Log closes
both; worst-case alignment skew = recorder startup spread, typically < 300 ms).

**Risks.** SyncAccessHandle requires a worker and exclusive file locks — adopting
it in the production write path is a real change (per-channel writer workers) with
throughput characteristics to measure under 4-channel load. localStorage journal is
a prototype stand-in; the Session Log is the correct final home.

**Recommendation.** **Merge-track.** If the durability A/B confirms the swap-file
loss on review hardware, this is the highest-severity reliability finding in the
audit: "streaming to OPFS" currently does not mean "durable". Recovery UX is a
product decision; the durable write path is not — it should be scheduled
regardless, ideally as the first consumer of the Session Log.

---

## Experiment 4 — WebCodecs capture (A/B, not a migration)

**Purpose.** Quantify the alternative capture path: MediaStreamTrackProcessor →
VideoEncoder(AVC, forced GOPs) → fragmented MP4 → OPFS stream, against
MediaRecorder on the same live source — for timestamp fidelity, keyframe control,
capture cost, and export advantages (remux instead of re-encode).

**Architecture.** `wcap/`
- `webcodecs-types.ts` — scoped declarations for the Chromium-only draft API +
  capability probe (no global type pollution).
- `capture.ts` — single-track prototype: explicit backpressure policy (drop over
  stall at queue > 8, counted), forced 2 s keyframes, `EncodedPacket.fromEncodedChunk`
  → `EncodedVideoPacketSource` → `Mp4OutputFormat({fastStart:'fragmented'})` →
  `StreamTarget` → OPFS. Metrics: frames in/encoded/dropped, first-frame timestamp
  (the REAL start offset, vs the production onstart heuristic), max queue depth,
  mux wall time, encode fps, bytes.
- `run.ts` — records the same canvas source via both paths sequentially, demuxes
  both files with `EncodedPacketSink`, compares: container/codec, packet counts,
  **keyframe cadence** (min/max/mean GOP spacing — MediaRecorder's is opaque;
  the prototype's must be ≈ 2.0 s exactly), first-packet timestamps, size.

**Implementation status.** Prototype complete for one video track. Deliberate,
documented scope cuts: audio (AudioEncoder — same pattern), worker placement
(mechanical), battery measurement (needs OS tooling; out of browser reach).

**Measurements.** From the harness: the keyframe-cadence table is the decisive
output (smart-cut feasibility), plus dropped-frame count under backpressure = the
kill-criterion metric for weak hardware. CPU proxy = encode fps vs source fps.
Battery: not measurable in-page; requires a scripted OS-level run (documented as
follow-up).

**Risks.** Chromium-only (acceptable per product decision, still a fallback
requirement); encoder saturation on low-end hardware (measured, not guessed — the
drop counter exists for exactly this); `MediaStreamTrackProcessor` spec churn;
remux-export path implies native-resolution output, which deviates from the fixed
1080p decision — a TD product call, flagged not decided.

**Recommendation.** **Keep as measurement rig.** Do not consider migration until
(a) the oracle baselines the current pipeline, (b) this rig reports clean runs on
mid-tier hardware with audio added. The keyframe-control evidence alone justifies
keeping the rig: it is the precondition for smart-cut exports.

---

## Experiment 5 — Streaming export

**Purpose.** Isolate and measure the export memory ceiling: `BufferTarget` holds
the whole output file in RAM (~60 MB per output minute at 8 Mbps; ≈ 1.8 GB for the
30-min cap) while a `StreamTarget` → OPFS keeps peak memory flat and unlocks
longer-than-30-min futures.

**Architecture.** `streamx/run.ts` — renders the identical procedural 1080p30
composition (no decode: decode cost is orthogonal and equal for both paths) through
both targets, fragmented MP4 in both cases; reports wall time, realtime factor,
output bytes, JS-heap delta and sampled heap high-water (Chromium
`performance.memory`). Stream runs first so buffer growth can't be blamed on
warmup. Deliberately NOT a fork of `exportRecording` — the muxing-target decision
is the smallest reviewable unit; worker placement is a separate variable kept out
on purpose.

**Implementation status.** Benchmark complete. Default 20 s runs (fast review);
duration is a parameter — the memory divergence grows linearly with it, and the
extrapolation figure is printed in the report notes.

**Measurements.** From the harness: expect comparable wall time (target overhead is
not the bottleneck) and a heap high-water gap ≈ output file size. Long-recording
behavior: run with 120–300 s durations on the review machine; the buffer path's
heap grows unbounded, the stream path's stays flat — that curve is the deliverable.

**Risks.** `performance.memory` is coarse (JS heap only; OPFS page-cache cost
invisible — but that is precisely the point: it's evictable OS cache, not tab-fatal
heap). Adopting StreamTarget in production also changes the ShareScreen contract
(Blob from OPFS file handle — trivial, `getFile()`), and progress reporting.

**Recommendation.** **Merge-track** (smallest, safest production-relevant change on
this branch): swap BufferTarget for StreamTarget-to-OPFS in `exportRecording`
behind the existing `ExportResult` contract, after the oracle (Exp 2) is in CI to
prove byte-level equivalence of outputs.

---

## Experiment 6 — Timed Data Channels

**Purpose.** Capture is the only irreversible moment; interaction data not recorded
at capture time is gone forever. Prototype a timestamped event channel sharing the
recording epoch, prove alignment through the standard timeline rules, and fix the
privacy posture at the schema level.

**Architecture.** `datachan/events.ts`
- Schema: `pointer` (20 Hz sampled), `click`, `key` (**modifiers only — key
  identity is unrepresentable in the schema**, privacy by construction),
  `visibility`, `resize`; timestamps relative to the capture epoch.
- Recorder: passive listeners in the app's own tab; NDJSON sidecar to OPFS keyed
  by recordingId; `Recording`/`EditState` untouched.
- Replay/alignment: `eventsInOutputWindow()` maps recording-time events to OUTPUT
  time through the TimeMap bridge — startOffsets, channel trims and global trims
  apply to events exactly as to media (unit-tested, including trim exclusion);
  `clickTimesOnOutput()` demoes the first derived signal (chapter candidates).

**Implementation status.** Complete for own-tab events. Alignment unit-tested
(3 tests). Live 5 s capture demo in the harness. Not implemented, documented:
cross-surface cursor when capturing another window (needs CaptureController /
Region Capture — the honest browser-reality limit from the proposal).

**Measurements.** Event counts/rates from the harness demo; alignment correctness
is proven by unit test rather than by run. Overhead is passive listeners + ~30 B
per event — no measurable capture-path cost expected (shadow-verifiable via Exp 1's
log if promoted).

**Risks.** Privacy optics: even modifier-only key events require an explicit TD
sign-off and, if productized, visible user consent. Cross-window cursor data is the
actually valuable payload for auto-zoom and is NOT obtainable in the general case
today — the experiment's value is the substrate + own-tab signals, stated plainly.

**Recommendation.** **Keep.** Cheap option on the future. Promote only as a
`data-event` fact stream inside the Session Log (Exp 1) rather than as a separate
subsystem.

---

## Experiment 7 — Scene / Time architecture

**Purpose.** Two structural upgrades proven compatible with the current system:
(a) **TimeMap** — the piecewise-linear monotone output→source algebra of which the
entire EditState model is provably the single-segment special case; (b) **Scene
Document** — one serializable description of frame composition, extracting the
layout semantics that currently exist twice (canvas compositor + DOM preview,
hand-synchronized per decision #11).

**Architecture.**
- `timemap/timemap.ts` (pure) — segments, `sourceAt` (binary search), `compose`,
  `invert`, `ripple`, `cutRanges` (the multi-cut/tighten primitive), and
  `channelTimeMap()` compiling (Recording, EditState, channel) → TimeMap.
- `scene/scene.ts` (pure) — `SceneFrame`/`ScenePlacement` in normalized
  coordinates; `sceneAt()` implementing exactly today's rules (contain screen,
  24 %-width PiP with 24 px margin/16 px radius, cover camera, waveform fallback,
  decision-#11 slot stability via `isCameraFull`); geometry cross-checked against
  `layout.ts` constants at 1080p.

**Implementation status.** Complete and the branch's strongest evidence:
- **Equivalence theorem, tested:** `channelTimeMap` ≡ production
  `channelSourceTimeAt` at 1 ms granularity across trims/offsets/disabled/edge
  cases (property-style sweep). The "EditState is a special case" claim is now a
  passing test, not rhetoric.
- Algebra laws unit-tested (composition rates, inversion roundtrip, ripple, cuts).
- Scene rules unit-tested including the decision-#11 no-slot-jump case.
  15 tests total. Both modules are consumed by Experiments 6 and 8 — the
  cross-experiment reuse is itself the design validation.

**Measurements.** n/a (pure math) — the test suite is the measurement.

**Risks.** Abstraction tax if adopted beyond need; audio at cut boundaries needs
micro-crossfades (known DSP detail, out of scope here); DOM preview seek density
across many cuts needs coalescing. Adoption is a rendering-path migration — a
separate, later PR per renderer with oracle verification.

**Recommendation.** **Merge the modules as-is** (pure, dead until imported, zero
risk) and treat them as the reference semantics. First consumer suggestion:
re-implement the compositor's `activeOutputWindowMs` on `channelTimeMap` under the
oracle's watch.

---

## Experiment 8 — Semantic layer (research prototype)

**Purpose.** Establish whether recordings can become searchable artifacts —
contract and plumbing only, no product features, no models shipped (PM has ruled
it out as an MVP target; this keeps the research cheap and dormant).

**Architecture.** `semantic/artifact.ts`
- `TranscriptArtifact` sidecar: words timestamped in **channel-local time** of the
  source audio channel — one time model for text and media, so offsets/trims/global
  windows apply to words with zero new rules (reuses TimeMap).
- `Transcriber` = a one-method interface; `fakeTranscriber()` provides a
  deterministic engine so every downstream property is exactly testable without a
  model. Real engine candidates (whisper-class via WebGPU, ~40–250 MB fetched
  lazily, never in the bundle) are an implementation of the same interface —
  evaluation deliberately deferred.
- `searchTranscript()` returns OUTPUT-time hits under the current edit
  (trimmed-away words drop out naturally — tested); `silenceGaps()` sketches the
  tighten-pass input, which would feed `cutRanges()` from Experiment 7.

**Implementation status.** Contract + plumbing complete and unit-tested (5 tests).
No ASR engine on the branch, by design.

**Measurements.** Plumbing correctness via tests. Engine metrics (WER, realtime
factor, memory) belong to a future engine-evaluation experiment and are explicitly
out of scope.

**Risks.** None on-branch (pure, dormant). The real risks (model size, WebGPU
availability, battery) attach to the engine evaluation, not to this contract.

**Recommendation.** **Keep dormant.** The artifact contract costs nothing and
ensures that when/if PM re-opens the topic, the time-model decisions are already
made correctly (channel-local timestamps), which is the mistake-prone part.

---

## Suggested review order

1. **Exp 7** (pure, proves the branch's discipline: equivalence tests vs production)
2. **Exp 2** (the instrument; then run it and keep the baseline numbers)
3. **Exp 3** (durability A/B — likely the most consequential finding)
4. **Exp 1** (the substrate decision)
5. **Exp 5 → 4 → 6 → 8** (pipeline economics, capture future, options)

## Cross-experiment dependency map

```
Oracle (2) ──verifies──► Streaming export (5), WebCodecs capture (4), any compositor change (7)
Session Log (1) ──subsumes──► journal (3), data-event stream (6), provenance (future)
TimeMap (7) ──powers──► datachan alignment (6), semantic search (8), tighten/multi-cut (future)
Durable writer (3) ──pairs with──► fragmented MP4 capture (4)
```
