import { useState } from 'react'
import {
  SWITCHES,
  SWITCH_GROUPS,
  readAllSwitches,
  readSwitch,
  resetAllSwitches,
  switchById,
  switchStateLine,
  writeSwitchStorage,
  type SwitchGroup,
  type SwitchReading,
  type SwitchSpec,
} from '@core/switches'
import { liveValue } from '@app/lib/switchBindings'
import { urlWithoutTestParam } from '@app/lib/testPanel'

/**
 * EVERY SWITCH WE HAVE, IN ONE PLACE — Robert, 2026-08-30: "i m tired of your
 * links with parametres, make me one link /?text with panel of settings we
 * testing all the time"; and 2026-09-03, when a dozen of fifty were showing:
 * "make priority task to clean up test switches mess".
 *
 * THIS PANEL NO LONGER HAS A LIST OF ITS OWN. It renders `SWITCHES` from
 * `@core/switches`, so a switch that exists in the code and not in the panel is
 * impossible by construction — and `switches.test.ts` walks the source to prove
 * the registry itself is complete. Before U4 the list was hand-kept here, which
 * is why thirty-odd switches had no row and four (`screensize`, `camsize`,
 * `screenfps`, `camfps`) were not written down anywhere at all.
 *
 * Changed switches are pinned to the top, because the question this panel is
 * asked is never "what exists" — it is "what did I press".
 *
 * Changes apply to THE NEXT TAKE: every switch is read when a take arms.
 * Nothing here needs a reload.
 */
export function TestPanel() {
  const [, bump] = useState(0)
  const redraw = (): void => bump((n) => n + 1)
  const all = readAllSwitches()
  const changed = all.filter((r) => (r.spec.product ? r.source === 'url' : r.source !== 'default'))
  const urlSet = all.filter((r) => r.source === 'url')

  return (
    <div className="tp">
      <div className="tp__title">Test settings · {switchStateLine()}</div>
      {urlSet.length > 0 && (
        <div className="tp__warn">
          The address bar is overriding {urlSet.map((r) => r.spec.id).join(', ')} for this load —
          those switches won’t follow the panel until you open the plain <code>/?test</code> link.
        </div>
      )}

      {changed.length > 0 && (
        <>
          <div className="tp__sep">Not at default ({changed.length})</div>
          {changed.map((r) => (
            <Row key={`pin-${r.spec.id}`} reading={r} redraw={redraw} />
          ))}
        </>
      )}

      {SWITCH_GROUPS.map((group) => (
        <Group key={group} group={group} rows={all} redraw={redraw} />
      ))}

      <button
        type="button"
        className="tp__reset"
        onClick={() => location.replace(resetAllSwitches(location.href))}
      >
        Reset everything ({changed.length} set)
      </button>
      {/* LEAVING TEST MODE IS DROPPING THE PARAMETER, now that the switch is
          URL-only. Kept as a button because the alternative is editing the
          address bar, which is the thing this panel exists to spare him. */}
      <button
        type="button"
        className="tp__reset tp__reset--exit"
        onClick={() => location.replace(urlWithoutTestParam())}
      >
        Leave test mode
      </button>
      <div className="tp__foot">
        Settings apply to the next take and persist. This panel does not: it is only ever here on a{' '}
        <code>/?test</code> link, so a plain visit to the app never shows it. The line at the top
        says the same thing the capture screen says, and is read from the same place.
      </div>
    </div>
  )
}

function Group({
  group,
  rows,
  redraw,
}: {
  group: SwitchGroup
  rows: SwitchReading[]
  redraw: () => void
}) {
  const mine = rows.filter((r) => r.spec.group === group)
  if (mine.length === 0) return null
  return (
    <>
      <div className="tp__sep">
        {group}
        {group === 'Harness' ? ' · agents only, link-only' : ''}
      </div>
      {mine.map((r) => (
        <Row key={r.spec.id} reading={r} redraw={redraw} />
      ))}
    </>
  )
}

/** True when this switch's owner is not set the way it needs. */
function inert(spec: SwitchSpec): boolean {
  if (!spec.needs) return false
  const owner = switchById(spec.needs.id)
  if (!owner) return false
  return (liveValue(owner.id) ?? readSwitch(owner).value) !== spec.needs.value
}

function Row({ reading, redraw }: { reading: SwitchReading; redraw: () => void }) {
  const { spec } = reading
  const live = liveValue(spec.id)
  const value = live ?? reading.value
  const off = inert(spec)
  const linkOnly = spec.storageKey === null
  const set = (v: string | null): void => {
    writeSwitchStorage(spec, v)
    redraw()
  }

  return (
    <div className={`tp__row${off ? ' tp__row--off' : ''}`}>
      {spec.kind === 'toggle' && !linkOnly && (
        <input
          type="checkbox"
          checked={value === '1'}
          disabled={off}
          onChange={(e) => set(e.currentTarget.checked ? '1' : '0')}
        />
      )}
      <div className="tp__label">
        <span>{spec.label}</span>
        <span className="tp__hint">
          {spec.hint}
          {off && spec.needs ? ` Inert right now: needs ${spec.needs.id}=${spec.needs.value}.` : ''}
        </span>
        {reading.source !== 'default' && (
          <span className="tp__hint">
            set to <code>{reading.value}</code>{' '}
            {reading.source === 'url' ? 'in the address bar' : 'and sticky in this browser'}
            {!linkOnly && (
              <>
                {' · '}
                <button type="button" className="tp__clear" onClick={() => set(null)}>
                  put back
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {spec.kind === 'choice' && !linkOnly && (
        <div className="tp__choice">
          {(spec.options ?? []).map((o) => (
            <button
              key={o}
              type="button"
              className={`tp__opt${value === o ? ' tp__opt--on' : ''}`}
              disabled={off}
              onClick={() => set(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      {(spec.kind === 'number' || spec.kind === 'text') && !linkOnly && (
        <input
          className="tp__num"
          value={value ?? ''}
          size={6}
          onChange={(e) => set(e.currentTarget.value.trim() === '' ? null : e.currentTarget.value)}
        />
      )}
      {linkOnly && (
        <div className="tp__link">{reading.value === null ? '—' : reading.value}</div>
      )}
    </div>
  )
}

/** Exported for the panel-coverage gate: every registry row is rendered here. */
export const PANEL_ROWS = SWITCHES.map((s) => s.id)
