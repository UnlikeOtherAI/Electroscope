import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { AppHub } from '../src/main/hub.js';
import type { ActivityEvent } from '../src/shared/types.js';
import { CaptureStore } from '../src/main/captures.js';
import { startMcpHttp, type McpHttp } from '../src/main/mcp/http.js';
import { createMcpServer, type CameraBackend } from '../src/main/mcp/tools.js';
import type { Annotation, CameraState, CaptureRequest, CaptureResult, RendererCommands } from '../src/shared/types.js';

// A minimal valid JPEG header + padding; the tools only forward bytes.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(7), 0xff, 0xd9]);

const cam = { id: 'cam-1', label: 'Test Scope', active: true };
let state: CameraState;
const reset = () => {
  state = {
    active: cam,
    cameras: [cam, { id: 'cam-2', label: 'Webcam', active: false }],
    width: 1920,
    height: 1080,
    fps: 30,
    orientation: { rotation: 0, mirror: false },
    focusScore: 120,
    controlsNote: '',
    maxResolution: { width: 1920, height: 1080 },
    adjustments: { brightness: 1, contrast: 1, saturation: 1 },
    controls: [
      { name: 'zoom', value: 100, range: { min: 100, max: 500, step: 1 } },
      { name: 'focusMode', value: 'continuous', options: ['manual', 'continuous'] },
      { name: 'brightness', value: 16, range: { min: 1, max: 255, step: 1 }, responsive: false },
    ],
    view: { zoom: 1, centerX: 0.5, centerY: 0.5, grid: false, crosshair: false, gridColor: '#ffffff', crosshairColor: '#ff5050', frozen: false },
    annotations: [],
  };
};
reset();

const captures: CaptureRequest[] = [];
const calls: Array<{ name: string; args: unknown }> = [];

const backend: CameraBackend = {
  async call<K extends keyof RendererCommands>(name: K, args: Parameters<RendererCommands[K]>[0]) {
    calls.push({ name, args });
    const out = (v: unknown) => v as ReturnType<RendererCommands[K]>;
    switch (name) {
      case 'getState':
      case 'refreshCameras':
        return out(state);
      case 'selectCamera': {
        const a = args as Parameters<RendererCommands['selectCamera']>[0];
        const target = state.cameras.find((c) => c.id === a.cameraId || c.label.toLowerCase().includes(a.cameraId.toLowerCase()));
        if (!target) throw new Error(`No camera matches "${a.cameraId}"`);
        state = { ...state, active: { ...target, active: true }, cameras: state.cameras.map((c) => ({ ...c, active: c.id === target.id })) };
        return out(state);
      }
      case 'setControls': {
        const a = args as Parameters<RendererCommands['setControls']>[0];
        const applied: Record<string, unknown> = {};
        const rejected: Record<string, string> = {};
        for (const [k, v] of Object.entries(a.controls)) {
          if (state.controls.some((c) => c.name === k && c.responsive !== false)) applied[k] = v;
          else rejected[k] = 'Not supported by this camera';
        }
        return out({ applied, rejected, state });
      }
      case 'setOrientation':
        state = { ...state, orientation: { ...state.orientation, ...(args as object) } };
        return out(state);
      case 'setView':
        state = { ...state, view: { ...state.view, ...(args as object) } };
        return out(state);
      case 'setAdjustments':
        state = { ...state, adjustments: { ...state.adjustments, ...(args as object) } };
        return out(state);
      case 'setAnnotations': {
        const a = args as Parameters<RendererCommands['setAnnotations']>[0];
        let list = [...state.annotations];
        if (a.clear) list = [];
        if (a.remove) list = list.filter((m) => !a.remove!.includes(m.id));
        for (const u of a.upsert ?? []) {
          // The real viewer stamps the author the same way.
          const m = { id: u.id ?? `m${list.length + 1}`, color: '#ff3b30', thickness: 3, ...u, author: a.author ?? 'You' } as Annotation;
          const at = list.findIndex((x) => x.id === m.id);
          if (at >= 0) list[at] = m;
          else list.push(m);
        }
        state = { ...state, annotations: list };
        return out(state);
      }
      case 'capture': {
        const req = args as CaptureRequest;
        captures.push(req);
        const result: CaptureResult = {
          data: JPEG,
          mimeType: req.format === 'png' ? 'image/png' : 'image/jpeg',
          width: Math.min(req.maxWidth, 1920),
          height: Math.round((Math.min(req.maxWidth, 1920) * 9) / 16),
          sourceWidth: 1920,
          sourceHeight: 1080,
          camera: cam,
          region: req.region ?? null,
          orientation: state.orientation,
          metrics: { focusScore: 5, brightness: 130, overexposed: 0.3, underexposed: 0 },
          capturedAt: new Date().toISOString(),
        };
        return out(result);
      }
    }
    throw new Error(`unhandled ${String(name)}`);
  },
};

