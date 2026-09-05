/**
 * THE TAKE REPORT CARD — "perfect" as a VERDICT the take computes about itself
 * (task S1, 2026-09-01).
 *
 * The black box already records everything a verdict needs and nobody has ever
 * computed one. Robert's 50-minute max take (rec_78ogcw052vdn) lost 27 minutes
 * of tab audio and told him nothing: he found out by listening, and the numbers
 * that convicted it were read off the take by hand, in a session, days later.
 * That is the whole problem. A take that can grade itself turns his ordinary
 * daily recording into the soak fleet this product has never had — every take
 * readable by an agent off the machine with nothing asked of him (the
 * wedgeJournal precedent, DECISIONS 2026-08-30 (4)).
 *
 * THREE RULES THIS FILE IS WRITTEN UNDER:
 *
 *  1. NO SCORE FOR A MEASUREMENT NOT TAKEN (R1's ruling, generalised). A
 *     dimension with no evidence reads `unmeasured` and says WHY. It never
 *     silently passes, and a card carrying one is `incomplete`, not `green`.
 *  2. IT COSTS THE TAKE (ALMOST) NOTHING, AND THE EXCEPTION IS MEASURED.
 *     Everything here is computed from what is already persisted, at stop or
 *     later on demand. ONE dimension samples while the recorder runs —
 *     `lateness` (G7), because "how late did the main thread run" cannot be
 *     derived from anything the take already holds — and it is the exception
 *     that proves the rule: its clock is in a worker, the main thread does one
 *     subtraction per beat, it keeps a histogram rather than a list, and it
 *     carries its own measured cost on the card (`selfCostMsPerSec`) so this
 *     claim is a number and not a promise. Everything else still samples,
 *     polls and allocates nothing.
 *  3. IT MUST NOT CRY WOLF. The user-facing banner already learned this twice
 *     (app/lib/channels.ts) — a report that reads RED on a take that was fine
 *     is a report nobody looks at, and then a real loss goes unread. Every
 *     threshold below is a number with a reason, and every detail line quotes
 *     what it actually measured so a stricter gate (A1's `silentTailMs < 1 s`)
 *     can be read off a card that passed.
 *
 * Pure and framework-free: a Recording in, a card out. The evidence that lives
 * outside the take (the wedge journal) is passed IN, so this stays testable
 * without a browser.
 */
import { auditElastic } from '@core/elasticLog'
import { STALL_FAIL_MS } from '@core/lateness'
import { REVIVE_BASE_SEC, REVIVE_CEILING_SEC } from '@core/capture/reviveSchedule'
import { WARN_SECONDS_LEFT } from '@core/capture/diskGuard'
import type { ChannelKind, ChannelRecording, LatenessSummary, Recording } from '@core/types'

/** Every dimension the card grades. Order is the order they are reported in. */
export type DimensionId =
  | 'channels'
  | 'audio-continuity'
  | 'audio-clock'
  | 'rescue'
  | 'picture'
  | 'rate'
  | 'elastic'
  | 'decisions'
  | 'sync'
  | 'storage'
  | 'memory'
  | 'lateness'
  | 'wedges'

export type DimensionStatus = 'pass' | 'fail' | 'unmeasured'

export interface ReportDimension {
  id: DimensionId
  status: DimensionStatus
  /** What was measured and what it read — with the numbers, always, for every
   *  channel it looked at. */
  detail: string
  /** Set on a failure: the convicting part alone, for the one-line verdict.
   *  A headline that repeated the channels that passed would bury it. */
  headline?: string
  /** The channels a failure convicts. */
  kinds?: ChannelKind[]
}

/**
 * `green`  — every dimension measured and inside its band.
 * `red`    — at least one dimension failed. The line names it.
 * `incomplete` — nothing failed, but something could not be measured. NOT green:
 *                an unread dimension is not a passed one.
 */
export type Verdict = 'green' | 'red' | 'incomplete'

export interface ReportCard {
  recordingId: string
  /** Epoch ms the take stopped (Recording.createdAt). */
  createdAt: number
  /** The commit the tab's bundle came from, `dev`, or null on a take made
   *  before this was stamped. In the headline, because a field report about a
   *  long take is a report about the build the tab was LOADED with. */
  buildId: string | null
  durationMs: number
  verdict: Verdict
  /** ONE line: the verdict, the dimension that decides it, and its numbers. */
  line: string
  dimensions: ReportDimension[]
}

/** Evidence that lives outside the take. */
export interface ReportEvidence {
  /** wedgeJournal entries (any window) — the card picks the ones inside the take. */
  wedgeJournal?: readonly { t: number; kind: string }[]
}

/* ─────────────────────────── the bands ─────────────────────────── */

/**
 * A CHANNEL IS "FULL LENGTH" WITHIN THIS. Channels stop on their own clocks and
 * a second of difference at the seam is the drain budget, not a loss.
 */
export const SHORT_CHANNEL_MS = 1_500
export const SHORT_CHANNEL_RATIO = 0.01

/**
 * A SILENT TAIL FAILS WHEN IT IS BOTH LONG AND A REAL SHARE OF THE CHANNEL.
 *
 * `silentTailMs` counts PURE DIGITAL silence, so a tab with nothing playing
 * reads it honestly and a person reaching for the stop button after their video
 * ended is not a defect (app/lib/channels.ts, twice). Stricter than the user
 * banner's 10 s + 10 % because this is an engineering verdict and not a notice:
 * the same 5 % that reads 6 s on a 2-minute take reads 27 minutes on Robert's
 * 50-minute one. The DETAIL always quotes the raw ms, so A1's own
 * `silentTailMs < 1 s` gate is readable from a card that passed.
 */
export const SILENT_TAIL_FAIL_MS = 10_000
export const SILENT_TAIL_FAIL_RATIO = 0.05

