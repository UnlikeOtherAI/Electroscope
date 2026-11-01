/** Types shared by the main process, the renderer and the MCP layer. */

export interface CameraInfo {
  id: string;
  label: string;
  active: boolean;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface Orientation {
  rotation: Rotation;
  mirror: boolean;
}

/** A normalised rectangle (0..1) in the coordinates of the oriented camera frame. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControlRange {
  min: number;
  max: number;
  step: number;
}

export interface CameraControl {
  name: string;
  value: number | string | boolean | null;
  range?: ControlRange;
  options?: string[];
  /** False once the camera has been seen to ignore changes to this control. */
  responsive?: boolean;
}

/**
 * Electroscope's own picture adjustments, applied to the live view and to every capture.
 * These are not camera settings: they work on any camera on any platform, which matters
 * because macOS exposes almost no real UVC controls (see docs/camera-controls.md).
 * 1 is "as the camera sent it".
 */
export interface ImageAdjustments {
  brightness: number;
  contrast: number;
  saturation: number;
}

export const NEUTRAL_ADJUSTMENTS: ImageAdjustments = { brightness: 1, contrast: 1, saturation: 1 };

export const ADJUSTMENT_RANGE = { min: 0.25, max: 2.5, step: 0.05 } as const;

export function isNeutral(a: ImageAdjustments): boolean {
  return a.brightness === 1 && a.contrast === 1 && a.saturation === 1;
}

/** A CSS/canvas filter string, or '' when nothing needs doing. */
export function adjustmentFilter(a: ImageAdjustments): string {
  if (isNeutral(a)) return '';
  return `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})`;
}

export type AnnotationType = 'circle' | 'crosshair' | 'rect' | 'arrow' | 'text';

/**
 * A mark drawn over the live view by an agent. Positions are normalised 0..1 in the oriented frame
 * (the same coordinates as capture regions). Sizes are fractions of the frame width unless noted,
 * so a mark stays on its feature when the human zooms.
 */
export interface Annotation {
  id: string;
  type: AnnotationType;
  x: number;
  y: number;
  /** circle: radius, fraction of frame width. */
  radius?: number;
  /** crosshair: half-length of each arm, fraction of frame width. */
  size?: number;
  /** rect: width and height, fractions of the frame. */
  width?: number;
  height?: number;
  /** arrow: the point the arrow ends on (x,y is the tail). */
  toX?: number;
  toY?: number;
  text?: string;
  /** Text size, fraction of frame height. */
  fontSize?: number;
  /** Any CSS colour. */
  color: string;
  /** Line width in thousandths of the frame width. */
  thickness: number;
  fill?: string;
  /** A caption drawn next to circles, crosshairs, rectangles and arrows. */
  label?: string;
  /** Colour behind text; 'none' for no backing. */
  background?: string;
  /** Who put it there: "You", or the agent's own name. */
  author?: string;
}

export type AnnotationInput = Partial<Omit<Annotation, 'type'>> & Pick<Annotation, 'type' | 'x' | 'y'>;

/** What the human sees in the window: zoom, pan and overlays. */
export interface ViewState {
  /** 1 = whole frame. */
  zoom: number;
  /** Centre of the visible area, 0..1 in the oriented frame. */
  centerX: number;
  centerY: number;
  grid: boolean;
  crosshair: boolean;
  gridColor: string;
  crosshairColor: string;
  /** The on-screen view is paused. Captures still read the live camera. */
  frozen: boolean;
}

export interface CameraState {
  active: CameraInfo | null;
  cameras: CameraInfo[];
  width: number;
  height: number;
  fps: number;
  orientation: Orientation;
  focusScore: number | null;
  controls: CameraControl[];
  /** Why there are no controls, when there are none. Empty when some exist. */
  controlsNote: string;
  maxResolution: { width: number; height: number } | null;
  adjustments: ImageAdjustments;
  view: ViewState;
  annotations: Annotation[];
}

export interface CaptureRequest {
  cameraId?: string;
  maxWidth: number;
  format: 'jpeg' | 'png';
  quality: number;
  region?: Region;
  followUserView?: boolean;
  /** Draw the agent's annotations onto the image. */
  annotated?: boolean;
  /** Also return a small preview, for the activity list in the window. */
  thumbnail?: boolean;
}

export interface FrameMetrics {
  /** Variance of the Laplacian on a downscaled grey image. Higher is sharper; only comparable within one scene. */
  focusScore: number;
  /** Mean luma, 0..255. */
  brightness: number;
  /** Share of pixels clipped to white (>=250), 0..1. */
  overexposed: number;
  /** Share of pixels crushed to black (<=5), 0..1. */
  underexposed: number;
}

export interface CaptureResult {
  data: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  camera: CameraInfo;
  region: Region | null;
  orientation: Orientation;
  metrics: FrameMetrics;
  capturedAt: string;
  /** A small JPEG data URL, so the window can show what the agent just looked at. */
  thumbnail?: string;
}

export interface ClientInfo {
  id: string;
  name: string;
  version: string;
  connectedAt: string;
  lastSeen: string;
}

/** One thing an agent did, for the activity list in the window. */
export interface ActivityEvent {
  id: string;
  /** MCP session id of the agent, so entries can be grouped by who did them. */
  clientId: string;
  /** The agent's own name, e.g. "Claude Code". */
  client: string;
  tool: string;
  /** One plain-language line for the window. */
  summary: string;
  at: string;
  ok: boolean;
  /** Set when the tool produced a picture. */
  thumbnail?: string;
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface ServerInfo {
  running: boolean;
  port: number;
  /** Address the app is reachable on from other computers; falls back to loopback. */
  url: string;
  /** Every non-virtual IPv4 address of this computer, best first. */
  addresses: string[];
  hostname: string;
  /** Listening on the network, not just this computer. */
  network: boolean;
  error?: string;
}

export interface Settings {
  port: number;
  /** Let other computers on the network connect. */
  network: boolean;
  lastCameraId: string | null;
  orientations: Record<string, Orientation>;
  resolutions: Record<string, { width: number; height: number }>;
  adjustments: Record<string, ImageAdjustments>;
  theme: 'system' | 'dark' | 'light';
  /** Where the window was last time, so it opens where it was left. */
  window: WindowBounds | null;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 7821,
  network: true,
  lastCameraId: null,
  orientations: {},
  resolutions: {},
  adjustments: {},
  theme: 'system',
  window: null,
};

/** Commands the main process (MCP) sends to the renderer, which owns the camera. */
export interface RendererCommands {
  getState(): CameraState;
  selectCamera(args: { cameraId: string; width?: number; height?: number }): CameraState;
  setControls(args: { controls: Record<string, number | string | boolean> }): {
    applied: Record<string, unknown>;
    rejected: Record<string, string>;
    state: CameraState;
  };
  setOrientation(args: Partial<Orientation>): CameraState;
  setView(args: Partial<ViewState>): CameraState;
  setAdjustments(args: Partial<ImageAdjustments>): CameraState;
  /** Add or replace marks (by id), remove some, or clear all. */
  setAnnotations(args: { upsert?: AnnotationInput[]; remove?: string[]; clear?: boolean; author?: string }): CameraState;
  capture(args: CaptureRequest): CaptureResult;
  refreshCameras(): CameraState;
}

export type RendererCommandName = keyof RendererCommands;
