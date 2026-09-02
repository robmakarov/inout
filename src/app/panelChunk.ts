/**
 * U1's chunk — the on-top recorder window and its contents, off first paint.
 *
 * Same rule as editorChunk.ts and for the same reason (O7): ONE module owns the
 * dynamic import, so React.lazy and the mount-time warm resolve the SAME chunk.
 * Statically imported it cost the first-paint payload 7.4 KB (290.7 → 298.1 KB
 * against a 300 KB gate) for a window most loads never open.
 *
 * WARMED AT MOUNT, never fetched from the press. `requestWindow()` needs the
 * click's transient activation, which lasts ~5 s — a chunk fetched on the press
 * would be racing it. Warmed, the press resolves this from the module cache in
 * a microtask, which the activation survives (measured, scripts/dpip-check.mjs).
 */
export { RecorderPanel, type PanelMode } from '@app/components/RecorderPanel'
export * from '@app/lib/recorderPanel'
