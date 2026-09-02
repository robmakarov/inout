/**
 * EXPERIMENTAL — WHY DOES THE EDITOR'S AUDIO STARVE ON A LONG TAKE, AND WHAT
 * MAKES IT STOP.
 *
 * Robert, 2026-09-02: "no waiting, we are trying to fix all waiting, not
 * tolerate it." The stall hold shipped that morning waits for a starved element
 * instead of correcting it audibly, and waiting is the wrong answer to the
 * wrong question. The right question is why an element that has been sitting on
 * a local file for minutes has nothing to play.
 *
 * B2 named the mechanism and half-fixed it: a channel blob reaches the element
 * as an OPFS-BACKED File, so the first pass over any region pays a disk read
 * and a cold decode however `preload` is set — which is why Robert heard
 * "noises almost completly stops IN SAME PLACES they were in begining", the
 * signature of a second pass being warm. The fix was to read the file into
 * memory, capped at 64 MB so a long take could not be pulled into the heap. An
 * opus channel is ~16 KB/s, so the cap is 68 minutes: exactly the takes that
 * stall most get no protection at all.
 *
 * There are three ways to make the first pass warm and they cost very different
 * things, so this measures all three against each other rather than picking:
 *
 *   cold    the OPFS file exactly as it is handed over today
 *   warmed  the same file, read end to end once and DISCARDED first — no heap
 *           held at all, on the theory that what is slow is the disk and the
 *           OS page cache is what fixes it
 *   memory  the whole file copied into an in-memory Blob (B2's fix, uncapped)
 *
 * WHAT IS MEASURED is the thing the user hears: seek to a region the element
 * has never touched, ask it to play, and time how long until it is actually
 * playing — plus every `waiting` and `stalled` event on the way. A lane whose
 * worst first-play is inside a frame is a lane where nothing ever has to wait.
 *
 * Each lane gets its OWN fixture file, and cold runs FIRST, because a page
 * cache warmed by one lane would answer for the next one.
 *
 *   node scripts/exp.mjs previewstarve '{"minutes":124}' --headed --timeout=3600
 */
import { buildAudioFile, existingFixture } from './nativeRender'
import { blobStore } from '@core/store'

export interface StarveProbe {
  /** Where in the file we jumped to, seconds. */
  atSec: number
  /** Seek asked → the element reports it is playing, ms. */
  toPlayingMs: number
  /** `waiting` events fired between the seek and playing. */
  waits: number
  /** `stalled` events fired between the seek and playing. */
  stalls: number
  /** readyState the moment before play() was called. */
  readyStateBefore: number
}

export interface StarveLane {
  lane: 'cold' | 'warmed' | 'memory'
  sizeMB: number
  /** What preparing the lane cost, ms — the price of the fix itself. */
  prepareMs: number
  /** Heap the lane is holding afterwards, MB, or null where unavailable. */
  heldMB: number | null
  probes: StarveProbe[]
  worstMs: number
  medianMs: number
  totalWaits: number
  error: string | null
}

export interface PreviewStarveReport {
  minutes: number
  lanes: StarveLane[]
  notes: string[]
  verdict: string
}

const MB = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

interface PerfMemory {
  usedJSHeapSize: number
}
function heapMB(): number | null {
  const mem = (performance as unknown as { memory?: PerfMemory }).memory
  return mem ? MB(mem.usedJSHeapSize) : null
}

/**
 * Read a file end to end and throw every byte away.
 *
 * The point is the SIDE EFFECT: the bytes pass through the OS page cache on
 * the way, so the media element's own later reads are served from memory the
 * process never has to hold. 4 MB at a time, because one 119 MB
 * `arrayBuffer()` is the very allocation this lane exists to avoid.
 */
async function warmThrough(blob: Blob, chunkBytes = 4 << 20): Promise<void> {
  for (let at = 0; at < blob.size; at += chunkBytes) {
    const slice = blob.slice(at, Math.min(blob.size, at + chunkBytes))
    // `arrayBuffer()` on a slice reads exactly that range; the result goes out
    // of scope immediately, so nothing accumulates.
    await slice.arrayBuffer()
  }
}

/** The whole file as an in-memory Blob — B2's fix with its cap removed. */
async function intoMemory(blob: Blob, type: string): Promise<Blob> {
  const bytes = await blob.arrayBuffer()
  return new Blob([bytes], { type })
}

/**
 * Jump into a region this element has never played and time how long until it
 * IS playing. That is the user's experience of a stall, and the only reading
 * that means anything here.
 */
