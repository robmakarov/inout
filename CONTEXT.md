# INOUT — Context

Human-readable truth. Machine layer: `.ai/` (ARCH, STATE, DECISIONS — authoritative, kept current).
Business ops live outside this repo.

## How work happens

Working rules: no flattery · direct · evidence first · admit uncertainty · challenge assumptions · minimize words, time, complexity, waste.

Robert decides product, design and scope; that call is his and it is final. Everything technical —
architecture, reliability, security, maintainability — is settled in the session, on evidence, and
**every production change is reviewed before it lands on main**. State, decisions and scope drift are
kept current in `.ai/` by whoever does the work.

Pipeline: experiment → shadow → evidence → review → production.
Safety block: an unresolved safety objection stops a merge. Robert can override it; the override is
recorded in DECISIONS with the risk stated.

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

Working and verified end-to-end: capture 4 channels → edit → export → share. Robert records with it.

**Two things were making your recordings sound wrong, and neither was the part of the app that
handles sound (2026-08-26).**

The first: **music recorded from a tab was going through Chrome's telephone processing** — echo
cancellation, noise suppression and automatic gain, which are built for a voice call and turn music
into pumping mono mush. INOUT switches all three off when it asks for tab audio. But when a screen
share gets stuck, the app retries with a progressively simpler request, and the simplest version had
been dropping those three switches along with everything else. The 4K-game freezes last week pushed
your machine onto exactly that fallback, and it stays there for a day after the last freeze — so
every tab-audio recording you made since then was captured through the voice processor. The rule you
set for that fallback settles it: it may only drop things you never chose, and how your sound is
captured is not one of them. It now keeps them at every level. A machine still stuck on the fallback
fixes itself on the next recording; there is nothing to do.

The second: **the deploy that carried last week's audio fix had failed, silently.** A leftover file
meant the commit did not compile, so the live site quietly kept serving the version before it — the
one where the fix was present but disconnected. Every recording you tested was made on that build,
which is why the fix you were asked to listen for was never actually there to hear. The site now
serves the repaired build, and a check was added so a failed deploy cannot go unnoticed again.

**Both need one listen test each**: reload the app, record a normal take and a tab-music take, and
say whether they sound right. If tab music is still wrong, the console now prints what Chrome
actually delivered (`[capture] tab audio delivered: ec=… ns=… agc=…`), which says in one line whether
the problem is in capture or later.

**The editor stopped re-listening to audio it had already heard (2026-08-26).** While a recording is
being made, INOUT is already measuring how loud it is, moment by moment. It used to keep three numbers
from that and throw the rest away — so trimming a take, cutting one, or asking it to tighten the
silences all made it read the whole soundtrack a second time before it could start. It keeps the
measurements now (about 120 KB for half an hour), and those three jobs simply use them: "Tighten"
proposes exactly the same cuts it did before, in about a thousandth of the time. And while checking
that, one thing turned up that matters more than the speed: last week's fix for the audio quality Robert
reported as regressed was not actually reaching any export — the number it depends on was being
calculated and then quietly dropped on the way. That is fixed, and the listen test Robert owes is now a
test of a build where the fix is real.

**We started checking the sound of the file people actually get (2026-08-26).** INOUT has had an
automated listener for a while: it records a known set of tones, exports them, and complains if the
levels, the stereo or the distortion come out wrong. It was only ever listening to one of the three
ways INOUT can build a file — the slow, rebuild-everything one. The fast path an untouched recording
takes, which is what most people get by default, had never been listened to at all, which is exactly
the kind of gap that lets a sound problem ship unnoticed. It is checked now, on a recording shaped
like a real one, and the check refuses to pass if the fast path quietly didn't run.

The result is reassuring and worth writing down: the fast file and the slow file are the same to
three decimal places, on every measure. They share the same sound-mixing code — the fast path only
skips the video work — so there is no quality penalty for the quick export. One expected difference
is real and by design: a recording with two sound sources comes out about 6 dB quieter than one with
a single source, because INOUT deliberately leaves headroom so two loud sources can never clip each
other. The check now allows that specific, documented amount and flags anything else, so the number
stays Robert's to change rather than something a test quietly locks in.

