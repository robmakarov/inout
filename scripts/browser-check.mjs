#!/usr/bin/env node
/**
 * QA MATRIX RUNNER (task P3) — drives one real browser through the whole
 * product on the PRODUCTION build: load → record a synthetic take → stop →
 * editor → export → read the result the user reads.
 *
 * Why this exists: the RU market is ~75 % Chromium, but ~18 points of that is
 * YANDEX BROWSER, which wears a `Chrome/NNN` UA token. Nothing in our test rig
 * could tell the two apart, and "it's Chromium, it'll be fine" is an assumption,
 * not evidence. This turns the Yandex gate into one command.
 *
 * Same hygiene as oracle.mjs: ephemeral server on a free port (never :5173,
 * which Robert's QA owns), throwaway browser profile, prod build only.
 *
 *   node scripts/browser-check.mjs --list
 *   node scripts/browser-check.mjs --browser=yandex
 *   node scripts/browser-check.mjs --browser=chrome --ua-of=yandex   # detection only
 *   node scripts/browser-check.mjs --bin="/path/to/browser" --headed
 *
 * Exit code is 0 only when every gate in the report passed.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG_PORT = 9347
const FORBIDDEN_PORTS = new Set([5173])

/**
 * Where each browser actually installs. Yandex ships as `Yandex.app` on macOS
 * (binary `Yandex`), NOT "Yandex Browser.app" — both spellings have shipped
 * over the years, so both are probed.
 */
const BROWSERS = {
  chrome: {
    label: 'Google Chrome',
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['google-chrome', 'google-chrome-stable'],
    win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe'],
  },
  yandex: {
    label: 'Yandex Browser',
    darwin: [
      '/Applications/Yandex.app/Contents/MacOS/Yandex',
      '/Applications/Yandex Browser.app/Contents/MacOS/Yandex Browser',
      `${process.env.HOME ?? ''}/Applications/Yandex.app/Contents/MacOS/Yandex`,
    ],
    linux: ['yandex-browser', 'yandex-browser-stable'],
    win32: [
      `${process.env.LOCALAPPDATA ?? ''}/Yandex/YandexBrowser/Application/browser.exe`,
    ],
  },
  edge: {
    label: 'Microsoft Edge',
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['microsoft-edge', 'microsoft-edge-stable'],
    win32: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  },
  brave: {
    label: 'Brave',
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['brave-browser'],
    win32: ['C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe'],
  },
  opera: {
    label: 'Opera',
    darwin: ['/Applications/Opera.app/Contents/MacOS/Opera'],
    linux: ['opera'],
    win32: [],
  },
  // Firefox is driven by CDP here like the rest, which it does NOT speak. It is
  // listed so `--list` tells the truth about what is installed, and so the
  // failure names the reason instead of "browser not found" (task P1: the real
  // Firefox gate needs Playwright's gecko driver, not this runner).
  firefox: {
    label: 'Mozilla Firefox',
    darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    linux: ['firefox'],
    win32: ['C:/Program Files/Mozilla Firefox/firefox.exe'],
    noCdp: true,
  },
}

/** UA strings for `--ua-of` — spoofing proves OUR detection, never their engine. */
const UA_OF = {
  yandex:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36',
  'yandex-old':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.81 YaBrowser/21.11.0.1996 Yowser/2.5 Safari/537.36',
  'yandex-android':
    'Mozilla/5.0 (Linux; arm_64; Android 13; RMX3710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.91 YaBrowser/24.1.1.91.00 SA/3 Mobile Safari/537.36',
  // P1: current Firefox on each desktop OS. Spoofing these proves OUR engine x
  // OS matrix picks the right row — it proves NOTHING about Gecko itself, and
  // the QA matrix has to say so wherever these rows appear.
  firefox:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  'firefox-windows':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'firefox-old':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:98.0) Gecko/20100101 Firefox/98.0',
  // …and Chromium on WINDOWS, the row that differs from macOS: a monitor share
  // there carries the machine's audio, so the channel is named differently.
  'chrome-windows':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
}

