import { useEffect, useState } from 'react'
import type { Recording } from '@core/types'
import { clampEditState, defaultEditState } from '@core/timeline'
import { useAppStore } from '@app/state/store'
import { CHANNEL_META } from '@app/lib/channels'

/**
 * EVERY TAKE YOU HAVE, AND A WAY BACK INTO ONE.
 *
 * Robert, 2026-08-30: "how th fuck will i open last night take in the editor".
 * He could not, and neither could anyone. The app opens the newest recording at
 * boot and there was no other route: record a second take, or dismiss the first,
 * and the earlier one became unreachable while still sitting on disk with its
 * blobs, its edit state and its diagnostics intact. `recordingsRepo.list()` has
 * existed the whole time and only experimental rigs ever called it.
 *
 * It surfaced as a diagnosis problem — his tab audio died and the evidence was
 * in a take he had no way to open — but it is a product hole in its own right:
 * takes are kept and were not reachable.
 *
 * Opens a take exactly the way the boot recovery does (App.tsx), including the
 * saved edit state, so a take reached from here is the take a refresh would
 * have handed back.
 */
export function TakesList({ onOpen }: { onOpen?: () => void }) {
  const [takes, setTakes] = useState<Recording[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        // Imported here, not at module scope, so the store stays out of the
        // first-paint chunk (O7) — the same rule App.tsx's recovery follows.
        const { recordingsRepo } = await import('@core/store')
        const rows = await recordingsRepo.list()
        if (alive) setTakes(rows)
      } catch {
        if (alive) setTakes([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  if (!takes || takes.length === 0) return null

  const openTake = async (rec: Recording): Promise<void> => {
    const s = useAppStore.getState()
    let saved: import('@core/types').EditState | undefined
    try {
      saved = await (await import('@core/store')).editsRepo.get(rec.id)
    } catch {
      saved = undefined
    }
    // Opening an OLDER take must not be undone by the boot recovery deciding a
    // newer one is the interesting one on the next load. Marking it dismissed
    // is the app's own "I have moved on from that" flag (recovery.ts).
    try {
      const { markRecordingDismissed } = await import('@core/capture/recovery')
      const newest = takes[0]
      if (newest && newest.id !== rec.id) markRecordingDismissed(newest.id)
    } catch {
      /* the take still opens; only the next boot's default is affected */
    }
    s.setRecording(rec)
    s.setEditState(clampEditState(rec, saved ?? defaultEditState(rec)))
    s.setMode('editor')
    onOpen?.()
  }

  return (
    <div className="takes">
      <button type="button" className="takes__toggle" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide takes' : `Takes (${takes.length})`}
      </button>
      {open && (
        <ul className="takes__list">
          {takes.map((r) => (
            <li key={r.id}>
              <button type="button" className="takes__item" onClick={() => void openTake(r)}>
                <span className="takes__when">{when(r.createdAt)}</span>
                <span className="takes__len">{clock(r.durationMs)}</span>
                <span className="takes__kinds">
                  {[...new Set(r.channels.map((c) => c.kind))]
                    .map((k) => CHANNEL_META[k].label)
                    .join(' · ')}
                </span>
                {lossNote(r) && <span className="takes__loss">{lossNote(r)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function when(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/** The one-glance version of what the editor spells out — so a take whose sound
 *  died is visible in the LIST, not only after opening it. */
function lossNote(r: Recording): string | null {
  if (r.missing?.length) return 'incomplete'
  for (const c of r.channels) {
    const d = c.diagnostics
    if (!d) continue
    if ((d.silentTailMs ?? 0) >= 3_000) return 'sound died'
    if ((d.revivals ?? 0) > 0) return 'sound interrupted'
  }
  return null
}