/**
 * INSERTED SILENCE IS THE WALL-CLOCK HOLD WORKING until it is a whole percent
 * of the take. rec_78ogcw052vdn padded 5,647 ms across 3,026 s (0.19 %) while
 * losing 27 minutes of sound — which is exactly why the clock and the input are
 * graded apart. Same band for `trimmedMs`: a fast clock is the same fault
 * mirrored (278 ppm ≈ 0.03 %).
 */
export const CLOCK_FAIL_RATIO = 0.01

/**
 * REVIVE BURSTS AFTER THIS ARE THE FAULT; before it they are the arm settling.
 * A tap that needs rebuilding once as the take starts is the source not yet
 * playing (a screen share of a paused video is digital silence). One that needs
 * rebuilding at minute 23 is A1.
 */
export const WARMUP_MS = 60_000

/** Heap at stop against the engine's own limit. */
export const HEAP_FAIL_RATIO = 0.7

/* ────────────────────────── revive bursts ────────────────────────── */

export interface ReviveBurst {
  /** Where the silent run this burst belongs to began, ms from the epoch. */
  runStartMs: number
  /** First and last attempt of the burst, ms from the epoch. */
  firstMs: number
  lastMs: number
  attempts: number
}

/**
 * THE ATTEMPTS ARE A FLAT LIST; THE STORY IS IN THE RUNS.
 *
 * "25 attempts" says nothing. "Six separate deaths, one of which the ladder
 * gave up on 105 s before sound came back" convicts the ladder — and it is the
 * shape reviveSchedule.ts was rewritten from. So the attempts are regrouped
 * into the silent runs that produced them, using the schedule's own arithmetic:
 * within a run the attempt sits at 5, 10, 20, 40, 80, … seconds of continuous
 * silence, so THE GAP TO THE NEXT ATTEMPT EQUALS THE AGE OF THE RUN — capped at
 * REVIVE_CEILING_SEC once the run has climbed past it. A gap that is neither is
 * a different run.
 *
 * What this cannot separate: a new run whose first attempt happens to land one
 * ceiling-length after the previous run's last, on a run already at the
 * ceiling. The black box holds nothing that could — sound coming back is not an
 * event, it is the absence of one — and merging two such runs understates the
 * count rather than inventing one, which is the safe direction for a verdict.
 */
export function reviveBursts(
  events: readonly { atMs: number; type: string }[] | undefined,
): ReviveBurst[] {
  const attempts = (events ?? [])
    .filter((e) => e.type === 'revive' || e.type === 'revive-failed')
    .map((e) => e.atMs)
    .sort((a, b) => a - b)
  const base = REVIVE_BASE_SEC * 1000
  const ceiling = REVIVE_CEILING_SEC * 1000
  const out: ReviveBurst[] = []
  for (const t of attempts) {
    const cur = out[out.length - 1]
    if (cur) {
      const gap = t - cur.lastMs
      const runAge = cur.lastMs - cur.runStartMs
      const expected = [runAge]
      // The capped cadence is only on the table once the run has actually
      // climbed to it — otherwise a fresh run starting a minute later reads as
      // a continuation of a one-attempt run.
      if (runAge >= ceiling) expected.push(ceiling)
      if (expected.some((e) => Math.abs(gap - e) <= Math.max(2_000, e * 0.25))) {
        cur.lastMs = t
        cur.attempts++
        continue
      }
    }
    out.push({ runStartMs: Math.max(0, t - base), firstMs: t, lastMs: t, attempts: 1 })
  }
  return out
}

/* ─────────────────────────── the card ─────────────────────────── */

const LABEL: Record<ChannelKind, string> = {
  screen: 'screen',
  camera: 'camera',
  mic: 'mic',
  'system-audio': 'tab audio',
}

