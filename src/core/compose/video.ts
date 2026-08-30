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

  /**
   * A DECODE FAILURE MUST NOT COST THE WHOLE EXPORT — 2026-08-30. Robert lost
   * four-minute renders repeatedly to "decoding error", with no other text and
   * nothing salvaged: "decoding error 1080 again, that all text i see".
   *
   * A raw channel written under load can have a patch the decoder will not
   * read — his takes have been dropping frames and freezing all session, and a
   * file that ends badly is exactly what this product now produces when a
   * machine is overrun. Abandoning the render there throws away every frame
   * already encoded, which is the worst possible response to a damaged second
   * of source.
   *
   * So a failed decode ENDS THIS READER instead of throwing: the last good
   * frame is held, the render carries on to the end, and the failure is
   * recorded so the export can say what happened rather than dying silently.
   * A visible freeze in one channel beats losing a four-minute export.
   */
  /** Returned sample is owned by the reader — do not close it. */
  async sampleAt(localSec: number): Promise<VideoSample | null> {
    // mediabunny yields the last sample at-or-before startTimestamp first.
    this.iter ??= this.sink.samples(Math.max(0, localSec), this.localEndSec)
    try {
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
    } catch (err) {
      this.done = true
      this.failure = {
        atSec: localSec,
        message: err instanceof Error ? err.message : String(err),
      }
      console.error(
        `[compose] ${this.kind} channel could not be decoded past ${localSec.toFixed(2)}s — ` +
          `holding the last good frame and finishing the export (${this.failure.message})`,
      )
    }
    return this.current
  }

  /** Set once a decode fails. The export reports it; it never throws. */
  failure: { atSec: number; message: string } | null = null

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
    return new VideoChannelReader(
      channelId,
      kind,
      input,
      // `optimizeForLatency` asks the decoder to hold as few packets as it can
      // before emitting a frame. It is a LATENCY hint by name and a MEMORY one
      // in effect, and memory is what this render runs out of: a decoded
      // 3024x1964 frame is GPU-backed, and a decoder buffering a reorder window
      // of them holds hundreds of megabytes in the GPU process for the whole
      // render. Robert, 2026-08-30, watching a 1080p export of such a take:
      // "before decoding error all computer lags as shit and seems like all
      // chrome window reloads, because even chrome header dissapears for second
      // and all screen skeleton" — the header vanishing is the GPU PROCESS
      // CRASHING, which kills every decoder with it. The "decoding error" that
      // follows is the symptom, not the cause.
      // Nothing is given up: this render never needs frames out of order, it
      // walks the timeline strictly forwards.
      new VideoSampleSink(track, { optimizeForLatency: true }),
      localEndSec,
    )
  } catch (err) {
    input.dispose()
    throw err
  }
}
