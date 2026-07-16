#!/usr/bin/env node
/**
 * EXPERIMENTAL — headless audio-fidelity oracle (task oracle-audio-fidelity).
 * Ephemeral Vite server only (never :5173 / shared PO QA).
 *
 * Usage: npm run oracle:fidelity
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FORBIDDEN_PORTS = new Set([5173])

const MAX_TONE_ERROR_DB = 1
const MIN_SEPARATION_DB = 40

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      /* */
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${url}`)
}

function runQuiet(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'pipe', cwd: ROOT })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.stderr?.on('data', (d) => {
      err += String(d)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ out, err, ok: code === 0, code }))
  })
}

function gateFidelity(report) {
  const f = report.fidelity ?? {}
  const failures = []
  if (f.maxToneErrorDb == null || f.maxToneErrorDb > MAX_TONE_ERROR_DB) {
    failures.push(`tone error ${f.maxToneErrorDb} > ${MAX_TONE_ERROR_DB} dB`)
  }
  if (f.separationDb == null || f.separationDb < MIN_SEPARATION_DB) {
    failures.push(`separation ${f.separationDb} < ${MIN_SEPARATION_DB} dB`)
  }
  if (f.limiterHits == null || f.limiterHits !== 0) {
    failures.push(`limiterHits ${f.limiterHits} ≠ 0`)
  }
  return {
    pass: failures.length === 0 && report.pass === true,
    failures,
    metrics: {
      maxToneErrorDb: f.maxToneErrorDb,
      separationDb: f.separationDb,
      limiterHits: f.limiterHits,
      thdDb: f.thdDb,
      imdDb: f.imdDb,
    },
  }
}

async function main() {
  try {
    await runQuiet(CHROME, ['--version'])
  } catch {
    console.error('Chrome not found — set CHROME_BIN')
    process.exit(2)
  }

  const port = await allocateEphemeralPort()
  console.error(`oracle-fidelity: ephemeral server on http://${HOST}:${port}`)
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  try {
    await waitForHttp(`http://${HOST}:${port}/experimental.html`, Date.now() + 60_000)
    const cdp = await runQuiet(process.execPath, [
      join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
      'oracle-fidelity',
      `--port=${port}`,
    ])
    if (!cdp.ok) {
      console.error(cdp.err || `cdp-run exited ${cdp.code}`)
      process.exitCode = 1
      return
    }
    const report = JSON.parse(cdp.out.trim())
    const gate = gateFidelity(report)
    const m = gate.metrics
    console.error(
      `${gate.pass ? 'PASS' : 'FAIL'} toneErr=${m.maxToneErrorDb?.toFixed?.(2)}dB sep=${m.separationDb?.toFixed?.(1)}dB hits=${m.limiterHits} thd=${m.thdDb?.toFixed?.(1)} imd=${m.imdDb?.toFixed?.(1)}`,
    )
    if (!gate.pass) console.error('  failures:', gate.failures.join('; '))
    process.stdout.write(JSON.stringify({ gate, report }, null, 2) + '\n')
    if (!gate.pass) process.exitCode = 1
  } finally {
    vite.kill('SIGTERM')
    await sleep(200)
    try {
      vite.kill('SIGKILL')
    } catch {
      /* */
    }
  }
}

await main()
