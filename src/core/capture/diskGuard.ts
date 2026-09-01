/**
 * HOW MUCH ROOM IS LEFT, AND HOW LONG THAT IS — task B5, built 2026-08-30 from
 * Robert: "we must prevent junk from saving, it will fuck up users disks".
 *
 * Nothing in this product has ever read `navigator.storage.estimate()`, before
 * a take or during one. The 30-minute cap that used to bound the damage is
 * gone, and the takes have got very much bigger: one of his at 3024x1964@60
 * wrote 1,138 MB before it froze. A recorder that can fill a disk and only
 * finds out when a write fails is a recorder that loses the take AND the space.
 *
 * WHAT MATTERS IS THE RATE, NOT THE TOTAL. "12 GB free" means nothing without
 * knowing that this take is writing 500 MB a minute; "about 9 minutes left"
 * is the same fact in the form a person can act on. So the guard measures what
 * this take is actually writing and reports time, not bytes.
 *
 * AND IT STOPS RATHER THAN LETS THE WRITE FAIL. A take stopped with room to
 * spare is a finished recording; a take that hits the quota mid-write loses
 * whatever the writer had not acknowledged, and the user gets neither the
 * recording nor the disk space back. That is not a quality trade, it is the
 * difference between having the take and not.
 *
 * Pure so both decisions are testable without a browser or a full disk.
 */

/** Warn here: enough left to finish a thought, not enough to ignore. */
export const WARN_SECONDS_LEFT = 120
/** Stop here. Below this the next flush is the one that fails. */
export const STOP_SECONDS_LEFT = 20
/** Never act on a rate measured over less than this — the first seconds of a
 *  take are the encoder waking up, not its steady write rate. */
export const MIN_SAMPLE_MS = 8_000

/**
 * B5's OTHER HALF: THE ANSWER BEFORE THE TAKE, NOT DURING IT.
 *
 * The guard above is measured — it needs the take's own byte rate and cannot
 * say anything until 8 s of it exist. That is the right instrument once
 * recording, and the wrong one for the question a person asks BEFORE pressing
 * record: is there room for what I am about to do. Two minutes' notice is
 * enough to finish a thought and useless for planning a take.
 *
 * So the pre-flight speaks in the length of take the machine can hold, and it
 * stays quiet unless that length is short enough to change what someone
 * records. Robert's own takes run 15-50 minutes; under twenty is news.
 */
export const PREFLIGHT_QUIET_MINUTES = 20

export interface PreflightSample {
  /** navigator.storage.estimate() */
  usageBytes: number
  quotaBytes: number
  /** What a second of THIS take is expected to cost — measured from this
   *  machine's own recent takes where there are any, planned from the
   *  configured bitrates where there are not. */
  bytesPerSec: number
}

export interface PreflightVerdict {
  level: 'ok' | 'low'
  minutesLeft: number
  mbPerMin: number
  freeBytes: number
  /** Empty at 'ok' — a healthy machine shows nothing new. */
  message: string
}

export function preflightVerdict(s: PreflightSample): PreflightVerdict | null {
  if (!(s.quotaBytes > 0) || !(s.bytesPerSec > 0)) return null
  const freeBytes = Math.max(0, s.quotaBytes - s.usageBytes)
  const minutesLeft = freeBytes / s.bytesPerSec / 60
  const mbPerMin = mbPerMinute(s.bytesPerSec)
  if (minutesLeft >= PREFLIGHT_QUIET_MINUTES) {
    return { level: 'ok', minutesLeft, mbPerMin, freeBytes, message: '' }
  }
  const mins = Math.floor(minutesLeft)
  return {
    level: 'low',
    minutesLeft,
    mbPerMin,
    freeBytes,
    message:
      (mins >= 1
        ? `Room for about ${mins} more minute${mins === 1 ? '' : 's'} of recording at this quality`
        : `Under a minute of recording room left at this quality`) +
      ` — this take would write about ${mbPerMin} MB a minute. Free some space, or record less at once.`,
  }
}

/**
 * MB A MINUTE, WITH A DECIMAL WHERE ONE IS NEEDED.
 *
 * B5's gate is that the rate this UI quotes matches the take's own measured
 * byte rate within 10 %, and rounding to a whole number cannot do that at the
 * bottom of the range: a take writing 3.4 reads "3", which is 12 % low. Above
 * 10 MB a minute the decimal is noise (Robert's max takes write ~140), so it is
 * spent only where it buys accuracy.
 */
export function mbPerMinute(bytesPerSec: number): number {
  const perMin = (bytesPerSec * 60) / 1048576
  return perMin >= 10 ? Math.round(perMin) : Math.round(perMin * 10) / 10
}

export interface DiskSample {
  /** navigator.storage.estimate() */
  usageBytes: number
  quotaBytes: number
  /** Bytes this take has written so far, and over how long. */
  takeBytes: number
  takeMs: number
}

export interface DiskVerdict {
  level: 'ok' | 'warn' | 'stop'
  secondsLeft: number
  bytesPerSec: number
  message: string
}

export function diskVerdict(s: DiskSample): DiskVerdict | null {
  if (!(s.quotaBytes > 0) || s.takeMs < MIN_SAMPLE_MS || !(s.takeBytes > 0)) return null
  const free = Math.max(0, s.quotaBytes - s.usageBytes)
  const bytesPerSec = s.takeBytes / (s.takeMs / 1000)
  if (!(bytesPerSec > 0)) return null
  const secondsLeft = free / bytesPerSec
  const mbPerMin = mbPerMinute(bytesPerSec)
  const mins = Math.max(0, Math.round(secondsLeft / 60))
  if (secondsLeft <= STOP_SECONDS_LEFT) {
    return {
      level: 'stop',
      secondsLeft,
      bytesPerSec,
      message:
        `Stopped — this computer is out of room. The recording is saved. ` +
        `It was writing about ${mbPerMin} MB a minute.`,
    }
  }
  if (secondsLeft <= WARN_SECONDS_LEFT) {
    return {
      level: 'warn',
      secondsLeft,
      bytesPerSec,
      message:
        `About ${mins} minute${mins === 1 ? '' : 's'} of room left at this quality — ` +
        `this take is writing ${mbPerMin} MB a minute. It will stop itself before the disk fills.`,
    }
  }
  return { level: 'ok', secondsLeft, bytesPerSec, message: '' }
}
