import type { CameraControl, Orientation, RendererCommandName, ServerInfo, Settings } from '../shared/types.js';
import { buildAgentPrompt } from '../shared/prompt.js';
import { CameraSession } from './camera.js';
import { captureFrame, createCommands, type CommandContext } from './commands.js';
import { icons } from './icons.js';
import { Viewer } from './viewer.js';

const api = window.electroscope;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) el.className = String(cls);
  Object.assign(el, rest);
  el.append(...children);
  return el;
}

const PRESETS = [
  [3840, 2160],
  [2592, 1944],
  [2560, 1440],
  [1920, 1080],
  [1600, 1200],
  [1280, 720],
  [1024, 768],
  [800, 600],
  [640, 480],
] as const;

let settings: Settings;
let serverInfo: ServerInfo = { running: false, port: 0, url: '', addresses: [], hostname: '', network: true };
let controlsSignature = '';

const video = $<HTMLVideoElement>('video');
const session = new CameraSession(video);
const viewer = new Viewer($('stage'), $('frame'), $('zoomer'), video, session);

// ---------- helpers ----------
function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4200): void {
  const el = h('div', { class: `toast ${kind}`, textContent: message });
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function humanize(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`${what} copied`);
}

// ---------- what agents' tool calls land on ----------
const ctx: CommandContext = {
  session,
  viewer,
  async setOrientation(cameraId: string, o: Orientation) {
    const orientations = { ...settings.orientations, [cameraId]: o };
    settings = await api.patchSettings({ orientations });
    session.orientations = settings.orientations;
    // Marks and the zoom window are positioned in the oriented frame, so they no longer line up.
    viewer.clearAnnotations();
    viewer.reset();
    viewer.layout();
    session.changed();
  },
  async rememberCamera(cameraId, size) {
    const patch: Partial<Settings> = { lastCameraId: cameraId };
    if (size) patch.resolutions = { ...settings.resolutions, [cameraId]: size };
    settings = await api.patchSettings(patch);
    viewer.reset();
  },
};
const commands = createCommands(ctx);

api.onCommand(async ({ id, name, args }) => {
  try {
    const fn = commands[name as RendererCommandName] as (a: unknown) => Promise<unknown>;
    if (!fn) throw new Error(`Unknown command ${name}`);
    api.sendCommandResult({ id, ok: true, value: await fn(args) });
  } catch (e) {
    api.sendCommandResult({ id, ok: false, error: (e as Error).message });
  }
});

// ---------- rendering ----------
function renderCameras(): void {
  const list = $('camera-list');
  list.replaceChildren();
  if (session.cameras.length === 0) {
    list.append(h('li', { class: 'list-empty', textContent: 'No cameras detected.' }));
    return;
  }
  for (const cam of session.cameras) {
    const active = cam.id === session.activeId;
    const btn = h('button', { class: `camera-item${active ? ' active' : ''}`, type: 'button' });
    btn.append(
      h('span', { class: 'ico', innerHTML: icons.camera }),
      h(
        'span',
        { class: 'meta' },
        h('div', { class: 'name', textContent: cam.label, title: cam.label }),
        h('div', { class: 'sub', textContent: active ? `${session.width}×${session.height}` : 'Click to switch' }),
      ),
    );
    if (active) btn.append(h('span', { class: 'live-dot', title: 'Live' }));
    btn.addEventListener('click', () => {
      if (!active) void switchCamera(cam.id);
    });
    list.append(h('li', {}, btn));
  }
}

