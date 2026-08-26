# INOUT — Context

Human-readable truth. Machine layer: `.ai/` (ARCH, STATE, DECISIONS — authoritative, kept current).
Business ops live with the PM, not here.

## Roles

Shared rules: no flattery · direct · evidence first · admit uncertainty · challenge assumptions · minimize words, time, complexity, waste.

- **PO** — Product Owner + Design Director. Final decision maker.
- **TD** — Technical Director. Architecture and technical strategy; reliability, security,
  maintainability. **All production changes require TD review; veto absolute for safety.** While PM
  is vacant, TD also maintains STATE/DECISIONS/NEXT and flags scope drift.
- **EE** — Experimental engineer. Experiments in shadow mode only; production work only on
  TD-assigned tasks, on branches, merged only by TD.
- **PM** — Owns scope protection, validation plan, product evidence, role briefings,
  and the business/launch work outside the repository. PO retains final product decisions; TD
  retains production-change review and the safety veto.

Pipeline: experiment → shadow → evidence → TD review → production.
Override rule: if PO overrides a TD safety block, the override is recorded in DECISIONS with the risk stated.

## Product

Instant capture → compose → share. Web-first (Chromium), local-first.
Flow: open → record (screen / camera / mic / tab audio) → simple trim → one MP4 → file or cloud link.
Audio-only becomes visualized video. UI: iOS-Camera simplicity, Final Cut timeline feel. Not Loom, not Zoom.

## Frozen decisions

- **Instant is law**: instant record start, instant default export. Slow = dead product.
- **No idle device access, ever**: camera/mic activate only after the record click.
- Every capable browser (Chromium-first unfrozen 2026-07-16) · offline/local-first
- Composition: screen + cam PiP BR default; audio → waveform. Fixed-layout UNFROZEN 2026-08-22:
  user-movable TIMED camera, zoom/pan, backgrounds approved on the roadmap; untouched takes keep the default.
- 30-min cap (the RAM reason for it is gone — O1 shipped; the cap is now a product choice, not a
  limitation) · channels recorded separately (per-channel trim) · export always a real file
- Cloud optional: Google login, free tier, finished exports only, 512 MB/user, 7-day links (Supabase behind swappable interface)
- Security: TLS + at-rest + signed links, minimal data, E2EE-compatible architecture
- Excluded permanently: AI/transcripts. MVP excluded: native apps, P2P, collaboration, social, permanent
  free storage. Editor expansion is now the approved post-MVP roadmap (2026-08-22, see Roadmap below)
- Backlog (approved): **instant link mode** — opt-in progressive upload + cloud assembly, OFF by default
- North star: **distributed multi-device capture** (phone camera + laptop screen, one time model). Shapes time/session/format decisions now; product work gated on a 2-device sync spike with kill criteria. iOS = Safari capture node first; thin native node later; never a separate editor.
- Never: real-time streaming as the capture basis · closed project format · sub-ms multi-mic mixing promises · silent background capture · deterministic replay of live media

## State (2026-08-26)

Working and verified end-to-end: capture 4 channels → edit → export → share. PO records with it.

**The editor stopped re-listening to audio it had already heard (2026-08-26).** While a recording is
being made, INOUT is already measuring how loud it is, moment by moment. It used to keep three numbers
from that and throw the rest away — so trimming a take, cutting one, or asking it to tighten the
silences all made it read the whole soundtrack a second time before it could start. It keeps the
measurements now (about 120 KB for half an hour), and those three jobs simply use them: "Tighten"
proposes exactly the same cuts it did before, in about a thousandth of the time. And while checking
that, one thing turned up that matters more than the speed: last week's fix for the audio quality PO
reported as regressed was not actually reaching any export — the number it depends on was being
calculated and then quietly dropped on the way. That is fixed, and the listen test PO owes is now a
test of a build where the fix is real.

**The timeline shows the recording now, not a set of coloured bars (2026-08-25).** Each video track
in the editor carries a strip of its own frames, so finding a moment is a matter of looking rather
than scrubbing — the "Final Cut timeline feel" in the product statement, taken one step. It costs
about half a second per track and appears after the editor has already opened; if it cannot be built
the lane simply looks the way it did before, because nothing in editing depends on it.

