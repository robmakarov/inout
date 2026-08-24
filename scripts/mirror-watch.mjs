#!/usr/bin/env node
/**
 * Live mirror of the source tree into /tmp, so an agent session can run and
 * WATCH the real app instead of a snapshot.
 *
 * WHY: this project lives in ~/Downloads, and macOS TCC does not grant that
 * folder to the process that spawns the preview server. Anything it starts
 * with this directory as its cwd dies at bootstrap on `EPERM: uv_cwd` —
 * before npm, before vite, before any config is read. Three sessions hit that
 * wall and shipped capture fixes "argued from the code" instead of watching
 * the bug disappear. The Bash tool DOES have the grant, so the split is:
 *
 *     Bash (can read ~/Downloads)  ──rsync/watch──▶  /tmp/inout-dev
 *     preview launcher (cannot)    ──vite──────────▶  serves /tmp/inout-dev
 *
 * With this running, editing a file in the repo lands in the mirror in a few
 * ms and vite's HMR fires exactly as it would in a normal `npm run dev`.
 *
 *   node scripts/mirror-watch.mjs        # run in the background from Bash
 *   preview_start { name: "inout-tmp" }  # port 5174
 *
 * THE REAL FIX is to not live in ~/Downloads: move the repo (or grant the
 * desktop app Full Disk Access) and plain `npm run dev` works for agents too,
 * with no mirror at all. This exists because neither is mine to do.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync, statSync } from 'node:fs'
import { watch } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = process.argv[2] ?? '/tmp/inout-dev'

/** Recursive watches on node_modules would blow the descriptor budget for no
 *  gain — dependencies do not change while a dev server runs. The initial
 *  rsync still copies them, because vite needs them present. */
const WATCH_DIRS = ['src', 'public']
const WATCH_ROOT_FILES = new Set([
  'index.html',
  'experimental.html',
  'vite.config.ts',
  'tsconfig.json',
  'package.json',
])

function fullSync() {
  // Rooted excludes (leading /): an unanchored `dist` also eats
  // node_modules/vite/dist and the mirror will not boot.
  const r = spawnSync(
    'rsync',
    [
      '-a',
      '--delete',
      '--exclude',
      '/.git',
      '--exclude',
      '/dist',
      '--exclude',
      '/.ai',
      '--exclude',
      '*.mp4',
      `${SRC}/`,
      `${DEST}/`,
    ],
    { stdio: 'inherit' },
  )
  if (r.status !== 0) {
    console.error('[mirror] initial rsync failed — is rsync on PATH?')
    process.exit(1)
  }
  console.log(`[mirror] full sync ${SRC} -> ${DEST}`)
}

const pending = new Map()
function syncOne(rel) {
  // Debounce: editors write a file two or three times in a burst (temp file,
  // rename, mtime touch) and vite would reload once per write.
  clearTimeout(pending.get(rel))
  pending.set(
    rel,
    setTimeout(() => {
      pending.delete(rel)
      const from = join(SRC, rel)
      const to = join(DEST, rel)
      try {
        if (!existsSync(from)) {
          rmSync(to, { force: true, recursive: true })
          console.log(`[mirror] - ${rel}`)
          return
        }
        if (statSync(from).isDirectory()) return // its files arrive as their own events
        cpSync(from, to)
        console.log(`[mirror] > ${rel}`)
      } catch (err) {
        console.error(`[mirror] ! ${rel}: ${err.message}`)
      }
    }, 40),
  )
}

fullSync()

for (const dir of WATCH_DIRS) {
  const abs = join(SRC, dir)
  if (!existsSync(abs)) continue
  watch(abs, { recursive: true }, (_event, name) => {
    if (name) syncOne(join(dir, name))
  })
  console.log(`[mirror] watching ${dir}/`)
}

watch(SRC, (_event, name) => {
  if (name && WATCH_ROOT_FILES.has(name)) syncOne(name)
})
console.log(`[mirror] watching ${[...WATCH_ROOT_FILES].join(', ')}`)
console.log('[mirror] ready — start the "inout-tmp" preview (port 5174)')

// Keep the process alive; the Bash tool owns its lifetime.
setInterval(() => {}, 1 << 30)
