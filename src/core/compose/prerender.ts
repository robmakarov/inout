/**
 * THE EXPORT IS MADE BEFORE IT IS ASKED FOR — task F16, core.
 *
 * Robert, 2026-08-30: "max 60 fps must export fast on any old computer". It
 * cannot be made fast by rendering faster. A 3024x1964@60 take re-rendered to
 * 1440p is ~577 Mpx/s of decode and encode against the ~416 his machine
 * measures for one encoder, and an older machine is further away, so no amount
 * of optimisation reaches "fast" — the only export that is fast on ANY computer
 * is one that is already finished. His own counter, the day before: "cant it be
 * same high instant quality rendered already ... squeeze rendering in parallel
 * of edits so user wont notice?" Editing is when the machine is idle: capture
 * is over, and the render already lives in a worker.
 *
 * WHAT F16 PRESCRIBED AND WHAT MEASUREMENT SAID. The task specified a
 * background TRANSCODE lane, on the premise that transcoding is several times
 * cheaper than rendering. Spike T1 measured it at 1.3x, identically at 60 s and
 * 120 s — and transcoding from the smaller High file, which decodes a third of
 * the pixels, was not faster than transcoding from the raw channel at all. The
 * premise was formed against a render whose encoder had no backpressure and
 * spent its time draining a queue; that defect was fixed the same morning
 * (0f8fefe). So there is no transcode lane here and there does not need to be:
 * this runs THE PRODUCTION RENDER, earlier. It reuses every path, costs no
 * second generation of 4:2:0, and scales the same way on a slow machine.
 *
 * ONE JOB AT A TIME, and it belongs to exactly one (recording, edit, settings).
 * Anything that changes the output changes the key and cancels what was
 * running: a render for an edit the user has moved past is worse than no render
 * at all, because it is spending the machine on a file nobody will ask for.
 *
 * WHAT IT WILL NOT DO:
 *  · never for an export that is already a packet COPY. Instant is instant;
 *    pre-rendering it would spend a machine to save nothing.
 *  · never a second render of the same thing. An export pressed while the job
 *    is still running JOINS it — `take()` hands back the in-flight promise —
 *    so pressing the button early costs the user the remaining time and never
 *    restarts the work.
 */
import type {
  EditState,
  ExportProgress,
  ExportResult,
  ExportSettings,
  Recording,
} from '@core/types'
import { newId } from '@core/id'
import { blobStore, createPositionedWriter, persistBlobCopy } from '@core/store'
import { createJobPace, type JobPace } from '@core/backgroundWork'
import { keptSegments } from '@core/timeline'
import { currentRenderFlags } from './chunkPlan'
import { exportRecording } from './pipeline'

/**
 * F16b — THE ELASTIC BRAKE, wired to the product's one pressure instrument.
 *
 * Robert's ruling (2026-09-01): the background render runs BESIDE a live take
 * at strictly lower priority and is the first load shed on the machine. This
 * is the only place a job is handed one: a user-visible export never gets a
 * pace, because a person is waiting for it.
 *
 * E3 (2026-09-04) made it a pace PER JOB rather than one shared reading of the
 * broker, because "a person is waiting for it" stopped being a property of
 * which code started the render: `takePrerender` turns this job into exactly
 * that export, mid-render. The brake now ends where the waiting begins.
 */

/**
 * A pre-rendered file has to survive the NEXT export, and by default it does
 * not: an ExportResult's blob is a view of the export scratch, and scratch.ts
 * keeps only the newest finished one — by design, and documented. A second
 * pre-render (the user changed rung) would therefore delete the first one's
 * bytes and leave a blob that reads back "network error".
 *
 * It cannot be fixed by retaining the scratch, because the scratch's
 * bookkeeping lives in the EXPORT WORKER's own module instance and the main
 * thread has no reference to hand it. So the finished file is copied once, to a
 * key this module owns, and the copy is what is served. One extra file on disk,
 * never two: the previous copy is removed as soon as a new job supersedes it.
 *
 * The copy itself is store/persistBlobCopy.ts — export jobs make the same move.
 */
export const PRERENDER_PREFIX = 'prerender-'
const OWN_PREFIX = PRERENDER_PREFIX

