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
  // Tab/system audio rides on display capture — unavailable on Apple WebKit
  // AND on Firefox, which accepts the constraint and returns video only (P1).
  if (kind === 'system-audio') return caps.systemAudioCapture
  return caps.camera
}

/**
 * What to CALL this channel here (task P1). On Chromium/Windows a whole-monitor
 * share carries the machine's audio, so "Tab Audio" is simply the wrong word;
 * everywhere else it is exactly the right one. The label follows the platform
 * rather than promising the same thing everywhere and being wrong on one.
 */
export function channelLabel(kind: ChannelKind, caps: Capabilities): string {
  if (kind === 'system-audio' && caps.displayAudioScope === 'system') return 'System Audio'
  return CHANNEL_META[kind].label
}

/**
 * The line the editor shows when a take came back short. Wording is the
 * original (2026-08): for a few hours today it claimed a whole-screen share
 * cannot carry sound on macOS, which is false on Robert's own machine — his screen
 * share has that box. Restored verbatim; it does not change again without
 * evidence from a real picker.
 */
export function missingChannelsMessage(missing: ChannelKind[], caps: Capabilities): string {
  const names = missing.map((k) => channelLabel(k, caps)).join(', ')
  if (!missing.includes('system-audio')) {
    return `Missing from this take: ${names} — the device never connected.`
  }
  return `Missing from this take: ${names}. Audio wasn't shared — next time tick “Also share system audio” in the screen picker (tab shares always include it; window shares can't).`
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
    // Firefox does not refuse — it accepts `audio: true` and hands back video
    // only. Saying "not available" would be true but useless; saying what it
    // actually does is what stops someone recording a silent take twice.
    if (caps.engine === 'gecko')
      return 'Firefox accepts the request and records video only — it can’t capture tab or system audio yet. Use Chrome or Edge for tab audio.'
    return 'Tab audio isn’t available in this browser. Use Chrome for tab audio.'
  }
  return 'Camera and mic access isn’t available in this browser.'
}
