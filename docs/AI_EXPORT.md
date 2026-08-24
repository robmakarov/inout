# AI export — spec

Status: agreed 2026-08-24; v1 scoped same day — PO: **max token cutting is the design goal**, the
button ships first, every richer layer goes to the roadmap (`.ai/TASKS` phase A). A second export
target next to the MP4: capture → … → **agent bundle** → share.

Agents don't watch video — they sample frames and pay roughly 1 token per 750 pixels: a 1024×576
view ≈ 800 tokens, a full 1080p frame ≈ 2 800, a 5-minute video is thousands of frames. The bundle
exists to spend as few of those as possible: text before pixels, low-res before full-res, and
nothing shipped that a cheaper layer already answers.

## Design law: no knobs

Every parameter a human would set is either **derived from a signal already in the recording**, or
**both layers ship and the agent's reading order decides**. In one line:

> The recorder captures everything, the export adapts from signals, and the agent pulls.

| knob you'd be tempted to add | the signal that replaces it |
|---|---|
| frame rate | pixel delta — dense keyframes during motion, near zero when static |
| resolution | low-res full view + full-res crop of the changed region |
| small vs complete bundle | layering — cost scales with how deep the agent descends |
| record quality | none — always capture max, derive everything down at export |

## V1 — the button (task AI1)

One "For AI" control in the export panel. Output: a **zip** (share targets need one file; INDEX at
the zip root; unzipped it works as a plain folder — agents read the index and descend; no server,
no API).

```
inout-ai-<take>/
  INDEX.md      ≤~150 tokens. What this is, duration, resolution, the clock note, the keyframe
                list, and the approx token price of each layer — the agent budgets its descent
                from this file alone.
  events.jsonl  v1 carries only what capture already knows: channel on/off segments, stalls,
                take duration. (DOM events are AI2 — see scope, below.)
  keyframes/    pixel-delta sampled. Per keyframe: t0012500_full.webp (≤1024 px wide full view)
                + t0012500_crop.webp (full-res crop of the changed region). Timestamp = ms.
  video.mp4     the ordinary default-tier export. Bottom of the stack; costs tokens only if opened.
```

Rules that are decisions, not defaults:

- **The bundle follows the edit.** Cuts, speed, zoom are the user's expressed intent; keyframe and
  event times are remapped through the same output→recording mapping the render uses, and cut
  content must not appear.
- **Clock:** every timestamp sits on the recording epoch. If the bundled video's t=0 differs (the
  composite's first packet sits 133–300 ms in — see P0-instant-sync), INDEX declares
  `clockOffsetMs`. Never assume composite time is recording time; that assumption is the P0.
- **No generated prose.** "No AI" is a standing PO ruling — INDEX content is signal-derived
  (durations, counts, filenames), never model-written summaries.
- **Keyframe selection is pure and unit-tested**, with a defined delta metric (share of changed
  pixels on a downscaled luma diff) so "dense during motion, near zero when static" is testable.

## Scope honesty — where events can come from

inout is a web page: it sees DOM events only in **its own tab**. No browser API exposes the input
events of a captured surface (another tab, a window, the screen). So the event sidecar this spec
originally led with needs a capture vehicle, and that is a PO decision (task AI2):

- (a) **companion extension** — covers other tabs, not native apps;
- (b) **SDK snippet** in the recorded page — the "developers record their own product" market;
- (c) **the desktop shell (P4)** — global cursor/clicks natively; richest, latest. P4 already
  specs a cursor/click metadata track; AI2 is its browser-side sibling.

V1 ships without DOM events and INDEX says so.

## Deferred, not rejected (roadmap: `.ai/TASKS` phase A)

- **AI2 event sidecar** — click/key/scroll/nav/focus + role/name/bbox per event; visible text
  recorded in ordinary fields, count-only in password/sensitive fields (the pixels show the text
  anyway — withholding it only costs the agent image tokens). Events drive full-res crops around
  the click point.
- **AI3 voice transcript** — VTT, silence/filler stripped, original timestamps kept. ASR is a
  local model: PO-gated per instance under the no-AI rule.
- **AI4 repro bundle** — console errors + failed requests timestamped against the take; needs
  AI2's vehicle.
- **AI5 marker key** during recording — lands as ordinary events.jsonl lines.
- **AI6 addressable recordings / MCP server** — agent pulls a take by reference; after cloud.
- **AI7 PII redaction** — after AI2 (events name what is sensitive).
- **bursts/** dense frame sequences — only if an agent use case proves the need; delta sampling
  already covers motion coarsely.
- **low-rate pointer trail** (~5 Hz) — cheap attention signal; with AI2.
