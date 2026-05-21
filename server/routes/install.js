import express from 'express';
import { spawn } from 'child_process';
import { broadcast } from '../ws.js';
import { PYTHON_BIN } from '../config.js';

// Whitelisted installable deps; key = canonical name used in /api/status,
// value = list of pip packages to install for it.
const INSTALLERS = {
  'auto-editor':         { type: 'pip', pkgs: ['auto-editor'] },
  'paddleocr/rapidocr':  { type: 'pip', pkgs: ['rapidocr-onnxruntime', 'opencv-python'] },
  'rapidocr':            { type: 'pip', pkgs: ['rapidocr-onnxruntime', 'opencv-python'] },
  'paddleocr':           { type: 'pip', pkgs: ['paddlepaddle', 'paddleocr'] },
  'whisper-asr':         { type: 'pip', pkgs: ['faster-whisper'] },
  'mlx-whisper':         { type: 'pip', pkgs: ['mlx-whisper'] },
  'coqui-tts':           { type: 'pip', pkgs: ['coqui-tts', 'pypinyin', 'jieba'] }
  // F5-TTS needs Python 3.10+ → start-voice-server.command guides venv setup; not auto-installable here.
};

const router = express.Router();

router.get('/installable', (_req, res) => res.json({ names: Object.keys(INSTALLERS) }));

// POST /api/install/:name → async pip install, progress over WS as op events.
router.post('/:name', (req, res) => {
  const name = req.params.name;
  const def = INSTALLERS[name];
  if (!def) return res.status(400).json({ error: `不在自動安裝白名單：${name}` });

  res.json({ ok: true, name, packages: def.pkgs });
  const opKey = `install:${name}`;
  const emit = (state, progress, message) => broadcast('op', { jobId: null, kind: opKey, state, progress, message, ts: Date.now() });
  emit('running', 0.05, `pip install ${def.pkgs.join(' ')}…`);

  const args = ['-m', 'pip', 'install', '--user', '--quiet', '--upgrade', ...def.pkgs];
  const proc = spawn(PYTHON_BIN, args, { env: process.env });
  let tail = '';
  proc.stdout.on('data', (b) => { const s = b.toString(); tail = (tail + s).slice(-2000); emit('running', 0.5, s.trim().slice(-100) || '安裝中…'); });
  proc.stderr.on('data', (b) => { const s = b.toString(); tail = (tail + s).slice(-2000); emit('running', 0.5, s.trim().slice(-100) || '安裝中…'); });
  proc.on('error', (e) => emit('error', 0, `啟動 pip 失敗：${e.message}`));
  proc.on('close', (code) => {
    if (code === 0) emit('done', 1, `${def.pkgs.join(' ')} 安裝完成`);
    else emit('error', 0, `pip exit ${code}: ${tail.slice(-300)}`);
  });
});

export default router;
