import { shell, systemPreferences } from 'electron';
import type { CameraAccess } from '../shared/types.js';

const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/**
 * On macOS a camera the operating system has not released behaves worse than one that fails:
 * `getUserMedia` resolves, the track reports `live` with a fully negotiated resolution, and not a
 * single frame ever arrives. Without asking the OS first there is no way to tell that apart from a
 * microscope with its light switched off, so the window ends up blaming the cable.
 *
 * Windows has no equivalent API; a blocked camera there rejects `getUserMedia` outright, which the
 * renderer already explains, so there is nothing to ask for up front.
 */
export function cameraAccessNow(): CameraAccess {
  if (!isMac) return 'unknown';
  switch (systemPreferences.getMediaAccessStatus('camera')) {
    case 'granted':
      return 'granted';
    case 'denied':
    case 'restricted':
      return 'denied';
    default:
      return 'undecided';
  }
}

/**
 * Asks macOS for the camera, once. Resolves to what the OS decided.
 *
 * Staying `undecided` after asking means macOS declined to even put the question to the user. That
 * happens when the running binary has no stable code identity — an unsigned development build, for
 * instance — and it is worth telling apart from a plain refusal, because the remedy is different.
 */
export async function requestCameraAccess(): Promise<CameraAccess> {
  if (!isMac) return 'unknown';
  const current = cameraAccessNow();
  if (current !== 'undecided') return current;
  const granted = await systemPreferences.askForMediaAccess('camera').catch(() => false);
  return granted ? 'granted' : cameraAccessNow();
}

/** Opens the pane where the human can actually grant the camera. */
export function openCameraSettings(): void {
  if (isMac) {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera');
  } else if (isWindows) {
    void shell.openExternal('ms-settings:privacy-webcam');
  }
}
