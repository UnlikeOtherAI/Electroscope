import type { Annotation, AnnotationInput, AnnotationType, Region, ViewState } from '../shared/types.js';
import { checkColor, drawAnnotations, normalise } from './annotations.js';
import type { CameraSession } from './camera.js';
import { orientedSize } from './frames.js';

const MAX_ZOOM = 12;
const DEFAULT_GRID = '#ffffff';
const DEFAULT_CROSS = '#ff5050';

/**
 * Shows the live video fitted to the stage, with wheel-zoom, drag-pan, overlays and agent marks. The
 * visible area is always a normalised rectangle of the oriented frame, so "what the human sees" can
 * be captured exactly and marks stay on their feature.
 */
interface Pt {
  x: number;
  y: number;
  px: number;
  py: number;
}

export class Viewer extends EventTarget {
  zoom = 1;
  cx = 0.5;
  cy = 0.5;
  grid = false;
  crosshair = false;
  gridColor = DEFAULT_GRID;
  crosshairColor = DEFAULT_CROSS;
  frozen = false;
  annotations: Annotation[] = [];
  /** The mark the human is drawing, if any tool is selected. */
  tool: AnnotationType | null = null;
  drawColor = '#ff3b30';
  /** Called when the text tool is clicked, so the app can ask what to write. */
  onTextRequest: ((x: number, y: number) => void) | null = null;
  private draft: { start: Pt; now: Pt } | null = null;

  private boxW = 0;
  private boxH = 0;
  private nextId = 1;
  private readonly canvas: HTMLCanvasElement;

  constructor(
    private readonly stage: HTMLElement,
    private readonly frame: HTMLElement,
    private readonly zoomer: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly session: CameraSession,
  ) {
    super();
    this.canvas = frame.querySelector('canvas')!;
    new ResizeObserver(() => this.layout()).observe(stage);
    this.bindPointer();
  }

  view(): ViewState {
    return {
      zoom: this.zoom,
      centerX: this.cx,
      centerY: this.cy,
      grid: this.grid,
      crosshair: this.crosshair,
      gridColor: this.gridColor,
      crosshairColor: this.crosshairColor,
      frozen: this.frozen,
    };
  }

  patchView(p: Partial<ViewState>): void {
    if (p.gridColor !== undefined) this.gridColor = checkColor(p.gridColor, 'grid_color');
    if (p.crosshairColor !== undefined) this.crosshairColor = checkColor(p.crosshairColor, 'crosshair_color');
    if (p.grid !== undefined) this.grid = p.grid;
    if (p.crosshair !== undefined) this.crosshair = p.crosshair;
    if (p.frozen !== undefined && p.frozen !== this.frozen) {
      this.frozen = p.frozen;
      if (this.frozen) this.video.pause();
      else void this.video.play();
    }
    if (p.zoom !== undefined) this.zoom = Math.min(MAX_ZOOM, Math.max(1, p.zoom));
    if (p.centerX !== undefined) this.cx = p.centerX;
    if (p.centerY !== undefined) this.cy = p.centerY;
    this.apply();
  }

  visibleRegion(): Region {
    const w = 1 / this.zoom;
    return { x: this.cx - w / 2, y: this.cy - w / 2, width: w, height: w };
  }

  reset(): void {
    this.zoom = 1;
    this.cx = this.cy = 0.5;
    this.apply();
  }

  zoomBy(factor: number, nx = 0.5, ny = 0.5): void {
    const z2 = Math.min(MAX_ZOOM, Math.max(1, this.zoom * factor));
    const ox = this.cx + (nx - 0.5) / this.zoom;
    const oy = this.cy + (ny - 0.5) / this.zoom;
    this.zoom = z2;
    this.cx = ox - (nx - 0.5) / z2;
    this.cy = oy - (ny - 0.5) / z2;
    this.apply();
  }

  setTool(tool: AnnotationType | null): void {
    this.tool = this.tool === tool ? null : tool;
    this.draft = null;
    this.frame.classList.toggle('drawing', this.tool !== null);
    this.drawMarks();
    this.dispatchEvent(new Event('change'));
  }

  /** Remove the most recently added mark. */
  undo(): void {
    const last = this.annotations.at(-1);
    if (last) this.removeAnnotations([last.id]);
  }

  upsertAnnotations(inputs: AnnotationInput[], author = 'You'): void {
    // Validate everything first so a bad mark does not leave the others half-applied.
    const made = inputs.map((i) => ({ ...normalise(i, i.id ?? `m${this.nextId++}`), author }));
    for (const m of made) {
      const at = this.annotations.findIndex((a) => a.id === m.id);
      if (at >= 0) this.annotations[at] = m;
      else this.annotations.push(m);
    }
    this.drawMarks();
    this.dispatchEvent(new Event('change'));
  }

  removeAnnotations(ids: string[]): void {
    this.annotations = this.annotations.filter((a) => !ids.includes(a.id));
    this.drawMarks();
    this.dispatchEvent(new Event('change'));
  }

  clearAnnotations(): void {
    if (this.annotations.length === 0) return;
    this.annotations = [];
    this.drawMarks();
    this.dispatchEvent(new Event('change'));
  }

