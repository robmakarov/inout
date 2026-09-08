#!/usr/bin/env node
/**
 * J13's GATE, THE HALF THAT IS NOT CHROME — `node scripts/j13.mjs`.
 *
 * WHAT THIS PROVES, and why it is not "the same bytes as today". Today's render
 * RE-ENCODES a picture identical to the one before it, and encoding is lossy —
 * measured, the same source picture encoded twice comes out up to 3 levels
 * different from itself, and every frame after the first skip then differs by
 * up to 4 because the encoder's reference and rate control moved. So no
 * implementation of this idea can be byte-identical to today's file, and a gate
 * asking for that can never pass. Robert ruled it 2026-09-08, told exactly
 * that: "ship it — exactness is to the SOURCE".
 *
 * So the gate proves the three things that ARE true, outside Chrome, exactly:
 *   A  the file keeps its picture count, its rate and its length
 *   B  every copied picture decodes BIT-EXACTLY equal to the frame before it —
 *      counted, and the count must equal the number of pictures written
 *   C  no copied slot hid a real movement. The floor is MEASURED, not guessed:
 *      in today's own file a slot whose source is unchanged moves a median of
 *      4 and a worst of 48, while a genuinely new picture moves at least 193 —
 *      so the floor sits at 96, in the middle of a 145-level gap, and the run
 *      also proves the floor is not above everything the file contains.
 *
 * No PSNR anywhere: every comparison is exact bytes, and C reports a maximum
 * rather than an average so one moved pixel cannot hide in a mean.
 *
 *   node scripts/j13.mjs                    20 s of 720p at 30 fps → 60 fps out
 *   node scripts/j13.mjs --take=60 --rebuild
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(homedir(), 'Downloads', 'inout-j13')

const args = process.argv.slice(2)
const num = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.slice(name.length + 3)) : dflt
}
const expArgs = {
  takeSec: num('take', 20),
  sourceFps: num('sourcefps', 30),
  outputFps: num('outputfps', 60),
  sourceW: num('w', 1280),
  sourceH: num('h', 720),
  rebuild: args.includes('--rebuild'),
}

console.log(`j13: rendering the same take twice (${JSON.stringify(expArgs)})`)
const raw = execFileSync(
  process.execPath,
  [join(ROOT, 'scripts/exp.mjs'), 'sameaslast', JSON.stringify(expArgs), '--timeout=1800'],
  { cwd: ROOT, maxBuffer: 512 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)
const parsed = JSON.parse(raw.slice(raw.indexOf('{')))
const r = parsed.result ?? parsed

mkdirSync(OUT, { recursive: true })
const files = {}
for (const [name, b64] of Object.entries(r.files ?? {})) {
  const file = join(OUT, name === 'off' ? 'A-OFF-todays-render.mp4' : 'B-ON-same-as-last.mp4')
  writeFileSync(file, Buffer.from(b64, 'base64'))
  files[name] = file
}
delete r.files

for (const line of r.verdict ?? []) console.log(`  ${line}`)
console.log(`\nlanes:`)
for (const l of r.lanes ?? []) {
  console.log(
    `  ${l.name.padEnd(28)} ${String(l.ms).padStart(6)} ms · ${String(l.bytes).padStart(9)} bytes · ` +
      `${l.frames} frames` +
      (l.written === undefined ? '' : ` · ${l.written} written of ${l.slots} slots`),
  )
}

/* ── the half that is not Chrome ─────────────────────────────────────────── */

/** Decode one file to raw RGB and walk it a frame at a time, holding two. */
function eachFrame(file, w, h, visit) {
  return new Promise((resolve, reject) => {
    const size = w * h * 3
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    let held = Buffer.alloc(0)
    let prev = null
    let n = 0
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.stdout.on('data', (d) => {
      held = held.length ? Buffer.concat([held, d]) : d
      while (held.length >= size) {
        const frame = held.subarray(0, size)
        visit(n, frame, prev)
        prev = Buffer.from(frame)
        held = held.subarray(size)
        n++
      }
    })
    ff.on('close', (code) => (code === 0 ? resolve({ frames: n, err }) : reject(new Error(err || `ffmpeg ${code}`))))
    ff.on('error', reject)
  })
}

