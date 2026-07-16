import type { CaptureConfig } from '@core/types'

const STORAGE_KEY = 'inout.capture.prefs'

const DEFAULTS: CaptureConfig = { screen: true, camera: true, mic: true, systemAudio: true }

export function loadCapturePrefs(): CaptureConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(parsed as Partial<CaptureConfig>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveCapturePrefs(c: CaptureConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  } catch {
    /* storage unavailable — prefs are best-effort */
  }
}
