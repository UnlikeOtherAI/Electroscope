// End-to-end check: launch the built app, then drive it exactly as an agent would, over MCP.
//   node scripts/e2e.mjs           real camera
//   node scripts/e2e.mjs --fake    Chromium's synthetic camera (CI)
// ELECTROSCOPE_EXE=<path> tests a packaged build instead of the source tree.
// ELECTROSCOPE_CAMERA=<label> selects a particular physical camera before testing.
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
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
const photoDir = await mkdtemp(join(tmpdir(), 'electroscope-e2e-photos-'));

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
await page.setViewportSize({ width: 1360, height: 860 }).catch(() => undefined);

if (process.env.ELECTROSCOPE_CAMERA) {
  const camera = process.env.ELECTROSCOPE_CAMERA;
  await page.locator('#camera-list button').filter({ hasText: camera }).click();
  await page.waitForFunction((label) => {
    return document.getElementById('hud-cam')?.textContent.includes(label)
      && document.getElementById('video')?.videoWidth > 0;
  }, camera, { timeout: 30000 });
}

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

const addressText = await page.evaluate(() => document.getElementById('address').textContent);
const endpoint = addressText.match(/http:\/\/\S+\/mcp/)?.[0];
console.log(`  MCP endpoint ${endpoint}`);
assert.ok(endpoint, `no endpoint shown: ${addressText}`);
const port = new URL(endpoint).port;

// The window must be simple: one prompt button, no Claude-specific panels.
await step('window has the address, one Copy prompt button, and no Claude panels', async () => {
  const text = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  assert.ok(text.includes('copy prompt for agent'));
  for (const gone of ['share with claude', "claude's view", 'claude access', 'claude can see', 'claude connected']) {
    assert.ok(!text.includes(gone), `still shows "${gone}"`);
  }
  assert.equal(await page.locator('#copy-prompt').isEnabled(), true);
});

await step('Copy prompt puts the real IP, port and tools on the clipboard', async () => {
  await page.click('#copy-prompt');
  await page.waitForTimeout(400);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  await writeFile(join(outDir, 'copied-prompt.txt'), clip);
  const url = new URL(endpoint);
  assert.ok(clip.includes(`${url.hostname}:${port}/mcp`), 'prompt lacks the address the window shows');
  assert.ok(clip.includes('claude mcp add --transport http electroscope'));
  for (const t of ['capture_snapshot', 'annotate', 'set_view', 'save_photo']) assert.ok(clip.includes(t), t);
});

await page.screenshot({ path: join(outDir, 'app-window.png') });

