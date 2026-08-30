import { useEffect, useMemo, useRef, useState } from 'react'
import type { CloudProvider, CloudShare, CloudUser, ExportResult } from '@core/types'
import { saveToFile } from '@core/share'
import { getCloudProvider } from '@core/cloud'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { formatRemaining, humanBytes } from '@app/lib/format'
import { Icon } from '@app/components/Icon'
import { ProgressRing } from '@app/components/ProgressRing'

const PHASE_LABEL = {
  preparing: 'Preparing…',
  rendering: 'Rendering…',
  finalizing: 'Finalizing…',
} as const

/**
 * THERE ARE THREE SCREENS AND THIS IS NOT ONE OF THEM (UI1, 2026-08-30).
 *
 * Robert: "rendering loader show on same screen where download button is, so we
 * have only main screen, recording screen, and editing screen", and of the old
 * result panel: "no need for screen on first screenshot at all".
 *
 * The export used to take over the whole bottom half twice — once as a progress
 * panel, then again as a result panel with a Save button, a cloud card and a
 * "New recording" button. Two screens for one action, and the second one asked
 * a question (save it?) that pressing Export had already answered.
 *
 * So both halves are strips now, and they live in the slot the quality slider
 * occupies: the render replaces it while it runs, and what it produced sits
 * above it afterwards. The editor never goes away, so the picture never moves.
 */
export function ExportProgressStrip() {
  const progress = useAppStore((s) => s.exportProgress)
  const abort = useAppStore((s) => s.exportAbort)
  const ratio = progress?.ratio ?? 0
  const phase = progress?.phase ?? 'preparing'
  const remainingMs = useRemainingMs(phase, ratio)
  return (
    <div className="xstrip xstrip--progress">
      <ProgressRing ratio={ratio} />
      <span className="xstrip__pct">{Math.round(ratio * 100)}%</span>
      <span className="xstrip__phase">{PHASE_LABEL[phase]}</span>
      {remainingMs !== null && (
        <span className="xstrip__eta">{formatRemaining(remainingMs)}</span>
      )}
      <button className="btn btn--ghost xstrip__cancel" onClick={() => abort?.abort()}>
        Cancel
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
 * A ring and a percentage are enough for the 60-105 ms instant export. They are
 * not enough for a full render: Robert's 15m38s take sat in this panel for ~3.5
 * minutes with nothing to say whether that meant seconds or an hour.
 *
 * The progress ratio is NOT uniform in time, so extrapolating the whole thing
 * would lie: `preparing` (0→0.05) hides an entire audio decode on a long take
 * and `finalizing` is a muxer flush. Only the `rendering` span advances at a
 * rate worth reading, so the estimate anchors at the first rendering sample and
 * takes its slope from there — and says nothing at all until that slope has 3 s
 * and 3 % under it.
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
 * WHAT THE EXPORT PRODUCED, on one line, above the slider that made it.
 *
 * The file is already in the user's downloads — pressing Export is asking for
 * it, and asking again afterwards was the "bullshit extra step". This says so
 * and offers the second copy, which is the only reason anyone would press it: a
 * download the browser put somewhere unexpected, or a dialog that was
 * dismissed. The cloud link keeps its place here because a link is a genuinely
 * different thing to want, and it stays a choice.
 */
export function ExportSavedStrip({ result, onDismiss }: { result: ExportResult; onDismiss: () => void }) {
  const ai = result.ai
  return (
    <div className="xstrip xstrip--saved">
      <Icon name="check" size={15} />
      <span className="xstrip__name" title={result.fileName}>
        Saved to your downloads · {result.fileName}
      </span>
      <span className="xstrip__meta">
        {ai
          ? `${ai.pages} pages · ~${Math.round(ai.approxTokens / 100) / 10}k tokens`
          : `${humanBytes(result.blob.size)} · ${result.width}×${result.height}`}
      </span>
      <button className="xstrip__btn" onClick={() => saveToFile(result)}>
        <Icon name="download" size={13} />
        <span>Save again</span>
      </button>
      <CloudAction result={result} />
      <button className="xstrip__x" onClick={onDismiss} aria-label="Dismiss">
        <Icon name="x" size={12} />
      </button>
    </div>
  )
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
