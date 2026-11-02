#!/usr/bin/env node
/**
 * Runs the app in development.
 *
 * On macOS this goes through `open` rather than spawning the Electron binary, because the camera
 * depends on it. macOS attributes a permission request to the process responsible for the launch,
 * so a binary started from a shell is attributed to the shell — which cannot be granted a camera,
 * and which makes macOS refuse to even show the prompt. `askForMediaAccess` then returns false
 * instantly and, worse, `getUserMedia` still succeeds: the track reports itself live with a
 * negotiated resolution and never delivers a single frame. Launching through `open` makes launchd
 * responsible, the prompt appears, and the picture arrives. See docs/camera-permission.md.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

if (process.platform !== 'darwin') {
  const child = spawn(electron, [root, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
} else {
  // `open` hands the app's output to a path it opens itself, so an inherited pipe such as
  // /dev/stdout fails the launch outright (-10810). A real file works, and tailing it keeps the
  // console log in this terminal where it belongs.
  const log = join(mkdtempSync(join(tmpdir(), 'electroscope-dev-')), 'app.log');
  writeFileSync(log, ''); // `open` creates it only once the app starts, and tail would race it
  const tail = spawn('tail', ['-F', '-n', '+1', log], { stdio: 'inherit' });
  // Three levels up from Contents/MacOS/Electron is the bundle `open` needs.
  const bundle = dirname(dirname(dirname(electron)));
  const child = spawn(
    'open',
    ['-n', '-W', '--stdout', log, '--stderr', log, bundle, '--args', root, ...args],
    { stdio: 'inherit' },
  );
  const stop = (code) => {
    tail.kill();
    process.exit(code);
  };
  child.on('exit', (code, signal) => setTimeout(() => stop(signal ? 1 : (code ?? 0)), 150));
  process.on('SIGINT', () => stop(0));
}
