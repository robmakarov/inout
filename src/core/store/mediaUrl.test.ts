/**
 * The bytes decide the type, not the filename.
 *
 * PO on an iPhone, 2026-08-29: "mic dont work in iphone safari too … recorded
 * mic beatrate is shown on editing but no sound hearable". The waveform is
 * decoded from the raw bytes and was right; the element beside it was handed a
 * blob labelled `video/webm` holding MP4, because MediaRecorder on Safari has
 * no WebM encoder and the storage key's extension assumed it did.
 */
import { describe, expect, it } from 'vitest'
import { typedBlob } from './mediaUrl'

const bytes = new Uint8Array([1, 2, 3, 4])

describe('typedBlob', () => {
  it('re-types an MP4 that was stored under a .webm name', () => {
    const stored = new Blob([bytes], { type: 'video/webm' })
    const fixed = typedBlob(stored, 'audio/mp4')
    expect(fixed.type).toBe('audio/mp4')
    expect(fixed.size).toBe(stored.size)
  })

  it('leaves a blob alone when the recorder agreed with the name', () => {
    const stored = new Blob([bytes], { type: 'video/webm' })
    expect(typedBlob(stored, 'video/webm')).toBe(stored)
  })

  it('leaves takes recorded before the mime was kept exactly as they are', () => {
    const stored = new Blob([bytes], { type: 'video/webm' })
    expect(typedBlob(stored, undefined)).toBe(stored)
    expect(typedBlob(stored, '')).toBe(stored)
    // OPFS hands back this type for a name it does not recognise; it is not a
    // statement about the bytes, so it must not overwrite one.
    expect(typedBlob(stored, 'application/octet-stream')).toBe(stored)
  })

  it('carries the codec parameters through — an element uses them to decide', async () => {
    const stored = new Blob([bytes], { type: '' })
    const fixed = typedBlob(stored, 'video/mp4;codecs=avc1.42E01E')
    expect(fixed.type).toBe('video/mp4;codecs=avc1.42e01e')
    expect(new Uint8Array(await fixed.arrayBuffer())).toEqual(bytes)
  })
})
