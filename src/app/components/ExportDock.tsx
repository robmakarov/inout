import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CloudProvider,
  CloudShare,
  CloudUser,
  ExportJobRecord,
  ExportResult,
} from '@core/types'
import { saveToFile } from '@core/share'
import { getCloudProvider } from '@core/cloud'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { formatRemaining, humanBytes } from '@app/lib/format'
import { loadExportJobs } from '@app/lib/exportJobs'
import { Icon } from '@app/components/Icon'
import { ProgressRing } from '@app/components/ProgressRing'

const PHASE_LABEL = {
  preparing: 'Preparing…',
  rendering: 'Rendering…',
  finalizing: 'Finalizing…',
} as const

/**
 * EVERY EXPORT, ON EVERY SCREEN — Robert, 2026-08-30: "i want rendering
 * process shown in block like on screenshot in bottom of screen layout and
 * happening further if i switch app screen, independetly".
 *
 * One dock, fixed to the bottom of the app, one row per job. A running job
 * shows its real place and a Cancel that actually reaches it; a finished one
 * becomes the saved row (the file is already in Downloads — the row offers
 * the second copy and the cloud link); a failed one says what happened. Rows
 * come from core/compose/exportJobs via the store mirror, so they are the
 * same rows before and after a refresh.
 */
export function ExportDock() {
  const jobs = useAppStore((s) => s.exportJobs)
  if (jobs.length === 0) return null
  return (
    <div className="xdock">
      {jobs.map((job) => (
        // runs in the key: a restart after refresh remounts the row, which
        // resets the ETA anchor to the new run's own slope.
        <DockRow key={`${job.id}:${job.runs}`} job={job} />
      ))}
    </div>
  )
}

function remove(id: string): void {
  void loadExportJobs().then((m) => m.removeExportJob(id))
}

function DockRow({ job }: { job: ExportJobRecord }) {
  if (job.state === 'running') return <RunningRow job={job} />
  if (job.state === 'failed') return <FailedRow job={job} />
  return <SavedRow job={job} />
}

/** What a row is ABOUT — with several jobs at once, the rows need names. */
function jobLabel(job: ExportJobRecord): string {
  if (job.kind === 'ai') return 'For AI'
  const s = job.settings
  return s ? `${s.width}×${s.height}` : 'video'
}

function RunningRow({ job }: { job: ExportJobRecord }) {
  const ratio = job.progress.ratio
  const phase = job.progress.phase
  const remainingMs = useRemainingMs(phase, ratio)
  return (
    <div className="xstrip xstrip--progress">
      <ProgressRing ratio={ratio} />
      <span className="xstrip__pct">{Math.round(ratio * 100)}%</span>
      <span className="xstrip__phase">{PHASE_LABEL[phase]}</span>
      <span className="xstrip__meta">{jobLabel(job)}</span>
      {remainingMs !== null && <span className="xstrip__eta">{formatRemaining(remainingMs)}</span>}
      <button className="btn btn--ghost xstrip__cancel" onClick={() => remove(job.id)}>
        Cancel
      </button>
    </div>
  )
}