**The "For AI" export stopped freezing the app while it builds (2026-08-26).** That file is not a
smaller video — it is a document of the recording's own frames, and building it costs about
three-quarters of what a full export costs. It was doing that work on the same thread that draws the
interface, so on a long recording the app went unresponsive for seconds. It now runs out of the way,
and the file it produces is byte-for-byte the same one: built four times, twice each way, all four
identical down to the checksum. The build is not faster — it was never meant to be — the app simply
keeps working while it happens. Measured on a short recording, the interface lost 13 ms instead of
84; on a real 97-second take that difference is roughly a second of unresponsiveness against ten.

**The engineering roadmap is finished (2026-08-26).** Everything on it that could be settled by
building or measuring has been. What is left is seven decisions and checks that are yours, not ours —
they are listed at the end of this section, and each one is a single question with the evidence
already gathered.

Four items on that roadmap turned out to be **wrong ideas**, and finding that out is most of what the
work bought. Parallel decoding made exports 1 % faster, not twice as fast. Drawing on the graphics
card fails on text. Lowering the recording data rate makes your download *bigger*. And "the export
smears screen text" is false — the export preserves text almost perfectly. None of those would have
been visible without measuring them, and three of the four had been on the plan for weeks as things
that would obviously help. (A fifth entry once sat here, and what it claimed was about SHARPNESS:
"capture throws away half of every letter's edge contrast". That number was our own measuring
mistake and it is retracted — letter *sharpness* survives recording intact. Letter *colour* does
not, and that finding is real, separate, and two sections below.)

**You can pause a recording now (2026-08-26).** A Pause button sits beside the record button while
you record. It does not release anything: the camera light stays on, nothing is asked for again, and
pressing Resume picks up on the same inputs — so a pause costs you no setup and no permission
dialogs. **The paused stretch is left out of the recording entirely**: if you record five minutes,
pause for two, and record five more, you get ten minutes with no dead air to trim. The on-screen
timer stops while you are paused, for the same reason.

One trade, and it is worth knowing: a paused recording takes the slower export path. INOUT normally
keeps a ready-made combined video while you record, which is what makes an untouched export almost
instant — but that is one continuous file and it cannot represent a gap, so pausing discards it and
the export rebuilds instead. Everything else is unaffected.

Not built yet: *retake* — dropping the last stretch and recording it again. That is a different
thing (it means reopening a finished recording) and it is written down as its own piece of work.

**Recording now costs about half the processor it did — but the change is switched off until you
say otherwise (2026-08-26).** While you record, INOUT saves each source separately as well as the
combined picture, and those separate files were being compressed the slow way, in software, twice
over. They can now use the graphics chip's built-in video compressor instead, the same one the
combined picture already uses. Measured on a 15-second test recording with nothing dropped on either
side: the browser's processor use went from 149 % to 95 % at its peak, and from 80 % to 47 % on
average. That is headroom that goes straight to the thing you actually hit — recording a demanding
game or a 4K screen.

It also fixes something that blocked this a month ago. The reason INOUT records those files in the
older format is that Chrome writes the newer one all at once, at the end — so a browser crash
halfway through lost the whole recording. The new path writes continuously, and the test for it is
the same one that rejected the idea last time: cut the file off halfway and see what still plays.
It plays back 56–88 % of the recording. The old way left 753 bytes.

**Why it is not on yet.** At the same quality setting the new compressor spends about a fifth of the
data on screen content, and the resulting picture is measurably different from the old one. It is
not losing frames — every frame is there — it is choosing to spend less. That may well be fine (the
combined picture INOUT already gives you does exactly the same thing), but it changes how an *edited*
export looks, and changing a picture you already have is your call and not ours. There is one
specific setting left to try that would likely close the gap; it is written down. Until then:
`?rawcodec=webcodecs` turns it on for one load if you want to compare.

**Screen text: the alarming finding was our own measuring mistake (corrected 2026-08-26).** We
reported that recording "throws away half the contrast of every letter edge" before the export ever
sees it. It does not. The test compared frames from the recording against a snapshot of the screen
taken at a *different moment* — and the test screen scrolls by one line every 2.5 seconds, so it was
comparing two different pages of text and reporting the difference as damage. Measured against the
picture that was actually recorded, neither recording nor exporting loses any measurable letter
sharpness. We can reproduce the old number on demand by deliberately shifting the reference one line,
which is how we know that is what happened.

