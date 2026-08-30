import { useEffect, useState } from 'react'
import type { ExportProgress, Recording } from '@core/types'
import { clampEditState, defaultEditState } from '@core/timeline'
import { qualityStepById } from '@core/qualityStep'
import { useAppStore } from '@app/state/store'
import { CHANNEL_META } from '@app/lib/channels'
import { useTakeThumbs } from '@app/hooks/useTakeThumbs'
import { Icon } from '@app/components/Icon'

/**
 * EVERY TAKE YOU HAVE, AND EVERY WAY BACK INTO ONE.
 *
 * Robert, 2026-08-30: "how th fuck will i open last night take in the editor".
 * He could not, and neither could anyone. The app opens the newest recording at
 * boot and there was no other route: record a second take, or dismiss the first,
 * and the earlier one became unreachable while still sitting on disk with its
 * blobs, its edit state and its diagnostics intact.
 *
 * UI1 turned the list into CARDS IN THE PAGE — Robert: "show kept videos saved
 * above slider, not floating, as cards with delete and download and send and
 * copy buttons, watch and edit too if possible". It used to be an overlay
 * floating over the record button, which is the wrong shape for the one thing
 * on this screen you are meant to be able to act on: a floating panel is a
 * notification, and these are your files.
 *
 * WHAT EACH BUTTON DOES:
 *   Watch     opens the take in the editor and starts playing it.
 *   Edit      opens it in the editor, paused, exactly as the boot recovery does.
 *   Download  runs the export and saves the file — no editor round-trip. On an
 *             untouched take at its own step this is the instant packet copy,
 *             so it is a second's work; on anything else it renders, and the
 *             card says so while it does.
 *   Send/Copy are NOT WIRED YET and say so (Robert: "make them blank for now").
 *             They are on the card because that is where he asked for them, and
 *             a disabled control that names itself is honest about a gap that a
 *             missing control hides.
 *   Delete    removes the take and its files.
 */
