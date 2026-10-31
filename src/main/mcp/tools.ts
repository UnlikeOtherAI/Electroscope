import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  ActivityEntry,
  CameraState,
  CaptureRequest,
  CaptureResult,
  RendererCommandName,
  RendererCommands,
  SharedFrame,
} from '../../shared/types.js';

/** Talks to whatever owns the camera (the renderer in the app, a fake in tests). */
export interface CameraBackend {
  call<K extends RendererCommandName>(
    name: K,
    args: Parameters<RendererCommands[K]>[0],
  ): Promise<ReturnType<RendererCommands[K]>>;
}

/** Everything the tools need from the app besides the camera. */
export interface AppFacade {
  claudeAccess(): boolean;
  /** Persist a capture and add it to the activity strip. */
  recordCapture(result: CaptureResult, tool: string, source: 'claude' | 'user'): Promise<ActivityEntry>;
  sharedFrames(): Promise<Array<{ entry: SharedFrame; data: Uint8Array; mimeType: string }>>;
  clearShared(): Promise<void>;
  announceCapture(tool: string): void;
}

export const SERVER_INSTRUCTIONS = [
  'Electroscope is a live electronics microscope camera. The human is watching the same camera in the Electroscope window, so do not ask them to stop or switch streams: you receive still frames on demand.',
  'Start with get_status to see the active camera, resolution and controls. Use capture_snapshot to look at the board. Pass region (normalised 0..1) to get a full-resolution close-up of a part of the frame, or follow_user_view to look at exactly what the human has zoomed to.',
  'Check focus_score, brightness and the exposure hints in the capture metadata before trusting fine detail. Use capture_sequence to watch something change (LED blinking, flux smoking, a part heating).',
  'If the human says they shared a frame, call get_shared_frames. The human can pause your access at any time; a paused response means you should ask them to resume it.',
].join('\n');

const regionSchema = z
  .object({
    x: z.number().min(0).max(1).describe('Left edge, 0..1 of the (oriented) frame width'),
    y: z.number().min(0).max(1).describe('Top edge, 0..1 of the frame height'),
    width: z.number().min(0.02).max(1).describe('Width, 0..1'),
    height: z.number().min(0.02).max(1).describe('Height, 0..1'),
  })
  .describe('Crop rectangle in normalised coordinates, taken from the full-resolution frame');

const captureShape = {
  camera: z.string().optional().describe('Camera id or part of its name. Defaults to the active camera.'),
  max_width: z
    .number()
    .int()
    .min(160)
    .max(3840)
    .optional()
    .describe('Longest-edge budget in pixels (default 1280). Larger costs more tokens.'),
  format: z.enum(['jpeg', 'png']).optional().describe('Default jpeg. Use png for lossless detail on small crops.'),
  quality: z.number().int().min(30).max(100).optional().describe('JPEG quality, default 85.'),
  region: regionSchema.optional(),
  follow_user_view: z
    .boolean()
    .optional()
    .describe('Capture exactly the area the human has zoomed/panned to in the window. Overrides region.'),
};

type CaptureArgs = {
  camera?: string | undefined;
  max_width?: number | undefined;
  format?: 'jpeg' | 'png' | undefined;
  quality?: number | undefined;
  region?: { x: number; y: number; width: number; height: number } | undefined;
  follow_user_view?: boolean | undefined;
};

function textResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function paused(): CallToolResult {
  return textResult(
    'The user has paused Claude access in Electroscope. Ask them to switch "Claude access" back on in the app, then try again.',
    true,
  );
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function hints(r: CaptureResult): string[] {
  const out: string[] = [];
  if (r.metrics.overexposed > 0.12) {
    out.push(
      `${Math.round(r.metrics.overexposed * 100)}% of pixels are blown out; reduce exposure/brightness (set_camera_controls) or ask for lighting to be dimmed.`,
    );
  }
  if (r.metrics.underexposed > 0.4 || r.metrics.brightness < 25) {
    out.push('Image is very dark; raise exposure/brightness or add light.');
  }
  if (r.metrics.focusScore < 15) {
    out.push('Focus score is very low: the image is probably out of focus or the field is featureless.');
  }
  return out;
}

function describeCapture(r: CaptureResult, entry: ActivityEntry, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    camera: r.camera.label,
    width: r.width,
    height: r.height,
    source_resolution: `${r.sourceWidth}x${r.sourceHeight}`,
    region: r.region,
    orientation: r.orientation,
    focus_score: round(r.metrics.focusScore, 1),
    brightness: round(r.metrics.brightness, 1),
    overexposed_fraction: round(r.metrics.overexposed, 3),
    underexposed_fraction: round(r.metrics.underexposed, 3),
    captured_at: r.capturedAt,
    saved_to: entry.path,
    hints: hints(r),
  };
}