async function probe(el: HTMLAudioElement, atSec: number): Promise<StarveProbe> {
  let waits = 0
  let stalls = 0
  const onWait = (): void => void waits++
  const onStall = (): void => void stalls++
  el.addEventListener('waiting', onWait)
  el.addEventListener('stalled', onStall)
  try {
    el.pause()
    const seeked = new Promise<void>((resolve) => el.addEventListener('seeked', () => resolve(), { once: true }))
    const t0 = performance.now()
    el.currentTime = atSec
    await seeked
    const readyStateBefore = el.readyState
    // `playing` is the honest signal: `play()` resolves when playback has been
    // ALLOWED, not when a sample has come out.
    const playing = new Promise<void>((resolve) => el.addEventListener('playing', () => resolve(), { once: true }))
    await el.play().catch(() => undefined)
    await Promise.race([
      playing,
      new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
    ])
    const toPlayingMs = Math.round(performance.now() - t0)
    el.pause()
    return { atSec: Math.round(atSec), toPlayingMs, waits, stalls, readyStateBefore }
  } finally {
    el.removeEventListener('waiting', onWait)
    el.removeEventListener('stalled', onStall)
  }
}

async function runLane(
  lane: StarveLane['lane'],
  key: string,
  seconds: number,
  positions: number[],
): Promise<StarveLane> {
  const out: StarveLane = {
    lane,
    sizeMB: 0,
    prepareMs: 0,
    heldMB: null,
    probes: [],
    worstMs: 0,
    medianMs: 0,
    totalWaits: 0,
    error: null,
  }
  let url = ''
  const el = document.createElement('audio')
  el.preload = 'auto'
  el.volume = 0
  el.style.cssText = 'position:fixed;left:-9999px'
  document.body.append(el)
  try {
    const stored = await blobStore.read(key)
    out.sizeMB = MB(stored.size)
    const heapBefore = heapMB()
    const t0 = performance.now()
    let source: Blob = stored
    if (lane === 'warmed') await warmThrough(stored)
    if (lane === 'memory') source = await intoMemory(stored, 'audio/webm;codecs=opus')
    out.prepareMs = Math.round(performance.now() - t0)
    const heapAfter = heapMB()
    out.heldMB = heapBefore !== null && heapAfter !== null ? Math.round((heapAfter - heapBefore) * 10) / 10 : null

    url = URL.createObjectURL(source)
    el.src = url
    await new Promise<void>((resolve, reject) => {
      el.addEventListener('loadedmetadata', () => resolve(), { once: true })
      el.addEventListener('error', () => reject(new Error('the element refused the source')), { once: true })
      setTimeout(() => reject(new Error('loadedmetadata never fired in 120 s')), 120_000)
    })
    for (const at of positions) {
      out.probes.push(await probe(el, Math.min(at, seconds - 2)))
    }
    const times = out.probes.map((p) => p.toPlayingMs).sort((a, b) => a - b)
    out.worstMs = times[times.length - 1] ?? 0
    out.medianMs = times[Math.floor(times.length / 2)] ?? 0
    out.totalWaits = out.probes.reduce((n, p) => n + p.waits + p.stalls, 0)
  } catch (err) {
    out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  } finally {
    el.pause()
    el.removeAttribute('src')
    el.load()
    el.remove()
    if (url) URL.revokeObjectURL(url)
  }
  return out
}

export async function runPreviewStarve(
  opts: { minutes?: number; probes?: number; rebuild?: boolean } = {},
): Promise<PreviewStarveReport> {
  const minutes = opts.minutes ?? 124
  const seconds = Math.round(minutes * 60)
  const probeCount = opts.probes ?? 8
  const notes: string[] = []

  // One fixture PER LANE: a page cache warmed by the cold lane would answer
  // for the warmed lane, and then both would be measuring the same thing.
  const lanes: StarveLane['lane'][] = ['cold', 'warmed', 'memory']
  const keys: Record<string, string> = {}
  for (const lane of lanes) {
    const key = `ps-v1-${seconds}s-${lane}`
    keys[lane] = key
    if (opts.rebuild || (await existingFixture(key)) === null) {
      await blobStore.remove(key).catch(() => undefined)
      const t0 = performance.now()
      const size = await buildAudioFile(key, seconds)
      notes.push(`built ${key}: ${MB(size)} MB in ${Math.round(performance.now() - t0)} ms`)
    }
  }

  // Spread across the file, never the same instant twice, and never the very
  // start — the start is the one region `preload` was always going to have.
  const positions: number[] = []
  for (let i = 1; i <= probeCount; i++) positions.push((seconds * i) / (probeCount + 1))

  const results: StarveLane[] = []
  for (const lane of lanes) {
    results.push(await runLane(lane, keys[lane]!, seconds, positions))
  }

  const by = (lane: string): StarveLane | undefined => results.find((r) => r.lane === lane)
  const cold = by('cold')
  const warmed = by('warmed')
  const memory = by('memory')
  const verdict =
    !cold || !warmed || !memory
      ? 'a lane did not run'
      : `worst first-play: cold ${cold.worstMs} ms · warmed-through ${warmed.worstMs} ms (prepare ${warmed.prepareMs} ms, holds ${warmed.heldMB} MB) · ` +
        `in-memory ${memory.worstMs} ms (prepare ${memory.prepareMs} ms, holds ${memory.heldMB} MB). ` +
        `Waits: ${cold.totalWaits} / ${warmed.totalWaits} / ${memory.totalWaits} over ${probeCount} jumps each.`

  return { minutes, lanes: results, notes, verdict }
}
