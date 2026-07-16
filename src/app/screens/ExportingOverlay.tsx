import { useAppStore } from '@app/state/store'
import { ProgressRing } from '@app/components/ProgressRing'

const PHASE_LABEL = {
  preparing: 'Preparing…',
  rendering: 'Rendering…',
  finalizing: 'Finalizing…',
} as const

export function ExportingOverlay() {
  const progress = useAppStore((s) => s.exportProgress)
  const abort = useAppStore((s) => s.exportAbort)
  const ratio = progress?.ratio ?? 0
  return (
    <div className="exporting">
      <div className="exporting__card">
        <ProgressRing ratio={ratio} />
        <div className="exporting__pct">{Math.round(ratio * 100)}%</div>
        <div className="exporting__phase">{PHASE_LABEL[progress?.phase ?? 'preparing']}</div>
        <button className="btn btn--ghost" onClick={() => abort?.abort()}>
          Cancel
        </button>
      </div>
    </div>
  )
}
