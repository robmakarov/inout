/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
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
