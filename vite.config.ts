/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * B3 — WRITE DOWN WHAT THIS BUILD IS MADE OF.
 *
 * The service worker is cache-first for /assets/, which is safe because the
 * names are content-hashed — but its install-time precache list is `/` and the
 * icons, not one line of JS. So a chunk is only ever cached once some session
 * has actually asked for it, and the LAZY ones (the export worker, the size
 * probe, EditorScreen, session) are exactly the chunks a tab has not asked for
 * yet. When such a tab spans a deploy, the cache misses, the network has moved
 * on, and Vercel serves 404. Measured in `scripts/stale-tab-check.mjs`: seven
 * of a build's assets 404 in an open tab after the next deploy, including the
 * two Robert's own console named.
 *
 * This emits the list so the worker can cache the whole build up front. It is
 * written at build time because only the bundler knows the lazy chunks; nothing
 * in the app can enumerate them.
 */
function assetManifest() {
  return {
    name: 'inout-asset-manifest',
    apply: 'build' as const,
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      const files = Object.keys(bundle)
        .filter((f) => f.startsWith('assets/'))
        .map((f) => `/${f}`)
        .sort()
      ;(this as unknown as { emitFile: (f: unknown) => void }).emitFile({
        type: 'asset',
        fileName: 'asset-manifest.json',
        source: JSON.stringify({ assets: files }),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), assetManifest()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@app': fileURLToPath(new URL('./src/app', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Cross-origin isolation unlocks performance.measureUserAgentSpecificMemory(),
    // the only instrument that counts ArrayBuffer backing stores (performance.memory
    // does not). Opt-in via env so normal dev and prod are untouched — set by
    // scripts/exp.mjs for memory experiments only.
    headers:
      process.env.INOUT_COI === '1'
        ? {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          }
        : undefined,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
