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

## State (2026-08-23)

Working and verified end-to-end: capture 4 channels → edit → export → share. PO records with it.

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
- **You are in the shot** — hiding the browser's "you are sharing your screen" bar yanks you back to
  INOUT, and no web page can prevent that. What INOUT can do, and now does, is stop filming itself and
  tell you what happened.

Known gaps, honestly stated:

- **The end of a take going missing under load is FIXED for the composite** — 2.7 seconds lost off a
  4K recording became 0.04-0.3 seconds, and the recording now recovers about a megabyte at every stop
  that used to be thrown away. A take whose encoder never catches up says so, and the fast export
  path refuses to ship it. **The raw channels still lose up to 0.75 seconds** under the same
  artificial load; that is the next item, and it needs care because it touches the code that once
  wedged the record button.
- **The new capture engine is off, and we now know we were blaming the wrong thing.** It was deferred
  on "the browser's video encoder is too slow here". That is measurably false: the same encoder does
  150-190 frames a second in isolation, and 169 even inside a worker, while the engine delivers 7.5.
  Nine candidate causes are eliminated with numbers and one suspect is left — how frames are handed
  across the thread boundary. This is good news: it is a bug we can find rather than hardware we have
  to wait for.
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
WebCodecs capture engine (merged dormant, see below) · the bits audit and the two size levers it
priced · background frame · silence tightening · timed zoom/pan · the composite tail fix.

**Next, and it is a bug, not a feature.** The *raw* channels still lose up to three quarters of a
second off the end of a take under heavy load. The composite — the file you get when you export
without editing — was losing nearly three seconds and is fixed; the channels an EDITED take renders
from are not. Task `P0-tail-raw`. It is small in code and delicate in placement: the fix touches the
stop path that once left the record button wedged, so it wants its own session.

**O4, the WebCodecs engine: built, measured, switched off — and we now know we were blaming the wrong
thing.** Capture *can* run in a worker feeding our own encoder and fragmented-MP4 muxer, and on every
axis but one it is better: capture leaves the main thread entirely (131 ms of blocking work per take
becomes zero), sync is tighter (40 ms vs 59), and because it owns the encoder it can drain it at stop
instead of asking a black box to stop. The one bad axis is throughput — 7.5 frames a second at 1080p
where the old path does 30 — and that was blamed on the browser's video encoder. Measured properly
this session, that encoder does 150–190 frames a second in isolation and 169 even inside a worker, and
the full compositor path does 59 with the encoder never once waiting. Nine candidate causes are now
eliminated with numbers and one suspect remains. **The keystone is still only half placed** —
smart-cut exports, native-resolution capture, pause/retake and frame-exact scrubbing wait on it — but
it is waiting on a bug we can find rather than on hardware we cannot buy.

**Shipped alongside it:** the **timed movable camera** — drag the picture-in-picture on the stage and
the export moves it at the moment you moved it (PO's emphasized feature). And, found while building it,
**edits now survive a refresh**: until today a reload restored your recording but silently threw away
every trim and cut you had made. **Yandex Browser preparation** landed too: the app can now tell Yandex
from Chrome, and there is a one-command QA runner and an RU network probe.

**Shipped 2026-08-23 in one session, on PO's "roadmap o/f, all in one session":** the background
frame · silence tightening · the finer export ladder · the whole bits audit and the two size levers it
priced · the in-shot notice. One gate was NOT met and is a task rather than a footnote: the per-step
size number cannot be honest to ±20 % on every kind of content, because it is predicted from a file a
DIFFERENT encoder made — on text-heavy screen content the two encoders disagree by nearly 2×. The fix
is to measure rather than model (encode one frame per step and calibrate), and it is task F7c.

**Also shipped 2026-08-23, on "go p0-tail and others":** the composite tail fix · timed zoom and pan
(you chose timed zooms over a static reframe) · the O4 re-diagnosis. And one thing deliberately NOT
shipped: three attempts to measure export sizes instead of predicting them, all measured, none better
than the model they would have replaced. The spike is kept with its numbers so the next attempt starts
from the fourth idea.

**Runs in parallel now:** P0-tail-raw (the live defect) · the O4 hunt · the size-number probe, attempt
4 · Firefox + 3-engine oracle · per-segment speed · the codec ladder · the iOS ScreenCaptureKit spike
(time-sensitive: iOS 27 ships ~Sept 2026).

**Waiting on PO:** install Yandex Browser and run the one-command QA smoke.
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

## Experiments (verdict 2026-07-14, details: src/experimental/TD-VERDICT.md)

Shipped to production: durable writes, measured audio (sync), streaming export (graduated 2026-08-23
as O1 — the container question was answered by keeping mediabunny and writing through the positioned
OPFS writer). Instrument: pipeline oracle (QA by numbers), now with tail-integrity and throughput
bands, plus a measurement harness for memory, capture cost, bundles and UI (see `.ai/TASKS` tooling
index). Merged: TimeMap. Dormant until needed: scene, data channels, semantic. WebCodecs rig graduates
via O4. Nothing else merges without evidence + TD sign-off.

## Risks

Platform-creep before validation · polishing before PO's real QA · random experiments entering
production (gate: TD) · browser permission edge cases on real devices · free-tier storage limits
are product-visible.
