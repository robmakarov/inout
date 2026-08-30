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

/**
 * WHAT THIS TAKE LOST WHILE IT WAS RECORDING, said in the editor rather than
 * left in a console the tab already closed.
 *
 * Robert, 2026-08-30: "tab audio died completly". The take KNEW — every channel
 * carries `silentTailMs`, `revivals` and its track's life events, stored on the
 * recording precisely because "the console dies with the tab" — and nothing
 * showed him any of it. He found out by listening. That is the same defect as a
 * silently mic-less take, one layer in: the evidence existed and the interface
 * stayed quiet.
 *
 * Deliberately only reports what a LISTENER would notice. A second of padding
 * on an hour-long take is the guard working, not news; a channel that ended in
 * silence, or that had to have its tap rebuilt, is the thing worth a sentence.
 */
export interface TakeLoss {
  kind: ChannelKind
  message: string
}

/** Below this a silent tail is a quiet ending, not a dead source. */
const SILENT_TAIL_FLOOR_MS = 3_000
/**
 * PADDING IS THE GUARD WORKING, NOT A LOSS, AND SAYING OTHERWISE WAS A LIE.
 *
 * First cut reported anything over 200 ms as "Mic lost 0.4s". Robert, on a take
 * where both channels recorded perfectly: "tab audio was there all the time,
 * with little lags but there so its laying" — it is lying. He is right. A few
 * hundred milliseconds of inserted silence across a whole take is the
 * wall-clock hold doing its job on a busy machine; nothing was lost, nothing is
 * audible, and there is nothing for him to do about it. A number that alarms
 * without being actionable is worse than no number.
 *
 * Two seconds is the floor now, and the wording says what actually happened.
 */
const PAD_FLOOR_MS = 2_000

export function takeLosses(
  channels: readonly {
    kind: ChannelKind
    media: string
    durationMs: number
    diagnostics?: {
      silentTailMs?: number
      paddedMs?: number
      revivals?: number
      events?: { atMs: number; type: string }[]
    }
  }[],
  caps: Capabilities,
): TakeLoss[] {
  const out: TakeLoss[] = []
  for (const c of channels) {
    if (c.media !== 'audio') continue
    const d = c.diagnostics
    if (!d) continue
    const name = channelLabel(c.kind, caps)
    const tail = d.silentTailMs ?? 0
    const revivals = d.revivals ?? 0
    const muted = (d.events ?? []).some((e) => e.type === 'mute')
    if (tail >= SILENT_TAIL_FLOOR_MS) {
      // THE ONE THAT COST HIM A TAKE: sound that stopped and never came back.
      const secs = Math.round(tail / 1000)
      const from = Math.max(0, Math.round((c.durationMs - tail) / 1000))
      out.push({
        kind: c.kind,
        message:
          `${name} went silent ${from}s in and never came back — the last ${secs}s have no sound` +
          (muted ? ', because the source muted itself' : '') +
          (revivals > 0 ? `, and ${revivals} attempt${revivals === 1 ? '' : 's'} to reopen it did not take` : '') +
          '.',
      })
    } else if (revivals > 0) {
      // IT CAME BACK, so this is the rescue working rather than damage. Said as
      // a fact to check, not as a warning: on the take where Robert saw this,
      // everything had recorded fine. "There may be a gap" was a guess dressed
      // as a finding.
      out.push({
        kind: c.kind,
        message: `${name} dropped out mid-take and came back on its own${revivals > 1 ? ` (${revivals} times)` : ''} — the sound is complete either side of it.`,
      })
    } else if ((d.paddedMs ?? 0) >= PAD_FLOOR_MS) {
      out.push({
        kind: c.kind,
        message: `${name} was held in sync across ${Math.round((d.paddedMs ?? 0) / 100) / 10}s the machine could not deliver — nothing is missing, but that much of it is silence.`,
      })
    }
  }
  return out
}
