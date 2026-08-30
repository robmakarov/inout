import { useEffect, useMemo, useRef, useState } from 'react'
import {
  displayRequestLevel,
  loadCaptureEngine,
  loadCapturePrefs,
  resetDisplayWedge,
  warmCapturePipeline,
  saveCapturePrefs,
  type ArmingTimelineEntry,
} from '@core/capture'
import { CaptureError, MAX_RECORDING_MS } from '@core/types'
import type { CaptureConfig, ChannelKind } from '@core/types'
import { clampEditState, defaultEditState } from '@core/timeline'
import { detectCapabilities } from '@core/capabilities'
import { evaluateSupport } from '@core/platform'
import { analytics } from '@core/analytics'
import { DEFAULT_FRAME_ASPECT, aspectOf, frameForAspect, sourceFrameEnabled } from '@core/frame'
import { prefetchEditorChunk } from '@app/editorChunk'
import { useInstallPrompt } from '@app/hooks/useInstallPrompt'
import { useAppStore } from '@app/state/store'
import {
  CHANNEL_KINDS,
  CHANNEL_META,
  CONFIG_KEY,
  isKindSupported,
  unsupportedReason,
} from '@app/lib/channels'
import { armingLabel as armingLabelFor, foldWaiting } from '@app/lib/arming'
import { noteWedgeReload, shouldReloadForWedge, takeWedgeReloadNotice } from '@app/lib/wedgeReload'
import { ChannelChips } from '@app/components/ChannelChips'
import { RecordButton } from '@app/components/RecordButton'
import { TimerPill } from '@app/components/TimerPill'
import { AudioLevelRing } from '@app/components/AudioLevelRing'
import { Icon } from '@app/components/Icon'

function StreamVideo({ stream, className }: { stream: MediaStream; className: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  return <video ref={ref} className={className} autoPlay muted playsInline />
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

  /**
   * IS THIS MACHINE IN REDUCED MODE, and can the user get out of it (W1 item
   * 4)? Before W1 the only exit from the safe-mode ladder was a 24 h timer or
   * a localStorage line typed into a console — Robert was handed that line and
   * answered "what the fuck is this?". Read once at mount and after every
   * attempt, because the rung only ever moves inside one.
   */
  const [reducedRung, setReducedRung] = useState(0)
  useEffect(() => setReducedRung(displayRequestLevel()), [])

  // The recovery ritual's second half (wedgeReload.ts): this page just
  // refreshed itself over a wedged screen share — say so, and what to do NEXT
  // TIME, because a user who never presses record again never reaches the
  // second wedge that owns the ⌘Q text.
  useEffect(() => {
    if (takeWedgeReloadNotice()) {
      setWedgeNotice(
        'The screen share got stuck, so the app refreshed itself. Press record to try again — ' +
          'if it sticks again, quit Chrome completely (⌘Q) and reopen it.',
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
  /** F6: the take is held, devices still armed. Drives the pause control and
   *  the recording indicator; the elapsed counter simply stops advancing,
   *  because the session stops counting time nobody is recording. */
  const [paused, setPaused] = useState(false)
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
        if (err.reason === 'wedged' || err.reason === 'permission') setWedgeNotice(err.message)
        else toast(err.message, 'error')
      } else toast('Could not start recording', 'error')
    } finally {
      armAbortRef.current = null
      setArming(false)
      setArmingLabel(null)
      // A wedge steps the rung down and a success climbs it back (W1) — either
      // way the affordance below has to agree with storage after every press.
      setReducedRung(displayRequestLevel())
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

  return (
    <div className={`capture${recording ? ' capture--recording' : ''}`}>
      {!session && <div className="capture__wordmark">INOUT</div>}
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
      {!session && (wedgeNotice || reducedRung > 0) && (
        <div className="capture__unsupported" role="alert">
          {wedgeNotice ??
            'Screen sharing is running in reduced mode after a stuck share. Nothing you chose ' +
              'is missing — it clears itself after a good take, or you can clear it now.'}
          {reducedRung > 0 && (
            <div className="capture__notice-actions">
              {/* THE BUTTON MUST NOT PROMISE WHAT NO PAGE CAN DO — Robert,
                  2026-08-30: "reset screen sharing button dont fixes it i still
                  need to relaunch chrome". It was labelled "Reset screen
                  sharing", which reads as "unstick my screen sharing", and all
                  it can actually do is clear OUR reduced mode. The stuck claim
                  lives in Chrome's browser process and survives a refresh and a
                  tab close (docs/SCREEN_WEDGE.md); only quitting Chrome clears
                  it. So the control now says what it is, and the sentence next
                  to it says what the user actually has to do. */}
              <button
                type="button"
                className="capture__notice-btn"
                onClick={() => {
                  resetDisplayWedge()
                  setReducedRung(0)
                  setWedgeNotice(null)
                  toast('Reduced mode cleared — the next take asks for full quality')
                }}
              >
                Clear reduced mode
              </button>
              <span className="capture__notice-aside">
                Screen still stuck? That part is Chrome’s, not ours — quit Chrome completely
                (⌘Q) and reopen. Nothing on this page can release it.
              </span>
            </div>
          )}
        </div>
      )}
      {arming && armingLabel && <div className="capture__arming">{armingLabel}</div>}
      {session && <TimerPill elapsedMs={elapsedMs} remainingMs={remainingMs} />}
      {recording && stalled.length > 0 && (
        <div className="capture__stalled" role="alert">
          {stalled.map((k) => CHANNEL_META[k].label).join(' & ')} frozen — recording a still image.
          Re-share your whole screen to fix it.
        </div>
      )}

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
                className={screenStream ? 'stage__pip' : 'stage__full'}
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

      <div className="controlbar">
        <ChannelChips
          prefs={prefs}
          caps={caps}
          recording={!!session}
          off={off}
          pending={pending}
          onToggle={toggleChip}
        />
        {/* F6: only while a take is running, and never while arming — a
            half-started take has nothing to hold. */}
        {session && !arming && (
          <button
            className={`pausebtn${paused ? ' pausebtn--resume' : ''}`}
            onClick={() => (paused ? session.resume() : session.pause())}
            aria-label={paused ? 'Resume recording' : 'Pause recording'}
            title={
              paused
                ? 'Resume — your inputs stayed connected'
                : 'Pause — nothing is released, and the pause is left out of the recording'
            }
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
        )}
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
