// Renders the icon sources to PNGs and a multi-size Windows .ico (PNG-compressed entries).
//
// Three masters, because one drawing cannot be right everywhere:
//   build/icon.svg         macOS: a squircle on Apple's grid, with margin and a soft shadow.
//   build/icon-windows.svg Windows: full-bleed tile, small corner radius, no shadow.
//   build/icon-small.svg   16 and 24px: ring and spark only; the traces turn to mush that small.
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFile(resolve(root, 'build', name));

const [mac, win, small] = await Promise.all([read('icon.svg'), read('icon-windows.svg'), read('icon-small.svg')]);
const render = (svg, size) => sharp(svg, { density: 600 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

await writeFile(resolve(root, 'build/icon.png'), await render(mac, 1024));
await writeFile(resolve(root, 'build/icon-256.png'), await render(mac, 256));

// Below 32px the detailed artwork stops reading, so the .ico switches masters.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(ICO_SIZES.map((s) => render(s <= 24 ? small : win, s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(ICO_SIZES.length, 4);
let offset = 6 + 16 * ICO_SIZES.length;
const entries = images.map((img, i) => {
  const e = Buffer.alloc(16);
  const s = ICO_SIZES[i];
  e.writeUInt8(s === 256 ? 0 : s, 0);
  e.writeUInt8(s === 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(img.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.length;
  return e;
});
await writeFile(resolve(root, 'build/icon.ico'), Buffer.concat([header, ...entries, ...images]));

// A contact sheet to eyeball the small sizes, exactly as each will be rendered.
await mkdir(resolve(root, 'test-output'), { recursive: true });
const tiles = await Promise.all(
  [16, 24, 32, 48, 64, 128, 256].map(async (s) => ({ s, b: await render(s <= 24 ? small : win, s) })),
);
const macTiles = await Promise.all([128, 256].map(async (s) => ({ s, b: await render(mac, s) })));
const gap = 24;
const width = [...tiles, ...macTiles].reduce((a, t) => a + t.s + gap, gap);
const composites = [];
let x = gap;
for (const t of tiles) {
  composites.push({ input: t.b, left: x, top: gap + Math.round((256 - t.s) / 2) });
  x += t.s + gap;
}
for (const t of macTiles) {
  composites.push({ input: t.b, left: x, top: gap + Math.round((256 - t.s) / 2) });
  x += t.s + gap;
}
await sharp({ create: { width, height: 256 + gap * 2, channels: 4, background: '#8a94a6' } })
  .composite(composites)
  .png()
  .toFile(resolve(root, 'test-output/icon-sizes.png'));
console.log('icons written');
