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
}

export interface CaptureRequest {
  cameraId?: string;
  maxWidth: number;
  format: 'jpeg' | 'png';
  quality: number;
  region?: Region;
  followUserView?: boolean;
  /** Where the capture came from, for the activity strip. */
  source: 'claude' | 'user';
  note?: string;
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
  thumbnail: string;
  capturedAt: string;
}

export interface ActivityEntry {
  id: string;
  at: string;
  source: 'claude' | 'user';
  tool: string;
  cameraLabel: string;
  width: number;
  height: number;
  bytes: number;
  path: string;
  thumbnail: string;
  note?: string;
  region: Region | null;
}

export interface SharedFrame extends ActivityEntry {
  note: string;
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
  url: string;
  error?: string;
  clients: ClientInfo[];
}

export interface Settings {
  port: number;
  claudeAccess: boolean;
  lastCameraId: string | null;
  orientations: Record<string, Orientation>;
  resolutions: Record<string, { width: number; height: number }>;
  theme: 'system' | 'dark' | 'light';
}

export const DEFAULT_SETTINGS: Settings = {
  port: 47821,
  claudeAccess: true,
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
  capture(args: CaptureRequest): CaptureResult;
  refreshCameras(): CameraState;
}

export type RendererCommandName = keyof RendererCommands;
