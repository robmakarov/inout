import { useEffect, useMemo, useRef, useState } from 'react'
import {
  loadCaptureEngine,
  loadCapturePrefs,
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

const ARMING_LABEL: Record<ArmingTimelineEntry['step'], string> = {
  display: 'Waiting for screen…',
  camera: 'Waiting for camera…',
  mic: 'Waiting for microphone…',
  'system-audio': 'Waiting for system audio…',
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

  const [arming, setArming] = useState(false)
  const [armingLabel, setArmingLabel] = useState<string | null>(null)
  /** Lets the record button cancel a start that is taking too long. */
  const armAbortRef = useRef<AbortController | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
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
        case 'state':
          break
      }
    })
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
    setArming(true)
    setArmingLabel('Starting…')
    try {
      // Already fetched by warmCapturePipeline() at mount — this resolves from
      // the module cache, so the click path gains no network round-trip (O7).
      const { createCaptureSession } = await loadCaptureEngine()
      const s = await createCaptureSession(effectiveConfig, {
        signal: ac.signal,
        onArming: (e) => {
          if (e.status === 'start') setArmingLabel(ARMING_LABEL[e.step])
          else if (e.status === 'timeout') {
            setArmingLabel(`${ARMING_LABEL[e.step].replace('…', '')} timed out`)
          }
        },
      })
      setArmingLabel('Starting recorders…')
      s.start()
      setElapsedMs(0)
      setRemainingMs(MAX_RECORDING_MS)
      setOff({})
      setPending({})
      setStalled([])
      setSession(s)
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
      else if (err instanceof CaptureError) toast(err.message, 'error')
      else toast('Could not start recording', 'error')
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
          {/* Live WYSIWYG of the final 16:9 composition — the very same stage
              the editor and export use, so the frame the user sees while
              recording is exactly where the editable video lands next.
              Full-monitor capture can show a mirror tunnel if this window is on
              the captured screen — cosmetic, standard (OBS does the same). */}
          <div className="stage">
            {screenStream && <StreamVideo stream={screenStream} className="stage__screen" />}
            {cameraStream && (
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
