import { useEffect, useMemo, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { clampEditState, outputDurationMs } from '@core/timeline'
import type { TightenProposal } from '@core/timeline'
import {
  QUALITY_TIERS,
  isDefaultTier,
  resolveTier,
  settingsForTier,
  tiersForTake,
  type QualityTier,
} from '@core/compose/quality'
import { frameAspectFor, sourceFrameEnabled } from '@core/frame'
import { takeRate } from '@core/rate'
import {
  cancelPrerender,
  exportByBestPath,
  exportWouldRender,
  startPrerender,
} from '@core/compose'
import { prerenderEnabled } from '@core/compose/prerenderFlag'
import { loadRecovery } from '@core/capture'
import { editsRepo, recordingsRepo } from '@core/store'
import { saveToFile } from '@core/share'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { detectCapabilities } from '@core/capabilities'
import { missingChannelsMessage, takeLosses } from '@app/lib/channels'
import { usePlayback } from '@app/hooks/usePlayback'
import { Player } from '@app/components/Player'
import { Timeline } from '@app/components/Timeline'
import { ExportProgressStrip, ExportSavedStrip } from '@app/components/ExportPanel'
import { QualityBar } from '@app/components/QualityBar'
import { ToolsBar } from '@app/components/ToolsBar'
import { SettingsBadge } from '@app/components/SettingsBadge'
import { testPanelEnabled } from '@app/lib/testPanel'
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
  /**
   * UI1 — THE STEPS THIS TAKE MAY EXPORT AT, capped by what was chosen before
   * it was recorded. `tiersForTake` is the one place a step is resolved against
   * a take (F13/F15) and now also the one place the ceiling is applied.
   */
  const tiers = useMemo(
    () => tiersForTake(recording, frameAspect),
    [recording, frameAspect],
  )
  /**
   * UI1 — THE DEFAULT IS THE CEILING, i.e. exactly what the user chose before
   * pressing record. Robert: "maximal choosen quality must be rendered in
   * priority or background, whatever we do with it, instant". So the export the
   * pre-render spends the idle machine on is the one that was asked for, and
   * there is no second remembered preference quietly overriding the first.
   *
   * Keyed on the take: opening another one re-defaults to ITS ceiling rather
   * than carrying this one's choice across.
   */
  const [chosenId, setChosenId] = useState<string | null>(null)
  useEffect(() => setChosenId(null), [recording.id])
  const tier = useMemo(() => {
    // `tiersForTake` never returns an empty ladder — the lowest rung is
    // reachable from every ceiling — so `top` is defined in every real case.
    const top = tiers[tiers.length - 1] ?? resolveTier(QUALITY_TIERS[0]!, frameAspect, frameRate)
    const picked = chosenId ? tiers.find((t) => t.id === chosenId) : undefined
    if (picked) return picked
    const ceiling = recording.qualityStep
    if (ceiling) {
      // The step the user chose before recording. 'max' is this file's 'source'.
      return tiers.find((t) => t.id === (ceiling === 'max' ? 'source' : ceiling)) ?? top
    }
    /**
     * A TAKE FROM BEFORE THE CEILING EXISTED KEEPS THE DEFAULT IT WAS MADE
     * UNDER, and this is not a detail: defaulting an old take to the TOP of its
     * (uncapped) ladder would make its untouched export a full re-render of
     * every frame, where yesterday it was a packet copy. That is the frozen
     * "instant default export" rule, broken silently, for every take already on
     * disk. F18's rule stands for these: their own resolution when they offer
     * one, otherwise the default step.
     */
    return (
      tiers.find((t) => t.id === 'source') ??
      tiers.find((t) => isDefaultTier(t)) ??
      top
    )
  }, [tiers, chosenId, recording.qualityStep, frameAspect, frameRate])
  const exporting = mode === 'exporting'
  // F5a: a PROPOSED cut list. It is preview-only until the user applies it, and
  // any other edit invalidates it — a proposal computed against a timeline that
  // has since moved would cut the wrong places.
  const [proposal, setProposal] = useState<TightenProposal | null>(null)
  const [analysing, setAnalysing] = useState(false)
  const exportResult = useAppStore((s) => s.exportResult)
  useEffect(() => {
    setProposal(null)
    // The saved strip describes a file made from a timeline that has now moved,
    // so it stops describing anything. Clearing it is the whole of "that file
    // is not this edit" — no warning needed, because the slider below is right
    // there to make the new one.
    useAppStore.getState().setExportResult(null)
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

  /**
   * UI1 — WATCH MEANS WATCH. A take opened from the takes list's Watch button
   * arrives with `openIntent: 'watch'` and should be PLAYING when it appears;
   * one opened with Edit, or by the boot recovery, should not. Consumed once
   * and cleared, so a later re-render cannot restart playback under the user.
   */
  const openIntent = useAppStore((s) => s.openIntent)
  useEffect(() => {
    if (openIntent !== 'watch' || !pb.ready) return
    useAppStore.getState().setOpenIntent(null)
    pb.play()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIntent, pb.ready])

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

  /**
   * F16: START THE EXPORT BEFORE IT IS ASKED FOR.
   *
   * Robert, 2026-08-30: "max 60 fps must export fast on any old computer."
   * Rendering faster cannot get there — a native 60 fps take is more decode and
   * encode than the machine has — so the export has to be finished before the
   * button is pressed. Editing is exactly when the machine is idle: capture is
   * over and the render lives in a worker.
   *
   * DEBOUNCED HARDER THAN THE EDIT SAVE, and for a different reason: a save
   * that fires mid-drag costs a small write, but a RENDER that fires mid-drag
   * spends the machine on a file the next drag frame invalidates. 1.2 s of
   * stillness is the signal that the user is looking rather than moving.
   *
   * Only when the export would actually RENDER — an instant copy or a smart cut
   * is already fast, and pre-rendering one would spend a machine to save
   * nothing. A miss costs nothing either: choose.ts falls straight through to
   * rendering on demand, exactly as it did before this existed.
   */
  useEffect(() => {
    if (!prerenderEnabled()) return
    const chosen = resolveTier(tier, frameAspect, frameRate)
    const settings = settingsForTier(chosen)
    if (!exportWouldRender({ recording, edit, settings, allowPacketCopy: isDefaultTier(tier) })) {
      cancelPrerender()
      return
    }
    const t = setTimeout(() => startPrerender({ recording, edit, settings }), 1200)
    return () => clearTimeout(t)
  }, [recording, edit, tier, frameAspect, frameRate])

  // A take that is left behind takes its pre-render with it: the file is for an
  // export nobody is going to ask for now.
  useEffect(() => () => cancelPrerender(), [recording.id])

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
      // UI1: THE FILE IS THE POINT — Robert: "skip bullshit extra step after
      // render, download after it done". See the note on the video export.
      saveToFile(result)
      useAppStore.setState({
        exportResult: result,
        // UI1: back to the editor, not to a screen of its own — what the export
        // produced is a strip above the slider that made it.
        mode: 'editor',
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
      /**
       * UI1 — THE DOWNLOAD IS NOT A SEPARATE DECISION. Robert: "skip bullshit
       * extra step after render, download after it done".
       *
       * Pressing Export IS asking for the file; making the user press Save
       * afterwards was a second question with only one sensible answer, and it
       * put a click between the render finishing and the thing the render was
       * for. The share panel still opens behind it — a link is a different
       * thing to want and it stays a choice — but the file is already in
       * Downloads by the time it appears.
       *
       * This is a plain anchor click on a blob URL (core/share), the same call
       * the button made; it is not a filesystem write and it cannot fail
       * silently in a way the panel's Save button would have survived.
       */
      saveToFile(result)
      useAppStore.setState({
        exportResult: result,
        // UI1: back to the editor, not to a screen of its own — what the export
        // produced is a strip above the slider that made it.
        mode: 'editor',
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
      {/* WHAT THIS TAKE LOST WHILE RECORDING. The take has always carried the
          evidence — silent tails, tap rebuilds, wall-clock padding — and it has
          always been invisible, so a take whose tab audio died was something
          you found out by listening (Robert, 2026-08-30). */}
      {/* THE TAKE'S OWN DIAGNOSTICS ARE A TEST-MODE THING — Robert, 2026-08-30:
          "make sure this stupid errors of your shown only in test mode, audio
          was fine all this session". They were built to make his reports
          carry evidence, and they earned their keep doing that; but a banner
          that fires on a healthy take is worse than no banner, and twice now
          one has. Behind `/?test` they are diagnostics for us. In front of a
          user they would need a bar I have not yet shown I can hold. The
          MISSING-CHANNEL line above is not one of these: a take that lost a
          whole input has always said so, and still does. */}
      {testPanelEnabled() && (
        <>
          {takeLosses(recording.channels, detectCapabilities()).map((l) => (
            <div key={`${l.kind}-loss`} className="editor__missing" role="alert">
              {l.message}
            </div>
          ))}
          {/* The switches, beside the warnings, so one screenshot carries both. */}
          <SettingsBadge />
        </>
      )}

      <div className="editor__player">
        <Player
          recording={recording}
          edit={edit}
          pb={pb}
          onBack={() => setConfirmOpen(true)}
          onContinue={() =>
            useAppStore
              .getState()
              .toast(
                'Continuing a take from the playhead isn’t wired up yet — it’s on the roadmap (R-CONT)',
              )
          }
          onEdit={(next) => setEditState(clampEditState(recording, next))}
          measuredAspect={measuredAspect}
          onMeasuredAspect={setMeasured}
        />
      </div>

      {/* UI1: the editing tools, under the picture rather than through the
          middle of the timeline — Robert: "buttons with extra features make
          under preview video, not in the fucking middle of timeline".
          They STAY on screen while a render runs, because the render is not a
          screen of its own any more; they just stop taking input, because the
          export snapshotted the edit when it started and a change made now
          would silently not be in the file. */}
      <div className={`editor__below${exporting ? ' editor__below--locked' : ''}`}>
        <ToolsBar
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

        <Timeline
          recording={recording}
          edit={edit}
          timeMs={pb.timeMs}
          durationMs={pb.durationMs}
          onSeek={pb.seek}
          onEdit={(next) => setEditState(clampEditState(recording, next))}
          proposal={proposal}
        />
      </div>

      {exporting ? (
        <ExportProgressStrip />
      ) : (
        <>
          {exportResult && (
            <ExportSavedStrip
              result={exportResult}
              onDismiss={() => useAppStore.getState().setExportResult(null)}
            />
          )}
          {/* UI1: the quality slider is always on screen — there is no "choose
              a quality" step any more, because the choice was already made
              before the take and this only lets you go down from it. */}
          <QualityBar
            recording={recording}
            edit={edit}
            outputDurationMs={outputDurationMs(edit)}
            tier={tier}
            frameAspect={frameAspect}
            onTier={(t) => setChosenId(t.id)}
            onExport={() => void onExport(tier)}
            onExportForAi={() => void onExportAi()}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Leave this recording?"
        message="Keep it and you can reopen it from the takes list on the record screen. Discarding deletes it and its files — that can't be undone."
        confirmLabel="Discard"
        neutralLabel="Keep"
        danger
        onNeutral={() => {
          setConfirmOpen(false)
          // The take stays on disk and stays reachable — mark it dismissed so
          // the next boot does not decide it is the interesting one and drop
          // the user straight back into it (recovery.ts).
          void loadRecovery()
            .then((m) => m.markRecordingDismissed(recording.id))
            .catch(() => undefined)
            .finally(() => useAppStore.getState().resetToCapture())
        }}
        onConfirm={() => void discard()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