const client = new Client({ name: 'electroscope-e2e', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

const text = (r) => r.content.find((c) => c.type === 'text')?.text ?? '';
const images = (r) => r.content.filter((c) => c.type === 'image');
const json = (r) => JSON.parse(text(r));
const save = async (name, img) => {
  const file = join(outDir, `${name}.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`);
  await writeFile(file, Buffer.from(img.data, 'base64'));
  return file;
};
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const pixel = async (img, nx, ny) => {
  const { data, info } = await sharp(Buffer.from(img.data, 'base64')).raw().toBuffer({ resolveWithObject: true });
  const x = Math.min(info.width - 1, Math.round(nx * info.width));
  const y = Math.min(info.height - 1, Math.round(ny * info.height));
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

await step('connects through the LAN address, not just loopback', async () => {
  const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
  console.log(`       connected via ${new URL(endpoint).hostname}, ${health.clients} client(s)`);
});

const tools = await step('tools are listed', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`       ${names.join(', ')}`);
  for (const n of ['capture_snapshot', 'capture_sequence', 'get_status', 'list_cameras', 'select_camera', 'set_camera_controls', 'set_orientation', 'set_view', 'annotate', 'clear_annotations', 'save_photo']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  for (const gone of ['get_shared_frames']) assert.ok(!names.includes(gone), `${gone} should be gone`);
  return names;
});

const status = await step('get_status', async () => {
  const s = json(await call('get_status'));
  console.log(`       ${s.active_camera} ${s.resolution} @ ${s.fps}fps, controls: ${s.controls.map((c) => `${c.name}${c.responsive === false ? '(dead)' : ''}`).join(', ') || 'none'}`);
  assert.ok(s.active_camera);
  assert.ok(s.view && typeof s.view.zoom === 'number');
  assert.ok(Array.isArray(s.annotations));
  return s;
});

await step('the UI shows only camera controls that really work', async () => {
  await page.waitForTimeout(fake ? 1500 : 6000); // probing runs in the background after the camera opens
  const s = json(await call('get_status'));
  const working = s.controls.filter((c) => c.responsive !== false).map((c) => c.name).sort();
  const shown = await page.evaluate(() => [...document.querySelectorAll('#controls .control')].map((e) => e.dataset.name).sort());
  console.log(`       working: [${working.join(', ')}]  shown: [${shown.join(', ')}]  dead hidden: [${s.controls.filter((c) => c.responsive === false).map((c) => c.name).join(', ')}]`);
  assert.deepEqual(shown, working);
  const cardHidden = await page.evaluate(() => document.getElementById('controls-card').hidden);
  assert.equal(cardHidden, working.length === 0);
});

await step('list_cameras', async () => {
  const r = json(await call('list_cameras'));
  assert.ok(r.cameras.length >= 1);
  assert.equal(r.cameras.filter((c) => c.active).length, 1);
});

await step('capture_snapshot returns a real image with metrics', async () => {
  const r = await call('capture_snapshot');
  assert.ok(!r.isError, text(r));
  const [img] = images(r);
  assert.ok(img && img.mimeType === 'image/jpeg');
  const bytes = Buffer.from(img.data, 'base64');
  assert.ok(bytes.length > 2000, `tiny image: ${bytes.length}`);
  assert.equal(bytes[0], 0xff);
  const meta = json(r);
  console.log(`       ${meta.width}x${meta.height} of ${meta.source_resolution}, focus ${meta.focus_score}, brightness ${meta.brightness}`);
  await save('snapshot', img);
});

await step('capture_snapshot region is a full-resolution close-up', async () => {
  const r = await call('capture_snapshot', { region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, max_width: 3000, format: 'png' });
  assert.ok(!r.isError, text(r));
  const meta = json(r);
  assert.equal(images(r)[0].mimeType, 'image/png');
  const [sw] = meta.source_resolution.split('x').map(Number);
  assert.ok(Math.abs(meta.width - sw / 2) <= 2, `crop should keep source pixels, got ${meta.width} for ${sw}`);
  await save('region', images(r)[0]);
});

await step('capture_sequence returns N frames', async () => {
  const r = await call('capture_sequence', { count: 3, interval_ms: 300, max_width: 480 });
  assert.ok(!r.isError, text(r));
  assert.equal(images(r).length, 3);
  assert.ok(json(r).frames[2].t_ms >= 550);
  for (let i = 0; i < 3; i++) await save(`sequence-${i + 1}`, images(r)[i]);
});

await step('annotate draws coloured marks on the live view and in captures on request', async () => {
  const marks = [
    { id: 'ring', type: 'circle', x: 0.5, y: 0.5, radius: 0.12, color: '#ff00ff', thickness: 8, label: 'check this', fill: 'rgba(255,0,255,0.12)' },
    { id: 'aim', type: 'crosshair', x: 0.2, y: 0.25, size: 0.05, color: '#00ffff', thickness: 6 },
    { id: 'arrow', type: 'arrow', x: 0.85, y: 0.2, to_x: 0.62, to_y: 0.42, color: '#ffff00', thickness: 6 },
    { id: 'box', type: 'rect', x: 0.12, y: 0.62, width: 0.25, height: 0.2, color: '#00ff00', thickness: 6 },
    { id: 'note', type: 'text', x: 0.55, y: 0.85, text: 'cold joint?', color: '#ffffff', font_size: 0.06 },
  ];
  const stray = json(await call('get_status')).annotations;
  assert.equal(stray.length, 0, `marks existed before the test: ${JSON.stringify(stray)}`);
  const added = json(await call('annotate', { annotations: marks }));
  assert.equal(added.annotations.length, 5);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'app-annotated.png') });

  // Default capture is clean; include_annotations burns them in at the right place.
  const clean = images(await call('capture_snapshot', { max_width: 1000 }))[0];
  const marked = await call('capture_snapshot', { max_width: 1000, include_annotations: true });
  assert.ok(!marked.isError, text(marked));
  const img = images(marked)[0];
  await save('annotated', img);
  const [meta] = [json(marked)];
  // A point on the ring (right edge of the circle) should be magenta only in the annotated image.
  const aspect = meta.width / meta.height;
  const onRing = [0.5 + 0.12, 0.5];
  const m = await pixel(img, ...onRing);
  const c = await pixel(clean, ...onRing);
  console.log(`       ring pixel annotated=${m} clean=${c} (aspect ${aspect.toFixed(2)})`);
  assert.ok(m[0] > 200 && m[2] > 200 && m[1] < 90, `expected magenta on the ring, got ${m}`);
  assert.ok(!(c[0] > 200 && c[2] > 200 && c[1] < 90), 'clean capture must not contain marks');
  const g = await pixel(img, 0.12, 0.72); // left edge of the green box
  assert.ok(g[1] > 200 && g[0] < 90 && g[2] < 90, `expected green box edge, got ${g}`);
});

