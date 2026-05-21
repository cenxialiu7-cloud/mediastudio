import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { broadcast } from './ws.js';
import { OUTPUT_DIR, DEFAULTS } from './config.js';
import { download as ytDownload, probeUrl } from './services/ytdlp.js';
import { extractAudio, probeDuration } from './services/ffmpeg.js';
import { transcribe } from './services/transcribe.js';
import { ocrSubtitles } from './services/ocrSubs.js';
import { FORMATTERS } from './services/subtitles.js';
import { sanitizeSlug, slugFromUrl, makePrefix } from './utils/slug.js';

/** @typedef {'queued'|'downloading'|'extracting'|'transcribing'|'writing'|'done'|'error'|'canceled'} JobState */

const jobs = new Map();      // id -> job
const order = [];            // ids, oldest first
let running = 0;
const MAX_CONCURRENT = Number(process.env.MEDIASTUDIO_CONCURRENCY || 1);

function publicJob(j) {
  return {
    id: j.id, state: j.state, source: j.source, title: j.title,
    slug: j.slug, prefix: j.prefix,
    progress: j.progress, message: j.message, error: j.error,
    language: j.language, duration: j.duration,
    createdAt: j.createdAt, finishedAt: j.finishedAt,
    options: j.options,
    outputs: j.outputs ? Object.keys(j.outputs) : [],
    artifacts: (j.artifacts || []).map((a) => ({ name: a.name, kind: a.kind, label: a.label || a.name })),
    hasMedia: !!j.mediaPath,
    segmentCount: j.segments ? j.segments.length : 0
  };
}

function emit(j) {
  broadcast('job', publicJob(j));
}

function setState(j, state, message) {
  j.state = state;
  if (message != null) j.message = message;
  emit(j);
}

function setProgress(j, pct, message) {
  if (pct != null) j.progress = Math.max(0, Math.min(1, pct));
  if (message != null) j.message = message;
  emit(j);
}

export function addJob(source, options = {}) {
  const id = uuid();
  const rawTitle = source.type === 'file'
    ? path.basename(source.value)
    : slugFromUrl(source.value);
  const slug = sanitizeSlug(rawTitle);
  const job = {
    id,
    source,                                  // { type:'url'|'file', value:string }
    title: slug,
    slug,
    prefix: makePrefix(slug, id),
    options: { ...DEFAULTS, ...options },
    state: 'queued',
    progress: 0,
    message: '排隊中',
    error: null,
    language: null,
    duration: null,
    segments: null,
    mediaPath: null,
    audioPath: null,
    outputs: null,                           // { srt: filepath, ... }
    artifacts: [],                           // [{ name, kind:'video'|'audio', label, path }]
    createdAt: Date.now(),
    finishedAt: null,
    canceled: false
  };
  jobs.set(id, job);
  order.push(id);
  emit(job);
  pump();
  return publicJob(job);
}

export function listJobs() {
  return order.map((id) => publicJob(jobs.get(id))).reverse();
}

export function getJob(id) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

export function getSegments(id) {
  const j = jobs.get(id);
  return j ? j.segments : null;
}

export function getOutputPath(id, format) {
  const j = jobs.get(id);
  if (!j || !j.outputs) return null;
  return j.outputs[format] || null;
}

export function getMediaPath(id) {
  const j = jobs.get(id);
  return j && j.mediaPath && fs.existsSync(j.mediaPath) ? j.mediaPath : null;
}

export function getJobRaw(id) { return jobs.get(id) || null; }

export function getJobPrefix(id) {
  const j = jobs.get(id);
  return (j && j.prefix) || id;
}

export function addArtifact(id, art) {
  const j = jobs.get(id);
  if (!j) return;
  j.artifacts = (j.artifacts || []).filter((a) => a.name !== art.name);
  j.artifacts.push(art);
  emit(j);
}

export function getArtifactPath(id, name) {
  const j = jobs.get(id);
  if (!j) return null;
  const a = (j.artifacts || []).find((x) => x.name === name);
  return a && fs.existsSync(a.path) ? a.path : null;
}

export function touch(id) { const j = jobs.get(id); if (j) emit(j); }

export function cancelJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.state === 'done' || j.state === 'error') return false;
  j.canceled = true;
  if (j.state === 'queued') { setState(j, 'canceled', '已取消'); j.finishedAt = Date.now(); }
  return true;
}

export function removeJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (['queued', 'downloading', 'extracting', 'transcribing', 'writing'].includes(j.state)) return false;
  jobs.delete(id);
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  broadcast('job-removed', { id });
  return true;
}

