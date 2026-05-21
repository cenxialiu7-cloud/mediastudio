import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { PYTHON_BIN } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '..', '..', 'python', 'ocr_subtitles.py');

/**
 * OCR-extract burned-in subtitles from a video. Resolves with
 * { segments:[{start,end,text}], engine, fps, duration }.
 * onProgress(pct 0..1, msg).
 */
export function ocrSubtitles(videoPath, outJson, opts, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const args = [
      SCRIPT,
      '--video', videoPath,
      '--out-json', outJson,
      '--fps', String(opts.fps ?? 2),
      '--band-top', String(opts.bandTop ?? 0.70),
      '--band-bottom', String(opts.bandBottom ?? 1.0),
      '--min-duration', String(opts.minDuration ?? 0.3)
    ];
    const child = spawn(PYTHON_BIN, args, { env: process.env });
    let buf = '';
    let result = null;
    let tail = '';

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt; try { evt = JSON.parse(line); } catch { continue; }
        if (evt.event === 'progress') onProgress(evt.pct ?? null, evt.msg || '');
        else if (evt.event === 'result') result = evt;
        else if (evt.event === 'error') reject(new Error(evt.message || 'OCR error'));
      }
    });
    child.stderr.on('data', (c) => { tail = (tail + c.toString()).slice(-4000); });
    child.on('error', (e) => reject(new Error(`Failed to start Python (${PYTHON_BIN}): ${e.message}`)));
    child.on('close', (code) => {
      if (result) return resolve(result);
      if (code !== 0) {
        const hint = /No module named ['"]?(paddleocr|rapidocr|cv2|paddle)/.test(tail)
          ? '\n→ 請執行：pip install rapidocr-onnxruntime opencv-python   （或 paddlepaddle + paddleocr）'
          : '';
        return reject(new Error(`ocr_subtitles.py exited with code ${code}${hint}\n${tail}`));
      }
      reject(new Error('ocr_subtitles.py finished without emitting a result'));
    });
  });
}