function toRequest(args: CaptureArgs, defaults: { maxWidth: number }): CaptureRequest {
  const req: CaptureRequest = {
    maxWidth: args.max_width ?? defaults.maxWidth,
    format: args.format ?? 'jpeg',
    quality: (args.quality ?? 85) / 100,
    source: 'claude',
  };
  if (args.camera) req.cameraId = args.camera;
  if (args.follow_user_view) req.followUserView = true;
  else if (args.region) req.region = args.region;
  return req;
}

function summarise(state: CameraState, claudeAccess: boolean) {
  return {
    claude_access: claudeAccess,
    active_camera: state.active?.label ?? null,
    cameras: state.cameras.map((c) => ({ id: c.id, label: c.label, active: c.active })),
    resolution: state.active ? `${state.width}x${state.height}` : null,
    max_resolution: state.maxResolution ? `${state.maxResolution.width}x${state.maxResolution.height}` : null,
    fps: state.fps ? round(state.fps, 1) : null,
    orientation: state.orientation,
    live_focus_score: state.focusScore === null ? null : round(state.focusScore, 1),
    controls: state.controls,
  };
}

export function createMcpServer(backend: CameraBackend, app: AppFacade, version: string): McpServer {
  const server = new McpServer(
    { name: 'electroscope', title: 'Electroscope', version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'get_status',
    {
      title: 'Get microscope status',
      description:
        'Report the active camera, resolution, fps, orientation, live focus score, adjustable camera controls (with ranges) and whether the human currently allows Claude access.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const state = await backend.call('getState', undefined);
      return textResult(summarise(state, app.claudeAccess()));
    },
  );

  server.registerTool(
    'list_cameras',
    {
      title: 'List cameras',
      description: 'List every camera attached to the computer and which one the app is showing.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const state = await backend.call('refreshCameras', undefined);
      return textResult({ cameras: state.cameras });
    },
  );

  server.registerTool(
    'select_camera',
    {
      title: 'Switch camera',
      description:
        "Switch the live view (and therefore the human's window) to another camera, optionally at a given resolution.",
      inputSchema: {
        camera: z.string().describe('Camera id or part of its name'),
        width: z.number().int().min(160).max(7680).optional(),
        height: z.number().int().min(120).max(4320).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ camera, width, height }) => {
      if (!app.claudeAccess()) return paused();
      const args: { cameraId: string; width?: number; height?: number } = { cameraId: camera };
      if (width !== undefined) args.width = width;
      if (height !== undefined) args.height = height;
      const state = await backend.call('selectCamera', args);
      return textResult(summarise(state, true));
    },
  );

  server.registerTool(
    'set_camera_controls',
    {
      title: 'Adjust camera controls',
      description:
        'Set hardware camera controls such as focusMode ("manual"/"continuous"), focusDistance, zoom, exposureMode, exposureTime, brightness, contrast, sharpness, colorTemperature, torch. Names and ranges come from get_status; the camera decides which it supports. The human sees the change live.',
      inputSchema: {
        controls: z
          .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
          .describe('Map of control name to value, e.g. {"focusMode":"manual","focusDistance":120}'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ controls }) => {
      if (!app.claudeAccess()) return paused();
      const out = await backend.call('setControls', { controls });
      const nothingApplied = Object.keys(out.applied).length === 0 && Object.keys(out.rejected).length > 0;
      return textResult({ applied: out.applied, rejected: out.rejected, controls: out.state.controls }, nothingApplied);
    },
  );

  server.registerTool(
    'set_orientation',
    {
      title: 'Rotate or mirror the view',
      description:
        "Rotate (0/90/180/270 degrees clockwise) and/or mirror the image. Microscopes often flip the image; this changes both the human's view and your captures.",
      inputSchema: {
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
        mirror: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ rotation, mirror }) => {
      if (!app.claudeAccess()) return paused();
      const patch: { rotation?: 0 | 90 | 180 | 270; mirror?: boolean } = {};
      if (rotation !== undefined) patch.rotation = rotation;
      if (mirror !== undefined) patch.mirror = mirror;
      const state = await backend.call('setOrientation', patch);
      return textResult({ orientation: state.orientation });
    },
  );

  server.registerTool(
    'capture_snapshot',
    {
      title: 'Capture a snapshot',
      description:
        "Grab one still frame from the microscope without interrupting the human's live view. Returns the image plus metrics (focus_score, brightness, exposure) and hints. Use region for a high-detail close-up, or follow_user_view to see what the human is zoomed in on.",
      inputSchema: captureShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      if (!app.claudeAccess()) return paused();
      app.announceCapture('capture_snapshot');
      const result = await backend.call('capture', toRequest(args, { maxWidth: 1280 }));
      const entry = await app.recordCapture(result, 'capture_snapshot', 'claude');
      return {
        content: [
          { type: 'image', data: Buffer.from(result.data).toString('base64'), mimeType: result.mimeType },
          { type: 'text', text: JSON.stringify(describeCapture(result, entry), null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    'capture_sequence',
    {
      title: 'Capture a short sequence',
      description:
        'Capture 2-6 frames at a fixed interval to watch something change over time (blinking LED, heating part, smoke). Images are smaller by default (max_width 800).',
      inputSchema: {
        ...captureShape,
        count: z.number().int().min(2).max(6).describe('Number of frames'),
        interval_ms: z.number().int().min(100).max(5000).describe('Delay between frames in milliseconds'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ count, interval_ms, ...args }) => {
      if (!app.claudeAccess()) return paused();
      app.announceCapture('capture_sequence');
      const content: CallToolResult['content'] = [];
      const frames: unknown[] = [];
      const started = Date.now();
      for (let i = 0; i < count; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, interval_ms));
        const result = await backend.call('capture', toRequest(args, { maxWidth: 800 }));
        const entry = await app.recordCapture(result, 'capture_sequence', 'claude');
        content.push({ type: 'image', data: Buffer.from(result.data).toString('base64'), mimeType: result.mimeType });
        frames.push(describeCapture(result, entry, { index: i + 1, t_ms: Date.now() - started }));
      }
      content.push({ type: 'text', text: JSON.stringify({ frames }, null, 2) });
      return { content };
    },
  );

  server.registerTool(
    'get_shared_frames',
    {
      title: 'Get frames the human shared',
      description:
        'Return the frames the human pinned with "Share with Claude" in the app, newest last, with their notes. Optionally clear them afterwards.',
      inputSchema: {
        clear: z.boolean().optional().describe('Remove the returned frames from the share list'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ clear }) => {
      if (!app.claudeAccess()) return paused();
      const frames = await app.sharedFrames();
      if (frames.length === 0) return textResult('The human has not shared any frames.');
      const content: CallToolResult['content'] = [];
      for (const f of frames) {
        content.push({ type: 'image', data: Buffer.from(f.data).toString('base64'), mimeType: f.mimeType });
      }
      content.push({
        type: 'text',
        text: JSON.stringify(
          {
            frames: frames.map((f, i) => ({
              index: i + 1,
              note: f.entry.note,
              shared_at: f.entry.at,
              camera: f.entry.cameraLabel,
              width: f.entry.width,
              height: f.entry.height,
              saved_to: f.entry.path,
            })),
          },
          null,
          2,
        ),
      });
      if (clear) await app.clearShared();
      return { content };
    },
  );

  return server;
}
