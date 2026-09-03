import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Recording } from '@core/types'
import { groupByRecording, readSelfManifest, selfManifestKey } from './selfManifest'

/**
 * H7 — A TAKE WHOSE MANIFEST IS GONE IS STILL A TAKE.
 *
 * The pending manifest has two homes (localStorage and H2b's IndexedDB) and H2
 * measured both of them genuinely missing after a `kill -9`. This is the third
 * copy: the file's own name. What has to hold is that the scan rebuilds the
 * take when there is nothing else left, and — the case that matters more —
 * that it NEVER adopts a file it cannot prove belongs to a take.
 */

const KEYS: string[] = []
const shapes = new Map<
  string,
  { media: 'video' | 'audio'; width?: number; height?: number; durationSec: number }
>()
let saved: Recording[] = []

vi.mock('@core/store', () => ({
  blobStore: {
    listKeys: () => Promise.resolve([...KEYS]),
    read: (key: string) =>
      Promise.resolve({ size: shapes.has(key) ? 4096 : 0, type: '', key } as unknown as Blob),
    remove: () => Promise.resolve(),
  },
  recordingsRepo: {
    get: () => Promise.resolve(null),
    save: (r: Recording) => {
      saved.push(r)
      return Promise.resolve()
    },
    list: () => Promise.resolve(saved),
  },
}))

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {
    constructor(public blob: { key: string }) {}
  },
  Input: class {
    private key: string
    constructor(opts: { source: { blob: { key: string } } }) {
      this.key = opts.source.blob.key
    }
    computeDuration() {
      return Promise.resolve(shapes.get(this.key)?.durationSec ?? 0)
    }
    getPrimaryVideoTrack() {
      const s = shapes.get(this.key)
      return Promise.resolve(
        s?.media === 'video' ? { displayWidth: s.width, displayHeight: s.height } : null,
      )
    }
    getPrimaryAudioTrack() {
      return Promise.resolve(shapes.get(this.key)?.media === 'audio' ? {} : null)
    }
    dispose() {}
  },
}))

const { salvagePendingRecording } = await import('./recovery')

const store = new Map<string, string>()
beforeEach(() => {
  KEYS.length = 0
  shapes.clear()
  saved = []
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  // The durable manifest is the other half of the "no manifest" premise: with
  // no IndexedDB in this environment, reading it fails and returns null, which
  // is exactly the state a lost manifest leaves behind.
  vi.stubGlobal('indexedDB', undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function put(
  key: string,
  media: 'video' | 'audio',
  durationSec: number,
  width?: number,
  height?: number,
): void {
  KEYS.push(key)
  shapes.set(key, { media, durationSec, width, height })
}

describe('the name a media file carries', () => {
  it('round-trips take, role and channel', () => {
    const key = selfManifestKey('rec_gpsoujs2sydf', 'system-audio', 'ch_abcdef123456', 'mp4')
    expect(key).toBe('rec_gpsoujs2sydf_system-audio_ch_abcdef123456.mp4')
    expect(readSelfManifest(key)).toEqual({
      recordingId: 'rec_gpsoujs2sydf',
      kind: 'system-audio',
      channelId: 'ch_abcdef123456',
      ext: 'mp4',
    })
  })

  it('reads a take id that has underscores and dashes of its own', () => {
    const key = selfManifestKey('exp-oracle-fidcomp_1788423743997', 'screen', 'ch_aaaaaaaaaaaa', 'mp4')
    const self = readSelfManifest(key)
    expect(self?.recordingId).toBe('exp-oracle-fidcomp_1788423743997')
    expect(self?.kind).toBe('screen')
  })

  it('REFUSES everything it cannot prove is a channel of a take', () => {
    for (const stranger of [
      'rec_abc_ch_abcdef123456.mp4', // pre-H7: no role in the name
      'rec_abc_composite.mp4', // the composite, never salvaged
      'rec_abc_screen_ch_SHORT.mp4', // not the channel id shape
      'rec_abc_screen_ch_abcdef12345A.mp4', // uppercase is outside the id alphabet
      'rec_abc_screen_ch_abcdef1234567.mp4', // 13 characters, not 12
      'rec_abc_speaker_ch_abcdef123456.mp4', // not one of the four kinds
      'screen_ch_abcdef123456.mp4', // no take id at all
      '__chunk_deadbeef.mp4',
      'holiday-video.mp4',
    ]) {
      expect(readSelfManifest(stranger), stranger).toBeNull()
    }
  })

  it('groups the files of one take and leaves strangers out', () => {
    const takes = groupByRecording([
      'rec_one_screen_ch_aaaaaaaaaaaa.mp4',
      'rec_one_mic_ch_bbbbbbbbbbbb.webm',
      'rec_two_screen_ch_cccccccccccc.mp4',
      'holiday-video.mp4',
    ])
    expect([...takes.keys()]).toEqual(['rec_one', 'rec_two'])
    expect(takes.get('rec_one')!.map((p) => p.kind)).toEqual(['screen', 'mic'])
  })
})

describe('salvage with no manifest at all', () => {
  it('rebuilds every channel of the take from the files alone', async () => {
    put('rec_lost_screen_ch_aaaaaaaaaaaa.mp4', 'video', 62.5, 3024, 1964)
    put('rec_lost_camera_ch_bbbbbbbbbbbb.mp4', 'video', 62.5, 1280, 720)
    put('rec_lost_mic_ch_cccccccccccc.webm', 'audio', 62.4)

    const rec = await salvagePendingRecording()
    expect(rec).not.toBeNull()
    expect(rec!.id).toBe('rec_lost')
    expect(rec!.channels.map((c) => c.kind).sort()).toEqual(['camera', 'mic', 'screen'])
    expect(rec!.durationMs).toBe(62500)
    const screen = rec!.channels.find((c) => c.kind === 'screen')!
    expect(screen.media).toBe('video')
    expect(screen.width).toBe(3024)
    expect(screen.height).toBe(1964)
    expect(rec!.channels.find((c) => c.kind === 'mic')!.media).toBe('audio')
    expect(saved).toHaveLength(1)
  })

  it('never adopts a stranger, and finds nothing rather than something wrong', async () => {
    put('holiday-video.mp4', 'video', 30, 1920, 1080)
    put('rec_old_ch_aaaaaaaaaaaa.mp4', 'video', 30, 1920, 1080) // written before H7
    expect(await salvagePendingRecording()).toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('leaves a take the user can already see alone', async () => {
    saved = [{ id: 'rec_known', createdAt: 1, durationMs: 1000, channels: [] } as Recording]
    put('rec_known_screen_ch_aaaaaaaaaaaa.mp4', 'video', 30, 1920, 1080)
    expect(await salvagePendingRecording()).toBeNull()
    expect(saved).toHaveLength(1)
  })

  it('costs only itself when one channel is unreadable', async () => {
    put('rec_lost_screen_ch_aaaaaaaaaaaa.mp4', 'video', 62.5, 3024, 1964)
    KEYS.push('rec_lost_mic_ch_cccccccccccc.webm') // listed, but no bytes behind it
    const rec = await salvagePendingRecording()
    expect(rec!.channels.map((c) => c.kind)).toEqual(['screen'])
  })
})
