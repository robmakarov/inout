import { useEffect, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { clampEditState, isDefaultEdit, outputDurationMs } from '@core/timeline'
import {
  isDefaultTier,
  loadQualityTier,
  saveQualityTier,
  settingsForTier,
  type QualityTier,
} from '@core/compose/quality'
import { exportInstant, exportRecording } from '@core/compose'
import { recordingsRepo } from '@core/store'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { CHANNEL_META } from '@app/lib/channels'
import { usePlayback } from '@app/hooks/usePlayback'
import { Player } from '@app/components/Player'
import { Timeline } from '@app/components/Timeline'
import { ExportPanel } from '@app/components/ExportPanel'
import { QualityPanel } from '@app/components/QualityPanel'
import { ConfirmDialog } from '@app/components/ConfirmDialog'

export function EditorScreen() {
  const recording = useAppStore((s) => s.recording)
  const edit = useAppStore((s) => s.editState)
  if (!recording || !edit) return null
  return <Editor recording={recording} edit={edit} />
}

function Editor({ recording, edit }: { recording: Recording; edit: EditState }) {
  const setEditState = useAppStore((s) => s.setEditState)
  const mode = useAppStore((s) => s.mode)
  const pb = usePlayback(recording, edit)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // F7: quality is chosen BEFORE the export runs, in the timeline slot.
  const [choosing, setChoosing] = useState(false)
  const [tier, setTier] = useState<QualityTier>(() => loadQualityTier())
  const exporting = mode === 'exporting' || mode === 'share'

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

  const onExport = async (chosen: QualityTier) => {
    const store = useAppStore.getState()
    if (store.mode === 'exporting') return
    setChoosing(false)
    pb.pause()
    // Only the default tier can take the packet-copy path: any other tier is a
    // different resolution or bitrate, so the recorded composite is not it.
    const defaultTier = isDefaultTier(chosen)
    const settings = settingsForTier(chosen)

    // Instant + certified: an unedited take with a live composite copies that
    // composite's H.264 straight into MP4 (no re-encode) and muxes it with audio
    // mixed through the SAME certified mixer the render uses — instant again,
    // without the MediaRecorder audio that 4637bca removed as the noise cause.
    // Any edit, or any failure of the fast path, falls back to the full render.

    const ac = new AbortController()
    store.setExportAbort(ac)
    store.setExportProgress({ phase: 'preparing', ratio: 0 })
    store.setMode('exporting')
    const effectiveEdit = useAppStore.getState().editState ?? edit
    const onProgress = (p: Parameters<typeof store.setExportProgress>[0]) =>
      useAppStore.getState().setExportProgress(p)
    analytics.track('export_start')
    const t0 = performance.now()
    try {
      // Unedited + composite → instant certified path (copies the composite
      // H.264, muxes certified-mixer audio). Any edit or fast-path failure falls
      // back to the full render. BOTH paths now carry the loudness rescue, so a
      // faint capture (e.g. a Safari mic) exports audible either way.
      let result: Awaited<ReturnType<typeof exportRecording>> | undefined
      let instant = false
      if (defaultTier && recording.composite && isDefaultEdit(recording, effectiveEdit)) {
        try {
          result = await exportInstant({ recording, edit: effectiveEdit, onProgress, signal: ac.signal })
          instant = true
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') throw err
          // Fast path unusable (codec/track) — never fail an export over it.
          console.warn('instant export unavailable, falling back to render', err)
        }
      }
      if (!result) {
        result = await exportRecording({
          recording,
          edit: effectiveEdit,
          settings,
          onProgress,
          signal: ac.signal,
        })
      }
      analytics.track('export_complete', {
        durationMs: Math.round(performance.now() - t0),
        sizeBytes: result.blob.size,
        instant,
        tier: chosen.id,
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
      {recording.missing?.length ? (
        <div className="editor__missing" role="alert">
          {recording.missing.includes('system-audio')
            ? `Missing from this take: ${recording.missing
                .map((k) => CHANNEL_META[k].label)
                .join(', ')}. Audio wasn't shared — next time tick “Also share system audio” in the screen picker (tab shares always include it; window shares can't).`
            : `Missing from this take: ${recording.missing
                .map((k) => CHANNEL_META[k].label)
                .join(', ')} — the device never connected.`}
        </div>
      ) : null}

      <div className="editor__player">
        <Player
          recording={recording}
          edit={edit}
          pb={pb}
          onBack={() => setConfirmOpen(true)}
          onExport={() => setChoosing(true)}
          showExport={!exporting && !choosing}
        />
      </div>

      {exporting ? (
        <ExportPanel onBack={() => useAppStore.getState().setMode('editor')} />
      ) : choosing ? (
        <QualityPanel
          recording={recording}
          outputDurationMs={outputDurationMs(edit)}
          tier={tier}
          onTier={(t) => {
            setTier(t)
            saveQualityTier(t)
          }}
          onExport={() => void onExport(tier)}
          onCancel={() => setChoosing(false)}
        />
      ) : (
        <Timeline
          recording={recording}
          edit={edit}
          timeMs={pb.timeMs}
          durationMs={pb.durationMs}
          onSeek={pb.seek}
          onEdit={(next) => setEditState(clampEditState(recording, next))}
        />
      )}

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
