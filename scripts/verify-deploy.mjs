#!/usr/bin/env node
// Deploy-guard, detection half. Answers one question out loud: does prod serve
// THIS commit's build? Born from aa39084, whose Vercel build failed and prod
// silently served the previous deploy for hours while the PO tested on it.
//
//   node scripts/verify-deploy.mjs [sha] [--timeout=480]
//
// Builds <sha> (default HEAD) through scripts/build-gate.sh — or reuses the
// entry-asset list the gate cached when it ran at push time — then polls
// https://inout-kappa.vercel.app/ until the served index.html references
// exactly those assets, cross-checking Vercel's state on the GitHub commit
// status API (public repo, no token). Vite folds every chunk's hashed filename
// into its importer, so the entry assets change whenever any source does; the
// local and Vercel builds were verified byte-identical on 6717e7d. If they ever
// stop matching, first suspect a VITE_* env var set on Vercel but not locally.
//
// Exit 0: prod serves this commit's build. Exit 1: build failure, Vercel
// failure, or timeout — always with the full picture printed. No silent retry.

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROD = 'https://inout-kappa.vercel.app'
const STATUS_API = 'https://api.github.com/repos/robmakarov/inout/commits'
const SITE_POLL_MS = 5_000
const STATUS_POLL_MS = 30_000 // unauthenticated GitHub API: 60 req/h

const args = process.argv.slice(2)
const shaArg = args.find((a) => !a.startsWith('--')) ?? 'HEAD'
const timeoutS = Number(args.find((a) => a.startsWith('--timeout='))?.split('=')[1] ?? 480)

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const git = (...a) => execFileSync('git', ['-C', scriptsDir, ...a], { encoding: 'utf8' }).trim()
const sha = git('rev-parse', '--verify', `${shaArg}^{commit}`)
const short = sha.slice(0, 8)

const entryAssets = (html) => [...new Set(html.match(/\/assets\/[^"'\s]+/g) ?? [])].sort()

// Expected assets: the gate's cache if it already built this sha, else build now.
const cacheFile = join(git('rev-parse', '--absolute-git-dir'), 'inout-gate', sha)
if (!existsSync(cacheFile)) {
  const gate = spawnSync(join(scriptsDir, 'build-gate.sh'), [sha], { stdio: 'inherit' })
  if (gate.status !== 0) {
    console.error(`verify-deploy: FAIL — ${short} does not even build locally; nothing to wait for.`)
    process.exit(1)
  }
}
const expected = readFileSync(cacheFile, 'utf8').trim().split('\n').sort()

const fetchText = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache', ...headers } })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

// If prod ALREADY serves exactly these assets, the hash proves nothing: this
// commit changed no bundled source (docs, scripts, hooks), so its build is
// identical to the one already up and the match would read green at t=0 against
// the OLD deployment. Caught in practice on be76dcf, which reported OK after 0s
// while Vercel was still building. Fall back to the only signal that names the
// commit — Vercel's own status on the GitHub API.
let hashBlind = false
try {
  const baseline = entryAssets((await fetchText(`${PROD}/?verify=${short}-baseline`)).text)
  hashBlind = baseline.length > 0 && baseline.join() === expected.join()
} catch {
  // prod unreachable right now; the poll loop reports it properly
}

console.log(
  hashBlind
    ? `verify-deploy: ${short} produces the assets prod already serves — it changes no bundled output, so the hash cannot prove it deployed. Waiting on Vercel's status for this commit (timeout ${timeoutS}s).`
    : `verify-deploy: ${short} builds to [${expected.join(', ')}] — polling prod (timeout ${timeoutS}s)`,
)

const deadline = Date.now() + timeoutS * 1000
let lastStatusAt = 0
let ghState = 'unchecked'
let served = []

while (Date.now() < deadline) {
  const t = Math.round((Date.now() - deadline) / 1000) + timeoutS

  if (Date.now() - lastStatusAt >= STATUS_POLL_MS) {
    lastStatusAt = Date.now()
    try {
      const res = await fetchText(`${STATUS_API}/${sha}/status`, { 'user-agent': 'inout-verify-deploy' })
      const body = JSON.parse(res.text)
      ghState = res.ok ? body.state : `api ${res.status}`
      if (body.state === 'failure' || body.state === 'error') {
        console.error(`verify-deploy: FAIL — Vercel reports ${body.state} for ${short}. Prod keeps serving the previous build.`)
        for (const s of body.statuses ?? []) {
          console.error(`  ${s.context}: ${s.state} — ${s.description ?? ''}\n  ${s.target_url ?? ''}`)
        }
        process.exit(1)
      }
    } catch (e) {
      ghState = `unreachable (${e.message})`
    }
  }

  try {
    const res = await fetchText(`${PROD}/?verify=${short}-${t}`)
    served = res.ok ? entryAssets(res.text) : [`http ${res.status}`]
  } catch (e) {
    served = [`unreachable (${e.message})`]
  }

  if (!hashBlind && served.length && served.join() === expected.join()) {
    console.log(`verify-deploy: OK — prod serves the build of ${short} (github status: ${ghState}) after ${t}s`)
    process.exit(0)
  }
  if (hashBlind && ghState === 'success') {
    console.log(`verify-deploy: OK — Vercel reports success for ${short} after ${t}s. Prod serves an identical bundle; this commit changed no bundled output.`)
    process.exit(0)
  }

  console.log(`  t+${t}s prod=[${served.join(', ')}] github=${ghState}`)
  await new Promise((r) => setTimeout(r, SITE_POLL_MS))
}

console.error(
  hashBlind
    ? `verify-deploy: TIMEOUT after ${timeoutS}s — Vercel never reported success for ${short} (status: ${ghState}).`
    : `verify-deploy: TIMEOUT after ${timeoutS}s — prod does NOT serve ${short}.`,
)
console.error(`  expected [${expected.join(', ')}]`)
console.error(`  prod serves [${served.join(', ')}], github status: ${ghState}`)
console.error(`  Check https://vercel.com deployments for the failing build, or re-run with --timeout=900.`)
process.exit(1)
