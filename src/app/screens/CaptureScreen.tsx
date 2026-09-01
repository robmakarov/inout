import { useEffect, useMemo, useRef, useState } from 'react'
import {
  loadCaptureEngine,
  loadCapturePrefs,
  warmCapturePipeline,
  saveCapturePrefs,
  consecutiveDisplayStalls,
  displayStallMessage,
  ESCALATE_AT_STALLS,
  type ArmingTimelineEntry,
} from '@core/capture'
import { CaptureError, MAX_RECORDING_MS } from '@core/types'
import type { CaptureConfig, ChannelKind } from '@core/types'
import { clampEditState, defaultEditState } from '@core/timeline'
import { detectCapabilities } from '@core/capabilities'
import { detectPlatform, evaluateSupport } from '@core/platform'
import { analytics } from '@core/analytics'
import { DEFAULT_FRAME_ASPECT, aspectOf, frameForAspect, sourceFrameEnabled } from '@core/frame'
import { clampPose, defaultCameraPose, poseToRect, type CameraGeometry } from '@core/timeline'
import type { CameraPose } from '@core/types'
import { prefetchEditorChunk } from '@app/editorChunk'
import { useInstallPrompt } from '@app/hooks/useInstallPrompt'
import {
  QUALITY_STEPS,
  loadQualityStep,
  setQualityStep,
  type QualityStepId,
} from '@core/qualityStep'
import { useAppStore } from '@app/state/store'
import {
  CHANNEL_KINDS,
  CHANNEL_META,
  CONFIG_KEY,
  isKindSupported,
  unsupportedReason,
} from '@app/lib/channels'
import { armingLabel as armingLabelFor, foldWaiting } from '@app/lib/arming'
import {
  WEDGE_RELOAD_WINDOW_MS,
  noteWedgeReload,
  shouldReloadForWedge,
  takeWedgeReloadNotice,
  wedgeReloadStamp,
} from '@app/lib/wedgeReload'
import { appendWedgeJournal } from '@core/capture/wedgeJournal'
import { ChannelChips } from '@app/components/ChannelChips'
import { QualitySlider } from '@app/components/QualitySlider'
import { TakesList } from '@app/components/TakesList'
import { testPanelEnabled } from '@app/lib/testPanel'
import { lazy, Suspense } from 'react'

/* Lazily loaded so it costs the first-paint chunk nothing for everyone who is
   not testing (O7) — Robert's one link, `/?test`, is what turns it on. */
const TestPanel = lazy(() =>
  import('@app/components/TestPanel').then((m) => ({ default: m.TestPanel })),
)
import { RecordButton } from '@app/components/RecordButton'
import { TimerPill } from '@app/components/TimerPill'
import { AudioLevelRing } from '@app/components/AudioLevelRing'
import { Icon } from '@app/components/Icon'

