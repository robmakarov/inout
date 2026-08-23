# Backlog

Dump anything, anytime, top of Inbox. One line is enough; add repro/device only if you have it.
PM owns the project lane; TD owns the technical lane. PM triages Inbox and assigns it to one lane.
TD tags technical defects by severity. Done items get deleted, not archived.

## Inbox

- (dump here)

## Technical / code — TD + experimental engineer

### Now

- [P2] Oracle returns ALL-NULL metrics (and exit 0!) under machine contention — instrument must retry or fail loudly, never emit null-as-result. PARTLY ADDRESSED: oracle.mjs retries and fails loud on incomplete metrics. Still open: branch ee/oracle-nullfix unmerged (TD review), and the fidelity runner has no equivalent retry — it reads RED (toneErr 1.1-2.3 dB) purely from machine load, which is capture starvation and not a mix regression. Needs the same retry/quiet-machine guard.

- [P2] Sync is ~45-63 ms audio-late, not the ~30 ms previously believed (2026-08-23: the oracle was ~31 ms optimistic — exact 18 ms detection bias + an unmeasured 13.5 ms video reference). PO can feel it. Cause understood and partly compensated; closing it is TASKS O4's job (target ≤20 ms). Not a new regression — it was always there, we were measuring it wrong.

- [P1] PO QA 2026-07-15 evening ran against the SHARED DEV SERVER while EE's 20-run headless oracle matrix hammered it — slow load / unresponsive modal / "waiting to connect" / mic-timeout likely environment artifacts. RETEST on clean prod build (TD serves main at localhost:4173). Rule going forward: PO QA only on a dedicated prod-build port; EE load tests spawn their own ephemeral server, never 5173.
- [P1] Camera light at app load (PO report, pre-any-click?) — if reproduced on the clean 4173 build this violates 'no idle device access, ever'. Note: light DURING the screen picker (after record click) is the approved concurrent-acquisition design; need PO to distinguish which they saw.
- [P2] Silent channel loss: mic acquisition timed out and the take completed with no mic and no unmissable warning — user discovered it only on playback. Needs loud post-record surface ('Mic missing from this take') + arming-timeout telemetry.
- [P1] Fix tab/browser music recording quality — TD root-caused and shipped a 3-part fix (2026-07-15): tanh waveshaping distorted ALL rendered audio (now identity below 0.95 knee); composite hard limiter (−6dB/20:1) pumped music (now bypassed for single source, gentler −3dB/12:1 safety net for multi); unreported channelCount defaulted to mono downmix (now stereo). Awaiting PO listen test on real tab music to close.

### Next

THE ROADMAP LIVES IN `.ai/TASKS` — not here. That file carries the READY map, every task with its
gates, what a fresh session must know first, and the tooling index; it is rewritten on every merge.
Duplicating it here is how the two go out of step, so this section is a pointer on purpose.
PO protocol: say "roadmap" in any session → READY map → "go <id>".

### Later — deliberately inactive

- [P3] Distributed multi-device capture: run the gated two-device sync spike with kill criteria before product work. One authoritative mic/scene; no sub-ms mixing claim. PO 2026-08-22: "we'll need it eventually" — gating unchanged.
- [P3] Cursor-excluded capture + vector cursor re-render (sharp at any zoom, click ripples) — PO "maybe someday"; P4 designs the metadata track for it, builds nothing.
- [P3] Local quality models (camera background blur, ML denoise) — PO "maybe later". Boundary (ledger 08-22(3)): no AI product features ever; local quality models allowed when revisited; deterministic DSP ships first.
- [P3] Server-side auth-user deletion hook (the client already deletes user-owned objects/rows).
- [P3] Image/screenshot capture channel.

## Project / PM — PO + PM

### Now

- [P2] Oracle returns ALL-NULL metrics (and exit 0!) under machine contention — instrument must retry or fail loudly, never emit null-as-result. PARTLY ADDRESSED: oracle.mjs retries and fails loud on incomplete metrics. Still open: branch ee/oracle-nullfix unmerged (TD review), and the fidelity runner has no equivalent retry — it reads RED (toneErr 1.1-2.3 dB) purely from machine load, which is capture starvation and not a mix regression. Needs the same retry/quiet-machine guard.