function which(cmd) {
  try {
    return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function resolveBrowser(key) {
  const spec = BROWSERS[key]
  if (!spec) return null
  if (spec.noCdp) {
    return {
      key,
      label: spec.label,
      bin: null,
      unsupported:
        'this runner drives browsers over CDP, which Firefox does not speak — the real gecko run needs Playwright (task P1)',
    }
  }
  const candidates = spec[process.platform] ?? []
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return { key, label: spec.label, bin: c }
    } else {
      const found = which(c)
      if (found) return { key, label: spec.label, bin: found }
    }
  }
  return null
}

/** `--version` from the binary — the authoritative build string for a report. */
function binaryVersion(bin) {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const o = { browser: 'chrome', bin: null, ua: null, takeMs: 6000, headed: false, list: false, out: null, build: false }
  for (const a of argv) {
    if (a === '--list') o.list = true
    else if (a === '--headed') o.headed = true
    else if (a === '--build') o.build = true
    else if (a.startsWith('--browser=')) o.browser = a.slice(10)
    else if (a.startsWith('--bin=')) o.bin = a.slice(6)
    else if (a.startsWith('--ua=')) o.ua = a.slice(5)
    else if (a.startsWith('--ua-of=')) {
      const k = a.slice(8)
      if (!UA_OF[k]) {
        console.error(`browser-check: unknown --ua-of=${k} (have: ${Object.keys(UA_OF).join(', ')})`)
        process.exit(2)
      }
      o.ua = UA_OF[k]
      o.uaOf = k
    } else if (a.startsWith('--takeMs=')) o.takeMs = Number(a.slice(9))
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else {
      console.error(`browser-check: unknown argument ${a}`)
      process.exit(2)
    }
  }
  return o
}

const opts = parseArgs(process.argv.slice(2))

if (opts.list) {
  const rows = Object.keys(BROWSERS).map((k) => {
    const r = resolveBrowser(k)
    return {
      browser: k,
      label: BROWSERS[k].label,
      installed: !!r?.bin,
      bin: r?.bin ?? null,
      version: r?.bin ? binaryVersion(r.bin) : null,
      ...(r?.unsupported ? { unsupported: r.unsupported } : {}),
    }
  })
  console.log(JSON.stringify({ platform: process.platform, browsers: rows }, null, 2))
  process.exit(0)
}

const resolved = opts.bin
  ? { key: 'custom', label: 'custom binary', bin: opts.bin }
  : resolveBrowser(opts.browser)

if (!resolved) {
  console.error(
    JSON.stringify(
      {
        error:
          resolved?.unsupported ??
          `${BROWSERS[opts.browser]?.label ?? opts.browser} is not installed on this machine`,
        hint: 'install it, or pass --bin=/path/to/binary. `--list` shows what is here.',
        browser: opts.browser,
      },
      null,
      2,
    ),
  )
  process.exit(3)
}

if (opts.build || !existsSync(join(ROOT, 'dist/index.html'))) {
  console.error('[browser-check] building the production bundle…')
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })
}

const port = await new Promise((res, rej) => {
  const s = createServer()
  s.listen(0, 'localhost', () => {
    const { port } = s.address()
    s.close((e) => (e ? rej(e) : FORBIDDEN_PORTS.has(port) ? rej(new Error('bad port')) : res(port)))
  })
})

const preview = spawn(
  join(ROOT, 'node_modules/.bin/vite'),
  ['preview', '--port', String(port), '--strictPort'],
  { cwd: ROOT, stdio: 'pipe' },
)
const profile = mkdtempSync(join(tmpdir(), 'inout-qa-'))
let browser
const report = {
  browser: resolved.key,
  label: resolved.label,
  binary: resolved.bin,
  binaryVersion: binaryVersion(resolved.bin),
  uaSpoofedAs: opts.uaOf ?? (opts.ua ? 'custom' : null),
  takeMs: opts.takeMs,
  gates: {},
  consoleErrors: [],
}
let exitCode = 1

