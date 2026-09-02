# Backlog

Dump anything, anytime, top of Inbox. One line is enough; add repro/device only if you have it.
Two lanes: technical/code and project. Whoever picks an item up triages it into a lane and tags
technical defects by severity. Done items get deleted, not archived.

## Inbox

- (dump here)

## Roadmap — asked for, on the UI, not wired

- **R-CONT — continue a take from the playhead.** Robert, 2026-08-30: "no need for fucking pause
  button, record pressed - on editing appearing again left to play button, if pressed continues where
  dragger in timeline stands (if it cant work now put it in roadmap, just make on ui)". The control
  IS on the UI — `transport__rec`, left of play in the editor — and pressing it says it is on the
  roadmap. What it needs is real capture work, which is why it is not done: re-arm the same devices
  the take used, record a NEW segment, and splice it into an existing recording at a recording-timeline
  instant. Open questions the task has to answer before it is built: does the new segment become new
  channels or extend the existing ones (the blobs are per-channel and already closed); what happens to
  the audio anchors, which are measured once per session (B7); and what a continue does to the
  composite, which is one file written by one encoder for one arming. The pause button it replaces is
  gone from the capture screen — `session.pause()`/`resume()` still exist and still hold the devices
  (F6), so a first cut could be "continue = resume an un-stopped take" for the case where the user has
  not left the editor yet.
- **R-RIPPLE — the timeline closing up over a cut.** UI1, Robert: "make cutted out zone shrink with
  button undo inside". The undo IS inside the zone and the zone is recessed so it stops reading as
  timeline, but it still occupies its real width — the segments on either side do not slide together.
  That half is not cosmetic: the timeline's x() maps RECORDING time linearly, and making a cut span
  collapse to a fixed width means a piecewise x() plus its exact inverse in msAtClient(). Everything
  that reads the axis follows for free (ruler, playhead, trims, cut handles, zoom markers) EXCEPT the
  lane bars: each is one element whose filmstrip is a single stitched image stretched
  `background-size: 100% 100%` across a linear span, so a piecewise axis misaligns every frame after
  the first cut. Doing it properly means splitting each lane bar into per-segment pieces with their
  own slice of the strip. Worth doing, not worth doing by accident.
- **Show in folder.** On the take cards, and it cannot do what it says: no web API reveals a file in
  Finder or Explorer, by design. It currently explains where the file is (the browser's Downloads,
  ⌘⇧J) instead of opening a tab that fails silently. If this is ever wanted for real it needs a native
  wrapper, which is off the MVP roadmap.
- **Send / Copy link on the take cards.** Deliberately blank — Robert, 2026-08-30: "make them blank
  for now".

## Technical / code

### Now

