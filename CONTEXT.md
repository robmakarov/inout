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

- **The end of a take can go missing under load.** Newly measured, not yet fixed: 3.8 seconds lost off
  a 4K recording. The gate that was supposed to catch exactly this only ever ran on a gentle rig.
  First item on the engineering roadmap.
- **The new capture engine is off.** It is faster where it counts for the interface and tighter on
  sync, but the browser's video encoder gives it 10 fps at 1080p against the old path's 30. Turning it
  on would trade a working recording for a stuttering one, so it waits for a machine or a browser
  version that hands WebCodecs a real hardware encoder.
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
split · sync root-cause + honest gate · quality slider · mid-take cuts · tail/throughput bands +
certified exports · PWA install · movable timed camera + edit persistence · Yandex/RU pack part 1 ·
WebCodecs capture engine (merged dormant, see below).

**Next, and it is a bug, not a feature.** The composite we ship today loses the end of a take when the
machine is under load: on a 4K source it delivered 13.3 fps and the last frame in the file sat **3.8
seconds before the end of the recording**. At 1080p the same measurement is 65 ms, which is why nobody
had seen it — our tail gate only ever ran on a gentle test rig. This is the thing PO named as
unacceptable in a competitor, happening in our own product. Task `P0-tail`.

**O4, the WebCodecs engine: built, measured, and deliberately switched off.** Capture now *can* run in
a worker compositor feeding our own encoder and fragmented-MP4 muxer, and on every axis but one it is
better — it takes capture off the main thread completely (131 ms of blocking work per take becomes
zero), it syncs tighter (40 ms vs 59), and because it owns the encoder it can drain it at stop instead
of asking a black box to stop. The one axis is the one that matters most right now: the browser's own
video encoder delivers ~10 frames per second at 1080p where the old path delivers 30, and the
measurement isolates that to the encoder rather than to anything we wrote. So it ships dormant behind a
switch, with the harness that will say when to turn it on. **The keystone is therefore only half
placed** — smart-cut exports, native-resolution capture, pause/retake and frame-exact scrubbing still
wait on it.

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

**Runs in parallel now:** P0-tail (the live defect) · the O4 remainder · F7c · Firefox + 3-engine
oracle · per-segment speed · the codec ladder · the iOS ScreenCaptureKit spike (time-sensitive: iOS 27
ships ~Sept 2026).

**Waiting on PO:** zoom/pan scope reconfirm. Install Yandex Browser and run the one-command QA smoke.
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
