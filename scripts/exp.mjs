#!/usr/bin/env node
/**
 * Generic experiment driver: ephemeral Vite server + headless Chrome + one
 * window.__exp.run(id, args) call, JSON to stdout.
 *
 * Same hygiene rules as scripts/oracle.mjs: never reuses :5173 (Robert's QA owns it),
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
  let cpu = false
  let gpu = false
  let keepAudio = false
  let refocus = false
  let realThrottling = false
  let captureTitle = ''
  let query = ''
  let ua = ''
  let profile = ''
  let fixedPort = 0
  let logDir = ''
  const chromeFlags = []
  for (const a of argv) {
    if (a.startsWith('--timeout=')) timeoutSec = Number(a.slice(10))
    else if (a === '--headed') headed = true
    else if (a === '--rss') rss = true
    else if (a === '--cpu') cpu = true
    else if (a === '--gpu') gpu = true
    else if (a === '--keep-audio') keepAudio = true
    else if (a === '--refocus') refocus = true
    else if (a === '--real-throttling') realThrottling = true
    else if (a.startsWith('--capture-title=')) captureTitle = a.slice(16)
    else if (a.startsWith('--query=')) query = a.slice(8)
    else if (a.startsWith('--ua=')) ua = a.slice(5)
    else if (a.startsWith('--profile=')) profile = a.slice(10)
    else if (a.startsWith('--chrome-flag=')) chromeFlags.push(a.slice(14))
    else if (a.startsWith('--port=')) fixedPort = Number(a.slice(7))
    else if (a.startsWith('--log-dir=')) logDir = a.slice(10)
    else positional.push(a)
  }
  const [experiment, jsonArgs] = positional
  if (!experiment) {
    console.error(
      "usage: exp.mjs <experiment> ['{json}'] [--timeout=1800] [--headed] [--rss] [--gpu] [--query=k=v] [--profile=dir]",
    )
    process.exit(2)
  }
  return {
    experiment,
    jsonArgs,
    timeoutSec,
    headed,
    rss,
    cpu,
    gpu,
    keepAudio,
    refocus,
    realThrottling,
    captureTitle,
    query,
    ua,
    profile,
    chromeFlags,
    fixedPort,
    logDir,
  }
}

/**
 * Peak resident memory of the Chrome renderer processes, sampled from the OS.
 * The in-page instruments are blind here: performance.memory excludes
 * ArrayBuffer backing stores, and measureUserAgentSpecificMemory() is throttled
 * to ~2 samples per run. RSS sees everything, so a run must exercise ONE target
 * for its number to be attributable — hence `paths` in the experiment args.
 * `marker` is the profile directory the run's Chrome carries on its command
 * line — see where it is derived in main().
 */
