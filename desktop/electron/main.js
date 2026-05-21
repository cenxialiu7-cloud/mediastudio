// MediaStudio Desktop — Electron main process (CommonJS).
//
// Why CJS not ESM: Electron 31/32 + asar + ESM has known module-resolution bugs
// (ERR_MODULE_NOT_FOUND for paths inside packaged win-unpacked\resources\app...).
// CJS is the long-tested, asar-friendly path. Preload + renderer can still be modern.
//
// What this file does:
//   1) First run → opens the setup wizard window (HTML, all 繁中, no cmd)
//   2) Setup wizard installs pip pkgs, optional XTTS/F5-TTS venvs, optional GPU
//   3) Subsequent runs → spawns the bundled MediaStudio Node server + main window

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

// ---------- paths ----------
const isPackaged = app.isPackaged;
// In dev: project root = parent of `electron/`.
// In packaged: process.resourcesPath/app (when asar:false) or app.asar.unpacked.
const APP_ROOT = isPackaged
  ? (fs.existsSync(path.join(process.resourcesPath, 'app.asar.unpacked'))
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : path.join(process.resourcesPath, 'app'))
  : path.resolve(__dirname, '..');

const IS_MAC = process.platform === 'darwin';
// ms-app is shipped via electron-builder `extraResources` (so its node_modules
// survives — `files` strips nested node_modules). That lands it at
// process.resourcesPath/ms-app when packaged; in dev it sits next to electron/.
const MS_APP_DIR = isPackaged
  ? path.join(process.resourcesPath, 'ms-app')
  : path.join(APP_ROOT, 'ms-app');
const PY_EMBED_DIR = path.join(APP_ROOT, 'resources', 'python-embed');
const PY_EXE = path.join(PY_EMBED_DIR, 'python.exe');

// User-writable runtime data
const USER_DATA = app.getPath('userData');
const STATE_FILE = path.join(USER_DATA, 'state.json');
const LOG_FILE = path.join(USER_DATA, 'mediastudio.log');
const VENV_XTTS = path.join(USER_DATA, 'venv-xtts');
const VENV_F5TTS = path.join(USER_DATA, 'venv-f5tts');
const MS_DATA_DIR = path.join(USER_DATA, 'data');

fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(MS_DATA_DIR, { recursive: true });

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}\n`;
  try { logStream.write(line); } catch {}
  try { process.stdout.write(line); } catch {}
}
log(`MediaStudio Desktop v${app.getVersion()} starting`);
log(`paths`, { APP_ROOT, MS_APP_DIR, PY_EXE, USER_DATA });

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  const s = Object.assign(readState(), patch);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function which(bin) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, bin + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }

// On macOS we don't ship an embeddable Python — use the system python3
// (Apple CommandLineTools) for light tasks; the heavy subsystems install their
// own conda/venv on demand from the in-app panels.
function resolvePythonBin() {
  if (IS_MAC) {
    for (const cand of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
      if (fileExists(cand)) return cand;
    }
    return which('python3') || 'python3';
  }
  return PY_EXE;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close(); try { fs.unlinkSync(dest); } catch {}
        return resolve(downloadFile(res.headers.location, dest, onProgress));
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      res.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (e) => { file.close(); try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 800 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function runProcess(exe, args, send, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, {
      cwd: opts.cwd || APP_ROOT,
      env: Object.assign({}, process.env, opts.env || {}, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      windowsHide: true
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (b) => {
      const s = b.toString('utf8'); stdout += s;
      if (send && !opts.noProgress) s.split('\n').forEach((line) => { if (line.trim()) send('日誌', line); });
    });
    proc.stderr.on('data', (b) => {
      const s = b.toString('utf8'); stderr += s;
      if (send && !opts.noProgress) s.split('\n').forEach((line) => { if (line.trim()) send('日誌', line); });
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const r = { exitCode: code, stdout, stderr };
      if (opts.collectOutput || code === 0) resolve(r);
      else reject(new Error(`${path.basename(exe)} exited ${code}\n${stderr.slice(-600)}`));
    });
  });
}

function runPython(args, env, send, opts) {
  return runProcess(PY_EXE, args, send, Object.assign({ env: env || {} }, opts || {}));
}

async function ensurePython(send) {
  if (!fileExists(PY_EXE)) {
    throw new Error(`找不到嵌入式 Python：${PY_EXE}\n(installer 似乎沒包到 resources\\python-embed)`);
  }
  // Enable `import site` in *._pth so pip can find packages
  for (const f of fs.readdirSync(PY_EMBED_DIR)) {
    if (!f.endsWith('._pth')) continue;
    const p = path.join(PY_EMBED_DIR, f);
    let txt;
    try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (/^#import site/m.test(txt)) {
      txt = txt.replace(/^#import site/m, 'import site');
      try { fs.writeFileSync(p, txt); log(`enabled site in ${f}`); } catch (e) { log('cannot patch ._pth:', e.message); }
    }
  }
  // Bootstrap pip if missing
  const pipCheck = await runPython(['-m', 'pip', '--version'], null, null, { collectOutput: true, noProgress: true });
  if (pipCheck.exitCode !== 0) {
    if (send) send('進度', '下載 get-pip.py …');
    const tmp = path.join(USER_DATA, 'get-pip.py');
    await downloadFile('https://bootstrap.pypa.io/get-pip.py', tmp, (got, total) => {
      if (total && send) send('進度', `get-pip.py ${Math.round(got / total * 100)}%`);
    });
    if (send) send('進度', '安裝 pip …');
    await runPython([tmp], null, send);
    try { fs.unlinkSync(tmp); } catch {}
  }
  return PY_EXE;
}

// ---------- bundled node server ----------
let nodeServerProc = null;
const voiceProcs = { xtts: null, f5tts: null };

async function startNodeServer() {
  if (nodeServerProc) return;
  const serverEntry = path.join(MS_APP_DIR, 'server', 'index.js');
  if (!fileExists(serverEntry)) {
    throw new Error(`MediaStudio server entry not found: ${serverEntry}\n(這個檔案是 prepare-app.js 應該複製進來的，build 流程出問題)`);
  }
  log(`spawning node server (ELECTRON_RUN_AS_NODE): ${serverEntry}`);
  // Prepend the bundled ffmpeg/ffprobe dir so the server's `which ffmpeg`
  // resolves to our shipped static binaries — newbies need not install ffmpeg.
  // Bundled ffmpeg/ffprobe are staged per platform/arch at
  // APP_ROOT/resources/bin/<platform>-<arch> (see scripts/fetch-ffmpeg.js).
  const bundledBin = path.join(APP_ROOT, 'resources', 'bin', `${process.platform}-${process.arch}`);
  const pathWithBundledBin = fileExists(bundledBin)
    ? `${bundledBin}${path.delimiter}${process.env.PATH || ''}`
    : (process.env.PATH || '');
  nodeServerProc = spawn(process.execPath, [serverEntry], {
    cwd: MS_APP_DIR,
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '9810',
      PATH: pathWithBundledBin,
      MEDIASTUDIO_DATA: MS_DATA_DIR,
      PYTHON_BIN: resolvePythonBin(),
      MEDIASTUDIO_VOICE_HOST: '127.0.0.1',
      MEDIASTUDIO_VOICE_URL_XTTS: 'http://127.0.0.1:9811',
      MEDIASTUDIO_VOICE_URL_F5TTS: 'http://127.0.0.1:9812',
    }),
    windowsHide: true,
  });
  nodeServerProc.stdout.on('data', (b) => log('[node]', b.toString('utf8').trimEnd()));
  nodeServerProc.stderr.on('data', (b) => log('[node-err]', b.toString('utf8').trimEnd()));
  nodeServerProc.on('exit', (code) => { log(`node server exited code=${code}`); nodeServerProc = null; });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await probePort(9810)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('MediaStudio server failed to start in 30s; 詳細請看 ' + LOG_FILE);
}

function stopAll() {
  for (const p of [nodeServerProc, voiceProcs.xtts, voiceProcs.f5tts]) {
    if (p && !p.killed) { try { p.kill(); } catch {} }
  }
}

// ---------- windows ----------
let setupWin = null;
let mainWin = null;

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 720, height: 600, resizable: false,
    title: 'MediaStudio — 安裝精靈',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  setupWin.removeMenu();
  setupWin.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 820,
    title: 'MediaStudio',
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWin.removeMenu();
  mainWin.loadURL('http://127.0.0.1:9810');
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
}

// ---------- IPC ----------
ipcMain.handle('mediastudio:get-state', () => {
  const st = readState();
  return {
    setupDone: !!st.setupDone,
    version: app.getVersion(),
    paths: { userData: USER_DATA, appRoot: APP_ROOT, msAppDir: MS_APP_DIR, pythonExe: PY_EXE, log: LOG_FILE },
    have: {
      python: fileExists(PY_EXE),
      ffmpeg: !!which('ffmpeg'),
      ytdlp: !!which('yt-dlp'),
      msSource: fileExists(path.join(MS_APP_DIR, 'server', 'index.js')),
      clientBuilt: fileExists(path.join(MS_APP_DIR, 'client', 'dist', 'index.html'))
    }
  };
});

ipcMain.handle('mediastudio:open-log', () => shell.openPath(LOG_FILE));
ipcMain.handle('mediastudio:open-userdata', () => shell.openPath(USER_DATA));

ipcMain.handle('setup:run', async (event, options) => {
  const sender = event.sender;
  const send = (phase, message) => sender.send('setup:progress', { phase, message, ts: Date.now() });

  try {
    send('啟動', '檢查嵌入式 Python …');
    await ensurePython(send);

    if (options.installCorePackages !== false) {
      send('安裝', '安裝核心 Python 套件（faster-whisper / RapidOCR / silero-VAD / auto-editor / yt-dlp / huggingface_hub）…');
      await runPython(['-m', 'pip', 'install', '--no-warn-script-location', '--upgrade',
        'faster-whisper', 'huggingface_hub', 'rapidocr-onnxruntime',
        'opencv-python-headless', 'silero-vad', 'auto-editor', 'yt-dlp'], null, send);
    }

    if (options.installXtts) {
      send('安裝', '建立 XTTS venv 並安裝 Coqui TTS（~2 GB；5–10 分鐘）…');
      await runPython(['-m', 'venv', VENV_XTTS], null, send);
      const venvPy = path.join(VENV_XTTS, 'Scripts', 'python.exe');
      await runProcess(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], send);
      await runProcess(venvPy, ['-m', 'pip', 'install', 'coqui-tts', 'pypinyin', 'jieba'], send);
    }

    if (options.installF5tts) {
      send('安裝', '建立 F5-TTS venv 並安裝 F5-TTS（~3 GB 含 PyTorch；10–20 分鐘）…');
      await runPython(['-m', 'venv', VENV_F5TTS], null, send);
      const venvPy = path.join(VENV_F5TTS, 'Scripts', 'python.exe');
      await runProcess(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], send);
      await runProcess(venvPy, ['-m', 'pip', 'install', 'f5-tts'], send);
    }

    if (options.installCuda) {
      send('安裝', '偵測 NVIDIA GPU 並安裝 CUDA 版 PyTorch …');
      const hasNvidia = !!which('nvidia-smi');
      if (!hasNvidia) {
        send('日誌', '找不到 nvidia-smi，跳過 CUDA 安裝。');
      } else {
        const idx = 'https://download.pytorch.org/whl/cu121';
        await runPython(['-m', 'pip', 'install', '--upgrade', '--index-url', idx, 'torch', 'torchaudio'], null, send);
        if (options.installXtts) {
          const py = path.join(VENV_XTTS, 'Scripts', 'python.exe');
          if (fileExists(py)) await runProcess(py, ['-m', 'pip', 'install', '--upgrade', '--index-url', idx, 'torch', 'torchaudio'], send);
        }
        if (options.installF5tts) {
          const py = path.join(VENV_F5TTS, 'Scripts', 'python.exe');
          if (fileExists(py)) await runProcess(py, ['-m', 'pip', 'install', '--upgrade', '--index-url', idx, 'torch', 'torchaudio'], send);
        }
      }
    }

    if (options.downloadModels) {
      send('下載', '預下載 Whisper 模型（~5 GB）— 可關掉此視窗讓它在背景跑');
      await runPython([path.join(MS_APP_DIR, 'tools', 'download_models.py'), '--whisper'], null, send);
      if (options.installXtts) {
        const py = path.join(VENV_XTTS, 'Scripts', 'python.exe');
        await runProcess(py, [path.join(MS_APP_DIR, 'tools', 'download_models.py'), '--xtts'], send, { env: { COQUI_TOS_AGREED: '1' } });
      }
      if (options.installF5tts) {
        const py = path.join(VENV_F5TTS, 'Scripts', 'python.exe');
        await runProcess(py, [path.join(MS_APP_DIR, 'tools', 'download_models.py'), '--f5tts'], send);
      }
    }

    writeState({ setupDone: true, setupCompletedAt: Date.now() });
    send('完成', '設定完成！');
    return { ok: true };
  } catch (e) {
    log('setup failed:', e.stack || e.message);
    sender.send('setup:progress', { phase: '錯誤', message: (e && e.message) || String(e) });
    throw e;
  }
});

ipcMain.handle('voice:start', async (event) => {
  const sender = event.sender;
  const send = (msg) => sender.send('setup:progress', { phase: 'Voice', message: msg });
  const recipes = [
    ['xtts',  VENV_XTTS,  '9811', { COQUI_TOS_AGREED: '1', MEDIASTUDIO_VOICE_BACKEND: 'xtts' }],
    ['f5tts', VENV_F5TTS, '9812', { MEDIASTUDIO_VOICE_BACKEND: 'f5tts' }],
  ];
  for (const [key, dir, port, extraEnv] of recipes) {
    const py = path.join(dir, 'Scripts', 'python.exe');
    if (!fileExists(py)) { send(`(略過 ${key}: venv 不存在)`); continue; }
    if (voiceProcs[key]) { send(`(${key} 已在跑)`); continue; }
    const proc = spawn(py, [path.join(MS_APP_DIR, 'python', 'voice_server.py')], {
      cwd: MS_APP_DIR,
      env: Object.assign({}, process.env, extraEnv, {
        MEDIASTUDIO_VOICE_PORT: port,
        MEDIASTUDIO_VOICE_HOST: '127.0.0.1',
        PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
      }),
      windowsHide: true,
    });
    proc.stdout.on('data', (b) => log(`[voice-${key}]`, b.toString('utf8').trimEnd()));
    proc.stderr.on('data', (b) => log(`[voice-${key}-err]`, b.toString('utf8').trimEnd()));
    proc.on('exit', () => { voiceProcs[key] = null; });
    voiceProcs[key] = proc;
    send(`${key} :${port} 啟動`);
  }
  return { ok: true };
});

ipcMain.handle('launch:main', async () => {
  await startNodeServer();
  if (setupWin) { try { setupWin.close(); } catch {} setupWin = null; }
  if (!mainWin) createMainWindow(); else mainWin.focus();
  return { ok: true };
});

// ---------- lifecycle ----------
async function bootstrap() {
  try {
    const state = readState();
    // macOS path: no Windows-style embedded-Python setup wizard. The app boots
    // straight into the server + main window; dependency guidance is handled by
    // the in-app web onboarding (pip --user / on-demand conda). The Windows
    // setup wizard (createSetupWindow) is intentionally skipped here.
    if (IS_MAC) {
      await startNodeServer();
      createMainWindow();
      return;
    }
    if (!state.setupDone) {
      createSetupWindow();
    } else {
      try {
        await startNodeServer();
        createMainWindow();
      } catch (e) {
        log('main startup failed:', e.stack || e.message);
        dialog.showErrorBox('MediaStudio 啟動失敗', (e.message || String(e)) + `\n\n詳細 log：${LOG_FILE}`);
        // Fall back to setup wizard for diagnosis
        createSetupWindow();
      }
    }
  } catch (e) {
    log('bootstrap fatal:', e.stack || e.message);
    dialog.showErrorBox('MediaStudio fatal', (e.message || String(e)) + `\n\n詳細 log：${LOG_FILE}`);
    app.quit();
  }
}

app.whenReady().then(bootstrap);
app.on('window-all-closed', () => { stopAll(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => stopAll());

// Global error handlers so the user sees something useful instead of a blank crash
process.on('uncaughtException', (e) => {
  log('uncaughtException:', e.stack || e.message);
  try { dialog.showErrorBox('MediaStudio 未預期錯誤', (e.message || String(e)) + `\n\n${LOG_FILE}`); } catch {}
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection:', (e && e.stack) || e);
});
