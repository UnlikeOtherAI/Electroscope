// Renders build/icon.svg to PNGs and a multi-size Windows .ico (PNG-compressed entries).
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(resolve(root, 'build/icon.svg'));

const png = (size) => sharp(svg, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

await writeFile(resolve(root, 'build/icon.png'), await png(1024));
await writeFile(resolve(root, 'build/icon-256.png'), await png(256));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = images.map((img, i) => {
  const e = Buffer.alloc(16);
  const s = sizes[i];
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

// A contact sheet to eyeball small sizes.
const tiles = await Promise.all([16, 32, 48, 64, 128, 256].map(async (s) => ({ s, b: await png(s) })));
const W = tiles.reduce((a, t) => a + t.s + 24, 24);
const sheet = sharp({ create: { width: W, height: 300, channels: 4, background: '#e9edf2' } });
let x = 24;
const comps = tiles.map((t) => {
  const c = { input: t.b, left: x, top: 20 };
  x += t.s + 24;
  return c;
});
await sheet.composite(comps).png().toFile(resolve(root, 'test-output/icon-sizes.png'));
console.log('icons written');
