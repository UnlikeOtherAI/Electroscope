import type {
  ActivityEntry,
  CameraControl,
  CaptureResult,
  Orientation,
  RendererCommandName,
  ServerInfo,
  Settings,
} from '../shared/types.js';
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
let serverInfo: ServerInfo = { running: false, port: 0, url: '', clients: [] };
let activity: ActivityEntry[] = [];
let controlsSignature = '';
let frozen = false;
let pendingShare: CaptureResult | null = null;

const video = $<HTMLVideoElement>('video');
const session = new CameraSession(video);
const viewer = new Viewer($('stage'), $('frame'), $('zoomer'), video, session);

// ---------- helpers ----------
function toast(message: string, kind: 'claude' | 'error' | 'info' = 'info', ms = 4200): void {
  const el = h('div', { class: `toast ${kind}`, textContent: message });
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
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

function fileUrl(path: string): string {
  return encodeURI(`file:///${path.replace(/\\/g, '/')}`).replace(/#/g, '%23');
}

// ---------- commands (what Claude's tool calls land on) ----------
const ctx: CommandContext = {
  session,
  userViewRegion: () => viewer.visibleRegion(),
  async setOrientation(cameraId: string, o: Orientation) {
    const orientations = { ...settings.orientations, [cameraId]: o };
    settings = await api.patchSettings({ orientations });
    session.orientations = settings.orientations;
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
    const value = await fn(args);
    api.sendCommandResult({ id, ok: true, value });
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
    btn.dataset['id'] = cam.id;
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
    const size = settings.resolutions[id];
    await session.open(id, size);
    settings = await api.patchSettings({ lastCameraId: id });
    viewer.reset();
    viewer.layout();
  } catch (e) {
    toast((e as Error).message, 'error', 7000);
  }
}

function renderHud(): void {
  const cam = session.activeCamera;
  $('hud-cam').textContent = cam?.label ?? '—';
  $('hud-res').textContent = session.width ? `${session.width}×${session.height}` : '—';
  $('hud-fps').textContent = frozen ? 'Frozen' : session.fps ? `${session.fps} fps` : '—';
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
  const pct = Math.min(1, score / Math.max(focusPeak, 1));
  ($('focus-bar') as HTMLElement).style.width = `${(pct * 100).toFixed(0)}%`;
  ($('focus-peak') as HTMLElement).style.left = `calc(100% - 2px)`;
  $('focus-val').textContent = score >= 100 ? Math.round(score).toString() : score.toFixed(1);
}

function renderStageState(): void {
  const has = session.activeId !== null && session.width > 0;
  $('frame').hidden = !has;
  const empty = $('empty');
  empty.hidden = has;
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

function renderControls(): void {
  const box = $('controls');
  const sig = JSON.stringify(session.controls.map((c) => [c.name, c.range, c.options, c.responsive])) + session.activeId;
  if (sig !== controlsSignature) {
    controlsSignature = sig;
    box.replaceChildren();
    if (session.controls.length === 0) {
      box.append(
        h('p', {
          class: 'none',
          textContent: session.activeId
            ? 'This camera does not expose adjustable controls. Use the lens focus ring and your lighting.'
            : 'Open a camera to see its controls.',
        }),
      );
      return;
    }
    for (const c of session.controls) box.append(controlRow(c));
  }
  syncControlValues();
}

function controlRow(c: CameraControl): HTMLElement {
  const row = h('div', { class: 'control' });
  row.dataset['name'] = c.name;
  if (c.responsive === false) row.classList.add('dead');
  const value = h('span', { class: 'v' });
  row.append(h('div', { class: 'head' }, h('span', { textContent: humanize(c.name) }), value));
  if (c.responsive === false) row.append(h('div', { class: 'tiny', textContent: 'No effect on this camera' }));
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
    const b = h('button', { class: 'mode-seg-toggle chip-btn', type: 'button', textContent: 'Off' });
    b.addEventListener('click', () => void session.applyControls({ [c.name]: !(b.getAttribute('aria-pressed') === 'true') }));
    row.append(b);
  }
  return row;
}

function syncControlValues(): void {
  for (const c of session.controls) {
    const row = $('controls').querySelector<HTMLElement>(`[data-name="${c.name}"]`);
    if (!row) continue;
    const v = row.querySelector<HTMLElement>('.v');
    const input = row.querySelector<HTMLInputElement>('input[type=range]');
    if (input) {
      if (document.activeElement !== input && c.value !== null) input.value = String(c.value);
      if (v) v.textContent = c.value === null ? '' : String(Math.round(Number(c.value) * 100) / 100);
    }
    row.querySelectorAll<HTMLButtonElement>('.mode-seg button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset['value'] === c.value));
    });
    const t = row.querySelector<HTMLButtonElement>('.mode-seg-toggle');
    if (t) {
      t.setAttribute('aria-pressed', String(Boolean(c.value)));
      t.textContent = c.value ? 'On' : 'Off';
    }
  }
}

function renderOrientation(): void {
  $('mirror').setAttribute('aria-pressed', String(session.orientation.mirror));
}

function renderClaude(): void {
  const on = settings.claudeAccess;
  const toggle = $<HTMLInputElement>('access-toggle');
  toggle.checked = on;
  $('claude-card').classList.toggle('off', !on);
  const live = serverInfo.clients.length > 0;
  const pill = $('claude-pill');
  pill.className = `claude-pill ${on ? 'on' : 'off'}${on && live ? ' connected' : ''}`;
  $('claude-pill-text').textContent = !on ? 'Claude paused' : live ? 'Claude connected' : 'Claude can see';

  const status = $('claude-status');
  if (!serverInfo.running) {
    status.textContent = serverInfo.error ? `Server not running: ${serverInfo.error}` : 'Starting…';
  } else if (!on) {
    status.textContent = 'Paused. Claude cannot capture frames until you switch this back on.';
  } else if (!live) {
    status.textContent = 'Ready. Add the server to Claude, then ask it to take a look.';
  } else {
    status.textContent = 'Connected. Claude captures stills on request.';
  }
  $('endpoint').textContent = serverInfo.url || '—';
  const list = $('client-list');
  list.replaceChildren(
    ...serverInfo.clients.map((c) =>
      h(
        'li',
        {},
        h('span', { class: 'dot' }),
        h('span', { textContent: `${c.name}${c.version ? ` ${c.version}` : ''}` }),
        h('span', { class: 'when', textContent: ago(c.lastSeen) }),
      ),
    ),
  );
}

function renderActivity(): void {
  const strip = $('activity-strip');
  $('activity-count').textContent = String(activity.length);
  if (activity.length === 0) {
    strip.replaceChildren(
      h('p', {
        class: 'muted small strip-empty',
        textContent: 'Frames Claude captures, and frames you share, show up here so you always know what it has seen.',
      }),
    );
    return;
  }
  strip.replaceChildren(
    ...[...activity].reverse().map((a) => {
      const b = h('button', { class: `shot ${a.source}`, type: 'button' });
      b.title = `${a.source === 'claude' ? 'Claude captured' : 'You shared'} · ${a.cameraLabel} · ${a.width}×${a.height}`;
      b.append(
        h('img', { src: a.thumbnail, alt: '' }),
        h(
          'div',
          { class: 'cap' },
          h('span', { class: 'who' }),
          h('span', { textContent: a.source === 'claude' ? 'Claude' : 'Shared' }),
          h('span', { class: 't', textContent: clock(a.at) }),
        ),
      );
      if (a.note) b.append(h('div', { class: 'note', textContent: a.note }));
      b.addEventListener('click', () => openLightbox(a));
      return b;
    }),
  );
}

function openLightbox(a: ActivityEntry): void {
  $<HTMLImageElement>('lightbox-img').src = fileUrl(a.path);
  $('lightbox-meta').textContent = `${a.source === 'claude' ? 'Claude' : 'You'} · ${a.cameraLabel} · ${a.width}×${a.height} · ${clock(a.at)}${a.note ? ` · “${a.note}”` : ''}`;
  $('lightbox-reveal').onclick = () => void api.revealFile(a.path);
  $<HTMLDialogElement>('lightbox').showModal();
}

function renderAll(): void {
  renderCameras();
  renderStageState();
  renderHud();
  renderResolution();
  renderControls();
  renderOrientation();
  renderClaude();
}

// ---------- Claude capture feedback ----------
let ringTimer: number | undefined;
function showClaudeRing(text = 'Claude is looking…'): void {
  $('claude-ring-text').textContent = text;
  $('claude-ring').classList.add('active');
  window.clearTimeout(ringTimer);
  ringTimer = window.setTimeout(() => $('claude-ring').classList.remove('active'), 1600);
}

function flash(): void {
  const el = h('div', { class: 'flash go' });
  $('frame').append(el);
  setTimeout(() => el.remove(), 500);
}

// ---------- wiring ----------
function wireStatic(): void {
  $('logo').innerHTML = icons.logo;
  $('open-settings').innerHTML = icons.settings;
  $('refresh').innerHTML = icons.refresh;
  $('copy-url').innerHTML = icons.copy;
  $('copy-cmd').innerHTML = `${icons.copy}<span>Copy Claude Code command</span>`;
  $('tb-zoom-out').innerHTML = icons.zoomOut;
  $('tb-zoom-in').innerHTML = icons.zoomIn;
  $('tb-grid').innerHTML = icons.grid;
  $('tb-cross').innerHTML = icons.crosshair;
  $('tb-freeze').innerHTML = icons.freeze;
  $('tb-save').innerHTML = `${icons.save}<span>Save photo</span>`;
  $('tb-share').innerHTML = `${icons.share}<span>Share with Claude</span>`;
  $('rot-ccw').innerHTML = icons.rotateCcw;
  $('rot-cw').innerHTML = icons.rotateCw;
  $('mirror').innerHTML = icons.flip;
  $('open-folder').innerHTML = `${icons.folder}<span>Photos</span>`;
  $('clear-activity').innerHTML = `${icons.trash}<span>Clear</span>`;

  $('refresh').addEventListener('click', () => void session.refresh());
  $('open-settings').addEventListener('click', () => {
    $<HTMLInputElement>('set-port').value = String(settings.port);
    $<HTMLSelectElement>('set-theme').value = settings.theme;
    $<HTMLDialogElement>('settings').showModal();
  });
  $('settings-form').addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== 'ok') return;
    const port = Number($<HTMLInputElement>('set-port').value);
    const patch: Partial<Settings> = { theme: $<HTMLSelectElement>('set-theme').value as Settings['theme'] };
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) patch.port = port;
    void api.patchSettings(patch).then((s) => {
      settings = s;
      renderClaude();
    });
  });

  const setAccess = async (on: boolean) => {
    settings = await api.patchSettings({ claudeAccess: on });
    renderClaude();
    toast(on ? 'Claude can capture frames again' : 'Claude access paused', 'claude');
  };
  $('access-toggle').addEventListener('change', (e) => void setAccess((e.target as HTMLInputElement).checked));
  $('claude-pill').addEventListener('click', () => void setAccess(!settings.claudeAccess));
  $('copy-url').addEventListener('click', () => void copy(serverInfo.url, 'URL'));
  $('copy-cmd').addEventListener('click', () =>
    void copy(`claude mcp add --transport http electroscope ${serverInfo.url}`, 'Command'),
  );

  $('tb-zoom-in').addEventListener('click', () => viewer.zoomBy(1.5));
  $('tb-zoom-out').addEventListener('click', () => viewer.zoomBy(1 / 1.5));
  $('tb-zoom-reset').addEventListener('click', () => viewer.reset());
  const toggleOverlay = (btn: string, overlay: string) => {
    const b = $(btn);
    b.addEventListener('click', () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      $(overlay).hidden = !on;
    });
  };
  toggleOverlay('tb-grid', 'overlay-grid');
  toggleOverlay('tb-cross', 'overlay-cross');
  const toggleFreeze = () => {
    frozen = !frozen;
    $('tb-freeze').setAttribute('aria-pressed', String(frozen));
    if (frozen) video.pause();
    else void video.play();
    renderHud();
  };
  $('tb-freeze').addEventListener('click', toggleFreeze);
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
    if (e.key === ' ') {
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
        source: 'user',
        ...(viewer.zoom > 1.001 ? { followUserView: true } : {}),
      });
      const path = await api.saveCapture(res.data, res.mimeType);
      toast(`Saved ${res.width}×${res.height} photo to ${path}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });

  $('tb-share').addEventListener('click', async () => {
    try {
      pendingShare = await captureFrame(ctx, {
        maxWidth: 2400,
        format: 'jpeg',
        quality: 0.92,
        source: 'user',
        ...(viewer.zoom > 1.001 ? { followUserView: true } : {}),
      });
      $<HTMLImageElement>('share-preview').src = pendingShare.thumbnail;
      $<HTMLTextAreaElement>('share-note').value = '';
      $<HTMLDialogElement>('share-dialog').showModal();
      $('share-note').focus();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  });
  $('share-form').addEventListener('submit', (e) => {
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    const shot = pendingShare;
    pendingShare = null;
    if (submitter?.value !== 'ok' || !shot) return;
    const note = $<HTMLTextAreaElement>('share-note').value.trim();
    void api.shareFrame(shot, note).then(() => toast('Shared. Tell Claude to look at the frame you shared.', 'claude', 6000));
  });

  $('open-folder').addEventListener('click', () => void api.openCaptures());
  $('clear-activity').addEventListener('click', async () => {
    await api.clearActivity();
    activity = [];
    renderActivity();
  });
  $('lightbox-close').addEventListener('click', () => $<HTMLDialogElement>('lightbox').close());
  $('empty-retry').addEventListener('click', () => void session.init(settings.lastCameraId).then(renderAll));
}

async function main(): Promise<void> {
  document.documentElement.classList.add(`platform-${api.platform}`);
  settings = await api.getSettings();
  serverInfo = await api.getServerInfo();
  activity = await api.getActivity();
  session.orientations = settings.orientations;
  wireStatic();

  session.addEventListener('change', () => {
    renderCameras();
    renderStageState();
    renderHud();
    renderResolution();
    renderControls();
    renderOrientation();
  });
  session.addEventListener('focus', renderFocus);
  viewer.addEventListener('change', renderHud);

  api.onServerInfo((info) => {
    serverInfo = info;
    renderClaude();
  });
  api.onSettings((s) => {
    settings = s;
    session.orientations = s.orientations;
    viewer.layout();
    renderClaude();
    renderOrientation();
  });
  api.onActivity((entry) => {
    activity = [...activity, entry].slice(-60);
    renderActivity();
    if (entry.source === 'claude') {
      showClaudeRing('Claude captured a frame');
      flash();
    }
  });
  api.onClaudeCapturing((tool) => showClaudeRing(tool === 'capture_sequence' ? 'Claude is watching…' : 'Claude is looking…'));
  setInterval(renderClaude, 15_000);
  setInterval(() => void session.retryIfBusy(), 3000);

  renderAll();
  renderActivity();
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
