import type {
  ActivityEvent,
  Annotation,
  CameraControl,
  ClientInfo,
  ImageAdjustments,
  Orientation,
  RendererCommandName,
  ServerInfo,
  Settings,
} from '../shared/types.js';
import { ADJUSTMENT_RANGE, NEUTRAL_ADJUSTMENTS, adjustmentFilter, isNeutral } from '../shared/types.js';
import { buildAgentPrompt } from '../shared/prompt.js';
import { CameraSession } from './camera.js';
import { captureFrame, createCommands, type CommandContext } from './commands.js';
import { icons, type IconName } from './icons.js';
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

const ADJUSTMENTS = [
  { key: 'brightness', label: 'Brightness' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'saturation', label: 'Saturation' },
] as const;

const MARK_ICON: Record<Annotation['type'], IconName> = {
  circle: 'circle',
  crosshair: 'plus',
  rect: 'rect',
  arrow: 'arrow',
  text: 'text',
};

let settings: Settings;
let serverInfo: ServerInfo = { running: false, port: 0, url: '', addresses: [], hostname: '', network: true };
let clients: ClientInfo[] = [];
let activity: ActivityEvent[] = [];
let controlsSignature = '';
let saving = false;

const video = $<HTMLVideoElement>('video');
const session = new CameraSession(video);
const viewer = new Viewer($('stage-area'), $('frame'), $('zoomer'), video, session);