**The export panel stopped claiming things it could not know (2026-08-25).** Two of them. It used to
say "measuring the other sizes — they settle in a few seconds" forever on any recording it could not
measure (an audio-only take, for instance), over numbers that were never going to change; it now says
plainly that those are rough guides and that the file can come out several times bigger or smaller.
And on a recording with no combined video file behind it, it called the default choice "Instant" and
its size "the file, not a guess" while showing 5.6 MB for something that would come out a few hundred
KB — that export actually re-renders, and the panel now says so. The underlying estimate cannot be
repaired: measured this session, its error goes +86 % on screen content and −79 % on video with a lot
of motion, because the encoder that runs while you record has to keep up in real time and the one
that runs at export does not. Nothing that predicts from the first can be right about the second, so
the honest move was to label it. The measured number, which is accurate to a few percent, is what
users see whenever it can be computed — that is the normal case.

**Two ideas were killed with measurements this session, and that was the expensive part.** One was a
plan to improve audio/video sync by reading each captured frame's own clock; it cannot work, because
that clock starts at the first frame we receive, which is already late by exactly the amount we were
trying to remove — and adopting it would have added more drift over a fifteen-minute recording than
the error it fixed. The other was the export-size estimate above. Neither shipped a feature; both
close off work that would otherwise be attempted again.

**Found and not fixed, deliberately:** the automated sync test is unreliable on cold runs — two of six
fail, on a build that has none of this session's changes. Both failures land exactly on the test's own
one-second timing grid, which points at the measuring apparatus rather than the product, and the
warm test passes consistently. It is now the first item on the engineering map, with the reproduction
recorded and no attempted fix, because a test that can invent a one-second error can also hide one.

**A take can now be exported FOR AN AI (shipped 2026-08-24, reworked the same day).** The export
panel has a second control, "For AI", and it produces one PDF rather than a smaller video: a page of
plain text that tells its reader what the file is and how to read it, followed by one page per moment
the picture actually changed. Agents do not watch video — they sample frames and pay about a token
per 750 pixels — so a 97-second take costs roughly 144k tokens this way against 2.3M as video frames,
and it builds in half the time of the ordinary export.

The first real test earned three corrections worth recording, because all three were about judgement
rather than code. PO exported a 97-second walkthrough of a product UI and gave it to an agent to
recreate that UI and its animations. The AI **asked what to do with the file** — page one had opened
with machine facts instead of saying what the document was — and PO's own verdict was that it **lost
far too many frames**: a stretch where a field was typed into, a button turned active, was clicked
and a tab switched had fallen entirely between two pages five and a half seconds apart. Then PO
challenged the format itself, and was right to: the page ceiling the design had been built around was
a number taken from memory rather than checked. It is wrong — Claude accepts 600 pages and 32 MB,
Gemini 1000 pages and 50 MB — so the format was never the constraint; the cost is tokens, and how
many frames a recording earns is a spending decision, not a wall. All three are fixed and measured on
that same recording: the file briefs its reader in its first lines, and it went from 39 frames to
165, median gap 0.4 seconds, nothing longer than 2.9, the whole take covered. Frames go densely
through anything moving — an animation comes back as a sequence, which is what recreating one needs
— and not at all while the screen is still.

**PO's move: re-test.** The rebuilt version of that same take is at
`~/Downloads/inout-20260824-183853-for-ai-v2.pdf` for a side-by-side against the original file and
the MP4. That report decides whether the richer layers (DOM events, transcript, repro bundle) get
built at all.

Shipped 2026-08-23 (eleven merges; engineering detail in `.ai/DECISIONS`, task state in `.ai/TASKS`):

- **Reliability.** Recording could hang on arming with no way out and leave the mic indicator lit
  after a refresh. Each arming step had a deadline but the waits that JOIN them did not; the record
  button was disabled while arming, so there was nothing to press; and nothing released devices when
  the page went away. All four closed, PO-verified.
- **Exports stream to disk.** The muxer holds 4 MB whatever the length — a 30-minute export peaks at
  39 MB instead of 294 MB. The RAM ceiling on long takes is gone.
