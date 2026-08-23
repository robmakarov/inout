export { loadCapturePrefs, saveCapturePrefs } from './prefs'
export { isSyntheticMode } from './synthetic'
export { ACQUIRE_TIMEOUT_MS } from './acquire'
export { warmCapturePipeline } from './prearm'
// O7: session.ts and recovery.ts are reached through these loaders, never
// statically — re-exporting their values here would pull the whole capture
// engine (and mediabunny) back into the first-paint chunk.
export { loadCaptureEngine, loadRecovery } from './lazy'
export type {
  CreateCaptureSessionOptions,
  ArmingProgressHandler,
  ArmingTimelineEntry,
  ArmingStep,
} from './session'
