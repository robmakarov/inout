import { useEffect, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { clampEditState, isDefaultEdit } from '@core/timeline'
import { exportRecording } from '@core/compose'
import { blobStore } from '@core/store'
import { recordingsRepo } from '@core/store'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { usePlayback } from '@app/hooks/usePlayback'
import { Player } from '@app/components/Player'
import { Timeline } from '@app/components/Timeline'
import { ConfirmDialog } from '@app/components/ConfirmDialog'
import { Icon } from '@app/components/Icon'
import { formatClock } from '@app/lib/format'

export function EditorScreen() {
  const recording = useAppStore((s) => s.recording)
  const edit = useAppStore((s) => s.editState)
  if (!recording || !edit) return null
  return <Editor recording={recording} edit={edit} />
}

function Editor({ recording, edit }: { recording: Recording; edit: EditState }) {
  const setEditState = useAppStore((s) => s.setEditState)
  const pb = usePlayback(recording, edit)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const { toggle, seekBy } = pb
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useAppStore.getState().mode !== 'editor') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        seekBy(-1000)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        seekBy(1000)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, seekBy])

  const discard = async () => {
    setConfirmOpen(false)
    try {
      await recordingsRepo.remove(recording.id)
    } catch (err) {
      console.error('failed to remove recording', err)
    }
    useAppStore.getState().resetToCapture()
  }

  const onExport = async () => {
    const store = useAppStore.getState()
    if (store.mode === 'exporting') return
    pb.pause()

    // Instant path: untouched edit + live composite recorded during capture.
    const currentEdit = store.editState ?? edit
    if (recording.composite && isDefaultEdit(recording, currentEdit)) {
      try {
        const blob = await blobStore.read(recording.composite.blobKey)
        if (blob.size > 0) {
          const d = new Date(recording.createdAt)
          const pad = (n: number) => String(n).padStart(2, '0')
          const ext = recording.composite.mimeType.includes('mp4') ? 'mp4' : 'webm'
          const fileName = `inout-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`
          analytics.track('export_complete', { durationMs: 0, sizeBytes: blob.size, instant: true })
          useAppStore.setState({
            exportResult: {
              blob,
              mimeType: recording.composite.mimeType,
              fileName,
              durationMs: recording.composite.durationMs,
              width: recording.composite.width,
              height: recording.composite.height,
            },
            mode: 'share',
          })
          return
        }
      } catch (err) {
        console.warn('instant export unavailable, falling back to render', err)
      }
    }

    const ac = new AbortController()
    store.setExportAbort(ac)
    store.setExportProgress({ phase: 'preparing', ratio: 0 })
    store.setMode('exporting')
    analytics.track('export_start')
    const t0 = performance.now()
    try {
      const result = await exportRecording({
        recording,
        edit: useAppStore.getState().editState ?? edit,
        onProgress: (p) => useAppStore.getState().setExportProgress(p),
        signal: ac.signal,
      })
      analytics.track('export_complete', {
        durationMs: Math.round(performance.now() - t0),
        sizeBytes: result.blob.size,
      })
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__lastExport = result
        void navigator.storage
          .getDirectory()
          .then((d) => d.getFileHandle('__last-export.bin', { create: true }))
          .then((h) => h.createWritable())
          .then(async (w) => {
            await w.write(result.blob)
            await w.close()
          })
          .catch(() => undefined)
      }
      useAppStore.setState({
        exportResult: result,
        mode: 'share',
        exportAbort: null,
        exportProgress: null,
      })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      if (!aborted) {
        const message = err instanceof Error ? err.message : 'Export failed'
        useAppStore.getState().toast(message, 'error')
        analytics.track('export_error', { message })
      }
      useAppStore.setState({ mode: 'editor', exportAbort: null, exportProgress: null })
    }
  }

  return (
    <div className="editor">
      <header className="editor__header">
        <button
          className="editor__back"
          onClick={() => setConfirmOpen(true)}
          aria-label="Back to capture"
        >
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="editor__duration">{formatClock(pb.durationMs)}</div>
        <button className="btn btn--primary" onClick={() => void onExport()}>
          Export
        </button>
      </header>

      <div className="editor__player">
        <Player recording={recording} edit={edit} pb={pb} />
      </div>

      <Timeline
        recording={recording}
        edit={edit}
        timeMs={pb.timeMs}
        durationMs={pb.durationMs}
        onSeek={pb.seek}
        onEdit={(next) => setEditState(clampEditState(recording, next))}
      />

      <ConfirmDialog
        open={confirmOpen}
        title="Discard recording?"
        message="This recording will be deleted. This can't be undone."
        confirmLabel="Discard"
        danger
        onConfirm={() => void discard()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
