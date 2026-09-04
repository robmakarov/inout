/**
 * O10c's switch — the noise gate, off by default and staying off.
 *
 * A default a user can HEAR is Robert's alone (the frozen rule), and this one
 * changes the sound of every export. So it ships opt-in: the OFF path does not
 * run a line of the gate, and the default export is byte-identical to what
 * shipped before this existed.
 *
 * THE ROW SAYS WHAT HE GETS, not what it does. SIZE-CODEC's rule applies to
 * DSP too: "spectral gating" is not a word anybody uses about their own
 * recording, and the panel says the sound it removes instead.
 *
 *   ?noisegate=on | off        this load only
 *   localStorage['inout.compose.noisegate']   (sticky, the /?test row)
 *
 * A URL parameter wins, then the override, then storage, then the default.
 * Read on the MAIN thread and forwarded (pipeline.ts → export.worker.ts): the
 * render worker has no `localStorage` and a `location` of its own script URL.
 */

const STORAGE_KEY = 'inout.compose.noisegate'

function parse(v: string | null): boolean | null {
  if (v === 'on' || v === '1' || v === 'true') return true
  if (v === 'off' || v === '0' || v === 'false') return false
  return null
}

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  return parse(new URLSearchParams(location.search).get('noisegate'))
}

function fromStorage(): boolean | null {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export function noiseGateEnabled(): boolean {
  return fromSearch() ?? fromStorage() ?? false
}

export function setNoiseGate(on: boolean | null): void {
  try {
    if (on === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/** The worker has neither location nor storage: it is TOLD. */
let override: boolean | null = null
export function setNoiseGateOverride(value: boolean | null): void {
  override = value
}

export function noiseGateActive(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? false
}
