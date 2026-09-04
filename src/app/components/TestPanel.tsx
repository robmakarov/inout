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
import { painterChoice, setPainterChoice, type PainterChoice } from '@core/capture/painterChoice'
import { intakeChoice, setIntakeChoice, type IntakeChoice } from '@core/capture/frameIntake'
import { resolutionStepEnabled, setResolutionStep } from '@core/capture/resolutionStep'
import { nativeResEnabled, setNativeRes } from '@core/capture/nativeRes'
import { chunkedRenderEnabled, setChunkedRenderEnabled } from '@core/compose/chunkedFlag'
import { bandLimitedResampling, setBandLimitedResampling } from '@core/compose/audio'
import { urlOverrides, urlWithoutTestParam } from '@app/lib/testPanel'

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
        label="Record at the screen’s size"
        hint="On by default. Off records 1080p whatever your screen is — and makes “Go past 1440p” do nothing."
        on={nativeResEnabled()}
        set={(v) => {
          setNativeRes(v)
          redraw()
        }}
      />
      {/* THE DEPENDENCY MADE VISIBLE — Robert, 2026-08-30: "what the fuck is own
          res on and native res off, what is difference?". He was right to ask,
          and the honest answer was worse than confusing: with native-res OFF
          the capture constraint is the flat 1080p cap and this switch is not
          consulted at all (acquire.ts, displayVideoConstraints). So he recorded
          a take whose settings line said "own res" while the capture was 1080p.
          A switch that reports itself ON while being inert is a lie, so it now
          greys out with its owner, the way the max-ladder row already does. */}
      <Toggle
        label="Go past 1440p"
        hint="Needs “Record at the screen’s size”. Off stops at 2560 across; on goes all the way to your screen’s own pixels."
        on={sourceResEnabled()}
        disabled={!nativeResEnabled()}
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
      {/* B13(3). Robert heard this before it was measured: "some small noises in
          tab audio". It is the export's old resampling maths, which only got the
          top octaves roughly right — its error is 11 dB down at 16 kHz. The fix
          is ON; this switch exists to put the OLD maths back so the two can be
          compared on the same take, which is the only reason the old one is
          still in the tree. */}
      <Toggle
        label="Clean audio resampling"
        hint="On. Turn it OFF to hear the old maths: record a tab playing music, export, listen to cymbals and “s” sounds. Only does anything when the tab records at 44.1 kHz — at 48 kHz both settings give the same file."
        on={bandLimitedResampling()}
        set={(v) => {
          setBandLimitedResampling(v)
          redraw()
        }}
      />

      <div className="tp__sep">Rarely</div>
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
      <Toggle
        label="The render remembers"
        hint="On. The export is made five seconds at a time and kept, so an edit only re-does the seconds it changed and a closed tab picks up where it stopped. Costs the FIRST export about 8%; the second one takes half a second instead of three minutes. Off re-renders the whole take, every time."
        on={chunkedRenderEnabled()}
        set={(v) => {
          setChunkedRenderEnabled(v)
          redraw()
        }}
      />
      <Choice
        label="Compositor painter"
        hint="webgpu is the default: it never uploads the frame, so the composite costs 0.42 ms instead of 4.06, and warm colour comes out a little more saturated. webgl2 is exactly what every take before this used. 2d is the slow floor."
        value={painterChoice()}
        options={['webgpu', 'webgl2', '2d'] as PainterChoice[]}
        set={(v) => {
          setPainterChoice(v)
          redraw()
        }}
      />
      <Choice
        label="How frames get in"
        hint="auto picks the fastest way this browser can hand the recorder its pictures, and on Chrome that is the same way every take has always used. main reads them on the page. worker hands the whole camera/screen over to the background thread and reads them there — the only way Safari can. element lets a hidden video play and takes a snapshot of it 30-60 times a second, which is how Firefox will do it. Every one of them makes the SAME file; if one of them does not, that is the bug this switch is here to find."
        value={intakeChoice()}
        options={['auto', 'main', 'worker', 'element'] as IntakeChoice[]}
        set={(v) => {
          setIntakeChoice(v)
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
          setChunkedRenderEnabled(null)
          redraw()
        }}
      >
        Everything back to defaults
      </button>
      {/* LEAVING TEST MODE IS DROPPING THE PARAMETER, now that the switch is
          URL-only. Kept as a button because the alternative is editing the
          address bar, which is the thing this panel exists to spare him.
          Navigates rather than re-renders: two screens read the gate, and there
          is no session to lose here — the panel only shows when none is live. */}
      <button
        type="button"
        className="tp__reset tp__reset--exit"
        onClick={() => location.replace(urlWithoutTestParam())}
      >
        Leave test mode
      </button>
      <div className="tp__foot">
        Settings apply to the next take and persist. This panel does not: it is only ever here on a{' '}
        <code>/?test</code> link, so a plain visit to the app never shows it.
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
