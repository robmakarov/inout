#!/usr/bin/env node
/**
 * Screenshot a flow in the PRODUCTION build (vite preview + headless Chrome).
 * Records a short synthetic take, stops, opens Export, and captures the
 * quality panel — visual proof for UI work, on the build users actually get.
 *
 * Usage: node scripts/ui-shot.mjs [--takeMs=4000] [--out=/tmp/shot.png]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT_DEBUG = 9341
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let takeMs = 4000
let out = '/tmp/inout-quality.png'
let flow = 'quality'
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--takeMs=')) takeMs = Number(a.slice(9))
  else if (a.startsWith('--out=')) out = a.slice(6)
  else if (a.startsWith('--flow=')) flow = a.slice(7)
}

const port = await new Promise((res, rej) => {
  const s = createServer()
  s.listen(0, 'localhost', () => {
    const { port } = s.address()
    s.close((e) => (e ? rej(e) : res(port)))
  })
})

const preview = spawn(join(ROOT, 'node_modules/.bin/vite'), ['preview', '--port', String(port), '--strictPort'], {
  cwd: ROOT,
  stdio: 'pipe',
})
const profile = mkdtempSync(join(tmpdir(), 'inout-shot-'))
let chrome
try {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) break
    } catch {}
    await sleep(150)
  }
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT_DEBUG}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--mute-audio',
      '--window-size=1200,900',
      `http://localhost:${port}/?synthetic=1`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let ws = null
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT_DEBUG}/json/list`)).json()
      const page = t.find((x) => x.type === 'page' && x.url.includes(`:${port}/`))
      if (page) ws = page.webSocketDebuggerUrl
    } catch {}
    if (!ws) await sleep(150)
  }
  const sock = new WebSocket(ws)
  await new Promise((r, j) => {
    sock.addEventListener('open', r, { once: true })
    sock.addEventListener('error', () => j(new Error('cdp failed')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  /** Page console, kept for flows whose evidence is a logged number (F8). */
  const consoleLines = []
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleLines.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
      return
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(m.error.message)) : resolve(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      sock.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result
      .value

  await send('Runtime.enable')
  let chipsBefore = null
  let chipsAfter = null
  await sleep(2500)
  /**
   * F7d: a take with NO video channel is the cheapest real case where the size
   * probe cannot run at all — there is nothing to compose, so calibrateSteps
   * returns null and the panel must stop promising a measurement. Switch the
   * video inputs off before the take rather than mocking the failure.
   */
  if (flow === 'roughsize') {
    chipsBefore = await evaluate(
      `[...document.querySelectorAll('.chips .chip')].map(b=>b.title+':'+b.getAttribute('aria-pressed')).join(' ')`,
    )
    // ONE CLICK PER TASK. Two chip clicks in the same tick both read the same
    // prefs snapshot and the first one is lost — a human cannot produce that,
    // a synthetic driver does it every time.
    for (const label of ['Screen', 'Camera']) {
      await evaluate(
        `(() => { for (const b of document.querySelectorAll('.chips .chip')) {
            if (b.title === ${JSON.stringify(label)} && b.getAttribute('aria-pressed')==='true') b.click();
          } })()`,
      )
      await sleep(400)
    }
    chipsAfter = await evaluate(
      `[...document.querySelectorAll('.chips .chip')].map(b=>b.title+':'+b.getAttribute('aria-pressed')).join(' ')`,
    )
  }
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(takeMs)
  await evaluate(`document.querySelector('button[aria-label="Stop recording"]')?.click()`)
  await sleep(2500)
  let opened
  let text
  let cameraReport = null
  let filmReport = null
  if (flow === 'camera') {
    // F4: measure the PiP the way the export measures it — as FRACTIONS of the
    // stage — so the preview number and the exported-frame number are directly
    // comparable. Then drag it, reload, and see whether the work survived.
    const readPip = `(() => {
      const st = document.querySelector('.stage'); const p = document.querySelector('.pip');
      if (!st || !p) return null;
      const s = st.getBoundingClientRect(), r = p.getBoundingClientRect();
      const round = (n) => Math.round(n * 1e4) / 1e4;
      return {
        stageAspect: round(s.width / s.height),
        leftFrac: round((r.left - s.left) / s.width),
        topFrac: round((r.top - s.top) / s.height),
        widthFrac: round(r.width / s.width),
        heightFrac: round(r.height / s.height),
        centreXFrac: round((r.left + r.width / 2 - s.left) / s.width),
        centreYFrac: round((r.top + r.height / 2 - s.top) / s.height),
      };
    })()`
    const seekToEnd = `(() => { const sc=document.querySelector('.scrubber'); if(!sc) return false;
      const b=sc.getBoundingClientRect(); const x=b.left+b.width*0.92, y=b.top+b.height/2;
      sc.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
      sc.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
      return true })()`

    const beforeDrag = await evaluate(readPip)
    await evaluate(seekToEnd)
    await sleep(400)
    const dragged = await evaluate(`(() => {
      const p = document.querySelector('.pip'); if (!p) return null;
      const r = p.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
      const dx = -320, dy = -190;
      const opt = (x, y) => ({ clientX: x, clientY: y, bubbles: true, pointerId: 1, buttons: 1 });
      p.dispatchEvent(new PointerEvent('pointerdown', opt(x0, y0)));
      p.dispatchEvent(new PointerEvent('pointermove', opt(x0 + dx / 2, y0 + dy / 2)));
      p.dispatchEvent(new PointerEvent('pointermove', opt(x0 + dx, y0 + dy)));
      p.dispatchEvent(new PointerEvent('pointerup', opt(x0 + dx, y0 + dy)));
      return { dx, dy };
    })()`)
    await sleep(300)
    const afterDrag = await evaluate(readPip)
    // The debounced persist is 400 ms; give it room before pulling the rug.
    await sleep(1200)
    await evaluate(`location.reload()`)
    await sleep(6000)
    await evaluate(seekToEnd)
    await sleep(600)
    const afterReload = await evaluate(readPip)
    const drift =
      afterDrag && afterReload
        ? {
            centreXFrac: Math.round((afterReload.centreXFrac - afterDrag.centreXFrac) * 1e4) / 1e4,
            centreYFrac: Math.round((afterReload.centreYFrac - afterDrag.centreYFrac) * 1e4) / 1e4,
            widthFrac: Math.round((afterReload.widthFrac - afterDrag.widthFrac) * 1e4) / 1e4,
          }
        : null
    cameraReport = {
      flow,
      beforeDrag,
      dragged,
      afterDrag,
      afterReload,
      persistedAcrossReload:
        !!drift &&
        Math.abs(drift.centreXFrac) <= 0.005 &&
        Math.abs(drift.centreYFrac) <= 0.005 &&
        Math.abs(drift.widthFrac) <= 0.005,
      reloadDrift: drift,
      screenshot: out,
    }
  } else if (flow === 'zoom') {
    // F2: wheel on the stage, then check the PREVIEW scaled the composition by
    // exactly the factor the badge reports. The export side of the parity claim
    // is measured separately in `npm run exp -- f2`, against decoded frames.
    const readPip = `(() => {
      const st = document.querySelector('.stage'); const p = document.querySelector('.pip');
      if (!st || !p) return null;
      const s = st.getBoundingClientRect(), r = p.getBoundingClientRect();
      const round = (n) => Math.round(n * 1e4) / 1e4;
      return {
        leftFrac: round((r.left - s.left) / s.width),
        topFrac: round((r.top - s.top) / s.height),
        widthFrac: round(r.width / s.width),
        badge: document.querySelector('.stage__zoom-reset')?.textContent?.trim() ?? null,
        transform: getComputedStyle(document.querySelector('.stage__view')).transform,
      };
    })()`
    const before = await evaluate(readPip)
    opened = await evaluate(
      `(() => { const st=document.querySelector('.stage'); if(!st) return false;
        const b=st.getBoundingClientRect();
        st.dispatchEvent(new WheelEvent('wheel',{clientX:b.left+b.width*0.7,clientY:b.top+b.height*0.7,deltaY:-400,bubbles:true,cancelable:true}));
        return true })()`,
    )
    // The wheel commit is debounced at 180 ms; give it room plus a frame.
    await sleep(900)
    const after = await evaluate(readPip)
    const factor = after?.badge ? Number(after.badge.replace(/[^0-9.]/g, '')) : null
    const ratio = before && after && before.widthFrac > 0
      ? Math.round((after.widthFrac / before.widthFrac) * 100) / 100
      : null
    cameraReport = {
      flow,
      before,
      after,
      badgeFactor: factor,
      pipWidthRatio: ratio,
      // Under a pure scale about the viewport origin, every length in the
      // composition scales by the same factor the badge reports.
      matchesScale: !!factor && !!ratio && Math.abs(ratio - factor) <= 0.06,
      screenshot: out,
    }
  } else if (flow === 'zoomdrag') {
    // F2b: make a zoom with the wheel, then DRAG its marker along the timeline
    // and check the keyframe moved in time while the view itself did not.
    // Playhead into the middle FIRST: a zoom at t=0 has no room for its anchor,
    // so it writes a single keyframe and the group-drag has nothing to prove.
    await evaluate(
      `(() => { const r=document.querySelector('.tl__ruler'); if(!r) return false;
        const b=r.getBoundingClientRect(); const x=b.left+b.width*0.5,y=b.top+b.height/2;
        r.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
        r.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
        return true })()`,
    )
    await sleep(400)
    await evaluate(
      `(() => { const s=document.querySelector('.stage__surface')||document.querySelector('.stage');
        if(!s) return false; const b=s.getBoundingClientRect();
        s.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,clientX:b.left+b.width*0.4,clientY:b.top+b.height*0.5,bubbles:true,cancelable:true}));
        return true })()`,
    )
    await sleep(700)
    const dots = await evaluate(
      `JSON.stringify([...document.querySelectorAll('.tl__zoom-dot')].map(e=>e.getBoundingClientRect().left))`,
    )
    opened = await evaluate(
      `(() => { const d=[...document.querySelectorAll('.tl__zoom-dot')]; if(!d.length) return false;
        const el=d[d.length-1], b=el.getBoundingClientRect();
        const y=b.top+b.height/2, x0=b.left+b.width/2;
        // On the ELEMENT, not the window: startDrag listens there and relies on
        // pointer capture, which a synthetic pointer id does not get.
        el.dispatchEvent(new PointerEvent('pointerdown',{clientX:x0,clientY:y,bubbles:true,pointerId:7}));
        el.dispatchEvent(new PointerEvent('pointermove',{clientX:x0+120,clientY:y,bubbles:true,pointerId:7}));
        el.dispatchEvent(new PointerEvent('pointerup',{clientX:x0+120,clientY:y,bubbles:true,pointerId:7}));
        return true })()`,
    )
    await sleep(500)
    text = await evaluate(
      `JSON.stringify({
        before: ${JSON.stringify(dots)},
        after: [...document.querySelectorAll('.tl__zoom-dot')].map(e=>e.getBoundingClientRect().left),
        badge: document.querySelector('.stage__zoom')?.innerText ?? '',
      })`,
    )
  } else if (flow === 'frame') {
    // F3: pick a backdrop in the editor and measure where the PREVIEW puts the
    // screen surface, as fractions of the stage — directly comparable with the
    // numbers `npm run exp -- f3` reads out of decoded exported frames.
    const readSurface = `(() => {
      const st = document.querySelector('.stage');
      const v = document.querySelector('.stage__screen');
      if (!st || !v) return null;
      const s = st.getBoundingClientRect(), r = v.getBoundingClientRect();
      const round = (n) => Math.round(n * 1e4) / 1e4;
      return {
        leftFrac: round((r.left - s.left) / s.width),
        topFrac: round((r.top - s.top) / s.height),
        widthFrac: round(r.width / s.width),
        heightFrac: round(r.height / s.height),
        radiusPx: Math.round(parseFloat(getComputedStyle(v).borderTopLeftRadius) || 0),
        stageBackground: getComputedStyle(st).backgroundImage,
      };
    })()`
    const before = await evaluate(readSurface)
    opened = await evaluate(
      `(() => { const b=document.querySelector('button[aria-label="Slate"]'); if(!b) return false; b.click(); return true })()`,
    )
    await sleep(400)
    const afterPreset = await evaluate(readSurface)
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('.frame-bar__step')].find(x=>x.textContent==='L'); if(!b) return false; b.click(); return true })()`,
    )
    await sleep(400)
    const afterLarge = await evaluate(readSurface)
    cameraReport = {
      flow,
      before,
      afterPreset,
      afterLarge,
      // The medium step is padFrac 0.06 and the large one 0.1 — same numbers the
      // export compositor insets by.
      matchesGeometry:
        !!afterPreset &&
        Math.abs(afterPreset.leftFrac - 0.06) <= 0.004 &&
        Math.abs(afterPreset.widthFrac - 0.88) <= 0.008 &&
        !!afterLarge &&
        Math.abs(afterLarge.leftFrac - 0.1) <= 0.004 &&
        Math.abs(afterLarge.widthFrac - 0.8) <= 0.008,
      screenshot: out,
    }
  } else if (flow === 'tighten') {
    // F5a: press Tighten and see what comes back. The synthetic rig records a
    // CONSTANT tone, so the honest answer here is "nothing to tighten" — this
    // flow proves the control exists and that the refusal is visible, not that
    // detection works (that is `npm run exp -- f5a`, against a known map).
    opened = await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/tighten/i.test(x.textContent||'')); if(!b||b.disabled) return false; b.click(); return true })()`,
    )
    await sleep(4000)
    text = await evaluate(
      `JSON.stringify({ tools: document.querySelector('.tl__tools')?.innerText ?? 'NO TOOLS', toast: document.querySelector('.toasts')?.innerText ?? '', proposed: document.querySelectorAll('.tl__propose-span').length })`,
    )
  } else if (flow === 'speed') {
    // F5b: split the take so there is a middle clip, park the playhead in it,
    // then press 2x. The badge on the clip and the duration in the tools row
    // are the proof — a speed that only changed the button's colour would show
    // the same clip length.
    const clickRuler = (fx) =>
      evaluate(
        `(() => { const r=document.querySelector('.tl__ruler'); if(!r) return false;
          const b=r.getBoundingClientRect();
          const x=b.left+b.width*${fx},y=b.top+b.height/2;
          r.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
          r.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
          return true })()`,
      )
    const pressSplit = () =>
      evaluate(
        `(() => { const b=[...document.querySelectorAll('button')].find(x=>/split/i.test(x.textContent||'')); if(!b||b.disabled) return false; b.click(); return true })()`,
      )
    await clickRuler(0.3)
    await sleep(300)
    await pressSplit()
    await sleep(300)
    await clickRuler(0.7)
    await sleep(300)
    await pressSplit()
    await sleep(300)
    // Playhead into the MIDDLE clip, then 2x.
    await clickRuler(0.5)
    await sleep(300)
    const before = await evaluate(`document.querySelector('.transport__time')?.innerText ?? ''`)
    opened = await evaluate(
      `(() => { const b=[...document.querySelectorAll('.tl__speed-step')].find(x=>x.textContent==='2×'); if(!b||b.disabled) return false; b.click(); return true })()`,
    )
    await sleep(600)
    text = await evaluate(
      `JSON.stringify({
        before: ${JSON.stringify(before)},
        badges: [...document.querySelectorAll('.tl__seg-speed')].map(e=>e.textContent),
        selected: [...document.querySelectorAll('.tl__speed-step.is-on')].map(e=>e.textContent),
        tools: document.querySelector('.tl__tools')?.innerText ?? 'NO TOOLS',
        duration: document.querySelector('.transport__time')?.innerText ?? '',
      })`,
    )
  } else if (flow === 'scrub') {
    // F8: does a ONE-FRAME scrub actually repaint? usePlayback only re-seeks a
    // paused element past PAUSED_SEEK_MS of drift, and that used to be 40 ms
    // against a 33.3 ms frame — so a whole frame of scrub could leave the
    // picture where it was. Two ruler clicks one frame apart; the element's own
    // currentTime is the answer, and it is read from the PROD build.
    const readTimes = `(() => [...document.querySelectorAll('video')].filter(v=>v.src).map(v=>Math.round(v.currentTime*1000)))()`
    const clickRuler = (fx) =>
      `(() => { const r=document.querySelector('.tl__ruler'); if(!r) return false;
        const b=r.getBoundingClientRect(); const x=b.left+b.width*${fx}, y=b.top+b.height/2;
        r.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
        r.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
        return true })()`
    const clock = await evaluate(
      `(document.querySelector('.transport__time')?.innerText || '').replace(/\s+/g,' ')`,
    )
    const m = /(\d+):(\d\d)[^\d]*$/.exec(clock || '')
    // The rig knows how long it recorded; the clock is only a cross-check.
    const durMs = m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : takeMs
    const frameFrac = durMs > 0 ? 1000 / 30 / durMs : 0
    await evaluate(clickRuler(0.4))
    await sleep(700)
    const before = await evaluate(readTimes)
    await evaluate(clickRuler(0.4 + frameFrac))
    await sleep(200)
    await sleep(700)
    const after = await evaluate(readTimes)
    const moved = before.map((b, i) => after[i] - b)
    cameraReport = {
      flow: 'scrub',
      durMs,
      clock,
      frameMs: Math.round((1000 / 30) * 10) / 10,
      pxPerFrame: null,
      before,
      after,
      movedMs: moved,
      // The gate: a one-frame scrub must move every video element by about a
      // frame. Zero means the deadband ate it.
      allMoved: moved.length > 0 && moved.every((d) => Math.abs(d) >= 20),
    }
    text = JSON.stringify(cameraReport)
  } else if (flow === 'cuts') {
    // Seek to the middle of the take, split, then split again further along.
    await evaluate(
      `(() => { const r=document.querySelector('.tl__ruler'); if(!r) return false;
        const b=r.getBoundingClientRect();
        const click=(fx)=>{const x=b.left+b.width*fx,y=b.top+b.height/2;
          r.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
          r.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,pointerId:1}));};
        click(0.35); return true })()`,
    )
    await sleep(400)
    opened = await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/split/i.test(x.textContent||'')); if(!b||b.disabled) return false; b.click(); return true })()`,
    )
    await sleep(400)
    await evaluate(
      `(() => { const r=document.querySelector('.tl__ruler'); if(!r) return false;
        const b=r.getBoundingClientRect();
        const x=b.left+b.width*0.65,y=b.top+b.height/2;
        r.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
        r.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,bubbles:true,pointerId:1}));
        return true })()`,
    )
    await sleep(300)
    await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/split/i.test(x.textContent||'')); if(!b||b.disabled) return false; b.click(); return true })()`,
    )
    await sleep(300)
    // Delete the middle clip.
    await evaluate(
      `(() => { const d=[...document.querySelectorAll('.tl__seg-del')]; if(d.length<2) return false; d[1].click(); return true })()`,
    )
    await sleep(500)
    text = await evaluate(`document.querySelector('.tl__tools')?.innerText ?? 'NO TOOLS'`)
  } else if (flow === 'film') {
    /**
     * F8: does the timeline actually show the take's own frames, on the build a
     * user gets? The lane bar carries the strip as a background image, so this
     * asks the COMPUTED style rather than the React tree — a strip that failed
     * to decode leaves the bar exactly as it was, which is the fallback working
     * and must be distinguishable from the feature working.
     */
    // Strips land one channel at a time (one decoder at a time, on purpose), so
    // wait for the count to STOP changing rather than for the first one.
    let seen = -1
    let stable = 0
    for (let i = 0; i < 60; i++) {
      const n = await evaluate(`document.querySelectorAll('.lane--film').length`)
      if (n === seen && n > 0) stable++
      else stable = 0
      seen = n
      if (stable >= 4) break
      await sleep(250)
    }
    filmReport = await evaluate(
      `(() => {
        const lanes=[...document.querySelectorAll('.lane')];
        return lanes.map((l)=>{
          const bar=l.querySelector('.lane__bar');
          const bg=bar?getComputedStyle(bar).backgroundImage:'none';
          return {
            label: l.querySelector('.lane__label')?.textContent ?? '?',
            film: l.classList.contains('lane--film'),
            laneHeight: Math.round(l.getBoundingClientRect().height),
            barWidth: bar?Math.round(bar.getBoundingClientRect().width):0,
            hasStrip: !!bg && bg !== 'none',
          };
        });
      })()`,
    )
    opened = filmReport.some((l) => l.hasStrip)
    text = filmReport.map((l) => `${l.label}: ${l.hasStrip ? 'strip' : '—'} h${l.laneHeight}`).join(' · ')
  } else if (flow === 'roughsize') {
    opened = await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
    )
    // The probe fails fast here (no video channel), but "fast" is still an
    // await chain — give it room, then read what the panel settled on.
    await sleep(4000)
    text = await evaluate(
      `(() => { const q=document.querySelector('.quality'); if(!q) return 'NO QUALITY PANEL';
        return JSON.stringify({
          notice: q.querySelector('.quality__hint--rough')?.textContent?.trim() ?? null,
          stillMeasuring: !!q.querySelector('.quality__hint--measuring'),
          provisional: q.querySelectorAll('.quality__tier--provisional').length,
          text: q.innerText,
        }) })()`,
    )
  } else {
    opened = await evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(x=>/export/i.test(x.textContent||'')); if(!b) return false; b.click(); return true })()`,
    )
    await sleep(700)
    text = await evaluate(`document.querySelector('.quality')?.innerText ?? 'NO QUALITY PANEL'`)
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(
    JSON.stringify(
      cameraReport ?? {
        flow,
        actionOk: opened,
        panelText: text,
        screenshot: out,
        ...(filmReport
          ? { lanes: filmReport, filmstripLog: consoleLines.filter((l) => l.includes('filmstrip')) }
          : {}),
        ...(chipsBefore ? { chipsBefore, chipsAfter } : {}),
      },
      null,
      2,
    ),
  )
} finally {
  try { chrome?.kill('SIGKILL') } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  preview.kill('SIGTERM')
  await sleep(200)
  try { preview.kill('SIGKILL') } catch {}
  process.exit(0)
}
