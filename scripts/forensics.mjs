/**
 * Packet-level forensics on a finished take. No decode, no ffmpeg.
 *
 * Reads what the container already knows — every encoded packet's timestamp,
 * duration and BYTE SIZE — and bins it per second. That is enough to separate
 * the three failure modes we keep confusing for each other:
 *
 *   - a FROZEN video source repeats one picture, so inter-frame packets
 *     collapse to near-nothing while the cadence stays nominal;
 *   - a STARVED video source stops delivering, so the cadence itself drops
 *     and the gaps between packet timestamps blow past the frame interval;
 *   - STARVED audio is silence-filled by the capture worklet, and Opus codes
 *     digital silence in a handful of bytes — so a "lag sounds" stretch reads
 *     as a run of tiny packets among normal ones, at exactly the second the
 *     user heard it.
 *
 * Usage: node scripts/forensics.mjs <file.mp4> [--csv]
 */

import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny'

const file = process.argv[2]
const asCsv = process.argv.includes('--csv')
if (!file) {
  console.error('usage: node scripts/forensics.mjs <file> [--csv]')
  process.exit(2)
}

const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS })

/** Collect every packet of a track into per-second bins. */
async function scan(track) {
  const sink = new EncodedPacketSink(track)
  const packets = []
  for await (const p of sink.packets()) {
    packets.push({ t: p.timestamp, d: p.duration, size: p.byteLength, key: p.type === 'key' })
  }
  const bins = new Map()
  let prevT = null
  let maxGap = 0
  let maxGapAt = 0
  for (const p of packets) {
    if (prevT !== null) {
      const gap = p.t - prevT
      if (gap > maxGap) {
        maxGap = gap
        maxGapAt = p.t
      }
    }
    prevT = p.t
    const s = Math.floor(p.t)
    let b = bins.get(s)
    if (!b) {
      b = { n: 0, bytes: 0, min: Infinity, max: 0, tiny: 0, keys: 0, gap: 0 }
      bins.set(s, b)
    }
    b.n++
    b.bytes += p.size
    b.min = Math.min(b.min, p.size)
    b.max = Math.max(b.max, p.size)
    if (p.key) b.keys++
  }
  // Second pass for per-bin max inter-packet gap.
  prevT = null
  for (const p of packets) {
    if (prevT !== null) {
      const b = bins.get(Math.floor(p.t))
      if (b) b.gap = Math.max(b.gap, p.t - prevT)
    }
    prevT = p.t
  }
  return { packets, bins, maxGap, maxGapAt }
}

const videoTrack = await input.getPrimaryVideoTrack()
const audioTrack = await input.getPrimaryAudioTrack()
const duration = await input.computeDuration()

console.log(`file      ${file}`)
console.log(`duration  ${duration.toFixed(3)}s`)
if (videoTrack) {
  console.log(
    `video     ${await videoTrack.getCodecParameterString()} ${videoTrack.displayWidth}x${videoTrack.displayHeight}`,
  )
}
if (audioTrack) {
  console.log(
    `audio     ${await audioTrack.getCodecParameterString()} ${audioTrack.sampleRate}Hz x${audioTrack.numberOfChannels}`,
  )
}

const v = videoTrack ? await scan(videoTrack) : null
const a = audioTrack ? await scan(audioTrack) : null

if (v) {
  const fps = v.packets.length / duration
  console.log(
    `\nVIDEO  ${v.packets.length} packets, ${fps.toFixed(2)} fps mean, largest inter-frame gap ${(v.maxGap * 1000).toFixed(0)}ms at t=${v.maxGapAt.toFixed(2)}s`,
  )
}
if (a) {
  const sizes = a.packets.map((p) => p.size)
  const med = sizes.slice().sort((x, y) => x - y)[Math.floor(sizes.length / 2)]
  // "Tiny" = under a quarter of the median packet. Opus silence lands ~3-10B
  // against a speech/music median in the hundreds, so the threshold is not
  // delicate; it is two orders of magnitude away from the decision boundary.
  const tinyCut = Math.max(12, med / 4)
  let tiny = 0
  for (const b of a.bins.values()) b.tiny = 0
  for (const p of a.packets) {
    if (p.size < tinyCut) {
      tiny++
      const b = a.bins.get(Math.floor(p.t))
      if (b) b.tiny++
    }
  }
  console.log(
    `AUDIO  ${a.packets.length} packets, median ${med}B, ${tiny} under ${tinyCut.toFixed(0)}B (${((100 * tiny) / a.packets.length).toFixed(1)}% — silence-coded), largest gap ${(a.maxGap * 1000).toFixed(0)}ms at t=${a.maxGapAt.toFixed(2)}s`,
  )
}

const secs = Math.ceil(duration)
const rows = []
for (let s = 0; s < secs; s++) {
  const vb = v?.bins.get(s)
  const ab = a?.bins.get(s)
  rows.push({
    s,
    vfps: vb?.n ?? 0,
    vkb: vb ? Math.round(vb.bytes / 1024) : 0,
    vgap: vb ? Math.round(vb.gap * 1000) : 0,
    apk: ab?.n ?? 0,
    ab: ab ? Math.round(ab.bytes / Math.max(1, ab.n)) : 0,
    asil: ab?.tiny ?? 0,
  })
}

if (asCsv) {
  console.log('\nsec,video_fps,video_kb,video_maxgap_ms,audio_packets,audio_mean_bytes,audio_silent')
  for (const r of rows) {
    console.log(`${r.s},${r.vfps},${r.vkb},${r.vgap},${r.apk},${r.ab},${r.asil}`)
  }
} else {
  console.log('\n  sec | vfps  vKB  gapms | apkt  aB/pk  silent | ')
  const vfpsNom = rows.length ? Math.max(...rows.map((r) => r.vfps)) : 0
  const apktNom = rows.length ? Math.max(...rows.map((r) => r.apk)) : 0
  for (const r of rows) {
    const flags = []
    if (vfpsNom && r.vfps < vfpsNom * 0.6) flags.push('VIDEO-SLOW')
    if (r.vgap > 400) flags.push('VIDEO-GAP')
    if (apktNom && r.asil > apktNom * 0.5) flags.push('AUDIO-SILENT')
    else if (r.asil > 0) flags.push('audio-gaps')
    const bar = '#'.repeat(Math.min(20, Math.round(r.ab / 20)))
    console.log(
      `${String(r.s).padStart(5)} |${String(r.vfps).padStart(5)}${String(r.vkb).padStart(5)}${String(r.vgap).padStart(7)} |` +
        `${String(r.apk).padStart(5)}${String(r.ab).padStart(7)}${String(r.asil).padStart(8)}  ${bar} ${flags.join(' ')}`,
    )
  }
}
