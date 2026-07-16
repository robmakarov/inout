import { useEffect, useMemo, useState } from 'react'
import type { CloudProvider, CloudShare, CloudUser, ExportResult } from '@core/types'
import { markRecordingDismissed } from '@core/capture'
import { saveToFile } from '@core/share'
import { getCloudProvider } from '@core/cloud'
import { analytics } from '@core/analytics'
import { useAppStore } from '@app/state/store'
import { formatClock, humanBytes } from '@app/lib/format'
import { Icon } from '@app/components/Icon'

export function ShareScreen() {
  const result = useAppStore((s) => s.exportResult)
  if (!result) return null
  return <Share result={result} />
}

function Share({ result }: { result: ExportResult }) {
  // Created and revoked in the same effect: StrictMode's mount/cleanup/remount
  // cycle would permanently revoke a useMemo-created URL.
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const u = URL.createObjectURL(result.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [result])

  return (
    <div className="share">
      <div className="share__col">
        <h1 className="share__title">Ready</h1>
        <video className="share__video" src={url} controls playsInline />
        <div className="share__meta">
          {formatClock(result.durationMs)} · {humanBytes(result.blob.size)} · {result.width}×
          {result.height}
        </div>
        <div className="share__actions">
          <button className="btn btn--primary btn--wide" onClick={() => saveToFile(result)}>
            <Icon name="download" size={16} />
            <span>Save file</span>
          </button>
        </div>
        <CloudCard result={result} />
        <button
          className="btn btn--ghost share__new"
          onClick={() => {
            const rec = useAppStore.getState().recording
            if (rec) markRecordingDismissed(rec.id)
            useAppStore.getState().resetToCapture()
          }}
        >
          New recording
        </button>
      </div>
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
