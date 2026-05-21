#!/usr/bin/env node
// One-click launcher: builds the UI if needed, starts the server, opens the browser.
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import open from 'open';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9810);
const URL = `http://localhost:${PORT}`;
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// `pip install --user` puts CLIs (auto-editor, yt-dlp, paddleocr, …) under
// ~/Library/Python/<ver>/bin (macOS) or %APPDATA%\Python\Python<ver>\Scripts (Win).
// Prepend those to PATH so any child process MediaStudio spawns can find them.
// Only PREPEND user-local pip bin dirs (so we find CLIs like auto-editor /
// yt-dlp / mlx_whisper installed via `pip install --user`). NEVER prepend
// /opt/homebrew/bin — Homebrew installs Python 3.14 there, which on most
// systems does NOT have the whisper packages (those got installed to
// /usr/bin/python3's user-site by `pip install --user`). Prepending would
// shadow the python that actually has the modules, breaking ASR with
// "No module named 'mlx_whisper'". Append homebrew/local as a fallback.
function augmentPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const prepend = [];
  const append = [];
  if (process.platform === 'darwin' && home) {
    for (const v of ['3.14', '3.13', '3.12', '3.11', '3.10', '3.9']) {
      prepend.push(`${home}/Library/Python/${v}/bin`);
    }
    append.push('/opt/homebrew/bin', '/usr/local/bin');
  } else if (process.platform === 'win32' && process.env.APPDATA) {
    for (const v of ['Python314', 'Python313', 'Python312', 'Python311', 'Python310', 'Python39']) {
      prepend.push(`${process.env.APPDATA}\\Python\\${v}\\Scripts`);
    }
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = `${prepend.join(sep)}${sep}${process.env.PATH || ''}${sep}${append.join(sep)}`;
}
augmentPath();

function log(m) { console.log(`[MediaStudio] ${m}`); }

function ensureDeps() {
  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    log('安裝伺服器依賴 (npm install)…');
    spawnSync(npmCmd, ['install', '--no-fund', '--no-audit'], { cwd: ROOT, stdio: 'inherit' });
  }
  const dist = path.join(ROOT, 'client', 'dist', 'index.html');
  if (!existsSync(dist)) {
    if (!existsSync(path.join(ROOT, 'client', 'node_modules'))) {
      log('安裝前端依賴…');
      spawnSync(npmCmd, ['install', '--no-fund', '--no-audit'], { cwd: path.join(ROOT, 'client'), stdio: 'inherit' });
    }
    log('建置前端 (vite build)…');
    spawnSync(npmCmd, ['run', 'build'], { cwd: path.join(ROOT, 'client'), stdio: 'inherit' });
  }
}

function probeOnce(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(URL + '/api/status', { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(j && j.status === 'running'); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeOnce()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('伺服器啟動逾時');
}

ensureDeps();

// If something is already serving MediaStudio on this port, reuse it.
if (await probeOnce()) {
  log(`偵測到 MediaStudio 已在 ${URL} 執行中，直接開啟瀏覽器。`);
  await open(URL);
  log('要結束既有服務：在它的視窗按 Ctrl+C，或執行  pkill -f "MediaStudio/server"');
  process.exit(0);
}

log(`啟動伺服器於 ${URL} …`);
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, stdio: 'inherit', env: process.env });
let serverExited = false;
let shuttingDown = false;
server.on('exit', (code) => {
  serverExited = true;
  if (code && code !== 0) log(`伺服器結束 (code ${code})`);
  process.exit(code ?? 0);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，關閉伺服器…`);
  try { server.kill('SIGTERM'); } catch { /* ignore */ }
  // Hard kill after 3s if it didn't respond.
  setTimeout(() => {
    try { if (!serverExited) server.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(0);
  }, 3000).unref();
}

// Close terminal window → SIGHUP. Ctrl+C → SIGINT. `kill` → SIGTERM. All should stop the service.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));

// Belt and suspenders: if our stdout pipe breaks (terminal vanished), shut down too.
process.stdout.on('error', () => shutdown('STDOUT_CLOSED'));
process.on('beforeExit', () => { try { if (!serverExited) server.kill('SIGTERM'); } catch { /* ignore */ } });

try {
  await waitForServer();
  if (!serverExited) {
    log('開啟瀏覽器…');
    await open(URL);
    log('完成。關閉此終端機視窗 / 按 Ctrl+C 即可結束服務。');
  }
} catch (e) {
  log(`警告：${e.message}（請手動開啟 ${URL}）`);
}
