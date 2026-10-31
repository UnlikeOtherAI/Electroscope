import type { CameraState, CaptureRequest, CaptureResult, Orientation, RendererCommands } from '../shared/types.js';
import { drawAnnotations } from './annotations.js';
import { DEFAULT_ORIENTATION, type CameraSession } from './camera.js';
import { computeMetrics, encode, renderFrame } from './frames.js';
import type { Viewer } from './viewer.js';

export interface CommandContext {
  session: CameraSession;
  viewer: Viewer;
  setOrientation(cameraId: string, o: Orientation): Promise<void>;
  rememberCamera(cameraId: string, size?: { width: number; height: number }): Promise<void>;
}

function fullState({ session, viewer }: CommandContext): CameraState {
  return { ...session.state(), view: viewer.view(), annotations: viewer.annotations };
}

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
    // Metrics first: marks must not change the focus score.
    const metrics = computeMetrics(rendered.canvas, rendered.canvas.width, rendered.canvas.height);
    // Marks belong to the camera the human is looking at, not to a one-off capture from another.
    if (req.annotated && cam.id === session.activeId) {
      const c = rendered.canvas.getContext('2d');
      if (c) drawAnnotations(c, viewer.annotations, rendered.region, rendered.canvas.width, rendered.canvas.height);
    }
    const data = await encode(rendered.canvas, req.format, req.quality);
    const full = rendered.region.width > 0.999 && rendered.region.height > 0.999;
    return {
      data,
      mimeType: req.format === 'png' ? 'image/png' : 'image/jpeg',
      width: rendered.canvas.width,
      height: rendered.canvas.height,
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
    async setAnnotations({ upsert, remove, clear }) {
      if (clear) viewer.clearAnnotations();
      if (remove?.length) viewer.removeAnnotations(remove);
      if (upsert?.length) viewer.upsertAnnotations(upsert);
      return fullState(ctx);
    },
    capture: (req) => captureFrame(ctx, req),
  };
}
