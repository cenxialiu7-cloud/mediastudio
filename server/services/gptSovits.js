// Drives GPT-SoVITS via its officially supported path:
//   ~/.mediastudio-miniforge/                          (Miniforge — open-source conda)
//   ~/.mediastudio-miniforge/envs/gpt-sovits/python    (Python 3.10 conda env)
//   ~/.mediastudio-gpt-sovits/                         (cloned GPT-SoVITS repo)
//
// We use Miniforge because raw venv + pip cannot install GPT-SoVITS's transitive
// deps (funasr → python_mecab_ko, pyopenjtalk, pydantic-core) on macOS / fresh
// Python 3.14 — they require system tools (mecab-config, cmake) that conda-forge
// ships cross-platform.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { broadcast } from '../ws.js';
import { ROOT } from '../config.js';

const HOME = os.homedir();
export const GS_ROOT = process.env.MEDIASTUDIO_GPTSOVITS_ROOT || path.join(HOME, '.mediastudio-gpt-sovits');
export const MINIFORGE = process.env.MEDIASTUDIO_MINIFORGE || path.join(HOME, '.mediastudio-miniforge');
const ENV_NAME = process.env.MEDIASTUDIO_GPTSOVITS_ENV || 'gpt-sovits';
const ENV_DIR = path.join(MINIFORGE, 'envs', ENV_NAME);
export const ENV_PY = process.platform === 'win32'
  ? path.join(ENV_DIR, 'python.exe')
  : path.join(ENV_DIR, 'bin', 'python');
const CONDA_BIN = process.platform === 'win32'
  ? path.join(MINIFORGE, 'Scripts', 'conda.exe')
  : path.join(MINIFORGE, 'bin', 'conda');

const INSTALL_SCRIPT = path.join(ROOT, 'tools', 'install_gpt_sovits.py');
const WEBUI_PORT = Number(process.env.GPTSOVITS_WEBUI_PORT || 9874);
const API_PORT = Number(process.env.GPTSOVITS_API_PORT || 9880);

const procs = { install: null, webui: null, api: null };

// Build a spawn env that strips HTTP(S)_PROXY / ALL_PROXY (both cases) and
// forces no_proxy/NO_PROXY to include loopback. Gradio's launch() does a
// `requests.head("http://127.0.0.1:<port>/")` reachability probe; if the
// parent shell has *_PROXY set (Clash/ClashX/Surge/V2Ray/VPN — common on
// macOS Chinese-user setups, also Docker rare), the probe goes through the
// proxy which 502s, and Gradio raises:
//   ValueError: When localhost is not accessible, a shareable link must be created.
// GPT-SoVITS's webui.py only clears lowercase `all_proxy` — uppercase keys
// still leak through. We fix it at the spawn boundary instead.
function spawnEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  env.no_proxy = 'localhost,127.0.0.1,::1,0.0.0.0';
  env.NO_PROXY = 'localhost,127.0.0.1,::1,0.0.0.0';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.TERM = process.env.TERM || 'xterm-256color';
  return { ...env, ...extra };
}
const lastErr = { install: '', webui: '', api: '' };
let venvHealthCache = null;
let venvHealthCacheTs = 0;

function emit(kind, state, progress, message, extra = {}) {
  broadcast('gpt-sovits', { kind, state, progress, message, ts: Date.now(), ...extra });
}

function probeHttp(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode != null); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }

function checkEnvHealth() {
  if (!fileExists(ENV_PY)) return { ok: false, missing: ['conda-env'] };
  if (venvHealthCache && Date.now() - venvHealthCacheTs < 30000) return venvHealthCache;
  const probe = "import importlib, json, sys\nmods=['torch','gradio','librosa','psutil','yaml','transformers']\nmissing=[m for m in mods if not _t(m)]\ndef _t(m):\n  try: importlib.import_module(m); return True\n  except Exception: return False\nsys.stdout.write(json.dumps({'missing':missing}))";
  // Note: probe has fwd-reference issue; use simpler form:
  const probe2 =
    "import importlib, json, sys\n" +
    "ok=[]; missing=[]\n" +
    "for m in ['torch','gradio','librosa','psutil','yaml','transformers']:\n" +
    "  try: importlib.import_module(m); ok.append(m)\n" +
    "  except Exception: missing.append(m)\n" +
    "sys.stdout.write(json.dumps({'missing':missing}))";
  try {
    const r = spawnSync(ENV_PY, ['-c', probe2], { encoding: 'utf8', timeout: 12000 });
    if (r.status !== 0) {
      venvHealthCache = { ok: false, missing: ['python-died'], detail: (r.stderr || '').slice(-300) };
    } else {
      const parsed = JSON.parse(r.stdout || '{}');
      venvHealthCache = { ok: (parsed.missing || []).length === 0, missing: parsed.missing || [] };
    }
  } catch (e) {
    venvHealthCache = { ok: false, missing: ['probe-error'], detail: e.message };
  }
  venvHealthCacheTs = Date.now();
  return venvHealthCache;
}

