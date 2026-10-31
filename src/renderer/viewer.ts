import type { Region } from '../shared/types.js';
import { orientedSize } from './frames.js';
import type { CameraSession } from './camera.js';

const MAX_ZOOM = 12;

/**
 * Shows the live video fitted to the stage, with wheel-zoom and drag-pan. The visible area is
 * always a normalised rectangle of the oriented frame, so "what the human sees" can be captured exactly.
 */
export class Viewer extends EventTarget {
  zoom = 1;
  cx = 0.5;
  cy = 0.5;
  private boxW = 0;
  private boxH = 0;

  constructor(
    private readonly stage: HTMLElement,
    private readonly frame: HTMLElement,
    private readonly zoomer: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly session: CameraSession,
  ) {
    super();
    new ResizeObserver(() => this.layout()).observe(stage);
    this.bindPointer();
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

  layout(): void {
    const { width, height } = this.session;
    if (!width || !height) {
      this.frame.hidden = true;
      return;
    }
    this.frame.hidden = false;
    const o = this.session.orientation;
    const { width: ow, height: oh } = orientedSize(width, height, o);
    const availW = this.stage.clientWidth;
    const availH = this.stage.clientHeight;
    const fit = Math.min(availW / ow, availH / oh);
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
    this.dispatchEvent(new Event('change'));
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
      drag = { x: e.clientX, y: e.clientY };
      frame.setPointerCapture(e.pointerId);
      frame.classList.add('dragging');
    });
    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.cx -= (e.clientX - drag.x) / (this.boxW * this.zoom);
      this.cy -= (e.clientY - drag.y) / (this.boxH * this.zoom);
      drag = { x: e.clientX, y: e.clientY };
      this.apply();
    });
    const end = () => {
      drag = null;
      frame.classList.remove('dragging');
    };
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);
    frame.addEventListener('dblclick', (e) => {
      if (this.zoom > 1.001) this.reset();
      else {
        const n = norm(e);
        this.zoomBy(3, n.x, n.y);
      }
    });
  }
}
