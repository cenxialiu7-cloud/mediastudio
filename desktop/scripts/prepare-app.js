#!/usr/bin/env node
// Copies the MediaStudio source into `app/` and pre-builds the client (vite build)
// so the installer ships a ready-to-run bundle. Runs cross-platform; called from
// `npm run build:win` on the Windows build machine.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
// NOTE: must NOT be literally "app" — electron-builder auto-detects a root
// folder named `app` as the application directory (two-package.json mode) and
// then looks for `app/index.js` as the Electron entry, breaking the build.
const APP = path.join(ROOT, 'ms-app');

// Source location: this tooling now lives inside the MediaStudio repo at
// `desktop/`, so the app source is the repo root (one level up). Override with
// MEDIASTUDIO_SRC for out-of-tree builds (e.g. the legacy MediaStudio-Windows).
const SRC = process.env.MEDIASTUDIO_SRC || path.resolve(ROOT, '..');

function step(msg) { console.log(`\n=== ${msg} ===`); }
function sh(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')} (cwd=${opts.cwd || '.'})`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) { console.error(`FAILED: ${cmd}`); process.exit(r.status || 1); }
}

if (!fs.existsSync(SRC)) {
  console.error(`MediaStudio source not found at ${SRC}. Set MEDIASTUDIO_SRC env or place MediaStudio-Windows next to this folder.`);
  process.exit(1);
}

step(`copy MediaStudio source from ${SRC} -> ${APP}`);
fs.rmSync(APP, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

const SKIP = new Set([
  'node_modules', 'dist', 'data', 'installer', 'docker', 'dist-installer',
  '.git', '.gitignore', '.DS_Store', 'mediastudio.log',
  'desktop',  // the packaging tooling itself — must not recurse into ms-app
  'setup-windows.bat', 'start-windows.bat', 'start-voice-server-windows.bat',
  'install-cuda.bat', 'download-models.bat', 'setup-wsl.sh', '讀我先看.txt'
]);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(SRC, APP);

step('npm install (app/server)');
sh('npm', ['install', '--no-fund', '--no-audit', '--omit=dev'], { cwd: APP });

step('npm install + vite build (app/client)');
sh('npm', ['install', '--no-fund', '--no-audit'], { cwd: path.join(APP, 'client') });
sh('npm', ['run', 'build'], { cwd: path.join(APP, 'client') });

// strip node_modules from client to shrink the installer (vite output is self-contained)
fs.rmSync(path.join(APP, 'client', 'node_modules'), { recursive: true, force: true });

step('✓ app/ ready');