/**
 * WHOSE PRE-RENDER IS IT? — J10, 2026-09-05, and it is the same defect J9 fixed
 * one file over.
 *
 * `sweepPrerenderBlobs` deletes every `prerender-*` blob except the one claimed
 * by THIS page's in-memory `job`, and `job` is module state — so a second tab
 * knows nothing about the first tab's. Any second boot (a recovery check, a
 * second window, an agent opening a take) therefore deleted a FINISHED
 * pre-render another tab was about to hand to an export, and that export then
 * rendered the take from scratch. On a 90-minute max60 take that is a whole
 * ~81-minute generation thrown away, which is exactly the class of bug Robert
 * was paying for on 2026-09-05.
 *
 * The rule the sweep was reaching for is right and stays: a pre-render belongs
 * to the page session that made it, and one left by a session that is GONE is
 * an export nobody will ask for. It just had no way to tell a live sibling from
 * a dead ancestor. So the blob now NAMES its session, and a session that holds
 * one keeps a heartbeat file whose own name is its timestamp. The sweep reads
 * both out of the listing it already has: no content, no lock, no bookkeeping
 * to keep in sync with the disk.
 *
 * A blob written before J10 carries no session segment, so it belongs to no
 * live session and is swept exactly as it was — which is what it deserves.
 */
const SESSION = newId('s')
export const PRERENDER_CLAIM_PREFIX = 'pclaim-'
const CLAIM_PREFIX = PRERENDER_CLAIM_PREFIX
/** How long a heartbeat speaks for its session. */
const CLAIM_STALE_MS = 2 * 60 * 1000
/** Far shorter, so a live session is never mistaken for a dead one. */
const CLAIM_BEAT_MS = 20 * 1000

/** The session that owns this blob, or null for a key written before J10. */
function sessionOf(key: string): string | null {
  const rest = key.slice(OWN_PREFIX.length)
  const cut = rest.indexOf('-')
  return cut > 0 ? rest.slice(0, cut) : null
}

let beat: ReturnType<typeof setInterval> | null = null
let claimKey: string | null = null

/**
 * Start this session's heartbeat, once, the first time it owns a pre-render.
 * It is never stopped on purpose: the session owning a blob IS the page, so the
 * page going away is what ends it, and the file ages out two minutes later.
 */
function holdClaim(): void {
  if (beat) return
  const nameAt = (t: number): string => `${CLAIM_PREFIX}${t.toString(36)}-${SESSION}`
  claimKey = nameAt(Date.now())
  void createPositionedWriter(claimKey)
    .then(async (w) => {
      await w.write(new Uint8Array(1), 0)
      await w.close()
    })
    .catch(() => undefined)
  beat = setInterval(() => {
    void (async () => {
      const next = nameAt(Date.now())
      if (!claimKey) return
      try {
        await blobStore.move(claimKey, next)
        claimKey = next
      } catch {
        /* a missed beat ages the claim; the next one repairs it. */
      }
    })()
  }, CLAIM_BEAT_MS)
  ;(beat as unknown as { unref?: () => void }).unref?.()
}

export interface PrerenderKeyInput {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
}

/**
 * Everything that changes the bytes, and nothing that does not. The edit and
 * the settings go in whole: a key that summarised them would eventually serve
 * one take's file for another take's edit, which is the single worst thing this
 * module could do.
 *
 * AND THE RENDER FLAGS GO IN TOO, since 2026-09-04 — they were missing, and
 * "everything that changes the bytes" was therefore false. A take stopped with
 * `?cq=` off, the switch turned on in /?test, then exported, was served the
 * file made BEFORE the switch and the switch did nothing at all; F13's
 * `?sourceframe=` rode the same hole, and O9(b) could only work around it by
 * refusing the pre-render whenever `?colour=all` was on. The flags are read
 * from the one place the chunk plan reads them (chunkPlan.ts), so a key, a
 * shape and a chunk can never disagree about what is in force.
 *
 * IT INVALIDATES EVERY PRE-RENDER MADE BEFORE THIS CHANGE, which is correct:
 * those files were keyed by a question that did not include the answer.
 */
export function prerenderKey({ recording, edit, settings }: PrerenderKeyInput): string {
  return JSON.stringify([recording.id, edit, settings ?? null, currentRenderFlags()])
}

/**
 * THE SAME OUTPUT, WRITTEN DIFFERENTLY — F16b.
 *
 * The key above is deliberately strict, and it stays strict: it is what
 * decides whether a finished file may be SERVED. This is a second, weaker
 * question, asked only of a job that is still RUNNING: would the file it is
 * making be the same file under the new edit?
 *
 * It differs in exactly one place — the spans are normalised through
 * `keptSegments`, which is what the ENGINE sees. A bare split is two adjacent
 * spans in the editor and one span in the render (timeline.ts: "this is what
 * keeps a split-with-nothing-deleted free"), so a user who splits before
 * cutting has changed the key without changing a single byte of output. Killing
 * a 20 %-finished render for that — measured, exactly that, on 2026-09-02 —
 * spends the machine to obey a bookkeeping difference.
 *
 * Everything else goes in whole, as before: camera track, viewport, background,
 * channels, the global trim, the settings. Same shape ⇒ same bytes.
 */