- **Loudness is measured during capture**, so export stops decoding every audio channel twice.
- **First paint 803 KB → 221 KB**, with record-start latency unchanged (the engine is prewarmed at
  mount, not fetched on click).
- **Mid-take cuts** — split at the playhead, delete a clip, drag cut edges. Sync holds across joints
  and joins are click-free.
- **Quality steps before export** — 540p / 720p / 1080p / 1440p, each with a size number; the default
  step still exports instantly and its number is the file itself rather than a prediction.
- **Installable, and it starts offline.**
- **Every export now carries a record of how it was made** (path, settings, what the loudness
  normalizer did, anything capture knew was wrong).
- **The tail of a take is now gated**: CI fails if an export is short or loses its final events.
- **Zoom and pan, timed** — wheel on the stage to zoom into what matters, drag to pan, and the export
  zooms at the moment you did it. Reset with one click. It tops out at 2.5×, because a 1080p recording
  cannot be magnified past that without turning to mush; going further needs native-resolution
  capture, which is on the roadmap.
- **A frame around the screen** — backdrop, inset, rounded corners, shadow. Off by default; what you
  see in the editor is what the file gets, measured to under a pixel.
- **Tighten** — one press finds the silent stretches in a take and proposes the cuts. It stays a
  proposal until you apply it, it leaves the short pauses that make speech sound like speech, and it
  is pure signal processing: no transcript, no model, ever.
- **Files got smaller for free** — 20–24 % off a screen recording's export and 29 % off what the
  camera writes to disk while recording, with the picture measurably unchanged in both cases.
Known gaps, honestly stated:

- **The end of a take going missing under load is FIXED for the composite** — 2.7 seconds lost off a
  4K recording became 0.04-0.3 seconds, and the recording now recovers about a megabyte at every stop
  that used to be thrown away. A take whose encoder never catches up says so, and the fast export
  path refuses to ship it. The raw channels got the matching fix the same day (their tail loss went
  from ~1.3 seconds to under a quarter second, by starving the source instead of ending it).
