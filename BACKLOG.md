# Backlog

Dump anything, anytime, top of Inbox. One line is enough; add repro/device only if you have it.
PM owns the project lane; TD owns the technical lane. PM triages Inbox and assigns it to one lane.
TD tags technical defects by severity. Done items get deleted, not archived.

## Inbox

- (dump here)

## Technical / code — TD + experimental engineer

### Now

- [P0] TD 2026-08-25: SAFARI MIC — promoted to roadmap task .ai/TASKS P8 (PO 2026-08-25 "put
  safari bug in roadmap"). One line of truth: a real Safari take carries only a couple of
  seconds of mic sound; the task is BLOCKED on one PO artifact (the exported file, or a
  Safari-console take) and must not be coded from theory. Full spec, candidate causes and
  gates live in the task.

- [P1] TD 2026-08-25 (was P0; downgraded same day on PO's stress-test pass "seems to be allright
  now"): THE SCREEN WEDGE — MITIGATED, CAUSE STILL CHROME'S. getDisplayMedia never settles after
  the user picks; only ⌘Q reliably clears the browser-process claim. Shipped stack: bounded ≤30 s,
  devices released, request serializer (displayRelease.ts), persistent device connect, one
  automatic refresh + ⌘Q escalation, safe-mode ladder. If it recurs: quote the canonical
  formulation at the top of docs/SCREEN_WEDGE.md and run its evidence kit. Strongest unbuilt
  lever: TASKS O12 persistent-share (PO-gated, deferred).
  RECURRED 2026-08-25 in ONE ordering, two new facts in the case file: (a) a 4K game already
  running when record is pressed wedges; restart Chrome, share FIRST, then start the game — no
  wedge. Load at picker time is a trigger by itself, and the safe ordering is exactly what O12
  makes permanent. (b) IN THAT WEDGE THE REFRESH RITUAL DID NOT DELIVER — app unresponsive, no
  visible auto-reload, no ⌘Q message. That half is OURS and is its own P1 below.

- [P1] PO 2026-08-25: THE WEDGE RECOVERY ITSELF FAILED under game load — after the wedge the app
  "dont reloads normally, gets unresponsive, no message about that i need to reload chrome". The
  shipped contract (wedgeReload.ts: one automatic reload → "press record to try again"; second
  wedge within 2 min → ⌘Q text) delivered NEITHER. Candidate causes, unproven: the renderer is
  janked by the same GPU load so the reload/message never paints; or the failure path under load
  never classifies as `wedged` (e.g. arming dies somewhere else first) so wedgeReload is never
  asked. EVIDENCE BEFORE CODE: the `[capture:arming]` console timeline from a repro with the game
  running, and whether the sharing pill lit. Do not harden the ritual from theory.

- [P1] PO 2026-08-25, NEW DEFECT IN A REGIME NOBODY HAS MEASURED: on the game take (record started
  first, 4K game running beside it — the ordering that doesn't wedge) the sound comes apart
  PROGRESSIVELY: in sync for ~20 s, then audio runs AHEAD of video ("sounds go faster"), then
  "wrong speed", plus a lot of noises. This is NOT the known constant 45-63 ms offset, and it is
  not covered by "drift is dead" — that verdict (beta−1 = −0.003 ms/s) was measured on an IDLE
  machine; this take ran starved beside a 4K game, the regime where the fidelity oracle already
  goes red from capture starvation. No sync number in this project has ever been taken under load
  (oracle:load stresses the TAIL only). Candidate mechanism, UNPROVEN: starved audio capture loses
  quanta; if lost quanta are dropped rather than silence-filled, the audio timeline COMPRESSES and
  audio lands progressively early — exactly "goes faster" — and the starvation glitches are the
  noises. The v2 worker audio path under load has never been measured; also unknown whether the
  <12 fps watchdog refused the composite (that flips the export from packet copy to render, two
  different audio paths). EVIDENCE BEFORE CODE: (1) PO — was this the exported MP4 or the in-app
  preview player? (2) the console from such a take: `[capture] display capped …`,
  `[capture] … delivering N fps`, any watchdog/stall lines, engine v1/v2; (3) the file itself.
  Rig gap: a sync oracle cell under synthetic GPU load does not exist and is the instrument this
  needs.

- [P1] TD 2026-08-25: NOTHING HERE HAS EVER BEEN MEASURED ON A TAKE LONGER THAN 30 s, and PO records
  938-1800 s. `runOracle` defaults to 6000 ms and the matrix's widest cell is 30 s, so every sync,
  drift and throughput number this project quotes describes a take up to 156× shorter than the one PO
  complained about. Measured at 120 s on a /tmp mirror of the shipped build (a second live session was
  editing this worktree; its saves reload the harness page through HMR and killed two earlier runs):
    render path   symmetric 34.5 ms mean / 46.8 max, and FLAT — all 119 flash/click pairs returned
                  the SAME offset across the two minutes
    instant path  67.3 / 96.4 ms after 89e250e — it read 117.2 / 153.8 at the SAME length before that
                  fix, against 97-102 at 6 s, i.e. the defect grew with length and the 6 s gate
                  under-reported it by ~20 %
    smart cut     the trimmed export took smartcut at 1384 ms against the render's 17616 on the same
                  take — 12.7×
    drift         beta−1 = −0.003 ms/s → 2.8 ms across PO's whole 938 s take
  So DRIFT IS DEAD as an explanation for what PO hears: whatever is off is a CONSTANT offset.
  ACTION: one ≥120 s cell before any flip that touches the packet-copy paths — a 6 s gate passed the
  instant path's own defect while it was 20 % worse at PO's scale.

- [P1] TD 2026-08-25: THE TWO ALIGNMENT ERRORS A SYNTHETIC RIG CANNOT SEE, both pushing audio LATE.
  (1) the mic anchor subtracts only the platform-REPORTED track latency (measuredAudio.ts) — a
  Bluetooth headset's real 100-300 ms is invisible to it, and PO's 15-minute Zoom take is exactly that
  case. (2) the video channel is anchored to the `recorder.start()` CALL (session.ts:588), not to when
  its first frame landed: a canvas delivers instantly on the rig, a real getDisplayMedia surface does
  not — the composite's own first frame took 233 ms in the same run. Neither is measurable without
  instrumenting a REAL take. Next step is to put the alignment inputs into the file's certification
  (each channel's startOffsetMs, the raw anchor, the reported input latency, the first-frame delay) so
  the next field report arrives with numbers instead of an adjective.

- [P2] TD 2026-08-25, ONE OBSERVATION, NOT REPRODUCED: the audio-integrity spur gate read −34.6 dB
  against its −40 dB band on a 120 s run of HEAD (7c9a02f). The same build at 6 s read −52.3 (pass)
  and the previous build at 120 s read −56.7 (pass), so this is either machine load — the metric is
  known load-sensitive — or something length-dependent in the mix. Re-run 120 s on a quiet machine
  before believing either.

- [P2] Oracle returns ALL-NULL metrics (and exit 0!) under machine contention — instrument must retry or fail loudly, never emit null-as-result. PARTLY ADDRESSED: oracle.mjs retries and fails loud on incomplete metrics. Still open: branch ee/oracle-nullfix unmerged (TD review), and the fidelity runner has no equivalent retry — it reads RED (toneErr 1.1-2.3 dB) purely from machine load, which is capture starvation and not a mix regression. Needs the same retry/quiet-machine guard.

- [P2] Sync is ~45-63 ms audio-late, not the ~30 ms previously believed (2026-08-23: the oracle was ~31 ms optimistic — exact 18 ms detection bias + an unmeasured 13.5 ms video reference). PO can feel it — re-confirmed 2026-08-24 on a real tab-music take (YouTube music video), which matches the measured offset; no new fault implied. Cause understood and partly compensated. 2026-08-24: the v2 engine is now the DEFAULT and reads 33-48 ms on the oracle against v1's ~60 — users get the better number today; closing the rest to ≤20 ms is anchor work (input latency both engines share), tracked as O4-polish. Awaiting PO listen test on a real take.

- [P2] PO 2026-08-24: files too large for the quality on motion-heavy takes (YouTube music video).
  Structural to the v1 engine, not a regression: an unedited export packet-copies the live composite,
  whose MediaRecorder runs at a flat 8 Mbps ceiling with generic tuning — on motion the ceiling binds
  (~60 MB/min) and quality-per-bit is whatever MediaRecorder gives, no knobs. The shipped size levers
  do not touch motion (O11b GOP stretch: −23.8 % screen, −0.3 % motion; O11c is the camera PiP only).
  Lowering the ceiling was measured and rejected as a size step (F7b — it is a quality lever, O9's).
  What moves it: O4 owned encoder + rate control — SHIPPED 2026-08-24 (v2 is the default engine:
  frame-driven draw means static spans now cost ~1 fps of bytes; motion still rides the 8 Mbps
  ceiling) — then O5/O9 quality-per-bit, and O11d codec ladder (25-40 %, blocked on P1's Playwright
  install; default file stays avc for blind shares, so the rung flips only where the recipient is
  known). PO RE-JUDGED 2026-08-25: 300 MB / 5 min on a 4K game take — 60 MB/min, the 8 Mbps ceiling
  EXACTLY, so the ceiling still binds on motion as described (v2 helps static spans only) and this
  is the expected size of the current build, not a regression. Levers unchanged: O9 quality-per-bit,
  O11d codec ladder, X13 (PO-gated). while EE's 20-run headless oracle matrix hammered it — slow load / unresponsive modal / "waiting to connect" / mic-timeout likely environment artifacts. RETEST on clean prod build (TD serves main at localhost:4173). Rule going forward: PO QA only on a dedicated prod-build port; EE load tests spawn their own ephemeral server, never 5173.
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

- [P2] Sync is ~45-63 ms audio-late, not the ~30 ms previously believed (2026-08-23: the oracle was ~31 ms optimistic — exact 18 ms detection bias + an unmeasured 13.5 ms video reference). PO can feel it — re-confirmed 2026-08-24 on a real tab-music take (YouTube music video), which matches the measured offset; no new fault implied. Cause understood and partly compensated. 2026-08-24: the v2 engine is now the DEFAULT and reads 33-48 ms on the oracle against v1's ~60 — users get the better number today; closing the rest to ≤20 ms is anchor work (input latency both engines share), tracked as O4-polish. Awaiting PO listen test on a real take.

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
- [P1] PO 2026-08-22: recording another Chrome tab that renders a 4K game — "the video freezes". Different failure from 08-06 despite the same words: frames arrive in BURSTS, not never, so the 3s stall detector correctly stays quiet and nothing warns. Root cause is throughput. Nothing capped the display track, so a 4K surface was consumed four times on one GPU (Chrome capture readback of 3840×2160 + raw screen MediaRecorder at 8 Mbps ≈ 0.03 bpp + composite &lt;video&gt; decode and downscale 30×/s + on-screen preview decode) while the captured tab rendered the game on that same GPU — and every one of those pixels was thrown away at export, which is 1080p on both paths. TD shipped same day: display track constrained to the export size (CAPTURE_MAX_* tied to DEFAULT_EXPORT_SETTINGS), MAX-only so a smaller surface is never overconstrained, applied in the getDisplayMedia request and re-applied by capDisplayTrack() before the channel is delivered (before its recorder exists — a mid-file resolution change reinitialises the encoder); frameRate capped at 30 as max, not ideal, so a 60 fps game tab stops doubling the encode for frames the export drops; per-source delivered fps logged every 10s from the composite tick (console only). MEASURED (real Chrome, hidden tab, AudioWorklet rig mirroring liveComposite, 8s trials, 2 runs with order reversed, idle machine and no real game): 4K delivered 21.5 / 11.9 fps against a 30 fps target, drawImage 13.94 / 8.55 ms of a 33 ms budget, composite encoder starved to 289 / 106 KB/s; the same rig at 1080p delivered 29.8–29.9 fps, drawImage 0.97–1.04 ms, encoders 597–614 KB/s. PO RECHECK 2026-08-25 PARTIAL: the game take now RECORDS — no frozen-frame complaint; the failure moved to AUDIO (progressive desync + noises under the same load, its own P1 in Now) and to a game-first WEDGE ordering (case file). The console lines (`[capture] display capped 3840×2160@… → 1920×1080@30`, `[capture] screen … delivering N fps`) are still unseen from a real game take.
- [~~P1~~ FIXED 2026-08-23] PO: "sound broke into lag sounds" + "sound was not loud, same as before" — ONE cause, both symptoms. Measured on the delivered export: the makeup gain was PEAK-BOUND (p20 floor 0.0062 vs a 0.01 ceiling so the floor bound was slack; p90 reached 0.1063, 1.4 dB short of the 0.125 target, so the target bound was not reached) — one sharp transient set `peak`, capped the gain for the WHOLE take, and was itself destroyed by the limiter. The limiter's tanh fold went numerically dead at an input of 1.152 while the gain bound licensed peaks to 1.9, so a 1.66:1 range of the loudest content collapsed onto one 16-bit code: 217 full-scale ~0.25 ms impulses from t=12.5s, which is the crackle. FIXED by (1) an algebraic u/(1+u) fold — same f(0)=0, f'(0)=1 C1 knee and f(inf)=1 ceiling as tanh, but polynomial approach, resolved to LIMIT_USABLE_MAX ~= 82, and bit-identical below the knee; (2) NORMALIZE_PEAK_OVERDRIVE 2 -> 4, which the old curve could not have carried. Old vs new on the take's back-solved numbers: gain 3.06 peak-bound / p90 -19.47 dBFS / transient rendered as 32768 x5 + 31130 (2 distinct values of 6) BECOMES gain 3.60 target-bound / p90 -18.06 dBFS on target / 6 distinct values, none pinned. Gates: 260 tests, fidelity oracle PASS (toneErr 0.02 dB, limiterHits 0), sync oracle PASS. STILL OPEN and deliberately not claimed as fixed: general loudness. That take's MEDIAN window RMS is 18 dB below its p90, so most of it sits far below the level being normalized — closing that needs real dynamic-range compression, which is a separate PO decision.
- [~~P1~~ FIXED 2026-08-23] "stopped some input mid record, but in the editor timeline they are full length" + "why i cant turn off screen and camera mid session" + "must not be muted but stopped, but resumable after, any input". Was: the chips live-MUTED audio (`track.enabled = false` — device still open, camera light still on, channel still recording real-time silence at full length) and locked video entirely. Now `CaptureSession.setChannelActive(kind, active)`: off releases the device and closes that channel's file at that instant; on re-acquires and late-joins a NEW segment with its own startOffsetMs, so the off stretch is a real hole on the timeline. Any input, including one never armed for the take. `setAudioEnabled` is kept in the contract but the default UI no longer calls it.
- [P2] No local disk guard on capture, exposed by removing the 30-min cap (2026-08-23). Capture streams every channel to OPFS as it records, so length costs disk and not RAM — but nothing checks `navigator.storage.estimate()` before or during a take. A write failure is at least loud (`session.ts` ondataavailable → channel-error + onTrackEnded, partial take kept), so this is degradation and not silent loss; still, an uncapped take should warn on low headroom before it starts and while it runs, and the ~1.1 GB/hour at the production 8 Mbps + 128 kbps is a number the UI can show.
- [P2] Fidelity oracle red on TD machine under load: uniform tone-level drop 1.1–2.3 dB varying run-to-run (signature of contention-starved capture, same family as the ALL-NULL P2 above). Pre-existing before 2026-07-23 changes (clean tree measured worse). Do not treat as mix-path regression without a quiet-machine run.

## Ideas

<!-- anything not a defect: UX, features, polish -->
