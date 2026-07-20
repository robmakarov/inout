import type { CaptureConfig, ChannelKind } from '@core/types'
import type { Capabilities } from '@core/capabilities'
import type { IconName } from '@app/components/Icon'

export const CHANNEL_META: Record<
  ChannelKind,
  { label: string; icon: IconName; colorVar: string }
> = {
  screen: { label: 'Screen', icon: 'display', colorVar: 'var(--ch-screen)' },
  camera: { label: 'Camera', icon: 'camera', colorVar: 'var(--ch-camera)' },
  mic: { label: 'Mic', icon: 'mic', colorVar: 'var(--ch-mic)' },
  'system-audio': { label: 'Tab Audio', icon: 'waves', colorVar: 'var(--ch-sysaudio)' },
}

export const CHANNEL_KINDS: ChannelKind[] = ['screen', 'camera', 'mic', 'system-audio']

export const CONFIG_KEY: Record<
  ChannelKind,
  keyof Pick<CaptureConfig, 'screen' | 'camera' | 'mic' | 'systemAudio'>
> = {
  screen: 'screen',
  camera: 'camera',
  mic: 'mic',
  'system-audio': 'systemAudio',
}

export function isKindSupported(kind: ChannelKind, caps: Capabilities): boolean {
  if (kind === 'screen') return caps.screenCapture
  // Tab/system audio rides on display capture — unavailable on Apple WebKit.
  if (kind === 'system-audio') return caps.systemAudioCapture
  return caps.camera
}

/** Why this input can't be used here — shown on press, null when it works. */
export function unsupportedReason(kind: ChannelKind, caps: Capabilities): string | null {
  if (isKindSupported(kind, caps)) return null
  if (kind === 'screen') {
    return caps.ios
      ? 'Screen recording isn’t available on iPhone or iPad — Apple only allows it in native apps.'
      : 'Screen recording isn’t available in this browser. Try Chrome or Edge.'
  }
  if (kind === 'system-audio') {
    if (caps.ios) return 'Tab audio isn’t available on iPhone or iPad — Apple blocks it in the browser.'
    if (caps.appleWebKit)
      return 'Safari can’t capture tab or system audio — it’s an Apple limitation. Use Chrome for tab audio.'
    return 'Tab audio isn’t available in this browser. Use Chrome for tab audio.'
  }
  return 'Camera and mic access isn’t available in this browser.'
}
