# AI export — spec

Status: **V1 SHIPPED 2026-08-24** — the export panel has a "For AI" control and it produces the
file described below. Everything beyond the file is a roadmap candidate, reconsidered only
**after PO tests the first real file** (`.ai/TASKS` phase A). Evidence:
`node scripts/ai-pdf-check.mjs`; a sample the rig built is committed at `docs/qa/ai-export.pdf`.

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
| cursor filter | the delta's own size + persistence — see the taxonomy below |
| short vs complete file | page order — index first, an agent that can page (Claude Code `pages`) descends selectively |
| record quality | none — always capture max, derive everything down at export |

**The cursor problem, and the taxonomy that solves it.** The OS cursor is baked into the captured
pixels and moves every frame — a naive delta metric would keyframe constantly on it. One diff,
classified by size and persistence, separates noise from signal:

- tiny + moving + transient → **the cursor**: never a keyframe · logged as a low-rate pointer
  trail in the index text (a few tokens per line) — v1's only interaction signal, since DOM
  events wait on AI2
- tiny + stationary + blinking → **a text caret**: ignored
- small but persistent (survives several samples) → **real content** (tooltip, menu, hover
  highlight): keyframe, crop pointed at it
- large → **content change / motion burst**: keyframes as normal

When a content change lands where the cursor last rested, the keyframe caption says "change at
cursor" — click inference with zero new capture surface. Honest limit: reading a cursor out of
pixels is a heuristic, so the pointer trail ships only if the rig proves the detector reliable;
the filtering ships unconditionally (it is a threshold, not a detector).

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

## What shipping it changed in this spec

Three things the build settled, each with the measurement that settled it:

- **The caption is a 22 pt band ABOVE the picture, not text on it.** Drawn on the image it cost no
  page area — and covered the top ~20 px of the frame, which on a screen recording is the tab strip
  and the menu bar. Twenty points of page (~30 tokens) is the cheaper mistake. "No pixel is padding"
  still holds: the band is the timestamp, legible in the raster as well as extractable as text.
- **The pointer trail ships.** The rule was to drop it unless the rig proved the detector; on a take
  whose cursor path is known to the millisecond, 100 % of confident readings land within 5 % of the
  frame (median error 0.007). `POINTER_TRAIL_ENABLED` in `src/core/ai/build.ts` is the switch.
- **Pacing is derived from the take's own length** — a page floor of `duration / 60`, clamped to
  0.5–15 s — because "dense during motion" on a twenty-minute recording is a bankrupt token budget.
  It is not a rate limit that loses anything: the reference frame only advances when a page is
  emitted, so a change held back fires at the next instant the pace allows.

Two honest limits, both measured rather than assumed:

- **The take's first page is capture pre-roll.** A canvas `captureStream`'s first encoded frame holds
  whatever was painted before the recorder existed, so its picture is older than its timestamp (577 ms
  on the rig take). Confirmed identical on the channel itself — every export path inherits it, this
  one merely shows it. Every other page's caption is within 9 ms of its own picture.
- **The build runs on the main thread**, using the decoder's own awaits as its yields. It costs half a
  full render, so this is not a throughput decision — the export worker's fallback protocol is shaped
  for the certified render and a new path did not justify generalizing it.

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
