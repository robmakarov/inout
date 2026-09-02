# BACKLOG — bugs, evidence, ideas. For agents. The roadmap lives in `.ai/TASKS`; done items are deleted on sight.
Dump anything at the top of Inbox. Whoever picks it up triages it (lane, severity) or promotes it to a task id and leaves a one-line pointer here.

## Inbox
- (dump here)

## Open technical evidence (→ task id where one exists)
- [P1] THE LONG-TAKE EXPORT IS THE FRAME COUNT, and the machine may render it twice. Measured 2026-09-02 (`exp nativerender`, 60 s 3024x1964@60 source, 1080p step, real production render): 122-138 fps sustained — so a 124-minute take is 27 min of render at 30 fps out and ~57 min at 60 fps (`max`). RULED OUT as causes: the background frame + a zoom (128 ms over 3600 frames, 0.036 ms/frame — Robert's "must not make it slower" is already true), the decoder's `optimizeForLatency` hint (6 %, inside run noise, and it is what bounds GPU memory), constant quality (its cost tracks output BYTES: −11 % on still text = faster, not slower). Encoder alone does 187 fps at 1080p qp20 hardware (`scripts/encode-cost.mjs`), decode alone ~207 fps at 3024x1964, and they run SERIAL on one worker thread — overlapping them is the only pure-throughput lever left, worth ~1.4× (render.ts's header says a prefetch pump "bought nothing", measured on a 12 s take where the shape was different). The bigger waste is policy: the at-stop pre-render renders the WHOLE take, and any edit cancels it and restarts from zero 1.2 s later, so a frame preset and a zoom on a 124-minute take can cost two discarded hour-long renders before the export even starts. J1 (resumable renders) is the real fix; a length bound on the pre-render is the cheap one and needs Robert's yes.
- [P2] `?stallhold=` (new 2026-09-02) can delay the start of preview playback by up to 3 s on a cold element — the hold is doing its job, but pressing play and waiting is a new thing a user can feel. Watch for a report; if it lands, hold only after playback has actually started.
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
- [P1 → M1] SEVEN ELASTIC SYSTEMS, NOT ONE (found 2026-09-02 answering Robert's "so what is about that we have two elastics"). Ours: the frame-rate ladder 60↔30 on pressure/delivery (captureLadder.ts:105) · the encoder budget cutting screen resolution before the take (encoderBudget.ts:250) · the composite watchdog DROPPING THE WHOLE screen+camera mix after 5 s under 12 fps, no flag, fully automatic (liveCompositeV2.ts:366, compositorWatchdog.ts) · the background-work broker throttling the pre-render (backgroundWork.ts:90) · the export QP governor (below). NOT ours: the capture encoders run in BITRATE mode (rawVideo.worker.ts:238, compositor.worker.ts:416) so the browser's own rate control decides what detail to discard under strain — this is the mechanism that eats a ticking tab clock, per robert (13) · Chrome's own adaptation, which may ignore applyConstraints and downscales getDisplayMedia surfaces itself (acquire.ts:467, acquire.ts:614). At least four can lower quality with no decision anyone can point at, they can stack on one take, and no single place records that quality moved or why. M1's "ONE elastic system" must be read as all seven, not just max's floor plus E1.
- [P1 → M1/SIZE-CODEC] "CONSTANT QUALITY" IS NOT CONSTANT: constantQuality.ts:338 floats QP up one step whenever output runs >1.15× a bitrate ceiling, to MAX_GOVERNED_QP 32 from a target of 20 — a large quality drop, taken automatically, to hit a SIZE target. A hidden size governor living inside the thing named for not doing that; against robert (8)/(13) it is a defect, not a setting. Decide it deliberately or bound it so fine detail is never the thing it spends.

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

## Ideas — the 45 of 2026-09-02. REVIEWED 2026-09-02 (Robert: "yes, tidy it"); 23 of them were already tasks.
Numbers are PERMANENT ids (.ai/TASKS cites them). Rule for this block: an idea whose work has a home
elsewhere is ONE POINTER LINE here, never a second copy of the spec. Tags: UX = a user sees or hears a
change → Robert's yes · eng = invisible.

### Owned elsewhere — do not re-plan here
4 → X14 · 5 → X11 (idea 5 IS its light first step, now X11a) · 11 → SIZE-CODEC lane · 15 → AI1's delta
detector, measured by X17 · 17 → P4 · 20 → E2 · 28 → J1 · 29 → C1 · 30 → C2 · 31 → C1 · 32 → C5 ·
33 → C3/C8 signalling · 34 → C4 · 35 → the FROZEN RULE constraints in .ai/TASKS · 36-42 → CONTINUOUS
LANE + T1 (40 also ruled: the report card is an agent/dev surface, never a user one) · 43 · 44 · 45 → C7.

### Promoted to Phase 1 by this review — specs and gates in .ai/TASKS
2 → H7 self-manifesting media files · 21 → E3 deadline-paced background work ·
22 → G7 main-thread lateness on the report card · 25 → M4 temporal-layers probe. Plus two probes that were
buried inside heavy tasks and each answer an OPEN Phase-1 bug: X14a (`VideoFrame.metadata().captureTime` —
the string appears NOWHERE in src/; the anchor is still read-time `performance.now()`, measuredVideo.ts:229)
and X11a (transfer the track processor's readable into the worker — the standing suspect for B12).

### The one measurement — ideas 1, 15, 16 and AI1's known miss are ONE number, not four projects
X17 the changed-tile census (.ai/TASKS, Phase 5): how much of Robert's REAL work screen changes per second,
at what tile size, measured BEFORE anything is built. It decides 1 (lossless changed-tile master for work
screens; perfect text, far smaller, frees the screen encoder; hybrid with the encoder for motion · UX ·
heavy), 16 (the lossy sibling: an atlas of changed rectangles through the hardware encoder · eng · heavy),
15 (zoom proposals from pixel change, like Tighten · UX proposals · medium) and why AI1's keyframe picker
dropped frames whose only change was small (cursor, text fields). Robert on 1: "try it but skeptical" —
the census IS the cheap half of trying it.

### Still only ideas — phase-gated, nothing owed until their gate opens
6 constant-quality capture: quantizer mode + the export's governor on the raw screen encoder · UX (file sizes) · medium · measure the size delta first, then Robert's call. SETTLED 2026-09-02 (Robert: "constant quality is must be anyway isnt it? unless is elastic is on, so offering me to turn off elastic?"): they are NOT alternatives and elastic is never turned off. Elastic decides HOW MUCH WORK WE ASK FOR (resolution, rate, what is composited); the quantizer decides HOW FAITHFULLY the encoder renders what it was asked for. Today's bitrate ceiling is a SECOND, hidden elastic system nobody controls — under pressure it silently discards the finest detail, which is exactly the ticking tab clock of robert (13). Constant quality removes that hidden system, so the visible one (E2/M1, "like water") must be good enough to be the only brake. Still needed: an upper bitrate bound so a pathological screen cannot fill the disk (disk-guard territory), and that bound may never be met by trading the clock away.
7 cloud player composites screen+camera from two packet copies + the camera track as data → instant max+camera SHARE · UX · medium · needs C8
9 record the export: at max, composite at native size + tiny stream of the patch under the PiP + camera raw → unedited max+camera export = copy · UX · heavy · only after A1's long take holds (load family)
14 continue after a crash: recovery + R-CONT continue = one take · UX control · medium-heavy · after F19
18 installed core serves the browser: PWA gains native capture when the core is installed · UX install · medium · after P4
24 heat as a signal: thermal state from the native shell, battery-aware ceilings in the browser · eng · light · after P4
26 two devices, one take — the full approved shape is in "Later — approved shapes" above · UX new mode · heavy · needs C1-C3 + J1
27 streaming out: composed stage as a track to any WHIP ingest, same link as 26 · UX new mode · medium · after 26

### DEAD by Robert's word 2026-09-02 — do not re-propose
3 speculative seams (pre-cut at silences while idle) — "i dont feel like its good, triming goes back and forth all the time". A pre-cut guess is worthless when the trim keeps moving. What he actually wants instead: R1, review the render path, it was too slow on his last take.
11 name the size (type an exact target file size) — "bullshit, user only use quality slider".
15 zoom proposals from pixel change — "bullshit, excatly the shit that must not go unaproved, features for users". The delta detector itself survives ONLY as X17's measurement and AI1's index, never as a user-facing suggestion.
8 idle consolidation · 12 the player is the editor · 13 every take at 60 by interpolation · 23 UI complexity dial · 32 device-hosted sharing for free users — Robert 2026-09-02 on the whole cut list: "other to cut - fuck them".

### THE INTERACTIVE SCREEN — a direction Robert named 2026-09-02, bigger than any single idea
"select text is important, clicking links on screen too, also i think this is important direction, we can make screen on video almost interactive." Text in a recorded screen is selectable, links are clickable — the recording stops being a flat picture. Robert 2026-09-02 asked how far it goes: "i pause video of guy on some page and i can scroll that page?" — THREE LEVELS, and the middle one is new: (a) OCR the paused frame → select/copy what is VISIBLE, recognise visible URLs; no scrolling, what was off-screen was never recorded. (b) SCROLLING IS SEEKING IN TIME — if he scrolled past that content at any point in the take, those pixels exist somewhere in the timeline, so scrolling a PAUSED frame = jumping to the moment that region was on screen and stitching it in. Needs no extension and no DOM: it needs the change-tile index that idea 1/16 produces anyway, plus a scroll-offset estimate (derivable from tile motion). This is the strongest argument yet for idea 1. (c) the page's own description (idea 10) → true scrolling and real links even for what was never shown; needs a vehicle and breaks on canvas/video/protected content. D-OCR is the cheap half; the full half needs idea 10 — the reason 10 survived the cuts. Same data serves AI collaboration. Also on his mind and already logged in "Later — approved shapes": the screenshot / image capture channel.
10 record the page not the pixels — Robert 2026-09-02: "10 is way to experiment later, put it somwhere for coloboration with ai experimints in v2 to consider". NOT cut. Phase 5 / v2, beside idea 1, as an AI-collaboration experiment; still needs AI2's vehicle (extension/snippet/P4), still breaks on canvas/video/protected content.
19 shared math in Rust → WASM + native — UN-DEMOTED by the ceiling ruling (DECISIONS robert (7)): it belongs INSIDE P4, not nowhere.
NOTE on 1 and 16 after the ceiling ruling and the every-movement rule: idea 1 is a v2 experiment with a second reason to exist — Robert 2026-09-02: "feels like something that can be used for collaboration with ai too" (a tile stream already states WHAT CHANGED, which is what an agent needs and what a video hides). Idea 16 stays alive but is now bounded: any tile that changed AT ALL is kept, cursor twitches included; no threshold is permitted, so its saving must come from the encoder, never from discarding movement.

### Idea outside the 45, kept
- OCR text selection in the paused player (Robert 2026-08-29: "select text from video" while paused): OCR the paused frame locally (zero tokens), transparent selectable spans over the stage scaled with its transform, cached per frame; degrades to today. Open: WASM OCR size vs the PWA budget · the cloud player · feeding the For-AI index. → Phase 4 as D-OCR.