export function TakesList({ onOpen }: { onOpen?: () => void }) {
  const [takes, setTakes] = useState<Recording[] | null>(null)
  const [busy, setBusy] = useState(false)
  /** Bytes on disk belonging to no take — see reclaim(). */
  const [orphanBytes, setOrphanBytes] = useState(0)
  /** What the last Reclaim actually did. Null until one has been pressed. */
  const [reclaimed, setReclaimed] = useState<string | null>(null)
  /** The take being exported straight from its card, and how far along. */
  const [saving, setSaving] = useState<{ id: string; label: string } | null>(null)
  /** One decoded frame per take (UI1) — best-effort, empty until it lands. */
  const thumbs = useTakeThumbs(takes)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        // Imported here, not at module scope, so the store stays out of the
        // first-paint chunk (O7) — the same rule App.tsx's recovery follows.
        const { recordingsRepo } = await import('@core/store')
        const rows = await recordingsRepo.list()
        if (alive) setTakes(rows)
        const { orphanBlobBytes } = await import('@core/store/reclaim')
        if (alive) setOrphanBytes(await orphanBlobBytes())
      } catch {
        if (alive) setTakes([])
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const refreshOrphans = async (): Promise<void> => {
    const { orphanBlobBytes } = await import('@core/store/reclaim')
    setOrphanBytes(await orphanBlobBytes().catch(() => 0))
  }

  /**
   * RECLAIM WHAT BELONGS TO NOTHING — and it is BOOT'S OWN SWEEP, not a second
   * copy of it. This used to inline its own loop, and the copy is what broke:
   * one `await blobStore.remove()` with no catch, so the first file that
   * refused removal threw, the loop died, nothing else was touched and the
   * number on screen never moved. Robert, 2026-08-30: "reclaim button still
   * fucking doing nothing, fix it or fucking remove this shit".
   *
   * Delegating to reclaim.ts means the count, the button and the boot sweep
   * cannot disagree about what an orphan is. And the result is REPORTED: a
   * sweep that frees nothing has to say so, because silence is what "does
   * nothing" is made of.
   */
  const reclaim = async (): Promise<void> => {
    setBusy(true)
    try {
      const { reclaimOrphanBlobs, orphanBlobBytes } = await import('@core/store/reclaim')
      const result = await reclaimOrphanBlobs()
      setOrphanBytes(await orphanBlobBytes().catch(() => 0))
      setReclaimed(
        result.removed === 0 && result.failed === 0
          ? 'Nothing left to free.'
          : `Freed ${bytes(result.bytes)}` +
              (result.failed > 0
                ? ` — ${result.failed} file${result.failed === 1 ? '' : 's'} still in use, restarting the app will get ${result.failed === 1 ? 'it' : 'them'}.`
                : '.'),
      )
    } catch (err) {
      setReclaimed(`Could not free the space: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (takes === null || (takes.length === 0 && orphanBytes <= 0 && !reclaimed)) return null

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      const { recordingsRepo } = await import('@core/store')
      await recordingsRepo.remove(id)
      const left = (takes ?? []).filter((r) => r.id !== id)
      setTakes(left)
      await refreshOrphans()
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
      await refreshOrphans()
    } finally {
      setBusy(false)
    }
  }

  const openTake = async (rec: Recording, intent: 'watch' | 'edit'): Promise<void> => {
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
    s.setOpenIntent(intent)
    s.setMode('editor')
    onOpen?.()
  }

  /**
   * SAVE THE FILE WITHOUT GOING THROUGH THE EDITOR.
   *
   * The same call the editor's Export makes — `exportByBestPath` with the
   * take's own top step — so a card download and an editor export of an
   * untouched take are the same file by the same path, including the instant
   * packet copy. Anything else would be a second export ladder, and two
   * ladders disagree eventually.
   */
  const download = async (rec: Recording): Promise<void> => {
    if (saving) return
    setSaving({ id: rec.id, label: 'Preparing…' })
    try {
      const [{ exportByBestPath }, { settingsForTier, tiersForTake }, { saveToFile }, store] =
        await Promise.all([
          import('@core/compose'),
          import('@core/compose/quality'),
          import('@core/share'),
          import('@core/store'),
        ])
      let edit: import('@core/types').EditState | undefined
      try {
        edit = await store.editsRepo.get(rec.id)
      } catch {
        edit = undefined
      }
      const steps = tiersForTake(rec)
      const top = steps[steps.length - 1]!
      const { result } = await exportByBestPath({
        recording: rec,
        edit: clampEditState(rec, edit ?? defaultEditState(rec)),
        settings: settingsForTier(top, rec),
        // Only the default step may copy the composite — the same fence the
        // editor applies, answered by the same function (O3c).
        allowPacketCopy: top.id === '1080p',
        onProgress: (p: ExportProgress) =>
          setSaving({ id: rec.id, label: progressLabel(p) }),
      })
      saveToFile(result)
      useAppStore.getState().toast(`Saved ${result.fileName}`)
    } catch (err) {
      useAppStore
        .getState()
        .toast(err instanceof Error ? err.message : 'Could not save this take', 'error')
    } finally {
      setSaving(null)
    }
  }

  const notWired = () =>
    useAppStore.getState().toast('Sending and links aren’t wired up yet — use Download for now')

  /**
   * WHERE THE FILE WENT. A page cannot open Finder — there is no web API that
   * reveals a path, and there will not be one, because it is the browser's
   * sandbox working. What it CAN do is send you to the browser's own downloads
   * list, which is where the "Show in folder" button that does work lives.
   * Chrome blocks a script navigation to chrome://downloads, so this says so
   * rather than opening a tab that fails silently.
   */
  const showInFolder = () =>
    useAppStore
      .getState()
      .toast(
        'A web page can’t open Finder — your exports are in the browser’s Downloads (⌘⇧J in Chrome), where “Show in Folder” is.',
      )

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
      {(orphanBytes > 0 || reclaimed) && (
        <div className="takes__orphan">
          <span>
            {orphanBytes > 0
              ? `${bytes(orphanBytes)} left behind by takes that never finished — no recording to open, nothing using it.`
              : /* The sweep has to survive its own success: the line stays put
                   long enough to say what happened, or a button that worked
                   looks exactly like the button that did not. */
                (reclaimed ?? '')}
          </span>
          {orphanBytes > 0 && (
            <button type="button" className="takes__all" disabled={busy} onClick={() => void reclaim()}>
              Reclaim
            </button>
          )}
        </div>
      )}
      {orphanBytes > 0 && reclaimed && <div className="takes__orphan-note">{reclaimed}</div>}
      <ul className="takes__list">
        {takes.map((r) => {
          const savingThis = saving?.id === r.id
          return (
            <li key={r.id} className="takecard">
              {/* UI1, Robert: "dont change how inside card look, just add
                  preview picture left to it". So the card is a row now and
                  everything that was in it is the column on the right,
                  unchanged. A take whose frame will not decode simply gets the
                  empty box, which is the shape the card had before. */}
              <button
                type="button"
                className="takecard__thumb"
                disabled={busy}
                aria-label="Open this take"
                onClick={() => void openTake(r, 'edit')}
              >
                {thumbs[r.id] ? <img src={thumbs[r.id]} alt="" /> : <span />}
              </button>
              <div className="takecard__body">
              <div className="takecard__top">
                <span className="takecard__when">{when(r.createdAt)}</span>
                <span className="takecard__len">{clock(r.durationMs)}</span>
                <span className="takecard__size">{size(r)}</span>
                {stepLabel(r) && <span className="takecard__step">{stepLabel(r)}</span>}
                {lossNote(r) && <span className="takecard__loss">{lossNote(r)}</span>}
                <button
                  type="button"
                  className="takecard__del"
                  disabled={busy || savingThis}
                  aria-label="Delete this take"
                  title="Delete this take and its files"
                  onClick={() => void remove(r.id)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
              <div className="takecard__kinds">
                {[...new Set(r.channels.map((c) => c.kind))]
                  .map((k) => CHANNEL_META[k].label)
                  .join(' · ')}
              </div>
              <div className="takecard__actions">
                <button
                  type="button"
                  className="takecard__btn"
                  disabled={busy}
                  onClick={() => void openTake(r, 'watch')}
                >
                  <Icon name="play" size={13} />
                  <span>Watch</span>
                </button>
                <button
                  type="button"
                  className="takecard__btn"
                  disabled={busy}
                  onClick={() => void openTake(r, 'edit')}
                >
                  <Icon name="scissors" size={13} />
                  <span>Edit</span>
                </button>
                <button
                  type="button"
                  className="takecard__btn takecard__btn--go"
                  disabled={busy || !!saving}
                  onClick={() => void download(r)}
                >
                  <Icon name="download" size={13} />
                  <span>{savingThis ? saving.label : 'Download'}</span>
                </button>
                {/* Blank for now, by Robert's own call — present so the card is
                    the shape he asked for, disabled so it cannot lie. */}
                <button
                  type="button"
                  className="takecard__btn takecard__btn--soon"
                  title="Not wired up yet"
                  onClick={notWired}
                >
                  <Icon name="send" size={13} />
                  <span>Send</span>
                </button>
                <button
                  type="button"
                  className="takecard__btn takecard__btn--soon"
                  title="Not wired up yet"
                  onClick={notWired}
                >
                  <Icon name="link" size={13} />
                  <span>Copy link</span>
                </button>
                {/* UI1 — SHOW IN FOLDER, and it is honest about what it can do.
                    A web page cannot reveal a file in Finder or Explorer: there
                    is no API for it, and the one place that button really
                    exists is the browser's own downloads list. So this opens
                    THAT, which is the closest thing the platform allows and the
                    place the file actually is. */}
                <button
                  type="button"
                  className="takecard__btn"
                  title="Open the browser’s downloads — a web page cannot reach Finder itself"
                  onClick={showInFolder}
                >
                  <Icon name="folder" size={13} />
                  <span>Show in folder</span>
                </button>
              </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="takes__foot">
        Kept until you delete them — a take you exported is not removed automatically. Files you
        already saved to Downloads are the browser’s and can only be deleted there.
      </div>
    </div>
  )
}

function progressLabel(p: ExportProgress): string {
  if (p.phase === 'rendering') return `${Math.round(p.ratio * 100)}%`
  return p.phase === 'finalizing' ? 'Finishing…' : 'Preparing…'
}

/** Every blob key any take points at — the rest is orphaned. */
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

/** UI1: the ceiling this take was recorded under, which is also its export cap.
 *  Empty for a take made before the ceiling existed — and the badge is then not
 *  rendered at all, because an empty pill is a label about nothing. */
function stepLabel(r: Recording): string {
  return r.qualityStep ? qualityStepById(r.qualityStep).label : ''
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
