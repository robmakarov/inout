import type {
  CloudProvider,
  CloudShare,
  CloudUploadProgress,
  CloudUser,
  ExportResult,
} from '../types'
import { CLOUD_QUOTA } from './quota'

/**
 * The Supabase client is the single largest dependency on a page whose whole
 * point is to start recording instantly — and it is not needed until someone
 * asks for a share link, which cannot happen before a take exists. So the real
 * provider loads on first use behind this wrapper (task O7); the module graph
 * of the record path no longer contains @supabase/supabase-js at all.
 */
let implPromise: Promise<typeof import('./supabase')> | null = null
const loadImpl = (): Promise<typeof import('./supabase')> => (implPromise ??= import('./supabase'))

class LazyCloudProvider implements CloudProvider {
  readonly quota = CLOUD_QUOTA
  private inner: Promise<CloudProvider> | null = null

  constructor(
    private readonly url: string,
    private readonly anonKey: string,
  ) {}

  /** Loads (once) and constructs the real provider. */
  load(): Promise<CloudProvider> {
    this.inner ??= loadImpl().then((m) => new m.SupabaseCloudProvider(this.url, this.anonKey))
    return this.inner
  }

  async signInWithGoogle(): Promise<void> {
    return (await this.load()).signInWithGoogle()
  }
  async signOut(): Promise<void> {
    return (await this.load()).signOut()
  }
  async getUser(): Promise<CloudUser | null> {
    return (await this.load()).getUser()
  }
  onAuthChange(cb: (u: CloudUser | null) => void): () => void {
    let off: (() => void) | null = null
    let cancelled = false
    void this.load().then((p) => {
      if (cancelled) return
      off = p.onAuthChange(cb)
    })
    return () => {
      cancelled = true
      off?.()
    }
  }
  async upload(
    result: ExportResult,
    onProgress?: (p: CloudUploadProgress) => void,
  ): Promise<CloudShare> {
    return (await this.load()).upload(result, onProgress)
  }
  async listShares(): Promise<CloudShare[]> {
    return (await this.load()).listShares()
  }
  async deleteShare(id: string): Promise<void> {
    return (await this.load()).deleteShare(id)
  }
  async deleteAllData(): Promise<void> {
    return (await this.load()).deleteAllData()
  }
}

/**
 * A returning OAuth redirect carries its session in the URL, and the client
 * consumes it on construction (detectSessionInUrl). Nothing else on the page
 * would touch cloud code, so warm the client immediately in that one case —
 * otherwise a sign-in would appear to do nothing.
 */
function looksLikeAuthCallback(): boolean {
  if (typeof location === 'undefined') return false
  return (
    location.hash.includes('access_token=') ||
    location.hash.includes('error_description=') ||
    new URLSearchParams(location.search).has('code')
  )
}

let instance: CloudProvider | null | undefined

/** Null when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not configured. */
export function getCloudProvider(): CloudProvider | null {
  if (instance === undefined) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
    const lazy = url && anonKey ? new LazyCloudProvider(url, anonKey) : null
    if (lazy && looksLikeAuthCallback()) void lazy.load()
    instance = lazy
  }
  return instance
}