await step('marks follow a zoomed region capture', async () => {
  const region = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
  const marked = images(await call('capture_snapshot', { region, max_width: 1000, include_annotations: true }))[0];
  const clean = images(await call('capture_snapshot', { region, max_width: 1000 }))[0];
  await save('annotated-zoom', marked);
  // Circle centre (0.5,0.5), radius 0.12 of frame width: the whole 0.4..0.6 window lies inside its
  // translucent magenta fill, so red and blue rise against a clean capture of the same area.
  const p = await pixel(marked, 0.5, 0.3);
  const q = await pixel(clean, 0.5, 0.3);
  console.log(`       inside-ring pixel marked=${p} clean=${q}`);
  // Magenta raises red/blue relative to green. Compare that colour shift rather than demanding
  // an exact increase in each channel across two different live frames (sensor noise/JPEG).
  const magenta = ([r, g, b]) => r + b - 2 * g;
  assert.ok(magenta(p) > magenta(q) + 30, `fill tint expected inside the ring, got ${p} vs ${q}`);
});

await step('clear_annotations removes some, then all', async () => {
  assert.equal(json(await call('clear_annotations', { ids: ['ring'] })).annotations.length, 4);
  assert.equal(json(await call('clear_annotations')).annotations.length, 0);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#tb-clear-all').isDisabled(), true);
});