try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) break
    } catch {}
    await sleep(150)
  }

  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--mute-audio',
    '--window-size=1280,900',
  ]
  if (!opts.headed) args.unshift('--headless=new')
  if (opts.ua) args.push(`--user-agent=${opts.ua}`)
  args.push(`http://localhost:${port}/?synthetic=1`)

  browser = spawn(resolved.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  let ws = null
  for (let i = 0; i < 200 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find((x) => x.type === 'page' && x.url.includes(`:${port}/`))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {}
    if (!ws) await sleep(200)
  }
  if (!ws) throw new Error('browser never exposed a debuggable page (does it support --remote-debugging-port?)')

  const sock = new WebSocket(ws)
  await new Promise((r, j) => {
    sock.addEventListener('open', r, { once: true })
    sock.addEventListener('error', () => j(new Error('cdp connect failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      report.consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    } else if (m.method === 'Runtime.exceptionThrown') {
      report.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception')
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

  await send('Runtime.enable')

  // ---- gate 1: the app boots, and knows what it is running in --------------
  const version = await send('Browser.getVersion')
  report.cdpProduct = version.product
  report.cdpUserAgent = version.userAgent

  await sleep(2500)
  const diag = await evaluate('JSON.stringify(window.__inoutSupport ?? null)')
  report.inoutSupport = diag ? JSON.parse(diag) : null
  report.gates.boots = !!(await evaluate(`!!document.querySelector('button[aria-label="Start recording"]')`))
  report.gates.identifiedBrowser =
    !!report.inoutSupport && report.inoutSupport.platform.browser === (opts.uaOf ? opts.uaOf.split('-')[0] : resolved.key)
  report.gates.supported = !!report.inoutSupport?.support?.ok

  // ---- gate 2: record a synthetic take -------------------------------------
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(opts.takeMs)
  const stopped = await evaluate(
    `(() => { const b=document.querySelector('button[aria-label="Stop recording"]'); if(!b) return false; b.click(); return true })()`,
  )
  report.gates.recorded = !!stopped
  await sleep(3500)
  report.gates.reachedEditor = !!(await evaluate(`!!document.querySelector('.editor')`))
  report.channels = await evaluate(
    `(() => { const l=[...document.querySelectorAll('.tl__lanes .lane__gutter')].map(e=>e.textContent.trim()).filter(Boolean); return l.length?l:null })()`,
  )

  // ---- gate 3: export, and read the result the user reads -------------------
  await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
  )
  await sleep(800)
  const tExport = Date.now()
  await evaluate(
    `(() => { const b=document.querySelector('.quality .btn--primary'); if(!b) return false; b.click(); return true })()`,
  )
  let meta = null
  for (let i = 0; i < 240 && !meta; i++) {
    await sleep(500)
    meta = await evaluate(`document.querySelector('.xp__meta')?.textContent ?? null`)
  }
  report.exportMs = Date.now() - tExport
  report.exportMeta = meta
  report.gates.exported = !!meta
  // "0:00 · 0 B" is a produced-but-empty file — that is a failure, not a pass.
  report.gates.exportNonEmpty = !!meta && !/·\s*0\s*B/.test(meta)

  report.gates.noConsoleErrors = report.consoleErrors.length === 0

  const failed = Object.entries(report.gates).filter(([, v]) => !v).map(([k]) => k)
  report.failed = failed
  report.verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  exitCode = failed.length === 0 ? 0 : 1
} catch (err) {
  report.verdict = 'ERROR'
  report.error = err instanceof Error ? err.message : String(err)
} finally {
  console.log(JSON.stringify(report, null, 2))
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true })
    writeFileSync(opts.out, JSON.stringify(report, null, 2))
  }
  try { browser?.kill('SIGKILL') } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  preview.kill('SIGTERM')
  await sleep(200)
  try { preview.kill('SIGKILL') } catch {}
  process.exit(exitCode)
}
