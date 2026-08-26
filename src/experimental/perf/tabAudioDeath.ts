/**
 * EXPERIMENTAL — DOES CAPTURED TAB AUDIO SURVIVE THE TAB GOING SILENT AND THEN
 * SOUNDING AGAIN? (PO 2026-08-26: "in long video tab audio still dies after a
 * while … maybe audio dies when one youtube video ends and other starts".)
 *
 * The scenario, in the lab: this page IS the captured tab. With Chrome's
 * testing flags (--auto-accept-this-tab-capture, added to cdp-run) the REAL
 * getDisplayMedia path runs against the current tab with no native picker —
 * the only way any harness can reach captured-tab-audio behaviour. An <audio>
 * element plays a tone ("video 1"), is torn down the way a player teardown
 * looks to the audio stack, the tab sits SILENT for the gap ("the autoplay
 * pause between videos"), and a NEW element plays ("video 2"). The captured
 * audio track records through the PRODUCTION measured path the whole time, so
 * the new witnesses (track mute/unmute/ended stamps, the silence witness)
 * report exactly as they would on PO's take.
 *
 * The verdict is one comparison: does phase C (video 2) carry signal in the
 * CAPTURED channel while the tab itself is audibly playing it?
 *
 * Run with `--keep-audio` (the driver's default --mute-audio may capture as
 * silence and make the whole run vacuous — phaseA says if it did).
 */

import { startMeasuredAudioCapture } from '@core/capture/measuredAudio'
import { TONE_CHANNEL, startVideo } from './toneChild'

interface Phase {
  name: 'video1' | 'gap' | 'video2'
  plannedMs: number
  /** Peak |sample| the CAPTURED channel saw during this phase. */
  capturedMaxAbs: number
  /** How much of the phase the captured input carried signal, in ms. */
  capturedLiveMs: number
}

export interface TabAudioDeathReport {
  ok: boolean
  verdict: string
  phases: Phase[]
  trackEvents: { atMs: number; type: string }[]
  /** track.muted polled once a second — the slow-motion view of the same story. */
  mutedTimeline: { atMs: number; muted: boolean }[]
  measured: { durationMs: number; paddedMs: number; silentTailMs: number } | null
  displayAudioSettings: MediaTrackSettings | null
  error?: string
}

interface ToneDriver {
  play: (freq: number) => Promise<void>
  silence: () => Promise<void>
  dispose: () => void
}

/** Tones in THIS tab (single-tab mode). */
function localToneDriver(): ToneDriver {
  let current: { stop: () => void } | null = null
  return {
    play: async (freq) => {
      current?.stop()
      current = startVideo(freq)
    },
    silence: async () => {
      current?.stop()
      current = null
    },
    dispose: () => current?.stop(),
  }
}

/**
 * Tones in a CHILD TAB (cross-tab mode — PO's real topology: the captured tab
 * is not the capturing tab, so nothing in it holds a capture that keeps its
 * audio stream alive). The child renames itself TONECHILD; cdp-run's
 * --capture-title flag points Chrome's auto-select at it.
 */
async function childToneDriver(): Promise<ToneDriver> {
  const bc = new BroadcastChannel(TONE_CHANNEL)
  const child = window.open(
    `${location.origin}${location.pathname}?synthetic=1&tonechild=1`,
    '_blank',
  )
  if (!child) throw new Error('window.open blocked — child tab unavailable')
  const waitEvt = (evt: string, timeoutMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`tone child never answered '${evt}' in ${timeoutMs}ms`)),
        timeoutMs,
      )
      const on = (e: MessageEvent): void => {
        if ((e.data as { evt?: string } | null)?.evt === evt) {
          clearTimeout(timer)
          bc.removeEventListener('message', on)
          resolve()
        }
      }
      bc.addEventListener('message', on)
    })
  await waitEvt('ready', 15_000)
  return {
    play: async (freq) => {
      const ack = waitEvt('playing', 10_000)
      bc.postMessage({ cmd: 'play', freq })
      await ack
    },
    silence: async () => {
      const ack = waitEvt('silent', 10_000)
      bc.postMessage({ cmd: 'silence' })
      await ack
    },
    dispose: () => {
      bc.postMessage({ cmd: 'close' })
      bc.close()
      try {
        child.close()
      } catch {
        /* already closed */
      }
    },
  }
}

