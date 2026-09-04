import { sourceFrameEnabled, sourceResEnabled } from '@core/frame'
import { sourceRateEnabled } from '@core/rate'
import { glueRecorded } from '@core/glue'
import { singleGenRung } from '@core/singleGen'
import { captureQualityMode, rateLadderAllowed } from '@core/capture/captureQuality'
import { encoderBudgetEnabled } from '@core/capture/encoderBudget'
import { resolutionStepEnabled } from '@core/capture/resolutionStep'
import { nativeResEnabled } from '@core/capture/nativeRes'
import { changedSwitches } from '@core/switches'

/**
 * THE SETTINGS, NEXT TO THE BANNERS, SO A SCREENSHOT CARRIES BOTH — Robert,
 * 2026-08-30: "make settings in test panel shown in edit next to errors banners
 * so i can send you screenshots with it easily".
 *
 * Every report so far has cost two screenshots and a round trip to work out
 * which switches were on. One line under the take's own warnings ends that: the
 * evidence and the configuration that produced it are the same picture.
 *
 * U4 (2026-09-04) ADDED THE SECOND LINE, and the reason is what U4 is about:
 * this line was HAND-KEPT and named ten switches out of fifty, so a screenshot
 * of a take made with, say, `?noisegate=on` sticky in his browser carried no
 * hint that anything was on at all. The second line is read from the REGISTRY
 * (`@core/switches`), so it can never again name fewer switches than there are,
 * and it says where each one comes from — the address bar, or sticky in this
 * browser, which are two different fixes.
 *
 * The first line stays hand-written on purpose: it is the TAKE's settings, in
 * the words the take is discussed in, and it carries the INERT rule below that
 * no generic list could. The two are complementary, not duplicates.
 *
 * It does NOT import `switchBindings.ts`: that pulls twenty-five core modules
 * in to answer what each module will DO, and the editor chunk is not the place
 * for it (O7). The registry alone is enough to say what is SET.
 *
 * Read at RENDER time from the same getters capture reads, so it describes the
 * settings as they are now. That is honest for the common case — nobody changes
 * them between recording and looking — and it is the only thing the editor can
 * know: a take does not carry the flags it was made under. Worth having as its
 * own field on the recording one day; not worth pretending to today.
 */
export function SettingsBadge() {
  const on: string[] = []
  // A SWITCH THAT IS ON AND INERT MUST NOT READ AS ON. With native-res capture
  // off, the capture constraint is the flat 1080p cap and `sourceres` is never
  // consulted (acquire.ts) — so a take recorded that way carried a settings
  // line saying "own res" while its screen channel was 1080p, and Robert read
  // the line and asked the obvious question: "what the fuck is own res on and
  // native res off, what is difference?". The line has to answer that, not
  // pose it.
  const nativeRes = nativeResEnabled()
  if (sourceResEnabled()) on.push(nativeRes ? 'full screen res' : 'full screen res (INERT)')
  if (sourceRateEnabled()) on.push('60 fps')
  const q = captureQualityMode()
  on.push(q === 'max' ? (rateLadderAllowed() ? 'max +ladder' : 'max') : 'auto')
  if (sourceFrameEnabled()) on.push('source frame')
  if (!nativeRes) on.push('capture 1080p (screen-size OFF)')
  if (encoderBudgetEnabled()) on.push('budget')
  if (resolutionStepEnabled()) on.push('res step')
  const rung = singleGenRung()
  if (rung !== 'export') on.push(`singlegen ${rung}`)
  // J6: the default is PAINTED and not encoded, so the line only speaks when
  // the second encoder is back on — a take that is slower than the shipped one
  // must say why on its face.
  if (glueRecorded()) on.push('glued copy RECORDED')
  // Everything the first line does not name — from the registry, so the count
  // cannot be wrong. The take's own settings above are not repeated here.
  const NAMED = new Set([
    'sourceres',
    'sourcefps',
    'quality',
    'maxladder',
    'sourceframe',
    'nativeres',
    'encoderbudget',
    'resstep',
    'singlegen',
    'glue',
  ])
  const rest = changedSwitches().filter((r) => !NAMED.has(r.spec.id))
  return (
    <>
      <div className="editor__settings">Settings: {on.join(' · ')}</div>
      {rest.length > 0 && (
        <div className="editor__settings editor__settings--switches">
          Also set: {rest.map((r) => `${r.spec.id}=${r.value}${r.source === 'url' ? ' (link)' : ''}`).join(' · ')}
        </div>
      )}
    </>
  )
}
