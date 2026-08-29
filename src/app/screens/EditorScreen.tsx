import { useEffect, useMemo, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { clampEditState, outputDurationMs } from '@core/timeline'
import type { TightenProposal } from '@core/timeline'
import {
  isDefaultTier,
  loadQualityTier,
  resolveTier,
  saveQualityTier,
  settingsForTier,
  type QualityTier,
} from '@core/compose/quality'
import { frameAspectFor, sourceFrameEnabled } from '@core/frame'
import { takeRate } from '@core/rate'
import { exportByBestPath } from '@core/compose'
import { editsRepo, recordingsRepo } from '@core/store'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { detectCapabilities } from '@core/capabilities'
import { missingChannelsMessage } from '@app/lib/channels'
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
  // F13: the remembered step, resolved to THIS take's shape. `resolveTier` is
  // the identity on a 16:9 take and on every take with the flag off, so a
  // reload restores exactly the step it always did.
  /**
   * F13 — WHAT THE DECODER SAW, once it has seen it. Everything upstream is a
   * claim about the take's shape (`track.getSettings()` describes the sensor
   * and lies about orientation on a phone; the composite inherits whatever
   * capture believed). The picture the stage actually decodes cannot be wrong,
   * so on a camera-only take it is what the stage AND the export follow. Null
   * until it lands, and null forever when the frame does not follow the source.
   */
  const [measured, setMeasured] = useState<number | null>(null)
  useEffect(() => setMeasured(null), [recording.id])
  const cameraOnly = !recording.channels.some((c) => c.kind === 'screen' && c.media === 'video')
  const measuredAspect = sourceFrameEnabled() && cameraOnly ? measured : null
  const frameAspect = measuredAspect ?? frameAspectFor(recording)
  /**
   * F15 — THE TAKE'S RATE, and unlike the aspect there is nothing to re-measure
   * it against: the files carry the rate they were written at. It has to be
   * threaded through every `resolveTier` here or the export asks for 30 while
   * the panel offers 60, the copy fence (correctly) refuses the mismatch, and a
   * 60 fps take silently re-renders itself down — measured exactly that way on
   * prod before this line existed.
   */
  const frameRate = takeRate(recording)
  const [storedTier, setTier] = useState<QualityTier>(() => loadQualityTier())
  const tier = useMemo(
    () => resolveTier(storedTier, frameAspect, frameRate),
    [storedTier, frameAspect, frameRate],
  )
  const exporting = mode === 'exporting' || mode === 'share'
  // F5a: a PROPOSED cut list. It is preview-only until the user applies it, and
  // any other edit invalidates it — a proposal computed against a timeline that
  // has since moved would cut the wrong places.
  const [proposal, setProposal] = useState<TightenProposal | null>(null)
  const [analysing, setAnalysing] = useState(false)
  useEffect(() => {
    setProposal(null)
  }, [edit])

  const runTighten = async () => {
    if (analysing) return
    setAnalysing(true)
    const snapshot = useAppStore.getState().editState ?? edit
    try {
      // Split out of the editor chunk too: the decoder only loads if asked for.
      const { analyzeSilence } = await import('@core/compose/analyzeSilence')
      const result = await analyzeSilence(recording, snapshot)
      // The timeline may have moved while we were decoding.
      if (useAppStore.getState().editState !== snapshot) return
      if (result.proposal) setProposal(result.proposal)
      else useAppStore.getState().toast(result.reason ?? 'Nothing to tighten')
    } catch (err) {
      console.error('silence analysis failed', err)
      useAppStore.getState().toast('Could not analyse this take’s audio', 'error')
    } finally {
      setAnalysing(false)
    }
  }

  const applyTighten = () => {
    if (!proposal) return
    setEditState(clampEditState(recording, { ...edit, segments: proposal.segments }))
    setProposal(null)
  }

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

  // Persist the edit so a refresh gives the work back (F4). Debounced: a drag
  // produces one commit, but a trim handle produces a stream of them, and the
  // durable writer is busy enough during a take.
  useEffect(() => {
    const t = setTimeout(() => {
      void editsRepo.save(edit).catch((err) => console.warn('failed to persist edit', err))
    }, 400)
    return () => clearTimeout(t)
  }, [edit])

  const discard = async () => {
    setConfirmOpen(false)
    try {
      await recordingsRepo.remove(recording.id)
    } catch (err) {
      console.error('failed to remove recording', err)
    }
    useAppStore.getState().resetToCapture()
  }

  /**
   * The AI export (AI1). A separate artefact, not a quality step: no tier, no
   * geometry, no packet-copy ladder — it composes the take once at 4 samples a
   * second and keeps the frames that changed. Everything the video export does
   * is untouched by this path.
   */
  const onExportAi = async () => {
    const store = useAppStore.getState()
    if (store.mode === 'exporting') return
    setChoosing(false)
    pb.pause()
    const ac = new AbortController()
    store.setExportAbort(ac)
    store.setExportProgress({ phase: 'preparing', ratio: 0 })
    store.setMode('exporting')
    const effectiveEdit = useAppStore.getState().editState ?? edit
    analytics.track('export_start')
    const t0 = performance.now()
    try {
      // Loaded on demand: a take that never asks for it never pays for the
      // PDF writer or the delta analysis.
      const { exportForAi } = await import('@core/ai')
      const result = await exportForAi({
        recording,
        edit: effectiveEdit,
        onProgress: (p) => useAppStore.getState().setExportProgress(p),
        signal: ac.signal,
      })
      analytics.track('export_complete', {
        durationMs: Math.round(performance.now() - t0),
        sizeBytes: result.blob.size,
        forAi: true,
        pages: result.ai?.pages ?? 0,
        approxTokens: result.ai?.approxTokens ?? 0,
      })
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
        analytics.track('export_error', { message, forAi: true })
      }
      useAppStore.setState({ mode: 'editor', exportAbort: null, exportProgress: null })
    }
  }

  const onExport = async (chosen: QualityTier) => {
    const store = useAppStore.getState()
    if (store.mode === 'exporting') return
    setChoosing(false)
    pb.pause()
    // Only the default tier may copy the COMPOSITE: any other tier is a
    // different resolution, so the recorded composite is not it. A single raw
    // channel that already holds the chosen tier's geometry is still
    // packet-copyable at any tier (O3c) — choose.ts answers that itself.
    const defaultTier = isDefaultTier(chosen)
    // The step at THIS take's shape — the decoder's answer where there is one,
    // so the file matches the stage the user just judged it on (F13).
    const settings = settingsForTier(resolveTier(chosen, frameAspect, frameRate))

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
      // The ladder itself lives in compose/choose.ts, not here: the oracle
      // drives the SAME function, so the sync band gates the path a user
      // actually gets rather than the render they only get as a fallback.
      const { result, path } = await exportByBestPath({
        recording,
        edit: effectiveEdit,
        settings,
        // Fences the composite only — a matching raw channel may still be
        // copied at any tier (O3c).
        allowPacketCopy: defaultTier,
        onProgress,
        signal: ac.signal,
      })
      analytics.track('export_complete', {
        durationMs: Math.round(performance.now() - t0),
        sizeBytes: result.blob.size,
        instant: path === 'instant',
        smartCut: path === 'smartcut',
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
    // F13: the take's own frame aspect, so the stage, the timeline and the
    // export panel are all the width of the picture this take will make.
    <div className="editor" style={{ '--stage-ar': frameAspect } as React.CSSProperties}>
      {recording.missing?.length ? (
        <div className="editor__missing" role="alert">
          {missingChannelsMessage(recording.missing, detectCapabilities())}
        </div>
      ) : null}

      <div className="editor__player">
        <Player
          recording={recording}
          edit={edit}
          pb={pb}
          onBack={() => setConfirmOpen(true)}
          onExport={() => setChoosing(true)}
          onEdit={(next) => setEditState(clampEditState(recording, next))}
          showExport={!exporting && !choosing}
          measuredAspect={measuredAspect}
          onMeasuredAspect={setMeasured}
        />
      </div>

      {exporting ? (
        <ExportPanel onBack={() => useAppStore.getState().setMode('editor')} />
      ) : choosing ? (
        <QualityPanel
          recording={recording}
          edit={edit}
          outputDurationMs={outputDurationMs(edit)}
          tier={tier}
          frameAspect={frameAspect}
          onTier={(t) => {
            setTier(t)
            saveQualityTier(t)
          }}
          onExport={() => void onExport(tier)}
          onExportForAi={() => void onExportAi()}
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
          tighten={{
            analysing,
            proposal,
            onRun: () => void runTighten(),
            onApply: applyTighten,
            onDismiss: () => setProposal(null),
          }}
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
