import { useEffect } from 'react'
import { recoverRecordingToEdit } from '@core/capture'
import { clampEditState, defaultEditState } from '@core/timeline'
import { useAppStore } from '@app/state/store'
import { ErrorBoundary } from '@app/components/ErrorBoundary'
import { Toasts } from '@app/components/Toasts'
import { CaptureScreen } from '@app/screens/CaptureScreen'
import { EditorScreen } from '@app/screens/EditorScreen'
import { ExportingOverlay } from '@app/screens/ExportingOverlay'
import { ShareScreen } from '@app/screens/ShareScreen'
import './app.css'

function Main() {
  const mode = useAppStore((s) => s.mode)

  // Never lose a recording to a refresh: salvage interrupted sessions and
  // re-open the latest un-dismissed recording straight in the editor.
  useEffect(() => {
    void recoverRecordingToEdit().then((rec) => {
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
      {(mode === 'editor' || mode === 'exporting') && <EditorScreen />}
      {mode === 'exporting' && <ExportingOverlay />}
      {mode === 'share' && <ShareScreen />}
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
