import { useState } from 'react'
import {
  changedSwitches,
  resetAllSwitches,
  switchStateLine,
  type SwitchReading,
} from '@core/switches'

/**
 * WHAT IS TURNED ON, ALWAYS ON SCREEN — U4 part 1, robert (23) 2026-09-03:
 * "i m sick of this bugs and fucking messes with /?test, something turned on
 * and something not, how to stop this shit".
 *
 * Fifty switches, each sticky in its own storage key, and no way to see which
 * of them a session was carrying. A link opened once in August decided how a
 * take recorded in September came out, and nothing on the screen said so.
 *
 * This is the answer, and it is one line: "default", or "N changed" — and one
 * tap gives the list and ONE button that puts every one of them back. It reads
 * through the same resolver the panel does (`@core/switches`), so the line and
 * the panel cannot disagree; and it counts what has been SET rather than what
 * differs from a constant, so a derived default (the quality slider moves two
 * of them) can never make it lie.
 *
 * It is always mounted on the capture screen, in test mode or not: a switch
 * that only shows itself on a `/?test` link is exactly the switch that follows
 * someone into ordinary use.
 *
 * IT IMPORTS NOTHING BUT THE REGISTRY, on purpose. `switchBindings.ts` can say
 * what each module will actually do, and pulls twenty-five core modules in to
 * do it — a cost the first paint must not pay for a line that is usually the
 * word "default" (O7). The panel, which is lazy and only ever on a `/?test`
 * link, is where the live values are shown.
 */
export function SwitchLine() {
  const [open, setOpen] = useState(false)
  const changed = changedSwitches()
  const line = switchStateLine()
  const clean = changed.length === 0

  return (
    <div className={`swline${clean ? '' : ' swline--dirty'}`}>
      <button
        type="button"
        className="swline__pill"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {line}
      </button>
      {open && (
        <div className="swline__sheet">
          {clean ? (
            <div className="swline__empty">
              Nothing is set. Every switch is at its default, and a take now records the way the
              product ships.
            </div>
          ) : (
            <>
              {changed.map((r) => (
                <Row key={r.spec.id} reading={r} />
              ))}
              <button
                type="button"
                className="swline__reset"
                onClick={() => location.replace(resetAllSwitches(location.href))}
              >
                Reset everything
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ reading }: { reading: SwitchReading }) {
  // A URL parameter beats storage, and saying which is what makes the sticky
  // one findable: "this one is in your address bar" is a different fix from
  // "this one has been in your browser since August".
  const where = reading.source === 'url' ? 'in the address bar' : 'sticky in this browser'
  return (
    <div className="swline__row">
      <div className="swline__name">{reading.spec.label}</div>
      <div className="swline__val">
        <code>
          {reading.spec.id}={reading.value}
        </code>{' '}
        · {where}
      </div>
    </div>
  )
}