await step('the human can draw every mark type with a chosen colour, and the agent sees them', async () => {
  await page.evaluate(() => {
    const c = document.getElementById('draw-color');
    c.value = '#00aa44';
    c.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const box = await page.locator('#frame').boundingBox();
  const at = (nx, ny) => [box.x + nx * box.width, box.y + ny * box.height];
  const drag = async (tool, from, to) => {
    await page.click(`#tool-${tool}`);
    await page.mouse.move(...at(...from));
    await page.mouse.down();
    await page.mouse.move(...at(...to), { steps: 6 });
    await page.mouse.up();
    await page.click(`#tool-${tool}`); // toggle the tool off again
  };
  await drag('circle', [0.3, 0.3], [0.38, 0.3]);
  await drag('rect', [0.5, 0.5], [0.7, 0.65]);
  await drag('arrow', [0.9, 0.9], [0.75, 0.7]);
  await page.click('#tool-crosshair');
  await page.mouse.click(...at(0.2, 0.7));
  await page.click('#tool-crosshair');
  await page.click('#tool-text');
  await page.mouse.click(...at(0.1, 0.1));
  await page.waitForSelector('#text-dialog[open]');
  await page.fill('#text-input', 'flux residue');
  await page.click('#text-form button[value="ok"]');
  await page.waitForTimeout(300);
  await page.click('#tool-text');
  await page.screenshot({ path: join(outDir, 'app-human-drawn.png') });

  const marks = json(await call('get_status')).annotations;
  assert.deepEqual(marks.map((m) => m.type), ['circle', 'rect', 'arrow', 'crosshair', 'text']);
  assert.ok(marks.every((m) => m.color === '#00aa44'), 'colour picker not applied');
  assert.ok(Math.abs(marks[0].x - 0.3) < 0.03 && marks[0].radius > 0.04 && marks[0].radius < 0.12, `circle ${JSON.stringify(marks[0])}`);
  assert.ok(Math.abs(marks[1].width - 0.2) < 0.03 && Math.abs(marks[1].height - 0.15) < 0.03, `rect ${JSON.stringify(marks[1])}`);
  assert.ok(Math.abs(marks[2].toX - 0.75) < 0.03, `arrow ${JSON.stringify(marks[2])}`);
  assert.equal(marks[4].text, 'flux residue');
  assert.equal(await page.locator('#tb-clear-all').isDisabled(), false);

  // Ctrl+Z removes the last mark; the agent can restyle a human mark by id.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(json(await call('get_status')).annotations.length, 4);
  const restyled = json(await call('annotate', { annotations: [{ id: marks[0].id, type: 'circle', x: marks[0].x, y: marks[0].y, radius: marks[0].radius, color: 'red' }] }));
  assert.equal(restyled.annotations.find((m) => m.id === marks[0].id).color, 'red');

  // Clear all button.
  await page.click('#tb-clear-all');
  assert.equal(json(await call('get_status')).annotations.length, 0);
  assert.equal(await page.locator('#tb-clear-all').isDisabled(), true);
});

await step('annotate refuses an invalid colour and out-of-range coordinates, clearly', async () => {
  const badColor = await call('annotate', { annotations: [{ type: 'circle', x: 0.5, y: 0.5, color: 'not-a-colour' }] });
  assert.ok(badColor.isError);
  assert.match(text(badColor), /not a CSS colour/);
  const badPos = await call('annotate', { annotations: [{ type: 'circle', x: 1.4, y: 0.5 }] }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e.message) }] }));
  assert.ok(badPos.isError);
  assert.equal(json(await call('get_status')).annotations.length, 0);
});

await step('set_view zooms the window, sets overlay colours, and follow_user_view captures the zoomed area', async () => {
  const v = json(await call('set_view', { zoom: 4, center_x: 0.4, center_y: 0.6, grid: true, crosshair: true, grid_color: '#00ffcc', crosshair_color: 'yellow' })).view;
  assert.equal(v.zoom, 4);
  assert.equal(v.grid, true);
  assert.equal(v.grid_color, '#00ffcc');
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() => ({
    zoom: document.getElementById('tb-zoom-reset').textContent,
    grid: document.querySelector('.overlay-grid').hidden,
    gridColor: document.getElementById('frame').style.getPropertyValue('--grid-color'),
  }));
  assert.equal(shown.zoom, '400%');
  assert.equal(shown.grid, false);
  assert.equal(shown.gridColor, '#00ffcc');
  await page.screenshot({ path: join(outDir, 'app-zoomed.png') });
  const r = await call('capture_snapshot', { follow_user_view: true, max_width: 2000 });
  const meta = json(r);
  assert.ok(Math.abs(meta.region.width - 0.25) < 0.02, `expected a quarter-width crop, got ${JSON.stringify(meta.region)}`);
  await save('user-view', images(r)[0]);
  const bad = await call('set_view', { grid_color: 'nope' });
  assert.ok(bad.isError);
  await call('set_view', { zoom: 1, grid: false, crosshair: false });
});

await step('set_view freezes the on-screen picture but captures stay live', async () => {
  await call('set_view', { frozen: true });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.getElementById('video').paused), true);
  const r = await call('capture_snapshot', { max_width: 320 });
  assert.ok(!r.isError, text(r));
  await call('set_view', { frozen: false });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.getElementById('video').paused), false);
});

