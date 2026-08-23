export {
  defaultEditState,
  clampEditState,
  outputDurationMs,
  channelSourceTimeAt,
  activeChannelsAt,
  channelHasOutputWindow,
  hasEnabledVideo,
  isDefaultEdit,
  // Kept segments (F1 — mid-take cuts).
  keptSegments,
  editSegments,
  outputToRecordingMs,
  recordingToOutputMs,
  segmentJoinsMs,
  normalizeSegments,
  splitAtOutputMs,
  removeSegment,
  hasCuts,
  MIN_SEGMENT_MS,
} from './timeline'

export {
  // Timed zoom/pan (F2 — viewport track).
  DEFAULT_VIEWPORT,
  MIN_VIEWPORT_WIDTH_FRAC,
  ZOOM_MOVE_MS,
  clampViewport,
  normalizeViewportTrack,
  viewportAt,
  viewportIsActive,
  viewportToRect,
  viewportTrackIsActive,
  writeViewportKeyframe,
  zoomAround,
  type ViewportRect,
} from './viewportTrack'

export {
  // Silence tightening (F5a) — pure analysis and proposal, no I/O.
  SILENCE_DEFAULTS,
  analyzeEnvelope,
  outputSpanToRecordingSpans,
  proposeTightening,
  removeRecordingSpans,
  type SilenceAnalysis,
  type SilenceParams,
  type Span,
  type TightenProposal,
} from './silence'

export {
  // Timed camera motion (F4 — movable camera).
  cameraPoseAt,
  cameraTrackIsActive,
  clampPose,
  defaultCameraPose,
  easeInOut,
  normalizeCameraTrack,
  pipHeightFrac,
  poseToRect,
  writeCameraKeyframe,
  CAMERA_MOVE_MS,
  PIP_MAX_WIDTH_FRAC,
  PIP_MIN_WIDTH_FRAC,
  PIP_WIDTH_FRAC,
  type CameraGeometry,
  type PipRect,
} from './cameraTrack'