export function prerenderShape({ recording, edit, settings }: PrerenderKeyInput): string {
  return JSON.stringify([
    recording.id,
    { ...edit, segments: keptSegments(edit) },
    settings ?? null,
    // Same reason as the key: a running job whose flags no longer match is not
    // making the file this export wants, however identical the edit looks.
    currentRenderFlags(),
  ])
}

export type PrerenderState = 'running' | 'done' | 'failed'

/** Where a job came from. F16 started them from the editor only; F16b starts
 *  the max+camera one at STOP, where the machine is idle by definition. */
export type PrerenderOrigin = 'stop' | 'edit'

interface Job {
  key: string
  /** What this job is rendering. Kept so a LATER edit can be described against
   *  the one the job is spending the machine on — an edit that binds has to be
   *  able to say WHERE it landed. */
  input: PrerenderKeyInput
  /** Why it was started: 'stop' (F16b, at the end of the take) or 'edit' (F16,
   *  1.2 s after the editor settles). Evidence for the console line. */
  origin: PrerenderOrigin
  state: PrerenderState
  progress: ExportProgress
  startedAt: number
  abort: AbortController
  blobKey: string
  /** E3 — this job's own pace. `claim()` when an export takes it out. */
  pace: JobPace
  promise: Promise<ExportResult>
  /** Set by the claimer (takePrerender) — progress keeps flowing after the
   *  job is retired, because from then on it is a USER-VISIBLE export. */
  forward: ((p: ExportProgress) => void) | null
  /** Claimed by an export. The settle handlers must then KEEP the blob — the
   *  claimer's file reads from it; the boot sweep collects it next session. */
  takenOut: boolean
}

let job: Job | null = null

/** What the panel may say about the job — never a promise it cannot keep. */
export function prerenderStatus(key: string): { state: PrerenderState; ratio: number } | null {
  if (!job || job.key !== key) return null
  return { state: job.state, ratio: job.progress.ratio }
}

async function dropOwnBlob(key: string): Promise<void> {
  await blobStore.remove(key).catch(() => undefined)
}

/** Stop whatever is running and forget it. Its file goes with it. */
export function cancelPrerender(): void {
  if (!job) return
  const dying = job
  job = null
  dying.abort.abort()
  // The promise is already owned by whoever called start(); swallow its
  // rejection here so an abort never surfaces as an unhandled rejection.
  dying.promise.catch(() => undefined)
  void dropOwnBlob(dying.blobKey)
}

/**
 * Begin a render for this exact output, or keep the one already running for it.
 * Returns nothing: nobody waits on a pre-render, that is the whole point.
 */
