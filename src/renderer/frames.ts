import type { FrameMetrics, ImageAdjustments, Orientation, Region } from '../shared/types.js';
import { adjustmentFilter } from '../shared/types.js';

/** Size of a frame after rotation. */
export function orientedSize(w: number, h: number, o: Orientation): { width: number; height: number } {
  return o.rotation === 90 || o.rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

export function clampRegion(r: Region): Region {
  const x = Math.min(Math.max(r.x, 0), 0.98);
  const y = Math.min(Math.max(r.y, 0), 0.98);
  return {
    x,
    y,
    width: Math.min(Math.max(r.width, 0.02), 1 - x),
    height: Math.min(Math.max(r.height, 0.02), 1 - y),
  };
}

export interface RenderedFrame {
  canvas: OffscreenCanvas;
  region: Region;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Draw `src` into a new canvas: mirrored/rotated, cropped to `region` (normalised, in oriented
 * coordinates) and scaled so the longest edge is at most `maxLongEdge`. One draw call straight
 * from the source pixels, so a crop keeps the camera's full resolution.
 */
export function renderFrame(
  src: CanvasImageSource,
  sw: number,
  sh: number,
  o: Orientation,
  region: Region | null,
  maxLongEdge: number,
): RenderedFrame {
  const { width: ow, height: oh } = orientedSize(sw, sh, o);
  const reg = clampRegion(region ?? { x: 0, y: 0, width: 1, height: 1 });
  const rx = Math.round(reg.x * ow);
  const ry = Math.round(reg.y * oh);
  const rw = Math.max(1, Math.min(ow - rx, Math.round(reg.width * ow)));
  const rh = Math.max(1, Math.min(oh - ry, Math.round(reg.height * oh)));
  const scale = Math.min(1, maxLongEdge / Math.max(rw, rh));
  const outW = Math.max(1, Math.round(rw * scale));
  const outH = Math.max(1, Math.round(rh * scale));

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(outW / rw, outH / rh);
  ctx.translate(-rx, -ry);
  ctx.translate(ow / 2, oh / 2);
  ctx.rotate((o.rotation * Math.PI) / 180);
  ctx.scale(o.mirror ? -1 : 1, 1);
  ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);

  return {
    canvas,
    region: { x: rx / ow, y: ry / oh, width: rw / ow, height: rh / oh },
    sourceWidth: sw,
    sourceHeight: sh,
  };
}

/**
 * Apply Electroscope's own picture adjustments in place. Done after the metrics are measured, so
 * focus_score and brightness still describe what the sensor delivered rather than our processing.
 */
export function applyAdjustments(canvas: OffscreenCanvas, adjustments: ImageAdjustments): OffscreenCanvas {
  const filter = adjustmentFilter(adjustments);
  if (!filter) return canvas;
  const out = new OffscreenCanvas(canvas.width, canvas.height);
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.filter = filter;
  ctx.drawImage(canvas, 0, 0);
  return out;
}

const ANALYSIS_LONG_EDGE = 640;
let analysisCanvas: OffscreenCanvas | null = null;

/**
 * Focus (variance of the Laplacian), brightness and clipping on a normalised copy of the frame,
 * so scores are comparable between live view and captures of the same scene.
 */
export function computeMetrics(src: CanvasImageSource, sw: number, sh: number): FrameMetrics {
  const scale = Math.min(1, ANALYSIS_LONG_EDGE / Math.max(sw, sh));
  const w = Math.max(3, Math.round(sw * scale));
  const h = Math.max(3, Math.round(sh * scale));
  if (!analysisCanvas || analysisCanvas.width !== w || analysisCanvas.height !== h) {
    analysisCanvas = new OffscreenCanvas(w, h);
  }
  const ctx = analysisCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(src, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const grey = new Float32Array(w * h);
  let sum = 0;
  let hot = 0;
  let dark = 0;
  for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
    const y = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
    grey[i] = y;
    sum += y;
    if (y >= 250) hot++;
    else if (y <= 5) dark++;
  }

  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = grey[i - 1]! + grey[i + 1]! + grey[i - w]! + grey[i + w]! - 4 * grey[i]!;
      lapSum += l;
      lapSq += l * l;
      n++;
    }
  }
  const mean = lapSum / n;
  return {
    focusScore: lapSq / n - mean * mean,
    brightness: sum / grey.length,
    overexposed: hot / grey.length,
    underexposed: dark / grey.length,
  };
}

export async function encode(canvas: OffscreenCanvas, format: 'jpeg' | 'png', quality: number): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({
    type: format === 'png' ? 'image/png' : 'image/jpeg',
    ...(format === 'jpeg' ? { quality } : {}),
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function thumbnailDataUrl(canvas: OffscreenCanvas, longEdge = 240): Promise<string> {
  const scale = Math.min(1, longEdge / Math.max(canvas.width, canvas.height));
  const t = new OffscreenCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)));
  const ctx = t.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  const blob = await t.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}
