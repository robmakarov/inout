import type { ReactNode } from 'react'

export type IconName =
  | 'display'
  | 'camera'
  | 'mic'
  | 'waves'
  | 'eye'
  | 'eye-off'
  | 'download'
  | 'link'
  | 'copy'
  | 'check'
  | 'play'
  | 'pause'
  | 'chevron-left'
  | 'x'
  | 'google'

const PATHS: Record<Exclude<IconName, 'google'>, ReactNode> = {
  display: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M12 16.5v3M8.5 19.5h7" />
    </>
  ),
  camera: (
    <>
      <rect x="2.5" y="6.5" width="12.5" height="11" rx="2.5" />
      <path d="M15 10.5l6-3.5v10l-6-3.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9.25" y="3" width="5.5" height="11" rx="2.75" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </>
  ),
  waves: (
    <>
      <path d="M4 9.5v5h3l4.5 4v-13l-4.5 4H4z" />
      <path d="M15 9.5a4 4 0 0 1 0 5M17.8 7a7.5 7.5 0 0 1 0 10" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.75 12 5.75 21.5 12 21.5 12 18 18.25 12 18.25 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M4.5 8.2C3.2 9.9 2.5 12 2.5 12s3.5 6.25 9.5 6.25c1.5 0 2.87-.39 4.07-.98M9.9 6.06A8.9 8.9 0 0 1 12 5.75c6 0 9.5 6.25 9.5 6.25a16.7 16.7 0 0 1-2.6 3.34" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M4 3.5l16 17" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a4 4 0 0 0 5.66 0l3.14-3.14a4 4 0 1 0-5.66-5.66l-1.6 1.6" />
      <path d="M13.8 10.2a4 4 0 0 0-5.66 0L5 13.34A4 4 0 1 0 10.66 19l1.6-1.6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4.5A2.5 2.5 0 0 1 2 12.5v-8A2.5 2.5 0 0 1 4.5 2h8A2.5 2.5 0 0 1 15 4.5V5" />
    </>
  ),
  check: <path d="M4.5 12.5l5 5.5L19.5 6" />,
  play: <path d="M8 5.4v13.2L19 12 8 5.4z" fill="currentColor" strokeWidth="1" />,
  pause: (
    <>
      <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" strokeWidth="1" />
      <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" strokeWidth="1" />
    </>
  ),
  'chevron-left': <path d="M14.5 5.5L8 12l6.5 6.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
}

export function Icon({
  name,
  size = 18,
  slash = false,
}: {
  name: IconName
  size?: number
  slash?: boolean
}) {
  if (name === 'google') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24z"
        />
        <path
          fill="#FBBC05"
          d="M5.29 14.28A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.56.38-2.28V6.61H1.28a12 12 0 0 0 0 10.78l4.01-3.11z"
        />
        <path
          fill="#EA4335"
          d="M12 4.77c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77z"
        />
      </svg>
    )
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
      {slash && <path d="M4 4l16 16" />}
    </svg>
  )
}