async function switchCamera(id: string): Promise<void> {
  try {
    await session.open(id, settings.resolutions[id]);
    settings = await api.patchSettings({ lastCameraId: id });
    viewer.clearAnnotations();
    viewer.reset();
    viewer.layout();
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

function renderHud(): void {
  $('hud-cam').textContent = session.activeCamera?.label ?? '—';
  $('hud-res').textContent = session.width ? `${session.width}×${session.height}` : '—';
  $('hud-fps').textContent = viewer.frozen ? 'Frozen' : session.fps ? `${session.fps} fps` : '—';
  const zoom = $('hud-zoom');
  zoom.hidden = viewer.zoom <= 1.001;
  zoom.textContent = `${Math.round(viewer.zoom * 100)}%`;
  $('tb-zoom-reset').textContent = `${Math.round(viewer.zoom * 100)}%`;
}

let focusPeak = 1;
function renderFocus(): void {
  const score = session.focusScore;
  if (score === null) {
    $('focus-val').textContent = '—';
    return;
  }
  focusPeak = Math.max(score, focusPeak * 0.995);
  ($('focus-bar') as HTMLElement).style.width = `${(Math.min(1, score / Math.max(focusPeak, 1)) * 100).toFixed(0)}%`;
  $('focus-val').textContent = score >= 100 ? Math.round(score).toString() : score.toFixed(1);
}

function renderStageState(): void {
  const has = session.activeId !== null && session.width > 0;
  $('frame').hidden = !has;
  $('empty').hidden = has;
  if (!has) {
    const noCam = session.cameras.length === 0;
    $('empty-art').innerHTML = icons.camera;
    $('empty-title').textContent = noCam ? 'No camera found' : 'Camera unavailable';
    $('empty-text').textContent =
      session.error ?? (noCam ? 'Plug in your microscope and it will appear here.' : 'Pick a camera from the list.');
  } else {
    viewer.layout();
  }
}

function renderResolution(): void {
  const sel = $<HTMLSelectElement>('resolution');
  const max = session.maxResolution;
  const options = PRESETS.filter(([w, hgt]) => !max || (w <= max.width && hgt <= max.height));
  const current = `${session.width}x${session.height}`;
  const sig = `${current}|${options.map((o) => o.join('x')).join(',')}|${session.activeId}`;
  if (sel.dataset['sig'] === sig) return;
  sel.dataset['sig'] = sig;
  sel.replaceChildren();
  const seen = new Set<string>();
  const add = (w: number, hgt: number) => {
    const v = `${w}x${hgt}`;
    if (seen.has(v)) return;
    seen.add(v);
    sel.append(h('option', { value: v, textContent: `${w} × ${hgt}` }));
  };
  if (session.width) add(session.width, session.height);
  for (const [w, hgt] of options) add(w, hgt);
  sel.value = current;
  sel.disabled = !session.activeId;
}

/** Only controls the camera has been seen to obey are shown; the rest would be fake sliders. */
function renderControls(): void {
  const working = session.controls.filter((c) => c.responsive !== false);
  $('controls-card').hidden = working.length === 0;
  const box = $('controls');
  const sig = JSON.stringify(working.map((c) => [c.name, c.range, c.options])) + session.activeId;
  if (sig !== controlsSignature) {
    controlsSignature = sig;
    box.replaceChildren(...working.map(controlRow));
  }
  syncControlValues(working);
}

function controlRow(c: CameraControl): HTMLElement {
  const row = h('div', { class: 'control' });
  row.dataset['name'] = c.name;
  const value = h('span', { class: 'v' });
  row.append(h('div', { class: 'head' }, h('span', { textContent: humanize(c.name) }), value));
  if (c.range) {
    const input = h('input', { type: 'range' });
    input.min = String(c.range.min);
    input.max = String(c.range.max);
    input.step = String(c.range.step);
    input.value = String(c.value ?? c.range.min);
    input.setAttribute('aria-label', humanize(c.name));
    let timer: number | undefined;
    input.addEventListener('input', () => {
      value.textContent = input.value;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void session.applyControls({ [c.name]: Number(input.value) }).then((r) => {
          const why = r.rejected[c.name];
          if (why) toast(`${humanize(c.name)}: ${why}`, 'error');
        });
      }, 60);
    });
    row.append(input);
  } else if (c.options) {
    const seg = h('div', { class: 'mode-seg' });
    for (const o of c.options) {
      const b = h('button', { type: 'button', textContent: o });
      b.dataset['value'] = o;
      b.addEventListener('click', () => void session.applyControls({ [c.name]: o }));
      seg.append(b);
    }
    row.append(seg);
  } else {
    const b = h('button', { class: 'chip-btn toggle-control', type: 'button', textContent: 'Off' });
    b.addEventListener('click', () => void session.applyControls({ [c.name]: b.getAttribute('aria-pressed') !== 'true' }));
    row.append(b);
  }
  return row;
}

function syncControlValues(working: CameraControl[]): void {
  for (const c of working) {
    const row = $('controls').querySelector<HTMLElement>(`[data-name="${c.name}"]`);
    if (!row) continue;
    const input = row.querySelector<HTMLInputElement>('input[type=range]');
    if (input) {
      if (document.activeElement !== input && c.value !== null) input.value = String(c.value);
      const v = row.querySelector<HTMLElement>('.v');
      if (v) v.textContent = c.value === null ? '' : String(Math.round(Number(c.value) * 100) / 100);
    }
    row.querySelectorAll<HTMLButtonElement>('.mode-seg button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset['value'] === c.value));
    });
    const t = row.querySelector<HTMLButtonElement>('.toggle-control');
    if (t) {
      t.setAttribute('aria-pressed', String(Boolean(c.value)));
      t.textContent = c.value ? 'On' : 'Off';
    }
  }
}

