import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { CloudProvider, CloudShare, CloudUploadProgress, CloudUser, ExportResult } from '../types'

const BUCKET = 'exports'
const DAY_MS = 86_400_000

interface ShareRow {
  id: string
  file_name: string
  object_path: string
  size_bytes: number
  created_at: string
  expires_at: string
}

function toCloudUser(u: User): CloudUser {
  const meta = u.user_metadata ?? {}
  return {
    id: u.id,
    email: u.email ?? null,
    name: (meta.full_name as string | undefined) ?? (meta.name as string | undefined) ?? null,
    avatarUrl: (meta.avatar_url as string | undefined) ?? null,
  }
}

function fileExt(result: ExportResult): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(result.fileName)
  if (m) return m[1].toLowerCase()
  if (result.mimeType.includes('mp4')) return 'mp4'
  if (result.mimeType.includes('webm')) return 'webm'
  return 'bin'
}

function formatBytes(n: number): string {
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export class SupabaseCloudProvider implements CloudProvider {
  readonly quota = { maxTotalBytes: 512 * 1024 * 1024, shareTtlDays: 7 }
  private readonly supabase: SupabaseClient

  constructor(url: string, anonKey: string) {
    this.supabase = createClient(url, anonKey, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
    })
  }

  async signInWithGoogle(): Promise<void> {
    const { error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin },
    })
    if (error) throw new Error(`Google sign-in failed: ${error.message}`)
  }

  async signOut(): Promise<void> {
    const { error } = await this.supabase.auth.signOut()
    if (error) throw new Error(`Sign-out failed: ${error.message}`)
  }

  async getUser(): Promise<CloudUser | null> {
    const { data } = await this.supabase.auth.getUser()
    return data.user ? toCloudUser(data.user) : null
  }

  onAuthChange(cb: (u: CloudUser | null) => void): () => void {
    const { data } = this.supabase.auth.onAuthStateChange((_event, session) => {
      cb(session?.user ? toCloudUser(session.user) : null)
    })
    return () => data.subscription.unsubscribe()
  }

  async upload(result: ExportResult, onProgress?: (p: CloudUploadProgress) => void): Promise<CloudShare> {
    const user = await this.requireUser()

    const usage = await this.usageBytes()
    if (usage + result.blob.size > this.quota.maxTotalBytes) {
      throw new Error(
        `Not enough cloud storage: ${formatBytes(usage)} of ${formatBytes(this.quota.maxTotalBytes)} used, ` +
          `this file needs ${formatBytes(result.blob.size)}. Delete old shares to free space.`,
      )
    }

    const id = crypto.randomUUID()
    const objectPath = `${user.id}/${id}.${fileExt(result)}`
    const expiresAt = new Date(Date.now() + this.quota.shareTtlDays * DAY_MS)

    // supabase-js standard uploads expose no progress events; UI shows indeterminate progress.
    onProgress?.({ ratio: 0 })

    const { error: uploadError } = await this.supabase.storage
      .from(BUCKET)
      .upload(objectPath, result.blob, { contentType: result.mimeType })
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`)

    const { error: insertError } = await this.supabase.from('shares').insert({
      id,
      user_id: user.id,
      file_name: result.fileName,
      object_path: objectPath,
      size_bytes: result.blob.size,
      expires_at: expiresAt.toISOString(),
    })
    if (insertError) {
      await this.supabase.storage.from(BUCKET).remove([objectPath])
      throw new Error(`Upload failed: ${insertError.message}`)
    }

    onProgress?.({ ratio: 1 })

    const url = await this.signUrl(objectPath, this.quota.shareTtlDays * 86_400)
    return {
      id,
      fileName: result.fileName,
      sizeBytes: result.blob.size,
      url,
      createdAt: Date.now(),
      expiresAt: expiresAt.getTime(),
    }
  }

  async listShares(): Promise<CloudShare[]> {
    const { data, error } = await this.supabase
      .from('shares')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw new Error(`Could not list shares: ${error.message}`)
    const rows = (data ?? []) as ShareRow[]

    const now = Date.now()
    const live = rows.filter((r) => Date.parse(r.expires_at) > now)
    const expired = rows.filter((r) => Date.parse(r.expires_at) <= now)
    if (expired.length > 0) void this.purge(expired)
    if (live.length === 0) return []

    // Batch signing takes a single TTL; use the longest remaining lifetime.
    const ttlSec = Math.max(60, ...live.map((r) => Math.ceil((Date.parse(r.expires_at) - now) / 1000)))
    const { data: signed, error: signError } = await this.supabase.storage
      .from(BUCKET)
      .createSignedUrls(live.map((r) => r.object_path), ttlSec)
    if (signError) throw new Error(`Could not refresh share links: ${signError.message}`)

    const urlByPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]))
    return live.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      sizeBytes: r.size_bytes,
      url: urlByPath.get(r.object_path) ?? '',
      createdAt: Date.parse(r.created_at),
      expiresAt: Date.parse(r.expires_at),
    }))
  }

  async deleteShare(id: string): Promise<void> {
    const { data, error } = await this.supabase
      .from('shares')
      .select('object_path')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(`Could not delete share: ${error.message}`)
    if (!data) return

    const path = (data as Pick<ShareRow, 'object_path'>).object_path
    const { error: removeError } = await this.supabase.storage.from(BUCKET).remove([path])
    if (removeError) throw new Error(`Could not delete share file: ${removeError.message}`)

    const { error: rowError } = await this.supabase.from('shares').delete().eq('id', id)
    if (rowError) throw new Error(`Could not delete share record: ${rowError.message}`)
  }

  async deleteAllData(): Promise<void> {
    const user = await this.requireUser()

    const { data, error } = await this.supabase.from('shares').select('id, object_path')
    if (error) throw new Error(`Could not list data for deletion: ${error.message}`)
    const rows = (data ?? []) as Pick<ShareRow, 'id' | 'object_path'>[]

    if (rows.length > 0) {
      const { error: removeError } = await this.supabase.storage
        .from(BUCKET)
        .remove(rows.map((r) => r.object_path))
      if (removeError) throw new Error(`Could not delete files: ${removeError.message}`)
    }

    const { error: rowError } = await this.supabase.from('shares').delete().eq('user_id', user.id)
    if (rowError) throw new Error(`Could not delete records: ${rowError.message}`)
  }

  private async requireUser(): Promise<CloudUser> {
    const user = await this.getUser()
    if (!user) throw new Error('Sign in required')
    return user
  }

  private async usageBytes(): Promise<number> {
    const { data, error } = await this.supabase.from('shares').select('size_bytes')
    if (error) throw new Error(`Could not check storage usage: ${error.message}`)
    return ((data ?? []) as Pick<ShareRow, 'size_bytes'>[]).reduce((sum, r) => sum + r.size_bytes, 0)
  }

  private async signUrl(path: string, ttlSec: number): Promise<string> {
    const { data, error } = await this.supabase.storage.from(BUCKET).createSignedUrl(path, ttlSec)
    if (error || !data) throw new Error(`Could not create share link: ${error?.message ?? 'unknown error'}`)
    return data.signedUrl
  }

  private async purge(rows: ShareRow[]): Promise<void> {
    try {
      await this.supabase.storage.from(BUCKET).remove(rows.map((r) => r.object_path))
      await this.supabase.from('shares').delete().in('id', rows.map((r) => r.id))
    } catch (e) {
      console.warn('Failed to clean up expired shares', e)
    }
  }
}
