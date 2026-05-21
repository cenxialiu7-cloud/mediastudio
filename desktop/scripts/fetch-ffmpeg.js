#!/usr/bin/env node
// Stage static ffmpeg + ffprobe per platform/arch into resources/bin/<plat>-<arch>/
// so the packaged app ships its own media tooling for every target it builds —
// newbies don't install ffmpeg. main.js picks resources/bin/<process.platform>-<process.arch>.
//
//   ffprobe-static  → ships ALL arches inside the npm package (just copy)
//   ffmpeg-static   → downloads only the HOST arch at install time; for the
//                     other mac arch we pull the matching binary from the
//                     eugeneware/ffmpeg-static GitHub release (tag b6.1.1).

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BIN_ROOT = path.join(ROOT, 'resources', 'bin');

const FFMPEG_TAG = 'b6.1.1'; // keep in sync with ffmpeg-static's binary-release-tag
const FFMPEG_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}`;

function download(url, dst) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const file = fs.createWriteStream(dst);
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dst);
        return resolve(download(res.headers.location, dst));
      }
      if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(dst); } catch {} return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dst)));
    }).on('error', (e) => { file.close(); try { fs.unlinkSync(dst); } catch {} reject(e); });
  });
}

function copyExec(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
}

async function stageMac() {
  const ffprobePkgDir = path.dirname(require.resolve('ffprobe-static'));
  for (const arch of ['arm64', 'x64']) {
    const outDir = path.join(BIN_ROOT, `darwin-${arch}`);
    // ffprobe — bundled per-arch in the package
    const ffprobeSrc = path.join(ffprobePkgDir, 'bin', 'darwin', arch, 'ffprobe');
    if (fs.existsSync(ffprobeSrc)) { copyExec(ffprobeSrc, path.join(outDir, 'ffprobe')); console.log(`  ✓ ffprobe darwin-${arch}`); }
    else console.warn(`  ✗ ffprobe darwin-${arch} missing (${ffprobeSrc})`);
    // ffmpeg — host arch from the package; other arch downloaded
    const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const ffmpegLocal = require('ffmpeg-static'); // host-arch binary path
    if (arch === hostArch && ffmpegLocal && fs.existsSync(ffmpegLocal)) {
      copyExec(ffmpegLocal, path.join(outDir, 'ffmpeg'));
      console.log(`  ✓ ffmpeg darwin-${arch} (from ffmpeg-static, host)`);
    } else {
      const url = `${FFMPEG_BASE}/ffmpeg-darwin-${arch}`;
      console.log(`  ↓ ffmpeg darwin-${arch} ← ${url}`);
      await download(url, path.join(outDir, 'ffmpeg'));
      fs.chmodSync(path.join(outDir, 'ffmpeg'), 0o755);
      console.log(`  ✓ ffmpeg darwin-${arch} (downloaded)`);
    }
  }
}

function stageWindows() {
  const ffprobePkgDir = path.dirname(require.resolve('ffprobe-static'));
  const outDir = path.join(BIN_ROOT, 'win32-x64');
  const ffprobeSrc = path.join(ffprobePkgDir, 'bin', 'win32', 'x64', 'ffprobe.exe');
  if (fs.existsSync(ffprobeSrc)) { copyExec(ffprobeSrc, path.join(outDir, 'ffprobe.exe')); console.log('  ✓ ffprobe win32-x64'); }
  const ffmpegLocal = require('ffmpeg-static');
  if (ffmpegLocal && fs.existsSync(ffmpegLocal)) { copyExec(ffmpegLocal, path.join(outDir, 'ffmpeg.exe')); console.log('  ✓ ffmpeg win32-x64'); }
}

(async function main() {
  console.log('staging media binaries into resources/bin/<plat>-<arch> …');
  fs.mkdirSync(BIN_ROOT, { recursive: true });
  if (process.platform === 'darwin') await stageMac();
  else if (process.platform === 'win32') stageWindows();
  else console.log('  (unsupported build host platform; skip)');
  console.log('✓ ffmpeg staging done');
})().catch((e) => { console.error('fetch-ffmpeg failed:', e.message); process.exit(1); });
