/**
 * O9(b) — KEEP EVERY COLOUR: the 4:4:4 rung, capability-gated.
 *
 * Robert 2026-08-29: "I WANT 100% COLORS". Everything else in this task turned
 * out to be a distraction and the measurement says so plainly (`exp o9draw`,
 * 2026-09-04, one still code page, 3024-wide source delivered at 1080p):
 *
 *   the DRAW keeps            99.8 % of the green      fringe 3.21
 *   through AVC 4:2:0         78.2 %                   fringe 9.13
 *   through AV1 4:4:4         98.9 %                   fringe 5.43
 *   at 1:1 with no minification anywhere: 4:2:0 77.8 %, 4:4:4 99.3 %, fringe
 *   8.60 → 3.61, for 296 KB against 268 KB — 1.10x the bytes.
 *
 * So the colour is not lost in the drawing and cannot be recovered there. It is
 * lost in ONE place: 4:2:0 stores one chroma sample per 2x2 pixels, and a
 * one-pixel-wide coloured glyph stroke shares its colour with the page. The
 * only lever that reaches it is a format that stores chroma per pixel.
 *
 * WHY IT IS OPT-IN AND STAYS OPT-IN. The file is BLIND-SHARED (codecs.ts): no
 * probe can ask a recipient what they can play, and AV1 4:4:4 has no hardware
 * decoder anywhere — it is dav1d on the CPU where it plays at all. The ceiling
 * ruling (DECISIONS robert (7)) says a capability that runs only on a strong
 * machine STILL SHIPS, capability-gated with today's rung underneath, and that
 * is exactly what this is: asked for, probed, and silently declined into the
 * shipped AVC rung on any machine or frame size that cannot encode it. It never
 * becomes the unknown-egress default (.ai/TASKS O9 gate).
 *
 * AND THE SWITCH IS NOT A CODEC. SIZE-CODEC: "codec is never a user word — the
 * destination decides". The row says what the user gets (all the colour, a
 * bigger file, a slower export, a file only some players open), never `av01`.
 *
 *   ?colour=all    this load only        ?colour=420 / absent   today's rung
 *   localStorage['inout.compose.fullcolour'] = '1'   (sticky)
 * A URL parameter wins, then storage, then the default (off).
 *
 * Read on the MAIN thread and forwarded (pipeline.ts → export.worker.ts): the
 * render worker has no `localStorage` and a `location` of its own script URL.
 */

import { passDoor } from '@core/door'

const STORAGE_KEY = 'inout.compose.fullcolour'

/**
 * AV1 PROFILE 1 IS THE 4:4:4 PROFILE, and the profile is the whole request —
 * `av1` alone gets profile 0, which is 4:2:0 and is what we already have. The
 * levels are tried in order so the rung is about CHROMA and not about a
 * constant: 08M is level 4.0 (up to 1080p), the rest reach 4K.
 */
const AV1_444_CODECS = [
  'av01.1.08M.08',
  'av01.1.09M.08',
  'av01.1.12M.08',
  'av01.1.13M.08',
] as const

function parse(v: string | null): boolean | null {
  if (v === 'all' || v === '444' || v === '1' || v === 'true') return true
  if (v === '420' || v === '0' || v === 'false' || v === 'off') return false
  return null
}

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  return parse(new URLSearchParams(location.search).get('colour'))
}

function fromStorage(): boolean | null {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export function fullColourEnabled(): boolean {
  return fromSearch() ?? fromStorage() ?? false
}

export function setFullColourEnabled(on: boolean | null): void {
  try {
    if (on === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/** The worker has neither location nor storage: it is TOLD. */
let override: boolean | null = null
export function setFullColourOverride(value: boolean | null): void {
  override = value
}
export function fullColourActive(): boolean {
  return override ?? fullColourEnabled()
}

/**
 * Can THIS machine encode 4:4:4 at THIS frame size? A real probe, never a table
 * — the same rule `hasHardwareVideoEncoder` follows in codecs.ts. Returns the
 * codec string to pin, or null, and null means the export takes today's rung
 * with nothing else changed.
 *
 * The string is PINNED into the encoder config afterwards: probing one profile
 * and encoding another is how constantQuality.ts first reported itself
 * unsupported on hardware that supports it.
 */
export async function fullColourCodec(
  width: number,
  height: number,
  bitrate: number,
): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null
  for (const codec of AV1_444_CODECS) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate,
        // There is no hardware AV1 4:4:4 encoder anywhere. Asking for software
        // outright keeps a machine from refusing the config on a preference it
        // could never satisfy.
        hardwareAcceleration: 'prefer-software',
      } as VideoEncoderConfig)
      if (support.supported === true) return codec
    } catch {
      /* try the next level */
    }
  }
  return null
}

/**
 * A rung asked for and NOT taken is a decision, and it goes through the door —
 * the rule codecDoor.test.ts pins for the ladder in codecs.ts. Without it "why
 * is this export 4:2:0 on a machine I was told could do 4:4:4" is unanswerable
 * after the fact, which is the exact failure that rule was written for.
 */
export function noteFullColourDeclined(
  why: string,
  measured: { width: number; height: number; bitrate: number },
): void {
  passDoor(
    {
      dial: 'quality',
      decidedBy: 'codec',
      action: 'shed',
      what: 'export colour rung 4:4:4 skipped',
      why,
      measured: { rung: 'av1-444-sw', ...measured },
    },
    () => undefined,
  )
}
