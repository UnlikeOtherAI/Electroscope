import type { CameraControl, CameraInfo, CameraState, Orientation } from '../shared/types.js';
import { computeMetrics } from './frames.js';

const NUMERIC = [
  'zoom',
  'focusDistance',
  'exposureTime',
  'exposureCompensation',
  'brightness',
  'contrast',
  'saturation',
  'sharpness',
  'colorTemperature',
  'iso',
  'pan',
  'tilt',
] as const;
const MODES = ['focusMode', 'exposureMode', 'whiteBalanceMode'] as const;
const TOGGLES = ['torch'] as const;

/** A mode must be set before the value it governs. */
const MODE_FOR: Record<string, { mode: string; value: string }> = {
  focusDistance: { mode: 'focusMode', value: 'manual' },
  exposureTime: { mode: 'exposureMode', value: 'manual' },
  colorTemperature: { mode: 'whiteBalanceMode', value: 'manual' },
};

const PREFERRED_SIZE = { width: 1920, height: 1080 };

type Caps = Record<string, unknown>;

export const DEFAULT_ORIENTATION: Orientation = { rotation: 0, mirror: false };

export class CameraSession extends EventTarget {
  readonly video: HTMLVideoElement;
  cameras: Array<{ id: string; label: string }> = [];
  activeId: string | null = null;
  width = 0;
  height = 0;
  fps = 0;
  focusScore: number | null = null;
  controls: CameraControl[] = [];
  maxResolution: { width: number; height: number } | null = null;
  error: string | null = null;
  /** The camera exists but another app holds it; we keep retrying. */
  busy = false;
  /** Controls the camera accepted but did not apply (common on cheap UVC cameras). */
  private unresponsive = new Set<string>();
  private wantedId: string | null = null;
  orientations: Record<string, Orientation> = {};

  private stream: MediaStream | null = null;
  private frames = 0;
  private fpsTimer: number | undefined;
  private focusTimer: number | undefined;
  private opening: Promise<void> = Promise.resolve();

  constructor(video: HTMLVideoElement) {
    super();
    this.video = video;
    navigator.mediaDevices.addEventListener('devicechange', () => void this.onDeviceChange());
    this.fpsTimer = window.setInterval(() => {
      this.fps = this.frames;
      this.frames = 0;
      this.changed();
    }, 1000);
    this.focusTimer = window.setInterval(() => this.updateFocus(), 300);
    const tick = () => {
      this.frames++;
      this.video.requestVideoFrameCallback(tick);
    };
    this.video.requestVideoFrameCallback(tick);
  }

  get activeCamera(): CameraInfo | null {
    const c = this.cameras.find((x) => x.id === this.activeId);
    return c ? { ...c, active: true } : null;
  }

  get orientation(): Orientation {
    return (this.activeId && this.orientations[this.activeId]) || DEFAULT_ORIENTATION;
  }

  orientationFor(id: string): Orientation {
    return this.orientations[id] ?? DEFAULT_ORIENTATION;
  }

  state(): Omit<CameraState, 'view' | 'annotations'> {
    return {
      active: this.activeCamera,
      cameras: this.cameras.map((c) => ({ ...c, active: c.id === this.activeId })),
      width: this.width,
      height: this.height,
      fps: this.fps,
      orientation: this.orientation,
      focusScore: this.focusScore,
      controls: this.controls,
      maxResolution: this.maxResolution,
    };
  }

  /** Find a camera by exact id, or by a case-insensitive part of its label. */
  resolve(query: string): { id: string; label: string } {
    const q = query.trim().toLowerCase();
    const hit =
      this.cameras.find((c) => c.id === query) ??
      this.cameras.find((c) => c.label.toLowerCase() === q) ??
      this.cameras.find((c) => c.label.toLowerCase().includes(q));
    if (!hit) {
      const names = this.cameras.map((c) => `"${c.label}"`).join(', ') || 'none';
      throw new Error(`No camera matches "${query}". Available: ${names}`);
    }
    return hit;
  }

  async refresh(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.cameras = devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    this.changed();
  }

  /** Ask for permission once so device labels become available, then list cameras. */
  async init(preferred: string | null): Promise<void> {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (e) {
      this.error = describeError(e);
    }
    await this.refresh();
    const target = this.cameras.find((c) => c.id === preferred) ?? this.cameras[0];
    if (target) await this.open(target.id).catch(() => undefined);
    else if (!this.error) this.error = 'No camera found. Plug in your microscope and it will appear here.';
    this.changed();
  }

  open(id: string, size?: { width: number; height: number }): Promise<void> {
    // Serialise opens: Windows allows only one handle per camera.
    this.opening = this.opening.catch(() => undefined).then(() => this.doOpen(id, size));
    return this.opening;
  }

