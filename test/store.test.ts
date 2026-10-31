import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../src/main/store.js';
import { CaptureStore } from '../src/main/captures.js';
import { RendererBridge } from '../src/main/bridge.js';
import { DEFAULT_SETTINGS } from '../src/shared/types.js';

describe('SettingsStore', () => {
  it('returns defaults, persists patches and survives a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'electroscope-store-'));
    const store = SettingsStore.at(dir);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    await store.patch({ port: 5555, network: false });

    const again = SettingsStore.at(dir);
    expect(await again.load()).toMatchObject({ port: 5555, network: false, theme: 'system' });

    // Settings written by older versions carry keys that no longer exist; they are dropped.
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ port: 7000, claudeAccess: false }));
    const migrated = await SettingsStore.at(dir).load();
    expect(migrated.port).toBe(7000);
    expect(migrated).not.toHaveProperty('claudeAccess');

    await writeFile(join(dir, 'settings.json'), '{not json');
    expect(await SettingsStore.at(dir).load()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('CaptureStore', () => {
  it('names files by time and prunes the oldest beyond the limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'electroscope-caps-'));
    const store = new CaptureStore(dir, 3);
    for (let i = 0; i < 6; i++) {
      await store.save(new Uint8Array([i]), i % 2 ? 'image/png' : 'image/jpeg', 'Capture Snapshot!');
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 100));
    const files = await readdir(dir);
    expect(files.length).toBeLessThanOrEqual(4);
    expect(files.every((f) => /^\d{4}-.*-capture-snapshot\.(png|jpg)$/.test(f))).toBe(true);
  });
});

describe('RendererBridge', () => {
  it('correlates replies, and surfaces renderer errors', async () => {
    const sent: Array<{ id: string; name: string }> = [];
    const bridge = new RendererBridge((e) => (sent.push(e), true), 500);
    bridge.rendererReady();
    const ok = bridge.call('getState', undefined);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bridge.handleResult({ id: sent[0]!.id, ok: true, value: { hello: 1 } });
    await expect(ok).resolves.toEqual({ hello: 1 });

    const bad = bridge.call('getState', undefined);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    bridge.handleResult({ id: sent[1]!.id, ok: false, error: 'boom' });
    await expect(bad).rejects.toThrow('boom');
  });

  it('times out when the renderer never answers and fails fast when the window is gone', async () => {
    const silent = new RendererBridge(() => true, 50);
    silent.rendererReady();
    await expect(silent.call('getState', undefined)).rejects.toThrow(/did not respond/);

    const gone = new RendererBridge(() => false, 50);
    gone.rendererReady();
    await expect(gone.call('getState', undefined)).rejects.toThrow(/closed/);

    const notReady = new RendererBridge(() => true, 50);
    await expect(notReady.call('getState', undefined)).rejects.toThrow(/not ready/);
  });
});
