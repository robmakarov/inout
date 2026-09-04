#!/usr/bin/env node
/**
 * E3, SECOND QUESTION: does the background render cost the editor its PICTURE?
 *
 * Idea 21 names three jobs — "prerender/uploads/filmstrips at the rate their
 * deadline needs". The pre-render's deadline is answered by the claim
 * (scripts/e3-claimpace.mjs). The upload has nothing to pace: it is one opaque
 * `supabase.storage.upload()` of a finished file, no chunking, no progress, and
 * it never touches the media engine. That leaves the filmstrip, and the
 * question is whether it is actually racing anything.
 *
 * THE RACE, if it exists. The editor holds the render off while it opens
 * (`noteEditorOpening` → trickle, closed two frames after the preview has its
 * sources). The LANE ART starts after that: `useLaneArt` decodes a filmstrip
 * per video channel and a waveform per audio one, off the same media engine the
 * pre-render is by then using at FULL. The lane art has the tighter deadline of
 * the two — it is what the person is looking at, and the pre-render has until
 * the export press — so if the race is real, the order is inverted.
 *
 * THE MEASUREMENT is the editor's first seconds, twice, on one machine:
 *   job   default: the at-stop pre-render runs while the lanes decode
 *   solo  ?prerender=0: nothing else is running
 * Reported per lane: mount → last lane-art line, each lane's own wallMs, and
 * G7's editor card (`__inoutEditorReport()`), which is Phase 1's own
 * "no editor stall > 30 ms in its first 15 s".
 *
 *   node scripts/e3-laneart.mjs [--url=https://inout-kappa.vercel.app] [--take=40]
 *
 * Real headed Chrome: the agent's pane is a hidden document and its timers are
 * clamped to ~1 Hz. Always through scripts/gate.sh.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChromeRetrying, quitChrome, resolveChrome, sleep } from './lib/chrome.mjs'

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const BASE = arg('url', 'https://inout-kappa.vercel.app')
const TAKE_SEC = Number(arg('take', '40'))
const ONLY = arg('lane', '')
/** A take with a CAMERA, so its export must render and the at-stop pre-render
 *  actually starts (J6: an unedited camera take has nothing to packet-copy). */
const COMMON = 'synthetic=1&qstep=1080p&screensize=1920x1080'

