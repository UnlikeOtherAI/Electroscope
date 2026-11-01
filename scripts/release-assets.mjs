import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'artifacts';
const expected = [
  'Electroscope-Windows-x64-Setup.exe',
  'Electroscope-Windows-x64-Portable.exe',
  'Electroscope-macOS-arm64.dmg',
  'Electroscope-macOS-arm64.zip',
];
const files = (await readdir(dir)).sort();
if (JSON.stringify(files) !== JSON.stringify([...expected].sort())) throw new Error(`Unexpected release assets: ${files}`);
const sums = [];
for (const name of expected) {
  const bytes = await readFile(join(dir, name));
  if (bytes.length < 1_000_000) throw new Error(`Release asset is unexpectedly small: ${name}`);
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await writeFile(join(dir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log(sums.join('\n'));
