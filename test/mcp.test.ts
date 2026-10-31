import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { AppHub } from '../src/main/hub.js';
import { CaptureStore } from '../src/main/captures.js';
import { startMcpHttp, type McpHttp } from '../src/main/mcp/http.js';
import { createMcpServer, type CameraBackend } from '../src/main/mcp/tools.js';
import type { CameraState, CaptureRequest, CaptureResult, RendererCommands } from '../src/shared/types.js';

// A minimal valid JPEG header + padding; the tools only forward bytes.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(7), 0xff, 0xd9]);

const cam = { id: 'cam-1', label: 'Test Scope', active: true };
let state: CameraState = {
  active: cam,
  cameras: [cam, { id: 'cam-2', label: 'Webcam', active: false }],
  width: 1920,
  height: 1080,
  fps: 30,
  orientation: { rotation: 0, mirror: false },
  focusScore: 120,
  maxResolution: { width: 1920, height: 1080 },
  controls: [
    { name: 'zoom', value: 100, range: { min: 100, max: 500, step: 1 } },
    { name: 'focusMode', value: 'continuous', options: ['manual', 'continuous'] },
  ],
};

const captures: CaptureRequest[] = [];

const backend: CameraBackend = {
  async call(name, args) {
    switch (name) {
      case 'getState':
      case 'refreshCameras':
        return state as never;
      case 'selectCamera': {
        const a = args as Parameters<RendererCommands['selectCamera']>[0];
        const target = state.cameras.find((c) => c.id === a.cameraId || c.label.toLowerCase().includes(a.cameraId.toLowerCase()));
        if (!target) throw new Error(`No camera matches "${a.cameraId}"`);
        state = { ...state, active: { ...target, active: true }, cameras: state.cameras.map((c) => ({ ...c, active: c.id === target.id })) };
        return state as never;
      }
      case 'setControls': {
        const a = args as Parameters<RendererCommands['setControls']>[0];
        const applied: Record<string, unknown> = {};
        const rejected: Record<string, string> = {};
        for (const [k, v] of Object.entries(a.controls)) {
          if (state.controls.some((c) => c.name === k)) applied[k] = v;
          else rejected[k] = 'Not supported by this camera';
        }
        return { applied, rejected, state } as never;
      }
      case 'setOrientation': {
        state = { ...state, orientation: { ...state.orientation, ...(args as object) } };
        return state as never;
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
          thumbnail: 'data:image/jpeg;base64,AAAA',
          capturedAt: new Date().toISOString(),
        };
        return result as never;
      }
    }
  },
};

let http: McpHttp;
let hub: AppHub;
let access = true;
let client: Client;
let announced: string[] = [];
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'electroscope-test-'));
  hub = new AppHub(() => access, new CaptureStore(join(dir, 'c')), new CaptureStore(join(dir, 's')), {
    activityAdded: () => undefined,
    claudeCapturing: (t) => announced.push(t),
  });
  http = await startMcpHttp({ port: 0, version: 'test', createServer: () => createMcpServer(backend, hub, 'test') });
  client = new Client({ name: 'vitest', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
});

afterAll(async () => {
  await client.close();
  await http.close();
});