function countTree(dir) {
  let n = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) n += countTree(path.join(dir, ent.name));
      else n += 1;
    }
  } catch {}
  return n;
}

export function status() {
  const miniforgeInstalled = fileExists(CONDA_BIN);
  const envExists = fileExists(ENV_PY);
  const repoCloned = fileExists(path.join(GS_ROOT, 'webui.py'));
  const pretrainedDir = path.join(GS_ROOT, 'GPT_SoVITS', 'pretrained_models');
  const pretrainedCount = fileExists(pretrainedDir) ? countTree(pretrainedDir) : 0;
  const installing = !!procs.install && !procs.install.killed;
  const env = envExists && repoCloned && !installing ? checkEnvHealth() : { ok: false, missing: envExists ? [] : ['conda-env'] };
  return {
    installed: env.ok && repoCloned,
    installedShallow: envExists && repoCloned,
    miniforgeInstalled,
    envExists,
    repoCloned,
    env,
    envPython: ENV_PY,
    miniforge: MINIFORGE,
    root: GS_ROOT,
    pretrainedCount,
    pretrainedReady: pretrainedCount >= 20,
    webui: { running: !!procs.webui && !procs.webui.killed, port: WEBUI_PORT, url: `http://127.0.0.1:${WEBUI_PORT}`, lastErr: lastErr.webui.slice(-600) || null },
    api: { running: !!procs.api && !procs.api.killed, port: API_PORT, url: `http://127.0.0.1:${API_PORT}`, lastErr: lastErr.api.slice(-600) || null },
    installing,
    installErr: lastErr.install.slice(-600) || null,
  };
}

// Pick a Python >= 3.10 to run the installer (installer needs to download Miniforge,
// run subprocess.Popen — anything 3.10+ works). Falls back to whatever python3
// MediaStudio is already using.
function findBootstrapPython() {
  const tryFile = (p) => { try { return fs.existsSync(p) ? p : null; } catch { return null; } };
  const tryWhich = (n) => {
    for (const d of (process.env.PATH || '').split(path.delimiter)) {
      const p = path.join(d, n + (process.platform === 'win32' ? '.exe' : ''));
      if (tryFile(p)) return p;
    }
    return null;
  };
  const okVer = (p) => {
    try {
      const r = spawnSync(p, ['-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8' });
      const m = (r.stdout || '').match(/\((\d+),\s*(\d+)\)/);
      if (!m) return false;
      return +m[1] === 3 && +m[2] >= 8;   // installer itself only needs urllib + subprocess
    } catch { return false; }
  };
  const candidates = [
    ...(process.platform === 'darwin'
      ? ['/opt/homebrew/bin/python3.11', '/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3.10',
         '/opt/homebrew/bin/python3.14', '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3']
      : []),
    'python3', 'python', 'python3.11', 'python3.12', 'python3.10'
  ];
  for (const c of candidates) {
    const p = c.includes('/') || c.includes('\\') ? tryFile(c) : tryWhich(c);
    if (p && okVer(p)) return p;
  }
  return null;
}

