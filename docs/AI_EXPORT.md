# AI export — spec

Status: agreed 2026-08-24; v1 re-scoped same day — PO: **one file that any AI will understand,
not human-watchable**, max token cutting is the design goal. Everything beyond the file is a
roadmap candidate, reconsidered only **after PO tests the first real file** (`.ai/TASKS` phase A).

Agents don't watch video — they sample frames and pay roughly 1 token per 750 pixels: a 1024×576
view ≈ 800 tokens, a full 1080p frame ≈ 2 800, a 5-minute video is thousands of frames. The export
exists to spend as few of those as possible: text before pixels, low-res before full-res, nothing
included that a cheaper layer already answers — and no video track at all.

## The format: one PDF

The deliverable is a single PDF, because it is the only one-file format every major AI ingests
natively as **text + images together** — Claude (chat, Code, API), ChatGPT, Gemini, and API-level
agents all read PDFs without tools. The alternatives all fail the "any AI, one file" bar: a
zip/folder needs a shell and a filesystem · markdown cannot carry images in one file · images
base64-embedded in text arrive as text and explode the token bill · an mp4 is the thing agents
cannot afford to watch. A PDF is not a watchable video: it is a machine-readable document. That a
human can also skim it is incidental, not the goal.

## Design law: no knobs

Every parameter a human would set is either **derived from a signal already in the recording**, or
**layered inside the file so the agent's reading order decides**. In one line:

> The recorder captures everything, the export adapts from signals, and the agent pulls.

| knob you'd be tempted to add | the signal that replaces it |
|---|---|
| frame rate | pixel delta — dense keyframes during motion, near zero when static |
| resolution | ≤1024 px full view; full-res crop added only when the changed region is small |
| short vs complete file | page order — index first, an agent that can page (Claude Code `pages`) descends selectively |
| record quality | none — always capture max, derive everything down at export |

## V1 — the file (task AI1)

One "For AI" control in the export panel → `<take>-for-ai.pdf`.

- **Page 1 — the index (pure text, ≤~200 tokens).** What this is, duration, resolution, the clock
  note, the event lines (v1: channel on/off segments, stalls — the facts capture already knows),
  and the keyframe list: one line per keyframe with timestamp and page number, so an agent that
  reads pages selectively knows exactly where to go. All of it selectable text, not rasterized.
- **One keyframe per page.** A ≤1024 px full view (JPEG — PDF-native DCTDecode, no exotic
  filters), captioned with its timestamp as real text. When the changed region is small (<~25 %
  of the frame), the same page carries a full-res crop of it — signal-derived, never a setting.
  Page dimensions equal the image, so no pixel is padding and per-page token cost is predictable
  (~800 tokens at 1024×576).
- **No video track anywhere in the file.** The ordinary MP4 remains a separate, unrelated export.

Rules that are decisions, not defaults:

- **The file follows the edit.** Cuts, speed, zoom are the user's expressed intent; keyframe and
  event times are remapped through the same output→recording mapping the render uses, and cut
  content must not appear.
- **Clock:** every timestamp sits on the recording epoch. If the source video's t=0 differs (the
  composite's first packet sits 133–300 ms in — see P0-instant-sync), the index declares
  `clockOffsetMs`. Never assume composite time is recording time; that assumption is the P0.
- **No generated prose.** "No AI" is a standing PO ruling — index content is signal-derived
  (durations, counts, timestamps), never model-written summaries.
- **Keyframe selection is pure and unit-tested**, with a defined delta metric (share of changed
  pixels on a downscaled luma diff) so "dense during motion, near zero when static" is testable.
- **Zero dependencies:** a minimal PDF writer (JPEG images + built-in Helvetica text) is a few
  hundred lines and stays ours.

## Scope honesty — where events can come from

inout is a web page: it sees DOM events only in **its own tab**. No browser API exposes the input
events of a captured surface (another tab, a window, the screen). So the event sidecar this spec
originally led with needs a capture vehicle, and that is a PO decision (candidate AI2):
(a) companion extension — other tabs, not native apps · (b) SDK snippet in the recorded page —
the "developers record their own product" market · (c) the desktop shell (P4) — global
cursor/clicks natively; richest, latest. V1 ships without DOM events and the index says so.

## Roadmap candidates — considered only after PO tests the first real file

Named so they don't get reinvented, and deliberately **not** scheduled (`.ai/TASKS` AI2–AI7):
DOM event sidecar (schema ready: click/key/scroll/nav/focus + role/name/bbox; visible text in
ordinary fields, count-only in password/sensitive fields) · voice transcript VTT (ASR is a local
model — PO-gated under the no-AI rule) · repro bundle (console errors + failed requests; needs
the sidecar's vehicle) · marker key during recording · addressable recordings / MCP server ·
PII redaction · dense burst sequences · low-rate pointer trail.
