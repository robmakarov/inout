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
import { cancelPrerender, exportWouldRender, startPrerender } from '@core/compose'
import { prerenderEnabled } from '@core/compose/prerenderFlag'
import { loadRecovery } from '@core/capture'
import { editsRepo, recordingsRepo } from '@core/store'
import { useAppStore } from '@app/state/store'
import { loadExportJobs } from '@app/lib/exportJobs'
import { detectCapabilities } from '@core/capabilities'
import { lostChannelsMessages, missingChannelsMessage, takeLosses } from '@app/lib/channels'
import { usePlayback } from '@app/hooks/usePlayback'
import { Player } from '@app/components/Player'
import { Timeline } from '@app/components/Timeline'
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
   * is untouched by this path. A JOB like the video export: the press returns
   * immediately and the dock carries it from here.
   */
  const onExportAi = async () => {
    const effectiveEdit = useAppStore.getState().editState ?? edit
    const m = await loadExportJobs()
    m.startExportJob({ kind: 'ai', recording, edit: effectiveEdit, allowPacketCopy: false })
  }

  /**
   * THE PRESS CREATES A JOB, NOT A MODE (2026-08-30, Robert: rendering
   * "happening further if i switch app screen, independetly, and i want it
   * sirvive refresh and continue, and several rendering at the same time").
   * The editor never locks: the job snapshotted the edit at the press, so a
   * change made now simply belongs to the NEXT export. The dock at the bottom
   * of every screen carries the progress, the cancel that actually cancels,
   * and the saved row; the download still fires the moment the job finishes
   * (UI1: pressing Export IS asking for the file). The ladder itself lives in
   * compose/choose.ts — the oracle drives the same function, so the sync band
   * gates the path a user actually gets.
   */
  const onExport = async (chosen: QualityTier) => {
    // Only the default tier may copy the COMPOSITE: any other tier is a
    // different resolution, so the recorded composite is not it. A single raw
    // channel that already holds the chosen tier's geometry is still
    // packet-copyable at any tier (O3c) — choose.ts answers that itself.
    const defaultTier = isDefaultTier(chosen)
    // The step at THIS take's shape — the decoder's answer where there is one,
    // so the file matches the stage the user just judged it on (F13).
    const settings = settingsForTier(resolveTier(chosen, frameAspect, frameRate))
    const effectiveEdit = useAppStore.getState().editState ?? edit
    const m = await loadExportJobs()
    m.startExportJob({
      kind: 'video',
      recording,
      edit: effectiveEdit,
      settings,
      allowPacketCopy: defaultTier,
    })
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
      {/* H4 — WHAT THIS TAKE LOST WHILE IT RAN, AND WHEN. Not behind test mode,
          for the same reason the missing-channel line above is not: a ledger
          entry cannot exist on a healthy take (it is written only when a track
          ended mid-take or a source delivered nothing at all), so this can
          never be the banner-on-a-good-take that got the audio diagnostics
          gated. It is also the only place the instant is recoverable — the
          file plays back as good minutes followed by nothing. */}
      {recording.lost?.length
        ? lostChannelsMessages(recording.lost, detectCapabilities()).map((l) => (
            <div key={`${l.kind}-lost`} className="editor__missing" role="alert">
              {l.message}
            </div>
          ))
        : null}
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
          They stay LIVE while a render runs: the job snapshotted the edit at
          the press, so an edit made now belongs to the next export — the dock
          row carries the running one wherever the user goes. */}
      <div className="editor__below">
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

      {/* UI1: the quality slider is always on screen — there is no "choose
          a quality" step any more, because the choice was already made
          before the take and this only lets you go down from it. The export's
          progress and result live in the ExportDock now, not in this slot. */}
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
