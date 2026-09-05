import { lazy, Suspense, useEffect } from 'react'
import { loadRecovery } from '@core/capture'
import { clampEditState, defaultEditState } from '@core/timeline'
import { useAppStore } from '@app/state/store'
import { loadExportJobs } from '@app/lib/exportJobs'
import { ErrorBoundary } from '@app/components/ErrorBoundary'
import { Toasts } from '@app/components/Toasts'
import { ExportDock } from '@app/components/ExportDock'
import { CaptureScreen } from '@app/screens/CaptureScreen'
import { loadEditorScreen } from '@app/editorChunk'
import './app.css'

// The editor (player, timeline, export pipeline, share) cannot be reached
// before a take exists, so it must not be in the bytes that stand between the
// user and the record button. It is prefetched the moment recording starts —
// the user is then guaranteed busy for seconds, so the chunk is warm long
// before stop (task O7).
const EditorScreen = lazy(async () => ({ default: (await loadEditorScreen()).EditorScreen }))

function Main() {
  const mode = useAppStore((s) => s.mode)
  // The dock is a fixed overlay; when it has rows the app reserves one row's
  // height so the bottom controls (quality bar, record bar) stay reachable
  // instead of sitting behind it.
  const docked = useAppStore((s) => s.exportJobs.length > 0)

  /**
   * ASK THE BROWSER NOT TO DELETE THE TAKES — J9, 2026-09-05.
   *
   * Everything this app keeps — every take's raw channels, every render chunk,
   * every scratch export — lives in "best effort" storage, which is the
   * browser's own term for data it may throw away on its own when the disk gets
   * tight. Nothing here had ever opted out, so on a nearly-full disk Chrome was
   * free to delete a 90-minute recording that had not been exported yet, and
   * render chunks between the pre-render and the press. This asks once, per
   * load, for the storage to be durable instead.
   *
   * IT IS NOT A PROMPT AND MUST NOT BE TREATED AS ONE. Chrome never shows a
   * dialog for this; it decides silently from its own engagement signals
   * (installed as an app, bookmarked, visited often) and answers yes or no.
   * Firefox is the one that asks. So this is fire-and-forget on every engine.
   *
   * IT DOES NOT RAISE THE QUOTA — that is computed from disk space either way.
   * It only changes whether what fits may later be deleted, so it is not a fix
   * for a take that is bigger than the quota; chunkedRender's own room check is.
   */
  useEffect(() => {
    const s = navigator.storage
    if (!s?.persist || !s.persisted) return
    void s
      .persisted()
      .then((already) => (already ? true : s.persist()))
      .then((granted) => {
        console.info(
          granted
            ? '[store] storage is durable — the browser will not evict takes on its own (J9)'
            : '[store] storage is best-effort: the browser may evict takes when the disk is tight (J9)',
        )
      })
      .catch(() => undefined)
  }, [])

  // Never lose a recording to a refresh: salvage interrupted sessions and
  // re-open the latest un-dismissed recording straight in the editor.
  useEffect(() => {
    void loadRecovery()
      .then((m) => m.recoverRecordingToEdit())
      .then(async (rec) => {
        if (!rec) return
        const s = useAppStore.getState()
        if (s.mode !== 'capture' || s.session) return
        // The edit is restored too (F4) — a refresh used to hand back the take
        // with every trim, cut and camera move silently reset to default.
        // Imported here rather than at module scope so the store stays out of
        // the first-paint chunk (O7). Best-effort: a failed read must never
        // keep a recovered take out of the editor.
        let saved: import('@core/types').EditState | undefined
        try {
          saved = await (await import('@core/store')).editsRepo.get(rec.id)
        } catch {
          saved = undefined
        }
        s.setRecording(rec)
        s.setEditState(clampEditState(rec, saved ?? defaultEditState(rec)))
        s.setMode('editor')
      })
      // AFTER recovery has had its chance, never before: the crash-salvage path
      // above is the one thing that can turn an unreferenced blob back into a
      // take, so the sweep runs behind it and skips whatever the pending
      // manifest still claims. Best-effort and never awaited by anything — a
      // failed sweep costs nothing and the next boot tries again.
      .finally(() => {
        void import('@core/store/reclaim')
          .then((m) => m.reclaimOrphanBlobs())
          .catch(() => undefined)
        // F16: a pre-render belongs to the page session that started it. One
        // left by a previous session is an export nobody is going to ask for.
        void import('@core/compose/prerender')
          .then((m) => m.sweepPrerenderBlobs())
          .catch(() => undefined)
        // J1: render chunks OUTLIVE the page session on purpose — that is what
        // lets a killed tab resume and an edit cost only what it changed. They
        // are still disk, and Robert's rule about disk is the loudest one here
        // ("we must prevent junk from saving, it will fuck up users disks"), so
        // they expire: staging files from a dead session, and finished chunks
        // nobody came back to inside a day.
        void import('@core/compose/chunkStore')
          .then((m) => m.sweepChunks())
          .then((swept) => {
            if (swept.removed > 0) {
              console.info(
                `[compose] swept ${swept.removed} render chunks, ` +
                  `${(swept.freedBytes / 1048576).toFixed(1)} MB freed; ` +
                  `${(swept.heldBytes / 1048576).toFixed(1)} MB held of a ` +
                  `${(swept.capBytes / 1048576).toFixed(0)} MB ceiling (J1)`,
              )
            }
          })
          .catch(() => undefined)
        // Export jobs SURVIVE the page session (2026-08-30): finished rows
        // come back, interrupted ones restart. Gated on the repo actually
        // holding rows, so a boot with no jobs never loads the compose graph.
        void import('@core/store')
          .then((m) => m.jobsRepo.list())
          .then((rows) =>
            rows.length ? loadExportJobs().then((m) => m.resumeExportJobs()) : undefined,
          )
          .catch(() => undefined)
      })
  }, [])

  return (
    <div className={docked ? 'app app--docked' : 'app'}>
      {mode === 'capture' && <CaptureScreen />}
      {mode === 'editor' && (
        <Suspense fallback={<div className="app__loading" />}>
          <EditorScreen />
        </Suspense>
      )}
      <ExportDock />
      <Toasts />
    </div>
  )
}

export function App() {
  return (
    <ErrorBoundary>
      <Main />
    </ErrorBoundary>
  )
}
