import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const systemPreferences = {
  getMediaAccessStatus: vi.fn<(kind: string) => string>(),
  askForMediaAccess: vi.fn<(kind: string) => Promise<boolean>>(),
};
const shell = { openExternal: vi.fn<(url: string) => Promise<void>>() };

vi.mock('electron', () => ({ systemPreferences, shell }));

const realPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

/** The module decides what it is on when it loads, so each platform needs a fresh copy. */
async function load(platform: string) {
  setPlatform(platform);
  vi.resetModules();
  return import('../src/main/permissions.js');
}

beforeEach(() => {
  systemPreferences.getMediaAccessStatus.mockReset();
  systemPreferences.askForMediaAccess.mockReset();
  shell.openExternal.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

it('asks macOS once and reports what it decided', async () => {
  const { requestCameraAccess } = await load('darwin');
  systemPreferences.getMediaAccessStatus.mockReturnValue('not-determined');
  systemPreferences.askForMediaAccess.mockResolvedValue(true);
  systemPreferences.getMediaAccessStatus.mockReturnValueOnce('not-determined').mockReturnValue('granted');

  await expect(requestCameraAccess()).resolves.toBe('granted');
  expect(systemPreferences.askForMediaAccess).toHaveBeenCalledWith('camera');
});

it('does not ask again once macOS has already answered', async () => {
  const { requestCameraAccess } = await load('darwin');
  systemPreferences.getMediaAccessStatus.mockReturnValue('granted');

  await expect(requestCameraAccess()).resolves.toBe('granted');
  expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
});

it('treats a restricted camera as denied', async () => {
  const { cameraAccessNow } = await load('darwin');
  systemPreferences.getMediaAccessStatus.mockReturnValue('restricted');
  expect(cameraAccessNow()).toBe('denied');
});

it('keeps a refusal to prompt separate from a refusal', async () => {
  // macOS leaves the status untouched when it declines to put the question to the user at all,
  // which is what a build with no stable code identity gets. That needs its own explanation.
  const { requestCameraAccess } = await load('darwin');
  systemPreferences.getMediaAccessStatus.mockReturnValue('not-determined');
  systemPreferences.askForMediaAccess.mockResolvedValue(false);

  await expect(requestCameraAccess()).resolves.toBe('undecided');
});

it('reports a plain denial when the user says no', async () => {
  const { requestCameraAccess } = await load('darwin');
  systemPreferences.askForMediaAccess.mockResolvedValue(false);
  systemPreferences.getMediaAccessStatus.mockReturnValueOnce('not-determined').mockReturnValue('denied');

  await expect(requestCameraAccess()).resolves.toBe('denied');
});

it('survives a throwing permission dialog', async () => {
  const { requestCameraAccess } = await load('darwin');
  systemPreferences.getMediaAccessStatus.mockReturnValue('not-determined');
  systemPreferences.askForMediaAccess.mockRejectedValue(new Error('no window server'));

  await expect(requestCameraAccess()).resolves.toBe('undecided');
});

it('asks nothing on platforms that cannot tell us in advance', async () => {
  const { cameraAccessNow, requestCameraAccess } = await load('win32');
  expect(cameraAccessNow()).toBe('unknown');
  await expect(requestCameraAccess()).resolves.toBe('unknown');
  expect(systemPreferences.getMediaAccessStatus).not.toHaveBeenCalled();
  expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
});

it('opens the privacy pane each platform actually has', async () => {
  const mac = await load('darwin');
  mac.openCameraSettings();
  expect(shell.openExternal).toHaveBeenCalledWith(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  );

  shell.openExternal.mockClear();
  const win = await load('win32');
  win.openCameraSettings();
  expect(shell.openExternal).toHaveBeenCalledWith('ms-settings:privacy-webcam');

  shell.openExternal.mockClear();
  const linux = await load('linux');
  linux.openCameraSettings();
  expect(shell.openExternal).not.toHaveBeenCalled();
});