- [P1 — SEEN ONCE, H1's rig, 2026-09-02] **a channel whose measured stop misses the 5 s budget is
  DELETED, not "kept with what reached disk".** One cell in four of
  `node scripts/contain-check.mjs` came back with screen AND camera absent from the take entirely —
  the report card said "screen was requested and never delivered a byte" about a channel whose own
  console line had it armed at +120 ms and delivering 1920x1080 frames all take. The mechanism is in
  plain sight in `session.ts doStop`: `Promise.all(channels.map(c => c.stopped))` is bounded at
  STOP_BUDGET_MS (5000) and the warning it prints says "keeping what reached disk" — but the very
  next lines are `kept = this.channels.filter(c => c.bytes > 0)` and
  `if (c.bytes === 0) blobStore.remove(c.blobKey)`, and `bytes` is filled by the stop reply that just
  timed out. So the file on disk (megabytes of it) is deleted and the take reports the channel as
  never delivered. NOT H1's mechanism — the budget, the filter and the removal all predate it, and
  three re-runs of the same cell passed with every channel full length — but H1's rig is what caught
  it, and the trigger is load: the failing run was the fourth back-to-back Chrome and both raw
  channels logged ~184 dropped frames. The fix is to read the bytes off DISK before deleting anything,
  or to keep a channel whose blob is non-empty regardless of what its stop reply said.
- [P1 — MEASURED, H2's floor probe, 2026-09-01] **a crash in the first ~5 seconds of a take
  loses the WHOLE take, and in the first ~7 seconds loses the picture.** Eight single-kill
  cells on prod, `node scripts/crash-bound.mjs --killAt=2000,3000,4000,5000,7000,8000,10000,20000`:
  at 2.8 / 3.3 / 4.2 s the pending manifest is NOT on disk and nothing is recoverable — no
  Recording, no blobs, `takeCount 0` — because `session.ts writeManifest` puts it in
  `localStorage` and Chrome's storage service commits localStorage asynchronously, so a `kill -9`
  inside that window takes the only pointer to the take's blobs with it. At 5.4 s the manifest is
  there and the take salvages as AUDIO ONLY: audio is on ~1 s WebM clusters and already has
  material, while a fragmented-MP4 fragment needs its minimum duration AND the next keyframe, so
  neither video channel has anything decodable. From 7.5 s on everything comes back and the
  2.1 s bound in docs/CRASH_BOUND.md holds at every length up to 31 minutes.
  TWO FIXES, both cheap, both BEHAVIOUR CHANGES and therefore Robert's to allow: write the
  manifest through the durable positioned writer the channels already use (or IndexedDB, which
  has a real transaction commit) instead of localStorage; and close the first video fragment
  early so a young take has something decodable. Each is additive — it can only turn a lost take
  into a recovered one — and each should ship capability-gated with the current path as fallback,
  per the frozen rule.
- [P2 — MEASURED, F16b, 2026-09-02] **the export panel's size probe is what stalls the first
  seconds in the editor, and it is on the main thread.** Hunting F16b's gate 5 (does a background
  render cost the person dragging?) found stalls of 35-201 ms landing 0.4-0.7 s into a drag, in
  four runs of seven — and they are not the render. `[quality] size probe` encodes 300 real frames
  to price the ladder's steps when the editor opens (10.8 s and 11.0 s on two measured takes), and
  every stall was inside that window: excluding it, the same drag beside the same working render
  reads p95 scheduling lateness 1.1-1.2 ms alone against 1.1-1.3 ms with the job, worst tick
  9.6-17.6 ms, and no stall over 30 ms in any run. So the panel's own estimate is the thing a user
  feels when they grab the playhead in the first ten seconds. Reproduce with
  `node scripts/editor-drag-cost.mjs` (it now waits the probe out on purpose — remove the wait to
  see it). Candidate fixes, none of them F16b's: probe in a worker, probe fewer frames, or probe
  only the step the user is actually looking at.

- [P1 — OBSERVATION with a caveat, H2's heavy cells, 2026-09-01] **under a starved main thread
  BOTH measured-audio channels end tens of seconds early, on a CLEAN stop, and only the report
  card notices.** A 300 s take at a synthetic 2560x1440@60 source (four channels, three encoders,
  354.8 Mpx/s): screen delivery fell 44 -> 26 -> 17 -> 10 -> 2.4 -> 0.2 fps over the last minute,
  and mic and tab audio BOTH ended at exactly 264,323 / 264,263 ms of a 303,235 ms take — 38.7 s
  short, to the same instant, on a take that was stopped normally and drained normally
  (`finishEncode` awaits encoder.flush, the encode chain, finalize and writer.close, so nothing
  was left undrained). Two independent channels ending at one instant says one shared cause, and
  the shared thing is the MAIN THREAD: since A1 the default tap is `MediaStreamTrackProcessor`
  read on the main thread, so when the main thread stops, the audio simply stops arriving —
  WallClockHold pads the gaps it survives (4,183 ms here) but a reader that stops delivering
  produces no more batches to pad. THE CAVEAT, and it is why this is an observation and not a
  verdict: the rig's synthetic source is a canvas the PAGE ITSELF paints at 2560x1440 sixty times
  a second, which a real screen share does not cost, so part of the starvation is the rig's own.
  Reproduce with `node scripts/crash-bound.mjs --control=300000 --screen=2560x1440`; the same
  command at `--screen=1920x1080` holds 60.0 fps and grades GREEN, which bounds where the line is
  on this machine. S1's card called it correctly and unprompted ("mic ended 38.7s before the take
  did"), so the instrument for whoever picks this up already exists. Belongs to A1/E1/H4, not H2.

- [P2 — OBSERVATION, from the 2026-09-01 autopsy, not yet a verdict] **the 720p camera PiP wrote
  MORE bytes than the 3024x1964 screen.** Take rec_78ogcw052vdn, 3,026 s: camera 900 MB
  (2.49 Mbps against a 2.5 Mbps request — on target) and screen 814 MB (2.25 Mbps against an
  8 Mbps request — 28 % of it). Either the screen encoder could not be fed at max quality, or
  50 minutes of a mostly-static screen legitimately compresses that far; `npm run exp -- bits`
  on a screen-only max take decides which, and only the first one is a defect.

- [P0 — EVIDENCE PHASE, the wedge] **the next stall convicts a suspect instead of adding to a
  count.** The verdict table, the playbook for whoever handles Robert's next report, and the whole
  case history live in ONE place: `docs/SCREEN_WEDGE.md` (rewritten 2026-08-30 — start at "WHEN
  ROBERT REPORTS IT AGAIN"). Containment today: a wedge costs one press, never a take.
- [~~P0~~ FIXED 2026-08-30] **"?sourcefps=1 - record froze on game tab again"** (Robert). NOT the game
  and NOT 60 fps. REPRODUCED ON A QUIET MACHINE WITH NO GAME, from his own configuration
  (`screensize=3024x1964`, sourcefps on, native res at its shipped default), against prod — and the
  take produced NO channels and no composite at all.
  THE CHAIN, four defects deep: the capture ceiling asks for a 2560 long edge → Chrome returns
  2560x1663, odd HEIGHT → capDisplayTrack asks for 2560x1662 → **Chrome re-derives the width from the
  aspect and returns 2559x1662, odd WIDTH** → every AVC config is unsupported → `pickVideoConfig`
  threw → the raw channel fell back to **MediaRecorder's SOFTWARE VP8/VP9 at 2559x1662@60**.
  Software-encoding 4.25 Mpx sixty times a second is the freeze. The console said only "measured
  video unavailable". The 2026-08-29 odd-side fix had evened the TRACK and stopped there; BACKLOG
  recorded that `startMeasuredVideo` "evens its own ENCODER CONFIG" as the second line of defence and
  IT DID NOT — no caller of the worker evened anything.
  FIXED IN FOUR PLACES, each measured rather than argued:
   1. both encoder-config pickers even DOWN (Chrome 151, measured first: 2559x1662 AVC unsupported,
      2558x1662 supported, and an encoder configured at 2558 ACCEPTS a 2559-wide frame and emits a
      chunk with no error — so it costs one pixel column instead of the hardware path);
   2. single generation now reaches native resolution, so a screen-only take at its own size opens
      ONE encoder instead of two. His ask, 3024x1964@60, is 481 Mpx/s with a composite and 356
      without — the composite is the difference between impossible and merely hard;
   3. the 60 fps decision is MEASURED, not a size constant. The app times its own encoder at load:
      on his Mac, idle, one hardware AVC encoder — 362 Mpx/s at 1080p, 410 at 2560x1662, 416 at
      3024x1964, 435 at 4K. The old rule refused 60 above a 2560 long edge, which allowed 60 at a
      2559 long edge and refused it at 2561 — the worst case this product can produce was the one
      case nothing checked, and it is the take that froze;
   4. the encoder measurement is kicked off FIRST in prearm; behind four other awaits it landed after
      the take had already armed.
  WHERE IT LANDS: the take that produced nothing now records 3024x1964@30 on one encoder, verified on
  prod. 60 fps AT FULL NATIVE RESOLUTION IS RIGHT AT THE EDGE OF HIS HARDWARE — 356 Mpx/s wanted
  against 346-416 measured depending on how busy the machine is — so it is decided per launch by
  measurement, and a game correctly pushes it to 30. 2560-class at 60 (255 Mpx/s) is comfortably
  inside. That trade is his to make and the console now prints both numbers.
  STILL OPEN, and it is the honest remainder: nothing yet measures the encoder WHILE A GAME RUNS. The
  reading is taken at app load on an idle machine; captureLadder is the only thing that sees the
  loaded regime, and it steps the rate. Whether the ladder is fast enough for a game that starts
  MID-TAKE is unmeasured — `npm run exp -- syncload` is the cell that would say.

- [P1] 2026-08-29 (G3 session): **the v1 oracle's export-throughput gate is a coin flip** — `node
  scripts/oracle.mjs --engine=v1` fails on `export throughput X < 1x realtime` with the threshold
  sitting inside the run-to-run noise. Interleaved A/B, same machine, alternating trees:
  base 1.34x PASS / 0.87x FAIL / 1.35x PASS against a working tree's 1.15 / 1.28 / 1.28. It is not a
  regression detector at 1x — it is a load detector, and it flips on whatever else the machine is
  doing. Same family as G1. NOTE FOR ANY SESSION READING A RED v1 ORACLE: run the parent commit
  beside it before believing it, which is how this one was caught (a first pass read 0.73-1.01 on the
  working tree against 1.16-1.29 on the parent and looked exactly like a real 20-40 % regression).

- [P2] 2026-08-29: **the export quality step is sticky forever** → F14, RULED the same day and
  ABSORBED BY `.ai/TASKS` F16: quality becomes ONE option (Min/Medium/High-default/Max-later,
  later also chosen before record) and capture's composite FOLLOWS it, which is what makes
  "instant export for any quality" achievable (the chosen rung is always a packet copy). Until
  F16 lands, O3c's per-step INSTANT badges keep the panel honest.

- [P2] 2026-08-29: **30 fps hardcoded everywhere** → `.ai/TASKS` F15, RULED YES the same day
  (Robert: "every device records the best it can, 60 fps"). F13 landed 2026-08-29 and left the seam it
  rides (`session.compositeFrame()` asks the take what it is, once, before any encoder exists), so
  F15 is unblocked; the ruling and shape live in the task and DECISIONS.

- [P1] 2026-09-01 (G1+LC1 session; ABSORBS the 08-29 "render lane flips run to run" entry and
  RETRACTS the "instant lane is bimodal" one): **the fidelity oracle's RENDER lane flips on machine
  load, and the instant lane does not flip at all.** Prior readings on the same lane, now explained:
  toneErr 5.33 dB once, then 0.04 and 0.01 on the same tree (G2 session). Five consecutive runs
  here: instant residual 0.03 / 0.03 / 0.04 / 0.03 / 0.03 (sd 0.004 dB);
  render 8.69 FAIL / 0.02 / 0.04 / 0.03 / 0.02. The old entry blamed the instant lane and a "decode
  window landing on the wrong span"; BOTH are refuted — the failing run's window (0.403 s) is EARLIER
  than a passing run's (0.409 s), and its four tones are wrong by four different amounts (440/L
  -8.69, 880/L -0.77, 550/R -1.78, 1100/R -6.69), which a misplaced window cannot produce because it
  attenuates every tone by the same fraction. In the red run THD reads -56.8 dB against -65.9, IMD
  -54.5 against -61.9, separation 47.4 against 55.6: a disturbed recording, not a wrong measurement
  of a good one, and it was the FIRST run after an hour of 120 s cells.
  ACTION, already written down one entry below: this runner never got the retry/quiet-machine guard
  `oracle.mjs` got in 86ed200. Give it that, and re-read the render band after.
  Evidence: /tmp/fid-1..5.json, and the fidelity block in the G1+LC1 handoff in `.ai/TASKS`.

- [P1] 2026-09-01 (found by the 120 s cell, G1+LC1 session): **smart cut errors out on a long take and
  the trim silently falls back to a full render.** One of five cold `--recordMs=120000` runs:
  `trimmed export took 'render', expected 'smartcut'` with the reason `Timestamps must be
  non-negative (got -0.0003333333333337407s)`. That is exactly -1/3000 s — a rounding artefact, not a
  real negative time. `outAt(compSec) = outCursorSec + (compSec - spanStartSec)` (src/core/compose/
  smartCut.ts:456) goes a hair negative when a sample sits just before its span start, and mediabunny
  rejects it. The same trim at 6 s takes the smart-cut path every time; the 120 s trim offset is
  30483 ms against 1483 ms, so this needs a long take to reach.
  WHY IT MATTERS: the user meets it as "the trim re-rendered instead of being instant" on exactly the
  long takes where a render costs the most — the complaint F16b exists for. The oracle's anti-vacuity
  rule is what caught it (the sync gate said it had measured the wrong file), which is the second time
  that rule has found a real defect rather than a bookkeeping one.
  LIKELY ONE LINE: clamp at the EPS_SEC the same file already uses everywhere else.

- [P2] 2026-09-01 (G1+LC1 session): **the 120 s cell dies on CDP about a third of the time, and it is
  the most expensive run in the repo.** Eight attempts at `--recordMs=120000`: three died — "experiment
  threw in page", "Inspected target navigated or closed" x2 — and all three were CONSECUTIVE, straight
  after a 10-run 6 s matrix, after which five ran clean. So it is a state the rig gets into, not a
  per-run dice roll; killing stray Chrome first is what preceded the clean five. At ~4 minutes a run
  that is 12 minutes lost, on the cell `.ai/TASKS` makes MANDATORY before any flip touching the
  instant or smart-cut paths — i.e. the tax is paid by every such task.
  SHARPENED 2026-09-01, same session: it tracks the take's WEIGHT, not the clock. The `f7` cell died
  the same way twice at ~50 s of a 120 s screen+camera+mic take ("Inspected target navigated or
  closed", no error, mid-capture); the identical cell with the CAMERA OFF ran the full 120 s and
  finished, peaking at 741 MB of Chrome renderer RSS (`--rss`, 641 samples). So the first move on a
  long cell that keeps dying is to drop a channel, not to retry it — and the renderer's ceiling on
  this 8 GB machine is the thing to measure, which is H3's cell.
- [ROBERT OWED] 2026-08-29: **F13 is built, verified on prod and OFF** — `?sourceframe=1` and the
  output follows the take's shape instead of a landscape constant. Its last gate is Robert's eye:
  open https://inout-kappa.vercel.app/?sourceframe=1 on a PHONE, record, look at the export. Until
  then INOUT still cannot make a vertical video by default, on purpose. Evidence read out of the
  exported FILE: portrait 1080x1920 (instant copy), 4:3 camera 1920x1440 (full height, was cropped
  to 1080), 16:9 unchanged at 1920x1080 on both copy paths.
  SECOND PASS SHIPPED after Robert's phone verdict ("still wrong proportions and cutted"): capture now
  takes the shape from the FRAMES rather than from `track.getSettings()`, which describes the
  sensor and lies about orientation on a phone. Reproducible on a desktop with `&camlies=1`.

- [P1 → ROADMAP B1] Robert 2026-08-29: **the size estimate is 2.15× low at the top step** — panel said 4.7 GB at
  1440p, file came out 10.09 GB (140 min). Every other step landed within ~100 MB, so this is the
  top rung specifically, not the model. quality.ts already admits the √-pixel model came in 47 % low
  at 1440p on text content; at Robert's length that becomes 5.4 GB of surprise. Note the estimate is
  ALSO the only warning a user gets before committing to a ~2 h render.
  PARTLY NARROWED BY O3c (2026-08-29): on a take whose single raw channel matches the step's
  geometry the number is now EXACT (the file's own byte rate) and that export no longer renders at
  all. The defect remains for steps that genuinely re-render (camera takes, mismatched geometry).
  SECOND, CHEAPER DEFECT SEEN WHILE CHECKING THIS (deployed build, 6 s synthetic take): the
  PROVISIONAL numbers — what the panel shows for the seconds before sizeProbe's calibration lands —
  ranked 1440p BELOW the 1080p step, `1080p 400 KB (exact)` against `1440p ~308 KB`. 1440p is an
  upscale of that very file; it cannot be smaller, and the model has the evidence to know it
  (`isDefaultTier` already returns the composite's exact bytes). After calibration the same panel
  read 540p 310 / 720p 340 / 1080p 400 / 1440p 460, which is ordered. Floor every re-encoding step
  at the exact size of any step whose pixel count it exceeds — one comparison, no new measurement.

- [P1] Robert 2026-08-29, PARTLY DONE — what is LEFT is the codec. Two of the three named causes
  shipped the same day: 1440p is no longer an upscale (native-res capture is the default now), and
  the export targets a QUALITY instead of a bitrate (qp20, measured Pareto-better at 1440p — never
  worse picture, ~11 % smaller, `docs/FLAGS.md`). THE REMAINING GAP IS NOT RATE CONTROL and the
  measurement says so: the bitrate target was already undershooting at 1.83 of 14 Mbps, so there was
  no ceiling of waste to reclaim, and 11 % is what rate control was ever worth here. Robert's comparison
  ("movies files with much better quality is twice smaller") is a CODEC comparison — hevc/av1 against
  our avc floor. Both rungs are BUILT and reachable (`pickEncodingTarget(..., {allowAboveFloor:true})`),
  and off for a distribution reason rather than a technical one: a blind-shared file must play for a
  recipient we cannot probe. THE DECISION IS ROBERT'S and it is worth re-pricing at two-hour takes, where
  the file is too big to send anyway. Options, in order of how little they give up: (a) hevc/av1 for
  the CLOUD player only, where we control playback — no recipient risk at all; (b) a "smaller file,
  newer players only" choice in the export panel, named honestly; (c) flip the blind-share floor.
  ROBERT RULED THE OBJECTIVE 2026-08-29 ("minimal size ... couple minutes ~10 MB with good quality") —
  the a/b/c PICK is still owed; recommendation: (b) now + (a) when cloud lands, and against (c) (it
  breaks blind shares on old players). Carried on the READY map as SIZE-CODEC.
  Also open, and cheap: quantizer mode has NO bitrate ceiling, so a pathological source could exceed
  the tier's old cap. Nothing measured came close (busiest lane 3.17 Mbps at qp20 against 3.55), but
  the guarantee is gone — a mid-export achieved-rate check that steps the QP up would restore it.

- [P2] Robert 2026-08-29: **"at some points video got slows down and lag too"** on a long take. NOT
  DIAGNOSED — needs to be pinned to a stage before it is chased: during capture (frame delivery),
  during preview playback, or in the exported file itself. The take already carries the answer for
  the first (`CompositorStats.framesDropped` / `maxEncodeGapMs` / `peakQueue`); the third is visible
  by scrubbing the export to the same instant. The preview half is partly addressed 2026-08-29 (the
  scrubber was firing a full re-seek of every element per pointer event, now one per frame).

- [P1 → ROADMAP B2] Robert 2026-08-29, sharpening his earlier "noises on tab audio": **tab audio crackles all
  through the start of an editing session and then MOSTLY heals** — "when video recorded and edit
  starts a lot of minor noises in tab audio, but after some time editing noises almost completly
  stops in same places they were in begining, but not completly, i need them gone".
  THAT SHAPE IS THE WHOLE CLUE AND IT SAYS THERE ARE TWO DEFECTS, not one. A noise that heals with
  repetition is not in the file; one that survives every repetition is. Chasing them as one bug is
  how this stays open.
  (A) THE HEALING PART IS PLAYBACK, and what you hear is the preview's own CORRECTION rather than
      the audio. Channel blobs reach the player as OPFS-backed `File`s (`blobStore.read` →
      `getFile()` → `createObjectURL`), so the first pass over any region pays a disk read and a
      cold decode however `preload="auto"` is set, and later passes hit the browser's cache — which
      is exactly "the same places, quieter each time". The resulting stall then meets
      `usePlayback.sync`, which makes it audible two ways: past RESYNC_HARD_MS (250 ms) it
      hard-seeks a PLAYING element, which is a click, and between SYNC_DEADBAND_MS (15 ms) and that
      it slews `playbackRate` by up to −20 %/+25 %. Media elements preserve pitch by default, so
      that slew engages the browser's TIME-STRETCHER — the warbling a listener calls "minor noises",
      and worst on tab audio because it is usually music or continuous speech, where stretch
      artefacts have nowhere to hide. Candidates, cheapest first: warm the decode before playback
      (audio channels are small — decoding them to an AudioBuffer once removes the class outright);
      ramp the correction instead of applying it (crossfade a hard seek, cap the slew far below
      ±20 %); or stop slewing AUDIO at all and slew only video, letting audio be the clock — it is
      the one channel where a listener can hear the correction being made.
  (B) THE RESIDUAL IS CAPTURE, already in the file and immune to warming. Every starved audio
      quantum is deliberately turned into 64 frames of fade-out / silence / fade-in
      (`measuredAudio.ts` PAD_FADE, `compositor.worker.ts` AUDIO_PAD_FADE) so the sample-counted
      timeline stays honest — a starve is audible BY DESIGN, as a ~1.3 ms notch. 2026-08-26 measured
      tab audio padding 1281 ms in 84 s under load, ~15 notches a minute. Fix is either starve less
      (CPU) or splice better: crossfade ACROSS the gap instead of through zero.
  THE DISCRIMINATOR IS ONE EXPORT, so nobody has to argue about which half is which: export the take
  and listen to the FILE. Anything audible in the exported file is (B) and was recorded that way;
  anything that exists only in the editor preview is (A). `ChannelDiagnostics.paddedMs` on the take
  says how much (B) there is before you even listen — 0 there means (A) is the whole story.
  Robert's bar is explicit and it is not "less": "i need them gone".

- [P1 → ROADMAP B3] 2026-08-26, from Robert's own console dump (real takes, deployed build): **a long-lived app
  tab spans deploys, its lazily-loaded chunks 404, and that silently killed the EXPORT WORKER.**
  Evidence in the dump: `/assets/sizeProbe-Bp5ddNpw.js` 404 and `index-Bo_8S72j.css` 404 (hashed
  names from a build Vercel no longer serves), and twice `[compose] export worker unusable,
  rendering in-thread — Error: export worker error`. The fallback WORKED (files delivered), but
  those exports paid the slow lane on the UI thread — one 32 s take spent 7.5 s of its 8.2 s render
  in encode-wait, in-thread at 1440p. Mechanism: the PWA service worker is assets cache-first /
  documents network-first, so a tab (or cached document) from build N requests build N's hashed
  chunks after build N+1 deploys, and Vercel serves 404. Repro: open app → deploy → open the export
  panel. FIX SHAPE, not chosen: SW precaches ALL hashed assets at activate · a version-mismatch
  "refresh for the new version" prompt (owed-flag boot-notice machinery exists) · or keep build N−1
  assets alive in the SW cache. This may also explain past "the fix wasn't there to hear" rounds —
  a stale tab IS an old build even when prod serves HEAD.

- [EVIDENCE for the live audio session, 2026-08-26 — not a new entry, do not fork the fix here]
  Robert's console from real takes says two things the audio session should read before choosing its
  fix: (1) mic peaks sit at EXACTLY 1.000 on several takes (`mix loudness measured live: peak
  1.000`) — the INPUT is clipping at capture, before any of our gain; (2) a mostly-quiet 48-min
  take read `p90rms 0.0034 → makeup 8.00×` — the normalizer drove room-tone up 8× (+18 dB), which
  is Robert's "mic is kinda too loud now" in one line. A quiet take gets the cap, a clipped take gets
  the limiter; both read as "sound is wrong". F9 (the slider) is the CONTROL for this, the target/
  cap policy is the fix and belongs to that session.

- [P0] 2026-08-25: SAFARI MIC — promoted to roadmap task .ai/TASKS P8 (Robert 2026-08-25 "put
  safari bug in roadmap"). One line of truth: a real Safari take carries only a couple of
  seconds of mic sound; the task is BLOCKED on one Robert artifact (the exported file, or a
  Safari-console take) and must not be coded from theory. Full spec, candidate causes and
  gates live in the task.

- [P1] 2026-08-25 (was P0; downgraded same day on Robert's stress-test pass "seems to be allright
  now"): THE SCREEN WEDGE — MITIGATED, CAUSE STILL CHROME'S. getDisplayMedia never settles after
  the user picks; only ⌘Q reliably clears the browser-process claim. Shipped stack: bounded ≤30 s,
  devices released, request serializer (displayRelease.ts), persistent device connect, one
  automatic refresh + ⌘Q escalation, safe-mode ladder. If it recurs: quote the canonical
  formulation at the top of docs/SCREEN_WEDGE.md and run its evidence kit. Strongest unbuilt
  lever: TASKS O12 persistent-share (Robert-gated, deferred).
  RECURRED 2026-08-25 in ONE ordering, two new facts in the case file: (a) a 4K game already
  running when record is pressed wedges; restart Chrome, share FIRST, then start the game — no
  wedge. Load at picker time is a trigger by itself, and the safe ordering is exactly what O12
  makes permanent. (b) IN THAT WEDGE THE REFRESH RITUAL DID NOT DELIVER — app unresponsive, no
  visible auto-reload, no ⌘Q message. That half is OURS and is its own P1 below.
  RECURRED 2026-08-26: "i got chrome wedge after trying to record after previous session" — the
  known second-take-after-a-session pattern, presumably cleared by ⌘Q (the next take recorded
  fine). No console timeline again, so no new mechanism facts. Precaution taken the same day:
  the dead-tap revival's track clones are now stopped on pagehide, so a page dying mid-take
  cannot leave a clone holding the display-capture claim the wedge family feeds on. The standing
  levers are unchanged: O12 persistent-share (Robert-gated) and the case-file evidence kit.

- [P1 → PARTLY FIXED 2026-08-25] Robert: THE WEDGE RECOVERY ITSELF FAILED under game load — after the
  wedge the app "dont reloads normally, gets unresponsive, no message about that i need to reload
  chrome". ONE HALF WAS OURS AND IS FIXED, from code, no repro needed: the boot notice was due only
  within 15 s of the reload stamp, and the wedge happens when the machine is saturated — which is
  exactly when the reload it triggers takes LONGEST to boot, so the one case that most needed
  explaining was the one case that silently got no message. The notice is now an OWED FLAG consumed
  once at boot (bounded at 2 min), so a slow boot cannot lose it. Two more, same report: it was a
  4 s TOAST, and the user who just wedged a share is watching the tab they were recording — the
  same reason the frozen-source banner is sticky — so it is now a sticky banner that stays until
  the user presses record; and it carries the ⌘Q escalation itself, because a user who never
  presses record again never reaches the second wedge that owned that text. The pre-reload state
  also says "Refreshing the app…" now, since reload() only REQUESTS the navigation and the page
  keeps running until it commits — seconds, on the machine that just wedged.
  STILL UNPROVEN AND STILL OPEN: whether the reload itself ran at all, and what "unresponsive"
  was. That needs the `[capture:arming]` console timeline from a repro with the game running, plus
  whether the sharing pill lit. Do not harden the ritual further from theory.

- [P1] Robert 2026-08-25: "4k game in other tab freezes, but not all the time and other inputs are fine."
  ONE REAL DEFECT FIXED, AND THE RIG'S OWN ANSWER RETRACTED. Fixed: `encodeComposite` advances
  `lastEncodedMs` even when it DROPS a frame for a full encoder queue (deliberately — otherwise the
  next source frame hammers a busy encoder), but the KEEP-ALIVE read that same field to decide
  whether anything had reached the file lately. So under sustained pressure every arriving-and-
  dropping frame reset the keep-alive's clock and it never fired: nothing at all was encoded for as
  long as the pressure lasted. Split into lastEncodedMs (attempted) and lastEncodeOkMs (actually
  encoded); new stat maxEncodeGapMs measures the longest hole in the file, which is what a viewer
  sees as a freeze. RETRACTED: the 4.0-4.8 s gaps this rig first reported were NOT a freeze, they
  were the rig paying a Chrome process's first-VideoEncoder init DURING the take (at t≈0.8 s), which
  production pays at MOUNT. Warmed with the production `warmVideoEncoder()`, the worst gap over a
  saturated 60 s take is 133 ms with ZERO drops. So NO mid-take freeze is reproduced under synthetic
  load and this entry does not claim one. WHAT ROBERT IS PROBABLY SEEING: the screen SOURCE starving
  under GPU contention — the composite then repeats its last frame via keep-alive and the picture
  stops changing while audio and the raw channels run on, which is exactly "other inputs are fine".
  That is Chrome's capture pipeline, and the biggest lever WE still hold is X6: the raw screen and
  camera channels still encode via SOFTWARE VP8/VP9 during capture, the largest capture CPU cost, on
  a machine already running a 4K game. NEXT: Robert console from a freezing take (`[capture] screen …
  delivering N fps` says whether the source starved), or take X6.
  RE-REPORTED 2026-08-26 ("i opened game in other tab, it froze") with no console again. The two
  asks stand unchanged and both are Robert's: (a) the console lines from a freezing take, and/or the
  O6 re-verify (`?nativeres=1`, record the game tab, report the console); (b) the X6 picture
  ruling, which is the capture-CPU lever this freeze keeps pointing at.
  AUTOPSIED 2026-08-26 (take rec_72y3unjtwmi4, X6 ON, Robert pinned "freeze is on 7:35" — exact): the
  game was captured WITH FULL MOTION for ~3.7 min while its tab was front (motion 4-56 per probe),
  then frames stop dead at t=455 (one stray frame at 466, frozen to the end) while TAB AUDIO KEEPS
  FLOWING to the last seconds — the picture-only inverse of the movie take's pair-stall, matching
  "froze when I switch on its tab": the 4K tab left the foreground and Chrome stopped compositing
  it for capture under GPU load. X6's CPU relief (starvation 1.6 % → 0.16 % on the same machine)
  did NOT save the source — this half is Chrome's compositor, not our encoder, and no app-side
  lever forces frames from a hidden crushed tab. The app's keep-alive held the last frame cleanly.
  Honest mitigation to tell users: keep a 4K game tab visible while it is being recorded. Levers
  left: O6 ?nativeres re-verify (console still unseen) and a Chromium report; O12 does not touch it.

- [P2] 2026-08-25, A CONSEQUENCE OF THE PADDING FIX, stated so it is not mistaken for a
  regression: holding the audio timeline against the wall clock converts "audio drifts early" into
  "audio has a short silence where the machine choked". The content is therefore DIFFERENT on a
  starved take, and the fidelity oracle's fixed 2.5 s analysis window can land on one of those
  silences: a batch of three oracles run back-to-back produced one toneErr=16.34 dB run that three
  subsequent solo runs could not reproduce (0.03, 0.70, 0.03 dB). Solo runs of every gate pass. The
  gate should learn to REPORT padding rather than fail opaquely — it is the same capture-starvation
  family already documented for this oracle, now with a louder signature.

- [P1 → INSTRUMENTED 2026-08-26, NEXT TAKE NAMES THE KILLER] Robert (same day, after the desync fix):
  "in long video tab audio still dies after a while."
  RULED OUT — OUR PIPELINE DYING WITH LENGTH: a 12.5-minute run of the production measured-audio
  path in a real (hidden-tab) browser delivered batches end to end, padded 417 ms total, no
  runaway, no stop. Synthetic sources cannot go quiet, so what dies on Robert's takes is UPSTREAM of
  the pipeline: the display-audio TRACK or its source. Chromium is known to MUTE a captured tab's
  audio track (crbug 40703184 family), to END display-audio tracks on audio-device changes
  (crbug 344876285 — AirPods auto-switching is that case), and a paused/idle source simply stops
  producing. All three record IDENTICAL digital silence, which is why every report so far arrived
  without a cause.
  SHIPPED (evidence, additive, zero behaviour change): the channel now testifies —
    · track `mute` / `unmute` / `ended` stamped to the console with take-relative times
    · AudioContext state changes stamped (a device-switch stall lands there)
    · a SILENCE WITNESS: stop() computes `silentTailMs` and warns "input was PURE SILENCE for the
      final Xs — went quiet Ys into the channel" (floor 1e-5, below anything live or dithered)
    · every measuredAudio console line now carries its channel name; stop() returns
      silentTailMs + paddedMs; the syncload `measured` lane reports silentTailSec.
  RED-PROVEN in the app: a live-but-silent stream read silentTailMs 14,688 of a 14,688 ms channel
  with the warning; dispatched mute/unmute logged at +3.2 s/+5.2 s; paddedMs 0 — silent input and
  a starved clock are correctly told apart.
  WHAT CLOSES IT: the console of Robert's next long take. Whichever line fires is the killer, and the
  fix (ours, or a crbug we work around, or a UI surface for a dead channel — Robert's call) follows
  from it. Do not harden anything here from theory before that console arrives.
  Robert's SHARPER OBSERVATION, same day: "maybe audio dies when one youtube video ends and other
  starts, but i maybe wrong." THE LAB TRIED EXACTLY THAT SHAPE AND CANNOT REPRODUCE IT — a new rig
  (`npm run exp -- tabaudio '{"gapSecs":45}' --keep-audio`, cross-tab variant adds
  `{"crossTab":true}` + `--refocus --capture-title=TONECHILD`) drives the REAL getDisplayMedia
  path with Chrome's auto-accept testing flags: plays an audible tone ("video 1"), tears it down
  like a player, sits silent 45 s, plays a new one ("video 2"), recording through the production
  measured path the whole time. BOTH topologies — capturing its own tab, and capturing a separate
  hidden child tab (Robert's, but harsher) — bring video 2 back at full level: 0.4 peak captured,
  ZERO mute events, silentTail 0. A THIRD shape (`{"occlude":true}` + `--headed --real-throttling`:
  one continuous tone, the captured window fully COVERED for 35 s mid-run) also fails to kill it —
  audio sails through occlusion at full level. Negative results recorded so no shape is re-run blind.
  **THE FIELD AUTOPSY, 2026-08-26 (Robert: "not fixed"), read off the dying take ITSELF before Robert
  discarded it** — via a browser session on the app origin: IndexedDB recording + OPFS channel
  files decoded in place. The take: 7.7 min of a subtitled movie in a captured tab. THE EVENT AT
  6:36–7:02 (26 s): the SCREEN channel freezes on ONE mid-dialogue frame, DIMMED (luma 36→21.7,
  residual motion 0.02–0.08 ≈ a spinner), the tab-audio channel goes digitally silent the same
  instant, the MIC records normally throughout, and both halves recover TOGETHER at full level.
  No track end, no stall mark, channels full length. So "tab audio dies" is really "THE DISPLAY
  PAIR dies together, then self-recovers", and the LEADING explanation is that THE PLAYER ITSELF
  STALLED (buffering/stall: dimmed frozen frame + spinner-scale flicker + silence is exactly that
  signature) — i.e. the recording is FAITHFUL, and the stall plausibly comes from capture's own
  CPU load starving the player (the documented contention family). The rival — a Chromium
  display-capture outage — is not dead, but three lab shapes failed to produce it and the DIMMING
  is a player behaviour, not a capture one. The discriminating test (subtitle continuity across
  the resume: paused players resume the same sentence) was lost when the take was discarded
  mid-analysis. PROTOCOL FOR THE NEXT DYING TAKE: DO NOT DISCARD IT — say so, and it gets the
  same remote autopsy in minutes; the witness build (live on prod) also logs mute/ended/silence
  in the console as it happens. If the buffering story holds, the fix is capture CPU = THE X6
  RULING, which every investigation of this family now terminates at.
  **SECOND AUTOPSY, SAME DAY (Robert kept the take — the protocol worked): the audio-only death is
  REAL and PROVEN.** Take rec_cjqcxsfhg02b (17:17Z, 7.5 min): tab audio dies at t=71 s ("completely
  dies in 1:10" — exact) and records PURE ZEROS for the remaining 380 s, while the SAME share's
  SCREEN channel delivers a playing movie the whole time (motion 9-44 at every probe after the
  death) and the mic lives to the end. Channels full length, no stall, no track end, no clipping
  in the tab audio before death (max 0.82; the MIC touches 1.0001 — the other session's clipping
  thread). So this is an AUDIO-ONLY capture death on a live share — the Chromium class where a
  MediaStreamSource goes permanently silent (device change family) or the track mutes forever.
  TWO DISTINCT MECHANISMS are now confirmed across takes: the display-PAIR stall (movie take,
  likely player buffering) and this audio-only tap death.
  **SHIPPED against it (2026-08-26): THE DEAD-TAP REVIVAL + BLACK-BOX DIAGNOSTICS.**
    · measuredAudio watches its own input: after 5 s of PURE digital silence on a live, unmuted
      track it rebuilds the source tap on a CLONE of the track (cloning re-taps the capture),
      with 5/10/20/40/80 s backoff and then ONE ATTEMPT A MINUTE for as long as the silence
      lasts, reset by any signal.
      Safe by construction: it only acts when the channel is already recording nothing, the
      worklet keeps the timeline sample-counted through the swap, and on a genuinely silent
      source the swap just yields the same silence. A muted or ended track is logged, not
      "revived" (Chrome owns the mute). RED-PROVEN in-browser: silent live stream → revivals at
      5.1/10.1/20.1 s, duration intact, 0 padded; GREEN: audible stream → zero revivals.
    · ChannelRecording.diagnostics (types.ts, additive): paddedMs, silentTailMs, revivals, and
      the track/context event log (mute/unmute/ended/ctx-state/revive) persist WITH THE TAKE —
      the console dies with the tab; the file now carries its own testimony, and the remote
      autopsy reads it without asking Robert for anything.
  **FIELD-PROVEN THE SAME DAY** (take rec_c1hqf2rjvv8o, 17:44Z, 84 s of YouTube music — the first
  take whose black box came back from the field): the tap died mid-music at t=71 s — the SAME
  death that cost the previous take its remaining 380 s — the revival fired at 76.2 s and the
  music is back at 78.2 s. Cost: 7.2 s of silence instead of everything after. A second, benign
  fire at 5.2 s on pre-roll silence cost nothing, as designed. The deaths keep HAPPENING (that is
  Chrome + a starving machine); the revival turns them from take-enders into blips.
  THE SAME BLACK BOX also quantified the starvation behind "music sounds shitty and sometimes
  goes faster": in 84 s the mic padded 1547 ms and the tab audio 1281 ms — the audio clocks lost
  ~1.6 % of wall time and the hold repaid it (no drift), but the CONTENT Chrome delivered under
  that load is time-compressed and mangled at the source, which no clock can restore (and Robert's
  parallel VLC sounding fine confirms the machine's audio output is healthy — it is Chrome's
  capture pipeline being crushed). The load lever remains X6. Music also peaks at 1.20 (1.42 on
  the movie take) — above-full-scale floats feeding the loudness/clipping thread.
  HARDENING with it: revival clones are tracked and stopped on pagehide — a page dying mid-take
  (the wedge-refresh ritual) must not leave a clone holding a display-capture claim, which is the
  exact food of the screen-wedge family.
  **THIRD AUTOPSY, 2026-09-01 — "tab audio died at 23 minute (50 min take, max quality), before it
  a lot of lag in sound, other input all right". THE RESCUE WAS RETIRING, and that is the bug.**
  Read off take rec_78ogcw052vdn's own black box (3,026 s, quality=max, screen 3024x1964@30, camera
  1280x720, no composite): the track was LIVE AND UNMUTED for the whole 50 minutes — no mute, no
  unmute, no ended, no AudioContext state change — and the tap died and was rescued repeatedly:
  25 attempts in six bursts, 5.2/10.2/20.2/40.2/80.2/160.2 | 194.4…349.5 | 460.1…535.1 | 712.7 |
  1333.4 | 1381.3…1536.4 s. The burst structure convicts the six-attempt LIFETIME CAP twice over:
  the runs beginning 707.7 s and 1328.4 s each took ONE attempt and never a second, so sound was
  back within 5 s — THE CLONE RESCUE WORKS; and the run beginning 189.4 s burned all six by 349.5 s
  and sound came back on its own before 455.1 s, MORE THAN 105 s AFTER THE LADDER GAVE UP. The
  final run began 1376.3 s (22.9 min — his "23 minute", exactly), spent its six attempts by
  1536.4 s, and the take ran 1,490 s further with NOT ONE more attempt: silentTailMs 1,650,144 of
  a 3,026,276 ms channel, 14 MB of opus where the mic wrote 48 MB. "A lot of lag in sound" before
  it is the same defect earlier on: the four dropouts before the fatal one, two of them minutes
  long because the ladder retired inside them.
  FIXED: `capture/reviveSchedule.ts` (pure, 7 unit tests). The gap to the next attempt doubles but
  never exceeds a 60 s CEILING — 5/10/20/40/80/140/200/260/… — and there is no cap, so a dead tap
  is looked at once a minute for as long as the take runs. Cost on a channel with genuinely nothing
  playing: one `track.clone()` + one source-node swap a minute, on input that is already silent.
  The only shipped attempt that MOVES is the sixth (140 s instead of 160 s).
  STILL OPEN, and it is load, not audio: the tap died SIX TIMES in 23 minutes on this machine.
  `quality=max` disables every step-down by Robert's own ruling (captureQuality.ts), so the answer
  there is X6, not a lever this file can pull. paddedMs was only 5,647 ms of 3,026 s (0.19 %), so
  the AUDIO clock was not the thing starving — Chrome's display-audio tap was.

- [P1 → FIXED AGAIN 2026-08-26, AWAITING ROBERT RECHECK] Robert: progressive audio desync — 08-25 report
  "sounds go faster than video" ~20 s in; 08-26 RECHECK FAILED: "mic and camera unsynch is about
  1-2 second was on 6 minute" (YouTube in another tab) and "all record tab audio become worse and
  worse and almost nothing just noises in the end" (game opened mid-take).
  THE 08-25 FIX WAS REAL AND REACHED NOTHING Robert HEARS — the same shape as the peakRobust dropped
  fields, and it is why the recheck failed. Two defects, found from the recheck report:
    (1) measuredAudio.ts — the mic/tab channels EVERY export mixes from — updated `lastArrivalMs`
        to the current batch's own arrival BEFORE computing `steady` against it, so steady was
        always false inside the 3 s origin window, the wall origin stayed Infinity and THE PAD
        NEVER FIRED on any real take. Dead code, shipped as verified, because the syncload rig
        only measured the composite's copy (whose audio no export carries — TASKS note 14).
    (2) the composite's copy padded on INSTANTANEOUS lateness of `recvMs` (a main-thread receipt
        stamp), so a main-thread stall whose queued batches deliver every sample moments later
        spliced spurious silence in and walked the audio late by the take's worst stall.
  FIX: one shared planner, capture/wallClockHold.ts, used by BOTH paths — the pad is the MINIMUM
  deficit that PERSISTS across a 1 s settle window (a burst erases it, a real loss stands); a real
  loss is padded up to ~1 s late as the price of never padding a false one. 9 unit tests pin both
  regressions. MEASURED in a real browser, loaded 60 s cell: independent clock probe says the
  context lost 4333 ms; the measured channel padded 4097 ms and landed −163 ms vs wall; idle
  controls pad ZERO (−15/−24 ms). syncload now carries a `measured` lane so the shipped audio path
  can never go unmeasured again. Gates: 458 tests · oracle PASS v2 (66.4 ms) AND v1 (52.6 ms).
  STILL OPEN AND DELIBERATELY NOT CLAIMED: the "noises" themselves — starvation mangles the audio
  it DOES deliver, and padding cannot resurrect audio the context never rendered; under a game the
  take now carries honest gaps instead of an accumulating slide. The lever on the starvation
  itself is capture CPU = the X6 picture ruling Robert owes. Robert recheck: a long take beside YouTube
  and one beside the game; the console says `[capture] measured audio padded …ms` when it fires.

- [P1 → FIXED 2026-08-25, AWAITING ROBERT LISTEN TEST] Robert: "audio quality regressed from before we
  updated roadmap and mass execution". FOUND, and the code had already written down the cost in a
  comment nobody came back to: on 2026-08-23 NORMALIZE_PEAK_OVERDRIVE went 2 → 4, which licenses the
  makeup gain to drive true peaks to 3.8 instead of 1.9 — "peaks are now squashed up to ~11.6 dB
  rather than ~5.6 dB, which is what loudness always costs. Raise no further without a listen test."
  Robert's listen test has now arrived and it says no. THE RAISE WAS TREATING A SYMPTOM: it existed
  because ONE SHARP TRANSIENT set `peak` and capped the whole take's gain (the take landed 1.4 dB
  under target), so loudness was bought back by crushing harder. The defect was never the licence, it
  was the STATISTIC — a single sample must not define a take's headroom. FIX: the bound now reads
  `peakRobust`, the p99 of per-window peaks over the same 100 ms windows the loudness already uses,
  measured on BOTH the export probe and the capture-time accumulator; with a statistic a transient
  cannot own, the licence goes back to 2. Takes recorded before the statistic existed keep the raw
  peak AND the old licence of 4 (NORMALIZE_PEAK_OVERDRIVE_RAW), so no existing file changes
  behaviour — pinned by test. Proven: the 08-23 take now reaches target AND its sustained programme
  lands under 2.0 instead of 3.8. 421 tests green.
  **THAT FIX WAS REACHING NOBODY, AND X1 FOUND IT ON 2026-08-26.** `peakRobust` was computed in both
  places and then DROPPED on the way to both consumers, so every export was still running the old
  licence of 4 on the raw `peak` — the exact regression Robert reported:
    · `session.ts` built `recording.loudness` field by field and never copied `acc.peakRobust`, so
      every take on disk read `peakRobust: undefined` → RAW licence. That is the capture-stats path
      (unedited exports, the editor's preview loudness).
    · `measureMixLoudness` destructured three fields of `measureMixEnvelope`'s four and returned
      `{ peak, loudRms, floorRms }`, so the PROBE path — every take without capture stats, and every
      edited export — did the same. Found by X1's rig lane printing `probe.peakRobust: 0`.
  Both are one line each and both are fixed; a unit test now pins the probe passthrough (a single
  full-scale spike over sustained 0.2 programme: `peak` > 0.9, `peakRobust` < 0.25). Robert's listen test
  is still owed — but it is owed on a build where the fix is actually in force, which no build before
  2026-08-26 was.

- [P1] 2026-08-26, FOUND BY ROBERT'S EYES on the X15 artifacts ("c shit is worse colors") and then
  measured: **coloured text loses about 30 % of its colour, all of it at capture, and the composite
  is responsible for a third of that.** Saturation kept against the canvas the source actually
  painted, masked by the source's own palette (`npm run exp -- x15c`, warmed, two runs within 2 pts):
      source 100 %  ·  raw screen channel green 80.0 / blue 89.3  ·  composite green 70.3 / blue 75.2
      instant export = the composite, byte for byte  ·  render green 67.3 / blue 78.3
  Grey text barely moves, so this is not brightness or gamma — it is 4:2:0 chroma subsampling on thin
  coloured glyphs. A raw channel costs ONE chroma generation; the composite costs a SECOND (capture
  frames arrive 4:2:0, the GL painter upsamples to RGB, the AVC encode re-subsamples), and the
  unedited export copies that file verbatim.
  WHY NO EXISTING GATE CAUGHT IT, and this is the lesson: every comparison we had — X5's, X15's own
  pair rows, the oracle's — compares a file with ANOTHER FILE. A loss that every path shares cancels
  to exactly zero in those. It is only visible against the source, which for a real take has to be
  reconstructed rather than captured. `chromaRows()` in perf/textSource.ts is that measurement now.
  ONE OF THE TWO LEVERS IS SHIPPED (O3b, 2026-08-29): a screen-only take at exactly the export
  geometry now packet-copies the RAW CHANNEL, so the unedited export keeps **80.0 % green / 89.1 %
  blue instead of 70.3 / 75.2** — and it is better on luma too (37.3 dB against 35.5 against the
  source, fringe 8.66 against 10.24) and FASTER, because the file it copies is one we did not have to
  make. It costs 14-23 % more download; the colour half of the win is structural and is NOT bought
  with those bytes. `?singlegen=off` reverts. No help for a take with a camera, or for a window share
  whose geometry is not the selected step's — both still composite (O3c made the equality follow
  the step; F13 made the composite follow the take's ASPECT, not its pixel count, so a native-res
  1440p/4K screen still declines the CAPTURE half — that one is F16's). The rest needs **4:4:4 at capture**, which on this
  machine is software only (AV1 profile 1: 80 fps at 1080p against 207, ~2x CPU — X15(b)). Robert has the
  crops: ~/Downloads/x15-text-truth/, c-00-SOURCE against c-01-instant; `npm run exp -- o3b
  '{"crops":true}'` writes the new before/after pair.
  NOT A REGRESSION and not new — it is how every take this product has ever made behaves.
  THE ATTRIBUTION IS NOW CONTROLLED, NOT ASSUMED (R1, 2026-08-29). 4:2:0 subsampling and a YUV
  matrix/range round-trip drift leave the SAME fingerprint on this fixture — saturated glyphs fade,
  grey holds — so every stage above was consistent with either, and the 4:4:4 case rests entirely on
  it being the first. The rig now runs a matched control pair: the identical palette as FLAT SLABS
  and as thin glyphs, through ONE identical AVC 4:2:0 encode. Slabs keep green 101.1 / blue 99.8 %
  (subsampling has no detail to average there); the same page's glyphs keep 79.8 / 82.1 %. It is
  subsampling on thin glyphs — but WHOSE subsampling was still assumed, and the answer changes the
  plan.
  THE SOURCE IS ALREADY 4:2:0 BEFORE OUR ENCODER SEES IT (2026-08-27, on Robert's "how to fix it").
  measuredVideo.ts now logs the first frame's pixel format per raw channel, and a take reports
  `format NV12 · coded 1920x1080`. NV12 IS 4:2:0. So in a REAL take the chain is:
      canvas/screen RGB → NV12, by Chrome's capture pipeline   ~20 points, and NOT OURS
      NV12 → our AVC 4:2:0 encode                              ~free (4:2:0 into 4:2:0)
      NV12 → GL upsample → composite → AVC re-subsample        ~10 points more, ours — O3b's win
  R1's slab/glyph control and lane (b)'s 100 %-retaining AV1 4:4:4 row were both measured feeding a
  VideoEncoder RGB frames DIRECTLY (`new VideoFrame(canvas)`), with no MediaStreamTrack in the path.
  That is why they see the encoder do the subsampling. Capture never does that — it can only get
  frames through a track, and the track hands over NV12. So "4:4:4 will deliver what this entry
  promises" is NOT established: at capture it would be encoding chroma that has already been thrown
  away, and could only buy back the SECOND generation (~10 points) that O3b already removes for
  screen-only takes. For a take WITH a camera it is ~10 points for software encoding at ~2x CPU.
  MEASURED ON THE SYNTHETIC SCREEN, WHICH IS A CANVAS — and if a canvas in our own process arrives
  NV12, a real OS screen capturer is unlikely to be better. Robert's next real take prints the format
  on the console; that is the confirmation, and it decides whether 4:4:4-at-capture is dead or merely
  expensive. Do not spend anything on 4:4:4 capture before that line is read from a real take.
  100 % IS REACHABLE AND IT IS A RESOLUTION LEVER, NOT A CHROMA-FORMAT ONE (2026-08-29, Robert
  "i want 100% colors"). 4:2:0 halves chroma in each axis OF WHATEVER IT IS GIVEN, so the samples a
  file carries are absolute: a 2x-resolution 4:2:0 file has one chroma sample per pixel at 1x.
  `npm run exp -- x15e`, every rung at equal bits per pixel, downscaled to 1080p as a player would:
      1x 4:2:0 (ships)  584 KB  green 79.6 / blue 81.7      1.5x 4:2:0  982 KB  green 96.9 / blue 99.0
      2x 4:2:0         1343 KB  green 96.0 / blue 98.3      1x 4:4:4    668 KB  green 99.6 / blue 97.9
  1.5x ON THE HARDWARE ENCODER MATCHES THE SOFTWARE 4:4:4 CEILING, at 1.68x the bytes; 2x buys
  nothing over 1.5x. So the answer to "100 %" is: capture and DELIVER at ~1.5x the viewing size.
  O6's `?nativeres=1` already stops the down-cap, and on a 2x display the capture frame is the
  supersample — what is missing is delivering at that resolution instead of the 1080p step.
  STILL UNMEASURED, one console line: whether Chrome hands us the screen at native resolution or
  already downscaled. measuredVideo.ts logs `format ... · coded WxH` per raw channel on every take.
  The rig cannot self-serve this — headless has no desktop picker and the probe hung a run for ten
  minutes before it got a deadline.
  AND GREY'S NUMBER IS NOW HONEST: "grey barely moves" used to be argued from a keptPct that divides
  by a 7.4 % source saturation, so +-1 LSB of decode noise arrived as +-6 points. In absolute
  saturation points grey moves -2.1 against green -13.5 and blue -13.0 — same argument, no amplifier.

- [P2, was P1 — SETTLED IN PRODUCTION 2026-08-26 by X15(c), `npm run exp -- x15c`] **a trim does
  change how a take's text looks, and the change is ~2.8 dB below what a plain re-encode costs
  anyway — much smaller than the lab number implied, and it does not reach the path a user gets.**
  One real take (still code-editor screen + camera PiP), exported three ways through the product's
  own ladder, screen region, worst of four instants:
      instant ↔ smart cut   99 dB · max 0     — BIT-IDENTICAL
      instant ↔ render      37.1 dB (mean 37.9) · max 56 · 7.7 % of pixels off by >8 · fringe 4.03
      the CONTROL: one re-encode of the instant frame alone   39.9 dB · max 50 · 3.8 % · fringe 3.00
  THE CONTROL IS THE POINT AND IT IS WHY THIS DROPS TO P2. `compose/smartCutFlag.ts` already records
  ~37.5 dB as "the ceiling for two independent encodes of one frame", so a bare 37.1 dB proves
  nothing; measured against a re-encode of the very same picture, the render costs 2.8 dB more and
  doubles the share of visibly-wrong pixels (7.7 % against 3.8 %). Real, bounded, and an order
  smaller than "max 156 on 3.8 % of pixels" suggested.
  AND THE PATH A USER ACTUALLY GETS IS UNAFFECTED. The backlog entry assumed a trim takes the render;
  it does not — SMART CUT has been the default since 2026-08-25 and copies the composite's packets,
  so a trimmed take is BIT-IDENTICAL to the untrimmed one. The render's number is what a user sees
  only when smart cut declines.
  WHAT IS LEFT FOR ROBERT, not engineering: whether 2.8 dB of extra glyph fringe on the render path is worth
  anything. It also re-prices X5, whose refusal rested on the two painters disagreeing.

- [P0 → ROADMAP B9, ROBERT-GATED] 2026-09-01, and it replaces this slot's old B8 entry outright:
  **an unedited or trimmed export writes its picture late against its own sound.** session.ts rebases
  the composite at stop with `Math.max(0, composite.startOffsetMs - minOffset)`, so a composite whose
  clock starts before the earliest channel loses that offset entirely — 64 to 198 ms on FIVE of seven
  measured takes. instant.ts and smartCut.ts then place the copied packets that much late, while the
  audio beside them is mixed from the RAW channels on the recording timeline. Measured as −2.25 to
  −6 frames of PiP displacement against the render, tracking the discarded ms take by take, with the
  composite file itself corroborating: its audio track starts at 0 ms and its video at 133–300 ms.
  THE OLD B8 ENTRY HERE (“the render places the PiP −0.5 s away”) WAS THE INSTRUMENT and is deleted:
  −15 was one badly-localised sample of a four-sample search, on a take whose live composite was
  dropping a third of its frames. `npm run exp -- x15c` now reports the whole census, excludes an
  instant it could not localise, and gates the CAUSE in milliseconds. Full diagnosis: B8's handoff
  in `.ai/TASKS`.

- [P2 → ROADMAP G3] 2026-08-26, found while writing X9's gate: **two of this repo's evidence gates are written
  in `longtask` counts, and a long-task count cannot fail here.** Anything in this codebase that
  awaits per frame or per sample — the render, the For-AI build, the AI selection loop — never forms
  a single ≥50 ms task while still owning the thread end to end, so the counter reads 0 on the
  blocking lane and 0 on the non-blocking one. The O5 rig learned this in August, X9 relearned it in
  August, and the shared instrument that replaces it now exists (`perf/mainThreadWatch.ts`,
  SchedulingDelayWatch). WHAT IS LEFT: audit the remaining rigs for gates phrased as long-task counts
  and move them onto scheduling lateness, and re-read any band whose green rests on one. Not urgent —
  no shipped claim is known to depend on it — but every such gate is currently decoration.

- [P2 → ROADMAP G2] 2026-08-26, found while verifying the wall-clock hold: **every makeRig-based rig
  (syncload, o4step2 family) is DEAD in headless Chrome on this machine — Chrome 151 stops
  delivering canvas-capture frames to an uncomposited window.** The page console (now captured)
  shows sources at 15.9 fps for the first seconds, then 0.0 forever; the composite degrades
  ("only 1.2 fps reached the file"), and a degraded stop DELETES its blob (liveCompositeV2), so
  every cell died as an opaque `blobStore: no blob stored` — including at git HEAD, so this is
  environmental, not a regression of ours. A HEADED run in an occluded window fails the same way,
  and the app-pane browser throttles rAF (0 fps) and intervals (1 Hz) when hidden. Mitigations
  shipped: makeRig paints on setInterval, not rAF (the loadedSync load painter's own lesson), and
  cdp-run.mjs prints the page console tail on failure so the next dead run says why. The oracle's
  synthetic path is unaffected (v1+v2 both PASS the same day). Until Chrome's behavior is
  understood, run makeRig-family rigs in a VISIBLE unoccluded window (the syncload numbers of
  2026-08-26 were taken in the app pane, fronted). The 08-25 numbers were taken on Chrome 150.
  SAME DAY, second lesson from the same rig: loadedSync used to THROW on reading the composite's
  blob, which a degraded take deletes — discarding the measured lane and clock probe it had
  already collected. A 12.5-min cell paid for that; the rig now reports with null spans and the
  degradeReason instead of throwing.

- [P2 → ROADMAP G3] 2026-08-26, found while wiring X2: **O1's MEMORY lane samples the wrong thread, and its
  headline gate metric is absent.** `runO1Evidence` polls heap on the MAIN thread while the export
  renders in a worker (since O5a), and `measureUserAgentSpecificMemory` is unavailable in the rig's
  Chrome — `totalSamples: 0`, `totalPeakDeltaMB: null` on every row, and the heap deltas it does print
  (0.1-0.2 MB) are the main thread's, not the export's. The scratch and buffer lanes therefore
  extrapolate to the SAME 145 MB at 30 minutes, which is exactly what O1 exists to distinguish. The
  number O1's claim actually rests on is sound and comes from the right place: `targetHeldMB` is
  ScratchStats, measured inside the worker and forwarded. FIX: sample from inside the export worker
  and post the high-water back with the done message, or run the rig cross-origin-isolated so
  measureUserAgentSpecificMemory exists. The related lever bug (flags flipped on a thread that no
  longer renders) is already fixed.

- [P1 → ROADMAP G4] 2026-08-25: NOTHING HERE HAS EVER BEEN MEASURED ON A TAKE LONGER THAN 30 s, and Robert records
  938-1800 s. `runOracle` defaults to 6000 ms and the matrix's widest cell is 30 s, so every sync,
  drift and throughput number this project quotes describes a take up to 156× shorter than the one Robert
  complained about. Measured at 120 s on a /tmp mirror of the shipped build (a second live session was
  editing this worktree; its saves reload the harness page through HMR and killed two earlier runs):
    render path   symmetric 34.5 ms mean / 46.8 max, and FLAT — all 119 flash/click pairs returned
                  the SAME offset across the two minutes
    instant path  67.3 / 96.4 ms after 89e250e — it read 117.2 / 153.8 at the SAME length before that
                  fix, against 97-102 at 6 s, i.e. the defect grew with length and the 6 s gate
                  under-reported it by ~20 %
    smart cut     the trimmed export took smartcut at 1384 ms against the render's 17616 on the same
                  take — 12.7×
    drift         beta−1 = −0.003 ms/s → 2.8 ms across Robert's whole 938 s take
  So DRIFT IS DEAD as an explanation for what Robert hears: whatever is off is a CONSTANT offset.
  ACTION: one ≥120 s cell before any flip that touches the packet-copy paths — a 6 s gate passed the
  instant path's own defect while it was 20 % worse at Robert's scale.

- [P1 → ROADMAP B7] 2026-08-25: THE TWO ALIGNMENT ERRORS A SYNTHETIC RIG CANNOT SEE, both pushing audio LATE.
  (1) the mic anchor subtracts only the platform-REPORTED track latency (measuredAudio.ts) — a
  Bluetooth headset's real 100-300 ms is invisible to it, and Robert's 15-minute Zoom take is exactly that
  case. (2) the video channel is anchored to the `recorder.start()` CALL (session.ts:588), not to when
  its first frame landed: a canvas delivers instantly on the rig, a real getDisplayMedia surface does
  not — the composite's own first frame took 233 ms in the same run. Neither is measurable without
  instrumenting a REAL take. Next step is to put the alignment inputs into the file's certification
  (each channel's startOffsetMs, the raw anchor, the reported input latency, the first-frame delay) so
  the next field report arrives with numbers instead of an adjective.
  NEW FIELD EVIDENCE, Robert 2026-08-26: "mic/camera unsynch in beggining of video seems to be smaller
  on other try" — a CONSTANT start-of-take offset that varies take to take and shrinks on a warm
  second try, which is exactly the signature of (2) (a cold first take pays device/recorder spin-up
  inside the anchor) and/or (1). Distinct from the progressive drift fixed the same day; nothing
  shipped today touches the start offset. The certification instrumentation above is still the step.
  STATUS AFTER THE DRIFT FIX + X6 FLIP (Robert, same day: "camera video/mic little unsynch"): the
  desync is down from seconds to "little" — what remains is this constant-offset family. With X6
  default the camera runs measuredVideo (arrival-stamped, min-filtered), so error (2) changes
  shape; the next step is unchanged — put the alignment inputs (anchor, reported latency,
  first-frame delay) into ChannelDiagnostics/cert so a field take carries the numbers, then
  compensate from measurements, not theory. X14 (≤20 ms) stays blocked on platform deliverables.

- [P2] 2026-08-25, ONE OBSERVATION, NOT REPRODUCED: the audio-integrity spur gate read −34.6 dB
  against its −40 dB band on a 120 s run of HEAD (7c9a02f). The same build at 6 s read −52.3 (pass)
  and the previous build at 120 s read −56.7 (pass), so this is either machine load — the metric is
  known load-sensitive — or something length-dependent in the mix. Re-run 120 s on a quiet machine
  before believing either.

- [P2 → ROADMAP G1] Oracle returns ALL-NULL metrics (and exit 0!) under machine contention — instrument must retry or fail loudly, never emit null-as-result. PARTLY ADDRESSED: oracle.mjs retries and fails loud on incomplete metrics (merged, 86ed200). Still open: the fidelity runner has no equivalent retry — it reads RED (toneErr 1.1-2.3 dB) purely from machine load, which is capture starvation and not a mix regression. Needs the same retry/quiet-machine guard.

- [P2] Sync is ~45-63 ms audio-late, not the ~30 ms previously believed (2026-08-23: the oracle was ~31 ms optimistic — exact 18 ms detection bias + an unmeasured 13.5 ms video reference). Robert can feel it — re-confirmed 2026-08-24 on a real tab-music take (YouTube music video), which matches the measured offset; no new fault implied. Cause understood and partly compensated. 2026-08-24: the v2 engine is now the DEFAULT and reads 33-48 ms on the oracle against v1's ~60 — users get the better number today; closing the rest to ≤20 ms is anchor work (input latency both engines share), tracked as O4-polish. Awaiting Robert listen test on a real take.

- [P2] Robert 2026-08-24: files too large for the quality on motion-heavy takes (YouTube music video).
  Structural to the v1 engine, not a regression: an unedited export packet-copies the live composite,
  whose MediaRecorder runs at a flat 8 Mbps ceiling with generic tuning — on motion the ceiling binds
  (~60 MB/min) and quality-per-bit is whatever MediaRecorder gives, no knobs. The shipped size levers
  do not touch motion (O11b GOP stretch: −23.8 % screen, −0.3 % motion; O11c is the camera PiP only).
  Lowering the ceiling was measured and rejected as a size step (F7b — it is a quality lever, O9's).
  What moves it: O4 owned encoder + rate control — SHIPPED 2026-08-24 (v2 is the default engine:
  frame-driven draw means static spans now cost ~1 fps of bytes; motion still rides the 8 Mbps
  ceiling) — then O5/O9 quality-per-bit, and O11d codec ladder (25-40 %, blocked on P1's Playwright
  install; default file stays avc for blind shares, so the rung flips only where the recipient is
  known). Robert RE-JUDGED 2026-08-25: 300 MB / 5 min on a 4K game take — 60 MB/min, the 8 Mbps ceiling
  EXACTLY, so the ceiling still binds on motion as described (v2 helps static spans only) and this
  is the expected size of the current build, not a regression. Levers unchanged: O9 quality-per-bit,
  O11d codec ladder, X13 (Robert-gated). while a 20-run headless oracle matrix hammered it — slow load / unresponsive modal / "waiting to connect" / mic-timeout likely environment artifacts. RETEST on clean prod build (serve main at localhost:4173). Rule going forward: Robert's QA only on a dedicated prod-build port; load tests spawn their own ephemeral server, never 5173.
- [P1] Camera light at app load (Robert report, pre-any-click?) — if reproduced on the clean 4173 build this violates 'no idle device access, ever'. Note: light DURING the screen picker (after record click) is the approved concurrent-acquisition design; need Robert to distinguish which they saw.
- [P1] Fix tab/browser music recording quality — root-caused and shipped a 3-part fix (2026-07-15): tanh waveshaping distorted ALL rendered audio (now identity below 0.95 knee); composite hard limiter (−6dB/20:1) pumped music (now bypassed for single source, gentler −3dB/12:1 safety net for multi); unreported channelCount defaulted to mono downmix (now stereo). Awaiting Robert listen test on real tab music to close.

### Next

- [P2] Oracle arrival probes date frames by READ time, not by the frame's own timestamp. Both
  `probeBeepArrivals` and `probeFlashArrivals` (src/experimental/oracle/rig.ts) stamp
  `performance.now()` when JS reads the AudioData/VideoFrame, so the reference carries the delivery
  latency and main-thread scheduling on top of the media's own clock. G5 (2026-09-01) removed the
  frame-phase lock that used to dominate the sync gate's run-to-run scatter and left 6.5 ms per run
  that is nothing else in the chain: not the beep reference (residual sd 0.43 ms), not the estimator
  (every candidate within 0.5 ms), not the event sets (aligning costs 0.0 ms). Record BOTH stampings
  in the probes, report the difference, and the next reduction in this instrument's noise is visible.

THE ROADMAP LIVES IN `.ai/TASKS` — not here. That file carries the READY map, every task with its
gates, what a fresh session must know first, and the tooling index; it is rewritten on every merge.
Duplicating it here is how the two go out of step, so this section is a pointer on purpose.
Protocol: say "roadmap" in any session → READY map → "go <id>".

### Later — deliberately inactive

- [P3] Distributed multi-device capture: run the gated two-device sync spike with kill criteria before product work. One authoritative mic/scene; no sub-ms mixing claim. Robert 2026-08-22: "we'll need it eventually" — gating unchanged. SHAPE DICTATED 2026-09-01 (Robert): no QR ceremony — ONE ACCOUNT is the pairing ("i open mac app - start record, open iphone app - on mac in inputs i see iphone camera and i start"). Same-account presence (supabase realtime, already in the stack) surfaces the signed-in phone as an input chip beside Screen/Camera/Mic — unavailable states ride the existing red-chip machinery. Under it, TWO streams device-to-device (LAN-direct WebRTC, cloud only introduces them): a rough low-latency monitor feed for framing/PiP placement, and the phone's OWN full-quality recording shipped as fragments seconds behind with retries — the take is built ONLY from the second, so network trouble degrades what you SEE, never what you KEEP. The composed frame streams back to the phone (it is a camera AND the director's monitor). Sync = clock pings + room-audio correlation with continuous drift fit (WallClockHold family); the finished take certifies its own sync bound. A remote-angle take re-renders on export (the monitor feed is never saved, so no packet copy). Phone must be unlocked, app foreground — Apple's rule; the phone's screen is the monitor anyway.
- [P3] Cursor-excluded capture + vector cursor re-render (sharp at any zoom, click ripples) — Robert "maybe someday"; P4 designs the metadata track for it, builds nothing.
- [P3] Local quality models (camera background blur, ML denoise) — Robert "maybe later". Boundary (ledger 08-22(3)): no AI product features ever; local quality models allowed when revisited; deterministic DSP ships first.
- [P3] Server-side auth-user deletion hook (the client already deletes user-owned objects/rows).
- [P3] Image/screenshot capture channel.
- [P3] Pre-cut capture — the recording prepares itself to be edited: force a composite keyframe at each speech-onset-after-silence (the loudness tap already sees them, min-spaced against KEYFRAME_INTERVAL_SEC), so later cuts land on GOP boundaries and an edited export becomes packet copy of kept GOPs + re-encode of the rare seam GOP, instead of a full render. Byte cost priced by bits.ts before any default flip. Robert 2026-09-01: "idk, add to consider later".

## Project

### Now

- [P1] Provision Supabase + Google OAuth, then verify login → upload → signed-link view in a second browser. Required before public cloud sharing; local download already works.
- [P2] Daily real use: collect only concrete friction/defects. Evidence turns into a bounded decision; Robert decides any resulting UX change.

### Launch — after the technical Now list and cloud test are clear

- [P1] Domain and product email.
- [P1] Public deploy.
- [P2] Robert UX pass from observed friction.
- [P1] Invite first users and establish a feedback channel.

### Later — approved, but intentionally inactive

- [P3] Instant link mode: opt-in progressive raw upload and cloud assembly. Depends on durable chunk boundaries, sync work, real QA, and a cloud-compose decision; OFF by default with explicit privacy copy.
- [P3] Design-later pack (Robert 2026-08-22, "we will build, design later"): brand templates on F3 · link-unfurl page so shared links show a thumbnail · local library search · keyboard-first editing pass.

## Bugs

<!-- Confirmed defects move here when triaged; format: - [P1|P2|P3] description — repro/context -->

- [P1] Robert 2026-07-23: (a) Chrome capture "stops after a while", (b) recorded audio not synced with video, (c) "still some noises". Shipped same day: screen wake lock while recording + OPFS persist + mid-take storage/encoder death now surfaces loudly and keeps the partial take (was: silent truncation — the take "stopped" with no signal); editor preview re-clocked — hidden-tab-proof master clock + playbackRate slewing (was: rAF clock froze in hidden tab while audio played on → frozen video, audio seconds ahead; ±120ms seek deadband allowed ~240ms A/V gap even when visible; verified sub-10ms after fix); loudness makeup now noise-floor-bounded (boost cannot lift room hiss past −40 dBFS — the +18 dB rescue amplified hiss). AWAITING ROBERT recheck on real takes; if (a) still reproduces during capture (not playback), collect console log + take length vs file length.
- [P1] Robert 2026-08-06: recorded in Chrome, switched to another tab with a game — "nothing was recorded, just frozen frame". Shipped same day: (1) a dead/frozen video source no longer poisons the take silently — SourceLiveness watches each source's media clock off the composite's AudioWorklet tick (hidden-tab-proof) and 3s with no frame emits channel-stalled, marks the composite unusable (unedited export renders from the raw channels instead of copying still frames) and records Recording.stalled; (2) a video track ENDING mid-take now invalidates the composite too — previously the dead track kept readyState 2 so the composite repainted its last frame for the rest of the take and instant export copied it; (3) sticky red banner while a source is frozen (a toast is invisible — the user is in another tab when it happens); (4) getDisplayMedia now hints displaySurface:'monitor' so the picker opens on Entire Screen, and picking a single tab/window raises a notice that other tabs/apps will not appear. MEASURED in real Chrome 150/macOS 26: in a hidden tab the AudioWorklet tick, canvas.captureStream, <video>→drawImage and MediaRecorder all keep running at full rate (rAF goes to 0) — the composite pipeline itself does NOT freeze, so the frozen frame comes from the SOURCE. SURFACE QUESTION ANSWERED by Robert 2026-08-22 — one Chrome tab — see the entry below; that report is a second, independent root cause.
- [P1] Robert 2026-08-22: recording another Chrome tab that renders a 4K game — "the video freezes". Different failure from 08-06 despite the same words: frames arrive in BURSTS, not never, so the 3s stall detector correctly stays quiet and nothing warns. Root cause is throughput. Nothing capped the display track, so a 4K surface was consumed four times on one GPU (Chrome capture readback of 3840×2160 + raw screen MediaRecorder at 8 Mbps ≈ 0.03 bpp + composite &lt;video&gt; decode and downscale 30×/s + on-screen preview decode) while the captured tab rendered the game on that same GPU — and every one of those pixels was thrown away at export, which is 1080p on both paths. Shipped same day: display track constrained to the export size (CAPTURE_MAX_* tied to DEFAULT_EXPORT_SETTINGS), MAX-only so a smaller surface is never overconstrained, applied in the getDisplayMedia request and re-applied by capDisplayTrack() before the channel is delivered (before its recorder exists — a mid-file resolution change reinitialises the encoder); frameRate capped at 30 as max, not ideal, so a 60 fps game tab stops doubling the encode for frames the export drops; per-source delivered fps logged every 10s from the composite tick (console only). MEASURED (real Chrome, hidden tab, AudioWorklet rig mirroring liveComposite, 8s trials, 2 runs with order reversed, idle machine and no real game): 4K delivered 21.5 / 11.9 fps against a 30 fps target, drawImage 13.94 / 8.55 ms of a 33 ms budget, composite encoder starved to 289 / 106 KB/s; the same rig at 1080p delivered 29.8–29.9 fps, drawImage 0.97–1.04 ms, encoders 597–614 KB/s. ROBERT RECHECK 2026-08-25 PARTIAL: the game take now RECORDS — no frozen-frame complaint; the failure moved to AUDIO (progressive desync + noises under the same load, its own P1 in Now) and to a game-first WEDGE ordering (case file). The console lines (`[capture] display capped 3840×2160@… → 1920×1080@30`, `[capture] screen … delivering N fps`) are still unseen from a real game take.
- [~~P1~~ FIXED 2026-08-23] Robert: "sound broke into lag sounds" + "sound was not loud, same as before" — ONE cause, both symptoms. Measured on the delivered export: the makeup gain was PEAK-BOUND (p20 floor 0.0062 vs a 0.01 ceiling so the floor bound was slack; p90 reached 0.1063, 1.4 dB short of the 0.125 target, so the target bound was not reached) — one sharp transient set `peak`, capped the gain for the WHOLE take, and was itself destroyed by the limiter. The limiter's tanh fold went numerically dead at an input of 1.152 while the gain bound licensed peaks to 1.9, so a 1.66:1 range of the loudest content collapsed onto one 16-bit code: 217 full-scale ~0.25 ms impulses from t=12.5s, which is the crackle. FIXED by (1) an algebraic u/(1+u) fold — same f(0)=0, f'(0)=1 C1 knee and f(inf)=1 ceiling as tanh, but polynomial approach, resolved to LIMIT_USABLE_MAX ~= 82, and bit-identical below the knee; (2) NORMALIZE_PEAK_OVERDRIVE 2 -> 4, which the old curve could not have carried. Old vs new on the take's back-solved numbers: gain 3.06 peak-bound / p90 -19.47 dBFS / transient rendered as 32768 x5 + 31130 (2 distinct values of 6) BECOMES gain 3.60 target-bound / p90 -18.06 dBFS on target / 6 distinct values, none pinned. Gates: 260 tests, fidelity oracle PASS (toneErr 0.02 dB, limiterHits 0), sync oracle PASS. STILL OPEN and deliberately not claimed as fixed: general loudness. That take's MEDIAN window RMS is 18 dB below its p90, so most of it sits far below the level being normalized — closing that needs real dynamic-range compression, which is a separate Robert decision.
- [~~P1~~ FIXED 2026-08-23] "stopped some input mid record, but in the editor timeline they are full length" + "why i cant turn off screen and camera mid session" + "must not be muted but stopped, but resumable after, any input". Was: the chips live-MUTED audio (`track.enabled = false` — device still open, camera light still on, channel still recording real-time silence at full length) and locked video entirely. Now `CaptureSession.setChannelActive(kind, active)`: off releases the device and closes that channel's file at that instant; on re-acquires and late-joins a NEW segment with its own startOffsetMs, so the off stretch is a real hole on the timeline. Any input, including one never armed for the take. `setAudioEnabled` is kept in the contract but the default UI no longer calls it.
- [P2 → ROADMAP B5] No local disk guard on capture, exposed by removing the 30-min cap (2026-08-23). Capture streams every channel to OPFS as it records, so length costs disk and not RAM — but nothing checks `navigator.storage.estimate()` before or during a take. A write failure is at least loud (`session.ts` ondataavailable → channel-error + onTrackEnded, partial take kept), so this is degradation and not silent loss; still, an uncapped take should warn on low headroom before it starts and while it runs, and the ~1.1 GB/hour at the production 8 Mbps + 128 kbps is a number the UI can show.
- [P1] THE EXPORT LADDER STOPS AT 1440p AND NOBODY EVER DECIDED IT SHOULD — Robert 2026-08-29: "why the fuck product cant deliver 3024×1964". He is right that it is not a technical limit. QUALITY_TIERS tops out at 1440p because F7/F7b picked steps by MEASURED FILE-SIZE SEPARATION (540p/720p/1080p/1440p, every adjacent pair 35-95 % apart) on a 1080p-capped product, and native-res later made 1440p real detail without anyone asking what sits above it. So a 3024x1964 screen — an ordinary MacBook Pro — cannot be exported at its own resolution, and the capture ceiling added 2026-08-29 follows that ladder rather than causing it. WANTED: a top step that IS the take's own long edge (the machinery exists — F13 made a step a PIXEL BUDGET resolved against the take's aspect, so `tiersForTake` can inject one), and MAX_OUTPUT_LONG_EDGE follows it. THE COST IS THE ONE JUST FIXED, and that is why this is a task and not a patch: capturing 3024x1964 instead of 2560x1662 is 40 % more pixels through three hardware encoders, which is where his freeze lived. It needs the encoder-count entry below settled first, or it needs to ship behind a flag so the freeze is his to find rather than everyone's. Sits with F16, which owns the export ladder.
- [P1] THE LADDER STEPS THE TRACK AND THE RAW CHANNEL CANNOT FOLLOW, so the step buys nothing and adds an upscale. Read straight off Robert's own console 2026-08-29: `display stepped 3024×1964@30 → 2217×1440@30`, then at stop `screen channel recorded 3024x1964 (the track said 2217x1440)`. The raw channel's VideoEncoder is configured once at start and a frame size cannot change mid-file (P0-tail-raw is careful about exactly this), so after a step Chrome UPSCALES every frame back to the original size for it — more work than before the step, for no picture. The composite does benefit (it draws into its own canvas), which is why this went unseen. Wanted: either the ladder knows the raw channel cannot follow and says so in its own reasoning, or a step closes the raw segment and opens a new one at the new size (the segment machinery already exists — F6 pause/resume opens segment N+1 on the same track). Until then a step is a partial measure and the console line above is the tell.
- [P1] THREE HARDWARE AVC ENCODERS RUN AT ONCE on a screen+camera take and nothing budgets them against each other: the raw screen channel, the raw camera channel, and the composite. On Robert's game take that was 3024x1964 (level 5.1) + 1280x720 + 1920x1080 while a game rendered on the same GPU, and the whole MACHINE froze, not just the tab — "some movement on record but after a while freezes and whole screen, not just this tab". The 2026-08-22 entry blamed a 4K surface being consumed four times over; this is the same shape one layer up, and native-res going default for a day made it reachable again. `?singlegen=capture` removes the composite encoder entirely and is the lever that already exists, but it only fires when the one video channel matches the export geometry exactly. Wanted: a capture-time budget that knows how many encoders a take is about to open and at what sizes, and declines the third.
- [~~P1~~ FIXED 2026-08-29] Robert: "Missing from this take: Screen — the device never connected", then "screen shown on preview, but in video its missing", same without `?sourcefps=1`. TWO CAUSES, ONE SYMPTOM, BOTH EXPOSED BY NATIVE-RES GOING DEFAULT THAT MORNING — the raw channel's VideoEncoder is now configured at the MONITOR's own size, and before that the 1920x1080 cap hid both by accident. (a) AVC CANNOT ENCODE AN ODD SIDE and refuses rather than rounding; a Mac in a scaled display mode reports odd sizes as a matter of course (1728x1117 is a stock "More Space" mode). (b) AN AVC LEVEL IS A FRAME-SIZE LIMIT and Chrome enforces it; both encoders' candidate lists stopped at level 4.2 = 8704 macroblocks ≈ 1920x1088, so EVERY display bigger than 1080p was in the hole (1440p is 14400 MB, 4K is 32400). Either way the channel wrote nothing, the MediaRecorder fallback wrote nothing either, and the take reported the screen missing — while the preview showed it throughout, because the TRACK was never the problem. REPRODUCED AND FIXED FROM A URL on prod: `?synthetic=1&screensize=1728x1117` was `missing: ["screen"]` and is now 1726x1116 on `avc1.4D402A` (the SAME encoder as before, so the 1080p-class path is untouched); `2560x1441` → 2558x1440 on `avc1.640032`; `3456x2234` → recorded whole on `avc1.640033`, 2.6 MB. Fix: `capDisplayTrack` evens the TRACK (so every consumer including MediaRecorder sees an encodable frame) and `startMeasuredVideo` evens its own ENCODER CONFIG (so a source that refuses to be constrained costs a cropped row, not the screen); levels 5.0/5.1/5.2/6.0 appended to both candidate lists, never reordered. `evenDown` lives beside `evenDim` in core/frame.ts.
- [P2] THE MEDIARECORDER FALLBACK IS NOT A FALLBACK for a frame the platform's AVC refuses — found while fixing the entry above. When `startMeasuredVideo` threw, the code fell back to the MediaRecorder built during arm and that wrote ZERO bytes too, so the "a failure here is not fatal to the take" comment in session.ts was not true for this class of failure: both paths were asking the same platform encoder for the same impossible frame. Both causes are fixed upstream now, so nothing reaches it this way today — but the fallback's own promise is still unverified for anything a hardware AVC encoder refuses. Wanted: a rung that changes the ASK (even the size, drop the level, or accept webm/VP9, which has no odd-side restriction) rather than re-asking the same question with a different API.
- [~~P2 → ROADMAP B6~~ FIXED 2026-08-29 by W1 — absorbed, same code, same defect; handoff under W1 in `.ai/TASKS`] "the device never connected" BLAMES THE DEVICE FOR AN OS PERMISSION. Separate from the entry above and still open — hit on the DEV machine while reproducing it: when macOS has not granted Chrome screen recording, Chrome's picker opens and says so ("allow screen recording for Chrome in System Settings. You'll then need to restart Chrome") with Share greyed out, `getDisplayMedia` never rejects, and INOUT's own 30 s deadline fires and reports the generic "the device never connected" — throwing away the one message that would have solved it. Measured: `display timeout +30023ms` / `+30021ms` with and without the flag. Wanted: when a display request times out, say what it actually is, and say it while the request is still outstanding rather than only in the post-take banner. The wedge ladder ALSO escalates on each such timeout (`rememberDisplayWedge`), spending a constraint escalation on something no constraint can fix; it self-heals on the first success. (THAT LAST CLAUSE WAS FALSE and is half of why W1 exists: a success cleared the mark from rung 0 ONLY, so the escalation self-healed from nowhere else and the machine sat degraded for the 24 h TTL.) Behaviour change → Robert's yes before it ships.
- [P1 → ROADMAP G2] `npm run oracle:load` IS RED, AND IT IS NOT F15 — measured on both sides of it 2026-08-29. HEAD (a47113c) and the commit before F15's first line (79d6def, run in a throwaway worktree) give the IDENTICAL verdict: `composite tail FAIL/fps FAIL · raw tail INCONCLUSIVE/fps INCONCLUSIVE`, composite tail 9848 ms / 7366 ms against a 400 ms band, delivered 0.2 / 2.5 fps against a band of 10, and BOTH raw runs erroring `the take produced no screen channel`. So the gate F15's task lists cannot be met by F15, and the red predates it. THE LEAD, and it is the same mechanism this session diagnosed for the Browser pane: the rig's 4K source is a canvas painted from requestAnimationFrame, and `oracle:load` drives through `exp.mjs`, which is HEADLESS by default — a hidden/headless page runs rAF at 0, so the SOURCE starves and the tail band reads the starvation as tail loss. DECISIONS already records this rig measuring 14 fps under 4K load ("a rAF-painted canvas's cost is the painting"); 0.2-2.5 fps is a different regime, which points at a Chrome update changing headless rAF rather than at the product. FIRST MOVE: re-run it `--headed` (exp.mjs takes the flag) and see whether the source delivers; if it does, the rig's default is the bug and the band has been measuring the harness for an unknown number of sessions. A rig that cannot make its own source move is not a gate.
  **THAT FIRST MOVE IS NOT RUNNABLE AS WRITTEN** — found 2026-08-29 by the O15 session, which owed this gate and went to run it. `exp.mjs` takes `--headed`, but `scripts/oracle-load.mjs` never forwards it: both of its spawns build `exp.mjs`'s argv as a hardcoded literal and parse none of their own process's flags beyond `--takeMs=`, `--band=`, `--fpsBand=`.
  **AND THE MOVE WOULD NOT HAVE HELPED, because the premise under it was never measured** — G2 settled this the same evening and the whole "headless rAF is 0" lead is RETRACTED: `npm run exp -- rigsource` reads 120.2 Hz headless AND headed, `document.hidden` is false under `--headless=new`, and a rAF-painted track delivers 30.2 of 30 fps either way. It had been written down twice in this repo and measured zero times. The real defect was that `oracle:load` handed all N takes to ONE page; it is one take per page now, and a starved source exits SOURCE-STARVED instead of being scored as the product. This entry is kept for the argv fact, which still stands, and as the record of a lead that two sessions believed on no evidence.
- [P2] Fidelity oracle red on dev machine under load: uniform tone-level drop 1.1–2.3 dB varying run-to-run (signature of contention-starved capture, same family as the ALL-NULL P2 above). Pre-existing before 2026-07-23 changes (clean tree measured worse). Do not treat as mix-path regression without a quiet-machine run.

## Ideas

<!-- anything not a defect: UX, features, polish -->

- Robert 2026-08-29: **selectable text in the player, while paused** — "i want on apps player pause
  ability to select text from video". Pause on a slide, a terminal, a code review, and drag across
  the words to copy them, the way you would on a real page.
  WHAT IT ACTUALLY IS: OCR over the paused frame plus an invisible, selectable text layer positioned
  on top of it — the same trick a scanned PDF uses. The picture stays the picture; the selection is a
  transparent overlay whose glyph boxes line up with what is on screen.
  WHY IT IS NOT A STRETCH HERE, and this is the part worth knowing before it is priced: the hard
  half already exists and already runs locally. `src/core/ai/` builds the for-AI artifact off this
  same take, `src/experimental/oracle/textEdge.ts` and `localize.ts` already reason about glyph edges
  and where text sits in a frame, and Robert's standing rule is that local zero-token inference is
  allowed where runtime token spend is not — so an in-browser OCR pass over ONE paused frame costs
  nothing per user and needs no service.
  SHAPE, cheapest first: OCR only the frame that is actually paused, on demand, and cache it by
  frame ordinal (a viewer pauses on a handful of frames, not thousands); overlay `<span>`s with
  `color: transparent` inside a container the same size as the stage, so native selection, copy,
  and find-in-page all work for free; scale the overlay with the stage's own transform so it stays
  aligned through zoom and the viewport track. Degrades honestly: no OCR result means no overlay and
  the player behaves exactly as it does today.
  OPEN QUESTIONS FOR WHOEVER TAKES IT: which engine (a WASM OCR is a real download — measure it
  against the PWA budget before committing); whether the CLOUD player gets it too, where the frame
  is not local; and whether this should also feed the for-AI artifact, which today describes a take
  without ever reading the words on its screen.
