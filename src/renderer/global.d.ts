import type { ElectroscopeApi } from '../preload/index.js';

declare global {
  interface Window {
    electroscope: ElectroscopeApi;
  }

  // Chromium's ImageCapture is not in lib.dom.d.ts.
  class ImageCapture {
    constructor(track: MediaStreamTrack);
    grabFrame(): Promise<ImageBitmap>;
  }

  interface MediaTrackCapabilities {
    focusMode?: string[];
    focusDistance?: { min: number; max: number; step: number };
    exposureMode?: string[];
    exposureTime?: { min: number; max: number; step: number };
    whiteBalanceMode?: string[];
    colorTemperature?: { min: number; max: number; step: number };
    brightness?: { min: number; max: number; step: number };
    contrast?: { min: number; max: number; step: number };
    saturation?: { min: number; max: number; step: number };
    sharpness?: { min: number; max: number; step: number };
    zoom?: { min: number; max: number; step: number };
    torch?: boolean;
  }
}

export {};
