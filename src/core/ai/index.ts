export {
  exportForAi,
  getLastAiExportStats,
  POINTER_TRAIL_ENABLED,
  SAMPLE_FPS,
  type AiExportOptions,
  type AiExportStats,
} from './build'
export { buildIndexLines, type IndexInput, type KeyframeEntry, type TrailPoint } from './indexText'
export {
  currentPaceMs,
  defaultSelectorConfig,
  initSelector,
  paceMs,
  stepSelection,
  KEYFRAME_BUDGET,
  type Classification,
  type Decision,
  type SelectorConfig,
  type SelectorState,
} from './select'
export {
  changedBlobs,
  gridDelta,
  makeGrid,
  CELL_DELTA,
  GRID_COLS,
  GRID_ROWS,
  type Delta,
  type LumaGrid,
  type Rect,
} from './delta'
export { PdfWriter, pdfEscape, wrapText, type PdfImage, type PdfSink } from './pdf'
