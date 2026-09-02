# AI export — the "For AI" PDF (V1 SHIPPED 2026-08-24)
Purpose: the export panel's "For AI" control writes `<take>-for-ai.pdf` — one PDF of text + JPEG keyframes, no video track — for agents that sample frames (~1 token per 750 px: 1024×576 ≈ 800 tokens, a 1080p frame ≈ 2 800). Everything beyond the file is roadmap, reconsidered only after Robert tests the first real file (`.ai/TASKS` phase A).

## Evidence / switches
- `node scripts/ai-pdf-check.mjs` — the rig; a sample it built is committed at `docs/qa/ai-export.pdf`.
- `POINTER_TRAIL_ENABLED` in `src/core/ai/build.ts` — the pointer trail is ON (detector proven on a take with a known cursor path: 100 % of confident readings within 5 % of the frame, median error 0.007).

## The file
- Page 1 = the index, pure selectable text, ≤~200 tokens: what the document is (the pages after it are frames of one recording in time order, spacing uneven, what to do if it arrived with no instructions), duration, resolution, clock note, event lines (channel on/off segments, stalls), keyframe list (one line per keyframe: timestamp + page number). The same one-liner is in the PDF metadata and every page caption.
- One keyframe per page: ≤1024 px full view, JPEG (PDF-native DCTDecode only), page size = image size (no padding; ~800 tokens at 1024×576). Changed region <~25 % of the frame → the same page also carries a full-res crop of it.
- Caption = a 22 pt text band ABOVE the picture (~30 tokens). Never draw it on the image: that covered the top ~20 px = tab strip and menu bar.
- No video track anywhere in the file; the MP4 stays a separate, unrelated export.

## Numbers (calibrated on Robert's 97 s real-UI take)
- Frame budget: 2.5 frames per second of take length, floor 96, ceiling 300 (≈236k tokens ≈ 11 MB); hard stop 28 MB (a pathological take degrades by stopping, never by being rejected).
- Analysis at 8 looks per second (was 4). Content threshold 0.12 % of the grid (~17 cells) with the pointer masked out of the metric (was 0.25 % / ~36 cells, set high to hide the cursor).
- Motion suspends the pace: while the picture keeps moving between looks every look is a page, capped at 1.2 s (after that a scroll is throttled, a transition is already captured).
- Pace floor = `duration / 60`, clamped 0.5–15 s; pace is derived from what is LEFT of the take and the budget, plus a burst credit that shrinks to zero by the end (the first controller spent the take out at 84 s of 97). Nothing is lost to the pace: the reference frame advances only when a page is emitted, so a held change fires at the next allowed instant.
- Result on that take: 39 → 165 frames (of 243 allowed), worst gap 5.5 s → 2.9 s, median gap 2.5 s → 0.4 s, covered to 97.1 s, 167 pages, ~144k tokens, 6.5 MB, built in 5.4 s.
- Reader limits (checked 2026-08-24): Claude 600 pages / 32 MB on 1M-context models (the 100-page figure applies only to 200k-context models); Gemini 1000 pages / 50 MB, flat 258 tokens per page. Tokens (~800 per full-view page) are the binding cost, not the format.

## Rules (decisions, not defaults)
- No knobs: every parameter is derived from a signal already in the recording or layered inside the file so the agent's reading order decides (index first; an agent that can page — Claude Code `pages` — descends selectively). Always capture max; derive everything down at export.
- Cursor taxonomy, one diff classified by size and persistence: tiny + moving + transient = cursor → never a keyframe, logged as a low-rate pointer trail in the index text · tiny + stationary + blinking = caret → ignored · small but persistent over several samples = real content (tooltip, menu, hover) → keyframe with a crop pointed at it · large = content change / motion burst → keyframe. A change landing where the cursor last rested is captioned "change at cursor".
- The file follows the edit: cuts, speed, zoom are remapped through the same output→recording mapping the render uses; cut content must not appear.
- Clock: every timestamp sits on the recording epoch. If the composite's t=0 differs (its first packet sits 133–300 ms in — P0-instant-sync) the index declares `clockOffsetMs`. Never assume composite time is recording time.
- No generated prose (standing no-AI ruling): index content is signal-derived (durations, counts, timestamps). The document explaining its own FORMAT is allowed and required.
- Keyframe selection is pure and unit-tested: delta metric = share of changed pixels on a downscaled luma diff ("dense during motion, near zero when static").
- Zero dependencies: our own minimal PDF writer (JPEG images + built-in Helvetica text).

## Known limits (measured)
- Page 1's picture is capture pre-roll — older than its timestamp (577 ms on the rig take): a canvas `captureStream`'s first encoded frame holds what was painted before the recorder existed; every export path inherits it. Every other page's caption is within 9 ms of its picture.
- The build runs on the main thread, using the decoder's own awaits as yields; costs half a full render; deliberately not moved into the export worker.
- DOM events: a web page sees them only in its own tab; no API exposes a captured surface's input. V1 ships without DOM events and the index says so. The vehicle is Robert's decision (AI2): (a) companion extension — other tabs, not native apps · (b) SDK snippet in the recorded page · (c) desktop shell (P4) — global cursor/clicks, richest, latest.

## Roadmap candidates — NOT scheduled (`.ai/TASKS` AI2–AI7); named so they are not reinvented
DOM event sidecar (schema ready: click/key/scroll/nav/focus + role/name/bbox; visible text in ordinary fields, count-only in password/sensitive fields) · voice transcript VTT (ASR is a local model — Robert-gated under the no-AI rule) · repro bundle (console errors + failed requests; needs the sidecar's vehicle) · marker key during recording · addressable recordings / MCP server · PII redaction · dense burst sequences · low-rate pointer trail.
