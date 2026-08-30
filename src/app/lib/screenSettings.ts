/**
 * THE FIX AS A BUTTON — because the answer to "what will users do if this
 * happens?" cannot be a terminal command (Robert, 2026-08-30: "i will not do
 * anything in console").
 *
 * When macOS stops handing the screen to the browser, nothing a page can run
 * will change it: the grant lives in TCC, one layer below anything JavaScript
 * reaches. So the most a web app can do is take the user directly to the
 * switch — and macOS does expose exactly that as a URL. Navigating to this
 * scheme opens System Settings on Privacy & Security → Screen & System Audio
 * Recording, the pane with the browser's own toggle on it. The browser asks
 * "Open System Settings?" first, which is the whole security story: the user
 * confirms, and lands one click from the fix instead of six menus deep.
 *
 * macOS only. Windows has no such grant (its screen capture is not gated this
 * way) and Linux/Wayland REFUSES rather than hangs, which arrives as a
 * rejection and never becomes a stall — so on anything else the button would
 * point at a setting that does not exist. Offer it where it is true.
 */
import type { OSName } from '@core/platform'

/** System Settings → Privacy & Security → Screen & System Audio Recording. */
export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export function canOpenScreenRecordingSettings(os: OSName): boolean {
  return os === 'macos'
}
