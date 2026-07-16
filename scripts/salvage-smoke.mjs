#!/usr/bin/env node
/** Headless salvage regression smoke (task webcodecs-capture-a). Ephemeral server only. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'localhost'
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, HOST, () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close((err) => (err ? reject(err) : resolve(port)))
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

async function main() {
  const port = await allocateEphemeralPort()
  console.error(`salvage-smoke: ephemeral http://${HOST}:${port}`)
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  try {
    await waitForHttp(`http://${HOST}:${port}/experimental.html`, Date.now() + 60_000)
    const cdp = await runQuiet(process.execPath, [
      join(ROOT, 'src/experimental/tools/cdp-run.mjs'),
      'salvage-smoke',
      `--port=${port}`,
    ])
    if (!cdp.ok) {
      console.error(cdp.err || `cdp-run exited ${cdp.code}`)
      process.exitCode = 1
      return
    }
    const report = JSON.parse(cdp.out.trim())
    console.error(
      `${report.pass ? 'PASS' : 'FAIL'} salvaged=${report.salvagedChannelCount}/${report.channelCount} videoMime=${report.videoMime} — ${report.note}`,
    )
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    if (!report.pass) process.exitCode = 1
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