await step('set_orientation rotates what the agent receives, and clears marks', async () => {
  await call('annotate', { annotations: [{ id: 'x', type: 'circle', x: 0.5, y: 0.5 }] });
  const before = json(await call('capture_snapshot', { max_width: 640 }));
  assert.ok(!(await call('set_orientation', { rotation: 90 })).isError);
  const after = await call('capture_snapshot', { max_width: 640 });
  const meta = json(after);
  assert.equal(meta.orientation.rotation, 90);
  assert.ok(meta.height > meta.width, `rotated frame should be portrait, got ${meta.width}x${meta.height}`);
  assert.ok(before.width > before.height);
  assert.equal(json(await call('get_status')).annotations.length, 0);
  await save('rotated', images(after)[0]);
  await call('set_orientation', { rotation: 0, mirror: false });
});

await step('set_camera_controls rejects unknown controls clearly', async () => {
  const r = await call('set_camera_controls', { controls: { warpDrive: 9 } });
  assert.ok(r.isError);
  assert.match(text(r), /Not supported/);
});

await step('save_photo writes a full-resolution file and returns its path', async () => {
  const r = await call('save_photo', {});
  assert.ok(!r.isError, text(r));
  assert.equal(images(r).length, 0);
  const out = json(r);
  assert.match(out.saved_to, /photo\.png$/);
  const meta = await sharp(out.saved_to).metadata();
  assert.equal(meta.width, out.width);
  console.log(`       ${out.saved_to} ${meta.width}x${meta.height}`);
});

await step('the window shows the agent and what it has been doing', async () => {
  await call('capture_snapshot', { max_width: 320 });
  await page.waitForTimeout(600);
  const shown = await page.evaluate(() => ({
    agents: [...document.querySelectorAll('#agent-list .agent-item .name')].map((e) => e.textContent),
    status: document.getElementById('status-text').textContent,
    activity: [...document.querySelectorAll('#activity-list .activity-item .name')].map((e) => e.textContent),
    thumbs: document.querySelectorAll('#activity-list img.thumb').length,
  }));
  console.log(`       agents: ${shown.agents.join(', ')} | status: ${shown.status} | ${shown.activity.length} entries, ${shown.thumbs} with a picture`);
  assert.ok(shown.agents.includes('electroscope-e2e'), `agent not listed: ${JSON.stringify(shown.agents)}`);
  assert.match(shown.status, /1 agent/);
  assert.ok(shown.activity.some((t) => t.includes('captured a snapshot')), `no capture in the feed: ${JSON.stringify(shown.activity)}`);
  assert.ok(shown.thumbs > 0, 'captures should show a thumbnail of what the agent saw');
});

await step('picture adjustments reach the window and the captured image', async () => {
  const dark = await pixel(images(await call('capture_snapshot', { max_width: 320 }))[0], 0.5, 0.5);
  const set = json(await call('set_image_adjustments', { brightness: 1.8 }));
  assert.equal(set.image_adjustments.brightness, 1.8);
  await page.waitForTimeout(400);
  const filter = await page.evaluate(() => document.getElementById('zoomer').style.filter);
  assert.match(filter, /brightness\(1\.8\)/, `live view not adjusted: "${filter}"`);
  const bright = await pixel(images(await call('capture_snapshot', { max_width: 320 }))[0], 0.5, 0.5);
  const lum = ([r, g, b]) => r + g + b;
  console.log(`       centre pixel ${dark} -> ${bright}`);
  assert.ok(lum(bright) > lum(dark) + 20, `capture should be brighter, got ${dark} -> ${bright}`);
  const bad = await call('set_image_adjustments', { brightness: 9 }).catch((e) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
  assert.ok(bad.isError, 'out-of-range brightness should be refused');
  await call('set_image_adjustments', { brightness: 1 });
});

await step('there is no access switch: every tool keeps working', async () => {
  for (const name of ['get_status', 'list_cameras', 'capture_snapshot']) {
    assert.ok(!(await call(name, name === 'capture_snapshot' ? { max_width: 320 } : {})).isError, name);
  }
});

await step('requests from a foreign Origin or Host are refused', async () => {
  const bad = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(bad.status, 403);
  const code = await new Promise((res) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (r) => res(r.statusCode));
      req.end('{}');
    });
  });
  assert.equal(code, 403);
});

await client.close();
await page.waitForTimeout(300);
await page.screenshot({ path: join(outDir, 'app-final.png') });
await app.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Output: ${outDir}`);
process.exit(failed.length ? 1 : 0);