let outside = { ran: false, pass: false, note: 'ffmpeg not found — the outside-Chrome gates did not run' }
if (files.off && files.on) {
  const have = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  if (have.status === 0) {
    const probe = (file) =>
      JSON.parse(
        spawnSync(
          'ffprobe',
          ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,codec_name,avg_frame_rate,duration,width,height', '-of', 'json', file],
          { encoding: 'utf8' },
        ).stdout || '{}',
      ).streams?.[0] ?? {}
    const fa = probe(files.off)
    const fb = probe(files.on)
    console.log(
      `\nffprobe (outside Chrome): off ${fa.nb_read_frames} frames ${fa.codec_name} ${fa.avg_frame_rate} ${fa.duration}s · ` +
        `on ${fb.nb_read_frames} frames ${fb.codec_name} ${fb.avg_frame_rate} ${fb.duration}s`,
    )

    const shapeSame =
      fa.nb_read_frames === fb.nb_read_frames &&
      fa.avg_frame_rate === fb.avg_frame_rate &&
      fa.duration === fb.duration &&
      fa.width === fb.width &&
      fa.height === fb.height
    console.log(
      `\nGATE A — ${shapeSame ? 'PASS' : 'FAIL'}: the file keeps its picture count, rate and length` +
        (shapeSame ? '' : ` (off ${fa.nb_read_frames}/${fa.avg_frame_rate}/${fa.duration} vs on ${fb.nb_read_frames}/${fb.avg_frame_rate}/${fb.duration})`),
    )

    // B — which frames of the ON file are EXACT copies of the frame before them.
    const copied = new Set()
    await eachFrame(files.on, fb.width, fb.height, (n, frame, prev) => {
      if (prev && frame.equals(prev)) copied.add(n)
    })
    const written = r.lanes?.find((l) => l.written !== undefined)?.written ?? null
    const countMatches = written !== null && copied.size === written
    console.log(
      `\nGATE B — ${countMatches ? 'PASS' : 'FAIL'}: ${copied.size} pictures decode bit-exactly equal to the frame ` +
        `before them, against ${written} written by the render`,
    )

    // C — NO COPIED SLOT HID A MOVEMENT, and it is a GATE again.
    //
    // It was demoted to a measurement on the reasoning that a floor here would
    // gate the OLD render's noise and fail the control rather than the change.
    // The measurement answers that: in today's own file the two populations are
    // cleanly separated, and nothing lands between them.
    //
    //   slots whose source picture is identical   median 4, worst 48
    //   slots that are a genuinely new picture    min 193, median 202
    //
    // So a floor at 96 — the middle of a 145-level gap — cannot be tripped by
    // the old render's noise (worst 48) and cannot be survived by a real
    // picture change (min 193). What it tests is the ENGINE's own claim: that
    // every slot it copied was a slot whose source did not change. That claim
    // is currently held "by construction", which is the one thing a gate exists
    // to stop anybody saying — a provenance bug that marked a moving slot would
    // still copy it bit-exactly, so GATE B would pass and only this can fail.
    //
    // And it proves it can fail, in the same run: if no UNcopied slot clears the
    // floor, the floor is above everything the file contains and the gate is
    // vacuous, which is itself a failure (note 17 — a gate that cannot fail is
    // not a gate).
    const FLOOR = 96
    let worst = 0
    let worstAt = -1
    let movedUncopied = 0
    let quietestReal = Infinity
    await eachFrame(files.off, fa.width, fa.height, (n, frame, prev) => {
      if (!prev) return
      let m = 0
      for (let i = 0; i < frame.length; i++) {
        const d = Math.abs(frame[i] - prev[i])
        if (d > m) m = d
      }
      if (copied.has(n)) {
        if (m > worst) {
          worst = m
          worstAt = n
        }
      } else {
        if (m >= FLOOR) movedUncopied++
        if (m < quietestReal) quietestReal = m
      }
    })
    const noMovementHidden = worst < FLOOR
    const discriminates = movedUncopied > 0
    const gateC = noMovementHidden && discriminates
    console.log(
      `\nGATE C — ${gateC ? 'PASS' : 'FAIL'}: no copied slot hid a movement. Worst copied slot moves ` +
        `${worst} levels (frame ${worstAt}) against a floor of ${FLOOR}` +
        (discriminates
          ? `; ${movedUncopied} uncopied slots clear that floor, so it is known to be able to fail`
          : `; NO uncopied slot clears the floor, so the floor is above everything in this file and the gate is vacuous`),
    )

    outside = {
      ran: true,
      pass: shapeSame && countMatches && gateC,
      shapeSame,
      copiedFrames: copied.size,
      written,
      worstMovementAtCopiedSlot: worst,
      worstAt,
      floor: FLOOR,
      uncopiedSlotsClearingFloor: movedUncopied,
      quietestUncopiedSlot: quietestReal === Infinity ? null : quietestReal,
      frames: { off: fa.nb_read_frames, on: fb.nb_read_frames },
      note: `A ${shapeSame} · B ${copied.size}/${written} · C worst ${worst} < ${FLOOR}, ${movedUncopied} uncopied slots above it`,
    }
  } else {
    console.log('\nffmpeg is not installed here; the outside-Chrome gates did not run')
  }
}

r.outsideChrome = outside
if (r.determinism) {
  console.log(
    `\ncontrol: today's render twice — ${r.determinism.identical ? 'IDENTICAL' : `differs at frame ${r.determinism.firstDifferentFrame}`}`,
  )
}
if (r.repeats) {
  console.log(
    `repeats: ${r.repeats.on} frames repeat their predecessor exactly with the engine ON, ${r.repeats.off} with it OFF (of ${r.repeats.frames})`,
  )
}
r.savedTo = files
const pass = outside.ran && outside.pass
r.pass = pass
const dump = join(ROOT, 'docs/qa/j13-same-as-last.json')
if (!existsSync(dirname(dump))) mkdirSync(dirname(dump), { recursive: true })
writeFileSync(dump, JSON.stringify(r, null, 2))
console.log(`\nfiles: ${files.off}\n       ${files.on}\nevidence: ${dump}`)
console.log(`\nJ13 ${pass ? 'PASS — every copied picture is exact, nothing moved, the file keeps its shape' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