- [P2] Sync is ~45-63 ms audio-late, not the ~30 ms previously believed (2026-08-23: the oracle was ~31 ms optimistic — exact 18 ms detection bias + an unmeasured 13.5 ms video reference). PO can feel it. Cause understood and partly compensated; closing it is TASKS O4's job (target ≤20 ms). Not a new regression — it was always there, we were measuring it wrong.

- [P1] Provision Supabase + Google OAuth, then verify login → upload → signed-link view in a second browser. Required before public cloud sharing; local download already works.
- [P2] Daily real use: collect only concrete friction/defects. PM turns evidence into a bounded decision; PO decides any resulting UX change.

### Launch — after the technical Now list and cloud test are clear

- [P1] Domain and product email.
- [P1] Public deploy.
- [P2] PO UX pass from observed friction.
- [P1] Invite first users and establish a feedback channel.

### Later — approved, but intentionally inactive

- [P3] Instant link mode: opt-in progressive raw upload and cloud assembly. Depends on durable chunk boundaries, sync work, real QA, and a cloud-compose decision; OFF by default with explicit privacy copy.
- [P3] Design-later pack (PO 2026-08-22, "we will build, design later"): brand templates on F3 · link-unfurl page so shared links show a thumbnail · local library search · keyboard-first editing pass.

## Bugs

<!-- TD moves confirmed defects here when triaged; format: - [P1|P2|P3] description — repro/context -->

