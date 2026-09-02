# Crash bound — what a `kill -9` costs a running take (H2 / H2b / H6, deployed build)
Purpose: the measured loss when Chrome dies mid-take, the floors in a take's first seconds, the one residual, and how to re-measure. If the numbers move, rewrite the tables.

## Re-measure
- `node scripts/crash-bound.mjs --control=300000 --killAt=60000,300000,720000,1200000,1860000` — the five-point matrix plus a properly-stopped control take.
- `node scripts/crash-bound.mjs --killAt=60000 --export` · `--screen=2560x1440` · `--keep-profile` · `--settleBeforeRecordMs=0` reproduces the cold first-take cell · also `--url=`, `--out=`, `--screenfps=`, `--settleMs=`.
- Rig: `kill -9` on Chrome's whole process group, prod build, synthetic 1920×1080@60 source, all four channels armed; the take is verified still recording at the kill instant (11–371 liveness polls per cell), so every row prices a crash, not a take that had already stopped.

## The bound: at most ~2.1 s lost anywhere in a running max60 take, independent of length
| killed at | screen | camera | tab audio | mic | worst |
|---|---|---|---|---|---|
| 60 s | 0.90 s | 0.67 s | 1.01 s | 1.01 s | 1.01 s |
| 5 min | 2.12 s | 0.97 s | 1.17 s | 1.17 s | 2.12 s |
| 12 min | 1.95 s | 0.76 s | 1.08 s | 1.08 s | 1.95 s |
| 20 min | 1.47 s | 0.48 s | 0.97 s | 0.97 s | 1.47 s |
| 31 min | 1.79 s | 1.77 s | 1.44 s | 1.49 s | 1.79 s |
N = 2.1 s, a property of the write cadence, not of length. Every channel comes back, the take is complete to that point and exports. Reference (a take stopped properly, same machine): channels end 0.22–0.24 s behind the stop click — a crash adds ~1–2 s on top of that.

## The floor: the first seconds of a take (H2b, 2026-09-02, `?crashfloor=1` = default)
- Kills at 2.3 / 3.3 / 4.3 / 5.3 / 7.3 / 8.3 / 10.3 / 20.3 s: manifest on disk (IndexedDB) every time, EVERYTHING came back, video 2.03 / 2.00 / 4.05 / 4.02 / 6.03 / 8.07 / 10.13 / 20.07 s. Worst channel trail 2.14 s — the bound now holds from the second second of a take instead of the eighth.
- Before (`?crashfloor=0`, still one URL away): kills at 2.8 / 3.3 / 4.2 s → no manifest, NOTHING recovered (the whole take); 5.4 s → localStorage manifest, audio only (no video fragment had closed); 7.5 s → everything, 0.44 s behind.
- Fix 1: the pending manifest also goes to its own IndexedDB database with `durability: 'strict'` (`recovery.ts`) — Chrome commits localStorage asynchronously, so a `kill -9` inside that window took the only pointer to the blobs. In the eight cells the IndexedDB copy survived every kill, the localStorage copy none.
- Fix 2: one extra keyframe closes the first fragment at 1 s (`EARLY_FRAGMENT_S`). Audio already rides ~1 s WebM clusters; an fMP4 fragment needs its minimum duration AND the next keyframe against a 2 s GOP. It is ADDED to the GOP grid (fragments close at 1, 2, 4, 6 s, where they closed at 2, 4, 6), never inserted into it — moving the grid measured WORSE at a 5 s kill (3.0–3.7 s of picture vs the shipped 4.0 s).

## The first take after a Chrome LAUNCH (H6, 2026-09-02) — the one residual
- A Chrome PROCESS's first `VideoEncoder` costs ~3.2 s (Chrome's GPU process starting, 3.1–3.3 s whatever is asked), and until it is paid nothing encoded exists to salvage. Measured on prod: 1920×1080 `isConfigSupported` 67 ms + init/5 frames/flush 3122 ms · 640×360 71 ms / 3276 ms · 320×240 147 ms / 3281 ms · SECOND encoder in the same process 0 ms / 47–77 ms · the warm's own chunks 585→708 ms cold cache, 288→372 ms warm. Not a size cost, not the app's chunks.
- The warm finished 4.2 s after page start with nobody recording; record pressed at once → 5.0–8.6 s (the take's three encoders fighting the warm's two). H6: the warm's init encoder closes the instant its flush resolves; its 40-frame measurement stands down when a take commits — deferred, `doStop` runs it when the take ends.
- Worth, same rig, `--settleBeforeRecordMs=0`: kill at 2 s / 3 s → no picture (before and after); 4 s → 3.00 s of picture (before: none); 5 s → 4.53 s (before: none); 7 s → everything, both.
- Any page load after the first in the same Chrome: the whole warm (chunks, init, measurement) finishes 577–618 ms after page start. Verified: running Chrome, fresh load, record at once, killed at 2 s → two of three video files hold a closed fragment with 1.0 s of picture, same as a settled app. Residual = the first page INOUT is asked for after a browser launch, where a crash inside ~4 s still loses the picture.

## Gotchas
- NEVER judge a live take's file by `getFile().size`: a blob a worker writes through a `SyncAccessHandle` reads 28 bytes (just the `ftyp`) for the whole take, from inside the page and from `ls` alike, while megabytes are on disk (cost an hour on 2026-09-02). The only honest reading is after the process is gone: kill it, then read the files — from OPFS in a fresh page, or straight out of `<profile>/Default/File System/` with no browser (what `crash-bound.mjs`'s manifest read does).
- 2560×1440@60 synthetic is over this machine's line: three of five takes were dead or dying before the kill (screen delivery 44 → 26 → 10 → 0.2 fps, both audio channels ending tens of seconds early). That is take collapse, not crash loss, and is never reported as loss; the rig's own painter (a canvas the page paints at 2560×1440 sixty times a second, which a real screen share does not cost) is part of the reason. 1920×1080@60 holds 60.0 fps for five minutes and grades GREEN — the bound is measured there. The one finding from the heavy cells is in BACKLOG.
