import type { CloudProvider } from '../types'
import { SupabaseCloudProvider } from './supabase'

let instance: CloudProvider | null | undefined

/** Null when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not configured. */
export function getCloudProvider(): CloudProvider | null {
  if (instance === undefined) {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
    instance = url && anonKey ? new SupabaseCloudProvider(url, anonKey) : null
  }
  return instance
}
