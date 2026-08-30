import { create } from 'zustand'
import type {
  CaptureSession,
  EditState,
  ExportProgress,
  ExportResult,
  Recording,
} from '@core/types'

/**
 * THREE SCREENS, and 'exporting' is not a fourth — it is the editor with the
 * render running in the slider's slot. UI1, Robert: "rendering loader show on
 * same screen where download button is, so we have only main screen, recording
 * screen, and editing screen". The old 'share' mode was a whole screen whose
 * job is now one strip above the slider (ExportSavedStrip).
 */
export type AppMode = 'capture' | 'editor' | 'exporting'

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
  exportResult: ExportResult | null
  exportProgress: ExportProgress | null
  exportAbort: AbortController | null
  openIntent: OpenIntent | null
  toasts: Toast[]
  setMode(mode: AppMode): void
  setSession(session: CaptureSession | null): void
  setRecording(recording: Recording | null): void
  setEditState(editState: EditState | null): void
  setExportResult(result: ExportResult | null): void
  setExportProgress(p: ExportProgress | null): void
  setExportAbort(a: AbortController | null): void
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
  exportResult: null,
  exportProgress: null,
  exportAbort: null,
  openIntent: null,
  toasts: [],
  setMode: (mode) => set({ mode }),
  setSession: (session) => set({ session }),
  setRecording: (recording) => set({ recording }),
  setEditState: (editState) => set({ editState }),
  setExportResult: (exportResult) => set({ exportResult }),
  setExportProgress: (exportProgress) => set({ exportProgress }),
  setExportAbort: (exportAbort) => set({ exportAbort }),
  setOpenIntent: (openIntent) => set({ openIntent }),
  toast: (message, variant = 'info') => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, message, variant }] })
    setTimeout(() => get().dismissToast(id), TOAST_MS)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  resetToCapture: () =>
    set({
      mode: 'capture',
      session: null,
      recording: null,
      editState: null,
      exportResult: null,
      exportProgress: null,
      exportAbort: null,
      openIntent: null,
    }),
}))
