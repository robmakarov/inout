import { sourceFrameEnabled, sourceResEnabled } from '@core/frame'
import { sourceRateEnabled } from '@core/rate'
import { singleGenRung } from '@core/singleGen'
import { captureQualityMode, rateLadderAllowed } from '@core/capture/captureQuality'
import { encoderBudgetEnabled } from '@core/capture/encoderBudget'
import { resolutionStepEnabled } from '@core/capture/resolutionStep'
import { nativeResEnabled } from '@core/capture/nativeRes'

/**
 * THE SETTINGS, NEXT TO THE BANNERS, SO A SCREENSHOT CARRIES BOTH — Robert,
 * 2026-08-30: "make settings in test panel shown in edit next to errors banners
 * so i can send you screenshots with it easily".
 *
 * Every report so far has cost two screenshots and a round trip to work out
 * which switches were on. One line under the take's own warnings ends that: the
 * evidence and the configuration that produced it are the same picture.
 *
 * Read at RENDER time from the same getters capture reads, so it describes the
 * settings as they are now. That is honest for the common case — nobody changes
 * them between recording and looking — and it is the only thing the editor can
 * know: a take does not carry the flags it was made under. Worth having as its
 * own field on the recording one day; not worth pretending to today.
 */
export function SettingsBadge() {
  const on: string[] = []
  if (sourceResEnabled()) on.push('own res')
  if (sourceRateEnabled()) on.push('60 fps')
  const q = captureQualityMode()
  on.push(q === 'max' ? (rateLadderAllowed() ? 'max +ladder' : 'max') : 'auto')
  if (sourceFrameEnabled()) on.push('source frame')
  if (!nativeResEnabled()) on.push('native-res OFF')
  if (encoderBudgetEnabled()) on.push('budget')
  if (resolutionStepEnabled()) on.push('res step')
  const rung = singleGenRung()
  if (rung !== 'export') on.push(`singlegen ${rung}`)
  return <div className="editor__settings">Settings: {on.join(' · ')}</div>
}
