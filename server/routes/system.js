import express from 'express';
import path from 'path';
import { spawnSync } from 'child_process';
import { ytdlpAvailable } from '../services/ytdlp.js';
import { ffmpegAvailable } from '../services/ffmpeg.js';
import { which } from '../services/proc.js';
import { PYTHON_BIN, DEFAULTS, ROOT } from '../config.js';
import { FORMATTERS } from '../services/subtitles.js';
import { voiceCloneStatus, VOICE_URL } from '../services/voiceClone.js';

const router = express.Router();

function probePy(expr, timeout = 8000) {
  try {
    const r = spawnSync(PYTHON_BIN, ['-c', expr], { timeout });
    if (r.status === 0) return { ok: true, out: (r.stdout || '').toString().trim() };
    return { ok: false, out: null };
  } catch { return { ok: false, out: null }; }
}
function checkPythonAsr() {
  const fw = probePy('import faster_whisper, sys; sys.stdout.write(getattr(faster_whisper,"__version__","?"))');
  const mlx = probePy('import mlx_whisper, sys; sys.stdout.write(getattr(mlx_whisper,"__version__","?"))');
  const which = mlx.ok ? `mlx-whisper ${mlx.out}` : (fw.ok ? `faster-whisper ${fw.out}` : null);
  return { ok: fw.ok || mlx.ok, version: which, hasMlx: mlx.ok, hasFasterWhisper: fw.ok };
}
function checkPythonOcr() {
  // first try paddleocr, then rapidocr
  let r = probePy('import paddleocr, sys; sys.stdout.write("paddleocr "+getattr(paddleocr,"__version__","?"))', 4000);
  if (r.ok) return { ok: true, version: r.out };
  r = probePy('import rapidocr_onnxruntime, sys; sys.stdout.write("rapidocr "+getattr(rapidocr_onnxruntime,"__version__","?"))', 4000);
  if (r.ok) return { ok: true, version: r.out };
  return { ok: false, version: null };
}

let cache = null;
let cacheTs = 0;

router.get('/status', async (_req, res) => {
  if (cache && Date.now() - cacheTs < 15000) return res.json(cache);
  const [ytdlp, ffmpeg, autoEditor] = await Promise.all([
    ytdlpAvailable(), ffmpegAvailable(), which('auto-editor')
  ]);
  let libass = false;
  try {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { timeout: 5000 });
    libass = r.status === 0 && /\bsubtitles\b/.test((r.stdout || '').toString());
  } catch { /* ignore */ }
  const asr = checkPythonAsr();
  const ocr = checkPythonOcr();
  const vc = await voiceCloneStatus();
  cache = {
    status: 'running',
    defaults: DEFAULTS,
    formats: Object.fromEntries(Object.entries(FORMATTERS).map(([k, v]) => [k, { label: v.label, timed: v.timed, ext: v.ext }])),
    features: {
      burnSubtitles: libass,
      ocr: ocr.ok,
      aiPlanViaMcp: true,
      voiceClone: vc.ok && vc.ready,
      voiceCloneRunning: vc.ok,
      voiceCloneBackends: vc.byBackend  // per-backend status: {xtts: {ok,ready,...}, f5tts: {...}, ...}
    },
    mcp: {
      serverPath: path.join(ROOT, 'mcp', 'server.js'),
      installClaudeCode: `claude mcp add mediastudio -- node "${path.join(ROOT, 'mcp', 'server.js')}"`,
      coworkConfig: { mcpServers: { mediastudio: { command: 'node', args: [path.join(ROOT, 'mcp', 'server.js')] } } },
      tools: ['mediastudio_get_status', 'mediastudio_list_jobs', 'mediastudio_get_transcript', 'mediastudio_list_artifacts', 'mediastudio_save_plan', 'mediastudio_cut_clip', 'mediastudio_transcribe_file']
    },
    dependencies: {
      'yt-dlp': { ok: !!ytdlp, path: ytdlp || null, purpose: '從網址下載影音', required: true },
      ffmpeg: { ok: !!ffmpeg, path: ffmpeg || null, purpose: '抽音 / 燒字幕 / 裁切 / 文字驅動剪輯', required: true },
      'whisper-asr': { ok: asr.ok, version: asr.version, purpose: '語音轉文字 (ASR)。Apple Silicon 偏好 mlx-whisper（Neural Engine）；CPU/GPU 用 faster-whisper', install: asr.hasMlx ? null : 'pip install mlx-whisper  # Apple Silicon 最快\n或 pip install faster-whisper', required: true, backend: asr.hasMlx ? 'mlx-whisper' : (asr.hasFasterWhisper ? 'faster-whisper' : null) },
      'auto-editor': { ok: !!autoEditor, path: autoEditor || null, purpose: 'AI 自動去靜音剪輯（選用）', install: 'pip install auto-editor', required: false },
      'paddleocr/rapidocr': { ok: ocr.ok, version: ocr.version, purpose: '影片內燒錄字幕 OCR（選用）', install: 'pip install rapidocr-onnxruntime opencv-python', required: false },
      'voice-clone-server': {
        ok: vc.ok, ready: vc.ready, backends: vc.byBackend, preferred: vc.preferred,
        url: VOICE_URL, purpose: '本機語音克隆服務（XTTS / F5-TTS / VoiceCraft）— 選用',
        required: false, install: '雙擊 start-voice-server.command（會同時啟動 xtts:9811 + f5tts:9812）'
      }
    }
  };
  cacheTs = Date.now();
  res.json(cache);
});

export default router;
