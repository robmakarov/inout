import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditState, Recording } from '@core/types'
import { clampEditState, outputDurationMs } from '@core/timeline'
import type { TightenProposal } from '@core/timeline'
import {
  defaultTierForTake,
  tierIsComposite,
  resolveTier,
  settingsForTier,
  tiersForTake,
  type QualityTier,
} from '@core/compose/quality'
import { frameAspectFor, sourceFrameEnabled } from '@core/frame'
import { takeRate } from '@core/rate'
import { cancelPrerender, editBindsPrerender, exportWouldRender } from '@core/compose'
import { cancelEditRender, noteEditorEdit } from '@core/compose/editRender'
import { holdEditorAhead, noteEditingActivity } from '@core/backgroundWork'
import { startEditorLateness } from '@core/lateness'
import { prerenderEnabled } from '@core/compose/prerenderFlag'
import { loadRecovery } from '@core/capture'
import { editsRepo, recordingsRepo } from '@core/store'
import { useAppStore } from '@app/state/store'
import { loadExportJobs } from '@app/lib/exportJobs'
import { detectCapabilities } from '@core/capabilities'
import {
  lostChannelsMessages,
  missingChannelsMessage,
  seamMessages,
  takeLosses,
} from '@app/lib/channels'
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
  /**
   * OPENING THE EDITOR OUTRANKS THE BACKGROUND RENDER (backgroundWork.ts,
   * EDITOR_OPENING_MAX_MS). At the end of a long take the at-stop pre-render is
   * already running flat out on the same decoder this screen needs to show its
   * first frame, and Robert saw the result as a black screen. The hold is taken
   * on mount and let go as soon as the preview has its sources and the browser
   * has had a frame to paint them — the LANE ART takes a hold of its own (E3),
   * so the render stays behind whichever of the two finishes last.
   */
  const previewHold = useRef<(() => void) | null>(null)
  useEffect(() => {
    previewHold.current = holdEditorAhead('the editor preview')
    return () => {
      previewHold.current?.()
      previewHold.current = null
    }
  }, [recording.id])
  /**
   * G7 — HOW LATE THIS THREAD RUNS IN THE EDITOR'S FIRST 15 SECONDS.
   *
   * The window Phase 1's "no editor stall > 30 ms" is claimed over, and the one
   * B10 lives in: the export panel encodes 300 frames on THIS thread about 11 s
   * after the editor opens. Stops itself; read afterwards with
   * `__inoutEditorReport()`. Agent/dev surface only — nothing here renders.
   */
  useEffect(() => startEditorLateness(recording.id), [recording.id])
  useEffect(() => {
    if (!pb.ready) return
    // Two frames: one for React to commit the elements, one for the browser to
    // paint them. Anything sooner hands the machine back before the picture is
    // actually up.
    const a = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        previewHold.current?.()
        previewHold.current = null
      }),
    )
    return () => cancelAnimationFrame(a)
  }, [pb.ready])
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
  /** H4: the kinds whose only story is "it never arrived" — the ones the loss
   *  ledger has a more specific sentence for are handled below. */
  const missingOnly = useMemo(
    () => (recording.missing ?? []).filter((k) => !(recording.lost ?? []).some((l) => l.kind === k)),
    [recording],
  )
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
    const picked = chosenId ? tiers.find((t) => t.id === chosenId) : undefined
    // F16b moved the default out of this component and into quality.ts: the
    // pre-render started at STOP has to resolve the same step this panel will,
    // or the export it made is a file nobody asks for.
    return picked ?? defaultTierForTake(recording, frameAspect)
  }, [tiers, chosenId, recording, frameAspect])
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

  /**
   * Persist the edit so a refresh gives the work back (F4). Debounced: a drag
   * produces one commit, but a trim handle produces a stream of them, and the
   * durable writer is busy enough during a take.
   *
   * B10 — AND IT WAITS FOR AN IDLE MOMENT, because the debounce alone put it in
   * the worst one. G7's attribution named this callback twice: 297.9 ms of
   * animation frame with 178.1 ms of BLOCKING, 316 ms into a drag, on the run
   * whose worst second was 619.5 ms. The write itself is small — `EditState` is
   * trims, segments and keyframes — so the cost is the IndexedDB transaction
   * committing against whatever else is writing (the at-stop render streams
   * chunk files while the editor is open). Nothing about that is worth a frame
   * the person is dragging through.
   *
   * The same writes, with the same data, scheduled when the thread is free. The
   * 2 s timeout is the promise that "free" cannot mean "never" — a busy editor
   * still persists, just behind the interaction instead of through it. Both
   * handles are cancelled on unmount, exactly as the bare timer was.
   */
  useEffect(() => {
    let idle: number | null = null
    const t = setTimeout(() => {
      const write = (): void => {
        void editsRepo.save(edit).catch((err) => console.warn('failed to persist edit', err))
      }
      const ric = (globalThis as { requestIdleCallback?: typeof requestIdleCallback })
        .requestIdleCallback
      if (ric) idle = ric(write, { timeout: 2000 })
      else write()
    }, 400)
    return () => {
      clearTimeout(t)
      const cic = (globalThis as { cancelIdleCallback?: typeof cancelIdleCallback })
        .cancelIdleCallback
      if (idle !== null && cic) cic(idle)
    }
  }, [edit])

  /**
   * THE EDIT HE MADE IS RENDERED WHILE HE MAKES THE NEXT ONE — task J5, Robert
   * 2026-09-04 (robert (27)): "kill the glued copy encoding and do background
   * render while editing", and the order is part of that ruling — this lands
   * before the composite's encoder comes out (J6), because without a pre-made
   * file an unedited camera take would lose instant export.
   *
   * IT IS NOT THE ONE HE DELETED (robert (23), "it goes back and forth and it
   * wastage of resourses"). F16's version rendered the whole take from zero and
   * threw all of it away on the next edit. Since J1 the render is content-keyed
   * chunks, so a superseded job loses the 2.5 s chunk it was inside and every
   * other chunk it finished stays on disk and is reused — by the next job and
   * by the press. Same trigger, bounded waste.
   *
   * FOUR THINGS HAPPEN HERE, and only one of them starts work:
   *  · `noteEditorEdit` (compose/editRender.ts) is the ONE door to a background
   *    render. It holds the rules and is unit-pinned: opening a take starts
   *    nothing, an undo back to the take as it opened starts nothing and
   *    cancels what was pending, an export that would be a packet copy starts
   *    nothing, and a real edit starts one 1.2 s after it settles.
   *  · `editBindsPrerender` still STOPS a running job when an edit makes its
   *    output unservable — the job stops instead of spending the machine on a
   *    file the key would never let anyone serve, and since J1 stopping costs
   *    one chunk.
   *  · a take whose export is a packet copy or a smart cut cancels the job
   *    outright, because those paths are already instant.
   *  · the whole thing is braked by `?bgpace=`, which this screen already feeds
   *    (`holdEditorAhead` / `noteEditingActivity`): a trickle while the
   *    editor is opening, a trickle while a hand is on it, paused beside a live
   *    take. The render is supposed to make progress while someone reviews a
   *    take; what it may never do is make the hand stutter.
   */
  useEffect(() => {
    if (!prerenderEnabled()) return
    const chosen = resolveTier(tier, frameAspect, frameRate)
    const settings = settingsForTier(chosen)
    const wouldRender = exportWouldRender({
      recording,
      edit,
      settings,
      // The same geometry question the export press asks, or the pre-render
      // would decide to render a take whose export is a packet copy.
      allowPacketCopy: tierIsComposite(recording, chosen),
    })
    editBindsPrerender({ recording, edit, settings })
    if (!wouldRender) cancelPrerender()
    noteEditorEdit({ recording, edit, settings, wouldRender })
  }, [recording, edit, tier, frameAspect, frameRate])

  // A take that is left behind takes its pre-render with it: the file is for an
  // export nobody is going to ask for now — and the schedule goes with it, or
  // the next editor would open onto a render aimed at the take it replaced.
  useEffect(
    () => () => {
      cancelEditRender()
      cancelPrerender()
    },
    [recording.id],
  )

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
    // A step may copy the COMPOSITE when it asks for the composite's own
    // GEOMETRY — not when it happens to be named `1080p`, which is the question
    // this used to ask and the reason an unedited 2560x1662 take re-rendered
    // (quality.ts `tierIsComposite`). A single raw channel that already holds
    // the chosen step's geometry is still copyable at any step (O3c) —
    // choose.ts answers that itself.
    // The step at THIS take's shape — the decoder's answer where there is one,
    // so the file matches the stage the user just judged it on (F13).
    const resolved = resolveTier(chosen, frameAspect, frameRate)
    const defaultTier = tierIsComposite(recording, resolved)
    const settings = settingsForTier(resolved)
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
    <div
      className="editor"
      style={{ '--stage-ar': frameAspect } as React.CSSProperties}
      /**
       * F16b — A HAND ON THE EDITOR OUTRANKS THE BACKGROUND RENDER.
       *
       * Robert's order is CAPTURE > EDITING > BACKGROUND RENDER, and until
       * this line the middle term was not implemented anywhere: the job ran
       * flat out beside somebody dragging a playhead. Measured in a real
       * visible editor before it existed, the steady drag was fine (p95
       * scheduling lateness 1.4-1.5 ms alone against 2.2-3.2 ms beside the
       * render) but the FIRST seek of a drag stalled 35-201 ms in four of
       * seven runs — the player's decoder starting against a render that is
       * saturating the same path.
       *
       * Capture phase, and pointerdown/move only: it must fire before any
       * handler that might stop propagation, and it must not depend on which
       * control was grabbed. The broker throttles itself back up 700 ms after
       * the hand stops, so nothing here has to say when editing ENDS.
       */
      onPointerDownCapture={noteEditingActivity}
      onPointerMoveCapture={noteEditingActivity}>
      {/* H4: a kind that is BOTH missing and certified lost gets the specific
          sentence only. "The device never connected" is the right line for a
          camera that was never granted or never appeared, and the wrong one
          for a camera that connected, stayed connected, and delivered nothing
          — it sends the user to the cable when the lid is shut. */}
      {missingOnly.length ? (
        <div className="editor__missing" role="alert">
          {missingChannelsMessage(missingOnly, detectCapabilities())}
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
      {/* H1 — WHERE THIS TAKE SURVIVED A COMPONENT DEATH. Same class as the
          loss lines above and not behind test mode for the same reason: the
          ledger is written only when an encoder, a worker or a recorder
          actually fell over mid-take, so it cannot fire on a healthy take. It
          is also the only place the hole is visible at all — every consumer
          composes a kind's segments into one continuous lane, which is the
          behaviour that keeps the take usable and the behaviour that hides
          what it cost. */}
      {recording.seams?.length
        ? seamMessages(recording.seams, detectCapabilities()).map((sm, i) => (
            <div key={`${sm.kind}-seam-${i}`} className="editor__missing" role="alert">
              {sm.message}
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
          onScrubStart={pb.scrubStart}
          onScrubEnd={pb.scrubEnd}
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
