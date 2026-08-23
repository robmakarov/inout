# QA matrix — which browsers we have actually driven through the product

CURRENT TRUTH ONLY. A row is worth nothing without the run behind it: every
claim here is produced by `scripts/browser-check.mjs`, which loads the
PRODUCTION build, records a synthetic take, stops, opens the editor, exports,
and reads the result line the user reads. Evidence lands in `docs/qa/*.json`.

```bash
node scripts/browser-check.mjs --list
```

```bash
node scripts/browser-check.mjs --browser=yandex --out=docs/qa/yandex.json
```

## The eight gates each run checks

| gate | means |
|---|---|
| `boots` | first paint reaches the capture screen |
| `identifiedBrowser` | the app names the browser correctly (Yandex ≠ Chrome) |
| `supported` | every required API probes present |
| `recorded` | a take starts and stops |
| `reachedEditor` | the take lands in the editor with its channels |
| `exported` | an MP4 is produced and the result line appears |
| `exportNonEmpty` | the file is not 0 B |
| `noConsoleErrors` | nothing threw along the way |

## Rows

| browser | version | run | verdict | evidence |
|---|---|---|---|---|
| Chrome (macOS 26) | 151.0.7922.170 | 2026-08-23 | **PASS** — 4 channels, export 1.6 MB 1920×1080 in 508 ms | [chrome.json](qa/chrome.json) |
| Yandex Browser (desktop) | — | **NOT RUN — not installed on the TD machine** | ⛔ open | — |
| Yandex Browser (UA only, engine = Chrome 151) | UA 24.10.0.0 / Chromium 128 | 2026-08-23 | PASS *detection only* | [yandex-ua-spoof.json](qa/yandex-ua-spoof.json) |
| Yandex Browser 2021 (UA only, engine = Chrome 151) | UA 21.11 / Chromium 94 | 2026-08-23 | PASS, `belowFloor: true` and correctly NOT blocked | [yandex-old-ua-spoof.json](qa/yandex-old-ua-spoof.json) |
| Firefox | — | not run — task **P1** owns it | — | — |
| Safari / iOS Safari | — | not run — long-standing PO recheck | — | — |
| Edge, Opera, Brave | — | not installed here; the runner knows their paths | — | — |

### What the spoofed rows do and do not prove

They prove **our** code: that a `YaBrowser` UA is named Yandex and not Chrome,
that the version floor reads Yandex's real Chromium token, and that a
below-floor build is *reported* without being *blocked*. They prove nothing
about Yandex's engine — the engine under those runs was Chrome 151. Only the
real-browser row can close that, and it is deliberately left open above rather
than quietly filled in.

**To close it:** install Yandex Browser, then

```bash
node scripts/browser-check.mjs --browser=yandex --out=docs/qa/yandex.json
```

The runner finds it at `/Applications/Yandex.app/…` (and the older
`Yandex Browser.app` spelling), drives the whole flow, and writes the row's
evidence. Paste the `binaryVersion` and `verdict` into the table.

## Version floor

`src/core/platform.ts` — **Chromium 107**, which is the syntax baseline this
bundle is compiled to (Vite 7's default `baseline-widely-available`:
chrome107 / edge107 / firefox104 / safari16). Every runtime API we need landed
earlier (WebCodecs 94, OPFS sync access handles 102), so the syntax target is
the binding constraint. Raise `CHROMIUM_FLOOR` only together with
`vite build.target`.

The floor is a **report, never a gate**. Feature probes decide support; the
version only supplies the wording once a probe has already failed — proven by
the `yandex-old` row above, which is below the floor and still runs.

One thing the floor must cover rather than probe: `FileSystemSyncAccessHandle`
is `[Exposed=DedicatedWorker]`, so it is invisible from the main thread even on
a browser that fully supports it. Probing it there declared Chrome 151
unsupported; `browser-check.mjs` caught that before it shipped, and
`platform.test.ts` now guards against re-adding it.

## Out of scope

**Aurora OS** — explicitly out. No modern browser engine ships on it, so there
is nothing for this codebase to target. Not a backlog item; a decision.