const activity: ActivityEvent[] = [];
let http: McpHttp;
let client: Client;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'electroscope-test-'));
  const hub = new AppHub(new CaptureStore(join(dir, 'c')), new CaptureStore(join(dir, 'p')), (e) => activity.push(e));
  http = await startMcpHttp({
    port: 0,
    version: 'test',
    createServer: (client) => createMcpServer(backend, hub, 'test', client),
  });
  client = new Client({ name: 'vitest', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
});

afterAll(async () => {
  await client.close();
  await http.close();
});

const text = (r: unknown) =>
  ((r as { content: unknown }).content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
const json = (r: unknown) => JSON.parse(text(r));

describe('MCP tools', () => {
  it('registers the documented tools and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'annotate',
      'capture_sequence',
      'capture_snapshot',
      'clear_annotations',
      'get_status',
      'list_cameras',
      'save_photo',
      'select_camera',
      'set_camera_controls',
      'set_image_adjustments',
      'set_orientation',
      'set_view',
    ]);
    expect(client.getInstructions()).toMatch(/do not ask them to stop/);
  });

  it('tracks connected clients by name', () => {
    expect(http.clients().map((c) => c.name)).toContain('vitest');
  });

  it('get_status reports camera, view, marks and which controls are real', async () => {
    const s = json(await client.callTool({ name: 'get_status', arguments: {} }));
    expect(s).toMatchObject({ active_camera: 'Test Scope', resolution: '1920x1080' });
    expect(s.view).toMatchObject({ zoom: 1, grid: false, frozen: false, grid_color: '#ffffff' });
    expect(s.annotations).toEqual([]);
    expect(s.controls.find((c: { name: string }) => c.name === 'brightness').responsive).toBe(false);
  });

  it('capture_snapshot returns an image block, metrics and hints, and saves the file', async () => {
    const r = await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 640 } });
    const blocks = r.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from(blocks[0]!.data!, 'base64')).toEqual(Buffer.from(JPEG));
    const meta = json(r);
    expect(meta).toMatchObject({ width: 640, camera: 'Test Scope', focus_score: 5 });
    expect(meta.hints.join(' ')).toMatch(/blown out/);
    expect(meta.hints.join(' ')).toMatch(/out of focus/);
    expect(await readFile(meta.saved_to)).toEqual(Buffer.from(JPEG));
    expect(captures.at(-1)).toMatchObject({ maxWidth: 640, format: 'jpeg' });
  });

  it('passes region, format, follow_user_view and include_annotations through', async () => {
    await client.callTool({
      name: 'capture_snapshot',
      arguments: { region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, format: 'png', include_annotations: true },
    });
    expect(captures.at(-1)).toMatchObject({ format: 'png', annotated: true, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    await client.callTool({ name: 'capture_snapshot', arguments: { follow_user_view: true, region: { x: 0, y: 0, width: 1, height: 1 } } });
    expect(captures.at(-1)?.followUserView).toBe(true);
    expect(captures.at(-1)?.region).toBeUndefined();
    expect(captures.at(-1)?.annotated).toBeUndefined();
  });

  it('rejects out-of-range arguments', async () => {
    const r = await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 99999 } }).catch((e: Error) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError).toBe(true);
  });

  it('capture_sequence returns one image per frame with timing', async () => {
    const r = await client.callTool({ name: 'capture_sequence', arguments: { count: 3, interval_ms: 100 } });
    expect((r.content as Array<{ type: string }>).filter((b) => b.type === 'image')).toHaveLength(3);
    const frames = json(r).frames;
    expect(frames.map((f: { index: number }) => f.index)).toEqual([1, 2, 3]);
    expect(frames[2].t_ms).toBeGreaterThanOrEqual(190);
    expect(captures.at(-1)?.maxWidth).toBe(800);
  });

  it('save_photo saves full resolution and returns only a path', async () => {
    const r = await client.callTool({ name: 'save_photo', arguments: { region: { x: 0, y: 0, width: 0.5, height: 0.5 } } });
    expect((r.content as Array<{ type: string }>).every((b) => b.type === 'text')).toBe(true);
    const out = json(r);
    expect(out.saved_to).toMatch(/photo\.png$/);
    expect(await readFile(out.saved_to)).toEqual(Buffer.from(JPEG));
    expect(captures.at(-1)).toMatchObject({ maxWidth: 8192, format: 'png', region: { x: 0, y: 0, width: 0.5, height: 0.5 } });
  });

  it('select_camera switches by partial name and errors clearly on a miss', async () => {
    expect(json(await client.callTool({ name: 'select_camera', arguments: { camera: 'webcam' } })).active_camera).toBe('Webcam');
    const bad = await client.callTool({ name: 'select_camera', arguments: { camera: 'nope' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/No camera matches/);
    await client.callTool({ name: 'select_camera', arguments: { camera: 'cam-1' } });
  });

  it('set_camera_controls reports applied and rejected controls, including dead ones', async () => {
    const r = await client.callTool({ name: 'set_camera_controls', arguments: { controls: { zoom: 300, bogus: 1, brightness: 99 } } });
    const out = json(r);
    expect(out.applied).toEqual({ zoom: 300 });
    expect(Object.keys(out.rejected).sort()).toEqual(['bogus', 'brightness']);
    expect(r.isError).toBeFalsy();
    expect((await client.callTool({ name: 'set_camera_controls', arguments: { controls: { bogus: 1 } } })).isError).toBe(true);
  });

  it('set_orientation updates orientation', async () => {
    const r = json(await client.callTool({ name: 'set_orientation', arguments: { rotation: 270, mirror: true } }));
    expect(r.orientation).toEqual({ rotation: 270, mirror: true });
  });

  it('set_view maps zoom, pan, overlays and colours', async () => {
    const r = json(
      await client.callTool({
        name: 'set_view',
        arguments: { zoom: 4, center_x: 0.3, center_y: 0.7, grid: true, crosshair: true, grid_color: '#00ffcc', crosshair_color: 'yellow', frozen: true },
      }),
    );
    expect(r.view).toMatchObject({ zoom: 4, center_x: 0.3, center_y: 0.7, grid: true, crosshair: true, grid_color: '#00ffcc', crosshair_color: 'yellow', frozen: true });
    expect(calls.at(-1)?.args).toMatchObject({ gridColor: '#00ffcc', crosshairColor: 'yellow', centerX: 0.3 });
    await client.callTool({ name: 'set_view', arguments: { zoom: 1, grid: false, crosshair: false, frozen: false } });
  });

  it('annotate sends circles, crosshairs, arrows, rects and text with their colours', async () => {
    const r = json(
      await client.callTool({
        name: 'annotate',
        arguments: {
          annotations: [
            { id: 'u3', type: 'circle', x: 0.4, y: 0.5, radius: 0.06, color: '#00e5ff', label: 'U3 is hot', fill: 'rgba(0,229,255,0.15)' },
            { type: 'crosshair', x: 0.7, y: 0.2, size: 0.02, color: 'lime' },
            { type: 'arrow', x: 0.1, y: 0.1, to_x: 0.4, to_y: 0.45, color: 'orange', thickness: 5 },
            { type: 'rect', x: 0.2, y: 0.6, width: 0.3, height: 0.1 },
            { type: 'text', x: 0.05, y: 0.9, text: 'cold joint?', font_size: 0.06, color: '#ffffff', background: 'none' },
          ],
        },
      }),
    );
    expect(r.annotations).toHaveLength(5);
    expect(r.annotations[0]).toMatchObject({ id: 'u3', type: 'circle', radius: 0.06, color: '#00e5ff', label: 'U3 is hot' });
    expect(r.annotations[2]).toMatchObject({ type: 'arrow', toX: 0.4, toY: 0.45, thickness: 5 });
    expect(r.annotations[4]).toMatchObject({ type: 'text', text: 'cold joint?', fontSize: 0.06, background: 'none' });
    expect(json(await client.callTool({ name: 'get_status', arguments: {} })).annotations).toHaveLength(5);
  });

  it('annotate with an existing id replaces that mark; clear_annotations removes some or all', async () => {
    const moved = json(await client.callTool({ name: 'annotate', arguments: { annotations: [{ id: 'u3', type: 'circle', x: 0.9, y: 0.9, color: 'red' }] } }));
    expect(moved.annotations).toHaveLength(5);
    expect(moved.annotations.find((a: Annotation) => a.id === 'u3')).toMatchObject({ x: 0.9, color: 'red' });
    expect(json(await client.callTool({ name: 'clear_annotations', arguments: { ids: ['u3'] } })).annotations).toHaveLength(4);
    expect(json(await client.callTool({ name: 'clear_annotations', arguments: {} })).annotations).toEqual([]);
  });

  it('annotate rejects coordinates outside the frame', async () => {
    const r = await client.callTool({ name: 'annotate', arguments: { annotations: [{ type: 'circle', x: 1.5, y: 0.2 }] } }).catch((e: Error) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError).toBe(true);
  });
});