export async function install(opts = {}) {
  if (procs.install) throw new Error('GPT-SoVITS 已在安裝中，請稍候');
  fs.mkdirSync(path.dirname(MINIFORGE), { recursive: true });
  emit('install', 'running', 0.01, '啟動安裝程序…');

  const py = findBootstrapPython();
  if (!py) {
    const e = '找不到 Python (>=3.8)。macOS 請執行 `brew install python@3.11` 後重試。';
    emit('install', 'error', 0, e); throw new Error(e);
  }
  const args = [INSTALL_SCRIPT,
    '--root', GS_ROOT,
    '--miniforge', MINIFORGE,
    '--env-name', ENV_NAME,
    '--source', opts.source || 'HF',
  ];
  if (opts.device) args.push('--device', opts.device);
  if (opts.skipPretrained) args.push('--skip-pretrained');

  return new Promise((resolve, reject) => {
    const proc = spawn(py, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', TERM: process.env.TERM || 'xterm-256color' } });
    procs.install = proc;
    lastErr.install = '';
    venvHealthCache = null;
    let buf = '';
    // Keep a ring buffer of recent log lines so errors carry context (the
    // installer pipes install.sh stderr into stdout as event=log lines, so
    // proc.stderr is normally empty — without this buffer we'd show "(無)"
    // when install.sh fails deep inside).
    const recentLogs = [];
    const remember = (line) => {
      recentLogs.push(line);
      if (recentLogs.length > 80) recentLogs.shift();
      lastErr.install = recentLogs.join('\n').slice(-4000);
    };
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let evt; try { evt = JSON.parse(line); } catch { remember(line); continue; }
        if (evt.event === 'step') { remember(`[step] ${evt.name}: ${evt.msg || ''}`); emit('install', 'running', evt.progress ?? null, evt.msg || evt.name); }
        else if (evt.event === 'log') { remember(evt.line); emit('install', 'running', null, evt.line.slice(0, 200)); }
        else if (evt.event === 'done') emit('install', 'done', 1, '✓ 安裝完成', evt);
        else if (evt.event === 'error') { remember(`[error] ${evt.message}`); emit('install', 'error', 0, evt.message); }
      }
    });
    proc.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      for (const line of s.split('\n')) if (line.trim()) remember(line);
      emit('install', 'running', null, s.trim().slice(-200));
    });
    proc.on('error', (e) => { procs.install = null; emit('install', 'error', 0, e.message); reject(e); });
    proc.on('close', (code) => {
      procs.install = null;
      venvHealthCache = null;
      if (code === 0) { emit('install', 'done', 1, '✓ 安裝完成'); resolve({ ok: true }); }
      else {
        const tail = lastErr.install || '(沒有捕捉到日誌 — 請檢查 server 終端機)';
        emit('install', 'error', 0, `installer exited ${code}\n${tail.slice(-800)}`);
        reject(new Error(`installer exited ${code}`));
      }
    });
  });
}

export async function startWebui() {
  if (procs.webui && !procs.webui.killed && await probeHttp(WEBUI_PORT, 1000)) {
    return { ...status().webui, ready: true };
  }
  if (!fileExists(ENV_PY) || !fileExists(path.join(GS_ROOT, 'webui.py'))) {
    throw new Error('GPT-SoVITS 尚未安裝（conda env 或 repo 缺）');
  }
  const health = checkEnvHealth();
  if (!health.ok) throw new Error(`conda env 缺套件：${(health.missing || []).join(', ')}。請重跑「自動安裝」`);

  const env = spawnEnv({ is_share: 'False', GRADIO_SERVER_NAME: '127.0.0.1' });
  const proc = spawn(ENV_PY, ['webui.py'], { cwd: GS_ROOT, env });
  procs.webui = proc;
  lastErr.webui = '';
  emit('webui', 'running', 0.05, 'GPT-SoVITS WebUI 啟動中…（首次載入 30–60 秒）');
  proc.stdout.on('data', (b) => { const s = b.toString('utf8'); lastErr.webui = (lastErr.webui + s).slice(-3000); emit('webui', 'running', null, s.trim().slice(-200)); });
  proc.stderr.on('data', (b) => { const s = b.toString('utf8'); lastErr.webui = (lastErr.webui + s).slice(-3000); emit('webui', 'running', null, s.trim().slice(-200)); });
  proc.on('close', (code) => { procs.webui = null; emit('webui', code === 0 ? 'done' : 'error', 0, `webui exited ${code}\n${lastErr.webui.slice(-300)}`); });
  proc.on('error', (e) => { procs.webui = null; emit('webui', 'error', 0, e.message); });

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (procs.webui == null) throw new Error(`WebUI 啟動失敗 (exit). 最後輸出：\n${lastErr.webui.slice(-500)}`);
    if (await probeHttp(WEBUI_PORT, 700)) {
      emit('webui', 'ready', 1, `WebUI 已就緒：http://127.0.0.1:${WEBUI_PORT}`);
      return { ...status().webui, ready: true };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`WebUI 90 秒後仍無回應。最後輸出：\n${lastErr.webui.slice(-500)}`);
}

