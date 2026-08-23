#!/usr/bin/env node
/**
 * Generic experiment driver: ephemeral Vite server + headless Chrome + one
 * window.__exp.run(id, args) call, JSON to stdout.
 *
 * Same hygiene rules as scripts/oracle.mjs: never reuses :5173 (PO QA owns it),
 * always spawns its own server, throwaway Chrome profile (cdp-run does that).
 *
 * Usage:
 *   node scripts/exp.mjs o1 '{"durationsSec":[10,20]}' --timeout=1800
 */

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const FORBIDDEN_PORTS = new Set([5173])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const positional = []
  let timeoutSec = 1800
  let headed = false
  let rss = false
  let query = ''
  let ua = ''
  for (const a of argv) {
    if (a.startsWith('--timeout=')) timeoutSec = Number(a.slice(10))
    else if (a === '--headed') headed = true
    else if (a === '--rss') rss = true
    else if (a.startsWith('--query=')) query = a.slice(8)
    else if (a.startsWith('--ua=')) ua = a.slice(5)
    else positional.push(a)
  }
  const [experiment, jsonArgs] = positional
  if (!experiment) {
    console.error(
      "usage: exp.mjs <experiment> ['{json}'] [--timeout=1800] [--headed] [--rss] [--query=k=v]",
    )
    process.exit(2)
  }
  return { experiment, jsonArgs, timeoutSec, headed, rss, query, ua }
}

/**
 * Peak resident memory of the Chrome renderer processes, sampled from the OS.
 * The in-page instruments are blind here: performance.memory excludes
 * ArrayBuffer backing stores, and measureUserAgentSpecificMemory() is throttled
 * to ~2 samples per run. RSS sees everything, so a run must exercise ONE target
 * for its number to be attributable — hence `paths` in the experiment args.
 */
function startRssSampler() {
  let peakKb = 0
  let samples = 0
  const tick = () => {
    try {
      const out = execFileSync('/bin/ps', ['-eo', 'rss=,command='], { encoding: 'utf8' })
      let sum = 0
      for (const line of out.split('\n')) {
        if (!line.includes('inout-oracle-profile-')) continue
        if (!line.includes('--type=renderer')) continue
        const kb = Number(line.trim().split(/\s+/)[0])
        if (Number.isFinite(kb)) sum += kb
      }
      if (sum > 0) {
        samples++
        if (sum > peakKb) peakKb = sum
      }
    } catch {
      /* ps unavailable — reported as null */
    }
  }
  const timer = setInterval(tick, 250)
  return {
    stop() {
      clearInterval(timer)
      return { peakRendererMB: samples ? Math.round(peakKb / 1024) : null, samples }
    },
  }
}

function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, HOST, () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close((err) => {
        if (err) reject(err)
        else if (!port || FORBIDDEN_PORTS.has(port)) reject(new Error(`bad ephemeral port ${port}`))
        else resolve(port)
      })
    })
    s.on('error', reject)
  })
}

async function waitForHttp(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up */
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${url}`)
}

async function main() {
  const { experiment, jsonArgs, timeoutSec, headed, rss, query, ua } = parseArgs(process.argv.slice(2))
  const port = await allocateEphemeralPort()
  console.error(`exp: ephemeral server on http://${HOST}:${port}`)

  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
    // Cross-origin isolated dev server: enables measureUserAgentSpecificMemory().
    env: { ...process.env, INOUT_COI: '1' },
  })
  let viteErr = ''
  vite.stderr?.on('data', (d) => {
    viteErr += String(d)
  })

  try {
    await waitForHttp(`http://${HOST}:${port}/experimental.html`, Date.now() + 60_000)
    const args = [
      join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
      experiment,
      ...(jsonArgs ? [jsonArgs] : []),
      `--port=${port}`,
      `--timeout=${timeoutSec}`,
      ...(query ? [`--query=${query}`] : []),
      ...(ua ? [`--ua=${ua}`] : []),
      ...(headed ? ['--headed'] : []),
    ]
    const sampler = rss ? startRssSampler() : null
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
      child.on('error', reject)
      child.on('close', resolve)
    })
    if (sampler) {
      const { peakRendererMB, samples } = sampler.stop()
      console.error(`exp: peak Chrome renderer RSS ${peakRendererMB} MB over ${samples} samples`)
    }
    process.exitCode = code ?? 0
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err))
    if (viteErr) console.error('--- vite stderr ---\n' + viteErr.slice(-2000))
    process.exitCode = 1
  } finally {
    vite.kill('SIGTERM')
    await sleep(200)
    try {
      vite.kill('SIGKILL')
    } catch {
      /* already dead */
    }
  }
}

await main()
