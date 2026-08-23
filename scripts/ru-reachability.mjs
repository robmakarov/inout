#!/usr/bin/env node
/**
 * RU REACHABILITY PROBE (task P3).
 *
 * The RU risk for this product is NOT the engine — ~75 % of the RU market is
 * Chromium (Chrome ~53 % + Yandex ~18 %) and Yandex Browser runs our code. The
 * risk is INFRASTRUCTURE: platform-wide IP/DNS blocks that hit every tenant of
 * a shared host, and an auth provider (Google) that RU users often cannot reach.
 *
 * That cannot be measured from a developer machine outside Russia. So this is a
 * self-contained probe meant to be RUN FROM THE NETWORK UNDER TEST — a laptop
 * on an RU consumer ISP, WITHOUT a VPN — and its output is the evidence. Run it
 * here too: the non-RU baseline is what an RU run gets compared against, and a
 * difference between the two is the finding.
 *
 *   node scripts/ru-reachability.mjs                     # probe the defaults
 *   node scripts/ru-reachability.mjs --supabase=https://xyz.supabase.co
 *   node scripts/ru-reachability.mjs --out=docs/qa/ru-<date>.json --label="MTS Moscow, no VPN"
 *
 * Every check is a plain GET of a public endpoint — nothing is authenticated,
 * nothing is uploaded, no personal data leaves the machine.
 */
import { Resolver } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
let supabaseUrl = process.env.VITE_SUPABASE_URL || null
let out = null
let label = null
let appUrl = 'https://inout-kappa.vercel.app'
for (const a of args) {
  if (a.startsWith('--supabase=')) supabaseUrl = a.slice(11)
  else if (a.startsWith('--out=')) out = a.slice(6)
  else if (a.startsWith('--label=')) label = a.slice(8)
  else if (a.startsWith('--app=')) appUrl = a.slice(6)
  else {
    console.error(`ru-reachability: unknown argument ${a}`)
    process.exit(2)
  }
}

/**
 * `why` is the part that matters in the report: a red line is only actionable
 * if the reader knows what breaks when it is red.
 */