export function startPrerender(input: PrerenderKeyInput, origin: PrerenderOrigin = 'edit'): void {
  const key = prerenderKey(input)
  if (job && job.key === key) return
  cancelPrerender()

  const abort = new AbortController()
  // J10: the key names its owning session, so another tab's sweep can tell a
  // live sibling's pre-render from one left by a session that is gone.
  const blobKey = `${OWN_PREFIX}${SESSION}-${newId('p')}`
  holdClaim()
  const pace = createJobPace()
  const started: Job = {
    key,
    input,
    origin,
    state: 'running',
    progress: { phase: 'preparing', ratio: 0 },
    startedAt: Date.now(),
    abort,
    blobKey,
    pace,
    promise: Promise.resolve() as unknown as Promise<ExportResult>,
    forward: null,
    takenOut: false,
  }
  job = started

  if (origin === 'stop') {
    console.info(
      `[compose] pre-render started AT STOP for a take whose export must render — ` +
        `${(input.recording.durationMs / 1000).toFixed(1)}s, ${input.settings?.width ?? '?'}x` +
        `${input.settings?.height ?? '?'} (F16b)`,
    )
  }

  started.promise = (async () => {
    const result = await exportRecording({
      recording: input.recording,
      edit: input.edit,
      settings: input.settings,
      signal: abort.signal,
      // F16b: a background job, and therefore elastic. Every other caller of
      // exportRecording is a person waiting for a file — and since E3 so is
      // this one, from the moment `takePrerender` claims it.
      pace,
      onProgress: (p) => {
        // NOT guarded by `job === started`: once claimed the job is retired
        // from this module but its progress is what the user is watching —
        // the flat "finalizing 99%" Robert sat five minutes behind was this
        // guard swallowing every real number the render produced.
        started.progress = p
        started.forward?.(p)
      },
    })
    // Copied BEFORE anyone can supersede it — see persistBlobCopy's note.
    const held = await persistBlobCopy(result.blob, blobKey)
    if (result.scratchKey) {
      // The copy is the file now; the scratch would otherwise sit until an
      // age sweep. Nobody has downloaded from this blob yet — it was never
      // handed out — so the remove is safe.
      void blobStore.remove(result.scratchKey).catch(() => undefined)
    }
    return { ...result, blob: held, scratchKey: undefined }
  })()

  // The render has ENDED by the time either settle handler runs — finished,
  // aborted or failed — so this is the one place where dropping the broker
  // subscription cannot silence a job that is still working. A cancel arrives
  // here too, through the abort's rejection.
  started.promise.then(
    (result) => {
      pace.dispose()
      if (job !== started) {
        // Superseded while it ran: its file is nobody's now. A CLAIMED job is
        // different — its file is exactly what the claimer is serving.
        if (!started.takenOut) void dropOwnBlob(blobKey)
        return
      }
      started.state = 'done'
      started.progress = { phase: 'finalizing', ratio: 1 }
      console.info(
        `[compose] pre-render ready after ${((Date.now() - started.startedAt) / 1000).toFixed(1)}s — ` +
          `${(result.blob.size / 1048576).toFixed(1)} MB waiting before it was asked for (F16)`,
      )
    },
    (err: unknown) => {
      pace.dispose()
      void dropOwnBlob(blobKey)
      if (job !== started) return
      started.state = 'failed'
      if (!(err instanceof Error && err.name === 'AbortError')) {
        // Never fatal: the export path falls back to rendering on demand,
        // exactly as it did before this module existed.
        console.info('[compose] pre-render did not finish; the export will render on demand', err)
      }
    },
  )
}

/**
 * WHERE TWO EDITS FIRST DISAGREE, on the take's own timeline — the number the
 * console line has to carry, because "an edit landed" without a WHERE is not
 * evidence of anything.
 *
 * Read off the kept spans rather than the raw fields: a trim, a cut and a
 * delete all arrive as different fields and mean the same thing to a render.
 * Null when the spans are identical (a change of camera track, background or
 * viewport — which still invalidates the job, and says so in its own words).
 */
export function firstEditDivergenceMs(before: EditState, after: EditState): number | null {
  const a = keptSegments(before)
  const b = keptSegments(after)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (!x || !y) return (x ?? y)!.startMs
    if (x.startMs !== y.startMs) return Math.min(x.startMs, y.startMs)
    if (x.endMs !== y.endMs) return Math.min(x.endMs, y.endMs)
  }
  return null
}

/**
 * AN EDIT BINDS THE ONGOING JOB — Robert, 2026-09-01 (DECISIONS (4)): "a cut or
 * delete landing while a job works takes effect IN the job, immediately — it
 * stops spending work on the excluded span and its output can never contain
 * it."
 *
 * Key-supersession already stopped a stale file being SERVED (the key carries
 * the edit whole, so `takePrerender` refuses it). This is the stronger half:
 * the stale work must not CONTINUE. Before this, an edit landing mid-job left
 * that job running for at least the editor's 1.2 s debounce — and for as long
 * as the user kept dragging — spending the machine on a file that could never
 * be served. The precedent this project does not get to repeat is the join bug
 * where cancel was wired to nothing and the render finished anyway: a control
 * that does not reach the running job is decoration, and an edit is a control.
 *
 * WHAT IT KEEPS: nothing. F16 left two options — segment-level reuse where the
 * seams allow, or debounced restart — and said to measure rather than choose by
 * taste. The measurement is in the F16b handoff: reuse is only ever valid for
 * output the render has ALREADY WRITTEN, the render writes audio a chunk ahead
 * of video, and the muxed file cannot be reopened at an earlier point — so the
 * reusable case is exactly "the cut lands after everything already encoded",
 * which is the case a restart pays the least for anyway. Restart, debounced by
 * the editor, is what ships.
 *
 * Returns true when a running job was actually stopped.
 */