export async function stopWebui() {
  if (procs.webui && !procs.webui.killed) { try { procs.webui.kill('SIGTERM'); } catch {} procs.webui = null; emit('webui', 'stopped', 0, '已停止'); }
  return { ok: true };
}

export async function startApi() {
  if (procs.api && !procs.api.killed) return status().api;
  if (!fileExists(ENV_PY)) throw new Error('GPT-SoVITS 尚未安裝');
  const env = spawnEnv();
  const proc = spawn(ENV_PY, ['api_v2.py', '-a', '127.0.0.1', '-p', String(API_PORT)], { cwd: GS_ROOT, env });
  procs.api = proc;
  emit('api', 'running', 0.05, 'GPT-SoVITS API 啟動中…');
  proc.stdout.on('data', (b) => emit('api', 'running', null, b.toString('utf8').trim().slice(-200)));
  proc.stderr.on('data', (b) => emit('api', 'running', null, b.toString('utf8').trim().slice(-200)));
  proc.on('close', (code) => { procs.api = null; emit('api', code === 0 ? 'done' : 'error', 0, `api exited ${code}`); });
  proc.on('error', (e) => { procs.api = null; emit('api', 'error', 0, e.message); });
  return status().api;
}

export async function stopApi() {
  if (procs.api && !procs.api.killed) { try { procs.api.kill('SIGTERM'); } catch {} procs.api = null; emit('api', 'stopped', 0, '已停止'); }
  return { ok: true };
}

export function listTrainedModels() {
  // GPT-SoVITS writes trained checkpoints per VERSION into different dirs:
  //   SoVITS_weights_v2/ + GPT_weights_v2/
  //   SoVITS_weights_v2Pro/ + GPT_weights_v2Pro/      (v2Pro)
  //   SoVITS_weights_v2ProPlus/ + GPT_weights_v2ProPlus/ (v2ProPlus)
  // We scan ALL of them so a model trained as v2Pro shows up in the picker.
  const out = [];
  const versions = ['v2', 'v2Pro', 'v2ProPlus'];
  for (const v of versions) {
    const sd = path.join(GS_ROOT, `SoVITS_weights_${v}`);
    const gd = path.join(GS_ROOT, `GPT_weights_${v}`);
    if (fileExists(sd)) for (const f of fs.readdirSync(sd))
      if (f.endsWith('.pth')) out.push({ name: f, path: path.join(sd, f), kind: 'sovits', version: v });
    if (fileExists(gd)) for (const f of fs.readdirSync(gd))
      if (f.endsWith('.ckpt')) out.push({ name: f, path: path.join(gd, f), kind: 'gpt', version: v });
  }
  // SoVITS files: `<name>_e<epoch>_s<step>.pth`
  // GPT files:    `<name>-e<epoch>.ckpt`
  const groups = {};
  for (const m of out) {
    const key = (m.name.match(/^(.+?)[-_]e\d+/) || [null, m.name])[1];
    const k = `${m.version}::${key}`;
    groups[k] = groups[k] || { name: key, version: m.version, sovits: null, gpt: null };
    groups[k][m.kind] = m;
  }
  return Object.values(groups).filter((g) => g.sovits && g.gpt);
}

export function stopAll() {
  for (const k of ['install', 'webui', 'api']) {
    const p = procs[k]; if (p && !p.killed) { try { p.kill('SIGTERM'); } catch {} }
  }
}

// Convenience: list voice training datasets (in data/voice_datasets/) so the UI
// can auto-suggest them in the GPT-SoVITS card without the user picking a path.
export function listLocalDatasets() {
  const root = path.join(ROOT, 'data', 'voice_datasets');
  if (!fileExists(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    const summaryFile = path.join(dir, 'summary.json');
    const listFile = path.join(dir, 'list.txt');
    if (!fileExists(listFile)) continue;
    let summary = null;
    try { summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')); } catch {}
    out.push({
      id: name,
      dir,
      listPath: listFile,
      metadataPath: fileExists(path.join(dir, 'metadata.csv')) ? path.join(dir, 'metadata.csv') : null,
      wavsDir: fileExists(path.join(dir, 'wavs')) ? path.join(dir, 'wavs') : null,
      chunks: summary?.chunks ?? null,
      totalMinutes: summary?.total_seconds ? +(summary.total_seconds / 60).toFixed(1) : null,
      speaker: summary?.speaker ?? null,
      language: summary?.language ?? null
    });
  }
  out.sort((a, b) => (b.chunks || 0) - (a.chunks || 0));
  return out;
}
