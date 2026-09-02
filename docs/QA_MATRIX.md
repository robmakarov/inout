# QA matrix — browsers actually driven through the product
Purpose: which browsers have been run end to end (PRODUCTION build → synthetic take → stop → editor → export → the result line the user reads). A row is worth nothing without the run behind it; evidence lands in `docs/qa/*.json`. Out of scope by decision, not backlog: Aurora OS (no modern browser engine ships on it).
## Commands
- `node scripts/browser-check.mjs --list` — the browsers the runner knows (Edge, Opera, Brave paths included; Firefox reported `unsupported` with the reason, not "missing").
- `node scripts/browser-check.mjs --browser=yandex --out=docs/qa/yandex.json` — closes the Yandex row once Yandex Browser is installed (runner finds `/Applications/Yandex.app/…` and the older `Yandex Browser.app`); paste `binaryVersion` and `verdict` into the table.
- `npm i -D playwright && npx playwright install firefox` — Robert's to run (a dependency install); the runner drives browsers over CDP, which Firefox does not speak. Then wire the oracle's third-engine run (task P1) to it.
- `node scripts/camera-check.mjs` — P9, the real camera on the deployed build · `node scripts/camera-check.mjs --fake-device` — the CONTROL: proves the harness, never P9.

## The eight gates each run checks
`boots` (first paint reaches the capture screen) · `identifiedBrowser` (the app names the browser correctly, Yandex ≠ Chrome) · `supported` (every required API probes present) · `recorded` (a take starts and stops) · `reachedEditor` (the take lands in the editor with its channels) · `exported` (an MP4 is produced and the result line appears) · `exportNonEmpty` (not 0 B) · `noConsoleErrors` (nothing threw).

## Rows
| browser | version | run | verdict | evidence |
|---|---|---|---|---|
| Chrome (macOS 26) | 151.0.7922.170 | 2026-08-23 | PASS — 4 channels, export 1.6 MB 1920×1080 in 508 ms | `qa/chrome.json` |
| Yandex Browser (desktop) | — | NOT RUN — not installed on the dev machine | open | — |
| Yandex Browser (UA only, engine = Chrome 151) | UA 24.10.0.0 / Chromium 128 | 2026-08-23 | PASS, detection only | `qa/yandex-ua-spoof.json` |
| Yandex Browser 2021 (UA only, engine = Chrome 151) | UA 21.11 / Chromium 94 | 2026-08-23 | PASS, `belowFloor: true` and correctly NOT blocked | `qa/yandex-old-ua-spoof.json` |
| Firefox (real gecko) | — | NOT RUN — not installed, and the runner speaks CDP | open | — |
| Firefox 131 (UA only, engine = Chrome 151) | UA 131.0 / Gecko | 2026-08-23 | PASS, detection only — engine `gecko`, Tab Audio correctly dropped | `qa/firefox-ua.json` |
| Chrome on Windows (UA only) | UA 151 / Win64 | 2026-08-23 | PASS, but the OS did NOT spoof (reports `os: macos`) | `qa/chrome-windows-ua.json` |
| Safari / iOS Safari | — | not run — long-standing Robert recheck | — | — |
| Edge, Opera, Brave | — | not installed here; the runner knows their paths | — | — |
- The spoofed rows prove OUR code only: a `YaBrowser` UA is named Yandex, the version floor reads Yandex's real Chromium token, a below-floor build is REPORTED without being BLOCKED. They prove nothing about Yandex's engine (it was Chrome 151); only the real-browser row closes it, deliberately left open.
- The Windows row cannot be spoofed, correctly: `navigator.userAgentData` wins over the UA string (probe-first, UA-sniff last) and CDP's UA override does not touch it. `chromium × windows → System Audio` is proven by unit test only; close it only by running the checker on Windows.

## Engine × OS (P1) — `displayAudioScopeFor` in `src/core/capabilities.ts`
| engine | OS | display audio | what the user sees |
|---|---|---|---|
| chromium | windows | `system` — a monitor share carries the machine's audio | channel named **System Audio** |
| chromium | macOS / Linux | `tab` — only a tab or window share carries audio | channel named **Tab Audio** |
| gecko | any | `none` — Firefox ACCEPTS `audio: true` and silently returns video only | channel dropped; copy says what Firefox actually does, not "not available" |
| webkit | any | `none` — Apple does not offer it | channel dropped, copy says why |
- Gecko has no AAC encoder (`aacEncode: false`) → an export there lands on the existing avc+opus / vp9+opus chains. That flag is ADVISORY — `codecs.ts` still probes; the encoder outranks a table.

## Version floor — `src/core/platform.ts`
- `CHROMIUM_FLOOR` = Chromium 107 = the syntax baseline this bundle is compiled to (Vite 7 `baseline-widely-available`: chrome107 / edge107 / firefox104 / safari16). Every runtime API landed earlier (WebCodecs 94, OPFS sync access handles 102). Raise it ONLY together with `vite build.target`.
- The floor is a REPORT, never a gate: feature probes decide support; the version only supplies the wording once a probe has failed (the `yandex-old` row is below the floor and still runs).
- Never probe `FileSystemSyncAccessHandle` from the main thread: it is `[Exposed=DedicatedWorker]`, invisible there even on a browser that fully supports it (it declared Chrome 151 unsupported once; `browser-check.mjs` caught it, `platform.test.ts` guards against re-adding it).

## Camera resolution (P9) — `scripts/camera-check.mjs`
- Question: a camera-only take records the camera's TRUE resolution (O3a), not a 720p source stretched into a 1080p export. Synthetic mode bypasses `getUserMedia`, the oracle's camera is a painted canvas, and a resolution is not judged by eye — hence its own runner.
- Drives real Chrome with `--use-fake-ui-for-media-stream` (auto-grants the SITE prompt, keeps the ACTUAL device; the opposite flag substitutes a test pattern and answers nothing). Reads every raw channel, the composite and the export straight out of OPFS through one MP4 box parser; the number that matters is the raw camera channel's CODED size — no downstream scaler can fabricate it.
- Verdicts: `PASS` / `FAIL` exit 0 / 1 (camera delivered frames, gates answered) · `CANNOT MEASURE` exit 2 (camera opened, negotiated a resolution, stayed live, delivered NO frames — nothing about the product was measured) · `HARNESS-OK (fake device)` exit 1 (the synthetic camera ran the whole flow; proves the runner, never P9).
- `getUserMedia` resolving is not evidence a camera works: a MacBook in clamshell still enumerates, negotiates 1920×1080@30 and reports its track `live` with the sensor off — this machine, 2026-08-29, `docs/qa/camera-1080-2026-08-29.json`, against 50 frames from the synthetic control through the identical code path. Re-run with a live camera to finish the row.