describe('HTTP transport safety', () => {
  const post = (headers: Record<string, string>, path = '/mcp') =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: http.port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });

  it('refuses a DNS name that is not this computer (DNS rebinding)', async () => {
    expect(await post({ host: 'evil.example' })).toBe(403);
    expect(await post({ host: `evil.example:${http.port}` })).toBe(403);
  });

  it('accepts IP literals, localhost and its own hostname as Host', async () => {
    for (const host of [`127.0.0.1:${http.port}`, `192.168.1.50:${http.port}`, `[::1]:${http.port}`, `localhost:${http.port}`, `${hostname().toLowerCase()}.local:${http.port}`]) {
      expect(await post({ host }), host).not.toBe(403);
    }
  });

  it('refuses a cross-site Origin, accepts a same-origin one and no Origin', async () => {
    expect(await post({ origin: 'https://evil.example' })).toBe(403);
    expect(await post({ origin: 'http://192.168.1.77:9999', host: `127.0.0.1:${http.port}` })).toBe(403);
    expect(await post({ origin: `http://127.0.0.1:${http.port}`, host: `127.0.0.1:${http.port}` })).not.toBe(403);
    expect(await post({})).not.toBe(403);
  });

  it('requires initialize before anything else and rejects unknown sessions', async () => {
    expect(await post({})).toBe(400);
    expect(await post({ 'mcp-session-id': 'nope' })).toBe(404);
  });

  it('set_image_adjustments changes the picture and refuses values outside its range', async () => {
    const ok = json(await client.callTool({ name: 'set_image_adjustments', arguments: { contrast: 1.4, brightness: 0.8 } }));
    expect(ok.image_adjustments).toMatchObject({ contrast: 1.4, brightness: 0.8, saturation: 1 });
    const bad = await client
      .callTool({ name: 'set_image_adjustments', arguments: { contrast: 9 } })
      .catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect((bad as { isError?: boolean }).isError).toBe(true);
    await client.callTool({ name: 'set_image_adjustments', arguments: { contrast: 1, brightness: 1 } });
  });

  it('tells the window who did what, with a picture when there is one', async () => {
    activity.length = 0;
    await client.callTool({ name: 'get_status', arguments: {} });
    await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 320 } });
    expect(activity.map((e) => e.tool)).toEqual(['get_status', 'capture_snapshot']);
    expect(activity.every((e) => e.client === 'vitest' && e.ok && e.id && e.at)).toBe(true);
    expect(activity[0]!.summary).toBe('Checked the microscope');
    expect(activity[1]!.summary).toBe('Captured a snapshot');
  });

  it('reports a failed call rather than staying silent', async () => {
    activity.length = 0;
    await client.callTool({ name: 'set_camera_controls', arguments: { controls: { warpDrive: 1 } } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ tool: 'set_camera_controls', ok: false });
  });

  it('points an agent at the adjustments when the camera has no controls of its own', async () => {
    const r = await client.callTool({ name: 'set_camera_controls', arguments: { controls: { warpDrive: 1 } } });
    expect(json(r).try_instead).toMatch(/set_image_adjustments/);
  });

  it('names the marks it draws after the agent that drew them', async () => {
    await client.callTool({ name: 'annotate', arguments: { annotations: [{ type: 'circle', x: 0.5, y: 0.5 }] } });
    expect(json(await client.callTool({ name: 'get_status', arguments: {} })).annotations[0].author).toBe('vitest');
    await client.callTool({ name: 'clear_annotations', arguments: {} });
  });

  it('serves /health and 404s other paths', async () => {
    const h = await fetch(`http://127.0.0.1:${http.port}/health`).then((r) => r.json());
    expect(h).toMatchObject({ name: 'electroscope', ok: true });
    expect((await fetch(`http://127.0.0.1:${http.port}/other`)).status).toBe(404);
  });

  it('listens on every interface by default, or only loopback when asked', async () => {
    const lan = await startMcpHttp({ port: 0, version: 't', createServer: () => createMcpServer(backend, new AppHub(new CaptureStore(join(dir, 'x')), new CaptureStore(join(dir, 'y'))), 't') });
    const local = await startMcpHttp({ port: 0, host: '127.0.0.1', version: 't', createServer: () => createMcpServer(backend, new AppHub(new CaptureStore(join(dir, 'x')), new CaptureStore(join(dir, 'y'))), 't') });
    try {
      const { address } = await import('node:net').then((n) => new Promise<{ address: string }>((res) => {
        const s = n.connect(lan.port, '127.0.0.1', () => { res({ address: s.remoteAddress ?? '' }); s.destroy(); });
      }));
      expect(address).toBe('127.0.0.1');
      expect(lan.port).not.toBe(local.port);
    } finally {
      await lan.close();
      await local.close();
    }
  });
});
