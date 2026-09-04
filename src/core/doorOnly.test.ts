/**
 * THE DOOR IS THE ONLY WAY IN — task M1's structural gate, and it is a TEST
 * rather than a paragraph because a paragraph is what this codebase already
 * had.
 *
 * Robert, 2026-09-02 (DECISIONS robert (17)): "a WRITTEN RULE is not structural
 * prevention — it decays". The audit that produced M1 found seven adaptive
 * systems and four of them could make a take worse in silence, in a codebase
 * whose every file already said that degradations must be reported.
 *
 * TWO LAYERS, because neither alone is enough:
 *
 *  1. THE TYPE. `DoorTicket` is branded with a module-private unique symbol, so
 *     a value of that type cannot be written outside core/door.ts. Every door
 *     wrapper takes one. A path that wants to narrow a track has to ask, and
 *     asking is what writes the line. That layer needs no test: it is the
 *     compiler, and it fails the build by itself.
 *
 *  2. THIS FILE, for what a type cannot see — a new fallback that reaches past
 *     the wrapper and calls the platform API directly. It scans the SHIPPED
 *     source for the primitives that can move one of the four dials, and every
 *     occurrence must be inside the door or on the allowlist below with a
 *     reason. A NEW ONE FAILS THE BUILD: `npm test` is red, scripts/build-gate.sh
 *     runs it on the exact pushed commit, and the push is refused.
 *
 * WHAT IT DOES NOT PROVE, said plainly so nobody reads more into a green run:
 * it proves nothing about a path that changes a dial some way this engine has
 * no primitive for today. It proves that the two calls which move a source or
 * an encoder in THIS product cannot be made without the door. The channel dial
 * (which channels run) has no single primitive — a channel can end a dozen
 * honest ways — so it is covered by routing every drop path through the door
 * and by the tests that assert each one appends, not by this scan.
 */
import { describe, expect, it } from 'vitest'

/**
 * THE SOURCE, READ THROUGH THE BUNDLER rather than through node:fs — this
 * project has no @types/node and `npm run typecheck` is one of the gates, so a
 * scan that needs them would fail the build it is here to protect.
 *
 * Everything that ships. `src/experimental` is deliberately excluded: it is the
 * rig tree, it never reaches a user, and a rig legitimately drives the engine
 * by hand (pressureLead.ts applies its own constraints because there is no
 * session in it).
 */
const SOURCE = import.meta.glob('/src/{core,app}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function hits(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {}
  for (const [path, src] of Object.entries(SOURCE)) {
    if (/\.test\.tsx?$/.test(path)) continue
    const n = src.match(pattern)?.length ?? 0
    if (n > 0) found[path.replace(/^\//, '')] = n
  }
  return found
}

describe('the door is the only way in', () => {
  /**
   * RATE AND RESOLUTION. `applyConstraints` is the single primitive underneath
   * every rate step, every pre-take budget and every cap in this engine: if a
   * live source's rate or size changes, this call did it.
   */
  it('nothing calls applyConstraints except the door', () => {
    expect(hits(/\.applyConstraints\s*\(/g)).toEqual({
      'src/core/door.ts': 1,
    })
  })

  /**
   * THE LEDGER HAS ONE WRITER. E2's elastic log is what the report card grades
   * the ORDER OF DEFENCE from; if anything but the door could append to it, a
   * shed could be written without a decision behind it — which is exactly the
   * bug M1 removed (liveCompositeV2 wrote `60 → 30 fps` at the VERDICT and max
   * then refused to step, so loaded max takes claimed a shed that never
   * happened).
   */
  it('nothing appends to the elastic ledger except the door', () => {
    expect(hits(/\bnoteElastic\s*\(/g)).toEqual({
      // the definition itself
      'src/core/elasticLog.ts': 1,
      // the mirror, on the outcome
      'src/core/door.ts': 1,
    })
  })

  /**
   * QUALITY. An encoder's configuration is what the take is written AT — codec,
   * geometry, bitrate, rate control. Configuring one is legitimate (every
   * channel opens an encoder) so this is a census with a reason per file rather
   * than a ban: a new `configure` moves a count, the count fails the build, and
   * whoever added it has to answer whether it changes a dial mid-take.
   *
   * These live in workers, where the door is a different module instance; a
   * worker-side decision reaches the take's ledger through `adoptDoorDecision`.
   */
  const CONFIGURE_ALLOWED: Record<string, { n: number; why: string }> = {
    'src/core/capture/encoderWarm.ts': {
      n: 2,
      why: 'H6 — the warm-up probe and the throughput meter. No take is running.',
    },
    'src/core/capture/rawVideo.worker.ts': {
      n: 2,
      why: 'the channel opens its encoder, and F13 reconfigures it when the first frame corrects the geometry. The rung it lands on is recorded through the door by measuredVideo.ts.',
    },
    'src/core/capture/compositor.worker.ts': {
      n: 3,
      why: 'the composite opens its video and audio encoders, and reconfigures the video one on a geometry change.',
    },
    'src/core/capture/compositorWGPU.ts': {
      n: 1,
      why: 'O4 — NOT AN ENCODER. This is GPUCanvasContext.configure, which tells WebGPU the pixel format of the canvas the painter draws into. It moves no rate, no resolution, no quality and no channel, so there is nothing for the door to hold; it is listed because the scan is textual and a silent exception would be the hole the door exists to close.',
    },
    'src/core/capture/measuredAudio.ts': {
      n: 1,
      why: 'A1 — the audio channel opens its opus encoder. AUDIO IS NEVER SACRIFICED, so nothing reconfigures it.',
    },
    'src/core/compose/smartCut.ts': {
      n: 1,
      why: 'export — the re-encode window opens an encoder matching the source avcC byte for byte.',
    },
    'src/core/compose/constantQuality.ts': {
      n: 2,
      why: 'export — quantizer mode, with the bitrate-mode configure as the fallback for a browser that refuses it.',
    },
  }

  it('every encoder configuration is one of the known ones', () => {
    const found = hits(/\.configure\s*\(/g)
    const expected = Object.fromEntries(
      Object.entries(CONFIGURE_ALLOWED).map(([file, { n }]) => [file, n]),
    )
    expect(found).toEqual(expected)
  })

  it('every allowlisted encoder configuration says why it is not a dial', () => {
    for (const [file, { why }] of Object.entries(CONFIGURE_ALLOWED)) {
      expect(why.length, file).toBeGreaterThan(30)
    }
  })
})
