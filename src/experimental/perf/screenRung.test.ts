import { describe, expect, it } from 'vitest'
import { proposeScreenRung, type RungMeasurement } from './screenRung'

/**
 * The two rows are the MEASURED ones (`npm run exp -- x12`, 2026-08-26, 12 s
 * takes), not invented numbers — the rule exists because of what they say.
 */
const SCREEN: RungMeasurement[] = [
  { requestedMbps: 8, channelSavingPct: null, exportDeltaPct: null, renderPsnrDb: null },
  { requestedMbps: 6, channelSavingPct: -6.8, exportDeltaPct: 15.7, renderPsnrDb: 45.5 },
  { requestedMbps: 4, channelSavingPct: -15.1, exportDeltaPct: 25.8, renderPsnrDb: 44.6 },
  { requestedMbps: 2.5, channelSavingPct: -32.5, exportDeltaPct: 31.5, renderPsnrDb: 43.7 },
]

const MOTION: RungMeasurement[] = [
  { requestedMbps: 8, channelSavingPct: null, exportDeltaPct: null, renderPsnrDb: null },
  { requestedMbps: 6, channelSavingPct: -20.3, exportDeltaPct: -9.3, renderPsnrDb: 49.1 },
  { requestedMbps: 4, channelSavingPct: -44.2, exportDeltaPct: -16.5, renderPsnrDb: 49 },
  { requestedMbps: 2.5, channelSavingPct: -63.4, exportDeltaPct: -23.3, renderPsnrDb: 48.5 },
]

describe('proposeScreenRung', () => {
  it('refuses every rung on screen content, because the delivered file GREW', () => {
    // This is the case the first version of the rule got wrong: it saw PSNR
    // 43.7 dB at 2.5 Mbps and recommended it, while that rung made the file a
    // user downloads 31.5 % bigger.
    const p = proposeScreenRung(SCREEN)
    expect(p.rungMbps).toBeNull()
    expect(p.reason).toContain('bigger')
    expect(p.reason).toContain('31.5%')
  })

  it('takes the cheapest rung on motion content, where the file shrinks too', () => {
    const p = proposeScreenRung(MOTION)
    expect(p.rungMbps).toBe(2.5)
  })

  it('refuses a rung that keeps the picture but barely saves anything', () => {
    const p = proposeScreenRung([
      { requestedMbps: 8, channelSavingPct: null, exportDeltaPct: null, renderPsnrDb: null },
      { requestedMbps: 6, channelSavingPct: -2, exportDeltaPct: -1, renderPsnrDb: 55 },
    ])
    expect(p.rungMbps).toBeNull()
    expect(p.reason).toContain('no cheaper rung')
  })

  it('refuses a rung that saves and shrinks but loses the picture', () => {
    const p = proposeScreenRung([
      { requestedMbps: 8, channelSavingPct: null, exportDeltaPct: null, renderPsnrDb: null },
      { requestedMbps: 2.5, channelSavingPct: -60, exportDeltaPct: -30, renderPsnrDb: 31 },
    ])
    expect(p.rungMbps).toBeNull()
  })
})