function StreamVideo({
  stream,
  className,
  style,
}: {
  stream: MediaStream
  className: string
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  return <video ref={ref} className={className} style={style} autoPlay muted playsInline />
}

const STEP_NOUN: Record<ArmingTimelineEntry['step'], string> = {
  display: 'screen',
  camera: 'camera',
  mic: 'microphone',
  'system-audio': 'system audio',
}

/** The aspect of a live preview stream's video track, or null when it has none
 *  yet (the track exists before its first frame settles the dimensions). */
function liveTrackAspect(stream: MediaStream | undefined): number | null {
  const t = stream?.getVideoTracks()[0]
  if (!t) return null
  const st = t.getSettings()
  return aspectOf(st.width, st.height)
}

export function CaptureScreen() {
  const caps = useMemo(() => detectCapabilities(), [])
  /** Silent on every browser that passes the probes — a below-floor build is
   * the only case that gets a line, because it fails in ways an error toast
   * cannot explain ("nothing happened"). P3. */
  const support = useMemo(() => evaluateSupport(), [])
  const session = useAppStore((s) => s.session)
  const setSession = useAppStore((s) => s.setSession)
  const toast = useAppStore((s) => s.toast)

  const [prefs, setPrefs] = useState<CaptureConfig>(() => loadCapturePrefs())
  /**
   * UI1 — THE QUALITY CEILING, CHOSEN BEFORE THE TAKE.
   *
   * It is not a label: it bounds what capture ASKS FOR (frame.ts's
   * `captureCeilingLongEdge`, rate.ts's ceiling) and it is stamped on the
   * finished take, which caps the export ladder afterwards. So it can only be
   * moved while nothing is running — a ceiling changed mid-take would describe
   * a file that was already written under the old one.
   */
  const [step, setStep] = useState<QualityStepId>(() => loadQualityStep())
  const installer = useInstallPrompt()

  // Warm compilers/workers only — devices must NOT activate before the
  // record click (acquire.ts starts them concurrently with the picker).
  useEffect(() => {
    warmCapturePipeline()
  }, [])

  /**
   * What the wedge ritual has to say, held on screen until the user acts on it
   * (Robert 2026-08-25: after a wedge with a 4K game running, "no message about
   * that i need to reload chrome"). A TOAST CANNOT CARRY THIS: it expires in
   * 4 s, and the user who just wedged a share is watching the tab they were
   * recording — the same reason the frozen-source banner is sticky. It also
   * has to survive a boot slowed by whatever saturated the machine, which is
   * why the notice is now an owed flag rather than a 15 s window.
   */
  const [wedgeNotice, setWedgeNotice] = useState<string | null>(null)
  /*
   * THERE IS NO "REDUCED MODE" FOR THE USER TO MANAGE — Robert, 2026-08-30:
   * "why there is still button clear reduced mode? no reduced mode we agreed,
   * auto coming back to max when ready". W1 added a banner and a Clear button
   * because the ladder used to be a one-way ratchet with a 24 h timer, and the
   * only escape anyone had found was a console line. Now that a rung is earned
   * clear by consecutive good takes (displayWedge.ts), there is nothing to
   * escape from, and a banner about a self-healing internal state is just a
   * mode the user did not ask to be given. The safe-mode request is invisible
   * by construction — no rung drops anything the user chose — so it should be
   * invisible in the interface too.
   */

  // The recovery ritual's second half (wedgeReload.ts): this page just
  // refreshed itself over a wedged screen share — say so, and what to do NEXT
  // TIME, because a user who never presses record again never reaches the
  // second wedge that owns the ⌘Q text.
  // AND THE OTHER HALF OF THE SAME QUESTION: not "was the notice due" but
  // "did this document ever paint". main.tsx writes the boot entry when the
  // bundle runs; this one is written when the UI is on screen, so a script
  // entry with no mount after it is the app coming back from the wedge and
  // never becoming usable — the report that has gone unconvicted twice
  // (wedgeJournal.ts).
  useEffect(() => {
    const at = wedgeReloadStamp()
    if (at && Date.now() - at < WEDGE_RELOAD_WINDOW_MS) {
      appendWedgeJournal({ kind: 'boot', phase: 'mount', sinceReloadMs: Math.round(Date.now() - at) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (takeWedgeReloadNotice()) {
      // AND SAY THE TRUE THING ON THE WAY BACK. The refresh notice used to end
      // in "quit Chrome (⌘Q)" every single time, which is the right next step
      // exactly once. By the third stall in a row that sentence has been tried
      // and disproved, so the message the user is handed after the refresh has
      // to be the escalated one — this is the screen they are actually reading
      // when they decide what to do next.
      const stalls = consecutiveDisplayStalls()
      setWedgeNotice(
        stalls >= ESCALATE_AT_STALLS
          ? displayStallMessage('wedge', detectPlatform().browser, 'failed', stalls)
          : 'The screen share got stuck, so the app refreshed itself. Press record to try again.',
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [arming, setArming] = useState(false)
  const [armingLabel, setArmingLabel] = useState<string | null>(null)
  /** Lets the record button cancel a start that is taking too long. */
  const armAbortRef = useRef<AbortController | null>(null)
  /** Devices still outstanding this arm, in start order — a ref, because the
   *  acquisition callback fires faster than a render and must not miss edges. */
  const waitingRef = useRef<ArmingTimelineEntry['step'][]>([])
  const [elapsedMs, setElapsedMs] = useState(0)
  /** F6: the take is held, devices still armed. The elapsed counter simply
   *  stops advancing, because the session stops counting time nobody is
   *  recording. UI1 removed the button that reached this from here (see the
   *  control bar); the state is kept because the ENGINE can still pause — the
   *  browser's own "Stop sharing" and the wedge paths both go through it — and
   *  the timer must not run through a hold it did not ask for. */
  const [, setPaused] = useState(false)
  const [remainingMs, setRemainingMs] = useState<number | null>(MAX_RECORDING_MS)
  /** Inputs turned off mid-take — by the user's chip OR by the browser's own
   *  "Stop sharing", which lands here through the same 'channel-ended' event. */
  const [off, setOff] = useState<Partial<Record<ChannelKind, boolean>>>({})
  /** Inputs being re-acquired right now (the screen picker may be open). */
  const [pending, setPending] = useState<Partial<Record<ChannelKind, boolean>>>({})
  /** previewStreams is a live object on the session, so React needs a nudge
   *  when a channel comes or goes — the ticks would get there, a beat late. */
  const [, bumpStreams] = useState(0)
  /** Sources frozen right now — a toast is useless here, the user is in
   * another tab while it happens and only sees this screen on the way back. */
  const [stalled, setStalled] = useState<ChannelKind[]>([])
  /**
   * B5 — IS THERE ROOM FOR THE TAKE ABOUT TO BE MADE.
   *
   * Read on the IDLE screen only, never from the press: instant record start is
   * a frozen constraint and this is a storage query plus an IndexedDB read. It
   * re-asks when the answer could have changed — the quality step, the channels,
   * or a take that just finished and consumed the space. A healthy machine sets
   * nothing and shows nothing (app/lib/diskPreflight.ts).
   */
  const [diskNotice, setDiskNotice] = useState<string | null>(null)
  /**
   * O4-polish: is the COMPOSITOR painting this preview? When it is, the two
   * <video> elements below come down and the sources stop being decoded a
   * second time. False is the normal answer on every engine but v2, and the
   * source preview is what runs until the compositor has proven it can paint —
   * so this can only ever remove decodes, never a picture.
   */
  const [compositePreview, setCompositePreview] = useState(false)
  /** F13: the composite's own geometry, once its engine has seen a frame. */
  const [compositeSize, setCompositeSize] = useState<{ width: number; height: number } | null>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const finishingRef = useRef(false)
  /**
   * UI1 — WHERE THE CAMERA IS, WHILE THE TAKE RUNS. Robert asked to drag the
   * small camera view during recording, and it had never been draggable there:
   * the editor's PiP is a keyframe track over a finished take, and the capture
   * preview only ever drew the default corner.
   *
   * It matters most here and not in the editor, because the thing you are
   * trying not to cover is on screen WHILE you record. Null = the default
   * corner, and a take nobody drags is byte-identical to one made before this.
   */
  const [pipPose, setPipPose] = useState<CameraPose | null>(null)
  useEffect(() => {
    if (!session) setPipPose(null)
  }, [session])
  /** Live gesture. The ref is the truth — a flick can move and release inside
   *  one task, and a state read in the release handler would be stale. */
  const pipDrag = useRef<{
    startX: number
    startY: number
    from: CameraPose
    stageW: number
    stageH: number
  } | null>(null)

  const finishRecording = async () => {
    const s = useAppStore.getState().session
    if (!s || finishingRef.current) return
    finishingRef.current = true
    try {
      const rec = await s.stop()
      if (rec.channels.length === 0) {
        toast('Nothing recorded')
        setSession(null)
      } else {
        const edit = clampEditState(rec, defaultEditState(rec))
        if (rec.missing?.length) {
          toast(
            `Missing from this take: ${rec.missing.map((k) => CHANNEL_META[k].label).join(', ')}`,
            'error',
          )
        }
        analytics.track('record_complete', {
          durationMs: Math.round(rec.durationMs),
          channels: rec.channels.length,
          missing: rec.missing?.length ?? 0,
        })
        useAppStore.setState({
          session: null,
          recording: rec,
          editState: edit,
          mode: 'editor',
        })
      }
    } catch (err) {
      console.error('stop failed', err)
      toast('Could not finish recording', 'error')
      setSession(null)
    } finally {
      finishingRef.current = false
      setArming(false)
      setArmingLabel(null)
      setElapsedMs(0)
      setPaused(false)
      setRemainingMs(MAX_RECORDING_MS)
      setOff({})
      setPending({})
      setStalled([])
    }
  }

  useEffect(() => {
    if (!session) return
    return session.on((e) => {
      switch (e.type) {
        case 'tick':
          setElapsedMs(e.elapsedMs)
          setRemainingMs(e.remainingMs)
          break
        case 'auto-stopped':
          void finishRecording()
          break
        // No toast on either edge: the chip IS the readout, and it stays put
        // instead of flashing past. This is also how the browser's own "Stop
        // sharing" shows up, so that case now darkens the chip too.
        case 'channel-ended':
          setOff((s) => ({ ...s, [e.kind]: true }))
          setPending((s) => ({ ...s, [e.kind]: false }))
          bumpStreams((n) => n + 1)
          break
        case 'channel-late-join':
          setOff((s) => ({ ...s, [e.kind]: false }))
          setPending((s) => ({ ...s, [e.kind]: false }))
          bumpStreams((n) => n + 1)
          break
        case 'channel-error':
          setPending((s) => ({ ...s, [e.kind]: false }))
          toast(e.message, 'error')
          break
        case 'channel-notice':
          toast(e.message)
          break
        case 'channel-stalled':
          setStalled((s) => (s.includes(e.kind) ? s : [...s, e.kind]))
          toast(`${CHANNEL_META[e.kind].label} froze — recording a still image`, 'error')
          break
        case 'channel-resumed':
          setStalled((s) => s.filter((k) => k !== e.kind))
          toast(`${CHANNEL_META[e.kind].label} is live again`)
          break
        case 'composite-geometry':
          // F13: what the compositor is ACTUALLY writing, which is the only
          // honest thing to shape the recording preview by — the track
          // settings this take started from report the sensor, not the picture.
          setCompositeSize({ width: e.width, height: e.height })
          break
        case 'composite-preview':
          // The compositor stopped painting (watchdog degrade, or a late join
          // tore it down). Its canvas would hold its last frame forever.
          setCompositePreview(false)
          break
        case 'state':
          setPaused(e.state === 'paused')
          break
      }
    })
  }, [session])

  /**
   * Hand the canvas over once per take. The canvas is TRANSFERRED to the
   * compositor's worker, so this must run exactly once per element — and the
   * whole preview unmounts between takes, so each take gets a fresh one.
   */
  useEffect(() => {
    if (!session) {
      setCompositePreview(false)
      setCompositeSize(null)
      return
    }
    const canvas = previewCanvasRef.current
    if (!canvas) return
    let cancelled = false
    void session.attachCompositePreview(canvas).then((live) => {
      if (!cancelled) setCompositePreview(live)
    })
    return () => {
      cancelled = true
    }
  }, [session])

  // Never ask the engine for a channel this browser can't deliver: on iOS that
  // means screen + tab-audio are dropped (Apple exposes no screen capture to
  // browsers), on Safari it drops tab audio. Prevents a doomed primary channel.
  const effectiveConfig = useMemo<CaptureConfig>(() => {
    const eff = { ...prefs }
    for (const k of CHANNEL_KINDS) {
      if (!isKindSupported(k, caps)) eff[CONFIG_KEY[k]] = false
    }
    return eff
  }, [prefs, caps])

  useEffect(() => {
    if (session || arming) return
    let cancelled = false
    void (async () => {
      try {
        const [{ recordingsRepo }, preflight, { singleGenCaptureEnabled }] = await Promise.all([
          import('@core/store'),
          import('@app/lib/diskPreflight'),
          import('@core/singleGen'),
        ])
        const takes = await recordingsRepo.list()
        const verdict = await preflight.readPreflight(takes, step, {
          ...effectiveConfig,
          composite: !singleGenCaptureEnabled(),
        })
        if (cancelled) return
        setDiskNotice(verdict?.level === 'low' ? verdict.message : null)
      } catch {
        // A guard that cannot read the disk says nothing. It must never be the
        // reason the capture screen fails to render.
        if (!cancelled) setDiskNotice(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session, arming, step, effectiveConfig])

  const cancelArming = () => {
    armAbortRef.current?.abort()
    setArmingLabel('Cancelling…')
  }

  const startRecording = async () => {
    const ac = new AbortController()
    armAbortRef.current = ac
    waitingRef.current = []
    // The notice asked for exactly this press — it has been acted on.
    setWedgeNotice(null)
    setArming(true)
    setArmingLabel('Starting…')
    try {
      // Already fetched by warmCapturePipeline() at mount — this resolves from
      // the module cache, so the click path gains no network round-trip (O7).
      const { createCaptureSession } = await loadCaptureEngine()
      const s = await createCaptureSession(effectiveConfig, {
        signal: ac.signal,
        // Devices acquire concurrently, so the line has to name what is STILL
        // outstanding — setting it on 'start' alone showed whichever step
        // began last and never cleared, which is how "Waiting for microphone…"
        // stayed on screen for the whole settle budget with a live microphone.
        onArming: (e) => {
          waitingRef.current = foldWaiting(waitingRef.current, e)
          if (e.status === 'timeout') {
            setArmingLabel(`${STEP_NOUN[e.step]} timed out`)
            return
          }
          setArmingLabel(armingLabelFor(waitingRef.current) ?? 'Starting recorders…')
        },
        // THE SCREEN IS LATE AND THE REQUEST IS STILL RUNNING (W1 item 3).
        // Sticky, like every other wedge message: the user is looking at
        // Chrome's picker in another window, and a 4 s toast is exactly the
        // thing that already failed here once.
        onStall: (message) => setWedgeNotice(message),
      })
      // From here the session HOLDS DEVICES and only the store can stop it.
      // Anything that goes wrong before setSession leaves it running with no
      // owner and no button that reaches it — the camera light and the
      // screen-share indicator stay on until the tab is closed. So every exit
      // from this stretch cancels it.
      try {
        // The press that lands in the gap between arm() finishing and the
        // session reaching the store is a CANCEL, not a start. Without this it
        // was swallowed: the user pressed stop and got a recording instead.
        if (ac.signal.aborted) throw new DOMException('Recording start cancelled', 'AbortError')
        setArmingLabel('Starting recorders…')
        s.start()
        setElapsedMs(0)
        setRemainingMs(MAX_RECORDING_MS)
        setOff({})
        setPending({})
        setStalled([])
        setSession(s)
      } catch (err) {
        void s.cancel().catch(() => undefined)
        throw err
      }
      // Recording is live and the user is committed for at least a few
      // seconds — warm the editor chunk now so stop() lands on parsed code.
      prefetchEditorChunk()
      analytics.track('record_start', {
        screen: prefs.screen,
        camera: prefs.camera,
        mic: prefs.mic,
        systemAudio: prefs.systemAudio,
      })
    } catch (err) {
      const cancelled = err instanceof Error && err.name === 'AbortError'
      if (cancelled) toast('Recording start cancelled')
      else if (err instanceof CaptureError) {
        // The recovery ritual (wedgeReload.ts): a wedged screen share fails
        // the take with every device already released, so the app refreshes
        // ITSELF once — fresh renderer, fresh pipes to Chrome's capture
        // service — and comes back saying "press record to try again". A
        // wedge that survives that refresh falls through to the error text,
        // which says the remaining truth: quit Chrome (⌘Q).
        // 'permission' is deliberately NOT in this condition: a refresh
        // cannot change a macOS TCC grant, and spending the one automatic
        // reload on it only throws away the message that names the fix (W1).
        // A DOCUMENT WITH A STUCK REQUEST IN IT IS NOT RETRYABLE, so this one
        // ignores the once-per-window rule that guards the wedge ritual: the
        // rule exists because a refresh MIGHT not cure a wedge, and here the
        // refresh is not a diagnosis at all — the page has an open screen
        // request Chrome will never settle, and replacing the document is the
        // only way to get one that can ask again. Nothing was waited for and
        // nothing was recorded, so it costs the user a blink instead of 30 s.
        // A REQUEST WE HELD BACK, NOT A FAILURE — and the one wedge-shaped
        // reason that must NOT refresh (Robert, 2026-08-30: two tabs recording
        // at once wedges Chrome, and the same collision needs no second tab).
        // The previous request is still pending, so it can still come back on
        // its own; replacing this document is exactly what would orphan it
        // where nothing can ever settle it. Say what happened and stop.
        if (err.kind === 'screen' && err.reason === 'busy') {
          setWedgeNotice(err.message)
          return
        }
        if (err.kind === 'screen' && err.reason === 'stale') {
          noteWedgeReload()
          setWedgeNotice(err.message)
          window.location.reload()
          return
        }
        if (err.kind === 'screen' && err.reason === 'wedged' && shouldReloadForWedge()) {
          noteWedgeReload()
          // reload() only REQUESTS the navigation; the page keeps running until
          // it commits, and on the loaded machine that wedged the share that
          // can take seconds. Say what is happening first, or the app just sits
          // there looking broken — which is exactly what Robert saw.
          setWedgeNotice('The screen share got stuck. Refreshing the app…')
          window.location.reload()
          return
        }
        // A wedge that survived the refresh: this is the ⌘Q text, and it must
        // still be on screen when the user comes back from the other tab.
        if (
          err.reason === 'wedged' ||
          err.reason === 'permission' ||
          err.reason === 'stale' ||
          err.reason === 'busy'
        ) {
          setWedgeNotice(err.message)
        }
        else toast(err.message, 'error')
      } else toast('Could not start recording', 'error')
    } finally {
      armAbortRef.current = null
      setArming(false)
      setArmingLabel(null)
    }
  }

  const toggleChip = (kind: ChannelKind) => {
    // Unusable input: don't toggle — explain why, only now that it was pressed.
    const reason = unsupportedReason(kind, caps)
    if (reason) {
      toast(reason, 'error')
      return
    }
    if (session) {
      // Mid-take this is a real stop/start of the device, not a mute: off
      // releases the hardware and ends that channel's file here, on re-acquires
      // and late-joins a fresh segment. The 'off' flag is set by the resulting
      // 'channel-ended' event rather than optimistically, so the chip always
      // reports what the engine actually did.
      // A kind never armed for this take counts as off, so it can be ADDED
      // mid-take by the same press — it is the same late-join either way.
      const turningOn = off[kind] ?? !prefs[CONFIG_KEY[kind]]
      if (turningOn) setPending((p) => ({ ...p, [kind]: true }))
      session.setChannelActive(kind, turningOn)
    } else {
      const key = CONFIG_KEY[kind]
      const next = { ...prefs, [key]: !prefs[key] }
      setPrefs(next)
      saveCapturePrefs(next)
    }
  }

  const anyOn = CHANNEL_KINDS.some((k) => prefs[CONFIG_KEY[k]] && isKindSupported(k, caps))

  const screenStream = session?.previewStreams.screen
  const cameraStream = session?.previewStreams.camera
  const audioStream = session?.previewStreams.mic ?? session?.previewStreams['system-audio']
  const audioOnly = !!session && !screenStream && !cameraStream
  const recording = !!session
  /**
   * F13: the preview stage IS the composite, so it carries the composite's
   * shape. Read off the live tracks with the same precedence the session uses
   * to size its canvas (screen first, then camera), and scaled to the same
   * 960-long-edge preview budget — the compositor stretches its output into
   * this canvas, so a preview of the wrong aspect is a squashed picture rather
   * than a letterboxed one. 960x540 and 16 / 9 whenever the frame does not
   * follow the source.
   */
  /**
   * F13: the preview stage IS the composite, so it carries the composite's
   * shape — reported by the engine that is writing it, because that is the only
   * source that has looked at a real frame. Until it reports (the first frames
   * of a take) the track settings are the guess, and 960x540 / 16 / 9 whenever
   * the frame does not follow the source at all.
   */
  const previewBox = !sourceFrameEnabled()
    ? { width: 960, height: 540 }
    : compositeSize
      ? frameForAspect(compositeSize.width / compositeSize.height, 960)
      : frameForAspect(
          liveTrackAspect(screenStream) ?? liveTrackAspect(cameraStream) ?? DEFAULT_FRAME_ASPECT,
          960,
        )

  /**
   * UI1 — the PiP's geometry, in the SAME functions the compositor and the
   * editor use (`clampPose` / `poseToRect`). Three renderers, one arithmetic:
   * what is dragged here is what the composite writes and what the editor
   * re-opens on.
   */
  const camGeometry: CameraGeometry = {
    frameAspect: previewBox.width / previewBox.height,
    cameraAspect: liveTrackAspect(cameraStream) ?? 4 / 3,
  }
  const camPose = clampPose(pipPose ?? defaultCameraPose(camGeometry), camGeometry)
  const camRect = poseToRect(camPose, camGeometry)
  const pipStyle: React.CSSProperties = {
    left: `${camRect.leftFrac * 100}%`,
    top: `${camRect.topFrac * 100}%`,
    width: `${camRect.widthFrac * 100}%`,
    height: `${camRect.heightFrac * 100}%`,
  }
  /** The PiP slot only exists when a screen is being composited under it. */
  const pipMovable = !!session && !!cameraStream && !!screenStream

  const beginPipDrag = (e: React.PointerEvent) => {
    const stage = (e.currentTarget as HTMLElement).parentElement
    if (!stage) return
    e.preventDefault()
    const r = stage.getBoundingClientRect()
    pipDrag.current = {
      startX: e.clientX,
      startY: e.clientY,
      from: camPose,
      stageW: Math.max(1, r.width),
      stageH: Math.max(1, r.height),
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // synthetic pointer — capture is a nicety, the gesture still works
    }
  }

  const movePipDrag = (e: React.PointerEvent) => {
    const g = pipDrag.current
    if (!g || !session) return
    const next = clampPose(
      {
        ...g.from,
        xFrac: g.from.xFrac + (e.clientX - g.startX) / g.stageW,
        yFrac: g.from.yFrac + (e.clientY - g.startY) / g.stageH,
      },
      camGeometry,
    )
    setPipPose(next)
    // Sent on every move, not on release: the compositor is what the user is
    // watching, and a PiP that only jumps when you let go is not a drag.
    session.setCameraPose(next)
  }

  const endPipDrag = () => {
    pipDrag.current = null
  }

  return (
    <div className={`capture${recording ? ' capture--recording' : ''}`}>
      {/* UI1: the page's own column. The takes list lives IN it rather than
          floating over the record button — Robert: "show kept videos saved
          above slider, not floating". Bottom-anchored, so one take sits just
          above the controls and twenty scroll. */}
      <div className="capture__body">
      {!session && !arming && installer.canInstall && (
        <div className="capture__install">
          <button className="capture__install-btn" onClick={installer.install}>
            Install INOUT
          </button>
          <button
            className="capture__install-x"
            onClick={installer.dismiss}
            aria-label="Don't ask again"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {!session && !support.ok && support.message && (
        <div className="capture__unsupported" role="alert">
          {support.message}
        </div>
      )}
      {!session && wedgeNotice && (
        <div className="capture__unsupported" role="alert">
          {wedgeNotice}
        </div>
      )}
      {/* B5: only when the machine cannot hold a normal take, and only when it
          is not already saying something more urgent — the notice slot is one
          absolutely-positioned strip and two of them would sit on each other. */}
      {!session && !wedgeNotice && support.ok && diskNotice && (
        <div className="capture__unsupported" role="alert">
          {diskNotice}
        </div>
      )}
      {/* Every take you have, and a way back into one — Robert, 2026-08-30:
          "how th fuck will i open last night take in the editor". He could not,
          and neither could anyone: the app opened the newest recording at boot
          and there was no other route in. */}
      {!session && !arming && <TakesList />}
      {recording && (
        <div className="capture__preview">
          {/* Live WYSIWYG of the final composition — the very same stage
              the editor and export use, so the frame the user sees while
              recording is exactly where the editable video lands next.
              Full-monitor capture can show a mirror tunnel if this window is on
              the captured screen — cosmetic, standard (OBS does the same). */}
          <div
            className="stage"
            style={{ '--stage-ar': previewBox.width / previewBox.height } as React.CSSProperties}
          >
            {/* The compositor's own output, when it can give it (O4-polish):
                one decode for the whole take instead of one for the file and
                one for this. Sized to the composition, not the screen — the
                worker scales into it, and both carry the take's own aspect. */}
            {/* The bitmap size is FIXED here and never re-rendered: this canvas is
                transferred to the compositor worker, and writing width/height on
                a transferred canvas throws. The worker owns the bitmap and turns
                it with the composite (F13); `object-fit: contain` means whatever
                shape it ends up, the picture is never stretched — and the stage
                box below is that shape anyway, so there is nothing to letterbox. */}
            <canvas
              ref={previewCanvasRef}
              width={960}
              height={540}
              className="stage__composite"
              style={compositePreview ? undefined : { display: 'none' }}
            />
            {!compositePreview && screenStream && (
              <StreamVideo stream={screenStream} className="stage__screen" />
            )}
            {!compositePreview && cameraStream && (
              <StreamVideo
                stream={cameraStream}
                className={screenStream ? 'stage__pip stage__pip--posed' : 'stage__full'}
                style={screenStream ? pipStyle : undefined}
              />
            )}
            {/* UI1 — the grab target. It is its own element rather than
                handlers on the video because the composite preview has no video
                to put them on: when the compositor is painting, the PiP is
                pixels in a canvas, and this transparent box is the only thing
                there is to take hold of. Same rect either way. */}
            {pipMovable && (
              <div
                className={`stage__pipdrag${pipDrag.current ? ' is-dragging' : ''}`}
                style={pipStyle}
                onPointerDown={beginPipDrag}
                onPointerMove={movePipDrag}
                onPointerUp={endPipDrag}
                onPointerCancel={endPipDrag}
                title="Drag to move the camera"
              />
            )}
            {screenStream && !cameraStream && audioStream && (
              <div className="stage__audio-badge">
                <AudioLevelRing stream={audioStream} />
              </div>
            )}
            {audioOnly && (
              <div className="stage__audio">
                {audioStream ? (
                  <AudioLevelRing stream={audioStream} />
                ) : (
                  <div className="audio-pill">Recording audio</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
      {!session && testPanelEnabled() && (
        <Suspense fallback={null}>
          <TestPanel />
        </Suspense>
      )}
      {arming && armingLabel && <div className="capture__arming">{armingLabel}</div>}
      {session && <TimerPill elapsedMs={elapsedMs} remainingMs={remainingMs} />}
      {recording && stalled.length > 0 && (
        <div className="capture__stalled" role="alert">
          {stalled.map((k) => CHANNEL_META[k].label).join(' & ')} frozen — recording a still image.
          Re-share your whole screen to fix it.
        </div>
      )}

      <div className="controlbar">
        {/* UI1: fixed above the chips, and only before a take — Robert: "show
            it fixed above chips before record". Locked while arming: the
            ceiling has already been handed to the devices by then. */}
        {!session && (
          <QualitySlider
            stops={QUALITY_STEPS.map((q) => ({ id: q.id, label: q.label }))}
            value={step}
            disabled={arming}
            // UI1, Robert: "remove all three captions near slider in main
            // screen", then "i said delete this shit" at the sentence coming
            // back as a hover tooltip. So it is GONE, not relocated: the step
            // names under the track say which one is chosen, and moving prose
            // the user deleted onto a hover is not removing it. `QualityStep.note`
            // still exists and is still the honest description of a step — it
            // simply has no home on this screen.
            compact
            onChange={(id) => {
              const next = id as QualityStepId
              setStep(next)
              setQualityStep(next)
            }}
          />
        )}
        <ChannelChips
          prefs={prefs}
          caps={caps}
          recording={!!session}
          off={off}
          pending={pending}
          onToggle={toggleChip}
        />
        {/* UI1: NO PAUSE BUTTON. Robert, 2026-08-30: "no need for fucking pause
            button, record pressed - on editing appearing again left to play
            button, if pressed continues where dragger in timeline stands".
            Pausing mid-take is answered by stopping and continuing from the
            editor instead — one control, on the screen where you can see where
            you would be continuing FROM. The session's pause/resume API is
            untouched (F6 still holds the devices); only the button is gone, so
            the continue path has something to build on. */}
        <RecordButton
          recording={!!session}
          arming={arming}
          disabled={!session && !anyOn}
          onClick={() =>
            arming
              ? cancelArming()
              : session
                ? void finishRecording()
                : void startRecording()
          }
        />
        {!session && !anyOn && <div className="controlbar__hint">Turn on an input to record</div>}
      </div>
    </div>
  )
}