export async function runTabAudioDeath(opts?: {
  video1Secs?: number
  gapSecs?: number
  video2Secs?: number
  /** Capture a CHILD tab (PO's topology) instead of this one. Needs the
   *  --capture-title=TONECHILD flag on the driver. */
  crossTab?: boolean
}): Promise<TabAudioDeathReport> {
  const video1Ms = (opts?.video1Secs ?? 8) * 1000
  const gapMs = (opts?.gapSecs ?? 45) * 1000
  const video2Ms = (opts?.video2Secs ?? 12) * 1000

  const report: TabAudioDeathReport = {
    ok: false,
    verdict: '',
    phases: [
      { name: 'video1', plannedMs: video1Ms, capturedMaxAbs: 0, capturedLiveMs: 0 },
      { name: 'gap', plannedMs: gapMs, capturedMaxAbs: 0, capturedLiveMs: 0 },
      { name: 'video2', plannedMs: video2Ms, capturedMaxAbs: 0, capturedLiveMs: 0 },
    ],
    trackEvents: [],
    mutedTimeline: [],
    measured: null,
    displayAudioSettings: null,
  }

  let display: MediaStream | null = null
  let mutedPoll: ReturnType<typeof setInterval> | null = null
  let driver: ToneDriver | null = null
  try {
    driver = opts?.crossTab ? await childToneDriver() : localToneDriver()
    // Opening the child tab steals focus, and getDisplayMedia throws
    // InvalidStateError from an unfocused document. Claim it back and wait.
    if (opts?.crossTab && !document.hasFocus()) {
      for (let i = 0; i < 20 && !document.hasFocus(); i++) {
        window.focus()
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!document.hasFocus()) {
        report.verdict = 'VACUOUS: could not refocus the capturing tab after opening the child'
        return report
      }
    }
    // The real path, no picker (testing flags in cdp-run). Single-tab mode
    // captures THIS tab; cross-tab mode excludes it so the auto-select-by-title
    // flag picks the TONECHILD tab instead. Bounded: with the flags missing,
    // headless getDisplayMedia would hang on a picker nothing can click.
    const request = navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chromium-specific; missing from the TS lib.
      ...((opts?.crossTab
        ? { selfBrowserSurface: 'exclude' }
        : { preferCurrentTab: true }) as Record<string, unknown>),
    } as DisplayMediaStreamOptions)
    display = await Promise.race([
      request,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getDisplayMedia never settled — auto-accept flags missing?')), 20_000),
      ),
    ])
    const audioTrack = display.getAudioTracks()[0]
    if (!audioTrack) {
      report.verdict = 'VACUOUS: current-tab capture carried no audio track — flag or platform gap'
      return report
    }
    report.displayAudioSettings = audioTrack.getSettings()

    const epoch = performance.now()
    const phaseAt = (atMs: number): Phase => {
      if (atMs < video1Ms) return report.phases[0]!
      if (atMs < video1Ms + gapMs) return report.phases[1]!
      return report.phases[2]!
    }
    for (const type of ['mute', 'unmute', 'ended'] as const) {
      audioTrack.addEventListener(type, () =>
        report.trackEvents.push({ atMs: Math.round(performance.now() - epoch), type }),
      )
    }
    mutedPoll = setInterval(
      () =>
        report.mutedTimeline.push({
          atMs: Math.round(performance.now() - epoch),
          muted: audioTrack.muted,
        }),
      1000,
    )

    const handle = await startMeasuredAudioCapture({
      stream: new MediaStream([audioTrack]),
      epoch,
      label: 'tabcap-rig',
      writer: {
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => undefined,
      },
      onPcm: (left, right, _startFrame, _startOffsetMs, sampleRate) => {
        const phase = phaseAt(performance.now() - epoch)
        let maxAbs = 0
        for (let i = 0; i < left.length; i++) {
          const a = Math.abs(left[i]!)
          if (a > maxAbs) maxAbs = a
          const b = Math.abs(right[i]!)
          if (b > maxAbs) maxAbs = b
        }
        if (maxAbs > phase.capturedMaxAbs) phase.capturedMaxAbs = maxAbs
        if (maxAbs > 1e-4) phase.capturedLiveMs += (left.length / sampleRate) * 1000
      },
    })

    await driver.play(440)
    await new Promise((r) => setTimeout(r, video1Ms))
    await driver.silence()
    await new Promise((r) => setTimeout(r, gapMs))
    await driver.play(660)
    await new Promise((r) => setTimeout(r, video2Ms))
    await driver.silence()

    const r = await handle.stop()
    report.measured = {
      durationMs: Math.round(r.durationMs),
      paddedMs: Math.round(r.paddedMs),
      silentTailMs: Math.round(r.silentTailMs),
    }

    const [a, , c] = report.phases
    const HEARD = 1e-3
    if (a!.capturedMaxAbs < HEARD) {
      report.verdict =
        'VACUOUS: the captured channel never heard video 1 — run with --keep-audio, or this platform captures a muted tab as silence'
    } else if (c!.capturedMaxAbs < HEARD) {
      report.ok = true
      report.verdict =
        'REPRODUCED: the captured tab audio never came back after the silent gap — video 2 played audibly and the capture recorded silence'
    } else {
      report.ok = true
      report.verdict = `NOT reproduced at gap ${gapMs / 1000}s: video 2 came through at ${c!.capturedMaxAbs.toFixed(3)} peak`
    }
    return report
  } catch (err) {
    report.error = String(err instanceof Error ? (err.stack ?? err.message) : err)
    report.verdict = 'ERROR: see error field'
    return report
  } finally {
    if (mutedPoll) clearInterval(mutedPoll)
    if (display) for (const t of display.getTracks()) t.stop()
    driver?.dispose()
  }
}
