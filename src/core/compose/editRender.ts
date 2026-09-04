/**
 * THE EXPORT IS MADE WHILE HE EDITS — task J5.
 *
 * Robert, 2026-09-04 (DECISIONS robert (27)): "kill the glued copy encoding and
 * do background render while editing". And the day before, when he deleted the
 * old one (robert (23)): "render in background while editing is fucked up, it
 * goes back and forth and it wastage of resourses, i dont want it".
 *
 * BOTH SENTENCES ARE TRUE OF DIFFERENT MACHINERY, and the difference is J1.
 * The deleted pre-render (F16) rendered the WHOLE take from zero and threw all
 * of it away on the next edit: a frame preset and a zoom cost two discarded
 * hour-long renders before Export was ever pressed. This one renders the edit
 * he ACTUALLY MADE into content-keyed chunks (`chunkedRender.ts`), so a
 * superseded job loses the chunk it was in the middle of — 2.5 s of output —
 * and everything else it finished stays on disk under its own content name and
 * is reused by the next job and by the press. The "back and forth" he watched
 * is bounded by one chunk instead of by the take's length.
 *
 * WHAT THIS FILE IS. The one door between an edit and a background render, and
 * deliberately the ONLY one: J3's gate was a source scan for a
 * `setTimeout(startPrerender)` anywhere in the app, because one line is exactly
 * the kind of thing that comes back by accident. That gate is now this module —
 * the rules are here, they are unit-pinned, and the editor calls one function.
 *
 * THE FOUR RULES, each of them a gate in J5's spec:
 *  1. AN UNTOUCHED EDITOR RENDERS NOTHING. Opening a take is not an edit.
 *     The take as it opened is the BASELINE, and while the current edit hashes
 *     to it (opening it, or undoing back to it) nothing is scheduled and any
 *     pending schedule is dropped. No idle work, ever — that was Robert's whole
 *     objection and it is not softened by the chunk cache.
 *  2. AN EDIT SETTLES FIRST. A drag lands dozens of edits a second; the render
 *     starts EDIT_SETTLE_MS after the last one. The debounce is politeness, not
 *     the mechanism — the mechanism is that the chunks survive.
 *  3. AN EXPORT THAT WOULD NOT RENDER STARTS NOTHING. An instant packet copy
 *     and a smart cut are already faster than any render; spending the machine
 *     on them would be F16's "pre-render an instant export" mistake.
 *  4. IT IS BRAKED, and by the instrument that already exists rather than by a
 *     second one: `startPrerender` hands the job its own pace over the broker,
 *     which is a trickle while a hand is on the editor (EDITING_QUIET_MS), a
 *     trickle while the editor is opening, and paused beside a live take. Since
 *     E3 that brake ENDS at the export press: `takePrerender` claims the job
 *     and its deadline becomes `now`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: cut any of the export's fixed cost. J7
 * measured that floor at 16.7 ms + 0.5 ms per second of take with every chunk
 * pre-made (19 / 38 / 48 ms at 10 / 30 / 60 s), all of it the plan hash, the
 * concatenation and one publish — so there is no ceremony left underneath this
 * task and it is not to be widened into cutting one.
 */
import { editRenderEnabled } from './editRenderFlag'
import { prerenderKey, startPrerender, type PrerenderKeyInput } from './prerender'

/**
 * How long the edit has to stand still before the machine spends anything on
 * it, ms. F16's number, kept on purpose: 1.2 s is long enough that a drag lands
 * as one edit and short enough that a person who stops to look at what they did
 * has a render running before they reach for Export.
 */
export const EDIT_SETTLE_MS = 1200

export interface EditRenderNote extends PrerenderKeyInput {
  /**
   * Would pressing Export RENDER this edit? The editor knows (it owns the tier
   * and therefore whether a packet copy is allowed); this module must not
   * re-derive it, or the two answers drift and a take gets a background render
   * for an export that was already instant.
   */
  wouldRender: boolean
}

/** What the module did with a note, and why — evidence, and what the tests read. */
export interface EditRenderDecision {
  /** True when a render is now scheduled (or already scheduled) for this edit. */
  scheduled: boolean
  why: string
}

interface Baseline {
  recordingId: string
  /** The take exactly as the editor opened it. */
  key: string
}

let baseline: Baseline | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** The key the pending timer will render, so a repeat of the same note does not
 *  restart its own settle timer (a re-render must not push the render away). */
let pendingKey: string | null = null

function clearPending(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
  pendingKey = null
}

/**
 * The editor's edit changed (or the editor mounted). Cheap by contract: one
 * JSON key and at most one timer, called from a React effect.
 */
export function noteEditorEdit(note: EditRenderNote): EditRenderDecision {
  const key = prerenderKey(note)

  // OPENING A TAKE IS NOT AN EDIT. Also the reset point: a different recording
  // means a different editor session, and its baseline is whatever it opened
  // with — a take that was edited yesterday opens with yesterday's edit and is
  // untouched until the hand moves.
  if (!baseline || baseline.recordingId !== note.recording.id) {
    baseline = { recordingId: note.recording.id, key }
    clearPending()
    return { scheduled: false, why: 'the editor opened this take — an untouched editor renders nothing' }
  }

  if (!editRenderEnabled()) {
    clearPending()
    return { scheduled: false, why: 'the background render is off (?bgrender=0)' }
  }

  // Rule 1, the other half: an undo back to the take as it opened is not a
  // reason to render either, and it CANCELS a schedule the edit before it made.
  if (key === baseline.key) {
    clearPending()
    return { scheduled: false, why: 'this is the take as it opened — nothing to render' }
  }

  if (!note.wouldRender) {
    clearPending()
    return { scheduled: false, why: 'this export is a packet copy or a smart cut — already instant' }
  }

  if (pendingKey === key) return { scheduled: true, why: 'already scheduled for this exact edit' }

  clearPending()
  pendingKey = key
  const input: PrerenderKeyInput = {
    recording: note.recording,
    edit: note.edit,
    settings: note.settings,
  }
  timer = setTimeout(() => {
    timer = null
    pendingKey = null
    console.info(
      `[compose] the edit settled — rendering it in the background at background pace, ` +
        `reusing every chunk it did not change (J5)`,
    )
    startPrerender(input, 'edit')
  }, EDIT_SETTLE_MS)
  return { scheduled: true, why: `scheduled ${EDIT_SETTLE_MS} ms after this edit` }
}

/**
 * The editor is gone (unmount), or the take is. Drops the schedule only — the
 * RUNNING job is `cancelPrerender`'s business, and the editor calls that too;
 * keeping the two separate is what lets a job survive a re-render.
 */
export function cancelEditRender(): void {
  clearPending()
  baseline = null
}

/** Is a render scheduled right now? For the tests, the rig and the panel. */
export function editRenderPending(): boolean {
  return timer !== null
}

/** Test seam — module state outlives test cases. */
export function resetEditRenderForTests(): void {
  clearPending()
  baseline = null
}
