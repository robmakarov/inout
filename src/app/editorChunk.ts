/**
 * The editor chunk's single entry point (task O7).
 *
 * One module owns the dynamic import so React.lazy and the record-time
 * prefetch resolve the SAME chunk — two import() sites with different
 * specifiers would produce two chunks and the prefetch would warm neither.
 */
let promise: Promise<typeof import('@app/screens/EditorScreen')> | null = null

export function loadEditorScreen(): Promise<typeof import('@app/screens/EditorScreen')> {
  return (promise ??= import('@app/screens/EditorScreen'))
}

/**
 * Called when recording starts: from here the user is busy for at least a few
 * seconds, so the chunk is fetched and parsed well before they can press stop.
 * Fire-and-forget — a failed prefetch just means React.lazy fetches it later.
 */
export function prefetchEditorChunk(): void {
  void loadEditorScreen().then(
    () => console.info('[perf] editor chunk ready'),
    () => undefined,
  )
}
