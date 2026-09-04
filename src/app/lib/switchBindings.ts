/**
 * WHAT EACH SWITCH IS ACTUALLY DOING RIGHT NOW — the second half of U4's
 * "the line cannot lie".
 *
 * `src/core/switches.ts` knows what has been SET (a URL parameter, a value in
 * storage). It deliberately does not know what the module DECIDED, because
 * several defaults are derived and a registry that carried them would go stale
 * the moment one moved. This table closes that gap the only honest way: it asks
 * each module.
 *
 * It lives in the app and not in core because one of the switches (`panel`) is
 * an app concern, and `src/core` never imports `src/app`.
 *
 * `switchBindings.test.ts` uses it as a GATE, not as a convenience: it writes
 * the registry's own encoding into storage and asserts the module's answer
 * moves with it. A row whose encoding is wrong is a row that shows Robert a
 * value his takes are not recorded with, which is the defect this task exists
 * to end.
 */
import { audioTapChoice, audioTapThreadChoice, trackTapBufferMs } from '@core/capture/audioTap'
import { burstAbsorberEnabled } from '@core/capture/burstBudget'
import { captureQualityMode, maxLadderChosen } from '@core/capture/captureQuality'
import { crashFloorEnabled } from '@core/capture/crashFloor'
import { emergencyFloorEnabled, floorResolutionRungEnabled } from '@core/capture/emergencyFloor'
import { encoderBudgetEnabled } from '@core/capture/encoderBudget'
import { preferredCompositeEngine } from '@core/capture/engine'
import { intakeChoice } from '@core/capture/frameIntake'
import { nativeResEnabled } from '@core/capture/nativeRes'
import { painterChoice } from '@core/capture/painterChoice'
import { rawVideoCodec } from '@core/capture/rawCodec'
import { resolutionStepEnabled } from '@core/capture/resolutionStep'
import { backgroundPaceEnabled } from '@core/backgroundWork'
import { bandLimitedResampling } from '@core/compose/audio'
import { audioTrackMode } from '@core/compose/audioTracks'
import { chunkedRenderEnabled } from '@core/compose/chunkedFlag'
import { constantQualityQp } from '@core/compose/constantQuality'
import { editRenderEnabled } from '@core/compose/editRenderFlag'
import { fullColourEnabled } from '@core/compose/fullColour'
import { keyframeIntervalSec } from '@core/compose/keyframeInterval'
import { loudnessMode } from '@core/compose/loudnessMode'
import { prerenderEnabled } from '@core/compose/prerenderFlag'
import { smartCutEnabled } from '@core/compose/smartCutFlag'
import { sourceFrameEnabled, sourceResEnabled } from '@core/frame'
import { glueRung } from '@core/glue'
import { latenessEnabled } from '@core/lateness'
import { pressureDetectorEnabled } from '@core/pressure'
import { loadQualityStep } from '@core/qualityStep'
import { sourceRateEnabled } from '@core/rate'
import { singleGenRung } from '@core/singleGen'
import { panelEnabled } from '@app/lib/recorderPanel'

const onOff = (b: boolean): string => (b ? '1' : '0')

/**
 * id -> what the product will do on the next take. Only switches that resolve
 * to something a module can be asked about are here; the harness knobs are
 * URL-only and their value IS what is in the address bar.
 */
export const SWITCH_READERS: Readonly<Record<string, () => string>> = {
  nativeres: () => onOff(nativeResEnabled()),
  sourceres: () => onOff(sourceResEnabled()),
  sourcefps: () => onOff(sourceRateEnabled()),
  sourceframe: () => onOff(sourceFrameEnabled()),
  quality: () => captureQualityMode(),
  qstep: () => loadQualityStep(),
  maxladder: () => onOff(maxLadderChosen()),
  resstep: () => onOff(resolutionStepEnabled()),
  pressure: () => onOff(pressureDetectorEnabled()),
  floor: () => onOff(emergencyFloorEnabled()),
  floorres: () => onOff(floorResolutionRungEnabled()),
  crashfloor: () => onOff(crashFloorEnabled()),
  burst: () => onOff(burstAbsorberEnabled()),
  encoderbudget: () => onOff(encoderBudgetEnabled()),
  panel: () => onOff(panelEnabled()),
  bgpace: () => onOff(backgroundPaceEnabled()),
  lateness: () => onOff(latenessEnabled()),
  engine: () => preferredCompositeEngine(),
  painter: () => painterChoice(),
  intake: () => intakeChoice(),
  rawcodec: () => rawVideoCodec(),
  glue: () => glueRung(),
  singlegen: () => singleGenRung(),
  audiotap: () => audioTapChoice(),
  audiotapthread: () => audioTapThreadChoice(),
  audiobuf: () => String(trackTapBufferMs()),
  resamp: () => onOff(bandLimitedResampling()),
  audiotracks: () => audioTrackMode(),
  loudness: () => loudnessMode(),
  chunked: () => onOff(chunkedRenderEnabled()),
  bgrender: () => onOff(editRenderEnabled()),
  prerender: () => onOff(prerenderEnabled()),
  smartcut: () => onOff(smartCutEnabled()),
  colour: () => (fullColourEnabled() ? 'all' : '420'),
  cq: () => String(constantQualityQp() ?? 'off'),
  gop: () => String(keyframeIntervalSec()),
}

/** What this switch will do on the next take, or null when only a link decides. */
export function liveValue(id: string): string | null {
  const read = SWITCH_READERS[id]
  if (!read) return null
  try {
    return read()
  } catch {
    return null
  }
}