// ---------- helpers ----------
function toast(message: string, kind: 'info' | 'error' = 'info', action?: { label: string; run: () => void }): void {
  const el = h('div', { class: `toast ${kind}` }, h('span', { textContent: message }));
  if (action) {
    const b = h('button', { class: 'toast-action', type: 'button', textContent: action.label });
    b.addEventListener('click', () => {
      action.run();
      el.remove();
    });
    el.append(b);
  }
  $('toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, kind === 'error' ? 7000 : 4200);
}

function humanize(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** "just now", "12s ago", "4 min ago" — rewritten on a timer so the list never goes stale. */
function relTime(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return `${hours} h ago`;
}

function ico(name: IconName, cls = 'ico'): HTMLElement {
  return h('span', { class: cls, innerHTML: icons[name] });
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

/** Settings writes are fire-and-forget from the UI; a failure must still be visible. */
function save(patch: Partial<Settings>): void {
  void api
    .patchSettings(patch)
    .then((s) => {
      settings = s;
      applyTheme();
    })
    .catch((e: Error) => toast(`Could not save settings: ${e.message}`, 'error'));
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
  async setAdjustments(cameraId: string, a: ImageAdjustments) {
    const adjustments = { ...settings.adjustments, [cameraId]: a };
    settings = await api.patchSettings({ adjustments });
    session.adjustmentsByCamera = settings.adjustments;
    applyLiveFilter();
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

/**
 * The window picks its own theme. Electron's nativeTheme.themeSource drives the native chrome but
 * does not reliably reach prefers-color-scheme inside the page, so "Match system" is resolved here.
 */
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(): void {
  const dark = settings.theme === 'system' ? systemDark.matches : settings.theme === 'dark';
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}
systemDark.addEventListener('change', () => {
  if (settings?.theme === 'system') applyTheme();
});

/** The live view shows the adjustments for free; captures redo them on the real pixels. */
function applyLiveFilter(): void {
  $('zoomer').style.filter = adjustmentFilter(session.adjustments);
}

// ---------- popovers ----------
const POPOVERS: Array<[button: string, panel: string]> = [
  ['camera-button', 'camera-popover'],
  ['image-button', 'image-popover'],
];

function closePopovers(except?: string): void {
  for (const [button, panel] of POPOVERS) {
    if (panel === except) continue;
    $(panel).hidden = true;
    $(button).setAttribute('aria-expanded', 'false');
  }
}

function wirePopovers(): void {
  for (const [button, panel] of POPOVERS) {
    $(button).addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $(panel).hidden;
      closePopovers(open ? panel : undefined);
      $(panel).hidden = !open;
      $(button).setAttribute('aria-expanded', String(open));
    });
    $(panel).addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('click', () => closePopovers());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePopovers();
  });
}

// ---------- cameras ----------
function renderCameras(): void {
  const cam = session.activeCamera;
  $('camera-name').textContent = cam?.label ?? (session.cameras.length ? 'Select a camera' : 'No camera');
  $('camera-sub').textContent = cam
    ? session.width
      ? `${session.width} × ${session.height}${session.fps ? ` · ${session.fps} fps` : ''}`
      : 'opening…'
    : `${session.cameras.length} available`;

  const list = $('camera-list');
  list.replaceChildren();
  if (session.cameras.length === 0) {
    list.append(h('li', { class: 'list-empty', textContent: 'No cameras detected.' }));
    return;
  }
  for (const cam of session.cameras) {
    const active = cam.id === session.activeId;
    const btn = h('button', { class: `camera-item${active ? ' active' : ''}`, type: 'button' });
    btn.setAttribute('aria-current', String(active));
    btn.append(
      ico('camera'),
      h(
        'span',
        { class: 'meta' },
        h('span', { class: 'name', textContent: cam.label, title: cam.label }),
        h('span', { class: 'sub', textContent: active ? `${session.width}×${session.height}` : 'Click to switch' }),
      ),
    );
    if (active) btn.append(h('span', { class: 'live-dot', title: 'Live' }));
    btn.addEventListener('click', () => {
      closePopovers();
      if (!active) void switchCamera(cam.id);
    });
    list.append(h('li', {}, btn));
  }
}

async function switchCamera(id: string): Promise<void> {
  try {
    resetFocusPeak();
    await session.open(id, settings.resolutions[id]);
    save({ lastCameraId: id });
    viewer.clearAnnotations();
    viewer.reset();
    viewer.layout();
    applyLiveFilter();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

// ---------- the stage ----------
/** True when the stage is showing the live frame rather than one of the waiting panels. */
function showingFrame(): boolean {
  return session.activeId !== null && session.width > 0;
}


/** Counts down to the next automatic reconnect, so "it retries" is something you can watch. */
let nextRetryAt = 0;
let retryAttempt = 0;
function retryCountdownText(): string {
  const secs = Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000));
  return `Retrying in ${secs}s · attempt ${retryAttempt}`;
}


function renderHud(): void {
  const signal = session.hasSignal;
  $('hud-cam').textContent = session.activeCamera?.label ?? '—';
  $('hud-res').textContent = session.width ? `${session.width}×${session.height}` : '—';
  $('hud-fps').textContent = signal ? (session.fps ? `${session.fps} fps` : '…') : 'no frames yet';
  const live = $('hud-live');
  live.classList.toggle('paused', viewer.frozen);
  live.classList.toggle('stalled', !signal);
  live.lastChild!.textContent = viewer.frozen ? 'FROZEN' : signal ? 'LIVE' : 'NO SIGNAL';
  // Shown exactly when the picture is on screen but nothing is arriving in it.
  $('no-signal').hidden = signal || !showingFrame();
  const zoom = $('hud-zoom');
  zoom.hidden = viewer.zoom <= 1.001;
  zoom.textContent = `${Math.round(viewer.zoom * 100)}%`;
  $('tb-zoom-reset').textContent = `${Math.round(viewer.zoom * 100)}%`;
}

const FOCUS_BARS = 16;
let focusPeak = 1;
let focusHistory: number[] = [];

function buildFocusBars(): void {
  $('focus-bars').replaceChildren(...Array.from({ length: FOCUS_BARS }, () => h('i')));
}

/** The peak belongs to one scene; a new camera or a new frame size invalidates it. */
function resetFocusPeak(): void {
  focusPeak = 1;
  focusHistory = [];
}

function renderFocus(): void {
  const score = session.focusScore;
  const val = $('focus-val');
  const peakEl = $('focus-peak');
  const bars = $('focus-bars').children;
  if (score === null) {
    val.textContent = '—';
    peakEl.textContent = '';
    for (const b of bars) (b as HTMLElement).className = '';
    return;
  }
  focusPeak = Math.max(score, focusPeak * 0.995);
  focusHistory = [...focusHistory, score].slice(-FOCUS_BARS);
  val.textContent = score >= 100 ? Math.round(score).toLocaleString() : score.toFixed(1);
  peakEl.textContent = focusPeak > score * 1.02 ? `peak ${Math.round(focusPeak).toLocaleString()}` : 'at peak';

  const top = Math.max(focusPeak, 1);
  for (let i = 0; i < FOCUS_BARS; i++) {
    const el = bars[i] as HTMLElement | undefined;
    if (!el) continue;
    const v = focusHistory[focusHistory.length - FOCUS_BARS + i];
    const ratio = v === undefined ? 0 : Math.min(1, v / top);
    el.style.height = `${Math.max(3, ratio * 20).toFixed(1)}px`;
    el.className = v === undefined ? '' : ratio > 0.96 ? 'peak' : 'lit';
  }
}

/**
 * One panel covers every reason there is nothing to look at. Each says what is happening and,
 * where the human can do something about it, what to do.
 */
function renderStageState(): void {
  const has = showingFrame();
  $('frame').hidden = !has;
  // The readouts belong to a picture; with no picture they would be describing nothing.
  $('hud-tl').hidden = !has;
  const panel = $('empty');
  panel.hidden = has;
  if (has) {
    viewer.layout();
    return;
  }

  const retry = $<HTMLButtonElement>('empty-retry');
  const note = $('empty-retry-note');
  const setState = (icon: IconName | 'spinner', title: string, text: string, retryLabel?: string) => {
    $('empty-art').replaceChildren(icon === 'spinner' ? h('span', { class: 'spinner lg' }) : ico(icon, 'ico'));
    $('empty-title').textContent = title;
    $('empty-text').textContent = text;
    retry.hidden = !retryLabel;
    if (retryLabel) retry.textContent = retryLabel;
  };

  note.hidden = true;
  if (session.opening) {
    const name = session.cameras.find((c) => c.id === session.wanted)?.label ?? 'the camera';
    setState('spinner', `Opening ${name}…`, 'Waiting for the first frame.');
  } else if (session.busy) {
    setState('camera', 'This camera is in use', 'Another app has it. Close that app — Electroscope reconnects by itself.', 'Retry now');
    note.hidden = false;
    note.textContent = retryCountdownText();
  } else if (session.cameras.length === 0) {
    setState('plug', 'Connect a microscope to begin', session.error ?? 'No camera detected. Plug in a USB camera and it will appear here.', 'Scan again');
  } else {
    setState('camera', 'Camera unavailable', session.error ?? 'Pick a camera from the list at the top left.', 'Try again');
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

// ---------- camera controls ----------
/** Only controls the camera has been seen to obey are shown; the rest would be fake sliders. */
function renderControls(): void {
  const working = session.controls.filter((c) => c.responsive !== false);
  const note = session.controlsNote;
  $('controls-card').hidden = working.length === 0 && !note;
  $('controls-note').textContent = note;
  $('controls-note').hidden = !note;
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
  }
}

// ---------- picture adjustments ----------
/** Electroscope's own, so they work on every camera — which on macOS is the only thing that does. */
function buildAdjustments(): void {
  const box = $('adjustments');
  box.replaceChildren(
    ...ADJUSTMENTS.map(({ key, label }) => {
      const row = h('div', { class: 'control' });
      row.dataset['adj'] = key;
      const value = h('span', { class: 'v' });
      row.append(h('div', { class: 'head' }, h('span', { textContent: label }), value));
      const input = h('input', { type: 'range' });
      input.min = String(ADJUSTMENT_RANGE.min);
      input.max = String(ADJUSTMENT_RANGE.max);
      input.step = String(ADJUSTMENT_RANGE.step);
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => {
        const id = session.activeId;
        if (!id) return;
        const next = { ...session.adjustmentsFor(id), [key]: Number(input.value) };
        session.adjustmentsByCamera = { ...session.adjustmentsByCamera, [id]: next };
        applyLiveFilter();
        renderAdjustments();
        save({ adjustments: { ...settings.adjustments, [id]: next } });
      });
      row.append(input);
      return row;
    }),
  );
}

function renderAdjustments(): void {
  const a = session.adjustments;
  $('adjust-card').hidden = !session.activeId;
  for (const { key } of ADJUSTMENTS) {
    const row = $('adjustments').querySelector<HTMLElement>(`[data-adj="${key}"]`);
    if (!row) continue;
    const input = row.querySelector<HTMLInputElement>('input');
    const v = row.querySelector<HTMLElement>('.v');
    if (input && document.activeElement !== input) input.value = String(a[key]);
    if (v) v.textContent = `${Math.round(a[key] * 100)}%`;
  }
  $<HTMLButtonElement>('adjust-reset').hidden = isNeutral(a);
  $('image-dirty').hidden = isNeutral(a);
}

// ---------- marks ----------
function renderMarks(): void {
  const list = $('marks-list');
  const marks = viewer.annotations;
  $('marks-count').textContent = marks.length ? String(marks.length) : '';
  $('marks-note').textContent = marks.length
    ? 'Marks stay on their feature as you zoom'
    : 'Pick a tool on the left, or let an agent point at something';
  $<HTMLButtonElement>('tb-clear-all').disabled = marks.length === 0;
  $<HTMLButtonElement>('tb-undo').disabled = marks.length === 0;
  list.replaceChildren();
  if (marks.length === 0) {
    list.append(h('li', { class: 'list-empty', textContent: 'Nothing drawn on this view yet.' }));
    return;
  }
  for (const m of marks) {
    const swatch = h('span', { class: 'mark-swatch' });
    swatch.style.setProperty('--c', m.color);
    const title = m.type === 'text' ? (m.text ?? 'Text') : (m.label ?? humanize(m.type));
    const author = m.author ?? 'You';
    const row = h(
      'li',
      { class: 'mark-item' },
      swatch,
      ico(MARK_ICON[m.type], 'ico small'),
      h('span', { class: 'meta' }, h('span', { class: 'name', textContent: title, title })),
      h('span', { class: `author${author === 'You' ? '' : ' agent'}`, textContent: author }),
    );
    const del = h('button', { class: 'icon-btn small quiet', type: 'button', title: `Remove this ${m.type}`, innerHTML: icons.trash });
    del.setAttribute('aria-label', `Remove this ${m.type}`);
    del.addEventListener('click', () => viewer.removeAnnotations([m.id]));
    row.append(del);
    list.append(row);
  }
}

function renderToolbar(): void {
  $('tb-grid').setAttribute('aria-pressed', String(viewer.grid));
  $('tb-cross').setAttribute('aria-pressed', String(viewer.crosshair));
  $('tb-freeze').setAttribute('aria-pressed', String(viewer.frozen));
  $('freeze-label').textContent = viewer.frozen ? 'Frozen' : 'Freeze';
  $('tool-none').setAttribute('aria-pressed', String(viewer.tool === null));
  for (const t of ['circle', 'crosshair', 'rect', 'arrow', 'text'] as const) {
    $(`tool-${t}`).setAttribute('aria-pressed', String(viewer.tool === t));
  }
  $('mirror').setAttribute('aria-pressed', String(session.orientation.mirror));
  const hints: Record<string, string> = {
    circle: 'Drag from the centre outwards',
    crosshair: 'Click where you want it',
    rect: 'Drag a box',
    arrow: 'Drag from the tail to the point',
    text: 'Click where the words should start',
  };
  const hint = $('hint-text');
  hint.textContent = viewer.tool ? (hints[viewer.tool] ?? '') : '';
  hint.hidden = !hint.textContent;
}

// ---------- server, agents, activity ----------
function renderServer(): void {
  const address = $('address');
  const prompt = $<HTMLButtonElement>('copy-prompt');
  const dot = (id: string, cls: string) => {
    const el = $(id);
    el.className = `pill-dot ${cls}`;
  };

  if (serverInfo.running) {
    address.textContent = serverInfo.url;
    address.classList.remove('error');
    const where = serverInfo.network ? 'Listening on your network' : 'Listening on this computer only';
    $('conn-text').textContent = where;
    dot('conn-dot', 'ok');
    $('status-text').textContent = clients.length
      ? `${clients.length} agent${clients.length > 1 ? 's' : ''}`
      : serverInfo.network
        ? 'Listening'
        : 'This computer only';
    dot('status-dot', clients.length ? 'busy' : 'ok');
    $('lock-hint').textContent = serverInfo.network ? 'No password' : 'Local only';
  } else if (serverInfo.error) {
    address.textContent = 'Server not running';
    address.classList.add('error');
    address.title = serverInfo.error;
    $('conn-text').textContent = `Could not start: ${serverInfo.error}`;
    dot('conn-dot', 'bad');
    $('status-text').textContent = 'Server stopped';
    dot('status-dot', 'bad');
    $('lock-hint').textContent = '';
  } else {
    address.textContent = 'starting…';
    $('conn-text').textContent = 'Starting the MCP server…';
    dot('conn-dot', 'wait');
    $('status-text').textContent = 'Starting…';
    dot('status-dot', 'wait');
  }
  prompt.disabled = !serverInfo.running;
  $<HTMLButtonElement>('copy-address').disabled = !serverInfo.running;
  $('tb-subtitle').textContent = serverInfo.running
    ? clients.length
      ? `${clients.length === 1 ? 'An agent is' : `${clients.length} agents are`} sharing this lens`
      : 'One lens, ready to share'
    : 'Starting…';
  $('wb-foot-text').textContent = clients.length
    ? 'Everything an agent does appears above as it happens.'
    : 'Frames stay on this computer until an agent asks for one.';
}

function renderAgents(): void {
  const list = $('agent-list');
  list.replaceChildren();
  if (clients.length === 0) {
    list.append(
      h('li', { class: 'list-empty', textContent: 'No agent yet. Copy the prompt below into Claude Code, Codex or any MCP client.' }),
    );
    return;
  }
  for (const c of clients) {
    list.append(
      h(
        'li',
        { class: 'agent-item' },
        h('span', { class: 'agent-mark' }, ico('bolt', 'ico small')),
        h(
          'span',
          { class: 'meta' },
          h('span', { class: 'name', textContent: c.name, title: `${c.name} ${c.version}`.trim() }),
          h('span', { class: 'sub', textContent: `Connected ${relTime(c.connectedAt)}` }),
        ),
        h('span', { class: 'live-dot', title: 'Connected' }),
      ),
    );
  }
}

function renderActivity(): void {
  const list = $('activity-list');
  $('activity-live').textContent = activity.length ? 'LIVE' : '';
  list.replaceChildren();
  if (activity.length === 0) {
    list.append(h('li', { class: 'list-empty', textContent: 'Nothing yet. What agents do to this camera shows up here.' }));
    return;
  }
  for (const e of activity) {
    const row = h('li', { class: `activity-item${e.ok ? '' : ' failed'}` });
    row.append(
      e.thumbnail
        ? h('img', { class: 'thumb', src: e.thumbnail, alt: '' })
        : h('span', { class: 'thumb placeholder' }, ico(e.ok ? 'bolt' : 'close', 'ico small')),
      h(
        'span',
        { class: 'meta' },
        h('span', { class: 'name' }, h('b', { textContent: e.client }), ' ', e.summary.replace(/^./, (c) => c.toLowerCase())),
        h('span', { class: 'sub time', textContent: relTime(e.at) }),
      ),
    );
    row.dataset['at'] = e.at;
    list.append(row);
  }
}

/** A short flash on the picture when an agent looks through the camera, so it is never invisible. */
let flashTimer: number | undefined;
function flashAgent(e: ActivityEvent): void {
  const flag = $('agent-flag');
  flag.replaceChildren(ico('camera', 'ico small'), h('b', { textContent: e.client }), h('span', { textContent: e.summary.replace(/^./, (c) => c.toLowerCase()) }));
  flag.hidden = false;
  $('stage-flash').classList.add('on');
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flag.hidden = true;
    $('stage-flash').classList.remove('on');
  }, 1800);
}