/** Take-scale time, in the unit a person says it in. */
const dur = (ms: number): string =>
  ms >= 90_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)}s`
/** Seconds to one decimal — how reviveSchedule.ts quotes a run, so the two
 *  documents can be read against each other. */
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`
const mb = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`
const list = (xs: string[]): string => xs.join(' · ')

function channelEnd(c: ChannelRecording): number {
  return c.startOffsetMs + c.durationMs
}

/**
 * DID ANYTHING ACTUALLY COUNT THIS CHANNEL'S SILENCE?
 *
 * `diagnostics` alone does not answer it: session.ts stamps a B7 anchor on
 * EVERY channel, including the MediaRecorder audio lane (Apple WebKit), which
 * counts no silence at all — and both lanes can write the same
 * `audio/webm;codecs=opus`, so the container cannot answer it either. The
 * measured path writes its counters even when they are zero (measuredAudio.ts,
 * S1) precisely so this question has an answer. A take recorded before that
 * whose channel was perfectly clean reads `unmeasured`, which is the truth
 * about it: nothing on it distinguishes silence counted at nought from silence
 * never counted.
 */
const silenceMeasured = (c: ChannelRecording): boolean => {
  const d = c.diagnostics
  return (
    d?.silentTailMs !== undefined ||
    d?.paddedMs !== undefined ||
    d?.trimmedMs !== undefined ||
    d?.revivals !== undefined ||
    (d?.events?.length ?? 0) > 0
  )
}

export function buildReportCard(recording: Recording, evidence: ReportEvidence = {}): ReportCard {
  const dims: ReportDimension[] = []
  const take = recording.durationMs
  const audio = recording.channels.filter((c) => c.media === 'audio')
  const video = recording.channels.filter((c) => c.media === 'video')

  /* 1. CHANNELS — what was asked for, what arrived, and did it last. */
  {
    const missing = recording.missing ?? []
    const shortfall = Math.max(SHORT_CHANNEL_MS, take * SHORT_CHANNEL_RATIO)
    /**
     * H1 — SHORTFALL IS A QUESTION ABOUT A KIND, NOT ABOUT A FILE.
     *
     * A kind has been allowed to be several non-overlapping segments since
     * 08-23 (pause/resume, O16's resolution step, and now a contained encoder
     * death), and this line used to grade every one of them separately: the
     * first segment of a screen that ran the whole take ended "23 s before the
     * take did" and the card said so, about a channel with no gap in it. Judge
     * the kind by its LAST segment, which is the one that answers "did this
     * input last".
     */
    const lastEndByKind = new Map<ChannelKind, ChannelRecording>()
    for (const c of recording.channels) {
      const prev = lastEndByKind.get(c.kind)
      if (!prev || channelEnd(c) > channelEnd(prev)) lastEndByKind.set(c.kind, c)
    }
    const shortAll = [...lastEndByKind.values()].filter((c) => take - channelEnd(c) > shortfall)
    /**
     * H4 — THE LOSS LEDGER CONVICTS HERE.
     *
     * Measured on prod 2026-09-01, before this line existed: a take whose
     * camera delivered nothing for 45 s read `GREEN — 10 of 10 dimensions
     * measured and inside band`. It was not missing (the file exists, 28 bytes
     * of container) and it was not short (a dead source still stamps a full
     * duration), so every dimension above passed it honestly and the verdict
     * was still wrong. Folded into THIS dimension rather than added as a new
     * one: it is the same question these lines already ask.
     */
    const lost = recording.lost ?? []
    // A kind in BOTH says it once, in the more specific words: "never delivered
    // a byte" is true of a camera whose lid is shut and does not describe it.
    // Same for the shortfall rule — "camera ended 23.6s before the take did"
    // and "camera died at 14.9s and the take ran 23.6s without it" are the same
    // fact, and the second one is the one that says WHY.
    const missingOnly = missing.filter((k) => !lost.some((l) => l.kind === k))
    const short = shortAll.filter((c) => !lost.some((l) => l.kind === c.kind))
    /**
     * H1 — A CONTAINED COMPONENT DEATH IS NOT A CLEAN TAKE.
     *
     * The kind ran the whole length and every consumer composes its segments
     * as one lane, so nothing else on this card can see the hole. It is tens of
     * milliseconds and the alternative was losing the rest of the channel — but
     * it IS missing material, and a report card that grades it green is the
     * same failure H4 found: ten of ten dimensions on a take that recorded
     * nothing from its camera.
     */
    const seams = recording.seams ?? []
    const kinds = [
      ...missingOnly,
      ...short.map((c) => c.kind),
      ...lost.map((l) => l.kind),
      ...seams.map((sm) => sm.kind).filter((k) => !lost.some((l) => l.kind === k)),
    ]
    if (kinds.length) {
      dims.push({
        id: 'channels',
        status: 'fail',
        kinds,
        detail: list([
          ...missingOnly.map((k) => `${LABEL[k]} was requested and never delivered a byte`),
          ...short.map(
            (c) =>
              `${LABEL[c.kind]} ended ${dur(take - channelEnd(c))} before the take did ` +
              `(${dur(c.durationMs)} of ${dur(take)})`,
          ),
          ...lost.map((l) =>
            l.reason === 'never-delivered'
              ? `${LABEL[l.kind]} stayed connected for the whole take and delivered no frames`
              : `${LABEL[l.kind]} died at ${dur(l.atMs)} and the take ran ${dur(l.lostMs)} without it`,
          ),
          ...seams.map(
            (sm) =>
              `${LABEL[sm.kind]} survived a ${sm.cause} at ${dur(sm.atMs)} — ` +
              `${sm.gapMs} ms missing there, the rest of the take recorded`,
          ),
        ]),
      })
    } else {
      dims.push({
        id: 'channels',
        status: 'pass',
        detail:
          `${recording.channels.length} channels, all full length ` +
          `(${recording.channels.map((c) => LABEL[c.kind]).join(', ')} over ${dur(take)})`,
      })
    }
  }

  /* 2. AUDIO CONTINUITY — did every audio channel carry sound to the end. */
  {
    const measured = audio.filter(silenceMeasured)
    if (!audio.length) {
      dims.push({ id: 'audio-continuity', status: 'pass', detail: 'no audio channels in this take' })
    } else if (!measured.length) {
      dims.push({
        id: 'audio-continuity',
        status: 'unmeasured',
        detail:
          'no audio channel carries silence counters — the MediaRecorder audio path (Apple ' +
          'WebKit) counts none, and a take recorded before they were always written cannot ' +
          'tell a clean channel from an uncounted one',
      })
    } else {
      const bad: ChannelKind[] = []
      /** What convicts, without the channels that were fine. */
      const lost: string[] = []
      const notes: string[] = []
      for (const c of measured) {
        const tail = c.diagnostics?.silentTailMs ?? 0
        const share = c.durationMs > 0 ? tail / c.durationMs : 0
        const muted = (c.diagnostics?.events ?? []).some((e) => e.type === 'mute')
        const from = Math.max(0, c.durationMs - tail)
        /**
         * SILENCE IN THE MIDDLE COUNTS TOO — and until 2026-09-05 it did not.
         *
         * This dimension read the open silent RUN, so a channel whose zeros
         * were interrupted once — by a revive that delivered a single batch,
         * by a moment of noise — reported a tail of a second or two however
         * much of the take was silent. Robert's 71.7-minute take
         * (`rec_yx4mi1or851p`) lost its tab audio at 52.5 min, never got it
         * back, carried `silentTailMs` of 1840 ms, and this dimension graded it
         * PASS at "0.0%". A gate that cannot catch the case it was written for
         * is not a gate.
         *
         * `silentTotalMs` is every zero after the channel was first HEARD, so
         * silence before any sound (a channel that never arrived, which is
         * `Recording.missing`'s subject) still convicts nobody. Absent on takes
         * made before the counter existed, where this reads the tail exactly as
         * it used to.
         */
        const total = Math.max(tail, c.diagnostics?.silentTotalMs ?? 0)
        const totalShare = c.durationMs > 0 ? total / c.durationMs : 0
        const scattered = total > tail + SILENT_TAIL_FAIL_MS
        if (total >= SILENT_TAIL_FAIL_MS && totalShare >= SILENT_TAIL_FAIL_RATIO) {
          bad.push(c.kind)
          lost.push(
            scattered
              ? `${LABEL[c.kind]} was digital zeros for ${dur(total)} of ${dur(c.durationMs)} ` +
                `(${pct(totalShare)}) — spread through the take, not only at the end ` +
                `(its unbroken tail was just ${dur(tail)})` +
                (muted ? ', and the source muted itself' : '')
              : `${LABEL[c.kind]} went to digital zeros ${dur(from)} in and never came back — ` +
                `${dur(total)} of ${dur(c.durationMs)} (${pct(totalShare)})` +
                (muted ? ', and the source muted itself' : ''),
          )
          notes.push(lost[lost.length - 1])
        } else {
          notes.push(
            `${LABEL[c.kind]} silent tail ${Math.round(tail)}ms (${pct(share)})` +
              (scattered ? `, ${dur(total)} silent in total` : ''),
          )
        }
      }
      /**
       * B15 — NAME THE AUDIO PATH BESIDE THE VERDICT.
       *
       * A display-audio death reads identically whichever path produced it, and
       * they are not the same source: Chrome's tab audio is a per-renderer mix
       * (label "Tab audio", 10 ms reported latency); a monitor share's audio on
       * macOS is the machine's own loopback (20 ms on the take that named this
       * task). Every negative lab cell ever run captured a TAB and all three
       * field deaths were whole-MONITOR shares — a fact nobody could read off a
       * take, because no take said it. Absent on takes made before this field.
       */
      const s = recording.capturedSurface
      if (s && measured.some((c) => c.kind === 'system-audio')) {
        notes.push(
          `display audio came from a ${s.kind ?? 'unknown'} share` +
            (s.audioLabel ? ` as "${s.audioLabel}"` : ''),
        )
      }
      dims.push({
        id: 'audio-continuity',
        status: bad.length ? 'fail' : 'pass',
        ...(bad.length ? { kinds: bad, headline: list(lost) } : null),
        detail: list(notes),
      })
    }
  }

  /* 3. AUDIO CLOCK — how much silence the wall-clock hold had to insert or cut. */
  {
    const measured = audio.filter(silenceMeasured)
    if (!measured.length) {
      dims.push({
        id: 'audio-clock',
        status: audio.length ? 'unmeasured' : 'pass',
        detail: audio.length
          ? 'no audio channel carries a padded/trimmed count (MediaRecorder audio path, or a ' +
            'take older than the counters)'
          : 'no audio channels in this take',
      })
    } else {
      const bad: ChannelKind[] = []
      const convicting: string[] = []
      const notes: string[] = []
      for (const c of measured) {
        const padded = c.diagnostics?.paddedMs ?? 0
        const trimmed = c.diagnostics?.trimmedMs ?? 0
        const worst = Math.max(padded, trimmed) / Math.max(1, c.durationMs)
        const note =
          `${LABEL[c.kind]} held ${Math.round(padded)}ms / cut ${Math.round(trimmed)}ms across ` +
          `${dur(c.durationMs)} (${pct(worst)})`
        notes.push(note)
        if (worst >= CLOCK_FAIL_RATIO) {
          bad.push(c.kind)
          convicting.push(note)
        }
      }
      dims.push({
        id: 'audio-clock',
        status: bad.length ? 'fail' : 'pass',
        ...(bad.length ? { kinds: bad, headline: list(convicting) } : null),
        detail: list(notes),
      })
    }
  }

  /* 4. RESCUE — WHAT THE DEAD TAP COST, NOT HOW OFTEN WE TRIED (task G6(g)).

        THIS DIMENSION WAS UNPASSABLE, and it is worth saying exactly how. It
        graded revive ATTEMPTS: any burst after the warm-up was a fail. But a
        revive fires after seconds of pure digital zeros on a track that is live
        and unmuted, and from inside the tap a paused tab and a dead tap look
        identical — so a quiet source produced attempts, attempts produced red,
        and every honest long take was convicted. Measured on rec_gpsoujs2sydf:
        63 attempts across 15 silent runs graded RED when every single run was a
        quiet tab (Robert confirmed the silence was real). It made A1's gate 2
        unreadable for a day.

        The evidence that separates the two cases is `revive-recovered`, which
        capture now records (measuredAudio.ts): sound returning within a second
        of a tap rebuild is THAT rebuild's doing — the source had been playing
        all along and the zeros before it are audio the take LOST. Sound that
        returns later is a source that started playing, and a rebuild into a
        source that stays quiet cost nothing.

        So: convict on recovered loss. A permanently dead tap is not lost here —
        `audio-continuity` above already owns it through `silentTailMs`, which
        is the same fault measured as what it cost rather than as how hard we
        fought it. */
  {
    const measured = audio.filter(silenceMeasured)
    if (!measured.length) {
      dims.push({
        id: 'rescue',
        status: audio.length ? 'unmeasured' : 'pass',
        detail: audio.length
          ? 'no audio channel carries a revival count (MediaRecorder audio path, or a take ' +
            'older than the counters)'
          : 'no audio channels in this take',
      })
    } else {
      const bad: ChannelKind[] = []
      const convicting: string[] = []
      const notes: string[] = []
      for (const c of measured) {
        const events = c.diagnostics?.events ?? []
        const bursts = reviveBursts(events)
        if (!bursts.length) continue
        const attempts = bursts.reduce((n, b) => n + b.attempts, 0)
        // A rebuild that brought the sound back: the tap was dead while the
        // source played, so the silent run before it is real lost audio.
        const recovered = events.filter((e) => e.type === 'revive-recovered')
        const late = recovered.filter((e) => e.atMs > WARMUP_MS)
        if (late.length) {
          bad.push(c.kind)
          // What it COST: each recovery ends a silent run, and the run is the
          // loss. Bound it by the burst that preceded the recovery.
          const lost = late.map((e) => {
            const burst = [...bursts].reverse().find((b) => b.firstMs <= e.atMs)
            const from = burst ? burst.runStartMs : e.atMs
            return `${dur(Math.max(0, e.atMs - from))} from ${secs(from)}`
          })
          convicting.push(
            `${LABEL[c.kind]} lost ${lost.join(' and ')} — the tap was dead while the source ` +
              `was playing, and a rebuild is what brought the sound back`,
          )
        }
        notes.push(
          `${LABEL[c.kind]} ${bursts.length} revive burst${bursts.length === 1 ? '' : 's'} ` +
            `(${attempts} attempts), ${recovered.length} recovered sound — ` +
            `runs began ${bursts.map((b) => secs(b.runStartMs)).join(', ')}` +
            (recovered.length === 0
              ? '; nothing was recovered, so the source itself was silent and no audio was lost'
              : ''),
        )
      }
      dims.push({
        id: 'rescue',
        status: bad.length ? 'fail' : 'pass',
        ...(bad.length ? { kinds: bad, headline: list(convicting) } : null),
        detail: notes.length ? list(notes) : 'the dead-tap rescue never fired',
      })
    }
  }

  /* 5. PICTURE — a source that froze recorded a still image and said nothing.

        AND WHICH MACHINERY MADE THE COMPOSITE (P9's seam, O4's painter). Both
        are chosen at runtime by probe and both fall through to a rung below
        when a machine cannot honour them, so a card that does not name them
        cannot notice one rung behaving differently from another — which is the
        only way "a silent difference between rungs is a defect" can be
        enforced rather than hoped for. A take made before the fields existed
        says so instead of being read as a default. */
  {
    const stalled = recording.stalled ?? []
    const comp = recording.composite
    /**
     * J6 — THE SAME EVIDENCE, FROM WHICHEVER PLACE THE TAKE PUT IT.
     *
     * The glued copy is painted and not encoded on the shipped default, so most
     * takes now have no CompositeRecording at all — and the rung/backend that
     * this dimension exists to name would silently disappear with it. The
     * session writes them into `stopStats.glue` instead, and a take that opened
     * no compositor at all has neither, which reads here as no machinery line
     * rather than as a missing field.
     */
    const glue = recording.stopStats?.glue
    const made = comp
      ? { intake: comp.intake, painter: comp.painter, recorded: true, framesPainted: undefined }
      : glue
        ? { intake: glue.intake, painter: glue.painter, recorded: glue.recorded, framesPainted: glue.framesPainted }
        : null
    const machinery = !made
      ? null
      : `composed by ${made.intake ?? 'an unrecorded intake'} into ` +
        `${made.painter ?? 'an unrecorded painter'}` +
        (made.recorded
          ? ''
          : `, painted only (${made.framesPainted ?? 0} frames) — no composite file was written (J6)`)
    const detail = stalled.length
      ? `${stalled.map((k) => LABEL[k]).join(' & ')} froze mid-take — those stretches are a still image`
      : `${video.length} video channel${video.length === 1 ? '' : 's'}, none stalled`
    dims.push({
      id: 'picture',
      status: stalled.length ? 'fail' : 'pass',
      ...(stalled.length ? { kinds: stalled } : null),
      detail: machinery ? `${detail}; ${machinery}` : detail,
    })
  }

  /* 6. RATE — what the take asked for, what its files were written at, and
        whether anything had to be given up to keep them coming. */
  {
    const stats = recording.stopStats
    const notes = video.map((c) => `${LABEL[c.kind]} ${c.fps ?? 30} fps`)
    if (recording.composite) notes.push(`composite ${recording.composite.fps ?? 30} fps`)
    if (stats?.requestedFps) notes.unshift(`asked for ${stats.requestedFps} fps`)
    if (stats?.degradedWhy) {
      dims.push({
        id: 'rate',
        status: 'fail',
        detail: `this take degraded to keep up — ${stats.degradedWhy}. ${list(notes)}`,
      })
    } else if (!stats) {
      dims.push({
        id: 'rate',
        status: 'unmeasured',
        detail:
          `${list(notes)} — but this take carries no stop stats, so whether anything ` +
          'degraded to deliver them is not recorded (takes made before S1)',
      })
    } else {
      dims.push({
        id: 'rate',
        status: 'pass',
        detail: `${list(notes)} — nothing degraded (no ladder step, no composite give-up)`,
      })
    }
  }

  /* 6b. ELASTIC — DID THE ORDER OF DEFENCE HOLD? (task E2.)

        `rate` above says only THAT something was given up. Robert's ruling of
        2026-09-02 is about the ORDER: shed the unseen work first, absorb the
        burst second, move the picture last. So this grades the take's own
        ledger, and it grades the ORDERING and not the stepping — a take that
        shed and recovered did exactly what elastic is for, and failing it for
        that is the G6(g) defect (the `rescue` dimension reds every honest long
        take by grading attempts instead of loss). The only failure here is a
        picture step taken while the free things were still running. */
  {
    const events = recording.stopStats?.elastic
    if (!events) {
      dims.push({
        id: 'elastic',
        status: 'pass',
        detail:
          'nothing was shed and nothing had to recover — this take carried its plan ' +
          'the whole way (or predates the ledger, in which case there is nothing to grade)',
      })
    } else {
      const audit = auditElastic({
        events,
        droppedEvents: recording.stopStats?.elasticDropped ?? 0,
      })
      const recovery = audit.pictureRecoveryMs.length
        ? ` · picture back up after ${audit.pictureRecoveryMs
            .map((ms) => `${(ms / 1000).toFixed(1)} s`)
            .join(', ')}`
        : ''
      if (audit.ok) {
        dims.push({
          id: 'elastic',
          status: 'pass',
          detail: `${audit.line}${recovery} — the unseen work went before the picture, every time`,
        })
      } else {
        const first = audit.outOfOrder[0]
        dims.push({
          id: 'elastic',
          status: 'fail',
          headline: `the picture stepped before the free work was shed at ${(
            (first?.atMs ?? 0) / 1000
          ).toFixed(1)} s`,
          detail:
            `${audit.line}${recovery} — ${audit.outOfOrder.length} picture step(s) were taken ` +
            `while the background work was still running: ${audit.outOfOrder
              .map((e) => `${(e.atMs / 1000).toFixed(1)} s ${e.what}`)
              .join('; ')}`,
        })
      }
    }
  }

  /* 6c. DECISIONS — DID ANYTHING MOVE THAT NOBODY DECIDED? (task M1.)

        `elastic` above grades the ORDER of the three defence layers. This
        grades the door's whole ledger: every change to rate, resolution,
        quality or which channels ran, including the ones taken before the first
        frame (the encoder budget, the arm-time rate hold) and the ones nobody
        chose — Chrome adapting a capture source on its own, which cannot be
        owned and is therefore detected.

        WHAT MAKES IT RED, and it is deliberately narrow, because G6(g) is the
        standing lesson about a dimension that reds every honest take: a
        decision this take could not carry out (`failed` — the platform refused
        a constraint, so the take is running unprotected), or a dial the
        PLATFORM moved on us. Everything else — a step taken, a rung skipped, a
        composite dropped, a refusal recorded — is the machinery working, and it
        is reported rather than graded. */
  {
    const decisions = recording.stopStats?.decisions
    if (!decisions?.length) {
      dims.push({
        id: 'decisions',
        status: 'pass',
        detail:
          'no decision was taken about this take — it recorded what it was asked for ' +
          '(or predates the door, in which case there is nothing to grade)',
      })
    } else {
      const failed = decisions.filter((d) => d.outcome === 'failed')
      const platform = decisions.filter((d) => d.decidedBy === 'chrome')
      const refused = decisions.filter((d) => d.outcome === 'refused')
      const sheds = decisions.filter((d) => d.action === 'shed' && d.outcome === 'applied')
      const say = (d: (typeof decisions)[number]): string =>
        `${(d.atMs / 1000).toFixed(1)} s ${d.what} [${d.decidedBy}]`
      const line =
        `${decisions.length} decision(s) — ${sheds.length} applied shed(s), ` +
        `${refused.length} refused, ${failed.length} failed` +
        (platform.length ? `, ${platform.length} taken by the platform itself` : '') +
        (sheds.length ? ` · ${sheds.map(say).join('; ')}` : '')
      if (failed.length || platform.length) {
        const first = failed[0] ?? platform[0]
        dims.push({
          id: 'decisions',
          status: 'fail',
          headline: failed.length
            ? `the take could not carry out its own decision at ${((first?.atMs ?? 0) / 1000).toFixed(1)} s: ${first?.what}`
            : `the platform moved the source on its own at ${((first?.atMs ?? 0) / 1000).toFixed(1)} s: ${first?.what}`,
          detail:
            `${line}` +
            (failed.length
              ? ` · FAILED: ${failed.map((d) => `${say(d)} — ${d.outcomeWhy ?? 'no reason recorded'}`).join('; ')}`
              : '') +
            (platform.length ? ` · PLATFORM: ${platform.map(say).join('; ')}` : ''),
        })
      } else {
        dims.push({
          id: 'decisions',
          status: 'pass',
          detail: `${line} — every one of them through the door, with its reason and its outcome`,
        })
      }
    }
  }

  /* 7. SYNC — B7's alignment inputs, so a complaint arrives with numbers. */
  {
    const anchored = recording.channels.filter((c) => c.diagnostics?.anchor)
    if (!anchored.length) {
      dims.push({
        id: 'sync',
        status: 'unmeasured',
        detail: 'no channel carries B7 anchors — this take predates them',
      })
    } else {
      const without = recording.channels.filter((c) => !c.diagnostics?.anchor)
      dims.push({
        id: 'sync',
        status: without.length ? 'fail' : 'pass',
        ...(without.length ? { kinds: without.map((c) => c.kind) } : null),
        detail: without.length
          ? `${without.map((c) => LABEL[c.kind]).join(' & ')} carry no anchor while the rest do — ` +
            'the alignment inputs for this take are incomplete'
          : list(
              anchored.map((c) => {
                const a = c.diagnostics?.anchor
                const parts = [`${LABEL[c.kind]} at ${c.startOffsetMs}ms`]
                if (a?.rawAnchorMs !== undefined) parts.push(`raw ${a.rawAnchorMs}`)
                if (a?.reportedInputLatencyMs !== undefined) {
                  parts.push(`reported latency ${a.reportedInputLatencyMs}`)
                }
                if (a?.firstFrameDelayMs !== undefined) {
                  parts.push(
                    `${a.firstFrameDelayIsStartGap ? 'start gap' : 'first frame'} ${a.firstFrameDelayMs}`,
                  )
                }
                return parts.join(' ')
              }),
            ),
      })
    }
  }

  /* 8. STORAGE — what the take wrote, and how close it came to the wall. */
  {
    const bytes =
      recording.channels.reduce((n, c) => n + (c.bytes ?? 0), 0) + (recording.composite?.bytes ?? 0)
    const perMin = take > 0 ? bytes / (take / 60_000) : 0
    const stats = recording.stopStats
    const free =
      stats?.storageQuotaBytes !== undefined && stats?.storageUsageBytes !== undefined
        ? stats.storageQuotaBytes - stats.storageUsageBytes
        : undefined
    if (bytes === 0) {
      dims.push({
        id: 'storage',
        status: 'unmeasured',
        detail: 'no channel carries its encoded size — this take predates the byte count',
      })
    } else if (free === undefined) {
      dims.push({
        id: 'storage',
        status: 'unmeasured',
        detail:
          `wrote ${mb(bytes)} (${mb(perMin)}/min) — but this take carries no storage sample, ` +
          'so the headroom it ended on is not recorded',
      })
    } else {
      const perSec = perMin / 60
      const secsLeft = perSec > 0 ? free / perSec : Infinity
      dims.push({
        id: 'storage',
        status: secsLeft < WARN_SECONDS_LEFT ? 'fail' : 'pass',
        detail:
          `wrote ${mb(bytes)} (${mb(perMin)}/min), ${mb(free)} still free — ` +
          `${Number.isFinite(secsLeft) ? `${Math.round(secsLeft / 60)} min` : 'unbounded'} of ` +
          'headroom left at this take’s own rate',
      })
    }
  }

  /* 9. MEMORY — the heap at stop against the engine's limit. NOT a high-water:
        nothing samples during a take and nothing here starts to (H3 owns the
        hour-scale slope). A take that ends near the limit is the finding. */
  {
    const stats = recording.stopStats
    if (stats?.heapBytes === undefined || !stats.heapLimitBytes) {
      dims.push({
        id: 'memory',
        status: 'unmeasured',
        detail:
          'no heap sample on this take — performance.memory is Chromium-only and is read once, ' +
          'at stop (the hour-scale slope is H3, and it is not this)',
      })
    } else {
      const share = stats.heapBytes / stats.heapLimitBytes
      dims.push({
        id: 'memory',
        status: share >= HEAP_FAIL_RATIO ? 'fail' : 'pass',
        detail:
          `heap at stop ${mb(stats.heapBytes)} of ${mb(stats.heapLimitBytes)} (${pct(share)}) — ` +
          'a point sample at the end of the take, not a high-water mark',
      })
    }
  }

  /* 10. LATENESS — how late the main thread ran while this take recorded (G7).

        The instrument Phase 1's "no editor stall > 30 ms" is read against. It
        is the only dimension on this card that is SAMPLED rather than derived,
        which is why it carries its own cost (`selfCostMsPerSec`) and why the
        sampler's whole design is about not being a cost: the clock is in a
        worker, the main thread does one subtraction per beat, and the take
        keeps a histogram rather than a list.

        WHAT IT MEANS ON A TAKE AND WHAT IT DOES NOT. The recorder's own work
        is in workers — the encoders, the compositor, the muxers — so main-thread
        lateness during a take is NOT a frame-loss signal (E1's `worker-lateness`
        is that, per interval, and it steps the ladder). What lives on the main
        thread is the tick, the preview, the audio taps and the store, so this
        is the dimension B12 (audio ending early under a starved main thread) is
        argued from, and the one that says whether a take was recorded on a
        machine that was already in trouble. */
  {
    dims.push(latenessDimension(recording.stopStats?.lateness, 'this take'))
  }

  /* 11. WEDGES — anything the machine logged against this take's own window. */
  {
    const journal = evidence.wedgeJournal
    if (!journal) {
      dims.push({
        id: 'wedges',
        status: 'unmeasured',
        detail: 'the wedge journal was not supplied to this card',
      })
    } else {
      const from = recording.createdAt - take
      const inside = journal.filter(
        (e) => e.t >= from && e.t <= recording.createdAt && (e.kind === 'wedge' || e.kind === 'block'),
      )
      dims.push({
        id: 'wedges',
        status: inside.length ? 'fail' : 'pass',
        detail: inside.length
          ? `${inside.length} wedge/block entr${inside.length === 1 ? 'y' : 'ies'} inside this ` +
            `take’s window (${inside.map((e) => e.kind).join(', ')})`
          : 'nothing wedged or blocked while this take ran',
      })
    }
  }

  const failed = dims.filter((d) => d.status === 'fail')
  const unmeasured = dims.filter((d) => d.status === 'unmeasured')
  const verdict: Verdict = failed.length ? 'red' : unmeasured.length ? 'incomplete' : 'green'

  /**
   * THE BUILD IS IN THE HEADLINE, next to the id, because that is where someone
   * reading a field report looks. A long take is always made on an OLD build
   * (the tab is open before the take starts and the service worker serves what
   * it cached), and a take that does not say which build made it invites a
   * session to investigate a defect that was fixed before the take existed —
   * which is exactly what Robert's 71.7 min take cost. `?` on every take made
   * before this field, which is itself an answer.
   */
  const head = `${recording.id} · ${dur(take)} · build ${recording.buildId ?? '?'} · ${verdict.toUpperCase()}`
  const body = failed.length
    ? ` — ${failed.map((d) => `${d.id}: ${d.headline ?? d.detail}`).join(' · ')}`
    : ` — ${dims.length - unmeasured.length} of ${dims.length} dimensions measured and inside band`
  const tail = unmeasured.length
    ? `. Not measured: ${unmeasured.map((d) => d.id).join(', ')}.`
    : '.'

  return {
    recordingId: recording.id,
    createdAt: recording.createdAt,
    /** Which build recorded this — see Recording.buildId. */
    buildId: recording.buildId ?? null,
    durationMs: take,
    verdict,
    line: head + body + tail,
    dimensions: dims,
  }
}

/* ─────────────────── G7: main-thread lateness ─────────────────── */

/**
 * ONE DIMENSION, TWO SURFACES. The take's card grades the capture window and
 * the editor's card grades the editor's first 15 seconds, and they must be the
 * same arithmetic against the same band or the two numbers cannot be compared —
 * which is the whole point of an instrument B10 is proved against (the stall
 * has to be the same size before the fix and after it).
 *
 * THE BAND IS THE CLAIM. Phase 1 says "no editor stall > 30 ms", so 30 ms is
 * what this fails on, and it fails on the WORST ONE-SECOND WINDOW rather than
 * on any single sample. Rule 3 of this file is why: at 60 samples a second an
 * hour-long take takes 216,000 of them and something will be over any threshold
 * eventually — a card that reds every take is a card nobody reads. The window
 * makes the number a stall a person could feel, and the strict "> 1 frame is a
 * defect" reading is kept in the detail (`overFrame`) so a stricter gate can be
 * read off a card that passed.
 */
export function latenessDimension(
  s: LatenessSummary | undefined,
  where: string,
): ReportDimension {
  if (!s) {
    return {
      id: 'lateness',
      status: 'unmeasured',
      detail:
        `no main-thread lateness sample for ${where} — the sampler was off (\`?lateness=0\`) ` +
        'or this take predates G7',
    }
  }
  if (s.clamped) {
    return {
      id: 'lateness',
      status: 'unmeasured',
      // The one reading that must never be graded: it is Chrome's hidden-tab
      // timer throttle (~1 Hz), not the machine. E1 measured 984 ms of it on an
      // idle page. Saying `fail` here would convict every backgrounded take.
      detail:
        `${where}: the worker clock could not be built and the fallback timer ran on a hidden ` +
        `document, so its ${s.maxMs} ms worst reading is Chrome's ~1 Hz throttle and not this ` +
        'machine — not graded',
    }
  }
  const worst = s.worstWindows[0]
  const owner = s.owners[0]
  const parts = [
    worst
      ? `worst second at ${secs(worst.startMs)}: ${worst.maxMs} ms late, ` +
        `${worst.lateMs} ms over ${worst.samples} samples`
      : 'no full window was sampled',
    `p50 ${s.p50Ms} · p95 ${s.p95Ms} · max ${s.maxMs} ms at ${secs(s.maxAtMs)}`,
    `${s.overFrame} of ${s.samples} samples over one frame (${s.frameMs} ms)`,
    // NOT the self-cost: it times the handler body alone and reads ~10x under
    // the renderer's own task accounting (0.783 vs 7.4 ms/s on one run), so
    // quoting it on a card would be a claim the card cannot support. What
    // sampling costs is measured from outside and lives in docs/FLAGS.md.
    `sampled every ${s.periodMs} ms by ${s.source}, document hidden ${pct(s.hiddenRatio)} of ` +
      `${dur(s.spanMs)}`,
  ]
  // A hole in the schedule means the page was frozen or the worker starved, and
  // every number above is then a FLOOR. Say it where it cannot be missed.
  if (s.missed > 0) parts.push(`${s.missed} beats never arrived — these are lower bounds`)
  if (owner) {
    // BLOCKING FIRST, because that is what a stall is made of: a long animation
    // frame can run 487 ms of wall clock and block for none of it, and quoting
    // its duration beside a 2 ms worst sample reads as a contradiction.
    parts.push(
      `worst task: ${owner.name} ` +
        (owner.blockingMs !== undefined
          ? `${owner.blockingMs} ms blocking of ${owner.durationMs} ms`
          : `${owner.durationMs} ms`) +
        ` at ${secs(owner.atMs)}`,
    )
  } else if (s.hiddenRatio > 0.5) {
    // Not a gap in the instrument: neither long-animation-frame nor longtask
    // reports on a hidden document (E1: 0 entries in 74 s). Attribution is a
    // thing the editor has and a take does not.
    parts.push('no task attribution — the browser reports none on a hidden document')
  }
  const failed = worst !== undefined && worst.maxMs > STALL_FAIL_MS
  return {
    id: 'lateness',
    status: failed ? 'fail' : 'pass',
    ...(failed
      ? {
          headline:
            `the main thread was ${worst.maxMs} ms late at ${secs(worst.startMs)} of ${where}` +
            (owner ? ` — ${owner.name}` : ''),
        }
      : null),
    detail: list(parts),
  }
}

