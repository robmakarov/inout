import { describe, expect, it } from 'vitest'
import { groupOrphansByRecording, type OrphanBlob } from './salvage'

describe('orphan grouping', () => {
  it('groups blob keys by recording id using the production key scheme', () => {
    const orphans: OrphanBlob[] = [
      { key: 'rec_abc123_ch_v1.webm', sizeBytes: 100 },
      { key: 'rec_abc123_ch_a1.webm', sizeBytes: 50 },
      { key: 'rec_zzz999_ch_v1.webm', sizeBytes: 10 },
      { key: 'stray-file.bin', sizeBytes: 1 },
    ]
    const groups = groupOrphansByRecording(orphans)
    expect(groups.get('rec_abc123')?.map((o) => o.key)).toEqual([
      'rec_abc123_ch_v1.webm',
      'rec_abc123_ch_a1.webm',
    ])
    expect(groups.get('rec_zzz999')).toHaveLength(1)
    expect(groups.get('unknown')).toHaveLength(1)
  })
})
