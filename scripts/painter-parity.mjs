#!/usr/bin/env node
/**
 * O4's PARITY GATE, DRIVEN AGAINST A REAL SCREEN.
 *
 * The experiment is `src/experimental/perf/painterParity.ts` and it imports the
 * product's own two painters. This file exists only to put a REAL
 * getDisplayMedia frame in front of it, which `npm run exp` cannot do:
 *
 *   · exp.mjs answers the TAB picker (`--auto-select-tab-capture-source-by-title`)
 *     but not the screen one, and a tab-capture frame is I420 from a different
 *     capturer — the wrong input for a gate about NV12 plane binding;
 *   · and a Chrome spawned from node is denied macOS Screen Recording outright,
 *     because TCC attributes the permission to the RESPONSIBLE process and that
 *     is node, which has no grant (measured 2026-09-04, O4 step 1). Launching
 *     through `open -na` makes launchd responsible and the grant is Chrome's
 *     own. `launchChrome({viaOpen})` in scripts/lib/chrome.mjs does that.
 *
 * So: vite dev on a free port, Chrome opened the one way that can capture a
 * screen, `window.__exp.run('painterparity')`, and the numbers printed with the
 * gate read against them.
 *
 *   node scripts/painter-parity.mjs
 *   node scripts/painter-parity.mjs --lane=canvas --frames=40   # the control
 *   node scripts/painter-parity.mjs --json
 *
 * THE GATE, and it is deliberately tight because the task's word is "identical":
 * the two painters must not differ by more than ONE 8-bit step on any channel of
 * any pixel of any frame. One step is the most that two independent YUV→RGB
 * conversions can round apart; anything above it is a different picture, not a
 * rounding difference, and this exits non-zero.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'
import { loadLine, startLoadSampler, waitForQuiet } from './lib/machine.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq === -1 ? true : hit.slice(eq + 1)
}
const OPTS = {
  lane: String(flag('lane', 'display')),
  frames: Number(flag('frames', 24)),
  matchSource: flag('match-source', false) === true,
  json: flag('json', false) === true,
  port: Number(flag('port', 5183)),
}

/** One 8-bit step. See the header. */
const MAX_STEP = 1

async function waitForHttp(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`never served ${url}`)
}

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : v === Infinity ? '∞' : '—')
const n = (v) => (Number.isFinite(v) ? String(v) : '—')

