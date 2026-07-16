# A/V sync defect — diagnosis (2026-07-14)

Status: **root cause falsification-proven (capture-side)**; candidate patch on `fix/av-sync` **does not yet meet acceptance gates** (TD review required).

Sign convention (oracle): **positive offset = audio late / video early** (`SyncStats.leads`).

---

## 1. TD baseline (MEASURED — do not re-derive)

From `src/experimental/TD-VERDICT.md` (Chromium, 2026-07-14):

| Metric | Value | Gate |
|---|---:|---|
| Sync mean (full export) | **170.7 ms** | 80 ms |
| Sync mean (trimmed @ 1500 ms) | **173.4 ms** | 80 ms |
| Sync maxAbs | (pass) | 120 ms |
| Drift | 1.46 ms/s | pass |
| Trim accuracy @ 1500 ms | 3.1 ms | pass |
| Readability | 100 % | pass |
| Session-log onstart skew | screen **76 ms**, mic **0 ms**, camera **9 ms**, sys **1 ms** | — |

Systematic positive offset ⇒ **audio late / video early** in export.

---

## 2. Oracle hardening (Step 0 — committed `exp/research` @ 0db8c11)

| Change | Purpose |
|---|---|
| Trim param **1483 ms** (non-frame-aligned) | Trim gate independent of frame grid |
| `fitClock` MAD outlier rejection | Robust barcode clock |
| `maxAbsOffsetMs` gated alongside `\|mean\|` | Catch single-frame spikes |
| Sign/`leads` in report output | Explicit audio-late vs video-late |
| `beepTrueRigMs` grid correction | Remove AudioContext startup stall from beep grid |
| Flash+click cross-check | Barcode-free falsification (step 3d) |
| try/finally + `sweepStaleOracleBlobs()` | TD hygiene |

**Instrument caveat (MEASURED this session):** grid-corrected barcode sync can read **≈ −24 ms** while flash+click on the **same export** reads **≈ +172 ms**. For production defect sizing, **flash+click is the honest metric**; barcode+grid is useful for drift/trim but can hide capture skew.

---

## 3. Step 1 — characterization matrix

### Before patch (MEASURED — TD + unfixed rig)

| Cell | sync mean | sync maxAbs | drift ms/s | trim err ms |
|---|---:|---:|---:|---:|
| TD full export (screen+mic, ~6 s) | **170.7** | pass | 1.46 | — |
| TD trimmed @ 1500 ms | **173.4** | pass | 1.46 | **3.1** |
| Localize flash+click (6 s, unfixed) | — | — | — | — |

Localize unfixed (this machine, 2026-07-14): flash+click **172 ms** MEASURED; grid-corrected barcode **−24 ms** MEASURED.

### After patch (`fix/av-sync`, MEASURED 2026-07-14)

| mix | duration | n | sync mean (run1 / run2) | sync maxAbs worst | trim worst |
|---|---|---:|---|---:|---:|
| screen+mic | 6 s | 2 | **−18 / +163 ms** | 168 ms | 17 ms |
| screen+mic | 30 s | 2 | **+172 / +194 ms** | 195 ms | 12 ms |

High **variance** on 6 s runs; 30 s runs still **≈ TD baseline (~171–194 ms)** on grid-corrected barcode. **Acceptance gates (|mean| ≤ 30 ms, maxAbs ≤ 50 ms) not met.**

---

## 4. Step 2 — localization (capture vs compose)

Method: decode **raw** per-channel webm; recover rig time of file `t=0` from barcodes/beeps; compare to `recorder.onstart` bookkeeping; export through **untouched** production compose.

### Representative unfixed run (MEASURED)

| Channel | fileEpoch rig ms | onstart rig ms | firstMediaLag ms | lagVsStartCall ms |
|---|---:|---:|---:|---:|
| screen (video) | 281.5 | 414.5 | **−133.0** | **−4.3** |
| mic (audio) | 369.6 | 441.8 | **−72.2** | **+82.2** |

- **fileEpoch delta (audio − video): 88.1 ms** MEASURED  
- **onstart delta (after epoch): 27 ms** MEASURED (metadata under-reports true 88 ms skew)  
- Export flash+click: **+172 ms** MEASURED (audio late)  
- Export grid-corrected barcode: **−24 ms** MEASURED  
- **composeResidual: +36.5 ms** MEASURED (hypothesis c bounded; cannot explain full 172 ms)

**Decision: CAPTURE-SIDE.** Raw per-channel files are **not** aligned at `t=0` (88 ms content delta); export error tracks that mismatch. Compose adds ≤ ~37 ms on top (MEASURED), not the primary term.

Video **lagVsStartCall ≈ 0** MEASURED ⇒ first-frame content aligns with **`recorder.start()`**, not **`onstart`** (which trails by ~videoLead ≈ 129 ms in this run).

