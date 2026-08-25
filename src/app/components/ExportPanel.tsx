import { useEffect, useMemo, useRef, useState } from 'react'
import type { CloudProvider, CloudShare, CloudUser, ExportResult } from '@core/types'
import { loadRecovery } from '@core/capture'
import { saveToFile } from '@core/share'
import { getCloudProvider } from '@core/cloud'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { formatClock, formatRemaining, humanBytes } from '@app/lib/format'
import { Icon } from '@app/components/Icon'
import { ProgressRing } from '@app/components/ProgressRing'

const PHASE_LABEL = {
  preparing: 'Preparing…',
  rendering: 'Rendering…',
  finalizing: 'Finalizing…',
} as const

/**
 * The export flow lives in the editor's bottom slot, replacing the timeline —
 * the player above stays put so the frame never moves. Progress while the MP4
 * renders, then the result actions; Back returns to the timeline.
 */
export function ExportPanel({ onBack }: { onBack: () => void }) {
  const mode = useAppStore((s) => s.mode)
  if (mode === 'exporting') return <Progress />
  return <Result onBack={onBack} />
}

/** Below this the slope is still noise — a number that swings by minutes is
 *  worse than no number. */
const ETA_MIN_ELAPSED_MS = 3000
const ETA_MIN_RATIO = 0.03

/**
 * How long is left — measured, not modelled.
 *
 * A ring and a percentage are enough for the 60-105 ms instant export. They are
 * not enough for a full render: PO's 15m38s take sat in this panel for ~3.5
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

function Progress() {
  const progress = useAppStore((s) => s.exportProgress)
  const abort = useAppStore((s) => s.exportAbort)
  const ratio = progress?.ratio ?? 0
  const phase = progress?.phase ?? 'preparing'
  const remainingMs = useRemainingMs(phase, ratio)
  return (
    <div className="xp xp--progress">
      <ProgressRing ratio={ratio} />
      <div className="xp__pct">{Math.round(ratio * 100)}%</div>
      <div className="xp__phase">{PHASE_LABEL[phase]}</div>
      {remainingMs !== null && <div className="xp__eta">{formatRemaining(remainingMs)}</div>}
      <button className="btn btn--ghost" onClick={() => abort?.abort()}>
        Cancel
      </button>
    </div>
  )
}

function Result({ onBack }: { onBack: () => void }) {
  const result = useAppStore((s) => s.exportResult)
  if (!result) return null
  // AI1: an AI export is a document, so the panel says pages and tokens. Its
  // width/height are one keyframe's, and reporting them as "the video" would
  // be a lie about what the file is.
  const ai = result.ai
  return (
    <div className="xp">
      <div className="xp__head">
        <button className="xp__back" onClick={onBack} aria-label="Back to editing">
          <Icon name="chevron-left" size={18} />
          <span>Editing</span>
        </button>
        <span className="xp__meta">
          {ai
            ? `${formatClock(result.durationMs)} · ${humanBytes(result.blob.size)} · ${ai.pages} pages · ~${Math.round(ai.approxTokens / 100) / 10}k tokens`
            : `${formatClock(result.durationMs)} · ${humanBytes(result.blob.size)} · ${result.width}×${result.height}`}
        </span>
      </div>
      <div className="xp__actions">
        <button className="btn btn--primary btn--wide" onClick={() => saveToFile(result)}>
          <Icon name={ai ? 'doc' : 'download'} size={16} />
          <span>{ai ? 'Save PDF for AI' : 'Save file'}</span>
        </button>
      </div>
      <CloudCard result={result} />
      <button
        className="btn btn--ghost xp__new"
        onClick={() => {
          const rec = useAppStore.getState().recording
          if (rec) void loadRecovery().then((m) => m.markRecordingDismissed(rec.id))
          useAppStore.getState().resetToCapture()
        }}
      >
        New recording
      </button>
    </div>
  )
}

function CloudCard({ result }: { result: ExportResult }) {
  const provider = useMemo(() => getCloudProvider(), [])
  if (!provider) {
    return (
      <div className="cloud">
        <div className="cloud__off-title">Cloud sharing not configured</div>
        <div className="cloud__off-hint">Add Supabase keys to enable links</div>
      </div>
    )
  }
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

  const signIn = () => {
    void provider.signInWithGoogle().catch((err: unknown) => {
      toast(err instanceof Error ? err.message : 'Sign-in failed', 'error')
    })
  }

  const signOut = () => {
    void provider.signOut().catch(() => {})
  }

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

  const copy = () => {
    if (!share) return
    void navigator.clipboard.writeText(share.url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  if (!user) {
    return (
      <div className="cloud">
        <button className="btn btn--surface btn--wide" onClick={signIn}>
          <Icon name="google" size={16} />
          <span>Continue with Google</span>
        </button>
      </div>
    )
  }

  return (
    <div className="cloud">
      <div className="cloud__user">
        {user.avatarUrl ? (
          <img className="cloud__avatar" src={user.avatarUrl} alt="" />
        ) : (
          <span className="cloud__avatar cloud__avatar--initial">
            {(user.name ?? user.email ?? '?').charAt(0).toUpperCase()}
          </span>
        )}
        <span className="cloud__email">{user.email ?? user.name ?? 'Signed in'}</span>
        <button className="cloud__signout" onClick={signOut}>
          Sign out
        </button>
      </div>
      {share ? (
        <div className="cloud__link">
          <div className="cloud__link-row">
            <span className="cloud__url" title={share.url}>
              {share.url}
            </span>
            <button className="cloud__copy" onClick={copy} aria-label="Copy link">
              <Icon name={copied ? 'check' : 'copy'} size={15} />
            </button>
          </div>
          <div className="cloud__expiry">Expires in {provider.quota.shareTtlDays} days</div>
        </div>
      ) : (
        <button
          className="btn btn--surface btn--wide"
          disabled={uploading}
          onClick={() => void createLink()}
        >
          {uploading ? (
            <>
              <span className="spinner" />
              <span>Uploading…</span>
            </>
          ) : (
            <>
              <Icon name="link" size={16} />
              <span>Create link</span>
            </>
          )}
        </button>
      )}
    </div>
  )
}
