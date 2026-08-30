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
  const [busy, setBusy] = useState(false)
  /** Bytes on disk belonging to no take — see reclaim(). */
  const [orphanBytes, setOrphanBytes] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        // Imported here, not at module scope, so the store stays out of the
        // first-paint chunk (O7) — the same rule App.tsx's recovery follows.
        const { recordingsRepo } = await import('@core/store')
        const rows = await recordingsRepo.list()
        if (alive) setTakes(rows)
        if (alive) setOrphanBytes(await orphanTotal(rows))
      } catch {
        if (alive) setTakes([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const refreshOrphans = async (rows: Recording[]): Promise<void> => {
    setOrphanBytes(await orphanTotal(rows).catch(() => 0))
  }

  /**
   * RECLAIM WHAT BELONGS TO NOTHING. A take that freezes never reaches stop, so
   * no Recording row is written — but its file is already on disk, and until
   * now nothing in the product could see it or remove it. Robert, 2026-08-30,
   * with the app showing zero takes: "i dont see any takes and you telling me
   * its 1,1 gb". One orphaned file, 1,138 MB, from an evening of takes that
   * froze.
   *
   * Never touches the blobs a CRASHED take is still hoping to be salvaged from
   * (recovery.ts's pending manifest): those are unreferenced on purpose.
   */
  const reclaim = async (): Promise<void> => {
    setBusy(true)
    try {
      const { blobStore } = await import('@core/store')
      const { pendingBlobKeys } = await import('@core/capture/recovery')
      const keep = new Set([...referencedKeys(takes ?? []), ...pendingBlobKeys()])
      for (const f of await blobStore.list()) {
        if (keep.has(f.key) || f.key.startsWith('__')) continue
        await blobStore.remove(f.key)
      }
      setOrphanBytes(0)
    } finally {
      setBusy(false)
    }
  }

  if (takes === null || (takes.length === 0 && orphanBytes <= 0)) return null

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const { recordingsRepo } = await import('@core/store')
      await recordingsRepo.remove(id)
      const left = (takes ?? []).filter((r) => r.id !== id)
      setTakes(left)
      await refreshOrphans(left)
    } finally {
      setBusy(false)
    }
  }

  const removeAll = async (): Promise<void> => {
    setBusy(true)
    try {
      const { recordingsRepo } = await import('@core/store')
      for (const r of takes ?? []) await recordingsRepo.remove(r.id)
      setTakes([])
      await refreshOrphans([])
    } finally {
      setBusy(false)
    }
  }

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
      <div className="takes__head">
        <span>
          {(takes ?? []).length} take{(takes ?? []).length === 1 ? '' : 's'} kept on this computer
        </span>
        {(takes ?? []).length > 0 && (
          <button type="button" className="takes__all" disabled={busy} onClick={() => void removeAll()}>
            Delete all
          </button>
        )}
      </div>
      {orphanBytes > 0 && (
        <div className="takes__orphan">
          <span>
            {bytes(orphanBytes)} left behind by takes that never finished — no recording to open,
            nothing using it.
          </span>
          <button type="button" className="takes__all" disabled={busy} onClick={() => void reclaim()}>
            Reclaim
          </button>
        </div>
      )}
      <ul className="takes__list">
        {takes.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="takes__item"
              disabled={busy}
              onClick={() => void openTake(r)}
            >
              <span className="takes__when">{when(r.createdAt)}</span>
              <span className="takes__len">{clock(r.durationMs)}</span>
              <span className="takes__size">{size(r)}</span>
              <span className="takes__kinds">
                {[...new Set(r.channels.map((c) => c.kind))]
                  .map((k) => CHANNEL_META[k].label)
                  .join(' · ')}
              </span>
              {lossNote(r) && <span className="takes__loss">{lossNote(r)}</span>}
            </button>
            <button
              type="button"
              className="takes__del"
              disabled={busy}
              aria-label="Delete this take"
              title="Delete this take and its files"
              onClick={() => void remove(r.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="takes__foot">
        Kept until you delete them — a take you exported is not removed automatically. Files you
        already saved to Downloads are the browser’s and can only be deleted there.
      </div>
    </div>
  )
}

/** Every blob key any take points at — the rest is orphaned. */
function referencedKeys(rows: Recording[]): string[] {
  const keys: string[] = []
  for (const r of rows) {
    for (const c of r.channels) keys.push(c.blobKey)
    if (r.composite) keys.push(r.composite.blobKey)
  }
  return keys
}

async function orphanTotal(rows: Recording[]): Promise<number> {
  const { blobStore } = await import('@core/store')
  const { pendingBlobKeys } = await import('@core/capture/recovery')
  const keep = new Set([...referencedKeys(rows), ...pendingBlobKeys()])
  let total = 0
  for (const f of await blobStore.list()) {
    if (keep.has(f.key) || f.key.startsWith('__')) continue
    total += f.size
  }
  return total
}

function bytes(n: number): string {
  const mb = n / 1048576
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}

/** What this take occupies on disk — every channel plus the composite. */
function size(r: Recording): string {
  let bytes = r.channels.reduce((n, c) => n + (c.bytes ?? 0), 0)
  bytes += r.composite?.bytes ?? 0
  if (bytes <= 0) return ''
  const mb = bytes / 1048576
  return mb >= 1 ? `${mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `${Math.round(bytes / 1024)} KB`
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