function FailedRow({ job }: { job: ExportJobRecord }) {
  return (
    <div className="xstrip xstrip--failed">
      <span className="xstrip__name" title={job.error}>
        Export failed{job.error ? ` · ${job.error}` : ''}
      </span>
      <span className="xstrip__meta">{jobLabel(job)}</span>
      <button className="xstrip__x" onClick={() => remove(job.id)} aria-label="Dismiss">
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

/**
 * WHAT THE EXPORT PRODUCED, on one line. The file is already in the user's
 * downloads — pressing Export was asking for it — so this offers the second
 * copy (a download the browser put somewhere unexpected, a dismissed dialog)
 * and the cloud link, which is a genuinely different thing to want.
 */
function SavedRow({ job }: { job: ExportJobRecord }) {
  const meta = job.result
  const [result, setResult] = useState<ExportResult | null>(null)
  useEffect(() => {
    let alive = true
    void loadExportJobs()
      .then((m) => m.exportJobResult(job.id))
      .then((r) => {
        if (alive) setResult(r)
      })
    return () => {
      alive = false
    }
  }, [job.id])
  if (!meta) return null
  return (
    <div className="xstrip xstrip--saved">
      <Icon name="check" size={15} />
      <span className="xstrip__name" title={meta.fileName}>
        Saved to your downloads · {meta.fileName}
      </span>
      <span className="xstrip__meta">
        {meta.ai
          ? `${meta.ai.pages} pages · ~${Math.round(meta.ai.approxTokens / 100) / 10}k tokens`
          : `${humanBytes(meta.bytes)} · ${meta.width}×${meta.height}`}
      </span>
      {result && (
        <button className="xstrip__btn" onClick={() => saveToFile(result)}>
          <Icon name="download" size={13} />
          <span>Save again</span>
        </button>
      )}
      {result && <CloudAction result={result} />}
      <button className="xstrip__x" onClick={() => remove(job.id)} aria-label="Dismiss">
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

/** Below this the slope is still noise — a number that swings by minutes is
 *  worse than no number. */
const ETA_MIN_ELAPSED_MS = 3000
const ETA_MIN_RATIO = 0.03

/**
 * How long is left — measured, not modelled.
 *
 * The progress ratio is NOT uniform in time, so extrapolating the whole thing
 * would lie: `preparing` (0→0.05) hides an entire audio decode on a long take
 * and `finalizing` is a muxer flush. Only the `rendering` span advances at a
 * rate worth reading, so the estimate anchors at the first rendering sample
 * and takes its slope from there — and says nothing at all until that slope
 * has 3 s and 3 % under it.
 */
function useRemainingMs(phase: keyof typeof PHASE_LABEL, ratio: number): number | null {
  const anchor = useRef<{ t: number; ratio: number } | null>(null)
  if (phase === 'preparing') anchor.current = null
  else if (phase === 'rendering' && !anchor.current) {
    anchor.current = { t: performance.now(), ratio }
  }
  if (phase !== 'rendering' || !anchor.current) return null
  const dt = performance.now() - anchor.current.t
  const dr = ratio - anchor.current.ratio
  if (dt < ETA_MIN_ELAPSED_MS || dr < ETA_MIN_RATIO) return null
  return ((1 - ratio) / dr) * dt
}

/**
 * The cloud link, reduced to one control. It was a card with an avatar, an
 * email and a sign-out row; that is an account panel, and an account panel is
 * not what someone who just exported a video is looking at.
 */
function CloudAction({ result }: { result: ExportResult }) {
  const provider = useMemo(() => getCloudProvider(), [])
  if (!provider) return null
  return <CloudInner provider={provider} result={result} />
}

function CloudInner({ provider, result }: { provider: CloudProvider; result: ExportResult }) {
  const toast = useAppStore((s) => s.toast)
  const [user, setUser] = useState<CloudUser | null>(null)
  const [uploading, setUploading] = useState(false)
  const [share, setShare] = useState<CloudShare | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    provider
      .getUser()
      .then((u) => {
        if (alive) setUser(u)
      })
      .catch(() => {})
    const off = provider.onAuthChange((u) => setUser(u))
    return () => {
      alive = false
      off()
    }
  }, [provider])

  const createLink = async () => {
    setUploading(true)
    try {
      const s = await provider.upload(result)
      setShare(s)
      analytics.track('share_upload_success', { sizeBytes: result.blob.size })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      toast(message, 'error')
      analytics.track('share_upload_error', { message })
    } finally {
      setUploading(false)
    }
  }

  if (share) {
    return (
      <button
        className="xstrip__btn"
        title={`${share.url} — expires in ${provider.quota.shareTtlDays} days`}
        onClick={() => {
          void navigator.clipboard.writeText(share.url).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        <span>{copied ? 'Copied' : 'Copy link'}</span>
      </button>
    )
  }

  if (!user) {
    return (
      <button
        className="xstrip__btn"
        onClick={() =>
          void provider.signInWithGoogle().catch((err: unknown) => {
            toast(err instanceof Error ? err.message : 'Sign-in failed', 'error')
          })
        }
      >
        <Icon name="google" size={13} />
        <span>Sign in for a link</span>
      </button>
    )
  }

  return (
    <button className="xstrip__btn" disabled={uploading} onClick={() => void createLink()}>
      {uploading ? <span className="spinner" /> : <Icon name="link" size={13} />}
      <span>{uploading ? 'Uploading…' : 'Create link'}</span>
    </button>
  )
}
