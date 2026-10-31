import type {
  CameraState,
  CaptureRequest,
  CaptureResult,
  Orientation,
  Region,
  RendererCommands,
} from '../shared/types.js';
import { DEFAULT_ORIENTATION, type CameraSession } from './camera.js';
import { computeMetrics, encode, renderFrame, thumbnailDataUrl } from './frames.js';

export interface CommandContext {
  session: CameraSession;
  userViewRegion(): Region;
  setOrientation(cameraId: string, o: Orientation): Promise<void>;
  rememberCamera(cameraId: string, size?: { width: number; height: number }): Promise<void>;
}

/** Grab, orient, crop, scale and encode a frame. Used for both Claude's requests and the human's "share". */
export async function captureFrame(ctx: CommandContext, req: CaptureRequest): Promise<CaptureResult> {
  const { session } = ctx;
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
  if (!cam) throw new Error('No camera is open. Ask the human to plug in or select a camera.');

  try {
    const region = req.followUserView ? ctx.userViewRegion() : (req.region ?? null);
    const rendered = renderFrame(grab.src, grab.width, grab.height, orientation, region, req.maxWidth);
    const metrics = computeMetrics(rendered.canvas, rendered.canvas.width, rendered.canvas.height);
    const [data, thumbnail] = await Promise.all([
      encode(rendered.canvas, req.format, req.quality),
      thumbnailDataUrl(rendered.canvas),
    ]);
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
      thumbnail,
      capturedAt: new Date().toISOString(),
    };
  } finally {
    grab.release();
  }
}

export function createCommands(ctx: CommandContext): {
  [K in keyof RendererCommands]: (args: Parameters<RendererCommands[K]>[0]) => Promise<ReturnType<RendererCommands[K]>>;
} {
  const { session } = ctx;
  return {
    async getState() {
      return session.state();
    },
    async refreshCameras() {
      await session.refresh();
      return session.state();
    },
    async selectCamera({ cameraId, width, height }) {
      const target = session.resolve(cameraId);
      const size = width && height ? { width, height } : undefined;
      await session.open(target.id, size);
      await ctx.rememberCamera(target.id, size);
      return session.state();
    },
    async setControls({ controls }) {
      const { applied, rejected } = await session.applyControls(controls);
      return { applied, rejected, state: session.state() as CameraState };
    },
    async setOrientation(patch) {
      const id = session.activeId;
      if (!id) throw new Error('No camera is open');
      const next = { ...(session.orientations[id] ?? DEFAULT_ORIENTATION), ...patch };
      await ctx.setOrientation(id, next);
      return session.state();
    },
    capture: (req) => captureFrame(ctx, req),
  };
}
