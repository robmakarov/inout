import { useAppStore } from '@app/state/store'

/**
 * The one door between the UI and core's export-job manager.
 *
 * Loaded lazily on purpose: the manager sits on the whole compose graph
 * (mediabunny and every export path), and the app shell must stay the ~221 KB
 * that stands between the user and the record button (O7). The dock itself
 * only ever READS the store's `exportJobs` mirror, which this module wires up
 * the first time anything touches the manager — an export press, a cancel,
 * or the boot resume.
 */
type JobsModule = typeof import('@core/compose')

let loaded: Promise<JobsModule> | null = null
let wired = false

export function loadExportJobs(): Promise<JobsModule> {
  loaded ??= import('@core/compose')
  return loaded.then((m) => {
    if (!wired) {
      wired = true
      m.subscribeExportJobs((rows) => useAppStore.getState().setExportJobs(rows))
    }
    return m
  })
}
