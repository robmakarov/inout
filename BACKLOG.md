# Backlog

Dump anything, anytime, top of Inbox. One line is enough; add repro/device only if you have it.
PM owns the project lane; TD owns the technical lane. PM triages Inbox and assigns it to one lane.
TD tags technical defects by severity. Done items get deleted, not archived.

## Inbox

- (dump here)

## Technical / code — TD + experimental engineer

### Now

- [P2] Oracle returns ALL-NULL metrics (and exit 0!) under machine contention (parallel EE oracle runs + preview server) — instrument must retry or fail loudly with a reason, never emit null-as-result; pre-push gate blocked a docs-only push on it. EE: harden as part of task 3 gate work.

- [P1] PO QA 2026-07-15 evening ran against the SHARED DEV SERVER while EE's 20-run headless oracle matrix hammered it — slow load / unresponsive modal / "waiting to connect" / mic-timeout likely environment artifacts. RETEST on clean prod build (TD serves main at localhost:4173). Rule going forward: PO QA only on a dedicated prod-build port; EE load tests spawn their own ephemeral server, never 5173.
- [P1] Camera light at app load (PO report, pre-any-click?) — if reproduced on the clean 4173 build this violates 'no idle device access, ever'. Note: light DURING the screen picker (after record click) is the approved concurrent-acquisition design; need PO to distinguish which they saw.
- [P2] Silent channel loss: mic acquisition timed out and the take completed with no mic and no unmissable warning — user discovered it only on playback. Needs loud post-record surface ('Mic missing from this take') + arming-timeout telemetry.
- [P1] Fix tab/browser music recording quality — TD root-caused and shipped a 3-part fix (2026-07-15): tanh waveshaping distorted ALL rendered audio (now identity below 0.95 knee); composite hard limiter (−6dB/20:1) pumped music (now bypassed for single source, gentler −3dB/12:1 safety net for multi); unreported channelCount defaulted to mono downmix (now stereo). Awaiting PO listen test on real tab music to close.

### Next

- [P2] WebCodecs video capture spike/implementation: remove the known ±45 ms video-epoch sync jitter, enable smart cuts, and replace composite v1 without breaking instant export. (EE task 3, in progress)
- [P2] Add the composite blob to crash-salvage manifests.
- [P3] Code-split the 748 KB bundle; do not trade instant start for a theoretical bundle gain.

### Later — deliberately inactive

- [P3] Distributed multi-device capture: run the gated two-device sync spike with kill criteria before product work. One authoritative mic/scene; no sub-ms mixing claim.
- [P3] Server-side auth-user deletion hook (the client already deletes user-owned objects/rows).
- [P3] Image/screenshot capture channel.

## Project / PM — PO + PM

### Now

- [P2] Oracle returns ALL-NULL metrics (and exit 0!) under machine contention (parallel EE oracle runs + preview server) — instrument must retry or fail loudly with a reason, never emit null-as-result; pre-push gate blocked a docs-only push on it. EE: harden as part of task 3 gate work.

- [P1] Provision Supabase + Google OAuth, then verify login → upload → signed-link view in a second browser. Required before public cloud sharing; local download already works.
- [P2] Daily real use: collect only concrete friction/defects. PM turns evidence into a bounded decision; PO decides any resulting UX change.

### Launch — after the technical Now list and cloud test are clear

- [P1] Domain and product email.
- [P1] Public deploy.
- [P2] PO UX pass from observed friction.
- [P1] Invite first users and establish a feedback channel.

### Later — approved, but intentionally inactive

- [P3] Instant link mode: opt-in progressive raw upload and cloud assembly. Depends on durable chunk boundaries, sync work, real QA, and a cloud-compose decision; OFF by default with explicit privacy copy.

## Bugs

<!-- TD moves confirmed defects here when triaged; format: - [P1|P2|P3] description — repro/context -->

- [P1] PO 2026-07-23: (a) Chrome capture "stops after a while", (b) recorded audio not synced with video, (c) "still some noises". TD shipped same day: screen wake lock while recording + OPFS persist + mid-take storage/encoder death now surfaces loudly and keeps the partial take (was: silent truncation — the take "stopped" with no signal); editor preview re-clocked — hidden-tab-proof master clock + playbackRate slewing (was: rAF clock froze in hidden tab while audio played on → frozen video, audio seconds ahead; ±120ms seek deadband allowed ~240ms A/V gap even when visible; verified sub-10ms after fix); loudness makeup now noise-floor-bounded (boost cannot lift room hiss past −40 dBFS — the +18 dB rescue amplified hiss). AWAITING PO recheck on real takes; if (a) still reproduces during capture (not playback), collect console log + take length vs file length.
- [P1] PO 2026-08-06: recorded in Chrome, switched to another tab with a game — "nothing was recorded, just frozen frame". TD shipped same day: (1) a dead/frozen video source no longer poisons the take silently — SourceLiveness watches each source's media clock off the composite's AudioWorklet tick (hidden-tab-proof) and 3s with no frame emits channel-stalled, marks the composite unusable (unedited export renders from the raw channels instead of copying still frames) and records Recording.stalled; (2) a video track ENDING mid-take now invalidates the composite too — previously the dead track kept readyState 2 so the composite repainted its last frame for the rest of the take and instant export copied it; (3) sticky red banner while a source is frozen (a toast is invisible — the user is in another tab when it happens); (4) getDisplayMedia now hints displaySurface:'monitor' so the picker opens on Entire Screen, and picking a single tab/window raises a notice that other tabs/apps will not appear. MEASURED in real Chrome 150/macOS 26: in a hidden tab the AudioWorklet tick, canvas.captureStream, <video>→drawImage and MediaRecorder all keep running at full rate (rAF goes to 0) — the composite pipeline itself does NOT freeze, so the frozen frame comes from the SOURCE. NEEDS PO: which surface did you share — whole screen, one window, or one Chrome tab? That decides whether (4) alone closes this.
- [P2] Fidelity oracle red on TD machine under load: uniform tone-level drop 1.1–2.3 dB varying run-to-run (signature of contention-starved capture, same family as the ALL-NULL P2 above). Pre-existing before 2026-07-23 changes (clean tree measured worse). Do not treat as mix-path regression without a quiet-machine run.

## Ideas

<!-- anything not a defect: UX, features, polish -->
