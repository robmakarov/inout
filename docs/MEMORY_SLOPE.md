# Memory at hour scale, and what actually ends a long take

Task H3, measured 2026-09-01 on the deployed build. This file holds CURRENT truth:
if the numbers move, rewrite them, do not append a note.

## The curve is flat, and memory is not the ceiling

Two soaks, one 60 minutes and one 90, synthetic max60 takes (1920×1080@60, all four
channels), sampled once a minute, stopped properly, graded by the product's own report
card. Both held 60 fps end to end.

| | 60 min | 90 min |
|---|---|---|
| RSS slope after warm-up | +0.03 MB/min (r² 0.00) | −0.73 MB/min (r² 0.12) |
| RSS, first half → second half | 427 → 417 MB (**−10**) | 625 → 606 MB (**−20**) |
| RSS range | 343–520 MB | 535–807 MB |
| JS heap slope | +0.04 MB/min (r² 0.18) | +0.05 MB/min (r² 0.38) |
| JS heap, first half → second half | 9.6 → 10.8 MB | 9.8 → 12.0 MB |
| DOM nodes | 395, constant | 395, constant |
| Chrome processes | 8, constant | 8, constant |
| delivered fps | 58.2–60.1 | 59.2–60.1 |
| written to disk | 4.1 GB | 5.9 GB |
| report card | RED — one rate-ladder step | **GREEN, 10 of 10** |

**Slope ~0. The band held (RSS < 5 MB/min, heap < 1 MB/min after a 5-minute warm-up),
and no leak was found** — so nothing here becomes its own task.

The premise the task was written on does not survive the measurement: memory is **not**
this machine's take-length ceiling. **Disk is.** The take writes ~66 MB/min, so free
space is what runs out — about 8.8 hours at 35 GB free — and B5's guard is the thing
that will end a long take, not RAM. The take report card's storage dimension is already
watching that; nothing here is.

## Read the slope from the halves, not from the line

RSS oscillates by ±90 MB while macOS reclaims, and a least-squares line over a short
window will happily manufacture a trend out of it: the 60-minute cell reads +0.03 MB/min
over the whole hour (r² 0.000) and **+3.45 MB/min over its second half alone** (r² 0.30).
The second number is not a leak starting — it is the oscillation aliased by a 28-point
window, and comparing the MEAN of the two halves says so plainly (−10 MB). The rig
reports both, and the halves are the statistic to trust.

Same caution for the per-process split. The renderer's own line reads +0.60 MB/min in
the 60-minute cell and +0.10 in the 90-minute one — a trend that gets *smaller* as the
lever arm gets longer is noise, not a leak. By halves it is +5 MB and +9 MB, over 30 and
45 minutes of recording.

The two cells sit on different plateaus (343–520 MB against 535–807 MB). That is
run-to-run machine state, not drift, and it is why the verdict is read from the shape of
each run rather than from comparing their absolute levels.

## Why RSS and not `performance.memory`

The JS heap is the smaller half of the story and the less interesting one: decoded
frames, encoder buffers and GPU-backed VideoFrames live outside it, which is exactly how
R2's GPU-process kill stayed invisible to every in-page counter for three sessions. So
every sample takes three readings — RSS per Chrome process off the OS grouped by Chrome's
own `--type=`, the renderer's JS heap and DOM counters over CDP, and what the take is
*doing* (delivered fps, bytes written) so a flat curve produced by a take that quietly
died is caught rather than reported as a pass.

## Re-run it

```bash
node scripts/memory-slope.mjs
```

60 minutes by default; `--minutes=90` for the longer cell, `--screen=2560x1440` for a
heavier source, `--sampleMs=` for a finer grid. HEAVY: announce it, and do not run it
while the machine is in use. Exit code is 0 only when the take survived and both slopes
are in band. The curve is printed on the console at the end, so a handoff can quote a
shape and not a file.

Headed on purpose, for the reason in docs/CRASH_BOUND.md: headless Chrome has no GPU
here and the raw channels fall back to a different codec.
