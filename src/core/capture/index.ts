export { loadCapturePrefs, saveCapturePrefs } from './prefs'
export {
  createCaptureSession,
  type CreateCaptureSessionOptions,
  type ArmingProgressHandler,
  type ArmingTimelineEntry,
  type ArmingStep,
} from './session'
export { isSyntheticMode } from './synthetic'
export { ACQUIRE_TIMEOUT_MS } from './acquire'
export { recoverRecordingToEdit, markRecordingDismissed } from './recovery'
export { warmCapturePipeline } from './prearm'