function renderAll(): void {
  renderCameras();
  renderStageState();
  renderHud();
  renderResolution();
  renderControls();
  renderAdjustments();
  renderMarks();
  renderToolbar();
  renderServer();
  renderAgents();
  renderActivity();
}

// ---------- wiring ----------
function wireStatic(): void {
  $('logo').innerHTML = icons.logo;
  $('open-settings').innerHTML = icons.settings;
  $('refresh').innerHTML = icons.refresh;
  $('copy-address').innerHTML = icons.copy;
  buildFocusBars();
  $('copy-prompt').innerHTML = `${icons.copy}<span>Copy prompt for agent</span>`;
  $('tb-zoom-out').innerHTML = icons.zoomOut;
  $('tb-zoom-in').innerHTML = icons.zoomIn;
  $('tb-grid').innerHTML = icons.grid;
  $('tb-cross').innerHTML = icons.crosshair;
  $('tb-save').innerHTML = `${icons.save}<span>Save photo</span>`;
  $('tool-none').innerHTML = icons.hand;
  $('tool-circle').innerHTML = icons.circle;
  $('tool-crosshair').innerHTML = icons.plus;
  $('tool-rect').innerHTML = icons.rect;
  $('tool-arrow').innerHTML = icons.arrow;
  $('tool-text').innerHTML = icons.text;
  $('rot-ccw').innerHTML = icons.rotateCcw;
  $('rot-cw').innerHTML = icons.rotateCw;
  $('mirror').innerHTML = icons.flip;
  $('adjust-reset').innerHTML = `${icons.undo}<span>Reset</span>`;
  document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    el.innerHTML = icons[el.dataset['icon'] as IconName] ?? '';
  });
  buildAdjustments();

  $('copy-prompt').addEventListener('click', () => void copy(buildAgentPrompt(serverInfo), 'Prompt'));
  $('copy-address').addEventListener('click', () => void copy(serverInfo.url, 'Address'));
  $('refresh').addEventListener('click', () => void session.refresh());
  $('status-pill').addEventListener('click', () => openSettings('connection'));
  $('tool-none').addEventListener('click', () => viewer.setTool(null));
  wirePopovers();
  $('open-settings').addEventListener('click', () => openSettings('general'));
  $('open-photos').addEventListener('click', () => void api.openPhotos());

  wireSettings();

  $('tb-zoom-in').addEventListener('click', () => viewer.zoomBy(1.5));
  $('tb-zoom-out').addEventListener('click', () => viewer.zoomBy(1 / 1.5));
  $('tb-zoom-reset').addEventListener('click', () => viewer.reset());
  $('tb-grid').addEventListener('click', () => viewer.patchView({ grid: !viewer.grid }));
  $('tb-cross').addEventListener('click', () => viewer.patchView({ crosshair: !viewer.crosshair }));
  $('tb-freeze').addEventListener('click', toggleFreeze);
  $('tb-clear-all').addEventListener('click', () => viewer.clearAnnotations());
  $('tb-undo').addEventListener('click', () => viewer.undo());
  // The picture is the only place a tool makes sense, so leaving it puts the hand back.
  $('stage').addEventListener('pointerdown', () => closePopovers());
  $('adjust-reset').addEventListener('click', () => {
    const id = session.activeId;
    if (!id) return;
    session.adjustmentsByCamera = { ...session.adjustmentsByCamera, [id]: { ...NEUTRAL_ADJUSTMENTS } };
    applyLiveFilter();
    renderAdjustments();
    save({ adjustments: { ...settings.adjustments, [id]: { ...NEUTRAL_ADJUSTMENTS } } });
  });

  for (const t of ['circle', 'crosshair', 'rect', 'arrow', 'text'] as const) {
    $(`tool-${t}`).addEventListener('click', () => viewer.setTool(t));
  }
  const colorInput = $<HTMLInputElement>('draw-color');
  const syncSwatch = () => $('swatch-dot').style.setProperty('--c', colorInput.value);
  colorInput.addEventListener('input', () => {
    viewer.drawColor = colorInput.value;
    syncSwatch();
  });
  syncSwatch();

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

  wireKeys();
  wireOrientation();

  $<HTMLSelectElement>('resolution').addEventListener('change', async (e) => {
    const [w, hgt] = (e.target as HTMLSelectElement).value.split('x').map(Number);
    const id = session.activeId;
    if (!id || !w || !hgt) return;
    try {
      resetFocusPeak();
      await session.open(id, { width: w, height: hgt });
      save({ resolutions: { ...settings.resolutions, [id]: { width: w, height: hgt } } });
      // Cameras silently fall back to the nearest mode they have; say so rather than pretend.
      if (session.width !== w || session.height !== hgt) {
        toast(`This camera does not do ${w}×${hgt}; it is using ${session.width}×${session.height}.`, 'error');
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });

  $('tb-save').addEventListener('click', () => void savePhoto());
  $('empty-retry').addEventListener('click', () => {
    if (session.busy && session.activeId === null) void session.retryIfBusy();
    else void session.init(settings.lastCameraId).then(renderAll);
  });
}

const toggleFreeze = (): void => viewer.patchView({ frozen: !viewer.frozen });

async function savePhoto(): Promise<void> {
  if (saving) return;
  saving = true;
  const btn = $<HTMLButtonElement>('tb-save');
  btn.classList.add('working');
  btn.disabled = true;
  try {
    const res = await captureFrame(ctx, {
      maxWidth: 8192,
      format: 'png',
      quality: 1,
      ...(viewer.zoom > 1.001 ? { followUserView: true } : {}),
    });
    const path = await api.savePhoto(res.data, res.mimeType);
    toast(`Saved ${res.width}×${res.height} to ${path}`, 'info', { label: 'Show', run: () => void api.openPhotos() });
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    saving = false;
    btn.classList.remove('working');
    btn.disabled = false;
  }
}

function wireOrientation(): void {
  const rotate = (delta: number) => {
    const id = session.activeId;
    if (!id) return;
    const rotation = ((session.orientation.rotation + delta + 360) % 360) as Orientation['rotation'];
    void ctx.setOrientation(id, { ...session.orientation, rotation }).catch((e: Error) => toast(e.message, 'error'));
  };
  $('rot-cw').addEventListener('click', () => rotate(90));
  $('rot-ccw').addEventListener('click', () => rotate(-90));
  $('mirror').addEventListener('click', () => {
    const id = session.activeId;
    if (!id) return;
    void ctx
      .setOrientation(id, { ...session.orientation, mirror: !session.orientation.mirror })
      .catch((e: Error) => toast(e.message, 'error'));
  });
}

function openSettings(pane: string): void {
  $<HTMLInputElement>('set-port').value = String(settings.port);
  $<HTMLInputElement>('set-network').checked = settings.network;
  $<HTMLSelectElement>('set-theme').value = settings.theme;
  showPane(pane);
  const dialog = $<HTMLDialogElement>('settings');
  if (!dialog.open) dialog.showModal();
}

function showPane(pane: string): void {
  document.querySelectorAll<HTMLElement>('.sheet-pane').forEach((el) => {
    el.hidden = el.dataset['pane'] !== pane;
  });
  document.querySelectorAll<HTMLButtonElement>('.sheet-tab').forEach((el) => {
    el.setAttribute('aria-selected', String(el.dataset['pane'] === pane));
  });
}

/** Settings apply as they are changed; only the port waits until it is a usable number. */
function wireSettings(): void {
  document.querySelectorAll<HTMLButtonElement>('.sheet-tab').forEach((tab) => {
    tab.addEventListener('click', () => showPane(tab.dataset['pane'] ?? 'general'));
  });
  $<HTMLSelectElement>('set-theme').addEventListener('change', (e) => {
    save({ theme: (e.target as HTMLSelectElement).value as Settings['theme'] });
  });
  $<HTMLInputElement>('set-network').addEventListener('change', (e) => {
    save({ network: (e.target as HTMLInputElement).checked });
  });
  const port = $<HTMLInputElement>('set-port');
  const note = $('port-note');
  const commitPort = () => {
    const value = Number(port.value);
    const ok = Number.isInteger(value) && value >= 1024 && value <= 65535;
    note.classList.toggle('bad', !ok);
    note.textContent = ok
      ? '1024–65535. The server restarts when you change it.'
      : 'Pick a number between 1024 and 65535.';
    if (ok && value !== settings.port) save({ port: value });
  };
  port.addEventListener('change', commitPort);
  port.addEventListener('blur', commitPort);
  $('settings-form').addEventListener('submit', () => undefined);
}

/** The keys the menu advertises, handled here so they work wherever focus happens to be. */
function wireKeys(): void {
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
    const dialogOpen = $<HTMLDialogElement>('settings').open || $<HTMLDialogElement>('text-dialog').open;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'z' && !dialogOpen) {
      e.preventDefault();
      viewer.undo();
      return;
    }
    if (mod && key === ',') {
      e.preventDefault();
      openSettings('general');
      return;
    }
    if (dialogOpen || typing) return;

    if (mod && key === 's') {
      e.preventDefault();
      void savePhoto();
    } else if (mod && (key === '+' || key === '=')) {
      e.preventDefault();
      viewer.zoomBy(1.5);
    } else if (mod && key === '-') {
      e.preventDefault();
      viewer.zoomBy(1 / 1.5);
    } else if (mod && key === '0') {
      e.preventDefault();
      viewer.reset();
    } else if (mod && key === 'g') {
      e.preventDefault();
      viewer.patchView({ grid: !viewer.grid });
    } else if (mod && key === 'k') {
      e.preventDefault();
      viewer.patchView({ crosshair: !viewer.crosshair });
    } else if (mod && key === 'r') {
      e.preventDefault();
      $(e.shiftKey ? 'rot-ccw' : 'rot-cw').click();
    } else if (mod && key === 'm') {
      e.preventDefault();
      $('mirror').click();
    } else if (mod) {
      // Leave every other chord to the menu and the platform.
    } else if (e.key === 'Escape' && viewer.tool) {
      viewer.setTool(null);
    } else if (e.key === ' ') {
      // Space belongs to the picture, not to whichever button happens to have focus.
      e.preventDefault();
      toggleFreeze();
    } else if (e.key === '+' || e.key === '=') {
      viewer.zoomBy(1.4);
    } else if (e.key === '-') {
      viewer.zoomBy(1 / 1.4);
    } else if (e.key === '0') {
      viewer.reset();
    }
  });
}

