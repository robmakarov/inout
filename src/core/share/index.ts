import type { ExportResult, ShareTarget } from '../types'
import { getCloudProvider } from '../cloud'

export function saveToFile(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = result.fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function listShareTargets(): ShareTarget[] {
  const cloudAvailable = getCloudProvider() !== null
  return [
    { id: 'file', label: 'Save file', available: true },
    {
      id: 'cloud',
      label: 'Cloud link',
      available: cloudAvailable,
      reason: cloudAvailable ? undefined : 'Cloud not configured',
    },
  ]
}
