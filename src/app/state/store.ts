import { create } from 'zustand'
import type { CaptureSession, EditState, ExportJobRecord, Recording } from '@core/types'

/**
 * THREE SCREENS, and the export is not a mode AT ALL any more (2026-08-30,
 * Robert: rendering "happening further if i switch app screen, independetly").
 * An export is a background JOB — a row in the dock at the bottom of every
 * screen (ExportDock) — so nothing locks, nothing navigates, and `exportJobs`
 * here is just the dock's mirror of core/compose/exportJobs.
 */
export type AppMode = 'capture' | 'editor'

/**
 * UI1 — WHY THE EDITOR WAS OPENED. A take reached through the takes list's
 * Watch button should be PLAYING when it appears; one reached through Edit, or
 * through the boot recovery, should not. Consumed once by the editor and
 * cleared, so a later re-render cannot restart playback.
 */
export type OpenIntent = 'watch' | 'edit'

export type ToastVariant = 'info' | 'error'

export interface Toast {
  id: number
  message: string
  variant: ToastVariant
}

interface AppStore {
  mode: AppMode
  session: CaptureSession | null
  recording: Recording | null
  editState: EditState | null
  /** The dock's rows — mirrored from core by app/lib/exportJobs. */
  exportJobs: ExportJobRecord[]
  openIntent: OpenIntent | null
  toasts: Toast[]
  setMode(mode: AppMode): void
  setSession(session: CaptureSession | null): void
  setRecording(recording: Recording | null): void
  setEditState(editState: EditState | null): void
  setExportJobs(jobs: ExportJobRecord[]): void
  setOpenIntent(i: OpenIntent | null): void
  toast(message: string, variant?: ToastVariant): void
  dismissToast(id: number): void
  resetToCapture(): void
}

let toastSeq = 0
const TOAST_MS = 4000

export const useAppStore = create<AppStore>()((set, get) => ({
  mode: 'capture',
  session: null,
  recording: null,
  editState: null,
  exportJobs: [],
  openIntent: null,
  toasts: [],
  setMode: (mode) => set({ mode }),
  setSession: (session) => set({ session }),
  setRecording: (recording) => set({ recording }),
  setEditState: (editState) => set({ editState }),
  setExportJobs: (exportJobs) => set({ exportJobs }),
  setOpenIntent: (openIntent) => set({ openIntent }),
  toast: (message, variant = 'info') => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, message, variant }] })
    setTimeout(() => get().dismissToast(id), TOAST_MS)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  // Deliberately does NOT touch exportJobs: jobs are independent of the
  // screen you are on — that is their whole point.
  resetToCapture: () =>
    set({
      mode: 'capture',
      session: null,
      recording: null,
      editState: null,
      openIntent: null,
    }),
}))
