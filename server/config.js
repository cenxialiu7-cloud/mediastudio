import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Make pip-installed CLIs (auto-editor, etc) visible to spawned subprocesses.
// IMPORTANT: only prepend USER-LOCAL pip bin dirs. Don't prepend /opt/homebrew/bin
// because that would shadow the system `python3` and break already-installed
// packages that live under a specific Python's site-packages. APPEND those as a
// fallback only.
(function augmentPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const prepend = [];
  const append = [];
  if (os.platform() === 'darwin' && home) {
    for (const v of ['3.14', '3.13', '3.12', '3.11', '3.10', '3.9']) prepend.push(`${home}/Library/Python/${v}/bin`);
    append.push('/opt/homebrew/bin', '/usr/local/bin');
  } else if (os.platform() === 'win32' && process.env.APPDATA) {
    for (const v of ['Python314','Python313','Python312','Python311','Python310','Python39']) prepend.push(`${process.env.APPDATA}\\Python\\${v}\\Scripts`);
  }
  const sep = os.platform() === 'win32' ? ';' : ':';
  process.env.PATH = `${prepend.join(sep)}${sep}${process.env.PATH || ''}${sep}${append.join(sep)}`;
})();

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.MEDIASTUDIO_DATA || path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');       // downloaded / uploaded source media
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');       // extracted audio for ASR

// OUTPUT_DIR is mutable at runtime — settings.js updates this via setOutputDir().
// ES-module `let` exports are live bindings, so importers always see the
// current value. Read it at call-time (inside handlers), not at module load.
export let OUTPUT_DIR = path.join(DATA_DIR, 'output');       // transcripts / subtitles / edited media
export function setOutputDir(p) { OUTPUT_DIR = p; }

for (const d of [DATA_DIR, MEDIA_DIR, AUDIO_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

export const PORT = Number(process.env.PORT || 9810);

// Pick the best Python: prefer one that can actually import a whisper backend
// (mlx_whisper or faster_whisper). Multiple Pythons commonly coexist on macOS
// (system /usr/bin/python3 vs. Homebrew /opt/homebrew/bin/python3), and pip
// `--user` installs land in *one specific* python's user-site. If the wrong
// python is picked, ASR fails with "No module named 'mlx_whisper'".
// Probe each candidate and pin the first that has the modules; fall back to
// plain "python3" so existing setups don't break.
function probeWhisperCandidate(py) {
  try {
    const r = spawnSync(py, ['-c', 'import mlx_whisper' ], { timeout: 5000 });
    if (r.status === 0) return 'mlx';
    const r2 = spawnSync(py, ['-c', 'import faster_whisper'], { timeout: 5000 });
    if (r2.status === 0) return 'faster';
  } catch { /* ignore */ }
  return null;
}
function pickPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (os.platform() === 'win32') return 'python';
  const candidates = ['python3', '/usr/bin/python3'];
  const home = process.env.HOME || '';
  for (const v of ['3.13', '3.12', '3.11', '3.10', '3.9']) {
    candidates.push(`/opt/homebrew/opt/python@${v}/bin/python3`);
    if (home) candidates.push(`${home}/.pyenv/versions/${v}/bin/python3`);
  }
  candidates.push('/opt/homebrew/bin/python3');  // last — usually 3.14, often missing libs
  for (const py of candidates) {
    if (probeWhisperCandidate(py)) return py;
  }
  return 'python3';  // fallback; will fail later with a clear error
}
export const PYTHON_BIN = pickPython();

export const DEFAULTS = {
  engine: 'asr',            // 'asr' (Whisper) | 'ocr' (read burned-in subtitles)
  model: 'medium',          // tiny | base | small | medium | large-v3 | large-v3-turbo
  language: 'auto',         // 'auto' or ISO code e.g. 'zh', 'en', 'ja'
  task: 'transcribe',       // 'transcribe' | 'translate' (translate => English)
  backend: 'auto',          // auto | mlx | faster (mlx preferred on Apple Silicon)
  formats: ['srt', 'vtt', 'txt-ts', 'txt', 'json'],
  diarize: false,           // requires pyannote + HF token (env HF_TOKEN)
  computeType: 'auto'       // auto | int8 | int8_float16 | float16 | float32
};
