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
| Yandex Browser (desktop) | — | **NOT RUN — not installed on the dev machine** | ⛔ open | — |
| Yandex Browser (UA only, engine = Chrome 151) | UA 24.10.0.0 / Chromium 128 | 2026-08-23 | PASS *detection only* | [yandex-ua-spoof.json](qa/yandex-ua-spoof.json) |
| Yandex Browser 2021 (UA only, engine = Chrome 151) | UA 21.11 / Chromium 94 | 2026-08-23 | PASS, `belowFloor: true` and correctly NOT blocked | [yandex-old-ua-spoof.json](qa/yandex-old-ua-spoof.json) |
| Firefox (real gecko) | — | **NOT RUN — not installed, and this runner speaks CDP** | ⛔ open | — |
| Firefox 131 (UA only, engine = Chrome 151) | UA 131.0 / Gecko | 2026-08-23 | PASS *detection only* — engine `gecko`, and **Tab Audio correctly dropped** | [firefox-ua.json](qa/firefox-ua.json) |
| Chrome on Windows (UA only) | UA 151 / Win64 | 2026-08-23 | PASS, but see below — the OS did **not** spoof | [chrome-windows-ua.json](qa/chrome-windows-ua.json) |
| Safari / iOS Safari | — | not run — long-standing Robert recheck | — | — |
| Edge, Opera, Brave | — | not installed here; the runner knows their paths | — | — |

### The engine × OS matrix (P1)

What display capture can carry alongside the picture is decided by engine AND
OS, not by engine — `displayAudioScopeFor` in `src/core/capabilities.ts`:

| engine | OS | display audio | what the user sees |
|---|---|---|---|
| chromium | windows | `system` — a monitor share carries the machine's audio | channel named **System Audio** |
| chromium | macOS / Linux | `tab` — only a tab or window share carries audio | channel named **Tab Audio** |
| gecko | any | `none` — Firefox ACCEPTS `audio: true` and returns video only | channel dropped, copy says why |
| webkit | any | `none` — Apple does not offer it at all | channel dropped, copy says why |

Gecko is the case worth spelling out: it does not refuse, it silently succeeds
with no audio track. Offering the channel there would record a silent take and
say nothing, so the channel is dropped and the copy says what Firefox actually
does rather than "not available".

Gecko also has no AAC encoder (`aacEncode: false`), so an export there lands on
the existing avc+opus / vp9+opus chains. That flag is ADVISORY — `codecs.ts`
still probes, because the encoder is a better authority than a table.

### What the spoofed rows do and do not prove

They prove **our** code: that a `YaBrowser` UA is named Yandex and not Chrome,
that the version floor reads Yandex's real Chromium token, and that a
below-floor build is *reported* without being *blocked*. They prove nothing
about Yandex's engine — the engine under those runs was Chrome 151. Only the
real-browser row can close that, and it is deliberately left open above rather
than quietly filled in.

**The Windows row cannot be spoofed at all, and that is correct.** The Chrome
on Windows run above reports `os: macos`, because `navigator.userAgentData`
wins over the UA string (probe-first, UA-sniff last) and CDP's UA override does
not touch it. So the `chromium × windows → System Audio` row is proven by unit
test only, and can be closed for real only by running the checker on Windows.

**To close Firefox:** it needs Playwright's gecko driver — this runner drives
browsers over CDP, which Firefox does not speak. That is a dependency install,
so it is Robert's to run:

```bash
npm i -D playwright && npx playwright install firefox
```

after which the oracle's third-engine run (task P1) can be wired to it. Until
then `--list` reports Firefox as `unsupported` with that reason rather than
pretending it is simply missing.

**To close Yandex:** install Yandex Browser, then

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

## Camera resolution (P9) — `scripts/camera-check.mjs`

A different question from the rest of this file, and it needs its own runner:
O3a claims a **camera-only** take records the camera's true resolution rather
than a 720p source stretched into a 1080p export, and nothing here could check
it. Synthetic mode bypasses `getUserMedia` entirely, the oracle's camera is a
painted canvas, and Robert is right that a resolution is not judged by eye.

```bash
node scripts/camera-check.mjs                 # the real camera, on the deployed build
node scripts/camera-check.mjs --fake-device   # the CONTROL: proves the harness, never P9
```

It drives real Chrome with `--use-fake-ui-for-media-stream` — which auto-grants
the **site** prompt while keeping the **actual device**; the opposite flag would
substitute a test pattern and answer nothing — then reads the answer out of the
files themselves: every raw channel, the composite and the finished export come
straight out of OPFS and through one MP4 box parser. The number that matters is
the raw camera channel's **coded** size, because no downstream scaler can
fabricate it.

Three verdicts, and the third is the point:

| verdict | exit | means |
|---|---|---|
| `PASS` / `FAIL` | 0 / 1 | the camera delivered frames and the gates were answered |
| `CANNOT MEASURE` | 2 | the camera opened, negotiated a resolution, stayed live — and delivered **no frames**. Nothing about the product was measured. |
| `HARNESS-OK (fake device)` | 1 | the synthetic camera ran the whole flow. Proves the runner, never P9. |

`getUserMedia` resolving is not evidence that a camera works. On a MacBook in
clamshell the built-in camera still enumerates, still negotiates 1920×1080@30
and still reports its track `live` while the sensor is off — which is exactly
what this machine did on 2026-08-29 (`docs/qa/camera-1080-2026-08-29.json`),
against 50 frames from the synthetic control through the identical code path.
Run it again with a live camera to finish the row.

## Out of scope

**Aurora OS** — explicitly out. No modern browser engine ships on it, so there
is nothing for this codebase to target. Not a backlog item; a decision.
