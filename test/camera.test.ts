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
  await session.retryIfStuck();
  expect(session.activeId).toBe('microscope');
  expect(session.width).toBe(1280);
  expect(session.busy).toBe(false);
  expect(session.error).toBeNull();
  session.dispose();
});

it('reopens a camera that hands over a stream and then goes silent', async () => {
  // Real timers here: this test moves the clock, not the event loop.
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720 }),
    getCapabilities: () => ({}),
  });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: Object.assign(new EventTarget(), { getUserMedia }) });
  vi.stubGlobal('window', globalThis);
  // A camera that opens cleanly and delivers a frame, so the stream looks healthy.
  const video = Object.assign(new EventTarget(), {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    srcObject: null,
    play: () => Promise.resolve(),
    requestVideoFrameCallback: vi.fn(),
  });
  const session = new CameraSession(video as unknown as HTMLVideoElement);
  await session.open('microscope');
  expect(session.activeId).toBe('microscope');
  expect(getUserMedia).toHaveBeenCalledTimes(1);

  // Still delivering, however long it runs: nothing to recover from.
  now += 20_000;
  await session.retryIfStuck();
  expect(getUserMedia).toHaveBeenCalledTimes(1);

  // Now it goes silent while holding the stream open. That is the failure worth recovering.
  video.videoWidth = 0;
  const reopening = session.retryIfStuck();
  for (let i = 0; i < 50 && getUserMedia.mock.calls.length < 2; i++) await Promise.resolve();
  expect(getUserMedia).toHaveBeenCalledTimes(2);

  // The reopened camera starts delivering again.
  video.videoWidth = 1280;
  video.dispatchEvent(new Event('loadeddata'));
  await reopening;
  expect(session.activeId).toBe('microscope');

  // The fresh stream gets its own grace period rather than being reopened on every tick.
  await session.retryIfStuck();
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  session.dispose();
});
