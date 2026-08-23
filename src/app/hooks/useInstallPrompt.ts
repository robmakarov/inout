import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISSED_KEY = 'inout.install.dismissed'

/**
 * Install affordance (task P2).
 *
 * Chrome fires `beforeinstallprompt` only when the app actually qualifies, so
 * holding onto that event is what lets us offer the install at a sensible
 * moment instead of guessing. Dismissal is remembered — being asked twice to
 * install something is how a tool starts feeling pushy.
 */
export function useInstallPrompt(): { canInstall: boolean; install: () => void; dismiss: () => void } {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setDeferred(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  return {
    canInstall: !!deferred && !hidden,
    install: () => {
      const e = deferred
      if (!e) return
      setDeferred(null)
      void e.prompt().then(
        () => undefined,
        () => undefined,
      )
    },
    dismiss: () => {
      setHidden(true)
      try {
        localStorage.setItem(DISMISSED_KEY, '1')
      } catch {
        /* best effort */
      }
    },
  }
}
