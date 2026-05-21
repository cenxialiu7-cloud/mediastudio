import path from 'path';
import fs from 'fs';
import { run, which } from './proc.js';
import { MEDIA_DIR } from '../config.js';

export async function ytdlpAvailable() {
  return (await which('yt-dlp')) || (await which('yt-dlp.exe'));
}

/**
 * Download a URL to MEDIA_DIR. Returns absolute path of the resulting media file.
 * onLog(line) receives progress lines.
 */
export async function download(url, prefix, onLog = () => {}) {
  const outTmpl = path.join(MEDIA_DIR, `${prefix}.%(ext)s`);
  const args = [
    '--no-playlist',
    '--newline',
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', outTmpl,
    url
  ];
  const { code } = await run('yt-dlp', args, {
    onLine: (line) => onLog(line)
  });
  if (code !== 0) throw new Error(`yt-dlp exited with code ${code}`);

  // Find the produced file (prefer mp4, else whatever matches the prefix).
  const files = fs.readdirSync(MEDIA_DIR).filter((f) => f.startsWith(`${prefix}.`));
  if (!files.length) throw new Error('yt-dlp produced no output file');
  files.sort((a, b) => (a.endsWith('.mp4') ? -1 : 1) - (b.endsWith('.mp4') ? -1 : 1));
  return path.join(MEDIA_DIR, files[0]);
}

/** Fetch lightweight metadata (title, duration) for display. */
export async function probeUrl(url) {
  try {
    const { code, stdout } = await run('yt-dlp', ['--no-playlist', '--dump-single-json', '--skip-download', url]);
    if (code !== 0) return null;
    const j = JSON.parse(stdout);
    return { title: j.title, duration: j.duration, ext: j.ext, uploader: j.uploader };
  } catch {
    return null;
  }
}
