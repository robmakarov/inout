import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createCaptureSession,
  loadCapturePrefs,
  warmCapturePipeline,
  saveCapturePrefs,
  type ArmingTimelineEntry,
} from '@core/capture'
import { CaptureError, MAX_RECORDING_MS } from '@core/types'
import type { CaptureConfig, ChannelKind } from '@core/types'
import { clampEditState, defaultEditState } from '@core/timeline'
import { detectCapabilities } from '@core/capabilities'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { CHANNEL_KINDS, CHANNEL_META, CONFIG_KEY, isKindSupported } from '@app/lib/channels'
import { ChannelChips } from '@app/components/ChannelChips'
import { RecordButton } from '@app/components/RecordButton'
import { TimerPill } from '@app/components/TimerPill'
import { AudioLevelRing } from '@app/components/AudioLevelRing'

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
  const session = useAppStore((s) => s.session)
  const setSession = useAppStore((s) => s.setSession)
  const toast = useAppStore((s) => s.toast)

  const [prefs, setPrefs] = useState<CaptureConfig>(() => loadCapturePrefs())

  // Warm compilers/workers only — devices must NOT activate before the
  // record click (acquire.ts starts them concurrently with the picker).
  useEffect(() => {
    warmCapturePipeline()
  }, [])

  const [arming, setArming] = useState(false)
  const [armingLabel, setArmingLabel] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [remainingMs, setRemainingMs] = useState(MAX_RECORDING_MS)
  const [muted, setMuted] = useState<Partial<Record<ChannelKind, boolean>>>({})
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
      setMuted({})
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
        case 'channel-ended':
          toast(`${CHANNEL_META[e.kind].label} ended`)
          break
        case 'channel-error':
          toast(e.message, 'error')
          break
        case 'channel-late-join':
          toast(`${CHANNEL_META[e.kind].label} joined late — this take will use full render on export`)
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

  const startRecording = async () => {
    setArming(true)
    setArmingLabel('Starting…')
    try {
      const s = await createCaptureSession(effectiveConfig, {
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
      setMuted({})
      setSession(s)
      analytics.track('record_start', {
        screen: prefs.screen,
        camera: prefs.camera,
        mic: prefs.mic,
        systemAudio: prefs.systemAudio,
      })
    } catch (err) {
      if (err instanceof CaptureError) toast(err.message, 'error')
      else toast('Could not start recording', 'error')
    } finally {
      setArming(false)
      setArmingLabel(null)
    }
  }

  const toggleChip = (kind: ChannelKind) => {
    if (session) {
      const nextMuted = !muted[kind]
      session.setAudioEnabled(kind, !nextMuted)
      setMuted((m) => ({ ...m, [kind]: nextMuted }))
    } else {
      const key = CONFIG_KEY[kind]
      const next = { ...prefs, [key]: !prefs[key] }
      setPrefs(next)
      saveCapturePrefs(next)
    }
  }

  const anyOn = CHANNEL_KINDS.some((k) => prefs[CONFIG_KEY[k]] && isKindSupported(k, caps))
  const degraded = !caps.screenCapture || !caps.webCodecs
  // Platform-honest, actionable copy — no vague "use Chrome" when the real
  // limit is Apple's (and screen capture on iOS is a native-app-only feature).
  const platformNotice = caps.ios
    ? 'On iPhone & iPad, Apple allows screen recording only to native apps — camera, mic and audio-only work here.'
    : caps.appleWebKit && !caps.systemAudioCapture
      ? 'Safari can’t capture tab or system audio (Apple limit) — screen, camera and mic work. Use Chrome for tab audio.'
      : degraded
        ? 'Best experienced in Chrome'
        : null

  const screenStream = session?.previewStreams.screen
  const cameraStream = session?.previewStreams.camera
  const audioStream = session?.previewStreams.mic ?? session?.previewStreams['system-audio']
  const audioOnly = !!session && !screenStream && !cameraStream
  const recording = !!session

  return (
    <div className={`capture${recording ? ' capture--recording' : ''}`}>
      {!session && <div className="capture__wordmark">INOUT</div>}
      {!session && platformNotice && (
        <div className="capture__notice">{platformNotice}</div>
      )}
      {arming && armingLabel && <div className="capture__arming">{armingLabel}</div>}
      {session && <TimerPill elapsedMs={elapsedMs} remainingMs={remainingMs} />}

      <div className="capture__stage">
        {/* PO 2026-07-16: single live preview while recording, ALL surfaces.
            Full-monitor capture shows a mirror tunnel if this window is on the
            captured screen — cosmetic, standard (OBS does the same), PO-accepted. */}
        {screenStream && (
          <StreamVideo
            stream={screenStream}
            className={`capture__screen${recording ? ' capture__screen--live' : ''}`}
          />
        )}
        {recording && screenStream && !cameraStream && audioStream && (
          <div className="capture__rec-audio capture__rec-audio--overlay">
            <AudioLevelRing stream={audioStream} />
          </div>
        )}
        {cameraStream && (
          <StreamVideo
            stream={cameraStream}
            className={
              recording || screenStream ? 'capture__pip' : 'capture__camera-full'
            }
          />
        )}
        {audioOnly &&
          (audioStream ? (
            <AudioLevelRing stream={audioStream} />
          ) : (
            <div className="audio-pill">Recording audio</div>
          ))}
      </div>

      <div className="controlbar">
        <ChannelChips
          prefs={prefs}
          caps={caps}
          recording={!!session}
          muted={muted}
          onToggle={toggleChip}
        />
        <RecordButton
          recording={!!session}
          arming={arming}
          disabled={!session && !anyOn}
          onClick={() => (session ? void finishRecording() : void startRecording())}
        />
        {!session && !anyOn && <div className="controlbar__hint">Turn on an input to record</div>}
      </div>
    </div>
  )
}
