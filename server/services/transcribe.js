import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { PYTHON_BIN } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', '..', 'python', 'transcribe.py');

/**
 * Run faster-whisper transcription on a wav file.
 * opts: { model, language, task, computeType, diarize }
 * onProgress(pct 0..1, msg) is called for streamed progress events.
 * Resolves: { segments:[{start,end,text,words?,speaker?}], language, duration, info }
 */
export function transcribe(wavPath, opts, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const args = [
      SCRIPT,
      '--audio', wavPath,
      '--model', opts.model || 'medium',
      '--task', opts.task || 'transcribe',
      '--compute-type', opts.computeType || 'auto',
      '--backend', opts.backend || 'auto'
    ];
    if (opts.language && opts.language !== 'auto') args.push('--language', opts.language);
    if (opts.diarize) args.push('--diarize');

    const child = spawn(PYTHON_BIN, args, { env: process.env });
    let buf = '';
    let result = null;
    let stderrTail = '';

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.event === 'progress') onProgress(evt.pct ?? null, evt.msg || '');
        else if (evt.event === 'result') result = evt;
        else if (evt.event === 'error') reject(new Error(evt.message || 'transcription error'));
      }
    });
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-4000); });
    child.on('error', (e) => reject(new Error(`Failed to start Python (${PYTHON_BIN}): ${e.message}`)));
    child.on('close', (code) => {
      if (result) return resolve(result);
      if (code !== 0) {
        const hint = /No module named ['"]?(faster_whisper|mlx_whisper)/.test(stderrTail)
          ? '\n\n→ 尚未安裝轉錄引擎。Apple Silicon 建議: pip install mlx-whisper；或 pip install faster-whisper'
          : '';
        return reject(new Error(`transcribe.py exited with code ${code}${hint}\n${stderrTail}`));
      }
      reject(new Error('transcribe.py finished without emitting a result'));
    });
  });
}
