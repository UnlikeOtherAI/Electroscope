import { afterEach, expect, it, vi } from 'vitest';
import { CameraSession } from '../src/renderer/camera.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('releases a camera that never produces frames, then retries without blocking camera switching', async () => {
  vi.useFakeTimers();
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), {
    stop,
    getSettings: () => ({ width: 1280, height: 720 }),
    getCapabilities: () => ({}),
  });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn().mockResolvedValue(stream),
  });
  vi.stubGlobal('navigator', { mediaDevices });
  vi.stubGlobal('window', globalThis);
  const video = Object.assign(new EventTarget(), {
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    srcObject: null,
    // Reproduce the driver failure: play never settles either.
    play: () => new Promise<void>(() => {}),
    requestVideoFrameCallback: vi.fn(),
  });
  const session = new CameraSession(video as unknown as HTMLVideoElement);
  const opening = expect(session.open('microscope')).rejects.toThrow(/camera/i);
  await vi.advanceTimersByTimeAsync(5000);
  await opening;
  expect(stop).toHaveBeenCalledOnce();
  expect(session.activeId).toBeNull();
  expect(session.busy).toBe(true);
  expect(video.srcObject).toBeNull();

  // The next opening gets a usable frame; even a pending play() must not block it.
  video.readyState = 2;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  await session.retryIfBusy();
  expect(session.activeId).toBe('microscope');
  expect(session.width).toBe(1280);
  expect(session.busy).toBe(false);
  expect(session.error).toBeNull();
  session.dispose();
});
