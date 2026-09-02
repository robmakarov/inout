# BACKLOG — bugs, evidence, ideas. For agents. The roadmap lives in `.ai/TASKS`; done items are deleted on sight.
Dump anything at the top of Inbox. Whoever picks it up triages it (lane, severity) or promotes it to a task id and leaves a one-line pointer here.

## Inbox
- (dump here)

## Open technical evidence (→ task id where one exists)
- [P1 → B11] smart cut refuses a 120 s trim on `Timestamps must be non-negative (got -0.0003333333333337407s)` = −1/3000 s in `outAt()` (smartCut.ts:456), one cold run in five; the user silently gets a full render.
- [P1 → B12] under a starved main thread (synthetic 2560x1440@60, three encoders, 354.8 Mpx/s) BOTH measured-audio channels ended tens of seconds early on a CLEAN stop; only the report card noticed.
- [P0 → W2] the screen wedge: rung 3 (bare request) wedged three in a row 2026-09-02; page has no move left; Robert's levers and the second-origin test in docs/SCREEN_WEDGE.md.
- [P1 → B1b] the size probe over-prices still text 1.50× (was 3.02×); the model is 7.96× LOW on motion so it is no fallback.
- [P2 → B10] the size probe encodes 300 frames on the main thread ~11 s after the editor opens; drag stalls 35-201 ms land inside that window.
- [P1/P2 → G6] instrument flakes: v1 export-throughput coin flip (0.46-0.94× loaded, 0.51-0.82× once idle) · fidelity render lane red under load (8.69 dB, THD −56.8) · spur gate moves 25 dB with load (−35 vs −50/−60) · 120 s cell dies on CDP ~1/3 · `?slow=` is dead code (parseSlowChannels has no caller) · the 720p camera PiP wrote MORE bytes than the 3024x1964 screen on rec_78ogcw052vdn (camera 900 MB at 2.49 Mbps, screen 814 MB at 2.25 of 8 requested) — starved encoder or honest still content?
- [P2] Robert 2026-08-29 "at some points video got slows down and lag too" on a long take — UNDIAGNOSED; pin the stage first: capture (CompositorStats.framesDropped / maxEncodeGapMs / peakQueue are in the take), preview playback, or the file.
- [P2 → SIZE-CODEC] files too large for the quality on motion-heavy takes: an unedited export packet-copies the composite's realtime encode at a flat ceiling; the levers are the codec lane and idea 11.
- [P1 → SIZE-CODEC/O9] coloured text loses ~30 % of its colour, all at capture (source arrives NV12: ≈20 % Chrome's, ≈10 % ours); Robert 2026-08-29: "I WANT 100% COLORS". Single generation recovers to 80 % green at no cost; 4:4:4 AV1 keeps 99.3 %, software only.
- [P2 → X14] sync reads 40-66 ms audio-late on the oracle; Robert can feel it; target is 0 (ruling 2026-09-02). Levers: idea 4 (capture stamps, echo ruler).
- [P2] the oracle's arrival probes stamp `performance.now()` at READ, not the frame's own timestamp — the 6.5 ms per-run term G5 left; record both stampings (small rig change).
- [P2] the MediaRecorder fallback is not a fallback for a frame the platform's AVC refuses (both paths ask the same encoder); wanted: a rung that changes the ASK (even the size, drop the level, accept VP9).
- [P2] `setChannelActive(kind, false)` stops through onTrackEnded without draining → a switched-off channel loses 200-1300 ms under load; needs async onTrackEnded (throttle, drain, stop); own session.
- [P1 → O6] the 4K game tab: keep-alive/cap fixes shipped, "not all the time" remains; Robert's re-verify with native res is the only instrument (a synthetic 4K source paints at ~209 Mpx/s).
- [P1] wedge recovery under game load: the boot notice is fixed (sticky banner, owed-flag); whether the reload itself ran under load is unproven — needs the arming timeline from a repro.
- [P1] camera light at app load (Robert, once, unreproduced) — if real it violates "no idle device access, ever"; the light DURING the picker is the approved concurrent arm.
- [Robert] July/August field reports (07-23 stops/desync/noises · 08-06 frozen frame · 08-22 4K freeze · 08-25/26 desync, audio quality, tab audio dying) each had fixes shipped; his recheck on the current build is what closes them; A1's long take covers the audio half.
- [P2] a starved take's padded silence can land in the fidelity oracle's fixed 2.5 s window (a consequence of the wall-clock hold, not a regression) → G6(b)'s guard.
- [P2] the audio-only size fallback is 8 Mbps × duration labelled rough; do not invent a constant.

## UI asked for, on the UI, not wired → tasks
F19 continue from the playhead (button says "roadmap") · F20 the timeline closing over a cut · "Show in folder" cannot exist on the web (it explains the Downloads folder instead) · Send / Copy link on take cards blank by ruling 2026-08-30 · pause/resume → U2 · device picker → U5.

## Later — approved shapes, deliberately inactive
- Two devices, one take (phase 5; DECISIONS 2026-09-02 (3)/(4)): one account pairs paid users, p2p/manual pairing for free (v2, "not only QR"); a monitor stream each way over a direct WebRTC link (relay only as a paid fallback); each side records locally at full quality; fragments ship on J1's journal; the remote camera is a PiP input to the live compositor; clock = pings + room-audio correlation with drift fit; the take certifies its own sync bound; the inviter moderates; users may let another user save their recording into that user's cloud. Streaming out = the same link to a WHIP ingest.
- Cursor-excluded capture + vector cursor re-render, click ripples, auto-zoom (P4's metadata track).
- Local quality models, zero tokens, per instance (camera background blur; denoise = F10).
- Server-side auth-user deletion hook (client already deletes user-owned rows/objects).
- Image/screenshot capture channel.
- Instant link mode (progressive upload + cloud assembly; OFF by default, consent copy) — rides J1's journal.
- Design-later pack: brand templates on F3 · link-unfurl page · library search · keyboard-first editing.
- Pre-cut capture (keyframes at speech onsets; Robert "idk, later") — superseded by idea 3, which costs no capture bytes.

## Project
Phase 2 (TASKS): provision Supabase + Google OAuth and prove login → upload → link in a second browser · domain + product email · public deploy · first users + feedback channel. Robert records daily; friction becomes bounded decisions, UX changes are his.

## Ideas — the 45 of 2026-09-02, for a SEPARATE session (Robert: "keep it to consider later")
Verdicts so far: 1 = "try it but skeptical" (the For-AI keyframe picker dropped frames whose only change
was small — cursor, text fields — so change detection must be designed WITH the export-for-AI problem);
everything else = later, not rejected. Tag UX = user sees/hears a change → Robert's yes; eng = invisible.
1 screen-is-not-a-video: lossless changed-tile master for work screens; perfect text, far smaller, frees the screen encoder; hybrid with the encoder for motion · UX · heavy · measure on Robert's real screen first
2 self-manifesting media files: each file carries take id + role in its metadata; recovery scans OPFS, no manifest to lose · eng · light
3 speculative seams: pre-encode smart cut's [cut→next keyframe] pieces at silence edges in idle time → edited exports are copies · eng · light-medium
4 self-measured lip-sync: (a) anchor from VideoFrame.metadata().captureTime / AudioData.timestamp instead of read-time performance.now() (measuredVideo.ts:222); (b) speaker-echo of tab audio in the mic as the mic-latency ruler (cross-correlation) · eng · light + light-medium
5 audio never on the main thread: transfer the track processor's ReadableStream into the raw worker · eng · light (tapstarve rig = gate)
6 constant-quality capture: quantizer mode + the export's governor on the raw screen encoder · UX (file sizes) · medium
7 cloud player composites screen+camera from two packet copies + the camera track as data → instant max+camera SHARE · UX · medium
8 idle consolidation: re-encode raw channels at export QP once the export exists; extends disk hours · UX (what is kept) · medium
9 record the export: at max, composite at native size + tiny stream of the patch under the PiP + camera raw → unedited max+camera export = copy · UX · heavy · only after A1's long take holds (load family)
10 record the page not the pixels: DOM/description stream for web content, pixels only for canvas/video/iframes · UX new mode, needs extension or snippet (AI2's vehicle) · heavy
11 name the size: two-pass export to an exact target size, our rate control through the quantizer, whole-take lookahead · UX new control · medium-heavy
12 the player is the editor: cloud player = editor preview code; upload raw + edit → any edit shares instantly, MP4 renders behind · UX · heavy · upload bigger than the file
13 every take at 60: scroll-aware frame interpolation for takes recorded below 60, local model for camera, opt-in at export · UX option · medium-heavy
14 continue after a crash: recovery + R-CONT continue = one take · UX control · medium-heavy
15 zoom proposals from pixel change (AI1's delta detector), like Tighten · UX proposals · medium
16 atlas of changed rectangles through the hardware encoder (lossy sibling of 1) · eng · heavy · same measurement day as 1
17 native core at maximum: Swift core on macOS (ScreenCaptureKit, VideoToolbox, Metal), Rust on Windows/Linux, same types.ts contract · UX native app · heavy (= P4 re-spec)
18 installed core serves the browser: PWA gains native capture when the core is installed · UX install · medium after 17
19 shared math in Rust → WASM + native: resampler, loudness, echo ruler, tile hashing, governor · eng · medium
20 governor everywhere, biased up: per-hardware-block pressure, every subsystem a dial, unseen work shed first, bursts absorbed, picture last, immediate climb · eng · medium (E1 retune is the first step)
21 deadline-paced background work: prerender/uploads/filmstrips at the rate their deadline needs · eng · light-medium
22 UI never freezes, measured: main-thread lateness as a report-card dimension; >1 frame → worker or chunked (size probe first) · eng · light-medium
23 UI complexity dial: effects level follows the governor; settings slider pins it; reduced-motion floor · UX setting · light after 20
24 heat as a signal: thermal state from the native shell, battery-aware ceilings in the browser · eng · light after 17
25 temporal layers at max (M1 candidate): 60 fps file with a 30 fps layer → sub-max export and streaming = packet selection · eng · medium, probe first
26 two devices, one take: room on Supabase realtime, direct WebRTC, shared clock (pings + room-audio correlation), each side records locally full quality, fragments ship after, remote camera = PiP input, the shared preview IS the call · UX new mode · heavy
27 streaming out: composed stage as a track to any WHIP ingest, same link as 26 · UX new mode · medium after 26
28 fragment journal = J1: resumable renders + the shipping cursor for 26 · eng · medium (task exists)
29 zero-egress paid storage: R2-class object storage or the user's own Drive · eng/pricing · medium
30 end-to-end encrypted cloud: key in the link fragment, we never see a frame, player decrypts · UX link semantics · medium
31 direct device links: free STUN, relay only as paid fallback or user-supplied · eng · medium
32 device-hosted sharing for free users: the recorder's machine serves the file while online · UX · medium
33 signaling on the existing free tier (Supabase realtime), no media through it · eng · light
34 payments through a merchant of record (Paddle/Lemon Squeezy class) · UX checkout · light-medium
35 no backend as a standing rule: static hosting, client-side logic, servers only for auth/storage rules/signaling · eng principle
36 one-call state snapshot for agents: flags, support verdict, store state, jobs, last errors in a few hundred tokens · eng · light
37 delta reporter: "what changed since I last asked" · eng · light
38 debug bundle: report cards, journals, anchors, certificates, console ring in one small file (also what a user could send) · eng · light-medium
39 console ring in the take's black box · eng · light
40 report card on the take card, expandable · UX display · light (Robert 09-02: bug data is NOT shown to users → agent/dev surface only)
41 agent-safe parallel sessions: hooks enforce worktree-per-session, refuse to commit into another session's claim · process · light (Robert: "make it perfect")
42 one-command headed prod check returning the report card (the hidden pane cannot rate-test) · tooling · medium
43 opt-in, show-before-send telemetry: report cards only, never pixels/audio, payload visible in settings · UX consent · medium (Robert 09-02: automatic if legal and free for users; "auto report bugs" toggle for paid, no off for free)
44 "send this take's report" after a bad take, user reviews first · UX control · light-medium
45 privacy ledger page: every byte that left the device and why · UX · light-medium
- OCR text selection in the paused player (Robert 2026-08-29: "select text from video" while paused): OCR the paused frame locally (zero tokens), transparent selectable spans over the stage scaled with its transform, cached per frame; degrades to today. Open: WASM OCR size vs the PWA budget · the cloud player · feeding the For-AI index.
