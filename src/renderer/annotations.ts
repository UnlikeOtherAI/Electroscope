import type { Annotation, AnnotationInput, Region } from '../shared/types.js';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const DEFAULT_COLOR = '#ff3b30';
const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';

/** Throws a message an agent can act on if the colour is not a valid CSS colour. */
export function checkColor(value: string, what: string): string {
  if (!CSS.supports('color', value)) {
    throw new Error(`${what}: "${value}" is not a CSS colour. Use a name ("red"), hex ("#ff3b30") or rgb()/hsl().`);
  }
  return value;
}

const unit = (n: unknown, what: string): number => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${what} must be a number from 0 to 1`);
  return n;
};

/** Validate an agent's mark, fill defaults, and give it an id. */
export function normalise(input: AnnotationInput, id: string): Annotation {
  const a: Annotation = {
    id,
    type: input.type,
    x: unit(input.x, `${input.type}.x`),
    y: unit(input.y, `${input.type}.y`),
    color: checkColor(input.color ?? DEFAULT_COLOR, `${id} color`),
    thickness: input.thickness ?? 3,
  };
  if (input.fill) a.fill = checkColor(input.fill, `${id} fill`);
  if (input.background && input.background !== 'none') a.background = checkColor(input.background, `${id} background`);
  else if (input.background === 'none') a.background = 'none';
  if (input.label) a.label = input.label;
  if (input.fontSize !== undefined) a.fontSize = input.fontSize;

  switch (input.type) {
    case 'circle':
      a.radius = input.radius ?? 0.04;
      break;
    case 'crosshair':
      a.size = input.size ?? 0.03;
      break;
    case 'rect':
      if (input.width === undefined || input.height === undefined) throw new Error(`${id}: a rect needs width and height`);
      a.width = unit(input.width, 'rect.width');
      a.height = unit(input.height, 'rect.height');
      break;
    case 'arrow':
      if (input.toX === undefined || input.toY === undefined) throw new Error(`${id}: an arrow needs to_x and to_y`);
      a.toX = unit(input.toX, 'arrow.to_x');
      a.toY = unit(input.toY, 'arrow.to_y');
      break;
    case 'text':
      if (!input.text) throw new Error(`${id}: text marks need text`);
      a.text = input.text;
      break;
    default:
      throw new Error(`Unknown annotation type "${String(input.type)}"`);
  }
  return a;
}

/**
 * Draw marks onto a canvas that shows `region` (normalised, oriented frame) at w x h pixels. The same
 * code draws the live overlay and the marks burned into a capture, so they always match.
 */
export function drawAnnotations(ctx: Ctx, list: readonly Annotation[], region: Region, w: number, h: number): void {
  if (list.length === 0) return;
  const fw = w / region.width; // pixels spanned by the whole frame width
  const fh = h / region.height;
  const px = (nx: number) => (nx - region.x) * fw;
  const py = (ny: number) => (ny - region.y) * fh;

  ctx.save();
  // The caller's canvas may still carry the transform it used to place the image.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const stroke = (color: string, width: number, path: () => void) => {
    ctx.beginPath();
    path();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; // halo so marks read on both bright and dark scenes
    ctx.lineWidth = width + Math.max(2, width * 0.8);
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };

  const label = (text: string, x: number, y: number, a: Annotation, fontPx: number) => {
    ctx.font = `600 ${fontPx}px ${FONT}`;
    ctx.textBaseline = 'top';
    const pad = fontPx * 0.3;
    const textW = ctx.measureText(text).width;
    if (a.background !== 'none') {
      ctx.fillStyle = a.background ?? 'rgba(0,0,0,0.6)';
      const r = fontPx * 0.25;
      const c = ctx as CanvasRenderingContext2D;
      c.beginPath();
      if (typeof c.roundRect === 'function') c.roundRect(x - pad, y - pad * 0.6, textW + pad * 2, fontPx + pad * 1.2, r);
      else c.rect(x - pad, y - pad * 0.6, textW + pad * 2, fontPx + pad * 1.2);
      c.fill();
    }
    ctx.fillStyle = a.color;
    ctx.fillText(text, x, y);
  };

  for (const a of list) {
    const lw = Math.max(1, (a.thickness / 1000) * fw);
    const fontPx = Math.max(8, (a.fontSize ?? 0.04) * fh);
    const x = px(a.x);
    const y = py(a.y);
    let anchor: [number, number] = [x, y];

    switch (a.type) {
      case 'circle': {
        const r = (a.radius ?? 0.04) * fw;
        if (a.fill) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = a.fill;
          ctx.fill();
        }
        stroke(a.color, lw, () => ctx.arc(x, y, r, 0, Math.PI * 2));
        anchor = [x + r * 0.72, y - r * 0.72 - fontPx * 1.3];
        break;
      }
      case 'crosshair': {
        const s = (a.size ?? 0.03) * fw;
        stroke(a.color, lw, () => {
          ctx.moveTo(x - s, y);
          ctx.lineTo(x + s, y);
          ctx.moveTo(x, y - s);
          ctx.lineTo(x, y + s);
        });
        anchor = [x + s * 0.3, y - s - fontPx * 1.3];
        break;
      }
      case 'rect': {
        const rw = (a.width ?? 0) * fw;
        const rh = (a.height ?? 0) * fh;
        if (a.fill) {
          ctx.fillStyle = a.fill;
          ctx.fillRect(x, y, rw, rh);
        }
        stroke(a.color, lw, () => ctx.rect(x, y, rw, rh));
        anchor = [x, y - fontPx * 1.4];
        break;
      }
      case 'arrow': {
        const tx = px(a.toX ?? a.x);
        const ty = py(a.toY ?? a.y);
        const ang = Math.atan2(ty - y, tx - x);
        const head = Math.max(lw * 5, fw * 0.015);
        stroke(a.color, lw, () => {
          ctx.moveTo(x, y);
          ctx.lineTo(tx, ty);
          ctx.moveTo(tx - head * Math.cos(ang - 0.5), ty - head * Math.sin(ang - 0.5));
          ctx.lineTo(tx, ty);
          ctx.lineTo(tx - head * Math.cos(ang + 0.5), ty - head * Math.sin(ang + 0.5));
        });
        anchor = [x, y - fontPx * 1.4];
        break;
      }
      case 'text':
        if (a.text) label(a.text, x, y, a, fontPx);
        continue;
    }
    if (a.label) label(a.label, anchor[0], anchor[1], a, fontPx);
  }
  ctx.restore();
}
