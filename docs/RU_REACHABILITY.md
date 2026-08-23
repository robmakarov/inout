# RU reachability — what actually threatens this product in Russia

CURRENT TRUTH ONLY. Task P3.

## The finding in one line

The engine is a non-issue and the infrastructure is the whole risk: ~75 % of
the RU market is Chromium (Chrome ~53 % + Yandex ~18 %, both current Chromium
bases), so **our code runs there**. What may not run there is the *hosting*,
the *backend domain*, and the *only sign-in we ship*.

Ranked by what it costs us if it goes red:

| # | risk | blast radius | status |
|---|---|---|---|
| 1 | **Google sign-in unreachable** | cloud sharing entirely unusable; capture/edit/export unaffected | designed around — see auth alternatives |
| 2 | **`*.supabase.co` blocked platform-wide** | no sign-in, no share links | mitigation known, not applied |
| 3 | **Vercel shared IP blocked** | the app does not open at all | mitigation known, not applied |
| 4 | Yandex Browser engine incompatibility | — | **not the risk** (Chromium; QA row still open) |

Note what is *not* on this list: losing a recording. Capture, editing and export
are local by design — OPFS storage, in-browser compose — so an RU user cut off
from every one of these endpoints still records and still exports a file. Only
the share link dies. That is worth protecting deliberately; it is the reason
the offline PWA (P2) matters more in RU than anywhere else.

## How to measure it

```bash
node scripts/ru-reachability.mjs --label="MTS Moscow, no VPN" --out=docs/qa/ru-mts.json
```

Must be run **from the network under test, without a VPN**. It probes DNS
(system resolver *and* a public one — a divergence is itself the diagnosis),
TLS (including the certificate issuer, which fingerprints an intercepting
middlebox), and HTTP (including RU block-notice pages, which arrive as HTTP 200
and fool a naive status check).

## Evidence so far

**Non-RU baseline, TD machine, 2026-08-23** — [`docs/qa/reachability-baseline.json`](qa/reachability-baseline.json):

```
  ✓  app                HTTP 200      inout-kappa.vercel.app
  –  vercel-apex        ECONNRESET    (bare-IP probe carries no SNI; fails off-RU too)
  ?  supabase-api       skipped       no VITE_SUPABASE_URL configured locally
  ✓  supabase-platform  HTTP 307
  ✓  google-oauth       HTTP 200
  ✓  yandex-id          HTTP 302
  ✓  yandex-login       HTTP 401      (401 = reachable and asking for a token)
  ✓  vk-id              HTTP 200
  verdict: ALL-CRITICAL-REACHABLE
```

**RU run: NOT DONE.** It cannot be faked from here, and a VPN run would measure
the VPN. This is the one open item of the P3 evidence, and it needs either PO on
an RU connection or one RU tester. Two things to supply when running it:
`--supabase=` (the deployed project URL, which is not in the local env) and a
`--label` naming the ISP and city.

## What is already known about the two platform risks

**Vercel.** No announced ban on Vercel as a company. What exists is a long,
continuing pattern of IP-level blocking: custom domains resolve to shared
anycast IPs, one tenant on an IP gets a block order, and every unrelated site on
that IP goes dark with it. The signature is unmistakable and useful — the
`*.vercel.app` subdomain keeps working while the custom domain does not. Reports
run from 2021 through January 2026, and *which* IP is blocked shifts over time
(one report in February 2026 found `76.76.21.21` clear while the domain's other
assigned IP was blocked).

For us today this means: `inout-kappa.vercel.app` is the low-risk address, and
the moment INOUT gets a custom domain it inherits this exposure. Worth knowing
*before* choosing the domain, not after.

**Supabase.** No evidence of an RU block on `supabase.co` — searched and not
found, which is a weaker statement than "confirmed reachable" and is exactly why
the RU probe run matters. But the *shape* of the risk is proven elsewhere:
India ordered `*.supabase.co` DNS blocked at Jio/Airtel/ACT on 2026-02-24, and
UAE ISPs did something similar around September 2025. Supabase's own write-up is
candid that a multi-tenant domain is a single point of failure, that their CDN
cannot intervene in government-directed blocking, and that their mitigations
(Public Suffix List entry, custom domains) have not prevented blocks. So: assume
one order can take the backend away, and keep the product useful without it.

