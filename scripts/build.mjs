import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const watch = process.argv.includes('--check');

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', absWorkingDir: root };

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer/main.ts'],
    outfile: 'dist/renderer/main.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
  }),
]);

await cp(resolve(root, 'src/renderer/index.html'), resolve(out, 'renderer/index.html'));
await cp(resolve(root, 'src/renderer/styles.css'), resolve(out, 'renderer/styles.css'));
await cp(resolve(root, 'build/icon-256.png'), resolve(out, 'icon.png'));
if (watch) console.log('build ok');
