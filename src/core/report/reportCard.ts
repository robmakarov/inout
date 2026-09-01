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
 *  2. IT COSTS THE TAKE NOTHING. Everything here is computed from what is
 *     already persisted, at stop or later on demand. Nothing samples, polls or
 *     allocates while the recorder runs.
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
import { REVIVE_BASE_SEC, REVIVE_CEILING_SEC } from '@core/capture/reviveSchedule'
import { WARN_SECONDS_LEFT } from '@core/capture/diskGuard'
import type { ChannelKind, ChannelRecording, Recording } from '@core/types'

/** Every dimension the card grades. Order is the order they are reported in. */
export type DimensionId =
  | 'channels'
  | 'audio-continuity'
  | 'audio-clock'
  | 'rescue'
  | 'picture'
  | 'rate'
  | 'sync'
  | 'storage'
  | 'memory'
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
    const short = recording.channels.filter((c) => take - channelEnd(c) > shortfall)
    const kinds = [...missing, ...short.map((c) => c.kind)]
    if (kinds.length) {
      dims.push({
        id: 'channels',
        status: 'fail',
        kinds,
        detail: list([
          ...missing.map((k) => `${LABEL[k]} was requested and never delivered a byte`),
          ...short.map(
            (c) =>
              `${LABEL[c.kind]} ended ${dur(take - channelEnd(c))} before the take did ` +
              `(${dur(c.durationMs)} of ${dur(take)})`,
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
        if (tail >= SILENT_TAIL_FAIL_MS && share >= SILENT_TAIL_FAIL_RATIO) {
          bad.push(c.kind)
          lost.push(
            `${LABEL[c.kind]} went to digital zeros ${dur(from)} in and never came back — ` +
              `${dur(tail)} of ${dur(c.durationMs)} (${pct(share)})` +
              (muted ? ', and the source muted itself' : ''),
          )
          notes.push(lost[lost.length - 1])
        } else {
          notes.push(`${LABEL[c.kind]} silent tail ${Math.round(tail)}ms (${pct(share)})`)
        }
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

  /* 4. RESCUE — the dead-tap revival is a rescue, and a rescue is a fault. */
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
        const bursts = reviveBursts(c.diagnostics?.events)
        const late = bursts.filter((b) => b.runStartMs > WARMUP_MS)
        if (!bursts.length) continue
        if (late.length) bad.push(c.kind)
        const attempts = bursts.reduce((n, b) => n + b.attempts, 0)
        const note =
          `${LABEL[c.kind]} ${bursts.length} revive burst${bursts.length === 1 ? '' : 's'} ` +
          `(${attempts} attempts), ${late.length} after warm-up — ` +
          `runs began ${bursts.map((b) => secs(b.runStartMs)).join(', ')}`
        notes.push(note)
        if (late.length) convicting.push(note)
      }
      dims.push({
        id: 'rescue',
        status: bad.length ? 'fail' : 'pass',
        ...(bad.length ? { kinds: bad, headline: list(convicting) } : null),
        detail: notes.length ? list(notes) : 'the dead-tap rescue never fired',
      })
    }
  }

  /* 5. PICTURE — a source that froze recorded a still image and said nothing. */
  {
    const stalled = recording.stalled ?? []
    dims.push({
      id: 'picture',
      status: stalled.length ? 'fail' : 'pass',
      ...(stalled.length ? { kinds: stalled } : null),
      detail: stalled.length
        ? `${stalled.map((k) => LABEL[k]).join(' & ')} froze mid-take — those stretches are a still image`
        : `${video.length} video channel${video.length === 1 ? '' : 's'}, none stalled`,
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

  /* 10. WEDGES — anything the machine logged against this take's own window. */
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

  const head = `${recording.id} · ${dur(take)} · ${verdict.toUpperCase()}`
  const body = failed.length
    ? ` — ${failed.map((d) => `${d.id}: ${d.headline ?? d.detail}`).join(' · ')}`
    : ` — ${dims.length - unmeasured.length} of ${dims.length} dimensions measured and inside band`
  const tail = unmeasured.length
    ? `. Not measured: ${unmeasured.map((d) => d.id).join(', ')}.`
    : '.'

  return {
    recordingId: recording.id,
    createdAt: recording.createdAt,
    durationMs: take,
    verdict,
    line: head + body + tail,
    dimensions: dims,
  }
}
