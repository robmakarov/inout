import { lazy, Suspense, useEffect } from 'react'
import { loadRecovery } from '@core/capture'
import { clampEditState, defaultEditState } from '@core/timeline'
import { useAppStore } from '@app/state/store'
import { ErrorBoundary } from '@app/components/ErrorBoundary'
import { Toasts } from '@app/components/Toasts'
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

  // Never lose a recording to a refresh: salvage interrupted sessions and
  // re-open the latest un-dismissed recording straight in the editor.
  useEffect(() => {
    void loadRecovery()
      .then((m) => m.recoverRecordingToEdit())
      .then((rec) => {
        if (!rec) return
        const s = useAppStore.getState()
        if (s.mode !== 'capture' || s.session) return
        s.setRecording(rec)
        s.setEditState(clampEditState(rec, defaultEditState(rec)))
        s.setMode('editor')
      })
  }, [])

  return (
    <div className="app">
      {mode === 'capture' && <CaptureScreen />}
      {(mode === 'editor' || mode === 'exporting' || mode === 'share') && (
        <Suspense fallback={<div className="app__loading" />}>
          <EditorScreen />
        </Suspense>
      )}
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