const TARGETS = [
  {
    id: 'app',
    host: new URL(appUrl).hostname,
    url: appUrl,
    why: 'The app itself. Red = nobody in RU can open INOUT at all.',
    critical: true,
  },
  {
    id: 'vercel-apex',
    host: '76.76.21.21',
    url: null,
    why: 'The shared Vercel apex IP custom domains point at. Historically blocked in RU as collateral damage from other tenants; the block moves between IPs over time.',
    critical: false,
    // A bare-IP TLS probe carries no SNI, so Vercel's edge resets it even from a
    // completely unfiltered network. Only the TCP/DNS half of this row is signal.
    baselineFails: true,
  },
  {
    id: 'supabase-api',
    host: supabaseUrl ? new URL(supabaseUrl).hostname : null,
    url: supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/auth/v1/health` : null,
    why: 'This project’s Supabase. Red = no sign-in and no share links; local capture/edit/export still work (they are offline by design).',
    critical: true,
    skipReason: supabaseUrl ? null : 'no VITE_SUPABASE_URL configured — pass --supabase=',
  },
  {
    id: 'supabase-platform',
    host: 'supabase.co',
    url: 'https://supabase.co/',
    why: 'The whole multi-tenant domain. India blocked *.supabase.co DNS wholesale in Feb 2026 — one order takes every project down, so this is the shape of the risk, not just our project.',
    critical: false,
  },
  {
    id: 'google-oauth',
    host: 'accounts.google.com',
    url: 'https://accounts.google.com/.well-known/openid-configuration',
    why: 'The ONLY sign-in we ship today. Red = cloud sharing is unusable in RU even if Supabase itself is reachable. This is what the auth alternatives exist for.',
    critical: true,
  },
  {
    id: 'yandex-id',
    host: 'oauth.yandex.ru',
    url: 'https://oauth.yandex.ru/authorize',
    why: 'Yandex ID authorize endpoint — auth alternative #1, and the one an RU user already has an account for.',
    critical: false,
  },
  {
    id: 'yandex-login',
    host: 'login.yandex.ru',
    url: 'https://login.yandex.ru/info',
    why: 'Yandex ID userinfo endpoint (the token exchange target).',
    critical: false,
  },
  {
    id: 'vk-id',
    host: 'id.vk.ru',
    url: 'https://id.vk.ru/authorize',
    why: 'VK ID authorize endpoint — auth alternative #2 (OAuth 2.1 + PKCE).',
    critical: false,
  },
]

const resolver = new Resolver()
resolver.setServers(['1.1.1.1', '8.8.8.8'])
const systemResolver = new Resolver()

const isIp = (h) => /^[0-9.]+$/.test(h)

async function dnsCheck(host) {
  if (isIp(host)) return { skipped: 'target is a literal IP' }
  const result = {}
  // The system resolver is the one a browser on this network actually uses —
  // an ISP-level DNS block shows up HERE and not in the public-resolver answer,
  // and that difference is itself the diagnosis.
  for (const [name, r] of [
    ['system', systemResolver],
    ['public', resolver],
  ]) {
    const t0 = Date.now()
    try {
      result[name] = { addresses: await r.resolve4(host), ms: Date.now() - t0 }
    } catch (err) {
      result[name] = { error: err.code ?? String(err), ms: Date.now() - t0 }
    }
  }
  result.divergent =
    !!result.system.addresses &&
    !!result.public.addresses &&
    result.system.addresses.join() !== result.public.addresses.join()
  result.systemBlockedOnly = !result.system.addresses && !!result.public.addresses
  return result
}

function tlsCheck(host, servername) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch {}
      resolve({ ...v, ms: Date.now() - t0 })
    }
    const sock = tlsConnect(
      { host, port: 443, servername: servername ?? host, timeout: 10_000, rejectUnauthorized: false },
      () => {
        const cert = sock.getPeerCertificate()
        done({
          ok: true,
          protocol: sock.getProtocol(),
          // An unexpected issuer on a censored network is the fingerprint of a
          // TLS-intercepting middlebox — worth seeing, not worth trusting.
          issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? null,
          subject: cert?.subject?.CN ?? null,
        })
      },
    )
    sock.on('timeout', () => done({ ok: false, error: 'TIMEOUT' }))
    sock.on('error', (err) => done({ ok: false, error: err.code ?? err.message }))
  })
}

async function httpCheck(url) {
  if (!url) return { skipped: 'no URL for this target' }
  const t0 = Date.now()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15_000)
  try {
    const res = await fetch(url, { redirect: 'manual', signal: ac.signal })
    const body = await res.text().catch(() => '')
    return {
      status: res.status,
      ms: Date.now() - t0,
      location: res.headers.get('location'),
      server: res.headers.get('server'),
      bytes: body.length,
      // RU ISPs serve a block notice page instead of dropping the connection;
      // a 200 that says "ограничен" is a block, and a naive status check misses it.
      looksLikeBlockPage: /огранич|заблокир|Роскомнадзор|blocked by|access denied/i.test(
        body.slice(0, 4000),
      ),
    }
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'TIMEOUT' : (err.cause?.code ?? err.code ?? String(err)), ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

const report = {
  runAt: new Date().toISOString(),
  label: label ?? '(unlabelled run — pass --label="ISP, city, VPN state")',
  node: process.version,
  platform: process.platform,
  targets: [],
}

for (const t of TARGETS) {
  if (!t.host || t.skipReason) {
    report.targets.push({ id: t.id, skipped: t.skipReason ?? 'not configured', why: t.why })
    continue
  }
  const dns = await dnsCheck(t.host)
  const tls = await tlsCheck(t.host, isIp(t.host) ? undefined : t.host)
  const http = await httpCheck(t.url)
  const reachable = !!(
    (tls.ok || (http.status && http.status < 500)) &&
    !http.looksLikeBlockPage
  )
  report.targets.push({
    id: t.id,
    host: t.host,
    url: t.url,
    why: t.why,
    critical: t.critical,
    baselineFails: !!t.baselineFails,
    dns,
    tls,
    http,
    reachable,
  })
}

report.unreachableCritical = report.targets.filter((t) => t.critical && t.reachable === false).map((t) => t.id)
report.verdict = report.unreachableCritical.length === 0 ? 'ALL-CRITICAL-REACHABLE' : 'CRITICAL-UNREACHABLE'

console.log(JSON.stringify(report, null, 2))
console.error('')
console.error(`── ${report.label}`)
for (const t of report.targets) {
  if (t.skipped) {
    console.error(`  ?  ${t.id.padEnd(18)} skipped — ${t.skipped}`)
    continue
  }
  const mark = t.baselineFails ? '–' : t.reachable ? '✓' : '✗'
  const detail = t.http?.status ? `HTTP ${t.http.status}` : (t.http?.error ?? t.tls?.error ?? 'no response')
  const suffix = t.baselineFails
    ? '  (fails off-RU too — compare DNS answers, not this mark)'
    : t.http?.looksLikeBlockPage
      ? '  ← BLOCK PAGE'
      : ''
  console.error(`  ${mark}  ${t.id.padEnd(18)} ${detail}${suffix}`)
}
console.error(`── verdict: ${report.verdict}`)

if (out) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(report, null, 2))
  console.error(`── written to ${out}`)
}
process.exit(report.verdict === 'ALL-CRITICAL-REACHABLE' ? 0 : 1)
