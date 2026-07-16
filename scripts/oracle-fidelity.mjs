#!/usr/bin/env node
/**
 * EXPERIMENTAL — audio fidelity oracle with optional file mode.
 *
 *   npm run oracle:fidelity              # e2e multitone capture path
 *   npm run oracle:fidelity -- --file=./export.mp4
 *
 * File mode serves the MP4 on a localhost port (never commits the file).
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createReadStream, existsSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FORBIDDEN_PORTS = new Set([5173])

const MAX_TONE_ERROR_DB = 1
const MIN_SEPARATION_DB = 40

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  let file = null
  for (const a of argv) {
    if (a.startsWith('--file=')) file = resolve(a.slice(7))
    else if (a.startsWith('--port=')) {
      console.error('oracle-fidelity: --port disabled (ephemeral only)')
      process.exit(2)
    }
  }
  return { file }
}

function allocateEphemeralPort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer()
    s.listen(0, HOST, () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close((err) => {
        if (err) reject(err)
        else if (!port || FORBIDDEN_PORTS.has(port)) reject(new Error(`bad port ${port}`))
        else resolvePort(port)
      })
    })
    s.on('error', reject)
  })
}

async function waitForHttp(url, deadline) {
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
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
  const f = report.fidelity ?? report
  const failures = []
  if (f.maxToneErrorDb != null) {
    if (f.maxToneErrorDb > MAX_TONE_ERROR_DB) {
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
  // File mode
  if (f.clickCount > 0) failures.push(`clicks=${f.clickCount}`)
  if (f.spliceCount > 0) failures.push(`splices=${f.spliceCount}`)
  if (f.spurPeakDb !== null && f.spurPeakDb > -40) {
    failures.push(`spur ${f.spurPeakDb.toFixed(1)} dB > -40 dB`)
  }
  return {
    pass: failures.length === 0 && f.pass === true,
    failures,
    metrics: {
      clickCount: f.clickCount,
      spliceCount: f.spliceCount,
      spurPeakDb: f.spurPeakDb,
      thdDb: f.thdDb,
      separationDb: f.separationDb,
      correlation: f.correlation,
      durationSec: f.durationSec,
    },
  }
}

async function runFileMode(filePath) {
  if (!existsSync(filePath)) {
    console.error(`file not found: ${filePath}`)
    process.exit(2)
  }
  const filePort = await allocateEphemeralPort()
  const fileName = basename(filePath)
  const fileServer = createHttpServer((req, res) => {
    if (req.url === `/${fileName}`) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': '*',
      })
      createReadStream(filePath).pipe(res)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => fileServer.listen(filePort, HOST, r))
  const fileUrl = `http://${HOST}:${filePort}/${fileName}`
  console.error(`oracle-fidelity file: ${filePath} via ${fileUrl}`)

  const devPort = await allocateEphemeralPort()
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(devPort), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  try {
    await waitForHttp(`http://${HOST}:${devPort}/experimental.html`, Date.now() + 60_000)
    const cdp = await runQuiet(process.execPath, [
      join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
      'oracle-fidelity-file',
      JSON.stringify({ fileUrl }),
      `--port=${devPort}`,
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
      `${gate.pass ? 'PASS' : 'ANALYZED'} clicks=${m.clickCount} splices=${m.spliceCount} spur=${m.spurPeakDb?.toFixed?.(1)}dB thd=${m.thdDb?.toFixed?.(1)} sep=${m.separationDb?.toFixed?.(1)} corr=${m.correlation?.toFixed?.(3)} dur=${m.durationSec?.toFixed?.(1)}s`,
    )
    if (report.clickEvents?.length) {
      console.error('  clicks:', report.clickEvents.slice(0, 8).map((e) => `${e.tSec.toFixed(2)}s Δ${e.magnitude.toFixed(3)}`).join(', '))
    }
    if (report.spliceEvents?.length) {
      console.error('  splices:', report.spliceEvents.slice(0, 8).map((e) => `${e.tSec.toFixed(2)}s Δ${e.magnitude.toFixed(3)}`).join(', '))
    }
    if (!gate.pass && report.note) console.error('  note:', report.note)
    process.stdout.write(JSON.stringify({ gate, report }, null, 2) + '\n')
  } finally {
    vite.kill('SIGTERM')
    await sleep(200)
    try {
      vite.kill('SIGKILL')
    } catch {
      /* */
    }
    fileServer.close()
  }
}

async function runE2eMode() {
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

async function main() {
  const { file } = parseArgs(process.argv.slice(2))
  if (file) await runFileMode(file)
  else await runE2eMode()
}

await main()
