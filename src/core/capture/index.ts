export { loadCapturePrefs, saveCapturePrefs } from './prefs'
export { isSyntheticMode } from './synthetic'
export { ACQUIRE_TIMEOUT_MS } from './acquire'
// W1: the capture screen needs to SEE that this machine is in reduced mode and
// to be able to clear it with a button. displayWedge.ts imports nothing but a
// type, so this costs the first-paint chunk nothing — unlike session.ts below.
export { displayRequestLevel, resetDisplayWedge } from './displayWedge'
export type { DisplayStall } from './displayWedge'
export { warmCapturePipeline } from './prearm'
// O7: session.ts and recovery.ts are reached through these loaders, never
// statically — re-exporting their values here would pull the whole capture
// engine (and mediabunny) back into the first-paint chunk.
export { loadCaptureEngine, loadRecovery } from './lazy'
export type {
  CreateCaptureSessionOptions,
  DisplayStallHandler,
  ArmingProgressHandler,
  ArmingTimelineEntry,
  ArmingStep,
} from './session'