**Robert looked at the crops and said the colours were worse. He was right, and it is the biggest thing
this work found (2026-08-26).** Coloured text — the green and blue words in a code editor — comes out
of INOUT with about **30 % less colour** than it went in. Grey text barely changes, so this is not
brightness or gamma; it is the way video compression stores colour at lower resolution than
brightness, and thin coloured letters are exactly what that hurts.

Measured against the actual screen, stage by stage:

| | green kept | blue kept |
|---|---|---|
| the screen itself | 100 % | 100 % |
| the raw recording of the screen | 80 % | 89 % |
| the combined picture we build while recording | 70 % | 75 % |
| **the file you download** | **70 %** | **75 %** |

Two things follow. **All of it happens while recording** — the export adds nothing at all; the
downloaded file is the combined picture copied across untouched. And **combining the screen with the
webcam costs a second helping of the same loss**, which is why the middle row drops again.

None of our existing checks could have caught this, and that is worth saying plainly: every quality
check we have compares one output file against another output file, so damage that happens to *all*
of them cancels out and reads as zero. It took a person looking at a picture. There is now a
measurement that compares against the original screen instead.

**And we checked that we blamed the right thing (2026-08-29).** "Colour stored at lower resolution
than brightness" and "we are converting colour slightly wrong somewhere" look identical on a page of
coloured text — both fade the coloured words and leave grey alone — so the whole case for the fix
below rested on it being the first one. The test that separates them: put the *same three colours*
through the *same compression* as big solid blocks instead of thin letters. Solid blocks give the
low-resolution-colour effect nothing to blur across, and a conversion error would not care. The
blocks come back at 99–101 % of their colour while the same page's thin letters come back at 80–82 %.
It is the letters, as claimed — which means full-colour-resolution recording will actually deliver
what it promises here.

**Half of it is fixed as of 2026-08-29, and the fix was to stop doing work.** A screen-only
recording never needed the combining step: the combined picture is just the screen, re-compressed a
second time. INOUT now hands you the *first* compression instead of the second. Same recording, one
step removed.

| a screen-only recording | green kept | blue kept | sharpness |
|---|---|---|---|
| before | 70 % | 75 % | 35.5 dB |
| now | **80 %** | **89 %** | **37.3 dB** |

It is also *faster* to export, because the file it hands you is one it did not have to build.

**One thing you should know, because it is not free.** The download is **14–23 % larger**. The two
files are compressed by different encoders at the same setting, and the one we now use spends more
of it. The colour improvement is *not* what those bytes bought — that comes from removing a step, and
we measured separately that tripling the data rate buys almost no colour back. But some of the
sharpness improvement is the extra bytes. If you would rather have the smaller file, `?singlegen=off`
puts it back for a load, and we can make that the default in one line.

This only applies to a **screen-only** recording at full 1080p. A recording with your webcam in it
still has to be combined, and so does a shared window that is not 1920×1080.

**And there is a second, bigger saving we have built but left switched off.** If the combining step
is not needed, we do not have to *run* it at all — which is a whole hardware video compressor that
never starts, and **45–49 % less data written to disk per second of recording**. It is off because it
would cost two things: INOUT would stop noticing when your screen freezes, and the live preview while
recording would come from the raw camera/screen feed instead of the combined picture. Both are real,
so that switch is yours: `?singlegen=capture` turns it on for one load.

**The rest** needs full-colour-resolution recording, which on this machine only exists in software —
roughly double the processor load. That is the trade below.

**What is still true, and it is the useful half.** There *is* a compression mode that makes coloured
text visibly crisper: it keeps colour at full resolution instead of quarter resolution, and it halves
the colour bleeding around letters — at slightly fewer bytes. Turning the data rate up three times
over does almost nothing by comparison, so this is not something more bandwidth can buy. The catch is
the price: no chip in this machine does it, so it would run on the processor — roughly 80 frames a
second at 1080p against 207 for what we use now, and about twice the processor load. Whether that is
worth it is a judgement call, and there are magnified before/after crops in `~/Downloads/x15-text-truth/`
so it can be made by eye rather than from numbers.

