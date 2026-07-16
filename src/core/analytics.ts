import type { AnalyticsEvent } from './types'

type Props = Record<string, string | number | boolean>

interface AnalyticsSink {
  track(event: AnalyticsEvent, props?: Props): void
}

const consoleSink: AnalyticsSink = {
  track(event, props) {
    console.debug('[analytics]', event, props ?? {})
  },
}

const noopSink: AnalyticsSink = { track() {} }

let sink: AnalyticsSink = import.meta.env.DEV ? consoleSink : noopSink

export const analytics = {
  track(event: AnalyticsEvent, props?: Props): void {
    try {
      sink.track(event, props)
    } catch {
      // analytics must never break the product
    }
  },
  setSink(s: AnalyticsSink): void {
    sink = s
  },
}
