import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const directories: string[] = [];
const names = ['Electroscope-Windows-x64-Setup.exe', 'Electroscope-Windows-x64-Portable.exe', 'Electroscope-macOS-arm64.dmg', 'Electroscope-macOS-arm64.zip'];
const run = (dir: string) => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/release-assets.mjs', import.meta.url)), dir], { encoding: 'utf8' });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'electroscope-release-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

it('refuses a release missing a platform', async () => {
  const dir = await fixture();
  await writeFile(join(dir, names[0]!), Buffer.alloc(1_000_000));
  expect(run(dir).status).not.toBe(0);
});

it('refuses unexpected files instead of publishing runner data', async () => {
  const dir = await fixture();
  for (const name of names) await writeFile(join(dir, name), Buffer.alloc(1_000_000));
  await writeFile(join(dir, 'notary.p8'), 'test fixture');
  expect(run(dir).status).not.toBe(0);
});

it('writes SHA-256 checksums for exactly the four platform downloads', async () => {
  const dir = await fixture();
  const data = Buffer.alloc(1_000_000, 42);
  for (const name of names) await writeFile(join(dir, name), data);
  expect(run(dir).status).toBe(0);
  const hash = createHash('sha256').update(data).digest('hex');
  expect(await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8')).toBe(names.map((name) => `${hash}  ${name}\n`).join(''));
});