async function main() {
  const bin = resolveChrome()
  if (!bin) {
    console.error('painter-parity: no Chrome found')
    process.exit(2)
  }
  const pre = await waitForQuiet({ label: 'painter-parity', maxWaitMs: 45_000 })
  const sampler = startLoadSampler()

  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(OPTS.port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let viteErr = ''
  vite.stderr?.on('data', (d) => {
    viteErr += String(d)
  })

  const profile = mkdtempSync(join(tmpdir(), 'inout-parity-'))
  let session = null
  let result = null
  let load = null
  let consoleLines = []
  try {
    await waitForHttp(`http://127.0.0.1:${OPTS.port}/experimental.html`, Date.now() + 90_000)
    session = await launchChromeRetrying({
      bin,
      profile,
      url: `http://127.0.0.1:${OPTS.port}/experimental.html`,
      headed: true,
      // Chrome's own in-content picker, answered by the switch. The macOS
      // system picker (ScreenCaptureKit) is a native window no switch can
      // reach, so those three features go off — the same set fps-check.mjs
      // disables, for the same reason.
      extraArgs: [
        `--auto-select-desktop-capture-source=${process.env.INOUT_CAPTURE_SOURCE ?? 'Entire screen'}`,
        '--auto-accept-this-tab-capture',
        '--disable-features=InfiniteSessionRestore,' +
          (process.env.INOUT_CAPTURE_DISABLE ??
            'ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac'),
        '--window-size=1280,860',
      ],
      viaOpen: process.platform === 'darwin',
    })
    await sleep(1500)
    result = await session.evalJson(
      `window.__exp.run('painterparity', ${JSON.stringify({ frames: OPTS.frames, lane: OPTS.lane, matchSource: OPTS.matchSource })})`,
      null,
    )
  } finally {
    load = sampler.stop()
    consoleLines = session?.consoleLines ? [...session.consoleLines] : []
    if (session) await quitChrome(session)
    try {
      vite.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    rmSync(profile, { recursive: true, force: true })
  }

  // WebGPU's validation errors arrive on the console, asynchronously, and a
  // silent black frame is exactly what they look like from here.
  const gpuErrors = consoleLines.filter((l) => /WebGPU|compositor/.test(l))
  if (gpuErrors.length) {
    console.error('\nconsole:')
    for (const l of gpuErrors.slice(0, 12)) console.error('  ' + l)
  }
  if (!result) {
    console.error('painter-parity: the experiment returned nothing')
    if (viteErr) console.error(viteErr.slice(0, 2000))
    process.exit(1)
  }
  // The harness wraps a run; unwrap either shape rather than guessing.
  const r = result.result ?? result
  const payload = { load: { preflight: pre, during: load, line: loadLine(load) }, ...r }

  if (OPTS.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log('\nO4 PARITY — the WebGPU painter against the WebGL2 painter')
    console.log(`${loadLine(load)} · preflight ${(pre.busy * 100).toFixed(0)}% ${pre.quiet ? 'quiet' : 'NOT QUIET'}`)
    console.log(
      `lane ${r.lane} · source ${r.source ? `${r.source.width}x${r.source.height} ${r.source.format}` : '—'}` +
        ` · composite ${r.composite.width}x${r.composite.height} · ${r.frames} frames`,
    )
    if (r.source?.colorSpace) console.log(`source colorSpace: ${JSON.stringify(r.source.colorSpace)}`)
    console.log(`backends: webgpu=${r.backends.webgpu} webgl2=${r.backends.webgl2}`)
    for (const n of r.notes ?? []) console.log(`  note: ${n}`)
    const line = (name, s) =>
      s
        ? `  ${name.padEnd(12)} maxAbs ${String(s.maxAbs).padStart(3)} · mean ${fmt(s.meanAbs)} · >1 ${n(s.over1)} · >2 ${n(s.over2)} · >4 ${n(s.over4)} of ${s.pixels} px · PSNR ${fmt(s.psnrDb, 1)} dB` +
          (s.worstAt ? `\n  ${' '.repeat(12)} worst at ${s.worstAt.x},${s.worstAt.y}: gpu ${s.worstAt.a.join('/')} vs gl ${s.worstAt.b.join('/')}` : '')
        : `  ${name.padEnd(12)} —`
    console.log('\nWORST FRAME of the run (an average would hide the one bad frame):')
    console.log(line('whole frame', r.whole))
    console.log(line('PiP corners', r.pip))
    if (r.whole?.lumaMaxDiff !== null && r.whole?.lumaMaxDiff !== undefined) {
      console.log(
        `\n  LUMA over those pixels differs by at most ${fmt(r.whole.lumaMaxDiff, 2)} of 255 —` +
          ` ${r.whole.lumaMaxDiff < 1.5 ? 'the two painters agree about brightness and differ only about CHROMA (NV12 reconstruction)' : 'they differ about brightness too, so it is not only chroma'}`,
      )
    }
    if (r.whole?.worst12?.length) {
      console.log('\n  the twelve worst pixels (gpu vs gl):')
      for (const w of r.whole.worst12) {
        console.log(`    ${String(w.x).padStart(5)},${String(w.y).padStart(4)}  gpu ${w.a.map((v) => String(v).padStart(3)).join(' ')}   gl ${w.b.map((v) => String(v).padStart(3)).join(' ')}   d ${w.d}`)
      }
    }
    if (r.costMs.webgpu !== null) {
      const d = r.costMs.webgl2 - r.costMs.webgpu
      console.log(
        `\nPAINT per frame (real fence, batch of ${r.costMs.batch}): webgpu ${fmt(r.costMs.webgpu, 3)} ms · webgl2 ${fmt(r.costMs.webgl2, 3)} ms` +
          ` · webgpu is ${fmt(d, 3)} ms ${d >= 0 ? 'cheaper' : 'DEARER'} (${fmt((d / r.costMs.webgl2) * 100, 0)} %)`,
      )
    }
  }

  // THE A/B FOR ROBERT'S EYE. The repo's rule is that a picture a user could
  // see does not move without him looking first, and ~/Downloads/inout-o4 is
  // where an A/B pair goes. The images are stripped from the JSON afterwards —
  // four PNGs as base64 would make the evidence file unreadable.
  if (r.images) {
    const dir = join(homedir(), 'Downloads', 'inout-o4')
    mkdirSync(dir, { recursive: true })
    const written = []
    for (const [name, url] of Object.entries(r.images)) {
      const b64 = String(url).split(',')[1] ?? ''
      const file = join(dir, `${name}.png`)
      writeFileSync(file, Buffer.from(b64, 'base64'))
      written.push(file)
    }
    console.log(`\nA/B for Robert's eye — ${written.length} PNGs in ${dir}`)
    console.log('  gpuFull/glFull are the same frame painted both ways; gpuCrop/glCrop are a 4x')
    console.log('  nearest blow-up around the worst pixel, where a difference is actually visible.')
    delete r.images
    delete payload.images
  }

  const dump = join(ROOT, 'docs/qa/o4-painter-parity.json')
  try {
    writeFileSync(dump, JSON.stringify(payload, null, 2))
    if (!OPTS.json) console.log(`json: ${dump}`)
  } catch {
    /* best effort */
  }

  const fails = []
  if (!r.backends.webgpu) fails.push('no WebGPU painter — parity unmeasured')
  if (!r.backends.webgl2) fails.push('no WebGL2 painter — parity unmeasured')
  if (!r.frames) fails.push('no frames reached the painters')
  if (r.whole && r.whole.maxAbs > MAX_STEP)
    fails.push(`whole-frame maxAbs ${r.whole.maxAbs} > ${MAX_STEP} step`)
  if (r.pip && r.pip.maxAbs > MAX_STEP) fails.push(`PiP maxAbs ${r.pip.maxAbs} > ${MAX_STEP} step`)
  if (OPTS.lane === 'display' && r.lane !== 'display')
    fails.push('asked for a real display frame and did not get one')
  console.log(`\nPARITY: ${fails.length ? `RED — ${fails.join(' · ')}` : 'GREEN — the two painters agree within one 8-bit step'}`)
  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