## Mitigations, in the order they should be done

1. **Ship email-OTP sign-in** (Supabase native, no new provider, no server
   function). Removes the #1 risk outright for anyone who can reach the
   backend. Open question is RU mailbox deliverability of the sending domain —
   provisioning, not code.
2. **Custom domain for Supabase** when cloud provisioning lands, so an
   `*.supabase.co` order does not take us with it. Costs a paid plan.
3. **Keep `*.vercel.app` as a working address** even after a custom domain
   exists, and say so in support copy. It is the documented escape hatch.
4. **Yandex ID / VK ID** as additional doors — designed in
   `src/core/cloud/ruAuth.ts`, blocked on the server-side token exchange.
5. Do **not** ship a VPN recommendation as product copy.

## Auth alternatives — design

Full rationale and the compiling stub: `src/core/cloud/ruAuth.ts`. Summary:

- **email-OTP** — Supabase implements it natively (`signInWithOtp` +
  `verifyOtp`). No new provider, no server function. Ship first.
- **Yandex ID** — OAuth 2.0, authorize `oauth.yandex.ru/authorize`, userinfo
  `login.yandex.ru/info`. The account an RU user already has.
- **VK ID** — OAuth 2.1 on `id.vk.ru`, PKCE S256 **mandatory**, no client
  secret, and not compatible with the legacy `oauth.vk.com` endpoints. Signs
  the flow against an exact `redirect_uri`.

Both OAuth providers hand back *their own* tokens, which Supabase will not
accept — `signInWithIdToken` only speaks to providers it knows. A session has to
be minted server-side against the project's JWT secret, and a browser holding
that secret would hand every visitor an admin key. So the token exchange is one
server function per provider, deployed with the project, and it does not exist
yet because cloud provisioning is still pending (`docs/CLOUD_RESET.md` steps
2–3). What is built and tested now is the pure half: PKCE pair generation
(pinned to the RFC 7636 test vector) and the authorize-URL builder that refuses
to produce a VK ID URL without PKCE.

`CloudProvider` gained three OPTIONAL members (`authMethods`, `signIn`,
`verifyOtp`); `signInWithGoogle()` stays required, so nothing that exists today
changes.

## i18n — decided, not started

The scheme, so that F-phase work can adopt it incrementally instead of
colliding with a mass string rewrite:

- **Catalog**: `src/app/i18n/en.ts` exports one flat frozen object, keys like
  `capture.record`. `type Key = keyof typeof en` makes every lookup
  compile-checked and every missing translation a type error.
- **Lookup**: a ~20-line `t(key, vars?)` in `src/app/i18n/index.ts`. No
  library — first paint is 219 KB after O7 and the record button must never
  wait on a locale bundle. `en` is inlined as the fallback; other packs are
  lazy `import()` keyed by BCP-47 and resolved from `navigator.languages`.
- **Extraction is manual-on-touch.** A string moves into the catalog the first
  time its component is edited for some other reason. **No mass churn now** —
  F2/F3/F4/F5 are all editing UI files, and a repo-wide string rewrite would
  conflict with every one of them.
- **Plurals**: `Intl.PluralRules`. RU has three forms (one/few/many) against
  English's two, so a catalog value must be allowed to be a plural record, not
  only a string. Designed into the value type now; implemented when the first
  plural is actually translated.
- **Numbers, dates, durations**: `Intl.NumberFormat` / `Intl.DateTimeFormat`
  with the resolved locale. `src/app/lib/format.ts` (`humanBytes`,
  `formatClock`) is the single seam.
- **Not translated**: the certification record written into every export's
  comment tag (O8). It is machine-readable and stays English.
- RTL is out of scope.