/** The application menu drives the same things the window does, so shortcuts are discoverable. */
function wireMenu(): void {
  const actions: Record<string, () => void> = {
    settings: () => openSettings('general'),
    'copy-prompt': () => void copy(buildAgentPrompt(serverInfo), 'Prompt'),
    'save-photo': () => void savePhoto(),
    undo: () => viewer.undo(),
    'clear-marks': () => viewer.clearAnnotations(),
    'zoom-in': () => viewer.zoomBy(1.5),
    'zoom-out': () => viewer.zoomBy(1 / 1.5),
    'zoom-reset': () => viewer.reset(),
    'toggle-grid': () => viewer.patchView({ grid: !viewer.grid }),
    'toggle-crosshair': () => viewer.patchView({ crosshair: !viewer.crosshair }),
    'toggle-freeze': toggleFreeze,
    'rotate-cw': () => $('rot-cw').click(),
    'rotate-ccw': () => $('rot-ccw').click(),
    mirror: () => $('mirror').click(),
    'rescan-cameras': () => void session.refresh(),
    'window-maximized': () => document.documentElement.classList.add('maximized'),
    'window-restored': () => document.documentElement.classList.remove('maximized'),
    'window-fullscreen': () => document.documentElement.classList.add('maximized'),
  };
  api.onMenu(({ action }) => actions[action]?.());
}

