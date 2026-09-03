#!/usr/bin/env node
/**
 * G6(h) GATE — DOES A FRESH TAKE NAME ITS TAP AND ITS TAB-AUDIO PROCESSING?
 *
 * `ChannelDiagnostics` had no `audiotap` field, so a take could not say whether
 * it recorded through the track tap or the worklet — and A1's gate 2 could not
 * verify its own premise from the artifact, because the answer only ever
 * existed as a console line on a machine that had since been closed. B13 landed
 * the delivered ec/ns/agc half; this checks BOTH halves off a real recording.
 *
 * Records a synthetic take against an ephemeral local server (never :5173) and
 * reads the persisted recording back out of IndexedDB — the file is the witness,
 * not the console. `--query=` reaches the app's own knobs, so the two taps can
 * be exercised on one build:
 *
 *   node scripts/g6h-tapcheck.mjs                       # whatever the build picks
 *   node scripts/g6h-tapcheck.mjs --query=audiotap=worklet
 *   node scripts/g6h-tapcheck.mjs --query=audiotap=track
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveChrome, launchChromeRetrying, quitChrome, sleep } from './lib/chrome.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FORBIDDEN_PORTS = new Set([5173])
const query = process.argv.find((a) => a.startsWith('--query='))?.slice(8) ?? ''
const takeMs = Number(process.argv.find((a) => a.startsWith('--takeMs='))?.slice(9) ?? 6000)

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, 'localhost', () => {
      const p = s.address().port
      s.close((e) => (e || !p || FORBIDDEN_PORTS.has(p) ? reject(e ?? new Error('bad port')) : resolve(p)))
    })
    s.on('error', reject)
  })
}

async function waitForHttp(url, deadline) {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up */
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${url}`)
}

/** The newest take's tap and delivered audio settings, read from the store. */
const READ_TAKE = `(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('inout', 2)
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const all = await new Promise((res, rej) => {
    const r = db.transaction('recordings').objectStore('recordings').getAll()
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rec = all.sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!rec) return JSON.stringify(null)
  return JSON.stringify({
    id: rec.id,
    durationMs: Math.round(rec.durationMs),
    channels: rec.channels.map((c) => ({
      kind: c.kind, media: c.media,
      audioTap: c.diagnostics?.audioTap ?? null,
      audioTrack: c.diagnostics?.audioTrack ?? null,
    })),
  })
})()`

const bin = resolveChrome()
if (!bin) {
  console.error('g6h: Chrome not found — set CHROME_BIN')
  process.exit(2)
}
const port = await freePort()
console.error(`g6h: ephemeral server on http://localhost:${port} (never :5173)`)
const vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
  cwd: ROOT,
  stdio: 'pipe',
})
const profile = mkdtempSync(join(tmpdir(), 'g6h-'))
let session = null
try {
  await waitForHttp(`http://localhost:${port}/`, Date.now() + 60_000)
  const url = `http://localhost:${port}/?synthetic=1${query ? `&${query}` : ''}`
  session = await launchChromeRetrying({ bin, profile, url, headed: true })
  await sleep(3000)
  const started = await session.evaluate(
    `(() => { const b = document.querySelector('button[aria-label="Start recording"]'); if (!b) return false; b.click(); return true })()`,
  )
  if (!started) throw new Error('no Start recording button')
  await sleep(takeMs + 2500)
  await session.evaluate(
    `(() => { const b = document.querySelector('button[aria-label="Stop recording"]'); if (b) b.click(); return true })()`,
  )
  for (let i = 0; i < 60; i++) {
    if (await session.evaluate(`!!document.querySelector('.editor')`)) break
    await sleep(500)
  }
  await sleep(1500)
  const take = await session.evalJson(READ_TAKE, null)
  if (!take) throw new Error('no recording was persisted')

  const audio = take.channels.filter((c) => c.media === 'audio')
  const named = audio.filter((c) => c.audioTap === 'track' || c.audioTap === 'worklet')
  const withSettings = audio.filter((c) => c.audioTrack)
  console.log(JSON.stringify({ query: query || '(build default)', take }, null, 2))
  for (const c of audio) {
    console.error(
      `  ${c.kind}: tap=${c.audioTap ?? 'MISSING'} · ` +
        (c.audioTrack
          ? `ec=${c.audioTrack.echoCancellation} ns=${c.audioTrack.noiseSuppression} ` +
            `agc=${c.audioTrack.autoGainControl} ch=${c.audioTrack.channelCount} sr=${c.audioTrack.sampleRate}`
          : 'audioTrack MISSING'),
    )
  }
  const ok = audio.length > 0 && named.length === audio.length && withSettings.length === audio.length
  console.error(
    ok
      ? `g6h: PASS — all ${audio.length} audio channel(s) name their tap AND their delivered ec/ns/agc`
      : `g6h: FAIL — ${named.length}/${audio.length} named a tap, ${withSettings.length}/${audio.length} carried settings`,
  )
  process.exitCode = ok ? 0 : 1
} catch (err) {
  console.error(`g6h: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  if (session) await quitChrome(session).catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
  vite.kill('SIGTERM')
  await sleep(200)
  try {
    vite.kill('SIGKILL')
  } catch {
    /* already dead */
  }
}
