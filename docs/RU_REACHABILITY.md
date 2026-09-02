# RU reachability — what actually threatens the product in Russia (P3)
Purpose: the ranked RU risks, the probe that measures them, the platform facts, and the rulings. The engine is a non-issue (~75 % of the RU market is Chromium: Chrome ~53 % + Yandex ~18 %, both current Chromium bases — our code runs there); the risk is the hosting, the backend domain, and the only sign-in we ship.

## Ranked risks
| # | risk | blast radius | status |
|---|---|---|---|
| 1 | Google sign-in unreachable | cloud sharing entirely unusable; capture/edit/export unaffected | ACCEPTED — alternatives ruled out by Robert |
| 2 | `*.supabase.co` blocked platform-wide | no sign-in, no share links | mitigation known, not applied |
| 3 | Vercel shared IP blocked | the app does not open at all | mitigation known, not applied |
| 4 | Yandex Browser engine incompatibility | — | NOT the risk (Chromium; QA row still open) |
Not on the list: losing a recording. Capture, editing and export are local by design (OPFS storage, in-browser compose) — an RU user cut off from every endpoint still records and still exports a file; only the share link dies. Protect that deliberately: the offline PWA (P2) matters more in RU than anywhere.

## Measure
- `node scripts/ru-reachability.mjs --label="MTS Moscow, no VPN" --out=docs/qa/ru-mts.json` — run FROM the network under test, WITHOUT a VPN (a VPN run measures the VPN). Supply `--supabase=<deployed project URL>` (not in the local env) and a `--label` naming the ISP and city.
- Probes: DNS (system resolver AND a public one — a divergence is itself the diagnosis), TLS (including the certificate issuer, which fingerprints an intercepting middlebox), HTTP (including RU block-notice pages, which arrive as HTTP 200 and fool a naive status check).
- Non-RU baseline, dev machine, 2026-08-23 (`docs/qa/reachability-baseline.json`): app HTTP 200 (inout-kappa.vercel.app) · vercel-apex ECONNRESET (bare-IP probe carries no SNI; fails off-RU too) · supabase-api skipped (no VITE_SUPABASE_URL configured locally) · supabase-platform HTTP 307 · google-oauth HTTP 200 · yandex-id HTTP 302 · yandex-login HTTP 401 (reachable and asking for a token) · vk-id HTTP 200 · verdict ALL-CRITICAL-REACHABLE.
- RU run: NOT DONE — the one open P3 evidence item; it cannot be faked from here and needs Robert on an RU connection or one RU tester.

## Known about the two platform risks
- Vercel: no announced ban on Vercel as a company; a long, continuing pattern (reports 2021 → January 2026) of IP-level blocking — custom domains resolve to shared anycast IPs, one tenant on an IP gets a block order, every unrelated site on it goes dark. Signature: the `*.vercel.app` subdomain keeps working while the custom domain does not. Which IP is blocked shifts (February 2026: `76.76.21.21` clear while the domain's other assigned IP was blocked). `inout-kappa.vercel.app` is the low-risk address; the moment INOUT gets a custom domain it inherits this exposure — know it BEFORE choosing the domain.
- Supabase: no evidence of an RU block on `supabase.co` (searched, not found — weaker than "confirmed reachable", which is why the RU probe matters). The shape is proven elsewhere: India ordered `*.supabase.co` DNS-blocked at Jio/Airtel/ACT on 2026-02-24; UAE ISPs did similar around September 2025. Supabase's own write-up: a multi-tenant domain is a single point of failure, their CDN cannot intervene in government-directed blocking, their mitigations (Public Suffix List entry, custom domains) have not prevented blocks. Assume one order can take the backend away; keep the product useful without it.

## Mitigations, in the order they should be done
1. Custom domain for Supabase when cloud provisioning lands, so a `*.supabase.co` order does not take us with it. Costs a paid plan.
2. Keep `*.vercel.app` as a working address even after a custom domain exists, and say so in support copy — the documented escape hatch.
3. Do NOT ship a VPN recommendation as product copy.

## RULED OUT — auth alternatives (Robert, 2026-08-23)
Yandex ID / VK ID / email-OTP were designed and built as a compiling stub, then removed on instruction: "dont do auth alternatives for rus, just prepare it to work in yandex browser." `CloudProvider` is unchanged — Google is the only door, no optional members or adapters remain in the tree. Where `accounts.google.com` is unreachable, cloud sharing is simply unavailable (the user still gets the file, not a link). Do not re-add an alternative without Robert asking for it.

## i18n — decided, not started (F-phase work adopts it incrementally)
- Catalog: `src/app/i18n/en.ts` exports one flat frozen object, keys like `capture.record`; `type Key = keyof typeof en` makes every lookup compile-checked and every missing translation a type error.
- Lookup: a ~20-line `t(key, vars?)` in `src/app/i18n/index.ts`. No library — first paint is 219 KB after O7 and the record button must never wait on a locale bundle. `en` is inlined as the fallback; other packs are lazy `import()` keyed by BCP-47, resolved from `navigator.languages`.
- Extraction is manual-on-touch: a string moves into the catalog the first time its component is edited for some other reason. NO mass churn now — F2/F3/F4/F5 are all editing UI files and a repo-wide string rewrite would conflict with every one of them.
- Plurals: `Intl.PluralRules`. RU has three forms (one/few/many) against English's two, so a catalog value must be allowed to be a plural record, not only a string — designed into the value type now, implemented when the first plural is actually translated.
- Numbers, dates, durations: `Intl.NumberFormat` / `Intl.DateTimeFormat` with the resolved locale; `src/app/lib/format.ts` (`humanBytes`, `formatClock`) is the single seam.
- Not translated: the certification record written into every export's comment tag (O8) — machine-readable, stays English. RTL is out of scope.