export function editBindsPrerender(next: PrerenderKeyInput): boolean {
  if (!job || job.key === prerenderKey(next)) return false
  const stale = job
  /**
   * THE EDIT THAT CHANGES NOTHING keeps its job — and gets it re-aimed. A
   * split makes two spans the engine immediately merges back into one, so the
   * render in flight is already making the file this new edit asks for; it
   * just no longer answers to the name it was started under.
   */
  if (prerenderShape(stale.input) === prerenderShape(next)) {
    stale.key = prerenderKey(next)
    stale.input = next
    console.info(
      '[compose] an edit landed that does not change the output (a split with nothing removed) — ' +
        `the background render keeps its ${Math.round(stale.progress.ratio * 100)}% and is re-aimed at it (F16b)`,
    )
    return false
  }
  const sameTake = stale.input.recording.id === next.recording.id
  const at = sameTake ? firstEditDivergenceMs(stale.input.edit, next.edit) : null
  const where =
    at !== null
      ? `at ${(at / 1000).toFixed(2)}s of the take`
      : sameTake
        ? 'that changes the picture rather than the spans'
        : 'from another take'
  console.info(
    `[compose] an edit landed ${where} while a background render was ` +
      `${Math.round(stale.progress.ratio * 100)}% through (phase ${stale.progress.phase}) — ` +
      `the job is stopped here and nothing it made can be served (F16b)`,
  )
  cancelPrerender()
  return true
}

/** What a claimer gets: the render, and the levers a user-visible export needs. */
export interface TakenPrerender {
  promise: Promise<ExportResult>
  /** Aborting this aborts the underlying render — cancel must reach a joined
   *  job (Robert's cancel pressed at the fake 99% reached nothing). */
  abort: AbortController
  /** Where the job is right now, for the first paint of the claimer's UI. */
  progress: ExportProgress
  /** Live updates from here on. One claimer; a second call replaces the first. */
  onProgress(cb: (p: ExportProgress) => void): void
}

/**
 * The finished (or in-flight) render for this exact output, or null.
 *
 * JOINING A RUNNING JOB IS THE POINT, not a bonus: an export pressed halfway
 * through waits out the remainder instead of starting the same work again,
 * which is what "export is never slower than it was" rests on.
 *
 * Handing it out RETIRES the job — the blob is the caller's now, and this
 * module must not delete a file somebody is downloading.
 */
export function takePrerender(key: string): TakenPrerender | null {
  if (!job || job.key !== key || job.state === 'failed') return null
  const taken = job
  job = null
  taken.takenOut = true
  /**
   * E3 — THE DEADLINE MOVES HERE, and this line is the whole task in one call.
   * From this instant the job is not background work: a person pressed Export
   * and is watching the dock. Before it existed the press itself throttled the
   * render it was claiming — the Export button sits inside the editor's
   * `onPointerDownCapture={noteEditingActivity}` — so joining a running
   * pre-render could finish LATER than starting a fresh render, against F16's
   * standing promise that a pre-render "may only ever SAVE time"
   * (Robert 2026-09-01, DECISIONS (3)). Measured on prod before the fix:
   * press -> file 65.6 s with a pointer moving over the editor against 23.1 s
   * with the hand off it — 2.84x, +42.5 s, one build, one machine, same take,
   * same edit and the same press moment (scripts/e3-claimpace.mjs).
   */
  taken.pace.claim()
  return {
    promise: taken.promise,
    abort: taken.abort,
    progress: taken.progress,
    onProgress: (cb) => {
      taken.forward = cb
    },
  }
}

/** Test seam — module state outlives test cases. */
export function resetPrerenderForTests(): void {
  job = null
  if (beat) clearInterval(beat)
  beat = null
  claimKey = null
}

/**
 * Boot sweep: pre-render files from a page session that is GONE belong to
 * nobody. One from a session still beating belongs to it — see SESSION above
 * for the tab-versus-tab defect this exists to stop.
 */
export async function sweepPrerenderBlobs(): Promise<number> {
  let removed = 0
  const now = Date.now()
  const files = await blobStore.list()

  // Who is still here. Ours counts even before its first beat is written.
  const live = new Set<string>([SESSION])
  for (const f of files) {
    if (!f.key.startsWith(CLAIM_PREFIX)) continue
    const rest = f.key.slice(CLAIM_PREFIX.length)
    const cut = rest.indexOf('-')
    const stamp = parseInt(rest.slice(0, Math.max(0, cut)), 36)
    if (cut > 0 && Number.isFinite(stamp) && now - stamp < CLAIM_STALE_MS) {
      live.add(rest.slice(cut + 1))
    } else {
      await blobStore.remove(f.key).catch(() => undefined)
    }
  }

  for (const f of files) {
    if (!f.key.startsWith(OWN_PREFIX)) continue
    if (job && f.key === job.blobKey) continue
    const owner = sessionOf(f.key)
    if (owner && live.has(owner)) continue
    await blobStore.remove(f.key).then(
      () => {
        removed += 1
      },
      () => undefined,
    )
  }
  return removed
}
