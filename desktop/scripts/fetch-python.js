#!/usr/bin/env node
// Downloads the Windows x64 embeddable Python distribution and unzips it into
// `resources/python-embed/`. This is what `app.asar.unpacked/resources/python-embed/python.exe`
// will be at runtime.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DEST = path.join(ROOT, 'resources', 'python-embed');
const PY_VERSION = process.env.MEDIASTUDIO_PY_VERSION || '3.11.9';
const URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const ZIP = path.join(ROOT, 'resources', `python-${PY_VERSION}-embed.zip`);

function dl(url, dst) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const file = fs.createWriteStream(dst);
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dst);
        return resolve(dl(res.headers.location, dst));
      }
      if (res.statusCode !== 200) { file.close(); fs.unlinkSync(dst); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0, lastPct = -1;
      res.on('data', (c) => {
        got += c.length;
        if (total) { const pct = Math.round(got / total * 100); if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\r  ${pct}% (${(got/1048576).toFixed(1)} MB)`); } }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => { process.stdout.write('\n'); resolve(dst); }));
    }).on('error', (e) => { file.close(); try { fs.unlinkSync(dst); } catch {} reject(e); });
  });
}

function unzipWindows(zip, dst) {
  // tar.exe ships with Windows 10+ and handles zip via libarchive.
  fs.mkdirSync(dst, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', dst], { stdio: 'inherit' });
  if (r.status !== 0) {
    // fallback: PowerShell Expand-Archive
    const r2 = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dst}' -Force`], { stdio: 'inherit' });
    if (r2.status !== 0) throw new Error('Failed to unzip with both tar and PowerShell');
  }
}

function unzipUnix(zip, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const r = spawnSync('unzip', ['-q', '-o', zip, '-d', dst], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('unzip failed (install unzip)');
}

(async function main() {
  // The embeddable Python distribution is a Windows-only artifact. On macOS the
  // app relies on the system python3 (Apple CommandLineTools) for light tasks
  // and on-demand Miniforge/conda installs for the heavy subsystems (GPT-SoVITS,
  // ComfyUI). So there's nothing to fetch for a mac build.
  if (process.platform === 'darwin' || process.argv.includes('--mac')) {
    console.log('✓ macOS build — system python3 + on-demand conda; skip embeddable Python.');
    return;
  }
  if (fs.existsSync(path.join(DEST, 'python.exe'))) {
    console.log(`✓ python-embed already present at ${DEST}; skip.`);
    return;
  }
  console.log(`downloading ${URL}`);
  await dl(URL, ZIP);
  console.log(`unzipping → ${DEST}`);
  if (process.platform === 'win32') unzipWindows(ZIP, DEST);
  else unzipUnix(ZIP, DEST);

  // Enable `import site` in the ._pth (main.js also does this defensively at runtime,
  // but doing it at build time means the installer ships a ready Python).
  for (const f of fs.readdirSync(DEST)) {
    if (!f.endsWith('._pth')) continue;
    const p = path.join(DEST, f);
    let txt = fs.readFileSync(p, 'utf8');
    if (/^#import site/m.test(txt)) {
      txt = txt.replace(/^#import site/m, 'import site');
      fs.writeFileSync(p, txt);
      console.log(`enabled site in ${f}`);
    }
  }
  // Don't bootstrap pip at build time — we'd need to RUN the embedded Python,
  // which on a macOS build host can't execute the Windows .exe. main.js installs
  // pip on first run instead.
  console.log('✓ python-embed prepared');
})().catch((e) => { console.error(e); process.exit(1); });
