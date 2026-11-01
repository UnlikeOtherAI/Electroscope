import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  ActivityEvent,
  AnnotationInput,
  CameraState,
  CaptureRequest,
  CaptureResult,
  ClientInfo,
  RendererCommandName,
  RendererCommands,
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
  /** Keep a copy of a frame that was returned to an agent; resolves to the file path. */
  saveCapture(result: CaptureResult, tool: string): Promise<string>;
  /** Save a photo for the human (Pictures folder); resolves to the file path. */
  savePhoto(result: CaptureResult): Promise<string>;
  /** Tell the window what an agent just did, so the human can see it happen. */
  activity(event: Omit<ActivityEvent, 'id' | 'at'>): void;
}

export const SERVER_INSTRUCTIONS = [
  'Electroscope is a live electronics microscope camera. A human may be watching the same camera in the Electroscope window, so do not ask them to stop or switch streams: you get still frames on demand and can drive every control the app has.',
  'Start with get_status to see the active camera, resolution, view and adjustable controls. Use capture_snapshot to look at the board. Pass region (normalised 0..1) for a full-resolution close-up of part of the frame, or follow_user_view to capture exactly what the human has zoomed to.',
  'Check focus_score, brightness and the exposure hints in the capture metadata before trusting fine detail. Use capture_sequence to watch something change (LED blinking, flux smoking, a part heating).',
].join('\n');

const regionSchema = z
  .object({
    x: z.number().min(0).max(1).describe('Left edge, 0..1 of the (oriented) frame width'),
    y: z.number().min(0).max(1).describe('Top edge, 0..1 of the frame height'),
    width: z.number().min(0.02).max(1).describe('Width, 0..1'),
    height: z.number().min(0.02).max(1).describe('Height, 0..1'),
  })
  .describe('Crop rectangle in normalised coordinates, taken from the full-resolution frame');

const frameShape = {
  include_annotations: z.boolean().optional().describe('Draw the marks set with annotate onto the image (off by default).'),
  camera: z.string().optional().describe('Camera id or part of its name. Defaults to the active camera.'),
  region: regionSchema.optional(),
  follow_user_view: z
    .boolean()
    .optional()
    .describe('Capture exactly the area the human has zoomed/panned to in the window. Overrides region.'),
};

const captureShape = {
  ...frameShape,
  max_width: z
    .number()
    .int()
    .min(160)
    .max(3840)
    .optional()
    .describe('Longest-edge budget in pixels (default 1280). Larger costs more tokens.'),
  format: z.enum(['jpeg', 'png']).optional().describe('Default jpeg. Use png for lossless detail on small crops.'),
  quality: z.number().int().min(30).max(100).optional().describe('JPEG quality, default 85.'),
};

type FrameArgs = {
  include_annotations?: boolean | undefined;
  camera?: string | undefined;
  region?: { x: number; y: number; width: number; height: number } | undefined;
  follow_user_view?: boolean | undefined;
};
type CaptureArgs = FrameArgs & {
  max_width?: number | undefined;
  format?: 'jpeg' | 'png' | undefined;
  quality?: number | undefined;
};

/** One plain line for the activity list in the window: what this call did, in the human's words. */
function describeCall(tool: string, args: Record<string, unknown>): string {
  const region = args['region'] as { width?: number } | undefined;
  switch (tool) {
    case 'get_status':
      return 'Checked the microscope';
    case 'list_cameras':
      return 'Listed the cameras';
    case 'select_camera':
      return `Switched to ${String(args['camera'] ?? 'another camera')}`;
    case 'set_camera_controls':
      return `Adjusted ${Object.keys((args['controls'] as object) ?? {}).join(', ') || 'the camera'}`;
    case 'set_orientation':
      return 'Rotated the image';
    case 'set_view':
      if (args['frozen'] !== undefined) return args['frozen'] ? 'Froze your view' : 'Unfroze your view';
      if (args['zoom'] !== undefined) return `Zoomed your view to ${String(args['zoom'])}x`;
      return 'Changed your view';
    case 'annotate': {
      const marks = (args['annotations'] as unknown[] | undefined)?.length ?? 0;
      return marks === 1 ? 'Drew a mark on your view' : `Drew ${marks} marks on your view`;
    }
    case 'clear_annotations':
      return 'Removed marks from your view';
    case 'capture_snapshot':
      if (args['follow_user_view']) return 'Captured the area you are zoomed to';
      return region ? 'Captured a close-up' : 'Captured a snapshot';
    case 'capture_sequence':
      return `Captured ${String(args['count'] ?? '')} frames in a row`;
    case 'set_image_adjustments':
      return 'Adjusted the picture';
    case 'save_photo':
      return 'Saved a full-resolution photo';
    default:
      return tool;
  }
}