function renderToolbar(): void {
  $('tb-grid').setAttribute('aria-pressed', String(viewer.grid));
  $('tb-cross').setAttribute('aria-pressed', String(viewer.crosshair));
  $('tb-freeze').setAttribute('aria-pressed', String(viewer.frozen));
  $<HTMLButtonElement>('tb-clear-all').disabled = viewer.annotations.length === 0;
  for (const t of ['circle', 'crosshair', 'rect', 'arrow', 'text'] as const) {
    $(`tool-${t}`).setAttribute('aria-pressed', String(viewer.tool === t));
  }
  $('mirror').setAttribute('aria-pressed', String(session.orientation.mirror));
}

function renderServer(): void {
  const address = $('address');
  const prompt = $<HTMLButtonElement>('copy-prompt');
  address.classList.toggle('error', !serverInfo.running && serverInfo.port > 0);
  if (serverInfo.running) {
    address.textContent = serverInfo.network ? serverInfo.url : `${serverInfo.url} (this computer only)`;
    address.title = 'MCP endpoint';
  } else if (serverInfo.error) {
    address.textContent = 'Server not running';
    address.title = serverInfo.error;
  } else {
    address.textContent = 'starting…';
  }
  prompt.disabled = !serverInfo.running;
}

function renderAll(): void {
  renderCameras();
  renderStageState();
  renderHud();
  renderResolution();
  renderControls();
  renderToolbar();
  renderServer();
}