function startRssSampler(marker) {
  let peakKb = 0
  let samples = 0
  const tick = () => {
    try {
      const out = execFileSync('/bin/ps', ['-eo', 'rss=,command='], { encoding: 'utf8' })
      let sum = 0
      for (const line of out.split('\n')) {
        if (!line.includes(marker)) continue
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

/**
 * Whole-browser CPU during a run, sampled from the OS: the sum of %CPU across
 * every Chrome process of the throwaway profile (renderer, GPU, utilities).
 * In-page instruments can see only their own thread; capture cost lives in
 * all of them. Peak and mean-of-nonzero are reported; attribution is the
 * run's job (drive ONE engine per invocation).
 */
function startCpuSampler(marker) {
  let peakPct = 0
  let sumPct = 0
  let samples = 0
  const tick = () => {
    try {
      const out = execFileSync('/bin/ps', ['-eo', 'pcpu=,command='], { encoding: 'utf8' })
      let total = 0
      for (const line of out.split('\n')) {
        if (!line.includes(marker)) continue
        const pct = Number(line.trim().split(/\s+/)[0])
        if (Number.isFinite(pct)) total += pct
      }
      if (total > 0) {
        samples++
        sumPct += total
        if (total > peakPct) peakPct = total
      }
    } catch {
      /* ps unavailable — reported as null */
    }
  }
  const timer = setInterval(tick, 500)
  return {
    stop() {
      clearInterval(timer)
      return {
        peakCpuPct: samples ? Math.round(peakPct) : null,
        meanCpuPct: samples ? Math.round(sumPct / samples) : null,
        samples,
      }
    },
  }
}

/**
 * THE GPU PROCESS, SAMPLED FROM THE OS — the instrument R2 asked for.
 *
 * No in-page instrument can see GPU memory: `performance.memory` is this
 * thread's JS heap, `measureUserAgentSpecificMemory()` covers the page's own
 * threads, and a dedicated worker has neither (G3). The resource the
 * native-resolution render exhausts lives in a different PROCESS, and on macOS
 * that process's RSS is where GPU-backed frames land.
 *
 * Two numbers, and the second is the whole point:
 *  · peak/last RSS of Chrome's GPU helper — what grows.
 *  · how many times its PID CHANGED — the crash itself, as a fact. A dying GPU
 *    process is reported inside the tab as "decoding error", which is what sent
 *    an earlier session hunting the decoder for hours.
 */

/**
 * TOTAL Chrome across every process of this profile, and how much memory the
 * MACHINE has left — because R2's GPU process is dying with `exit_code=9`,
 * which is SIGKILL, which on macOS means the kernel killed it under memory
 * pressure rather than it crashing on its own.
 *
 * THE GPU PROCESS'S OWN RSS IS THE WRONG NUMBER and reading it alone is how
 * this was nearly called "not memory": GPU allocations on macOS are largely
 * IOSurface-backed shared memory, which `ps` RSS does not attribute to the
 * process holding them. A GPU process sitting at 130 MB of RSS can be the
 * biggest memory consumer on the machine. What is NOT ambiguous is what the
 * whole browser costs and what the machine has left, so sample both.
 */
function chromeTotalMb(psOut, marker) {
  let sum = 0
  for (const line of psOut.split('\n')) {
    if (!line.includes(marker)) continue
    const kb = Number(line.trim().split(/\s+/)[1])
    if (Number.isFinite(kb)) sum += kb
  }
  return Math.round(sum / 1024)
}

/** Free + inactive as a share of physical memory, from vm_stat. */
function systemFreePct() {
  try {
    const out = execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' })
    const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384)
    const get = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0)
    const free = get('Pages free') + get('Pages inactive') + get('Pages purgeable')
    const total = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim())
    if (!total) return null
    return Math.round(((free * page) / total) * 100)
  } catch {
    return null
  }
}

function startGpuSampler(marker) {
  const series = []
  let peakKb = 0
  let pid = null
  let restarts = 0
  let samples = 0
  const tick = () => {
    try {
      const out = execFileSync('/bin/ps', ['-eo', 'pid=,rss=,command='], { encoding: 'utf8' })
      for (const line of out.split('\n')) {
        if (!line.includes(marker)) continue
        if (!line.includes('--type=gpu-process')) continue
        const [pidStr, kbStr] = line.trim().split(/\s+/)
        const nextPid = Number(pidStr)
        const kb = Number(kbStr)
        if (!Number.isFinite(kb) || !Number.isFinite(nextPid)) continue
        if (pid !== null && nextPid !== pid) restarts++
        pid = nextPid
        samples++
        if (kb > peakKb) peakKb = kb
        series.push({
          t: Date.now(),
          mb: Math.round(kb / 1024),
          pid: nextPid,
          allMb: chromeTotalMb(out, marker),
          freePct: systemFreePct(),
        })
        return
      }
    } catch {
      /* ps unavailable — reported as null */
    }
  }
  const timer = setInterval(tick, 500)
  return {
    stop() {
      clearInterval(timer)
      return {
        peakGpuMB: samples ? Math.round(peakKb / 1024) : null,
        lastGpuMB: series.length ? series[series.length - 1].mb : null,
        peakChromeMB: series.reduce((m, s) => Math.max(m, s.allMb ?? 0), 0) || null,
        minFreePct: series.reduce(
          (m, s) => (s.freePct === null ? m : Math.min(m ?? 100, s.freePct)),
          null,
        ),
        gpuProcessRestarts: restarts,
        samples,
        series,
      }
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
  const {
    experiment,
    jsonArgs,
    timeoutSec,
    headed,
    rss,
    cpu,
    gpu,
    keepAudio,
    refocus,
    realThrottling,
    captureTitle,
    query,
    ua,
    profile,
    chromeFlags,
    fixedPort,
    logDir,
  } = parseArgs(process.argv.slice(2))
  // A PINNED PORT IS A PINNED ORIGIN, and OPFS is per-origin. The ephemeral
  // port is right for every run that wants a clean slate, and wrong for the one
  // that must REUSE what a previous run stored: R2's fixture is a 690 MB file
  // that costs three minutes to build, and an ephemeral port throws it away as
  // surely as a throwaway profile does. Pair `--port=` with `--profile=`.
  if (fixedPort && FORBIDDEN_PORTS.has(fixedPort)) {
    throw new Error(`port ${fixedPort} is reserved for Robert's QA server`)
  }
  const port = fixedPort || (await allocateEphemeralPort())
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
      ...(profile ? [`--profile=${profile}`] : []),
      ...(headed ? ['--headed'] : []),
      ...(keepAudio ? ['--keep-audio'] : []),
      ...(refocus ? ['--refocus'] : []),
      ...(realThrottling ? ['--real-throttling'] : []),
      ...(captureTitle ? [`--capture-title=${captureTitle}`] : []),
      ...chromeFlags.map((f) => `--chrome-flag=${f}`),
      ...(logDir ? [`--log-dir=${logDir}`] : []),
    ]
    // WHICH CHROME TO WATCH. The samplers pick their processes out of `ps` by a
    // string in the command line, and that string is the profile directory:
    // throwaway runs carry cdp-run's own `inout-oracle-profile-<n>`, and a
    // `--profile=<dir>` run carries the dir the caller named. Deriving it
    // instead of hardcoding one is what lets a REUSED profile be sampled — R2's
    // fixture is a 690 MB file that must survive between A/B runs, and a
    // throwaway profile throws its OPFS away with it.
    const marker = profile || 'inout-oracle-profile-'
    const sampler = rss ? startRssSampler(marker) : null
    const cpuSampler = cpu ? startCpuSampler(marker) : null
    const gpuSampler = gpu ? startGpuSampler(marker) : null
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
      child.on('error', reject)
      child.on('close', resolve)
    })
    if (gpuSampler) {
      const { peakGpuMB, lastGpuMB, peakChromeMB, minFreePct, gpuProcessRestarts, samples, series } =
        gpuSampler.stop()
      console.error(
        `exp: Chrome GPU process peak RSS ${peakGpuMB} MB, last ${lastGpuMB} MB, ` +
          `PID changes ${gpuProcessRestarts} over ${samples} samples` +
          (gpuProcessRestarts > 0 ? '  <-- THE GPU PROCESS DIED AND RESTARTED' : ''),
      )
      console.error(
        `exp: whole-browser peak RSS ${peakChromeMB} MB · machine free+inactive bottomed at ${minFreePct}%`,
      )
      // Coarse trace so "what grows" is answerable after the fact, not only live.
      const step = Math.max(1, Math.floor(series.length / 40))
      const pick = series.filter((_, i) => i % step === 0)
      console.error(`exp: GPU RSS trace (MB, every ${(step * 0.5).toFixed(1)}s) ${pick.map((s) => s.mb).join(' ')}`)
      console.error(`exp: whole-Chrome RSS trace (MB) ${pick.map((s) => s.allMb).join(' ')}`)
      console.error(`exp: machine free+inactive trace (%) ${pick.map((s) => s.freePct).join(' ')}`)
    }
    if (cpuSampler) {
      const { peakCpuPct, meanCpuPct, samples } = cpuSampler.stop()
      console.error(`exp: Chrome CPU peak ${peakCpuPct}% mean ${meanCpuPct}% over ${samples} samples`)
    }
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
