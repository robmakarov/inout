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