- [P1] PO 2026-07-23: (a) Chrome capture "stops after a while", (b) recorded audio not synced with video, (c) "still some noises". TD shipped same day: screen wake lock while recording + OPFS persist + mid-take storage/encoder death now surfaces loudly and keeps the partial take (was: silent truncation — the take "stopped" with no signal); editor preview re-clocked — hidden-tab-proof master clock + playbackRate slewing (was: rAF clock froze in hidden tab while audio played on → frozen video, audio seconds ahead; ±120ms seek deadband allowed ~240ms A/V gap even when visible; verified sub-10ms after fix); loudness makeup now noise-floor-bounded (boost cannot lift room hiss past −40 dBFS — the +18 dB rescue amplified hiss). AWAITING PO recheck on real takes; if (a) still reproduces during capture (not playback), collect console log + take length vs file length.
- [P1] PO 2026-08-06: recorded in Chrome, switched to another tab with a game — "nothing was recorded, just frozen frame". TD shipped same day: (1) a dead/frozen video source no longer poisons the take silently — SourceLiveness watches each source's media clock off the composite's AudioWorklet tick (hidden-tab-proof) and 3s with no frame emits channel-stalled, marks the composite unusable (unedited export renders from the raw channels instead of copying still frames) and records Recording.stalled; (2) a video track ENDING mid-take now invalidates the composite too — previously the dead track kept readyState 2 so the composite repainted its last frame for the rest of the take and instant export copied it; (3) sticky red banner while a source is frozen (a toast is invisible — the user is in another tab when it happens); (4) getDisplayMedia now hints displaySurface:'monitor' so the picker opens on Entire Screen, and picking a single tab/window raises a notice that other tabs/apps will not appear. MEASURED in real Chrome 150/macOS 26: in a hidden tab the AudioWorklet tick, canvas.captureStream, <video>→drawImage and MediaRecorder all keep running at full rate (rAF goes to 0) — the composite pipeline itself does NOT freeze, so the frozen frame comes from the SOURCE. SURFACE QUESTION ANSWERED by PO 2026-08-22 — one Chrome tab — see the entry below; that report is a second, independent root cause.
- [P1] PO 2026-08-22: recording another Chrome tab that renders a 4K game — "the video freezes". Different failure from 08-06 despite the same words: frames arrive in BURSTS, not never, so the 3s stall detector correctly stays quiet and nothing warns. Root cause is throughput. Nothing capped the display track, so a 4K surface was consumed four times on one GPU (Chrome capture readback of 3840×2160 + raw screen MediaRecorder at 8 Mbps ≈ 0.03 bpp + composite &lt;video&gt; decode and downscale 30×/s + on-screen preview decode) while the captured tab rendered the game on that same GPU — and every one of those pixels was thrown away at export, which is 1080p on both paths. TD shipped same day: display track constrained to the export size (CAPTURE_MAX_* tied to DEFAULT_EXPORT_SETTINGS), MAX-only so a smaller surface is never overconstrained, applied in the getDisplayMedia request and re-applied by capDisplayTrack() before the channel is delivered (before its recorder exists — a mid-file resolution change reinitialises the encoder); frameRate capped at 30 as max, not ideal, so a 60 fps game tab stops doubling the encode for frames the export drops; per-source delivered fps logged every 10s from the composite tick (console only). MEASURED (real Chrome, hidden tab, AudioWorklet rig mirroring liveComposite, 8s trials, 2 runs with order reversed, idle machine and no real game): 4K delivered 21.5 / 11.9 fps against a 30 fps target, drawImage 13.94 / 8.55 ms of a 33 ms budget, composite encoder starved to 289 / 106 KB/s; the same rig at 1080p delivered 29.8–29.9 fps, drawImage 0.97–1.04 ms, encoders 597–614 KB/s. AWAITING PO recheck on the real 4K game tab — and the console from that take should now show `[capture] display capped 3840×2160@… → 1920×1080@30` plus `[capture] screen … delivering N fps`.
- [P1] PO 2026-08-23: "at some point tab audio broke and became just lag sounds". NOT YET REPRODUCED — mechanism identified by reading, not measured. The measured-audio worklet (`measuredAudio.ts` WORKLET_SOURCE) fills every STARVED quantum with 128 frames of silence once `sawLive` is true, with a 64-sample fade on each edge. That is correct by design (timestamps are sample-counted, so skipping a quantum splices the timeline — ledger 2026-08-23 F-keystone bug 2 measured a −33 dB spur from exactly that), and chopped live→silence→live audio is precisely what "lag sounds" sounds like. THE DEFECT IS THAT IT IS INVISIBLE: nothing counts starved quanta, nothing logs them, no event is emitted, and `Recording.stalled` never mentions audio. SourceLiveness watches the VIDEO media clock only (`liveComposite*.ts` feeds it per video source) — an audio source can starve or go permanently silent for the rest of a take and the UI stays green. First move is a number, not a fix: count `q.data === null` quanta in the worklet, report per batch, log a rate per channel every 10 s alongside the existing `[capture] <kind> delivering N fps`. Then decide whether audio gets its own stalled/resumed edge + the sticky banner the video path already has.
- [P1] PO 2026-08-23: "stopped some input mid record, but in the editor timeline they are full length". Timeline rendering is NOT the bug — `Timeline.tsx` draws each bar at `x(ch.startOffsetMs)`/`x(ch.durationMs)` from the channel's own numbers, and a VIDEO track that ends mid-take gets `durationMs = performance.now() - startAbs` stamped at the `ended` event, so a stopped screen share already draws SHORT. Two candidate causes, both audio, both producing a genuinely full-length channel: (a) BY DESIGN — the in-record channel chips do not stop an input, they live-MUTE it (`ChannelChips.tsx` locks video chips while recording; `session.setAudioEnabled` sets `track.enabled = false`), so the channel keeps recording real-time SILENCE to the end and a full-length bar is arithmetically correct. There is no way to end an input mid-take, and nothing in the editor marks the muted region — so the take looks intact and plays half-dead. (b) the starvation path in the P1 above: a tab-audio source that dies without its track firing `ended` is silence-filled to the end of the take, same full-length bar. NEEDS FROM PO: which input, and stopped HOW — the app's chip, or the browser's own "Stop sharing" bar. That one answer separates (a) from (b).
- [P2] No local disk guard on capture, exposed by removing the 30-min cap (2026-08-23). Capture streams every channel to OPFS as it records, so length costs disk and not RAM — but nothing checks `navigator.storage.estimate()` before or during a take. A write failure is at least loud (`session.ts` ondataavailable → channel-error + onTrackEnded, partial take kept), so this is degradation and not silent loss; still, an uncapped take should warn on low headroom before it starts and while it runs, and the ~1.1 GB/hour at the production 8 Mbps + 128 kbps is a number the UI can show.
- [P2] Fidelity oracle red on TD machine under load: uniform tone-level drop 1.1–2.3 dB varying run-to-run (signature of contention-starved capture, same family as the ALL-NULL P2 above). Pre-existing before 2026-07-23 changes (clean tree measured worse). Do not treat as mix-path regression without a quiet-machine run.

## Ideas

<!-- anything not a defect: UX, features, polish -->
