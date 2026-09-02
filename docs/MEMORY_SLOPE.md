# Memory at hour scale (H3, measured 2026-09-01, deployed build)
Purpose: whether a long take leaks memory, and what actually ends a long take. Verdict: slope ~0, no leak, nothing here becomes a task; DISK is this machine's take-length ceiling, not RAM. If the numbers move, rewrite them.

## Re-run
- `node scripts/memory-slope.mjs` — 60 minutes by default; `--minutes=90` the longer cell; `--screen=2560x1440` a heavier source; `--sampleMs=` a finer grid (also `--screenfps=`, `--out=`, `--url=`, `--keep`, `--type=`, `--headed` / `--headless`).
- HEAVY: announce it, and do not run it while the machine is in use. Exit code 0 only when the take survived AND both slopes are in band. The curve is printed to the console at the end — a handoff quotes the shape, not a file.
- Headed on purpose: headless Chrome has no GPU here and the raw channels fall back to a different codec.
- Every sample takes three readings: RSS per Chrome process off the OS, grouped by Chrome's own `--type=`; the renderer's JS heap and DOM counters over CDP; and what the take is DOING (delivered fps, bytes written), so a flat curve from a take that quietly died is caught rather than passed. `performance.memory` alone is the smaller half: decoded frames, encoder buffers and GPU-backed VideoFrames live outside the JS heap — R2's GPU-process kill stayed invisible to every in-page counter for three sessions.

## Measured — two soaks, synthetic max60 (1920×1080@60, all four channels), sampled once a minute, stopped properly, graded by the take report card; both held 60 fps end to end
| | 60 min | 90 min |
|---|---|---|
| RSS slope after warm-up | +0.03 MB/min (r² 0.00) | −0.73 MB/min (r² 0.12) |
| RSS, first half → second half | 427 → 417 MB (−10) | 625 → 606 MB (−20) |
| RSS range | 343–520 MB | 535–807 MB |
| JS heap slope | +0.04 MB/min (r² 0.18) | +0.05 MB/min (r² 0.38) |
| JS heap, first half → second half | 9.6 → 10.8 MB | 9.8 → 12.0 MB |
| DOM nodes | 395, constant | 395, constant |
| Chrome processes | 8, constant | 8, constant |
| delivered fps | 58.2–60.1 | 59.2–60.1 |
| written to disk | 4.1 GB | 5.9 GB |
| report card | RED — one rate-ladder step | GREEN, 10 of 10 |

## Bands and the real ceiling
- Band: RSS < 5 MB/min and JS heap < 1 MB/min, after a 5-minute warm-up. Both cells inside it.
- The take writes ~66 MB/min, so free disk runs out first — about 8.8 hours at 35 GB free. B5's guard is what will end a long take; the report card's `storage` dimension already watches it, nothing here does.

## Gotchas — how to read a slope
- Read the slope from the HALVES (mean of the first half vs the second), not from a least-squares line: RSS oscillates ±90 MB while macOS reclaims. The 60-min cell reads +0.03 MB/min over the whole hour (r² 0.000) but +3.45 MB/min over its second half alone (r² 0.30) — the oscillation aliased by a 28-point window, not a leak starting; the halves say −10 MB. The rig reports both; trust the halves.
- Per-process split: the renderer's own line reads +0.60 MB/min in the 60-min cell and +0.10 in the 90-min one — a trend that gets SMALLER as the lever arm gets longer is noise. By halves it is +5 MB and +9 MB, over 30 and 45 minutes of recording.
- The two cells sit on different plateaus (343–520 MB vs 535–807 MB): run-to-run machine state, not drift. Read the SHAPE of each run; never compare absolute levels across runs.