**Three optimizations were tried, measured, and thrown away — which is the point of measuring
(2026-08-26).** All three were on the roadmap as promising and all three turned out to be wrong, and
finding that out cost sessions rather than releases.

The first was to split the slow part of exporting — decoding your recording frame by frame — across
several processor cores instead of one. It was built and it worked, in the sense that it produced
exactly the same file. It made exporting 1 % faster, against a target of twice as fast. The reason is
worth keeping: decoding on a second core is just as fast as decoding on the first when nothing else
is happening, but the moment the export is also compressing video beside it, both slow down together
— they are queueing for the same underlying machinery, and adding threads does not create more of it.
The code was removed entirely; the export is exactly what it was. What stays is a one-command check
that reproduces those numbers, so the idea does not have to be re-argued from intuition next time.

The second was to lower how much data INOUT writes to disk while recording. The premise turned out to
be wrong twice over. It does not write anywhere near what was assumed — roughly 2.3 GB an hour for a
screen recording, not the 8 GB the roadmap implied, because the quality ceilings it sets are ceilings
and ordinary screen content never comes close to them. And lowering the one setting that looked
wasteful makes things *worse*: recording the screen at a third of the data rate saves a third of the
disk and makes **the file you actually download 31 % bigger**, because a rougher recording is harder,
not easier, to compress at export time. The recommendation is to change nothing, and that is a
finding rather than a deferral.

The third was to draw the exported picture on the graphics card instead of the processor. That one is
genuinely faster — about 1.7× at the drawing step — but drawing is only a quarter of what exporting
costs, so the whole change was worth roughly a tenth of export time. And it fails on something that
matters more: **the two ways of drawing do not produce the same text.** Compared on the same frames,
about 4 % of pixels differ, and they are the pixels that make up letters — the two methods handle
colour detail at sharp edges differently. Making exports faster by changing how text looks is not a
trade to take quietly, so it is now a question for Robert rather than a change.

**And that raised something worth checking on a real recording — now checked (2026-08-26).** INOUT
draws with both methods: the fast export of an untouched recording copies a picture drawn one way,
while a fully redrawn export uses the other. Measured on a real recording, **trimming does not change
your file at all** — a trimmed export comes out byte-for-byte identical to the untrimmed one, because
trimming copies the original picture rather than redrawing it. The full redraw does cost a little:
about twice as many visibly-off pixels as simply re-compressing the same picture would. Real, small,
and it only applies to exports that cannot take the fast path. The lab number turned out to be about
four times worse than what actually happens.

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
rather than code. Robert exported a 97-second walkthrough of a product UI and gave it to an agent to
recreate that UI and its animations. The AI **asked what to do with the file** — page one had opened
with machine facts instead of saying what the document was — and Robert's own verdict was that it **lost
far too many frames**: a stretch where a field was typed into, a button turned active, was clicked
and a tab switched had fallen entirely between two pages five and a half seconds apart. Then Robert
challenged the format itself, and was right to: the page ceiling the design had been built around was
a number taken from memory rather than checked. It is wrong — Claude accepts 600 pages and 32 MB,
Gemini 1000 pages and 50 MB — so the format was never the constraint; the cost is tokens, and how
many frames a recording earns is a spending decision, not a wall. All three are fixed and measured on
that same recording: the file briefs its reader in its first lines, and it went from 39 frames to
165, median gap 0.4 seconds, nothing longer than 2.9, the whole take covered. Frames go densely
through anything moving — an animation comes back as a sequence, which is what recreating one needs
— and not at all while the screen is still.

**Robert's move: re-test.** The rebuilt version of that same take is at
`~/Downloads/inout-20260824-183853-for-ai-v2.pdf` for a side-by-side against the original file and
the MP4. That report decides whether the richer layers (DOM events, transcript, repro bundle) get
built at all.

Shipped 2026-08-23 (eleven merges; engineering detail in `.ai/DECISIONS`, task state in `.ai/TASKS`):

