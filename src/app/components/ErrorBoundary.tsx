import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { analytics } from '@core/analytics'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('app crash', error, info.componentStack)
    analytics.track('app_error', { message: error.message })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <div className="crash__card">
          <div className="crash__title">Something went wrong</div>
          <div className="crash__message">{this.state.error.message}</div>
          <button className="btn btn--primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
