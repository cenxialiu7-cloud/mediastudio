// Voice profile library: save/load named reference clips for voice cloning.
// Each profile = a folder under data/voices/<id>/ with a profile.json + ref.wav.
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { DATA_DIR } from '../config.js';
import { run } from './proc.js';

export const VOICES_DIR = path.join(DATA_DIR, 'voices');
fs.mkdirSync(VOICES_DIR, { recursive: true });

function profilePath(id) { return path.join(VOICES_DIR, id, 'profile.json'); }

function readProfile(id) {
  try { return JSON.parse(fs.readFileSync(profilePath(id), 'utf8')); }
  catch { return null; }
}

export function listProfiles() {
  const out = [];
  for (const entry of fs.readdirSync(VOICES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = readProfile(entry.name);
    if (!p) continue;
    out.push(publicProfile(p));
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

export function getProfile(id) {
  const p = readProfile(id);
  if (!p) return null;
  return p;  // internal — includes file paths
}

export function getPublicProfile(id) {
  const p = readProfile(id);
  return p ? publicProfile(p) : null;
}

function publicProfile(p) {
  return {
    id: p.id, name: p.name, language: p.language, speaker: p.speaker,
    refText: p.refText, duration: p.duration, createdAt: p.createdAt,
    source: p.source, hasRef: !!(p.refAudio && fs.existsSync(p.refAudio))
  };
}

/**
 * Build a reference clip from a source audio/video file and store it as a profile.
 * Pulls audio with ffmpeg → 24 kHz mono PCM; trims to first N seconds (defaults 20).
 */
export async function createFromUpload({ sourcePath, name, language = 'zh', speaker = '', refText = '', maxSec = 20, sourceLabel = '', gptSovits = null }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error(`找不到來源檔: ${sourcePath}`);
  const id = uuid();
  const dir = path.join(VOICES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const refAudio = path.join(dir, 'ref.wav');
  // Use first `maxSec` seconds; the user should pick a clean span themselves
  // (we'll add UI to pick a range later). Strip leading silence with ffmpeg.
  const { code, stderr } = await run('ffmpeg', [
    '-y', '-i', sourcePath, '-t', String(maxSec), '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
    '-af', 'silenceremove=start_periods=1:start_duration=0.2:start_threshold=-40dB', refAudio
  ]);
  if (code !== 0) throw new Error(`ffmpeg ref cut failed (${code}): ${stderr.slice(-300)}`);
  const profile = {
    id, name: name || sourceLabel || `Voice ${id.slice(0, 6)}`,
    language, speaker, refText,
    refAudio,
    duration: maxSec,
    createdAt: Date.now(),
    source: sourceLabel ? { label: sourceLabel } : { file: sourcePath },
    gptSovits: gptSovits || null   // { sovitsPath, gptPath, version } if a fine-tuned model is linked
  };
  fs.writeFileSync(profilePath(id), JSON.stringify(profile, null, 2));
  return publicProfile(profile);
}

/**
 * Save a clip cut from an existing MediaStudio job's media at [start, end].
 * Used for the "use this video as a voice sample" button in the editor.
 */
export async function createFromJobMedia({ jobId, mediaPath, start, end, name, language = 'zh', speaker = '', refText = '' }) {
  if (!mediaPath || !fs.existsSync(mediaPath)) throw new Error('找不到 job 媒體檔');
  const dur = Math.max(2, (Number(end) || 20) - (Number(start) || 0));
  const id = uuid();
  const dir = path.join(VOICES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const refAudio = path.join(dir, 'ref.wav');
  const { code, stderr } = await run('ffmpeg', [
    '-y', '-ss', String(start || 0), '-t', String(dur), '-i', mediaPath,
    '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', refAudio
  ]);
  if (code !== 0) throw new Error(`ffmpeg ref cut failed (${code}): ${stderr.slice(-300)}`);
  const profile = {
    id, name: name || `Voice ${id.slice(0, 6)}`,
    language, speaker, refText,
    refAudio,
    duration: dur,
    createdAt: Date.now(),
    source: { jobId, start, end }
  };
  fs.writeFileSync(profilePath(id), JSON.stringify(profile, null, 2));
  return publicProfile(profile);
}

export function deleteProfile(id) {
  const dir = path.join(VOICES_DIR, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function refAudioPath(id) {
  const p = readProfile(id);
  return p && p.refAudio && fs.existsSync(p.refAudio) ? p.refAudio : null;
}

export function updateProfile(id, patch) {
  const p = readProfile(id);
  if (!p) return null;
  const next = { ...p, ...patch, id, refAudio: p.refAudio };  // don't allow refAudio rewrite
  fs.writeFileSync(profilePath(id), JSON.stringify(next, null, 2));
  return publicProfile(next);
}