function textResult(value: unknown, isError = false): CallToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function hints(r: CaptureResult): string[] {
  const out: string[] = [];
  if (r.metrics.overexposed > 0.12) {
    out.push(
      `${Math.round(r.metrics.overexposed * 100)}% of pixels are blown out; reduce exposure/brightness (set_camera_controls) or dim the lighting.`,
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

function describeCapture(r: CaptureResult, path: string, extra: Record<string, unknown> = {}) {
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
    saved_to: path,
    hints: hints(r),
  };
}

function toRequest(args: CaptureArgs, defaults: { maxWidth: number; format: 'jpeg' | 'png' }): CaptureRequest {
  const req: CaptureRequest = {
    maxWidth: args.max_width ?? defaults.maxWidth,
    format: args.format ?? defaults.format,
    quality: (args.quality ?? 85) / 100,
    // The window shows the human what the agent just looked at.
    thumbnail: true,
  };
  if (args.camera) req.cameraId = args.camera;
  if (args.include_annotations) req.annotated = true;
  if (args.follow_user_view) req.followUserView = true;
  else if (args.region) req.region = args.region;
  return req;
}

function summarise(state: CameraState) {
  return {
    active_camera: state.active?.label ?? null,
    cameras: state.cameras.map((c) => ({ id: c.id, label: c.label, active: c.active })),
    resolution: state.active ? `${state.width}x${state.height}` : null,
    max_resolution: state.maxResolution ? `${state.maxResolution.width}x${state.maxResolution.height}` : null,
    image_adjustments: state.adjustments,
    fps: state.fps ? round(state.fps, 1) : null,
    orientation: state.orientation,
    view: {
      zoom: round(state.view.zoom, 2),
      center_x: round(state.view.centerX, 3),
      center_y: round(state.view.centerY, 3),
      grid: state.view.grid,
      crosshair: state.view.crosshair,
      grid_color: state.view.gridColor,
      crosshair_color: state.view.crosshairColor,
      frozen: state.view.frozen,
    },
    annotations: state.annotations,
    live_focus_score: state.focusScore === null ? null : round(state.focusScore, 1),
    controls: state.controls,
    ...(state.controlsNote ? { controls_note: state.controlsNote } : {}),
  };
}

export function createMcpServer(
  backend: CameraBackend,
  app: AppFacade,
  version: string,
  client: ClientInfo = { id: '', name: 'an agent', version: '', connectedAt: '', lastSeen: '' },
): McpServer {
  const server = new McpServer(
    { name: 'electroscope', title: 'Electroscope', version },
    { instructions: SERVER_INSTRUCTIONS },
  );

  /**
   * Every tool goes through here, so the window can show the human what the agent is doing to
   * their camera as it happens. Reporting never changes what the agent gets back.
   */
  const report = (tool: string, args: unknown, ok: boolean, thumbnail?: string): void => {
    try {
      app.activity({
        clientId: client.id,
        client: client.name,
        tool,
        summary: describeCall(tool, (args ?? {}) as Record<string, unknown>),
        ok,
        ...(thumbnail ? { thumbnail } : {}),
      });
    } catch {
      /* the activity list is never worth failing a tool call over */
    }
  };

  /** Set by the capture handlers so the activity entry can carry the picture the agent just took. */
  let lastThumbnail: string | undefined;
  type Handler = (args: never) => Promise<CallToolResult>;
  const watched =
    (name: string, handler: Handler) =>
    async (args: never): Promise<CallToolResult> => {
      try {
        const result = await handler(args);
        report(name, args, !result.isError, lastThumbnail);
        return result;
      } catch (e) {
        report(name, args, false);
        throw e;
      } finally {
        lastThumbnail = undefined;
      }
    };
  /** Registers a tool exactly as the SDK would, with its call reported to the window. */
  const tool = ((name: string, config: never, handler: Handler) =>
    server.registerTool(name, config, watched(name, handler) as never)) as typeof server.registerTool;

  tool(
    'get_status',
    {
      title: 'Get microscope status',
      description:
        'Report the active camera, resolution, fps, orientation, on-screen view (zoom, pan, overlays), live focus score, and every adjustable camera control with its range. Controls marked responsive:false are accepted by the camera but have no effect.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => textResult(summarise(await backend.call('getState', undefined))),
  );

  tool(
    'list_cameras',
    {
      title: 'List cameras',
      description: 'Rescan and list every camera attached to the computer, and which one the app is showing.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const state = await backend.call('refreshCameras', undefined);
      return textResult({ cameras: state.cameras });
    },
  );

  tool(
    'select_camera',
    {
      title: 'Switch camera',
      description: "Switch the live view to another camera, optionally at a given resolution.",
      inputSchema: {
        camera: z.string().describe('Camera id or part of its name'),
        width: z.number().int().min(160).max(7680).optional(),
        height: z.number().int().min(120).max(4320).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ camera, width, height }) => {
      const args: { cameraId: string; width?: number; height?: number } = { cameraId: camera };
      if (width !== undefined) args.width = width;
      if (height !== undefined) args.height = height;
      return textResult(summarise(await backend.call('selectCamera', args)));
    },
  );

  tool(
    'set_camera_controls',
    {
      title: 'Adjust camera controls',
      description:
        'Set hardware camera controls such as focusMode ("manual"/"continuous"), focusDistance, zoom, exposureMode, exposureTime, brightness, contrast, sharpness, colorTemperature. Only the names get_status lists are available: most USB microscopes expose none, and macOS can only drive zoom, pan and tilt at all. When get_status lists no controls, use set_image_adjustments instead, which always works. Setting a manual value switches the matching mode to manual first. Controls the camera ignores are reported in "rejected".',
      inputSchema: {
        controls: z
          .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
          .describe('Map of control name to value, e.g. {"focusMode":"manual","focusDistance":120}'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ controls }) => {
      const out = await backend.call('setControls', { controls });
      const nothingApplied = Object.keys(out.applied).length === 0 && Object.keys(out.rejected).length > 0;
      return textResult(
        {
          applied: out.applied,
          rejected: out.rejected,
          controls: out.state.controls,
          ...(out.state.controlsNote ? { controls_note: out.state.controlsNote } : {}),
          ...(nothingApplied ? { try_instead: 'set_image_adjustments changes brightness, contrast and saturation on any camera.' } : {}),
        },
        nothingApplied,
      );
    },
  );

  tool(
    'set_orientation',
    {
      title: 'Rotate or mirror the image',
      description:
        "Rotate (0/90/180/270 degrees clockwise) and/or mirror the image. Microscopes often flip the image; this changes both the on-screen view and captures.",
      inputSchema: {
        rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
        mirror: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ rotation, mirror }) => {
      const patch: { rotation?: 0 | 90 | 180 | 270; mirror?: boolean } = {};
      if (rotation !== undefined) patch.rotation = rotation;
      if (mirror !== undefined) patch.mirror = mirror;
      const state = await backend.call('setOrientation', patch);
      return textResult({ orientation: state.orientation });
    },
  );

  tool(
    'set_view',
    {
      title: 'Control the on-screen view',
      description:
        'Zoom and pan the live view in the Electroscope window, toggle the grid and crosshair overlays, or freeze the on-screen picture. Captures always read the live camera, even while frozen. Use follow_user_view in capture_snapshot to capture the area you set here.',
      inputSchema: {
        zoom: z.number().min(1).max(12).optional().describe('1 shows the whole frame; 4 shows a quarter of its width'),
        center_x: z.number().min(0).max(1).optional().describe('Centre of the visible area, 0..1 across the oriented frame'),
        center_y: z.number().min(0).max(1).optional().describe('Centre of the visible area, 0..1 down the oriented frame'),
        grid: z.boolean().optional(),
        crosshair: z.boolean().optional(),
        grid_color: z.string().max(40).optional().describe('Any CSS colour, e.g. "#00ffcc" or "yellow"'),
        crosshair_color: z.string().max(40).optional().describe('Any CSS colour'),
        frozen: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ zoom, center_x, center_y, grid, crosshair, grid_color, crosshair_color, frozen }) => {
      const patch: Parameters<RendererCommands['setView']>[0] = {};
      if (zoom !== undefined) patch.zoom = zoom;
      if (center_x !== undefined) patch.centerX = center_x;
      if (center_y !== undefined) patch.centerY = center_y;
      if (grid !== undefined) patch.grid = grid;
      if (crosshair !== undefined) patch.crosshair = crosshair;
      if (grid_color !== undefined) patch.gridColor = grid_color;
      if (crosshair_color !== undefined) patch.crosshairColor = crosshair_color;
      if (frozen !== undefined) patch.frozen = frozen;
      return textResult({ view: summarise(await backend.call('setView', patch)).view });
    },
  );

  tool(
    'set_image_adjustments',
    {
      title: 'Adjust the picture',
      description:
        "Brighten, add contrast or change saturation. Electroscope does this itself, so it works on every camera on every platform, unlike set_camera_controls. 1 means the picture as the camera sent it; 0.25 to 2.5 are allowed. It changes what the human sees and every image you capture, but not focus_score or brightness in the capture metadata, which always describe the untouched frame.",
      inputSchema: {
        brightness: z.number().min(0.25).max(2.5).optional(),
        contrast: z.number().min(0.25).max(2.5).optional(),
        saturation: z.number().min(0.25).max(2.5).optional().describe('0 is not allowed; use 0.25 for nearly grey'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ brightness, contrast, saturation }) => {
      const patch: Parameters<RendererCommands['setAdjustments']>[0] = {};
      if (brightness !== undefined) patch.brightness = brightness;
      if (contrast !== undefined) patch.contrast = contrast;
      if (saturation !== undefined) patch.saturation = saturation;
      const state = await backend.call('setAdjustments', patch);
      return textResult({ image_adjustments: state.adjustments });
    },
  );

  const unit = z.number().min(0).max(1);
  const annotationSchema = z.object({
    id: z.string().min(1).max(40).optional().describe('Give a mark an id to move or restyle it later; reusing an id replaces that mark'),
    type: z.enum(['circle', 'crosshair', 'rect', 'arrow', 'text']),
    x: unit.describe('0..1 across the oriented frame. circle/crosshair: centre; rect: left edge; arrow: tail; text: left edge'),
    y: unit.describe('0..1 down the frame (same meaning as x)'),
    radius: z.number().min(0.002).max(1).optional().describe('circle: radius as a fraction of the frame width (default 0.04)'),
    size: z.number().min(0.004).max(1).optional().describe('crosshair: half-length of each arm as a fraction of the frame width (default 0.03)'),
    width: unit.optional().describe('rect: width as a fraction of the frame width'),
    height: unit.optional().describe('rect: height as a fraction of the frame height'),
    to_x: unit.optional().describe('arrow: x of the point it points at'),
    to_y: unit.optional().describe('arrow: y of the point it points at'),
    text: z.string().min(1).max(200).optional().describe('text: the words to draw'),
    label: z.string().min(1).max(120).optional().describe('A caption drawn next to any non-text mark'),
    font_size: z.number().min(0.01).max(0.3).optional().describe('Text height as a fraction of the frame height (default 0.04)'),
    color: z.string().max(40).optional().describe('Any CSS colour: "#ff3b30", "red", "rgb(0 200 255)". Default red.'),
    thickness: z.number().min(0.5).max(30).optional().describe('Line width in thousandths of the frame width (default 3)'),
    fill: z.string().max(40).optional().describe('Fill for circle/rect, usually translucent: "rgba(255,0,0,0.2)"'),
    background: z.string().max(40).optional().describe('Colour behind text and labels (default translucent black); "none" for no backing'),
  });

  tool(
    'annotate',
    {
      title: 'Draw on the live view',
      description:
        'Draw marks over the live view: circles, crosshairs, rectangles, arrows and text, each with its own colour. Positions are normalised 0..1 in the oriented frame, the same coordinates as capture_snapshot regions, so you can look at a frame and then point at exactly what you saw. Marks stay on their feature when the view is zoomed or panned. Give a mark an id to update it later; reusing an id replaces that mark. Marks are cleared when the camera or orientation changes. Captures omit them unless include_annotations is true.',
      inputSchema: { annotations: z.array(annotationSchema).min(1).max(100) },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ annotations }) => {
      const upsert: AnnotationInput[] = annotations.map((a) => {
        const m: AnnotationInput = { type: a.type, x: a.x, y: a.y };
        if (a.id !== undefined) m.id = a.id;
        if (a.radius !== undefined) m.radius = a.radius;
        if (a.size !== undefined) m.size = a.size;
        if (a.width !== undefined) m.width = a.width;
        if (a.height !== undefined) m.height = a.height;
        if (a.to_x !== undefined) m.toX = a.to_x;
        if (a.to_y !== undefined) m.toY = a.to_y;
        if (a.text !== undefined) m.text = a.text;
        if (a.label !== undefined) m.label = a.label;
        if (a.font_size !== undefined) m.fontSize = a.font_size;
        if (a.color !== undefined) m.color = a.color;
        if (a.thickness !== undefined) m.thickness = a.thickness;
        if (a.fill !== undefined) m.fill = a.fill;
        if (a.background !== undefined) m.background = a.background;
        return m;
      });
      const state = await backend.call('setAnnotations', { upsert, author: client.name });
      return textResult({ annotations: state.annotations });
    },
  );

  tool(
    'clear_annotations',
    {
      title: 'Remove marks from the live view',
      description: 'Remove the marks with the given ids, or every mark when no ids are given.',
      inputSchema: { ids: z.array(z.string()).max(100).optional() },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids }) => {
      const state = await backend.call('setAnnotations', ids?.length ? { remove: ids } : { clear: true });
      return textResult({ annotations: state.annotations });
    },
  );

  tool(
    'capture_snapshot',
    {
      title: 'Capture a snapshot',
      description:
        "Grab one still frame from the microscope without interrupting the live view. Returns the image plus metrics (focus_score, brightness, exposure) and hints. Use region for a high-detail close-up, or follow_user_view to see what the human is zoomed in on.",
      inputSchema: captureShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = await backend.call('capture', toRequest(args, { maxWidth: 1280, format: 'jpeg' }));
      const path = await app.saveCapture(result, 'capture_snapshot');
      lastThumbnail = result.thumbnail;
      return {
        content: [
          { type: 'image', data: Buffer.from(result.data).toString('base64'), mimeType: result.mimeType },
          { type: 'text', text: JSON.stringify(describeCapture(result, path), null, 2) },
        ],
      };
    },
  );

  tool(
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
      const content: CallToolResult['content'] = [];
      const frames: unknown[] = [];
      const started = Date.now();
      for (let i = 0; i < count; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, interval_ms));
        const result = await backend.call('capture', toRequest(args, { maxWidth: 800, format: 'jpeg' }));
        const path = await app.saveCapture(result, 'capture_sequence');
        lastThumbnail = result.thumbnail;
        content.push({ type: 'image', data: Buffer.from(result.data).toString('base64'), mimeType: result.mimeType });
        frames.push(describeCapture(result, path, { index: i + 1, t_ms: Date.now() - started }));
      }
      content.push({ type: 'text', text: JSON.stringify({ frames }, null, 2) });
      return { content };
    },
  );

  tool(
    'save_photo',
    {
      title: 'Save a full-resolution photo',
      description:
        "Save a full-resolution photo (PNG by default) in the Pictures/Electroscope folder of the computer running Electroscope, and return its path. Nothing is returned inline; use capture_snapshot to look at the image.",
      inputSchema: frameShape,
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      const result = await backend.call('capture', toRequest({ ...args, max_width: 8192 }, { maxWidth: 8192, format: 'png' }));
      const path = await app.savePhoto(result);
      lastThumbnail = result.thumbnail;
      return textResult({
        saved_to: path,
        width: result.width,
        height: result.height,
        camera: result.camera.label,
        captured_at: result.capturedAt,
      });
    },
  );

  return server;
}
