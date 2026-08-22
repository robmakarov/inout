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
- 30-min cap (until stream-to-disk exports land — TASKS O1) · channels recorded separately (per-channel trim) · export always a real file
- Cloud optional: Google login, free tier, finished exports only, 512 MB/user, 7-day links (Supabase behind swappable interface)
- Security: TLS + at-rest + signed links, minimal data, E2EE-compatible architecture
- Excluded permanently: AI/transcripts. MVP excluded: native apps, P2P, collaboration, social, permanent
  free storage. Editor expansion is now the approved post-MVP roadmap (2026-08-22, see Roadmap below)
- Backlog (approved): **instant link mode** — opt-in progressive upload + cloud assembly, OFF by default
- North star: **distributed multi-device capture** (phone camera + laptop screen, one time model). Shapes time/session/format decisions now; product work gated on a 2-device sync spike with kill criteria. iOS = Safari capture node first; thin native node later; never a separate editor.
- Never: real-time streaming as the capture basis · closed project format · sub-ms multi-mic mixing promises · silent background capture · deterministic replay of live media

## State (2026-07-15)

Working and verified end-to-end: capture 4 channels → edit → export → share.
Shipped this week: A/V sync fix (measured audio pipeline; was +171 ms), crash-durable recording
(refresh/crash mid-take salvages all channels, boots into editor), instant start (devices acquire
during the screen picker), instant export (~105 ms, MP4, live composite; edits fall back to render),
audio noise fixes (worklet splicing, mixer limiter, raw system audio for music).

Known gaps: ±45 ms sync jitter (video epoch — next task), composite absent from crash salvage,
bundle 748 KB (code-split later), cloud unprovisioned.

## Roadmap (PO-approved 2026-08-22 — executable plan in .ai/TASKS)

Optimization first, then features. Ordering is dependency order; every task evidence-gated.

1. **Optimization O1–O8**: exports stream to disk (removes the RAM ceiling on long takes) · loudness
   measured during capture (makes instant export truly O(1)) · Chromium capture moves to hardware
   mp4/h264 with single-generation packet-copy exports · WebCodecs worker compositor (the keystone:
   sub-frame sync, zero redundant decodes, smart-cut prerequisite) · pipelined worker export with
   smart-cut + HEVC/AV1 ladder · native-resolution capture behind measured backpressure · bundle split ·
   performance oracle bands.
2. **Features F1–F7**: mid-take cuts · zoom/pan (soft-yes, reconfirm) · background/frame ·
   movable camera (draggable on the stage, movement is TIMED and replayed in the export) ·
   silence tightening + per-segment speed (deterministic DSP, no transcript) · pause/resume + retake ·
   quality slider before export.

Competitive stance: the empty quadrant is no-install + local-first + world-class output — vs Loom's
network (mediocre tool), Screen Studio's Mac-only polish, Cap's required install, Tella's cloud-bound
browser. Share loop stays the minimal signed-link cloud already scoped.

## Next

Validated: PO completed a real Chrome full-flow QA and judged the MVP acceptable; bugs were
reported to the TD for triage. Next: (1) provision Supabase + Google OAuth (~15 min,
docs/CLOUD_SETUP.md) then e2e login→upload→share→view; (2) PO uses INOUT daily, collects pain points.
Engineering (EE, TD-gated): the Roadmap above — .ai/TASKS O1–O8 then F1–F7 (oracle-in-CI done).
Ship: (7) domain + email (no payments yet); (8) public deploy; (9) UX pass from pain points (PO);
(10) first users + feedback channel.
After real usage data: next milestone · business model · validation approach · launch path.
PM: establish context-separation rules per role — each role gets its own scoped briefing (what it
needs to know, what it must do, how, and what it must NOT touch), instead of everyone reading
everything. TD drafts the per-role templates; PM owns keeping them current.
Deleted from old master list: playback page (signed links play directly), SPEC/STATE/TODO file set
(superseded by CONTEXT.md + .ai/), 44 completed build items.

## Experiments (verdict 2026-07-14, details: src/experimental/TD-VERDICT.md)

Shipped to production: durable writes, measured audio (sync). Instrument: pipeline oracle (QA by
numbers). Merged: TimeMap. Dormant until needed: scene, data channels, semantic, WebCodecs rig
(graduates via task 2), streaming export (needs container decision). Nothing else merges without
evidence + TD sign-off.

## Risks

Platform-creep before validation · polishing before PO's real QA · random experiments entering
production (gate: TD) · browser permission edge cases on real devices · free-tier storage limits
are product-visible.