/** Re-write subtitle outputs from (possibly edited) segments. */
export function reExport(id, segments) {
  const j = jobs.get(id);
  if (!j) throw new Error('job not found');
  j.segments = segments;
  writeOutputs(j);
  setState(j, 'done', '已重新匯出');
  return publicJob(j);
}

function writeOutputs(j) {
  const payload = {
    source: j.source, title: j.title, language: j.language,
    duration: j.duration, options: j.options, segments: j.segments
  };
  const outputs = {};
  for (const fmt of j.options.formats) {
    const f = FORMATTERS[fmt];
    if (!f) continue;
    const file = path.join(OUTPUT_DIR, `${j.prefix}.${f.ext}`);
    fs.writeFileSync(file, f.fn(payload), 'utf8');
    outputs[fmt] = file;
  }
  j.outputs = outputs;
}

async function processJob(j) {
  try {
    // 1. Acquire the media file.
    if (j.source.type === 'url') {
      // Probe for the real video title first so output filenames carry it.
      setState(j, 'downloading', '取得影片資訊中…');
      try {
        const meta = await probeUrl(j.source.value);
        if (meta?.title) {
          j.slug = sanitizeSlug(meta.title);
          j.prefix = makePrefix(j.slug, j.id);
          j.title = j.slug;
          emit(j);
        }
      } catch { /* ignore — fall back to URL-derived slug */ }
      setState(j, 'downloading', '下載中…');
      j.mediaPath = await ytDownload(j.source.value, j.prefix, (line) => setProgress(j, null, line.slice(0, 120)));
    } else {
      if (!fs.existsSync(j.source.value)) throw new Error(`找不到檔案: ${j.source.value}`);
      j.mediaPath = j.source.value;
    }
    if (j.canceled) throw new CancelError();
    j.duration = await probeDuration(j.mediaPath);
    setProgress(j, 0.1, '取得媒體完成');

    let res;
    if (j.options.engine === 'ocr') {
      // 2-OCR. Skip ASR: read burned-in subtitles from the video frames.
      setState(j, 'transcribing', '影片畫面字幕 OCR 中…');
      const outJson = path.join(OUTPUT_DIR, `${j.prefix}.ocr.json`);
      const r = await ocrSubtitles(j.mediaPath, outJson, {
        fps: j.options.ocrFps || 2,
        bandTop: j.options.ocrBandTop ?? 0.70,
        bandBottom: j.options.ocrBandBottom ?? 1.0,
        minDuration: 0.3
      }, (pct, msg) => setProgress(j, pct == null ? null : 0.10 + 0.85 * pct, msg));
      if (j.canceled) throw new CancelError();
      res = { segments: r.segments || [], language: 'ocr', duration: r.duration, info: { backend: 'ocr', engine: r.engine } };
    } else {
      // 2-ASR. Audio extract then Whisper.
      setState(j, 'extracting', '抽取音訊…');
      j.audioPath = await extractAudio(j.mediaPath, j.prefix, () => {});
      if (j.canceled) throw new CancelError();
      setProgress(j, 0.18, '音訊就緒');

      setState(j, 'transcribing', '語音轉文字中…');
      res = await transcribe(j.audioPath, j.options, (pct, msg) => {
        const mapped = pct == null ? null : 0.18 + 0.77 * pct;
        setProgress(j, mapped, msg);
      });
    }
    if (j.canceled) throw new CancelError();
    j.segments = res.segments || [];
    j.language = res.language || j.options.language;
    if (res.duration) j.duration = res.duration;

    // 4. Write outputs.
    setState(j, 'writing', '輸出字幕/逐字稿…');
    writeOutputs(j);

    j.finishedAt = Date.now();
    setProgress(j, 1, `完成 (${j.segments.length} 段，語言 ${j.language || '未知'})`);
    setState(j, 'done', `完成 (${j.segments.length} 段)`);
  } catch (e) {
    j.finishedAt = Date.now();
    if (e instanceof CancelError || j.canceled) {
      setState(j, 'canceled', '已取消');
    } else {
      j.error = e.message || String(e);
      setState(j, 'error', `失敗: ${j.error.split('\n')[0]}`);
      // keep full error available
      j.message = j.error;
      emit(j);
    }
  } finally {
    // tidy temp audio
    try { if (j.audioPath && fs.existsSync(j.audioPath)) fs.unlinkSync(j.audioPath); } catch { /* ignore */ }
    running--;
    pump();
  }
}

class CancelError extends Error {}

function pump() {
  while (running < MAX_CONCURRENT) {
    const next = order.map((id) => jobs.get(id)).find((j) => j && j.state === 'queued' && !j.canceled);
    if (!next) break;
    running++;
    setState(next, 'downloading', '開始處理…');
    processJob(next);
  }
}
