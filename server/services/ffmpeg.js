import path from 'path';
import fs from 'fs';
import os from 'os';
import { run, which } from './proc.js';
import { AUDIO_DIR, OUTPUT_DIR } from '../config.js';

export async function ffmpegAvailable() {
  return (await which('ffmpeg')) || (await which('ffmpeg.exe'));
}

/** Extract a 16 kHz mono WAV suitable for Whisper. Returns the wav path. */
export async function extractAudio(inputPath, basename, onLog = () => {}) {
  const out = path.join(AUDIO_DIR, `${basename}.wav`);
  const args = ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', out];
  const { code } = await run('ffmpeg', args, { onLine: (l) => onLog(l) });
  if (code !== 0) throw new Error(`ffmpeg audio extraction failed (code ${code})`);
  return out;
}

/** Probe duration (seconds) via ffprobe; returns number or null. */
export async function probeDuration(inputPath) {
  try {
    const { code, stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', inputPath
    ]);
    if (code !== 0) return null;
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Burn a subtitle file into the video (re-encode video, copy audio).
 * Run with cwd = the subtitle's directory so the ffmpeg `subtitles=` filter
 * only sees a bare filename — avoids the filter's painful path escaping
 * (spaces / non-ASCII / colons in absolute paths).
 */
let _hasSubtitlesFilter = null;
async function hasSubtitlesFilter() {
  if (_hasSubtitlesFilter != null) return _hasSubtitlesFilter;
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters']);
    _hasSubtitlesFilter = /\bsubtitles\b/.test(stdout);
  } catch { _hasSubtitlesFilter = false; }
  return _hasSubtitlesFilter;
}

export async function burnSubtitles(inputPath, subPath, outPath, onLog = () => {}) {
  if (!(await hasSubtitlesFilter())) {
    throw new Error('目前的 ffmpeg 未編譯 libass，無法燒錄字幕。請改裝含 libass 的 ffmpeg（macOS: `brew install ffmpeg`；多數官方/Homebrew 版本都含），或改用「外掛字幕」(srt/ass) 搭配播放器。');
  }
  const dir = path.dirname(subPath);
  const name = path.basename(subPath);
  const args = ['-y', '-i', inputPath, '-vf', `subtitles=${escapeFilterArg(name)}`, '-c:a', 'copy', outPath];
  const { code, stderr } = await run('ffmpeg', args, { cwd: dir, onLine: (l) => onLog(l) });
  if (code !== 0) throw new Error(`ffmpeg burn-in failed (code ${code})\n${stderr.slice(-800)}`);
  return outPath;
}

function escapeFilterArg(s) {
  // inside a filter graph value, escape \ : '  and wrap in single quotes
  return `'${s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\\\'")}'`;
}

/** Lossless cut: stream-copy a [start,end] segment (keyframe-aligned). */
export async function losslessCut(inputPath, start, end, outPath, onLog = () => {}) {
  const args = ['-y', '-ss', String(start), '-to', String(end), '-i', inputPath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', outPath];
  const { code, stderr } = await run('ffmpeg', args, { onLine: (l) => onLog(l) });
  if (code !== 0) throw new Error(`ffmpeg lossless cut failed (code ${code})\n${stderr.slice(-800)}`);
  return outPath;
}

/**
 * Text-driven cut: keep only the given [start,end] ranges (seconds), in order,
 * and concatenate them into one video. Re-encodes for frame-accurate joins so
 * the cut points land exactly where the transcript was edited.
 * onProgress(done, total).
 */
export async function keepRanges(inputPath, ranges, outPath, onLog = () => {}, onProgress = () => {}) {
  if (!ranges.length) throw new Error('沒有要保留的片段');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cut-'));
  const parts = [];
  try {
    for (let i = 0; i < ranges.length; i++) {
      const [s, e] = ranges[i];
      if (!(e > s)) continue;
      const part = path.join(work, `p${String(i).padStart(4, '0')}.mp4`);
      const args = [
        '-y', '-ss', String(s), '-to', String(e), '-i', inputPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '192k',
        '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts', part
      ];
      const { code, stderr } = await run('ffmpeg', args, { onLine: (l) => onLog(l) });
      if (code !== 0) throw new Error(`ffmpeg segment ${i} failed (code ${code})\n${stderr.slice(-600)}`);
      parts.push(part);
      onProgress(i + 1, ranges.length);
    }
    if (!parts.length) throw new Error('沒有有效的保留片段');
    if (parts.length === 1) {
      fs.copyFileSync(parts[0], outPath);
      return outPath;
    }
    const listFile = path.join(work, 'list.txt');
    fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    const { code, stderr } = await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath], { onLine: (l) => onLog(l) });
    if (code !== 0) throw new Error(`ffmpeg concat failed (code ${code})\n${stderr.slice(-600)}`);
    return outPath;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Replace the audio track of a video with a new wav/mp3 (e.g. after voice fix). */
export async function replaceAudio(videoPath, newAudioPath, outPath, onLog = () => {}) {
  const args = ['-y', '-i', videoPath, '-i', newAudioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', outPath];
  const { code, stderr } = await run('ffmpeg', args, { onLine: (l) => onLog(l) });
  if (code !== 0) throw new Error(`ffmpeg replaceAudio failed (code ${code})\n${stderr.slice(-600)}`);
  return outPath;
}

export const OUT = OUTPUT_DIR;
