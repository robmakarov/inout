/**
 * EXPERIMENTAL — "did the UI thread keep running?", one instrument, two rigs.
 *
 * This lived inside the O5 export rig and was rediscovered from scratch by X9,
 * which is the reason it is a file now: both rigs ask exactly the same question
 * about two different pieces of work moving into a worker, and the WRONG answer
 * to it is easy to reach twice.
 *
 * THE LONG-TASK FORM OF THE GATE CANNOT FAIL, SO IT CANNOT PASS EITHER. Both
 * the render and the For-AI build await a decoded sample on every frame, and an
 * await ends the task — so neither ever blocks for 50 ms at a stretch, and the
 * `longtask` counter reads ZERO whichever thread the work is on. It reads zero
 * for the in-thread lane, which is the lane a user experiences as seconds of
 * jank. Measured 2026-08-24 (O5) and again 2026-08-26 (X9).
 *
 * SCHEDULING LATENESS IS THE NUMBER A USER WOULD FEEL: a ticker asking for
 * 60 Hz, and how much of it it does not get. Reported as total lateness AND as
 * the worst single stall, so a greedy-but-even render and a hitching one are
 * distinguishable. The long-task counter is kept alongside it as a DIAGNOSTIC,
 * never as a gate, because it is free and because it is the number that lies.
 */

export interface SchedulingDelay {
  ticks: number
  totalLateMs: number
  maxLateMs: number
  p95LateMs: number
}

export class SchedulingDelayWatch {
  private readonly late: number[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private last = 0
  private readonly periodMs = 16

  start(): void {
    this.last = performance.now()
    this.timer = setInterval(() => {
      const now = performance.now()
      this.late.push(Math.max(0, now - this.last - this.periodMs))
      this.last = now
    }, this.periodMs)
  }

  stop(): SchedulingDelay {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    const sorted = [...this.late].sort((a, b) => a - b)
    const p95 = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]!
      : 0
    return {
      ticks: this.late.length,
      totalLateMs: Math.round(this.late.reduce((a, b) => a + b, 0)),
      maxLateMs: Math.round(Math.max(0, ...this.late)),
      p95LateMs: Math.round(p95 * 10) / 10,
    }
  }
}

export interface LongTaskSummary {
  supported: boolean
  count: number
  totalMs: number
  maxMs: number
}

/** The browser's own long-task verdict. Diagnostic only — see the file header. */
export class LongTaskWatch {
  private readonly entries: { duration: number; startTime: number }[] = []
  private observer: PerformanceObserver | null = null

  start(): void {
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.entries.push({ duration: e.duration, startTime: e.startTime })
        }
      })
      this.observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // Not every engine ships the Long Tasks API; reported as unsupported,
      // never faked into a zero that would read as good news.
      this.observer = null
    }
  }

  stop(): LongTaskSummary {
    this.observer?.disconnect()
    const supported = this.observer !== null
    this.observer = null
    return {
      supported,
      count: this.entries.length,
      totalMs: Math.round(this.entries.reduce((a, e) => a + e.duration, 0)),
      maxMs: Math.round(this.entries.reduce((a, e) => Math.max(a, e.duration), 0)),
    }
  }
}
