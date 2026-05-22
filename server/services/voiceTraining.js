// Voice training: orchestrates `tools/build_voice_dataset.py` and tracks progress.
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuid } from 'uuid';
import { broadcast } from '../ws.js';
import { DATA_DIR, PYTHON_BIN, ROOT } from '../config.js';

const SCRIPT = path.join(ROOT, 'tools', 'build_voice_dataset.py');
const DEFAULT_DATASETS_ROOT = path.join(DATA_DIR, 'voice_datasets');
fs.mkdirSync(DEFAULT_DATASETS_ROOT, { recursive: true });

const trainings = new Map();   // id -> training record

function emit(t, state, progress, message, extra) {
  t.state = state;
  if (progress != null) t.progress = progress;
  if (message != null) t.message = message;
  if (extra) Object.assign(t, extra);
  broadcast('voice-train', publicTraining(t));
}

function publicTraining(t) {
  return {
    id: t.id, state: t.state, progress: t.progress, message: t.message,
    source: t.source, options: t.options, datasetDir: t.datasetDir,
    chunks: t.chunks, totalSeconds: t.totalSeconds, error: t.error,
    listPath: t.listPath, metadataPath: t.metadataPath, wavsDir: t.wavsDir,
    createdAt: t.createdAt, finishedAt: t.finishedAt
  };
}

export function listTrainings() {
  return Array.from(trainings.values()).sort((a, b) => b.createdAt - a.createdAt).map(publicTraining);
}

export function getTraining(id) {
  const t = trainings.get(id);
  return t ? publicTraining(t) : null;
}

export function deleteTraining(id, { removeFiles = false } = {}) {
  const t = trainings.get(id);
  if (!t) return false;
  if (t.proc && !t.proc.killed) { try { t.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  if (removeFiles && t.datasetDir && fs.existsSync(t.datasetDir)) {
    try { fs.rmSync(t.datasetDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  trainings.delete(id);
  return true;
}

/**
 * Start building a fine-tune dataset for one speaker.
 * source: { type:'file'|'folder', value:string } — file = single video/audio, folder = batch
 * options: { speaker, language, model, limitMin, minSec, maxSec, sr }
 * Returns the public training record.
 */
export function startBuild(source, options = {}) {
  if (!source || !source.value) throw new Error('source required');
  if (!fs.existsSync(source.value)) throw new Error(`找不到來源：${source.value}`);

  const id = uuid();
  const speaker = (options.speaker || 'speaker1').replace(/[\/\\?%*:|"<>\s]+/g, '_').slice(0, 40);
  const datasetDir = path.join(DEFAULT_DATASETS_ROOT, `${speaker}-${id.slice(0, 8)}`);
  fs.mkdirSync(datasetDir, { recursive: true });

  const args = [
    SCRIPT,
    '--input', source.value,
    '--out', datasetDir,
    '--speaker', speaker,
    '--language', options.language || 'zh',
    '--model', options.model || 'large-v3-turbo',
    '--json-events'
  ];
  if (options.limitMin != null) args.push('--limit-min', String(options.limitMin));
  if (options.minSec != null) args.push('--min-sec', String(options.minSec));
  if (options.maxSec != null) args.push('--max-sec', String(options.maxSec));
  if (options.sr != null) args.push('--sr', String(options.sr));

  const t = {
    id, source, options: { ...options, speaker },
    datasetDir, state: 'starting', progress: 0,
    message: '啟動中…', chunks: 0, totalSeconds: 0,
    createdAt: Date.now(), proc: null
  };
  trainings.set(id, t);

  // Force UTF-8 stdio so CJK transcript text in the dataset isn't mangled on Windows.
  const proc = spawn(PYTHON_BIN, args, { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  t.proc = proc;
  let buf = '';
  let stderrTail = '';

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      handleEvent(t, evt);
    }
  });
  proc.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-4000); });
  proc.on('error', (e) => {
    emit(t, 'error', t.progress, `啟動失敗：${e.message}`, { error: e.message, finishedAt: Date.now() });
  });
  proc.on('close', (code) => {
    if (t.state === 'done' || t.state === 'error' || t.state === 'canceled') return;
    if (code === 0) {
      // Read summary.json if present to fill in fields
      try {
        const sj = path.join(t.datasetDir, 'summary.json');
        if (fs.existsSync(sj)) {
          const s = JSON.parse(fs.readFileSync(sj, 'utf8'));
          t.chunks = s.chunks; t.totalSeconds = s.total_seconds;
          t.listPath = s.list_path; t.metadataPath = s.metadata_path; t.wavsDir = s.wavs_dir;
        }
      } catch { /* ignore */ }
      emit(t, 'done', 1, `完成：${t.chunks} 段、${(t.totalSeconds / 60).toFixed(1)} 分鐘`, { finishedAt: Date.now() });
    } else {
      emit(t, 'error', t.progress, `worker exit ${code}\n${stderrTail.slice(-500)}`, { error: stderrTail.slice(-500), finishedAt: Date.now() });
    }
  });

  emit(t, 'running', 0.02, '排程中…');
  return publicTraining(t);
}

function handleEvent(t, evt) {
  switch (evt.event) {
    case 'start':
      emit(t, 'running', 0.05, `共 ${evt.sources} 個來源檔，輸出到 ${evt.out}`);
      break;
    case 'file':
      emit(t, 'running', 0.1 + 0.85 * ((evt.index || 0) / Math.max(1, evt.total || 1)),
        `處理 ${evt.name} (${(evt.index || 0) + 1}/${evt.total})…`);
      break;
    case 'progress':
      emit(t, 'running', t.progress, evt.msg || '');
      break;
    case 'chunk':
      t.chunks = evt.n; t.totalSeconds = evt.total_seconds;
      const pct = evt.pct != null ? Math.min(0.98, 0.1 + 0.85 * evt.pct) : t.progress;
      emit(t, 'running', pct, `已切 ${evt.n} 段、${(evt.total_seconds / 60).toFixed(1)} 分鐘 · 「${evt.sample || ''}…」`);
      break;
    case 'done':
      t.chunks = evt.chunks; t.totalSeconds = evt.total_seconds;
      t.listPath = evt.list_path; t.metadataPath = evt.metadata_path; t.wavsDir = evt.wavs_dir;
      emit(t, 'done', 1, `完成：${evt.chunks} 段、${(evt.total_seconds / 60).toFixed(1)} 分鐘`, { finishedAt: Date.now() });
      break;
    case 'error':
      emit(t, 'error', t.progress, `${evt.file || ''}: ${evt.message}`, { error: evt.message, finishedAt: Date.now() });
      break;
  }
}

/**
 * Sample N preview chunks (audio paths + text) from a completed dataset.
 * Used by the wizard's review step.
 */
export function sampleDataset(id, n = 5) {
  const t = trainings.get(id);
  if (!t || !t.listPath || !fs.existsSync(t.listPath)) return null;
  const lines = fs.readFileSync(t.listPath, 'utf8').split('\n').filter(Boolean);
  const step = Math.max(1, Math.floor(lines.length / n));
  const picks = [];
  for (let i = 0; i < lines.length && picks.length < n; i += step) {
    const [audioPath, speaker, language, text] = lines[i].split('|');
    if (audioPath && fs.existsSync(audioPath)) picks.push({ audioPath, speaker, language, text });
  }
  return picks;
}