---

## 5. Step 3 — hypothesis falsification

| Id | Statement | Outcome |
|---|---|---|
| **(a) first-media vs onstart** | Video `onstart` fires late; first frame content does not; min-normalization bakes skew | **Supported.** MEASURED firstMediaLag asymmetry (−133 vs −72 ms); video lagVsStartCall ≈ 0; TD onstart skew 76/0 ms. **Would be disproven** if raw files were aligned at `t=0` — they are not. |
| **(b) opus pre-skip** | Audio container timestamps shifted by priming | **Rejected as primary.** Bounded by \|firstMediaLag(audio)\| ≈ 72 ms MEASURED ≪ 172 ms defect. |
| **(c) compose audio windowing** | Compose misplaces audio vs capture metadata | **Rejected as primary.** \|composeResidual\| ≈ 37 ms MEASURED. |
| **(d) rig artifact** | Barcode/beep instrument wrong | **Partially falsified.** Flash+click (barcode-free) **agrees with TD (~172 ms)**; disagrees with grid-corrected barcode — **instrument issue is grid correction hiding skew, not flash path.** |
| **(c2) AAC mux delay** | MP4 AAC adds audible delay | **Secondary.** codecbias MEASURED **+44 ms** (both mediabunny and `decodeAudioData`); explains ~25 % of residual, not all. |

---

## 6. Root cause (falsification-proven)

**Production `startOffsetMs` is derived from `recorder.onstart`, but first media in the container does not start there.**

- **Video:** `captureStream()` is live during preview; first encoded frame content aligns with **`recorder.start()`** (MEASURED lagVsStartCall ≈ 0), while **`onstart` trails by videoLead** (MEASURED 76–164 ms depending on run).  
- **Audio:** file `t=0` lags **`recorder.start()`** by **~80–91 ms** MEASURED (lagVsStartCallAudio), independent of small onstart skew between channels.  
- Min-normalization preserves **relative** error; compose faithfully maps the wrong metadata ⇒ **systematic audio-late export (~171 ms)** MEASURED (TD + flash+click).

**Not root cause:** compose chunk windowing (≤ ~37 ms MEASURED residual), opus pre-skip alone (≤ ~72 ms), oracle instrument (flash confirms TD).

---

## 7. Candidate patch (`fix/av-sync`)

Production changes (**minimal**):

- `src/core/capture/probe.ts` — demux first/last packet timestamps at stop  
- `src/core/capture/session.ts` — at `doStop()`, derive offsets from measured capture facts:
  - **Video:** `startOffsetMs = startCallAbs − epoch`  
  - **Audio:** `startOffsetMs = startCallVideo − epoch + lagVsStartCallAudio`  
    - When onstart skew is large: `(onstartA − startCallA) − videoLead + 2·(onstartA − onstartV)`  
    - When skew collapses: **MEASURED** fallback 90 ms stream lag (oracle N=2 — **needs more samples**)

Experimental rig mirrors the same logic (`src/experimental/oracle/rig.ts`).

**Contract:** no change to `src/core/types.ts` time model.

### Before / after (MEASURED)

| Metric | Before (TD / unfixed flash) | After patch (this session) |
|---|---:|---:|
| Flash+click 6 s | **172 ms** | 165–245 ms (run-dependent; **not stable**) |
| Grid-corrected sync 6 s | −24 ms | −18 to +163 ms (high variance) |
| 30 s sync mean | **171 ms** (TD) | **172–194 ms** (still failing) |

**Acceptance: FAIL** (|mean| ≤ 30 ms, maxAbs ≤ 50 ms across matrix). Patch direction validated by localization algebra but **audio stream-lag estimation still incomplete** — likely needs **demux-derived file epoch for audio at stopFinish** without magic constants.

---

## 8. Recommended next steps (TD)

1. Replace 90 ms fallback with **probe-derived audio file epoch** at `stopFinish` (post-`onstop`), using packet-accurate `lastEndTsMs`; cross-check against video `startCall` anchor.  
2. Re-run full matrix (4 mixes × 6 s/30 s × N=5) on hardened oracle; gate on **flash+click**, not grid-corrected barcode alone.  
3. Land production fix only after matrix passes acceptance.  
4. Secondary: investigate AAC +44 ms mux delay (separate compose ticket).

---

## 9. Verification commands

```bash
npm run typecheck && npm test
# Oracle (headless Chromium, dev server on 5199):
node src/experimental/tools/cdp-run.mjs localize '{"recordMs":6000}'
node src/experimental/tools/cdp-run.mjs matrix '{"mixes":["screen+mic"],"durations":[6000,30000],"n":2}'
```

No changes to `scene/`, `streamx/`, `wcap/`, `datachan/`, `semantic/`. **Do not merge to main** without TD sign-off.