const text = (r: unknown) =>
  ((r as { content: unknown }).content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';

describe('MCP server', () => {
  it('registers the documented tools and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'capture_sequence',
      'capture_snapshot',
      'get_shared_frames',
      'get_status',
      'list_cameras',
      'select_camera',
      'set_camera_controls',
      'set_orientation',
    ]);
    expect(client.getInstructions()).toMatch(/do not ask them to stop/);
  });

  it('tracks connected clients by name', () => {
    expect(http.clients().map((c) => c.name)).toContain('vitest');
  });

  it('get_status reports camera, controls and access', async () => {
    const s = JSON.parse(text(await client.callTool({ name: 'get_status', arguments: {} })));
    expect(s).toMatchObject({ claude_access: true, active_camera: 'Test Scope', resolution: '1920x1080' });
    expect(s.controls.map((c: { name: string }) => c.name)).toEqual(['zoom', 'focusMode']);
  });

  it('capture_snapshot returns an image block, metrics and hints, and saves the file', async () => {
    announced = [];
    const r = await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 640 } });
    const blocks = r.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from(blocks[0]!.data!, 'base64')).toEqual(Buffer.from(JPEG));
    const meta = JSON.parse(text(r));
    expect(meta).toMatchObject({ width: 640, camera: 'Test Scope', focus_score: 5 });
    expect(meta.hints.join(' ')).toMatch(/blown out/);
    expect(meta.hints.join(' ')).toMatch(/out of focus/);
    expect(await readFile(meta.saved_to)).toEqual(Buffer.from(JPEG));
    expect(announced).toEqual(['capture_snapshot']);
    expect(captures.at(-1)).toMatchObject({ maxWidth: 640, format: 'jpeg', source: 'claude' });
  });

  it('passes region, format and follow_user_view through', async () => {
    await client.callTool({
      name: 'capture_snapshot',
      arguments: { region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, format: 'png', quality: 100 },
    });
    expect(captures.at(-1)).toMatchObject({ format: 'png', region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    await client.callTool({ name: 'capture_snapshot', arguments: { follow_user_view: true, region: { x: 0, y: 0, width: 1, height: 1 } } });
    expect(captures.at(-1)?.followUserView).toBe(true);
    expect(captures.at(-1)?.region).toBeUndefined();
  });

  it('rejects out-of-range arguments', async () => {
    const r = await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 99999 } }).catch((e: Error) => e);
    const failed = r instanceof Error || (r as { isError?: boolean }).isError;
    expect(failed).toBe(true);
  });

  it('capture_sequence returns one image per frame with timing', async () => {
    const r = await client.callTool({ name: 'capture_sequence', arguments: { count: 3, interval_ms: 100 } });
    const blocks = r.content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(3);
    const frames = JSON.parse(text(r)).frames;
    expect(frames.map((f: { index: number }) => f.index)).toEqual([1, 2, 3]);
    expect(frames[2].t_ms).toBeGreaterThanOrEqual(190);
    expect(captures.at(-1)?.maxWidth).toBe(800);
  });

  it('select_camera switches by partial name and errors clearly on a miss', async () => {
    const ok = JSON.parse(text(await client.callTool({ name: 'select_camera', arguments: { camera: 'webcam' } })));
    expect(ok.active_camera).toBe('Webcam');
    const bad = await client.callTool({ name: 'select_camera', arguments: { camera: 'nope' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/No camera matches/);
    await client.callTool({ name: 'select_camera', arguments: { camera: 'cam-1' } });
  });

  it('set_camera_controls reports applied and rejected controls', async () => {
    const r = await client.callTool({ name: 'set_camera_controls', arguments: { controls: { zoom: 300, bogus: 1 } } });
    const out = JSON.parse(text(r));
    expect(out.applied).toEqual({ zoom: 300 });
    expect(out.rejected.bogus).toMatch(/Not supported/);
    expect(r.isError).toBeFalsy();
    const allBad = await client.callTool({ name: 'set_camera_controls', arguments: { controls: { bogus: 1 } } });
    expect(allBad.isError).toBe(true);
  });

  it('set_orientation updates orientation', async () => {
    const r = JSON.parse(text(await client.callTool({ name: 'set_orientation', arguments: { rotation: 270, mirror: true } })));
    expect(r.orientation).toEqual({ rotation: 270, mirror: true });
  });

  it('shared frames: empty, then delivered with note, then cleared', async () => {
    expect(text(await client.callTool({ name: 'get_shared_frames', arguments: {} }))).toMatch(/not shared any/);
    const result = await backend.call('capture', { maxWidth: 1000, format: 'jpeg', quality: 0.9, source: 'user' });
    await hub.addShared(result, 'check the 3V3 rail');
    const r = await client.callTool({ name: 'get_shared_frames', arguments: { clear: true } });
    expect((r.content as Array<{ type: string }>).filter((c) => c.type === 'image')).toHaveLength(1);
    expect(JSON.parse(text(r)).frames[0].note).toBe('check the 3V3 rail');
    expect(text(await client.callTool({ name: 'get_shared_frames', arguments: {} }))).toMatch(/not shared any/);
  });

  it('is paused by the human: capture-type tools refuse, get_status still works', async () => {
    access = false;
    try {
      for (const name of ['capture_snapshot', 'select_camera', 'set_orientation', 'get_shared_frames']) {
        const args = name === 'select_camera' ? { camera: 'x' } : {};
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError, name).toBe(true);
        expect(text(r)).toMatch(/paused/);
      }
      const s = JSON.parse(text(await client.callTool({ name: 'get_status', arguments: {} })));
      expect(s.claude_access).toBe(false);
    } finally {
      access = true;
    }
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

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    expect(await post({ host: 'evil.example' })).toBe(403);
  });

  it('refuses a foreign Origin (browser pages)', async () => {
    expect(await post({ origin: 'https://evil.example' })).toBe(403);
  });

  it('accepts a localhost Origin', async () => {
    expect(await post({ origin: `http://localhost:${http.port}` })).not.toBe(403);
  });

  it('requires initialize before anything else and rejects unknown sessions', async () => {
    expect(await post({})).toBe(400);
    expect(await post({ 'mcp-session-id': 'nope' })).toBe(404);
  });

  it('serves /health and 404s other paths', async () => {
    const h = await fetch(`http://127.0.0.1:${http.port}/health`).then((r) => r.json());
    expect(h).toMatchObject({ name: 'electroscope', ok: true });
    expect((await fetch(`http://127.0.0.1:${http.port}/other`)).status).toBe(404);
  });

  it('only listens on loopback', () => {
    expect(http.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
});
