import { useState } from 'react'
import { sourceFrameEnabled, sourceResEnabled, setSourceFrame, setSourceRes } from '@core/frame'
import { setSourceRate, sourceRateEnabled } from '@core/rate'
import { setSingleGenRung, singleGenRung, type SingleGenRung } from '@core/singleGen'
import {
  captureQualityMode,
  rateLadderAllowed,
  setCaptureQualityMode,
  setMaxLadder,
  type CaptureQualityMode,
} from '@core/capture/captureQuality'
import { encoderBudgetEnabled, setEncoderBudget } from '@core/capture/encoderBudget'
import { resolutionStepEnabled, setResolutionStep } from '@core/capture/resolutionStep'
import { nativeResEnabled, setNativeRes } from '@core/capture/nativeRes'
import { setTestPanelEnabled, urlOverrides, urlWithoutTestParam } from '@app/lib/testPanel'

/**
 * EVERY SWITCH WE HAVE BEEN TESTING, IN ONE PLACE — Robert, 2026-08-30: "i m
 * tired of your links with parametres, make me one link /?text with panel of
 * settings we testing all the time".
 *
 * The flags always persisted; what was missing was somewhere to press them, so
 * each round ended with another URL for him to keep or lose. Everything here
 * writes the same storage the flags already read, so the panel and a link are
 * the same mechanism — and a link still wins for the load it is on, which is
 * why the panel says so when one is present rather than showing a value that
 * is not in force.
 *
 * Changes apply to THE NEXT TAKE, not this one: every flag is read when a take
 * arms. Nothing here needs a reload.
 */
export function TestPanel() {
  const [, bump] = useState(0)
  const redraw = (): void => bump((n) => n + 1)
  const overrides = urlOverrides()

  return (
    <div className="tp">
      <div className="tp__title">Test settings</div>
      {overrides.length > 0 && (
        <div className="tp__warn">
          The address bar is overriding {overrides.join(', ')} for this load — these switches
          won’t take effect until you open the plain <code>/?test</code> link.
        </div>
      )}

      <Toggle
        label="My own resolution"
        hint="Capture and export at the screen’s own size instead of stopping at 1440p"
        on={sourceResEnabled()}
        set={(v) => {
          setSourceRes(v)
          redraw()
        }}
      />
      <Toggle
        label="60 fps"
        hint="The rate follows the source, up to 60"
        on={sourceRateEnabled()}
        set={(v) => {
          setSourceRate(v)
          redraw()
        }}
      />
      <Choice
        label="Quality mode"
        hint="max: nothing steps down and nothing is refused. auto: the rate gives under load and comes back."
        value={captureQualityMode()}
        options={['auto', 'max'] as CaptureQualityMode[]}
        set={(v) => {
          setCaptureQualityMode(v)
          redraw()
        }}
      />
      <Toggle
        label="Rate ladder inside max"
        hint="Off by design. On, max trades rate for smoothness instead of dropping frames."
        on={captureQualityMode() === 'max' ? rateLadderAllowed() : true}
        disabled={captureQualityMode() !== 'max'}
        set={(v) => {
          setMaxLadder(v)
          redraw()
        }}
      />
      <Toggle
        label="Vertical / source frame"
        hint="The output takes the take’s own shape — a phone take stays portrait"
        on={sourceFrameEnabled()}
        set={(v) => {
          setSourceFrame(v)
          redraw()
        }}
      />

      <div className="tp__sep">Rarely</div>
      <Toggle
        label="Native-res capture"
        hint="On by default. Off caps capture at 1080p."
        on={nativeResEnabled()}
        set={(v) => {
          setNativeRes(v)
          redraw()
        }}
      />
      <Toggle
        label="Encoder budget"
        hint="Bounds a take on a machine that has been seen to collapse. Never bounds an unmeasured one."
        on={encoderBudgetEnabled()}
        set={(v) => {
          setEncoderBudget(v)
          redraw()
        }}
      />
      <Toggle
        label="Follow a resolution change"
        hint="The screen channel segments when the source’s own size changes mid-take"
        on={resolutionStepEnabled()}
        set={(v) => {
          setResolutionStep(v)
          redraw()
        }}
      />
      <Choice
        label="Single generation"
        hint="Whether the composite is recorded when a raw channel already holds the picture"
        value={singleGenRung()}
        options={['off', 'export', 'capture'] as SingleGenRung[]}
        set={(v) => {
          setSingleGenRung(v)
          redraw()
        }}
      />

      <button
        type="button"
        className="tp__reset"
        onClick={() => {
          setSourceRes(null)
          setSourceRate(null)
          setSourceFrame(null)
          setCaptureQualityMode(null)
          setMaxLadder(null)
          setNativeRes(null)
          setEncoderBudget(null)
          setResolutionStep(null)
          setSingleGenRung(null)
          redraw()
        }}
      >
        Everything back to defaults
      </button>
      {/* THE OFF SWITCH THIS PANEL SHIPPED WITHOUT. `?test` is sticky by
          design — one link, kept — but sticky with no exit is a trap, and it
          sprang: the settings line followed Robert onto an editing screen he
          was not testing on, and the only documented way out was another URL
          parameter. Reloads on purpose, and only from here, where there is no
          session to lose: the gate is read at render by two screens, and the
          address bar has to be cleaned in the same move or the parameter turns
          it back on at the next refresh. */}
      <button
        type="button"
        className="tp__reset tp__reset--exit"
        onClick={() => {
          setTestPanelEnabled(false)
          location.replace(urlWithoutTestParam())
        }}
      >
        Turn off test mode
      </button>
      <div className="tp__foot">
        Applies to the next take. Nothing here needs a reload. Turning test mode off hides this
        panel and the settings line in the editor — open <code>/?test</code> again to bring it back.
      </div>
    </div>
  )
}

function Toggle({
  label,
  hint,
  on,
  set,
  disabled,
}: {
  label: string
  hint: string
  on: boolean
  set: (v: boolean | null) => void
  disabled?: boolean
}) {
  return (
    <label className={`tp__row${disabled ? ' tp__row--off' : ''}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} />
      <span className="tp__label">
        {label}
        <span className="tp__hint">{hint}</span>
      </span>
    </label>
  )
}

function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  set,
}: {
  label: string
  hint: string
  value: T
  options: T[]
  set: (v: T) => void
}) {
  return (
    <div className="tp__row">
      <span className="tp__label">
        {label}
        <span className="tp__hint">{hint}</span>
      </span>
      <span className="tp__choice">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`tp__opt${o === value ? ' tp__opt--on' : ''}`}
            onClick={() => set(o)}
          >
            {o}
          </button>
        ))}
      </span>
    </div>
  )
}
