#!/usr/bin/env node
/**
 * Generate the PWA icons from the same mark as the favicon — a white ring with
 * a red centre — with no image dependency: build the RGBA buffer and encode
 * PNG directly (zlib is built in). Deterministic, so re-running never churns
 * the build output.
 *
 * Usage: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'icons')
mkdirSync(OUT, { recursive: true })

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Anti-aliased coverage of a disc, by 4x4 supersampling. */
function discCoverage(px, py, cx, cy, r) {
  let hits = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const x = px + (sx + 0.5) / 4
      const y = py + (sy + 0.5) / 4
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) hits++
    }
  }
  return hits / 16
}

function render(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = size / 2
  // A maskable icon must survive an aggressive circular crop, so its art sits
  // inside the 80% safe zone; the plain icon can use the full canvas.
  const scale = maskable ? 0.62 : 0.82
  const ringOuter = (size / 2) * scale
  const ringInner = ringOuter * 0.82
  const dot = ringOuter * 0.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // Background: the app's near-black surface, opaque so maskable works.
      let r = 10
      let g = 10
      let b = 12
      const ring = discCoverage(x, y, c, c, ringOuter) - discCoverage(x, y, c, c, ringInner)
      const centre = discCoverage(x, y, c, c, dot)
      if (ring > 0) {
        r = r * (1 - ring) + 255 * ring
        g = g * (1 - ring) + 255 * ring
        b = b * (1 - ring) + 255 * ring
      }
      if (centre > 0) {
        r = r * (1 - centre) + 255 * centre
        g = g * (1 - centre) + 59 * centre
        b = b * (1 - centre) + 48 * centre
      }
      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = 255
    }
  }
  return png(size, size, rgba)
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]) {
  writeFileSync(join(OUT, name), render(size, maskable))
  console.log('wrote', join('public/icons', name))
}