- **The new capture engine was never slow — our measuring rig was (found 2026-08-24).** For three
  sessions the engine read "2-10 fps" and stayed off. The real story: the test harness always runs
  in a brand-new browser profile, whose very first video encoder takes several seconds to warm up;
  every test take was 8-10 seconds, so the whole take fit inside that warm-up; and the engine's own
  watchdog, measuring from the start of the take, killed it before the encoder finished waking.
  Measured warm, the new engine hits its speed gate (28.4 fps vs the old engine's 29.3) while using
  ZERO main-thread time (old: 198 ms) and roughly HALVING the audible A/V sync offset (33.7 ms vs
  63.4). The rig and the watchdog are fixed, and the same afternoon closed three more items:
  the warm-up question is settled (users would pay it after every browser launch, so the app now
  warms the encoder quietly at load), the CPU comparison came back in the new engine's favour (it
  uses LESS processor while delivering more), and the fallback for machines that truly can't keep
  up is proven. THE FLIP HAPPENED the same day, on PO's word: the new engine IS the default now,
  with the old one intact underneath as an automatic fallback (unsupported browsers, a failed
  start, or a machine that can't keep pace) and a one-parameter revert. Every gate was green on
  the way: full test suite, both engines' oracles, the eight-gate QA on the production build in
  real Chrome, recording-start latency proven unaffected. What users get: capture that costs the
  main thread nothing, LESS CPU, an audibly smaller A/V sync offset (~34-48 ms vs ~60), and a
  recording that is a playable file on disk even mid-take. Waiting on PO's first real recording
  to confirm; the sync target and a preview optimization remain as polish.
- **A/V sync is worse than we thought, and the instrument was why.** Every sync number quoted before
  2026-08-23 was ~31 ms optimistic: the oracle carried an exact 18 ms detection bias and never
  measured the video reference at all. The true offset is ~45–63 ms, audio late — which is what PO
  felt on a real take. The cause is understood (the audio anchor cannot see input latency; measured
  at +128.7 ms on a loopback rig) and partly compensated. Closing it properly is the WebCodecs
  engine's job (O4), whose target is ≤20 ms.
- MP4 capture on Chromium was tried and **rejected on evidence** — Chrome does not stream it, so a
  tab kill would lose the whole take. That hardware-encode win moves to O4, which owns its own muxer.
- Cloud unprovisioned. Composite still absent from crash salvage (O4 makes it free).

## Roadmap (PO-approved 2026-08-22 — executable plan and READY map in .ai/TASKS)

Every task is evidence-gated. `.ai/TASKS` is authoritative: it carries the READY map, per-task state,
what a fresh session must know first, and an index of the measurement tooling.

**Done:** exports stream to disk · capture-time loudness · content hints + full-size camera · bundle
split · sync root-cause + honest gate · quality steps · mid-take cuts · tail/throughput bands +
certified exports · PWA install · movable timed camera + edit persistence · Yandex/RU pack part 1 ·
WebCodecs capture engine (now the default, see below) · the export engine off the main thread and
smart-cut trimming (O5, see below) · the bits audit and the two size levers it
priced · background frame · silence tightening · timed zoom/pan · **the tail fix, now on both files a
take produces** · **per-clip speed** · **draggable zoom markers** · **the engine × OS capability
matrix** · **export for AI (AI1) — one PDF, no video inside, ~16× cheaper to read than the video frames**.

**The ending of your take is safe now, on both paths.** The composite — the file you get when you
export without editing — was losing nearly three seconds off a heavy take and was fixed last session.
The channels an EDITED take renders from were still losing up to three quarters of a second, and now
lose 7–216 ms under the same load. The fix is not the same one, and the difference is worth knowing:
the composite could simply stop drawing, but a camera or a screen is a live device, and *ending* it
makes the browser throw away whatever it had not finished compressing. So the source is slowed to one
frame a second instead — nothing new to compress, everything already queued still comes out. The stop
path also grew a deadline everywhere it did not have one: a take whose recorders all refuse to answer
now comes back in five seconds with the files intact, where it used to hang forever.

**O4, the WebCodecs engine: it is now how you record, and the "wall" was our own stopwatch.** For
three sessions the new engine looked like it could only manage a few frames a second where the old one
did thirty, and the search moved from the browser's encoder, to how we fed it, to a difference between
two of our own files. None of them was it. **The first video encoder a browser creates after launch
takes several seconds to start up**, every test take fitted entirely inside that window, and the
engine's own watchdog was killing takes mid-startup — so a one-off delay read as a permanent ceiling.
Warmed up, the new engine wins on every axis measured: 28.4 frames a second against 29.3, no blocking
work on the main thread at all (the old path spends 198 ms per take), lower CPU (peak 127 % against
196 %), tighter sync (33–48 ms against about 60), and because it owns the encoder it can drain it at
the stop instead of asking a black box to stop. The app now warms the encoder up when it loads, so
your first take after opening the browser is whole. **It is the default as of 2026-08-24**, with the
old path kept alive underneath it in three ways — browsers that cannot run it, a failure at start, and
a take that genuinely runs slow mid-recording — plus `?engine=v1` to force the old one outright.

**O5, the export engine: what we set out to build was already there, and measuring that is what paid.**
The plan was to overlap the export's stages, which were assumed to run one after another. They do not:
the library we use already keeps the encoder four frames ahead, and the decoding cannot be hidden
behind the drawing because both are the same thread. Two versions of the intended speed-up were built,
measured, and deleted for buying nothing. What the measurement *did* give us is the number nobody had:
**the export's floor is what it costs to decode every frame** — two thirds of the whole job — and the
only way past a floor like that is to decode fewer frames. So the effort went there instead, and the
result is the one people will feel: **trimming a take no longer means re-making the whole video.**
Cutting changes *which* parts you keep, not what any of them looks like, so the recording's own
compressed frames are copied straight through and only the few frames either side of each cut are
re-made. A thirty-second take with two cuts now exports in under a second instead of nearly four.
It is built, merged and measured, but **switched off by default** — and the next session explains why
in a way nobody expected.

**The test we built to turn trimming on found something worse, in the feature everyone already uses.**
The plan was small: teach the automatic checker to export a trimmed take the way the app really does,
confirm it is clean, switch trimming on. Building that revealed the checker had never tested the fast
path at all — it always exported the slow way, so **every sync figure this project has ever quoted
describes the path you get LAST**. With the checker finally looking at the real thing, the fast export
of an *unedited* take — the one you get every time you record and hit export without editing — is
**about 100 milliseconds out of sync on the new engine and 245 on the old one**, against 52–64 for the
slow path on the identical recording. Trimming inherits the same fault because it copies the same
file, which is why it stayed off. So the flip did not happen and a P0 took its place. This is the
uncomfortable kind of good news: the fault is not new, it is just newly visible, and it is consistent
with your standing report that sync is worse than it should be. It also means an untouched take is
currently worse than an edited one, which is backwards. Fixing it is the top item on the roadmap. The export also moved off the main thread, so a long export no longer competes with the
editor for the same thread; it produces a byte-for-byte identical file either way.

**Shipped alongside it:** the **timed movable camera** — drag the picture-in-picture on the stage and
the export moves it at the moment you moved it (PO's emphasized feature). And, found while building it,
**edits now survive a refresh**: until today a reload restored your recording but silently threw away
every trim and cut you had made. **Yandex Browser preparation** landed too: the app can now tell Yandex
from Chrome, and there is a one-command QA runner and an RU network probe.

**Shipped 2026-08-23 in one session, on PO's "roadmap o/f, all in one session":** the background
frame · silence tightening · the finer export ladder · the whole bits audit and the two size levers it
priced. (An "in-shot" notice shipped the same day and was pulled on PO's call — see DECISIONS.)
One gate was NOT met and is a task rather than a footnote: the per-step
size number cannot be honest to ±20 % on every kind of content, because it is predicted from a file a
DIFFERENT encoder made — on text-heavy screen content the two encoders disagree by nearly 2×. The fix
is to measure rather than model, and it is task F7c. **Attempt 4 halved the error and got ordinary
screen recordings inside the ±20 % promise for the first time** (7–15 % out), by measuring a whole
five-second stretch instead of half a second — the half-second sample turned out to be wrong in
*opposite directions* depending on the content, which is why no single correction had ever fixed it.
Full-motion content is still 30–40 % low, so the number shown to you is unchanged for now.

**Also shipped 2026-08-23, on "go p0-tail and others":** the composite tail fix · timed zoom and pan
(you chose timed zooms over a static reframe) · the O4 re-diagnosis. And one thing deliberately NOT
shipped: three attempts to measure export sizes instead of predicting them, all measured, none better
than the model they would have replaced. The spike is kept with its numbers so the next attempt starts
from the fourth idea.

**Also shipped 2026-08-23, on "go finish roadmap":** the raw-channel tail fix (above) · **per-clip
speed** — pick any clip and play it at 1.25× to 3×, with the voice held at its own pitch rather than
turned into a chipmunk, measured at eight hundredths of a semitone in the exported file · **zoom
markers you can drag in time**, which were read-only before, so changing *when* a zoom happened meant
redoing the zoom · and the capability matrix that finally tells the truth per platform: on Windows a
whole-screen share carries the machine's audio and the channel says "System Audio"; on a Mac it only
ever carries a tab's; and Firefox, which quietly accepts the request and hands back a silent track, now
has that channel removed with copy that says exactly what Firefox does.

Two real bugs surfaced on the way and were fixed, both caught by the new gates rather than by a user:
a take with cuts in it was exporting **9.5 dB quieter than it should**, and the loudness step was
spending itself hiding that; and a whole-take speed change could be silently discarded when the edit
was saved.

**Asked for on 2026-08-24: "roadmap all O and F in one session" — and it was not achievable, so here
is what happened instead.** The export engine (O5) was the heaviest unfinished piece and everything
else in the optimisation list depended on it, so it was taken end to end. Disproving its central
assumption *was* the work, and it consumed the session. What that bought is worth more than a feature:
a whole family of "make the export faster by overlapping things" ideas is now closed with numbers
against it, and the one lever that does work is built. **Eight tasks were not started** — single-pass
export, the capture-engine polish list, native-resolution capture, crisp screen text, the audio depth
work, pause/retake, the size number's fifth attempt, and frame-exact scrubbing. Each still costs a
session, and `.ai/TASKS` says which are unblocked and which can run at the same time.

**New 2026-08-24: AI export (phase A in .ai/TASKS) — PO's named top priority.** A second export
target next to the MP4: **one file any AI understands instead of a video it must watch**. The file
is a PDF — the only single-file format every major AI reads natively as text plus images; nothing
in it is a video and nothing in it needs a tool to open. Inside, maximum token cheapness: a
one-page text index (take facts, what capture knew went wrong, and a page-numbered list of the
screenshots), then one change-driven screenshot per page. The button (AI1) ships first. Everything
richer — DOM event sidecar, transcript, repro bundle, markers, MCP access, redaction — is marked
as a **candidate only** (AI2–AI7) and gets reconsidered after PO feeds the first real file to an
AI and reports how it went. The sidecar additionally waits on a product decision only PO can make:
where events come from (a browser extension, an SDK snippet in the recorded page, or the desktop
shell). The transcript stays PO-gated under the standing no-AI rule because speech recognition is
a local model; the export format itself runs no model anywhere.

**Runs in parallel now:** the AI export button (AI1, PO's named priority) · the out-of-sync fast
export (P0 — trimming waits on it) ·
native-resolution capture · crisp screen text · pause/retake · frame-exact scrubbing · the size-number
probe, attempt 5 · the codec ladder and the real Firefox run, both waiting on one install (below) ·
the iOS ScreenCaptureKit spike (time-sensitive: iOS 27 ships ~Sept 2026, and it needs a device we do
not have).

**Waiting on PO:** approve one dependency install — `npm i -D playwright && npx playwright install
firefox` — which unblocks both the real Firefox run and the codec ladder that needs three engines to
test against. Install Yandex Browser and run the one-command QA smoke.
Run the RU reachability probe from a Russian connection without a VPN. And two rechecks on real
hardware — a camera-only take should now record 1080p rather than upscaled 720p, and the Safari audio
path has never been verified on a real Apple device.

Competitive stance: the empty quadrant is no-install + local-first + world-class output — vs Loom's
network (mediocre tool), Screen Studio's Mac-only polish, Cap's required install, Tella's cloud-bound
browser. Share loop stays the minimal signed-link cloud already scoped.

## Next

PO records with the tool and reports bugs; that loop is working and is what caught both the mic hang
and the sync drift. Next: (1) provision Supabase + Google OAuth (~15 min, docs/CLOUD_SETUP.md) then
e2e login→upload→share→view; (2) PO keeps using INOUT daily and collecting pain points.
Engineering (TD-gated): O4 as the single big rock, features and ports in parallel — see .ai/TASKS.
Ship: (7) domain + email (no payments yet); (8) public deploy; (9) UX pass from pain points (PO);
(10) first users + feedback channel.
After real usage data: next milestone · business model · validation approach · launch path.
PM: establish context-separation rules per role — each role gets its own scoped briefing (what it
needs to know, what it must do, how, and what it must NOT touch), instead of everyone reading
everything. TD drafts the per-role templates; PM owns keeping them current.
Deleted from old master list: playback page (signed links play directly), SPEC/STATE/TODO file set
(superseded by CONTEXT.md + .ai/), 44 completed build items.

## Experiments — there is no experimental tree any more (PO ruling 2026-08-25, done 2026-08-26)

PO: "i just dont want experiments be separated, all the shit must get in worked or be deleted." So a
module either is tooling a live gate runs — the pipeline oracle, the measurement rigs behind each
task's evidence — or it is spent, and spent means deleted, with the verdict kept in `.ai/DECISIONS`
and the code kept in git. The dormant half is gone (2,745 lines): the session log, the WebCodecs
capture A/B, the streaming-export benchmark, timed data channels, TimeMap/Scene, the semantic
artifact. What they proved is in the product rather than beside it — the WebCodecs rig BECAME the v2
live composite, the streaming benchmark BECAME the stream-to-disk export, the size probe BECAME the
export panel's measured sizes. Nothing merges without evidence + TD sign-off; nothing waits around
without a task, either.

## Risks

Platform-creep before validation · polishing before PO's real QA · random experiments entering
production (gate: TD) · browser permission edge cases on real devices · free-tier storage limits
are product-visible.