// ---------- wiring ----------
function wireStatic(): void {
  $('logo').innerHTML = icons.logo;
  $('open-settings').innerHTML = icons.settings;
  $('refresh').innerHTML = icons.refresh;
  $('copy-prompt').innerHTML = `${icons.copy}<span>Copy prompt for agent</span>`;
  $('tb-zoom-out').innerHTML = icons.zoomOut;
  $('tb-zoom-in').innerHTML = icons.zoomIn;
  $('tb-grid').innerHTML = icons.grid;
  $('tb-cross').innerHTML = icons.crosshair;
  $('tb-freeze').innerHTML = icons.freeze;
  $('tb-save').innerHTML = `${icons.save}<span>Save photo</span>`;
  $('tool-circle').innerHTML = icons.circle;
  $('tool-crosshair').innerHTML = icons.plus;
  $('tool-rect').innerHTML = icons.rect;
  $('tool-arrow').innerHTML = icons.arrow;
  $('tool-text').innerHTML = icons.text;
  $('rot-ccw').innerHTML = icons.rotateCcw;
  $('rot-cw').innerHTML = icons.rotateCw;
  $('mirror').innerHTML = icons.flip;

  $('copy-prompt').addEventListener('click', () => void copy(buildAgentPrompt(serverInfo), 'Prompt'));
  $('refresh').addEventListener('click', () => void session.refresh());
  $('open-settings').addEventListener('click', () => {
    $<HTMLInputElement>('set-port').value = String(settings.port);
    $<HTMLInputElement>('set-network').checked = settings.network;
    $<HTMLSelectElement>('set-theme').value = settings.theme;
    $<HTMLDialogElement>('settings').showModal();
  });
  $('settings-form').addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'ok') return;
    const port = Number($<HTMLInputElement>('set-port').value);
    const patch: Partial<Settings> = {
      theme: $<HTMLSelectElement>('set-theme').value as Settings['theme'],
      network: $<HTMLInputElement>('set-network').checked,
    };
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) patch.port = port;
    void api.patchSettings(patch).then((s) => {
      settings = s;
    });
  });

  $('tb-zoom-in').addEventListener('click', () => viewer.zoomBy(1.5));
  $('tb-zoom-out').addEventListener('click', () => viewer.zoomBy(1 / 1.5));
  $('tb-zoom-reset').addEventListener('click', () => viewer.reset());
  $('tb-grid').addEventListener('click', () => viewer.patchView({ grid: !viewer.grid }));
  $('tb-cross').addEventListener('click', () => viewer.patchView({ crosshair: !viewer.crosshair }));
  const toggleFreeze = () => viewer.patchView({ frozen: !viewer.frozen });
  $('tb-freeze').addEventListener('click', toggleFreeze);
  $('tb-clear-all').addEventListener('click', () => viewer.clearAnnotations());
  for (const t of ['circle', 'crosshair', 'rect', 'arrow', 'text'] as const) {
    $(`tool-${t}`).addEventListener('click', () => viewer.setTool(t));
  }
  $<HTMLInputElement>('draw-color').addEventListener('input', (e) => {
    viewer.drawColor = (e.target as HTMLInputElement).value;
  });
  viewer.onTextRequest = (x, y) => {
    const dialog = $<HTMLDialogElement>('text-dialog');
    const input = $<HTMLInputElement>('text-input');
    input.value = '';
    dialog.returnValue = '';
    dialog.onclose = () => {
      const text = input.value.trim();
      if (dialog.returnValue === 'ok' && text) {
        viewer.upsertAnnotations([{ type: 'text', x, y, text, color: viewer.drawColor, thickness: 3, fontSize: 0.04 }]);
      }
    };
    dialog.showModal();
    input.focus();
  };
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      viewer.undo();
    } else if (e.key === 'Escape' && viewer.tool) viewer.setTool(viewer.tool);
    else if (e.key === ' ') {
      e.preventDefault();
      toggleFreeze();
    } else if (e.key === '+' || e.key === '=') viewer.zoomBy(1.4);
    else if (e.key === '-') viewer.zoomBy(1 / 1.4);
    else if (e.key === '0') viewer.reset();
  });

  const rotate = (delta: number) => {
    const id = session.activeId;
    if (!id) return;
    const rotation = ((session.orientation.rotation + delta + 360) % 360) as Orientation['rotation'];
    void ctx.setOrientation(id, { ...session.orientation, rotation });
  };
  $('rot-cw').addEventListener('click', () => rotate(90));
  $('rot-ccw').addEventListener('click', () => rotate(-90));
  $('mirror').addEventListener('click', () => {
    const id = session.activeId;
    if (id) void ctx.setOrientation(id, { ...session.orientation, mirror: !session.orientation.mirror });
  });

  $<HTMLSelectElement>('resolution').addEventListener('change', async (e) => {
    const [w, hgt] = (e.target as HTMLSelectElement).value.split('x').map(Number);
    const id = session.activeId;
    if (!id || !w || !hgt) return;
    try {
      await session.open(id, { width: w, height: hgt });
      settings = await api.patchSettings({ resolutions: { ...settings.resolutions, [id]: { width: w, height: hgt } } });
      // Cameras silently fall back to the nearest mode they have; say so rather than pretend.
      if (session.width !== w || session.height !== hgt) {
        toast(`This camera does not do ${w}×${hgt}; it is using ${session.width}×${session.height}.`, 'error', 6000);
      }
    } catch (err) {
      toast((err as Error).message, 'error', 6000);
    }
  });

  $('tb-save').addEventListener('click', async () => {
    try {
      const res = await captureFrame(ctx, {
        maxWidth: 8192,
        format: 'png',
        quality: 1,
        ...(viewer.zoom > 1.001 ? { followUserView: true } : {}),
      });
      toast(`Saved ${res.width}×${res.height} photo to ${await api.savePhoto(res.data, res.mimeType)}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });

  $('empty-retry').addEventListener('click', () => void session.init(settings.lastCameraId).then(renderAll));
}

async function main(): Promise<void> {
  document.documentElement.classList.add(`platform-${api.platform}`);
  settings = await api.getSettings();
  serverInfo = await api.getServerInfo();
  session.orientations = settings.orientations;
  wireStatic();

  session.addEventListener('change', () => {
    renderCameras();
    renderStageState();
    renderHud();
    renderResolution();
    renderControls();
    renderToolbar();
  });
  session.addEventListener('focus', renderFocus);
  viewer.addEventListener('change', () => {
    renderHud();
    renderToolbar();
  });

  api.onServerInfo((info) => {
    serverInfo = info;
    renderServer();
  });
  api.onSettings((s) => {
    settings = s;
    session.orientations = s.orientations;
    viewer.layout();
    renderToolbar();
  });
  setInterval(() => void session.retryIfBusy(), 3000);

  renderAll();
  await session.init(settings.lastCameraId);
  const lastSize = session.activeId ? settings.resolutions[session.activeId] : undefined;
  if (lastSize && session.activeId && (lastSize.width !== session.width || lastSize.height !== session.height)) {
    await session.open(session.activeId, lastSize).catch(() => undefined);
  }
  renderAll();
  api.ready();
}

void main().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${(e as Error).message}`, 'error', 10_000);
  api.ready();
});