async function lane(name, query, out) {
  const bin = resolveChrome()
  const profile = mkdtempSync(join(tmpdir(), 'inout-e3art-'))
  const url = `${BASE}/?${COMMON}&${query}`
  const chrome = await launchChromeRetrying({ bin, profile, url, headed: true })
  const rec = { lane: name, url }
  try {
    await sleep(3000)
    const visible = await chrome.evaluate('document.visibilityState')
    if (visible !== 'visible') throw new Error(`the page is ${visible}; every number here would be the clamp`)
    rec.build = await chrome.evaluate(
      `(performance.getEntriesByType('resource').map(e => e.name).find(n => /assets\\/index-.*\\.js/.test(n)) || '').split('/').pop()`,
    )
    const started = await chrome.evaluate(
      `(() => { const b = document.querySelector('button.recbtn'); if (!b) return 'no record button'; b.click(); return 'ok' })()`,
    )
    if (started !== 'ok') throw new Error(`could not start a take: ${started}`)
    await sleep(TAKE_SEC * 1000)
    const stopAt = Date.now()
    await chrome.evaluate(`(() => { document.querySelector('button.recbtn')?.click(); return 'ok' })()`)
    // The editor opens on the hand-off; the at-stop pre-render starts with it.
    let openAt = null
    for (let i = 0; i < 60; i++) {
      if (await chrome.evaluate(`!!document.querySelector('.tl__ruler')`)) {
        openAt = Date.now()
        break
      }
      await sleep(250)
    }
    if (openAt === null) throw new Error('the editor never opened')
    rec.stopToEditorMs = openAt - stopAt
    rec.prerenderStarted = chrome.consoleLines.some((l) => l.includes('pre-render started AT STOP'))

    // Every lane's art announces itself: "[timeline] filmstrip screen: 24/24
    // frames in 812 ms" / "[timeline] waveform mic: ...". Wait until the lanes
    // stop arriving, then read what they cost.
    let seen = 0
    let quietFor = 0
    let lastAt = Date.now()
    while (quietFor < 5000 && Date.now() - openAt < 90_000) {
      const n = chrome.consoleLines.filter((l) => /\[timeline\] (filmstrip|waveform)/.test(l)).length
      if (n !== seen) {
        seen = n
        lastAt = Date.now()
      }
      quietFor = Date.now() - lastAt
      await sleep(200)
    }
    rec.artLines = chrome.consoleLines.filter((l) => /\[timeline\] (filmstrip|waveform)/.test(l))
    rec.artCount = rec.artLines.length
    rec.artDoneMs = rec.artCount ? lastAt - openAt : null
    rec.artWallMs = rec.artLines
      .map((l) => Number(/in (\d+) ms/.exec(l)?.[1] ?? 0))
      .reduce((a, b) => a + b, 0)

    // G7's editor card samples the editor's own first 15 s and stops itself.
    // TWO TRAPS, both paid for once: `__inoutEditorReport` is ASYNC (main.tsx),
    // so stringifying the promise reads back `{}`; and it answers with a CARD
    // that says `unmeasured` long before the window closes, so breaking on the
    // first truthy answer records the sampler still running rather than what it
    // found. Wait for a dimension that is not `unmeasured`.
    for (let i = 0; i < 30; i++) {
      const card = await chrome.evaluate(
        `(async () => { try { const c = await globalThis.__inoutEditorReport?.(); return c ? JSON.stringify(c) : null } catch { return null } })()`,
      )
      if (card) {
        const parsed = JSON.parse(card)
        rec.editorCard = parsed
        if (parsed?.dimensions?.some((d) => d.status && d.status !== 'unmeasured')) break
      }
      await sleep(1000)
    }
    const dim = rec.editorCard?.dimensions?.[0]
    rec.editorVerdict = dim ? `${rec.editorCard.verdict}: ${dim.status} — ${dim.detail}` : 'no card'

    /**
     * F16's OWN GATE, unmoved: holding the render behind the editor's picture
     * only ever costs the pre-render TIME, and the pre-render's whole contract
     * is that it may only SAVE it. So say what it cost — the app prints
     * "pre-render ready after Ns" when the file is waiting.
     */
    for (let i = 0; i < 60; i++) {
      const line = chrome.consoleLines.find((l) => l.includes('pre-render ready after'))
      if (line) {
        rec.prerenderReadyLine = line
        rec.prerenderReadySec = Number(/ready after ([\d.]+)s/.exec(line)?.[1] ?? 0)
        break
      }
      if (chrome.consoleLines.some((l) => l.includes('pre-render did not finish'))) {
        rec.prerenderReadyLine = 'did not finish'
        break
      }
      if (!rec.prerenderStarted) break
      await sleep(1000)
    }
  } finally {
    await quitChrome(chrome).catch(() => undefined)
    rmSync(profile, { recursive: true, force: true })
  }
  out.lanes.push(rec)
  console.error(
    `e3-laneart: ${name} — art ${rec.artCount} lanes, done ${rec.artDoneMs} ms after the editor opened ` +
      `(${rec.artWallMs} ms of decode); pre-render ready ${rec.prerenderReadySec ?? 'n/a'}s; ${rec.editorVerdict}`,
  )
  return rec
}

async function main() {
  const out = { base: BASE, takeSec: TAKE_SEC, lanes: [], verdict: '' }
  if (ONLY !== 'solo') await lane('job', 'prerender=1&bgrender=1', out)
  if (ONLY !== 'job') await lane('solo', 'prerender=0&bgrender=0', out)
  const job = out.lanes.find((l) => l.lane === 'job')
  const solo = out.lanes.find((l) => l.lane === 'solo')
  if (job && solo) {
    out.verdict =
      `lane art lands ${solo.artDoneMs} ms after the editor opens with nothing else running, ` +
      `${job.artDoneMs} ms beside the at-stop pre-render ` +
      `(decode ${solo.artWallMs} -> ${job.artWallMs} ms); ` +
      `editor card ${solo.editorVerdict} -> ${job.editorVerdict}`
  } else {
    out.verdict = 'one lane only; no delta'
  }
  console.log(JSON.stringify(out, null, 2))
  console.error(`e3-laneart: ${out.verdict}`)
}

main().catch((err) => {
  console.error(`e3-laneart: ${err.message}`)
  process.exit(1)
})