- **Reliability.** Recording could hang on arming with no way out and leave the mic indicator lit
  after a refresh. Each arming step had a deadline but the waits that JOIN them did not; the record
  button was disabled while arming, so there was nothing to press; and nothing released devices when
  the page went away. All four closed, Robert-verified.
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
  up is proven. THE FLIP HAPPENED the same day, on Robert's word: the new engine IS the default now,
  with the old one intact underneath as an automatic fallback (unsupported browsers, a failed
  start, or a machine that can't keep pace) and a one-parameter revert. Every gate was green on
  the way: full test suite, both engines' oracles, the eight-gate QA on the production build in
  real Chrome, recording-start latency proven unaffected. What users get: capture that costs the
  main thread nothing, LESS CPU, an audibly smaller A/V sync offset (~34-48 ms vs ~60), and a
  recording that is a playable file on disk even mid-take. Waiting on Robert's first real recording
  to confirm; the sync target and a preview optimization remain as polish.
- **A/V sync is worse than we thought, and the instrument was why.** Every sync number quoted before
  2026-08-23 was ~31 ms optimistic: the oracle carried an exact 18 ms detection bias and never
  measured the video reference at all. The true offset is ~45–63 ms, audio late — which is what Robert
  felt on a real take. The cause is understood (the audio anchor cannot see input latency; measured
  at +128.7 ms on a loopback rig) and partly compensated. Closing it properly is the WebCodecs
  engine's job (O4), whose target is ≤20 ms.
- MP4 capture on Chromium was tried and **rejected on evidence** — Chrome does not stream it, so a
  tab kill would lose the whole take. That hardware-encode win moves to O4, which owns its own muxer.
- Cloud unprovisioned. Composite still absent from crash salvage (O4 makes it free).

## Roadmap (Robert-approved 2026-08-22 — executable plan and READY map in .ai/TASKS)

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
the export moves it at the moment you moved it (Robert's emphasized feature). And, found while building it,
**edits now survive a refresh**: until today a reload restored your recording but silently threw away
every trim and cut you had made. **Yandex Browser preparation** landed too: the app can now tell Yandex
from Chrome, and there is a one-command QA runner and an RU network probe.

**Shipped 2026-08-23 in one session, on Robert's "roadmap o/f, all in one session":** the background
frame · silence tightening · the finer export ladder · the whole bits audit and the two size levers it
priced. (An "in-shot" notice shipped the same day and was pulled on Robert's call — see DECISIONS.)
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

**New 2026-08-24: AI export (phase A in .ai/TASKS) — Robert's named top priority.** A second export
target next to the MP4: **one file any AI understands instead of a video it must watch**. The file
is a PDF — the only single-file format every major AI reads natively as text plus images; nothing
in it is a video and nothing in it needs a tool to open. Inside, maximum token cheapness: a
one-page text index (take facts, what capture knew went wrong, and a page-numbered list of the
screenshots), then one change-driven screenshot per page. The button (AI1) ships first. Everything
richer — DOM event sidecar, transcript, repro bundle, markers, MCP access, redaction — is marked
as a **candidate only** (AI2–AI7) and gets reconsidered after Robert feeds the first real file to an
AI and reports how it went. The sidecar additionally waits on a product decision only Robert can make:
where events come from (a browser extension, an SDK snippet in the recorded page, or the desktop
shell). The transcript stays Robert-gated under the standing no-AI rule because speech recognition is
a local model; the export format itself runs no model anywhere.

**Runs in parallel now:** the AI export button (AI1, Robert's named priority) · the out-of-sync fast
export (P0 — trimming waits on it) ·
native-resolution capture · crisp screen text · pause/retake · frame-exact scrubbing · the size-number
probe, attempt 5 · the codec ladder and the real Firefox run, both waiting on one install (below) ·
the iOS ScreenCaptureKit spike (time-sensitive: iOS 27 ships ~Sept 2026, and it needs a device we do
not have).

**Waiting on Robert:** approve one dependency install — `npm i -D playwright && npx playwright install
firefox` — which unblocks both the real Firefox run and the codec ladder that needs three engines to
test against. Install Yandex Browser and run the one-command QA smoke.
Run the RU reachability probe from a Russian connection without a VPN. And two rechecks on real
hardware — a camera-only take should now record 1080p rather than upscaled 720p, and the Safari audio
path has never been verified on a real Apple device.

Competitive stance: the empty quadrant is no-install + local-first + world-class output — vs Loom's
network (mediocre tool), Screen Studio's Mac-only polish, Cap's required install, Tella's cloud-bound
browser. Share loop stays the minimal signed-link cloud already scoped.

## Next — seven things that need you

The engineering roadmap is done. Each of these is one question with the evidence already gathered;
none of them can be settled without you.

**NEW AND AHEAD OF ALL SEVEN (2026-08-29).** You read the flags file, asked what the 1920×1080 rule
was, and rejected it: *"it must be device resolution, how the fuck mobile will make 1920x1080? its
vertical."* You are right, and it is worse than black bars. **INOUT cannot make a vertical video.**
The output size is a landscape constant, all four quality steps are landscape, and a camera-only
take — the only kind a phone can make, since iOS gives browsers no screen recording — is CROPPED to
fit, not letterboxed. Measured on the live app: a 4:3 source keeps 75 % of its height. A real phone
camera at 9:16 would keep 31 % — **68 % of the video thrown away, head and chin gone.**
**F13 IS NOW BUILT, and it is waiting on your eye — see the ask at the top of the list below.**
The audit that came with it found four more ceilings of the same shape:
a still screen being mistaken for a slow machine and quietly dropping your resolution
(P0-ladder-static, live today); two improvements shipped the same morning that cancel each other
(O3c); an export quality setting that sticks forever and silently makes every later export slow
(F14); and 30 fps welded into every path with no way to lift it (F15 — that one is a question for
you, not a bug). All five are on the READY map in `.ai/TASKS`.

**LATER THE SAME DAY you ruled and two of the five are fixed, live.** Your message — *"every device
records the best it can, 60 fps, minimal size, couple minutes ~10 MB"* — settled F15 (60 fps: yes,
scheduled behind F13 so it is derived from the take, not welded in as a new constant) and set the
size objective. Shipped and verified on the live app the same session: a still screen no longer
loses resolution for being still (P0-ladder-static — before the fix a static screen walked BOTH
ladder rungs down in 10 seconds; after, zero steps), and the export step that MATCHES your screen is
now an instant copy of the raw recording instead of a re-render (O3c — this is the fix for "picked
1440p on a 1440p screen and waited hours for a 10 GB file": that click is now ~a second, native
detail, and the size shown is exact). What is left of "minimal size" is one decision only you can
make — the codec (details in `BACKLOG.md`, carried as SIZE-CODEC on the READY map): AVC plays
everywhere and is the floor today; HEVC/AV1 is the ~2× you keep pointing at with the movie-file
comparison. Recommended: an honest "smaller file, newer players" option in the export panel now,
and the cloud player switching automatically once cloud lands.

0. **Record yourself on your PHONE again — it should just work now, no link needed.**
   Two things were wrong, and the second one you found yourself.
   **The one you saw twice:** the app asked the browser how big the camera was, and on a phone the
   browser answers with the *sensor's* size — sideways — while the pictures it hands over are the
   upright ones you are holding. It believed the answer instead of looking at the pictures.
   **The one your third message solved:** you said the mic waveform was there but no sound. That
   sentence was the whole diagnosis. Safari cannot record the file format the app assumed, so every
   recording on an iPhone was saved under a name that described the wrong format — and Safari, which
   trusts the name, then refused to play any of it. Silent mic, and a camera the editor could not
   open. Because it could not open it, it could never learn the real shape either, which is why the
   video stayed horizontal no matter what else was fixed. One cause, both symptoms.
   Fixed: files are labelled by what they actually are (including ones you already recorded), the
   shape now comes from the picture a decoder actually opened, and a camera-only video is never
   cropped — if anything ever disagrees you get black bars, not a missing chin.
   **On a phone this is now the default**, because a phone can only record its camera and the
   landscape rule was never right for one. Nothing changed on your computer.
   Please record a fresh one and tell me two things: is it the right shape, and can you hear
   yourself. If the sound is still missing, say whether the SAVED file is silent too or only the
   editor — that distinction points at two different fixes.

1. **Listen to two recordings.** A normal one and one with music from a tab. The audio fix you were
   asked to check before was never actually running — the number it depends on was being calculated
   and dropped. It runs now.
   **Same story again on 2026-08-26, for the growing desync:** your recheck ("mic and camera
   unsynch 1-2 s at minute 6", tab audio rotting to noise) failed because the anti-drift padding
   shipped on 08-25 was dead on the audio your exports actually use — it only ever ran on a track
   no export carries. It runs on the right audio now, verified under machine load in a real
   browser, and healthy takes are untouched. What it cannot do: bring back audio the machine never
   recorded while a game starves it — those moments are now honest short gaps instead of a
   desync that grows forever. A long recheck take (YouTube, then the game) is what closes it.
2. **Give a "For AI" file to an AI**, for the job you actually have, and say whether it worked. That
   report is the only thing that unfreezes the rest of the AI work.
3. **DONE — the new recording compressor is the default now (your call, 2026-08-26).** You ran days
   of takes on `?rawcodec=webcodecs` and said the sound is okay with it; measurements agreed (10×
   less audio starvation, and the "picture differs" worry turned out to be our own measuring
   mistake — identical pictures at half the data). `?rawcodec=mediarecorder` reverts one load if
   anything ever looks off. The further saving it unlocks (skipping the combined file entirely on
   screen-only takes) is now on the READY map.
4. **Decide whether exports may get quieter.** Your recordings currently come out 1–9 dB louder than
   the level everything else on the internet is normalised to, and they vary by almost 8 dB depending
   on what is in them. The standard fix is to turn them down. Everything to do it is built.
5. **Re-test the 4K game tab** with `?nativeres=1` and tell us what the console says. We built the
   safety net that steps the resolution down under load; we cannot test it, because a fake 4K source
   costs the browser something a real screen does not.
6. **Closed 2026-08-26**: trimming does not change how your text looks — a trimmed export is
   byte-identical to the untrimmed one. What is left for you is a judgement call, not a question:
   look at `~/Downloads/x15-text-truth/` and say whether the crisper-text compression mode is worth
   about twice the processor load.
7. The standing ones: a real Safari recording, a camera-only recording, and the Yandex/RU checks.

Robert records with the tool and reports bugs; that loop is working and is what caught both the mic hang
and the sync drift. Next: (1) provision Supabase + Google OAuth (~15 min, docs/CLOUD_SETUP.md) then
e2e login→upload→share→view; (2) Robert keeps using INOUT daily and collecting pain points.
Engineering (review-gated): O4 as the single big rock, features and ports in parallel — see .ai/TASKS.
Ship: (7) domain + email (no payments yet); (8) public deploy; (9) UX pass from pain points (Robert);
(10) first users + feedback channel.
After real usage data: next milestone · business model · validation approach · launch path.
Reading discipline: a session reads what its task needs, not everything — `.ai/TASKS` for the
assignment, `.ai/ARCH` and `src/*` for the code, and the rest only when the task reaches it.
Deleted from old master list: playback page (signed links play directly), SPEC/STATE/TODO file set
(superseded by CONTEXT.md + .ai/), 44 completed build items.

## Experiments — there is no experimental tree any more (Robert ruling 2026-08-25, done 2026-08-26)

Robert: "i just dont want experiments be separated, all the shit must get in worked or be deleted." So a
module either is tooling a live gate runs — the pipeline oracle, the measurement rigs behind each
task's evidence — or it is spent, and spent means deleted, with the verdict kept in `.ai/DECISIONS`
and the code kept in git. The dormant half is gone (2,745 lines): the session log, the WebCodecs
capture A/B, the streaming-export benchmark, timed data channels, TimeMap/Scene, the semantic
artifact. What they proved is in the product rather than beside it — the WebCodecs rig BECAME the v2
live composite, the streaming benchmark BECAME the stream-to-disk export, the size probe BECAME the
export panel's measured sizes. Nothing merges without evidence + review sign-off; nothing waits around
without a task, either.

The same ruling now cuts the other way too, and 2026-08-26 was the first time: a piece of PRODUCTION
code that was built, measured and found not to pay is deleted on the spot rather than left switched
off "in case". The parallel-decode export change is gone — it worked, it produced identical files,
and it bought 1 %. What is kept instead is the one-command measurement that reproduces the numbers,
so the next person to have the same idea can settle it in five minutes rather than five hours.

## Risks

Platform-creep before validation · polishing before Robert's real QA · random experiments entering
production (gate: review) · browser permission edge cases on real devices · free-tier storage limits
are product-visible. Closed 2026-08-26: a broken commit can no longer reach Vercel silently —
every push is build-gated locally, and `scripts/verify-deploy.mjs` proves prod serves HEAD.