  private async doOpen(id: string, size?: { width: number; height: number }): Promise<void> {
    this.closeStream();
    this.error = null;
    this.wantedId = id;
    this.unresponsive.clear();
    const want = size ?? PREFERRED_SIZE;
    try {
      // A camera that was just released can report "busy" for a moment; retry before giving up.
      for (let attempt = 0; ; attempt++) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: { exact: id },
              width: { ideal: want.width },
              height: { ideal: want.height },
              frameRate: { ideal: 30 },
            },
            audio: false,
          });
          break;
        } catch (e) {
          if ((e as DOMException).name !== 'NotReadableError' || attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 700));
        }
      }
      this.activeId = id;
      this.video.srcObject = this.stream;
      // Some UVC drivers return a stream but never deliver a first frame. In that case play()
      // also stays pending forever; keep camera switching and automatic recovery available.
      void this.video.play().catch(() => undefined);
      await waitForFrame(this.video);
    } catch (e) {
      this.closeStream();
      this.activeId = null;
      this.busy = (e as DOMException).name === 'NotReadableError';
      this.error = describeError(e);
      this.changed();
      throw new Error(this.error);
    }
    this.busy = false;
    this.readTrack();
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.activeId = null;
      this.error = 'The camera was disconnected.';
      this.closeStream();
      void this.refresh();
    });
    this.changed();
    void this.probeControls(id);
  }

  /**
   * Many cheap UVC cameras list controls (brightness, sharpness...) that they accept and ignore. Nudge
   * each numeric control once, see whether the reading really moves, and put it back. Controls that
   * do nothing are flagged so the UI can hide them and agents are not misled.
   */
  private async probeControls(id: string): Promise<void> {
    const track = this.track;
    if (!track) return;
    const names = this.controls
      .filter((c) => c.range && typeof c.value === 'number' && !MODE_FOR[c.name] && !this.unresponsive.has(c.name))
      .map((c) => c.name);
    for (const name of names) {
      if (this.activeId !== id || this.track !== track) return;
      const c = this.controls.find((x) => x.name === name);
      if (!c?.range || typeof c.value !== 'number') continue;
      const original = c.value;
      const step = c.range.step || 1;
      const delta = Math.max(step, Math.round(((c.range.max - c.range.min) / 10 / step)) * step);
      const target = original + delta <= c.range.max ? original + delta : original - delta;
      let moved = false;
      try {
        await track.applyConstraints({ advanced: [{ [name]: target } as MediaTrackConstraintSet] });
        await new Promise((r) => setTimeout(r, 120));
        const now = (track.getSettings() as Record<string, unknown>)[name];
        moved = typeof now === 'number' && Math.abs(now - original) >= step / 2;
      } catch {
        moved = false;
      }
      await track.applyConstraints({ advanced: [{ [name]: original } as MediaTrackConstraintSet] }).catch(() => undefined);
      if (!moved) this.unresponsive.add(name);
    }
    if (this.activeId === id) {
      this.readTrack();
      this.changed();
    }
  }

  /** Called on a timer: if another app had the camera, take it as soon as it is free. */
  async retryIfBusy(): Promise<void> {
    if (this.busy && !this.activeId && this.wantedId) await this.open(this.wantedId).catch(() => undefined);
  }

  private closeStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.controls = [];
    this.width = this.height = 0;
    this.focusScore = null;
  }

  private get track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  private readTrack(): void {
    const track = this.track;
    if (!track) return;
    const s = track.getSettings();
    this.width = s.width ?? this.video.videoWidth;
    this.height = s.height ?? this.video.videoHeight;
    const caps = (track.getCapabilities?.() ?? {}) as Caps;
    const settings = s as Record<string, unknown>;
    const wr = caps['width'] as { max?: number } | undefined;
    const hr = caps['height'] as { max?: number } | undefined;
    this.maxResolution = wr?.max && hr?.max ? { width: wr.max, height: hr.max } : null;

    const out: CameraControl[] = [];
    for (const name of NUMERIC) {
      const c = caps[name] as { min?: number; max?: number; step?: number } | undefined;
      if (c && typeof c.min === 'number' && typeof c.max === 'number' && c.max > c.min) {
        out.push({
          name,
          value: (settings[name] as number | undefined) ?? null,
          range: { min: c.min, max: c.max, step: c.step || (c.max - c.min) / 100 },
        });
      }
    }
    for (const name of MODES) {
      const c = caps[name] as string[] | undefined;
      if (Array.isArray(c) && c.length > 1) {
        out.push({ name, value: (settings[name] as string | undefined) ?? null, options: c });
      }
    }
    for (const name of TOGGLES) {
      if (caps[name]) out.push({ name, value: Boolean(settings[name]) });
    }
    this.controls = out.map((c) => (this.unresponsive.has(c.name) ? { ...c, responsive: false } : c));
  }

  async applyControls(
    wanted: Record<string, number | string | boolean>,
  ): Promise<{ applied: Record<string, unknown>; rejected: Record<string, string> }> {
    const track = this.track;
    if (!track) throw new Error('No camera is open');
    const applied: Record<string, unknown> = {};
    const rejected: Record<string, string> = {};
    const known = new Map(this.controls.map((c) => [c.name, c]));

    const entries = Object.entries(wanted).sort(([a], [b]) => Number(b.endsWith('Mode')) - Number(a.endsWith('Mode')));
    for (const [name, value] of entries) {
      const control = known.get(name);
      if (!control) {
        rejected[name] = `Not supported by this camera. Supported: ${[...known.keys()].join(', ') || 'none'}`;
        continue;
      }
      if (control.range && typeof value !== 'number') {
        rejected[name] = 'Expected a number';
        continue;
      }
      if (control.range && typeof value === 'number') {
        if (value < control.range.min || value > control.range.max) {
          rejected[name] = `Out of range ${control.range.min}..${control.range.max}`;
          continue;
        }
      }
      if (control.options && !control.options.includes(String(value))) {
        rejected[name] = `Must be one of ${control.options.join(', ')}`;
        continue;
      }
      // Setting a manual value implies manual mode.
      const needs = MODE_FOR[name];
      if (needs && !(needs.mode in wanted) && known.has(needs.mode)) {
        await track.applyConstraints({ advanced: [{ [needs.mode]: needs.value } as MediaTrackConstraintSet] }).catch(() => undefined);
      }
      try {
        await track.applyConstraints({ advanced: [{ [name]: value } as MediaTrackConstraintSet] });
      } catch (e) {
        rejected[name] = (e as Error).message;
        continue;
      }
      applied[name] = value;
    }

    this.readTrack();
    for (const [name, value] of Object.entries(applied)) {
      const now = this.controls.find((c) => c.name === name)?.value;
      if (typeof value === 'number' && typeof now === 'number') {
        const step = known.get(name)?.range?.step ?? 1;
        if (Math.abs(now - value) > Math.max(step, Math.abs(value) * 0.02)) {
          delete applied[name];
          this.unresponsive.add(name);
          rejected[name] = `Camera ignored the request and kept ${now}; this control has no effect on this camera`;
        }
      } else if (now !== null && now !== undefined && now !== value) {
        delete applied[name];
        this.unresponsive.add(name);
        rejected[name] = `Camera ignored the request and kept ${String(now)}; this control has no effect on this camera`;
      }
    }
    this.readTrack();
    this.changed();
    return { applied, rejected };
  }

  /** The current frame as something drawable, plus its pixel size. */
  async grab(): Promise<{ src: CanvasImageSource; width: number; height: number; release(): void }> {
    const track = this.track;
    if (!track) throw new Error('No camera is open');
    if (typeof ImageCapture !== 'undefined') {
      try {
        const bmp = await new ImageCapture(track).grabFrame();
        return { src: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
      } catch {
        /* fall through to the video element */
      }
    }
    return { src: this.video, width: this.video.videoWidth, height: this.video.videoHeight, release: () => undefined };
  }

  /** Open a different camera just long enough to take one frame, leaving the live view untouched. */
  async grabFromOther(id: string): Promise<{ src: CanvasImageSource; width: number; height: number; release(): void }> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: id }, width: { ideal: PREFERRED_SIZE.width }, height: { ideal: PREFERRED_SIZE.height } },
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await waitForFrame(video);
    // Let auto exposure settle for a moment.
    await new Promise((r) => setTimeout(r, 400));
    const bmp = await createImageBitmap(video);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    return { src: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
  }

  private updateFocus(): void {
    if (!this.stream || this.video.readyState < 2 || !this.video.videoWidth) return;
    try {
      this.focusScore = computeMetrics(this.video, this.video.videoWidth, this.video.videoHeight).focusScore;
      this.dispatchEvent(new Event('focus'));
    } catch {
      /* frame not ready */
    }
  }

  private async onDeviceChange(): Promise<void> {
    await this.refresh();
    if (this.activeId && !this.cameras.some((c) => c.id === this.activeId)) {
      this.activeId = null;
      this.closeStream();
      this.error = 'The camera was disconnected.';
    } else if (!this.activeId && this.cameras[0]) {
      await this.open(this.cameras[0].id).catch(() => undefined);
    }
    this.changed();
  }

  changed(): void {
    this.dispatchEvent(new Event('change'));
  }

  dispose(): void {
    window.clearInterval(this.fpsTimer);
    window.clearInterval(this.focusTimer);
    this.closeStream();
  }
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', done);
      if (video.readyState >= 2 && video.videoWidth > 0) resolve();
      else reject(new DOMException('The camera did not deliver a video frame. Retrying automatically.', 'NotReadableError'));
    };
    const timer = setTimeout(done, 5000);
    video.addEventListener('loadeddata', done);
  });
}

export function describeError(
  e: unknown,
  platform = typeof window !== 'undefined' ? window.electroscope?.platform : undefined,
): string {
  const err = e as DOMException;
  switch (err?.name) {
    case 'NotAllowedError':
      if (platform === 'darwin') return 'Camera access is blocked. Open System Settings > Privacy & Security > Camera and allow Electroscope.';
      return 'Camera access is blocked. On Windows, open Settings > Privacy & security > Camera and allow desktop apps to use your camera.';
    case 'NotFoundError':
      return 'No camera found. Plug in your microscope and it will appear here.';
    case 'NotReadableError':
      return 'The camera is unavailable. Close any other app using it; Electroscope will retry automatically.';
    case 'OverconstrainedError':
      return 'The camera does not support that resolution.';
    default:
      return err?.message || 'Could not open the camera.';
  }
}