/** What the editor's own card is. Not a `ReportCard`: there is no take being
 *  graded, and giving it a `recordingId` it does not own would let it be
 *  mistaken for one in the take log. */
export interface EditorCard {
  /** The take that was open, when one was. */
  recordingId: string | null
  verdict: Verdict
  line: string
  dimensions: ReportDimension[]
}

/**
 * THE EDITOR'S CARD (G7). One dimension today — main-thread lateness over the
 * editor's first 15 seconds, which is the window B10's size probe lands in
 * (300 frames encoded on the main thread about 11 s after the editor opens).
 * Deliberately the same builder and the same band as the take's card.
 */
export function buildEditorCard(
  summary: LatenessSummary | null | undefined,
  recordingId: string | null = null,
): EditorCard {
  const dims = [latenessDimension(summary ?? undefined, 'the editor')]
  const failed = dims.filter((d) => d.status === 'fail')
  const unmeasured = dims.filter((d) => d.status === 'unmeasured')
  const verdict: Verdict = failed.length ? 'red' : unmeasured.length ? 'incomplete' : 'green'
  const span = summary ? ` · first ${dur(summary.spanMs)}` : ''
  const body = failed.length
    ? ` — ${failed.map((d) => `${d.id}: ${d.headline ?? d.detail}`).join(' · ')}`
    : unmeasured.length
      ? ` — ${unmeasured.map((d) => `${d.id}: ${d.detail}`).join(' · ')}`
      : ` — ${dims.length} of ${dims.length} dimensions measured and inside band`
  return {
    recordingId,
    verdict,
    line: `editor${recordingId ? ` · ${recordingId}` : ''}${span} · ${verdict.toUpperCase()}${body}`,
    dimensions: dims,
  }
}
