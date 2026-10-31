// End-to-end check: launch the built app, then drive it exactly as Claude would, over MCP.
//   node scripts/e2e.mjs           real camera
//   node scripts/e2e.mjs --fake    Chromium's synthetic camera (CI)
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import electronPath from 'electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fake = process.argv.includes('--fake');
const outDir = join(root, 'test-output', fake ? 'fake' : 'real');
await mkdir(outDir, { recursive: true });
const userData = await mkdtemp(join(tmpdir(), 'electroscope-e2e-'));

const results = [];
const step = async (name, fn) => {
  try {
    const v = await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
    return v;
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL ${name}\n       ${e.message}`);
    return undefined;
  }
};

const app = await electron.launch({
  // ELECTROSCOPE_EXE tests a packaged build (npm run dist) instead of the source tree.
  executablePath: process.env.ELECTROSCOPE_EXE ?? electronPath,
  args: process.env.ELECTROSCOPE_EXE ? [] : [root],
  env: {
    ...process.env,
    ELECTROSCOPE_USER_DATA: userData,
    ELECTROSCOPE_PORT: '0',
    ...(fake ? { ELECTROSCOPE_FAKE_CAMERA: '1' } : {}),
  },
});
process.on('uncaughtException', async (e) => {
  console.error(e);
  await app.close().catch(() => undefined);
  process.exit(1);
});
const page = await app.firstWindow();
page.on('console', (m) => m.type() === 'error' && console.log('  [renderer error]', m.text()));
await page.setViewportSize({ width: 1420, height: 900 }).catch(() => undefined);

await step('window shows a live camera', async () => {
  await page.waitForFunction(() => document.getElementById('video')?.videoWidth > 0, null, { timeout: 30000 });
  const info = await page.evaluate(() => ({
    w: document.getElementById('video').videoWidth,
    h: document.getElementById('video').videoHeight,
    cam: document.getElementById('hud-cam').textContent,
  }));
  console.log(`       ${info.cam} ${info.w}x${info.h}`);
  assert.ok(info.w > 0 && info.h > 0);
});
await page.waitForTimeout(1500);
await page.screenshot({ path: join(outDir, 'app-window.png') });

const endpoint = await page.evaluate(() => document.getElementById('endpoint').textContent);
console.log(`  MCP endpoint ${endpoint}`);

const client = new Client({ name: 'electroscope-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

const text = (r) => r.content.find((c) => c.type === 'text')?.text ?? '';
const images = (r) => r.content.filter((c) => c.type === 'image');
const save = async (name, img) => {
  const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
  const file = join(outDir, `${name}.${ext}`);
  await writeFile(file, Buffer.from(img.data, 'base64'));
  return file;
};

await step('tools are listed', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`       ${names.join(', ')}`);
  for (const n of ['capture_snapshot', 'capture_sequence', 'get_status', 'list_cameras', 'select_camera', 'set_camera_controls', 'set_orientation', 'get_shared_frames']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

const status = await step('get_status', async () => {
  const s = JSON.parse(text(await client.callTool({ name: 'get_status', arguments: {} })));
  console.log(`       ${s.active_camera} ${s.resolution} @ ${s.fps}fps, controls: ${s.controls.map((c) => c.name).join(', ') || 'none'}`);
  assert.ok(s.active_camera);
  assert.equal(s.claude_access, true);
  return s;
});

await step('list_cameras', async () => {
  const r = JSON.parse(text(await client.callTool({ name: 'list_cameras', arguments: {} })));
  assert.ok(r.cameras.length >= 1);
  assert.equal(r.cameras.filter((c) => c.active).length, 1);
});

await step('capture_snapshot returns a real image', async () => {
  const r = await client.callTool({ name: 'capture_snapshot', arguments: {} });
  assert.ok(!r.isError, text(r));
  const [img] = images(r);
  assert.ok(img && img.mimeType === 'image/jpeg');
  const bytes = Buffer.from(img.data, 'base64');
  assert.ok(bytes.length > 2000, `tiny image: ${bytes.length}`);
  assert.equal(bytes[0], 0xff); // JPEG magic
  const meta = JSON.parse(text(r));
  console.log(`       ${meta.width}x${meta.height} of ${meta.source_resolution}, focus ${meta.focus_score}, brightness ${meta.brightness}`);
  await save('snapshot', img);
  assert.ok(meta.saved_to);
});

await step('capture_snapshot region is a full-res close-up', async () => {
  const r = await client.callTool({
    name: 'capture_snapshot',
    arguments: { region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, max_width: 3000, format: 'png' },
  });
  assert.ok(!r.isError, text(r));
  const meta = JSON.parse(text(r));
  const [img] = images(r);
  assert.equal(img.mimeType, 'image/png');
  const [sw] = meta.source_resolution.split('x').map(Number);
  assert.ok(Math.abs(meta.width - sw / 2) <= 2, `crop should keep source pixels, got ${meta.width} for ${sw}`);
  await save('region', img);
});

await step('capture_snapshot with max_width scales down', async () => {
  const r = await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 320 } });
  const meta = JSON.parse(text(r));
  assert.ok(Math.max(meta.width, meta.height) <= 320);
  await save('small', images(r)[0]);
});

await step('capture_sequence returns N frames', async () => {
  const r = await client.callTool({ name: 'capture_sequence', arguments: { count: 3, interval_ms: 300, max_width: 480 } });
  assert.ok(!r.isError, text(r));
  assert.equal(images(r).length, 3);
  const frames = JSON.parse(text(r)).frames;
  assert.equal(frames.length, 3);
  assert.ok(frames[2].t_ms >= 550);
  for (let i = 0; i < 3; i++) await save(`sequence-${i + 1}`, images(r)[i]);
});

await step('set_orientation rotates what Claude receives', async () => {
  const before = JSON.parse(text(await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 640 } })));
  const r = await client.callTool({ name: 'set_orientation', arguments: { rotation: 90 } });
  assert.ok(!r.isError, text(r));
  const after = await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 640 } });
  const meta = JSON.parse(text(after));
  assert.equal(meta.orientation.rotation, 90);
  assert.ok(meta.height > meta.width, `rotated frame should be portrait, got ${meta.width}x${meta.height}`);
  assert.ok(before.width > before.height);
  await save('rotated', images(after)[0]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, 'app-rotated.png') });
  await client.callTool({ name: 'set_orientation', arguments: { rotation: 0, mirror: false } });
});

await step('set_camera_controls rejects unknown controls clearly', async () => {
  const r = await client.callTool({ name: 'set_camera_controls', arguments: { controls: { warpDrive: 9 } } });
  assert.ok(r.isError);
  assert.match(text(r), /Not supported/);
});

if (status?.controls?.length) {
  await step('set_camera_controls changes a supported control', async () => {
    const c = status.controls.find((x) => x.range);
    if (!c) return;
    const target = c.range.min + (c.range.max - c.range.min) / 2;
    const r = await client.callTool({ name: 'set_camera_controls', arguments: { controls: { [c.name]: target } } });
    console.log(`       ${c.name} -> ${target}: ${text(r).slice(0, 120).replace(/\s+/g, ' ')}`);
  });
}

await step('follow_user_view captures the zoomed area', async () => {
  await page.evaluate(() => document.getElementById('tb-zoom-in').click());
  await page.evaluate(() => document.getElementById('tb-zoom-in').click());
  await page.waitForTimeout(300);
  const r = await client.callTool({ name: 'capture_snapshot', arguments: { follow_user_view: true, max_width: 2000 } });
  assert.ok(!r.isError, text(r));
  const meta = JSON.parse(text(r));
  assert.ok(meta.region && meta.region.width < 0.6, `expected a crop, got ${JSON.stringify(meta.region)}`);
  await save('user-view', images(r)[0]);
  await page.screenshot({ path: join(outDir, 'app-zoomed.png') });
  await page.evaluate(() => document.getElementById('tb-zoom-reset').click());
});

await step('human shares a frame and Claude receives it with the note', async () => {
  await page.evaluate(() => document.getElementById('tb-share').click());
  await page.waitForSelector('#share-dialog[open]');
  await page.fill('#share-note', 'U3 gets hot right after power-on');
  await page.screenshot({ path: join(outDir, 'app-share-dialog.png') });
  await page.click('#share-form button[value="ok"]');
  await page.waitForTimeout(500);
  const r = await client.callTool({ name: 'get_shared_frames', arguments: { clear: true } });
  assert.equal(images(r).length, 1);
  assert.match(text(r), /U3 gets hot/);
  const again = await client.callTool({ name: 'get_shared_frames', arguments: {} });
  assert.match(text(again), /not shared any/);
});

await step('activity strip shows what Claude captured', async () => {
  const n = await page.evaluate(() => document.querySelectorAll('#activity-strip .shot').length);
  assert.ok(n >= 6, `expected thumbnails, got ${n}`);
  await page.screenshot({ path: join(outDir, 'app-activity.png') });
});

await step('pausing access blocks capture with a helpful message', async () => {
  await page.evaluate(() => document.getElementById('claude-pill').click());
  await page.waitForTimeout(300);
  const r = await client.callTool({ name: 'capture_snapshot', arguments: {} });
  assert.ok(r.isError);
  assert.match(text(r), /paused/i);
  await page.screenshot({ path: join(outDir, 'app-paused.png') });
  await page.evaluate(() => document.getElementById('claude-pill').click());
  await page.waitForTimeout(300);
  const ok = await client.callTool({ name: 'capture_snapshot', arguments: { max_width: 320 } });
  assert.ok(!ok.isError);
});

await step('requests from a foreign Origin or Host are refused', async () => {
  const bad = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(bad.status, 403);
  const badHost = await new Promise((res) => {
    import('node:http').then(({ request }) => {
      const url = new URL(endpoint);
      const req = request({ host: '127.0.0.1', port: url.port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (r) => res(r.statusCode));
      req.end('{}');
    });
  });
  assert.equal(badHost, 403);
});

await client.close();
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, 'app-final.png') });
await app.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Output: ${outDir}`);
process.exit(failed.length ? 1 : 0);
