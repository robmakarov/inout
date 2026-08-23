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
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
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
  await sleep(2500)
  await evaluate(`document.querySelector('button[aria-label="Start recording"]').click()`)
  await sleep(takeMs)
  await evaluate(`document.querySelector('button[aria-label="Stop recording"]')?.click()`)
  await sleep(2500)
  let opened
  let text
  let cameraReport = null
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
    JSON.stringify(cameraReport ?? { flow, actionOk: opened, panelText: text, screenshot: out }, null, 2),
  )
} finally {
  try { chrome?.kill('SIGKILL') } catch {}
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  preview.kill('SIGTERM')
  await sleep(200)
  try { preview.kill('SIGKILL') } catch {}
  process.exit(0)
}