async function main(): Promise<void> {
  document.documentElement.classList.add(`platform-${api.platform}`);
  settings = await api.getSettings();
  applyTheme();
  serverInfo = await api.getServerInfo();
  clients = await api.getClients();
  session.orientations = settings.orientations;
  session.adjustmentsByCamera = settings.adjustments;
  wireStatic();
  wireMenu();

  session.addEventListener('change', () => {
    renderCameras();
    renderStageState();
    renderHud();
    renderResolution();
    renderControls();
    renderAdjustments();
    renderToolbar();
    renderServer();
  });
  session.addEventListener('focus', renderFocus);
  viewer.addEventListener('change', () => {
    renderHud();
    renderToolbar();
    renderMarks();
  });

  api.onServerInfo((info) => {
    serverInfo = info;
    renderServer();
  });
  api.onSettings((s) => {
    settings = s;
    applyTheme();
    session.orientations = s.orientations;
    session.adjustmentsByCamera = s.adjustments;
    applyLiveFilter();
    viewer.layout();
    renderToolbar();
    renderAdjustments();
  });
  api.onClients((list) => {
    clients = list;
    renderAgents();
    renderServer();
  });
  api.onActivity((event) => {
    activity = [event, ...activity].slice(0, 40);
    renderActivity();
    if (event.thumbnail) flashAgent(event);
  });

  setInterval(() => {
    if (session.busy && !session.activeId) {
      nextRetryAt = Date.now() + 3000;
      retryAttempt = session.retries + 1;
      void session.retryIfBusy();
    }
  }, 3000);
  // One second apart, so the countdown on the stage actually counts.
  setInterval(() => {
    if (session.busy && !session.activeId && !$('empty').hidden) {
      $('empty-retry-note').textContent = retryCountdownText();
    }
  }, 500);
  // Relative times would otherwise freeze at "just now".
  setInterval(() => {
    if (activity.length) renderActivity();
    if (clients.length) renderAgents();
  }, 15_000);

  renderAll();
  await session.init(settings.lastCameraId);
  const lastSize = session.activeId ? settings.resolutions[session.activeId] : undefined;
  if (lastSize && session.activeId && (lastSize.width !== session.width || lastSize.height !== session.height)) {
    await session.open(session.activeId, lastSize).catch(() => undefined);
  }
  applyLiveFilter();
  renderAll();
  api.ready();
}

void main().catch((e) => {
  console.error(e);
  toast(`Startup failed: ${(e as Error).message}`, 'error');
  api.ready();
});