  layout(): void {
    const { width, height } = this.session;
    if (!width || !height) {
      this.frame.hidden = true;
      return;
    }
    this.frame.hidden = false;
    const o = this.session.orientation;
    const { width: ow, height: oh } = orientedSize(width, height, o);
    const fit = Math.min(this.stage.clientWidth / ow, this.stage.clientHeight / oh);
    this.boxW = Math.max(1, Math.floor(ow * fit));
    this.boxH = Math.max(1, Math.floor(oh * fit));
    this.frame.style.width = `${this.boxW}px`;
    this.frame.style.height = `${this.boxH}px`;

    const odd = o.rotation === 90 || o.rotation === 270;
    const vw = odd ? this.boxH : this.boxW;
    const vh = odd ? this.boxW : this.boxH;
    this.video.style.width = `${vw}px`;
    this.video.style.height = `${vh}px`;
    this.video.style.left = `${(this.boxW - vw) / 2}px`;
    this.video.style.top = `${(this.boxH - vh) / 2}px`;
    this.video.style.transform = `rotate(${o.rotation}deg) scaleX(${o.mirror ? -1 : 1})`;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.boxW * dpr);
    this.canvas.height = Math.round(this.boxH * dpr);
    this.apply();
  }

  private apply(): void {
    const half = 0.5 / this.zoom;
    this.cx = Math.min(1 - half, Math.max(half, this.cx));
    this.cy = Math.min(1 - half, Math.max(half, this.cy));
    const tx = (0.5 - this.cx) * this.boxW * this.zoom;
    const ty = (0.5 - this.cy) * this.boxH * this.zoom;
    this.zoomer.style.transform = `translate(${tx}px, ${ty}px) scale(${this.zoom})`;
    this.frame.classList.toggle('zoomed', this.zoom > 1.001);
    this.frame.style.setProperty('--grid-color', this.gridColor);
    this.frame.style.setProperty('--cross-color', this.crosshairColor);
    this.frame.querySelector<HTMLElement>('.overlay-grid')!.hidden = !this.grid;
    this.frame.querySelector<HTMLElement>('.overlay-cross')!.hidden = !this.crosshair;
    this.drawMarks();
    this.dispatchEvent(new Event('change'));
  }

  private drawMarks(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const list = [...this.annotations];
    const draft = this.markFromDraft(false);
    if (draft) {
      try {
        list.push(normalise(draft, '_draft'));
      } catch {
        /* nothing to preview yet */
      }
    }
    drawAnnotations(ctx, list, this.visibleRegion(), this.canvas.width, this.canvas.height);
  }

  private point(e: PointerEvent): Pt {
    const r = this.frame.getBoundingClientRect();
    const reg = this.visibleRegion();
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return {
      x: clamp(reg.x + ((e.clientX - r.left) / r.width) * reg.width),
      y: clamp(reg.y + ((e.clientY - r.top) / r.height) * reg.height),
      px: e.clientX,
      py: e.clientY,
    };
  }

  /** The mark for the drag so far; a plain click on circle/crosshair gives a sensible default size. */
  private markFromDraft(final: boolean): AnnotationInput | null {
    const d = this.draft;
    if (!d || !this.tool) return null;
    const dist = Math.hypot(d.now.px - d.start.px, d.now.py - d.start.py);
    const perWidth = this.boxW * this.zoom; // screen pixels in one frame width
    const style = { color: this.drawColor, thickness: 3 };
    const dragged = dist > 4;
    switch (this.tool) {
      case 'circle':
        if (!dragged && !final) return null;
        return { type: 'circle', x: d.start.x, y: d.start.y, radius: dragged ? Math.max(0.004, dist / perWidth) : 0.04, ...style };
      case 'crosshair':
        return { type: 'crosshair', x: d.start.x, y: d.start.y, size: dragged ? Math.max(0.006, dist / perWidth) : 0.03, ...style };
      case 'rect': {
        const width = Math.abs(d.now.x - d.start.x);
        const height = Math.abs(d.now.y - d.start.y);
        if (width < 0.003 || height < 0.003) return null;
        return { type: 'rect', x: Math.min(d.start.x, d.now.x), y: Math.min(d.start.y, d.now.y), width, height, ...style };
      }
      case 'arrow':
        if (!dragged) return null;
        return { type: 'arrow', x: d.start.x, y: d.start.y, toX: d.now.x, toY: d.now.y, ...style };
      default:
        return null;
    }
  }

  private bindPointer(): void {
    const frame = this.frame;
    const norm = (e: MouseEvent) => {
      const r = frame.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    frame.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const n = norm(e);
        this.zoomBy(Math.exp(-e.deltaY * 0.0018), n.x, n.y);
      },
      { passive: false },
    );
    let drag: { x: number; y: number } | null = null;
    frame.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.tool) {
        const p = this.point(e);
        if (this.tool === 'text') {
          this.onTextRequest?.(p.x, p.y);
          return;
        }
        this.draft = { start: p, now: p };
        frame.setPointerCapture(e.pointerId);
        this.drawMarks();
        return;
      }
      drag = { x: e.clientX, y: e.clientY };
      frame.setPointerCapture(e.pointerId);
      frame.classList.add('dragging');
    });
    frame.addEventListener('pointermove', (e) => {
      if (this.draft) {
        this.draft.now = this.point(e);
        this.drawMarks();
        return;
      }
      if (!drag) return;
      this.cx -= (e.clientX - drag.x) / (this.boxW * this.zoom);
      this.cy -= (e.clientY - drag.y) / (this.boxH * this.zoom);
      drag = { x: e.clientX, y: e.clientY };
      this.apply();
    });
    const end = () => {
      if (this.draft) {
        const mark = this.markFromDraft(true);
        this.draft = null;
        if (mark) this.upsertAnnotations([mark]);
        else this.drawMarks();
      }
      drag = null;
      frame.classList.remove('dragging');
    };
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);
    frame.addEventListener('dblclick', (e) => {
      if (this.tool) return;
      if (this.zoom > 1.001) this.reset();
      else {
        const n = norm(e);
        this.zoomBy(3, n.x, n.y);
      }
    });
  }
}
