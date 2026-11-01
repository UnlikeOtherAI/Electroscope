import type {
  CameraState,
  CaptureRequest,
  CaptureResult,
  ImageAdjustments,
  Orientation,
  RendererCommands,
} from '../shared/types.js';
import { ADJUSTMENT_RANGE, NEUTRAL_ADJUSTMENTS } from '../shared/types.js';
import { drawAnnotations } from './annotations.js';
import { DEFAULT_ORIENTATION, type CameraSession } from './camera.js';
import { applyAdjustments, computeMetrics, encode, renderFrame, thumbnailDataUrl } from './frames.js';
import type { Viewer } from './viewer.js';

export interface CommandContext {
  session: CameraSession;
  viewer: Viewer;
  setOrientation(cameraId: string, o: Orientation): Promise<void>;
  setAdjustments(cameraId: string, a: ImageAdjustments): Promise<void>;
  rememberCamera(cameraId: string, size?: { width: number; height: number }): Promise<void>;
}

function fullState({ session, viewer }: CommandContext): CameraState {
  return { ...session.state(), view: viewer.view(), annotations: viewer.annotations };
}

export { NEUTRAL_ADJUSTMENTS };

/** Grab, orient, crop, scale and encode a frame. Used for agent captures and for "Save photo". */
export async function captureFrame(ctx: CommandContext, req: CaptureRequest): Promise<CaptureResult> {
  const { session, viewer } = ctx;
  let cam = session.activeCamera;
  let orientation = session.orientation;
  let grab: Awaited<ReturnType<CameraSession['grab']>>;

  if (req.cameraId && req.cameraId !== session.activeId) {
    const target = session.resolve(req.cameraId);
    if (target.id === session.activeId) {
      grab = await session.grab();
    } else {
      cam = { ...target, active: false };
      orientation = session.orientationFor(target.id);
      grab = await session.grabFromOther(target.id);
    }
  } else {
    grab = await session.grab();
  }
  if (!cam) throw new Error('No camera is open. Plug in the microscope or select a camera.');

  try {
    const region = req.followUserView ? viewer.visibleRegion() : (req.region ?? null);
    const rendered = renderFrame(grab.src, grab.width, grab.height, orientation, region, req.maxWidth);
    // Metrics first, on the untouched frame: neither our picture adjustments nor the marks
    // should move the focus score or the exposure readings.
    const metrics = computeMetrics(rendered.canvas, rendered.canvas.width, rendered.canvas.height);
    const canvas = applyAdjustments(rendered.canvas, session.adjustmentsFor(cam.id));
    // Marks belong to the camera the human is looking at, not to a one-off capture from another.
    if (req.annotated && cam.id === session.activeId) {
      const c = canvas.getContext('2d');
      if (c) drawAnnotations(c, viewer.annotations, rendered.region, canvas.width, canvas.height);
    }
    const data = await encode(canvas, req.format, req.quality);
    const full = rendered.region.width > 0.999 && rendered.region.height > 0.999;
    return {
      data,
      ...(req.thumbnail ? { thumbnail: await thumbnailDataUrl(canvas).catch(() => undefined) } : {}),
      mimeType: req.format === 'png' ? 'image/png' : 'image/jpeg',
      width: canvas.width,
      height: canvas.height,
      sourceWidth: grab.width,
      sourceHeight: grab.height,
      camera: cam,
      region: full ? null : rendered.region,
      orientation,
      metrics,
      capturedAt: new Date().toISOString(),
    };
  } finally {
    grab.release();
  }
}

export function createCommands(ctx: CommandContext): {
  [K in keyof RendererCommands]: (args: Parameters<RendererCommands[K]>[0]) => Promise<ReturnType<RendererCommands[K]>>;
} {
  const { session, viewer } = ctx;
  return {
    async getState() {
      return fullState(ctx);
    },
    async refreshCameras() {
      await session.refresh();
      return fullState(ctx);
    },
    async selectCamera({ cameraId, width, height }) {
      const target = session.resolve(cameraId);
      const size = width && height ? { width, height } : undefined;
      await session.open(target.id, size);
      viewer.clearAnnotations();
      await ctx.rememberCamera(target.id, size);
      return fullState(ctx);
    },
    async setControls({ controls }) {
      const { applied, rejected } = await session.applyControls(controls);
      return { applied, rejected, state: fullState(ctx) };
    },
    async setOrientation(patch) {
      const id = session.activeId;
      if (!id) throw new Error('No camera is open');
      const next = { ...(session.orientations[id] ?? DEFAULT_ORIENTATION), ...patch };
      await ctx.setOrientation(id, next);
      return fullState(ctx);
    },
    async setView(patch) {
      viewer.patchView(patch);
      return fullState(ctx);
    },
    async setAdjustments(patch) {
      const id = session.activeId;
      if (!id) throw new Error('No camera is open');
      const current = session.adjustmentsFor(id);
      const next = { ...current };
      for (const key of ['brightness', 'contrast', 'saturation'] as const) {
        const v = patch[key];
        if (v === undefined) continue;
        if (!Number.isFinite(v) || v < ADJUSTMENT_RANGE.min || v > ADJUSTMENT_RANGE.max) {
          throw new Error(`${key} must be between ${ADJUSTMENT_RANGE.min} and ${ADJUSTMENT_RANGE.max} (1 leaves the picture as the camera sent it)`);
        }
        next[key] = Math.round(v * 100) / 100;
      }
      await ctx.setAdjustments(id, next);
      return fullState(ctx);
    },
    async setAnnotations({ upsert, remove, clear, author }) {
      if (clear) viewer.clearAnnotations();
      if (remove?.length) viewer.removeAnnotations(remove);
      if (upsert?.length) viewer.upsertAnnotations(upsert, author ?? 'An agent');
      return fullState(ctx);
    },
    capture: (req) => captureFrame(ctx, req),
  };
}
