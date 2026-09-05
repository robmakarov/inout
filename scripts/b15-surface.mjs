#!/usr/bin/env node
/**
 * B15 CELL 0 — CAN THE LAB EVEN REACH ROBERT'S SURFACE?
 *
 * Every negative cell in tabAudioDeath.ts captured a TAB. Robert's three
 * tab-audio deaths were on ENTIRE-SCREEN takes (his frames carry the macOS
 * menu bar and dock at 3024x1964), so the sound in them is macOS SYSTEM audio
 * taken beside a screen share — a different Chrome audio path, and one this
 * repo has never once run. Its own reported input latency says so: 20 ms on
 * his take against the 10 ms Chrome reports for tab audio everywhere else.
 *
 * This asks one question and prints the answer: when `getDisplayMedia` is
 * answered with a SCREEN, does an audio track come back at all, and with what
 * settings? No product code, no take — just the platform's answer.
 *
 *   node scripts/b15-surface.mjs
 *
 * Cells (each its own Chrome, ~15 s):
 *   legacy   Chrome's own picker (ScreenCaptureKit picker disabled), answered
 *            by --auto-select-desktop-capture-source. This is what every rig
 *            here uses for --real.
 *   legacy+  the same, launched via `open -na` so macOS holds Chrome itself
 *            responsible for the TCC screen-recording grant rather than the
 *            terminal that spawned it.
 *   sck      the native macOS picker left ON, which is what Robert gets. It
 *            cannot be clicked from here; the cell exists to record HOW it
 *            fails (hang vs refusal) rather than to pass.
 *   tab      the control: a tab capture, the path that has always had audio.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChrome, removeProfile, resolveChrome, sleep } from './lib/chrome.mjs'

const bin = resolveChrome()
if (!bin) {
  console.error('b15-surface: no Chrome found')
  process.exit(2)
}

const NO_SCK = '--disable-features=InfiniteSessionRestore,ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac'

/** Asks for display media and reports what came back. Bounded in the page so a
 *  picker nothing can answer fails as a timeout with a number on it. */
const PROBE = (constraints) => `(async () => {
  const t0 = performance.now()
  const out = { asked: ${JSON.stringify(constraints)}, ms: 0, error: null, video: null, audio: null }
  try {
    const s = await Promise.race([
      navigator.mediaDevices.getDisplayMedia(${JSON.stringify(constraints)}),
      new Promise((_, rej) => setTimeout(() => rej(new Error('PICKER NEVER ANSWERED (30s)')), 30000)),
    ])
    out.ms = Math.round(performance.now() - t0)
    const v = s.getVideoTracks()[0] ?? null
    const a = s.getAudioTracks()[0] ?? null
    out.video = v ? { label: v.label, settings: v.getSettings() } : null
    out.audio = a ? { label: a.label, settings: a.getSettings() } : null
    for (const t of s.getTracks()) t.stop()
  } catch (e) {
    out.ms = Math.round(performance.now() - t0)
    out.error = e.name + ': ' + e.message
  }
  return JSON.stringify(out)
})()`

// A page of our own on a real origin: getDisplayMedia needs a secure context
// and a focused document, which about:blank and file:// do not reliably give.
const PAGE = 'https://inout-kappa.vercel.app/?synthetic=1'

async function cell(name, { extraArgs, viaOpen, constraints }) {
  const profile = mkdtempSync(join(tmpdir(), `inout-b15-${process.pid}-`))
  let sess = null
  const row = { name, ...(await (async () => {
    try {
      sess = await launchChrome({
        bin,
        profile,
        url: PAGE,
        headed: true,
        muteAudio: false,
        viaOpen,
        extraArgs,
      })
      await sleep(2500)
      // getDisplayMedia throws InvalidStateError from an unfocused document.
      await sess.evaluate('window.focus(), document.hasFocus()').catch(() => {})
      const raw = await sess.evaluate(PROBE(constraints), 40_000).catch((e) => JSON.stringify({ error: 'driver: ' + e.message }))
      return typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch (e) {
      return { error: 'launch: ' + e.message }
    }
  })()) }
  try { sess?.kill() } catch { /* gone */ }
  await sleep(600)
  removeProfile(profile)
  return row
}

const NO_SCK_FEATS = 'InfiniteSessionRestore,ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac'
const SCREEN_AUDIO = { video: true, audio: true, systemAudio: 'include' }

const ALL = {
  legacy: { viaOpen: false, extraArgs: ['--auto-select-desktop-capture-source=Entire screen', `--disable-features=${NO_SCK_FEATS}`], constraints: SCREEN_AUDIO },
  'legacy+open': { extraArgs: ['--auto-select-desktop-capture-source=Entire screen', `--disable-features=${NO_SCK_FEATS}`], viaOpen: true, constraints: SCREEN_AUDIO },
  sck: { extraArgs: ['--auto-select-desktop-capture-source=Entire screen'], viaOpen: true, constraints: SCREEN_AUDIO },
  tab: { extraArgs: ['--auto-accept-this-tab-capture', `--disable-features=${NO_SCK_FEATS}`], constraints: { video: true, audio: true, preferCurrentTab: true } },
  // Chrome 152 carries a NEWER switch than the one every rig here uses.
  'screen-switch': { viaOpen: true, extraArgs: ['--auto-select-screen-capture-source=Entire screen', `--disable-features=${NO_SCK_FEATS}`], constraints: SCREEN_AUDIO },
  'screen-switch-0': { viaOpen: true, extraArgs: ['--auto-select-screen-capture-source=0', `--disable-features=${NO_SCK_FEATS}`], constraints: SCREEN_AUDIO },
  'screen-switch-sck': { viaOpen: true, extraArgs: ['--auto-select-screen-capture-source=Entire screen'], constraints: SCREEN_AUDIO },
  // The macOS system-audio implementation is a Core Audio process TAP
  // (kMacCatapLoopbackAudioForScreenShare in the 152 binary), not SCK audio.
  catap: { viaOpen: true, extraArgs: ['--auto-select-desktop-capture-source=Entire screen', '--enable-features=MacCatapLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride', `--disable-features=${NO_SCK_FEATS}`], constraints: SCREEN_AUDIO },
  'catap-sck': { viaOpen: true, extraArgs: ['--auto-select-desktop-capture-source=Entire screen', '--enable-features=MacCatapLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'], constraints: SCREEN_AUDIO },
  fakeui: { viaOpen: true, extraArgs: ['--use-fake-ui-for-media-stream', `--disable-features=${NO_SCK_FEATS}`], constraints: SCREEN_AUDIO },
}

const pick = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const CELLS = (pick.length ? pick : ['legacy', 'legacy+open', 'sck', 'tab']).map((n) => {
  if (!ALL[n]) throw new Error(`unknown cell '${n}' — have: ${Object.keys(ALL).join(', ')}`)
  return [n, ALL[n]]
})

const rows = []
for (const [name, opts] of CELLS) {
  process.stdout.write(`· ${name} … `)
  const r = await cell(name, opts)
  rows.push(r)
  const a = r.audio
  console.log(r.error ? `ERROR ${r.error}` : `${r.ms}ms  video=${r.video ? r.video.settings.width + 'x' + r.video.settings.height + ' ' + (r.video.settings.displaySurface ?? '?') : 'none'}  audio=${a ? `YES ch=${a.settings.channelCount} sr=${a.settings.sampleRate} "${a.label}"` : 'NONE'}`)
}
console.log('\n' + JSON.stringify(rows, null, 2))
