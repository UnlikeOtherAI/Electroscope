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
  maxResolution: { width: number; height: number } | null;
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
}

export interface ClientInfo {
  id: string;
  name: string;
  version: string;
  connectedAt: string;
  lastSeen: string;
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
  theme: 'system' | 'dark' | 'light';
}

export const DEFAULT_SETTINGS: Settings = {
  port: 7821,
  network: true,
  lastCameraId: null,
  orientations: {},
  resolutions: {},
  theme: 'system',
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
  /** Add or replace marks (by id), remove some, or clear all. */
  setAnnotations(args: { upsert?: AnnotationInput[]; remove?: string[]; clear?: boolean }): CameraState;
  capture(args: CaptureRequest): CaptureResult;
  refreshCameras(): CameraState;
}

export type RendererCommandName = keyof RendererCommands;
