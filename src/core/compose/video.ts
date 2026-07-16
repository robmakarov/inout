import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from 'mediabunny'
import type { ChannelKind } from '@core/types'

/**
 * Sequential frame cursor over one channel's video track. `sampleAt` must be
 * called with non-decreasing channel-local times; it holds (and owns) the
 * latest decoded sample with timestamp <= the requested time. Never seeks
 * randomly — decoding advances strictly forward.
 */
export class VideoChannelReader {
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null
  private current: VideoSample | null = null
  private pending: VideoSample | null = null
  private done = false

  constructor(
    readonly channelId: string,
    readonly kind: ChannelKind,
    private readonly input: Input,
    private readonly sink: VideoSampleSink,
    private readonly localEndSec: number,
  ) {}

  /** Returned sample is owned by the reader — do not close it. */
  async sampleAt(localSec: number): Promise<VideoSample | null> {
    // mediabunny yields the last sample at-or-before startTimestamp first.
    this.iter ??= this.sink.samples(Math.max(0, localSec), this.localEndSec)
    while (!this.done) {
      if (this.pending) {
        if (this.pending.timestamp > localSec) break
        this.current?.close()
        this.current = this.pending
        this.pending = null
      } else {
        const r = await this.iter.next()
        if (r.done) this.done = true
        else this.pending = r.value
      }
    }
    return this.current
  }

  dispose(): void {
    this.current?.close()
    this.current = null
    this.pending?.close()
    this.pending = null
    if (this.iter) {
      void this.iter.return(undefined).catch(() => undefined)
      this.iter = null
    }
    this.input.dispose()
  }
}

export async function openVideoChannel(
  blob: Blob,
  channelId: string,
  kind: ChannelKind,
  localEndSec: number,
): Promise<VideoChannelReader | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) {
      console.warn(`compose: channel ${channelId} has no decodable video track, skipping`)
      input.dispose()
      return null
    }
    return new VideoChannelReader(channelId, kind, input, new VideoSampleSink(track), localEndSec)
  } catch (err) {
    input.dispose()
    throw err
  }
}
