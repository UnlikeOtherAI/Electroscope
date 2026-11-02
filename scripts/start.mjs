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
 * responsible, the prompt appears, and the picture arrives.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

const child =
  process.platform === 'darwin'
    ? spawn(
        'open',
        // Three levels up from Contents/MacOS/Electron is the bundle `open` needs.
        ['-n', '-W', '--stdout', '/dev/stdout', '--stderr', '/dev/stderr', dirname(dirname(dirname(electron))), '--args', root, ...args],
        { stdio: 'inherit' },
      )
    : spawn(electron, [root, ...args], { stdio: 'inherit' });

child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
