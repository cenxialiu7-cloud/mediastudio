import express from 'express';
import fs from 'fs';
import path from 'path';
import { broadcast } from '../ws.js';
import { OUTPUT_DIR } from '../config.js';
import {
  getJob, getSegments, getMediaPath, getOutputPath, addArtifact, getArtifactPath, getJobPrefix
} from '../jobQueue.js';
import { burnSubtitles, losslessCut, keepRanges, replaceAudio } from '../services/ffmpeg.js';
import { FORMATTERS, toSRT } from '../services/subtitles.js';
import { run, which } from '../services/proc.js';
import { ocrSubtitles } from '../services/ocrSubs.js';
import { aiPlan as claudeAiPlan, claudeReady } from '../services/claude.js';
import { voiceCloneStatus, cutReferenceClip, cutExactRange, synthesize, notRunningHint } from '../services/voiceClone.js';
import { reExport, getJobRaw } from '../jobQueue.js';

const router = express.Router();

function op(jobId, kind, state, progress, message) {
  broadcast('op', { jobId, kind, state, progress, message, ts: Date.now() });
}

// Run an async edit op without blocking the HTTP response.
function launch(res, jobId, kind, fn) {
  const j = getJob(jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  if (!j.hasMedia) return res.status(409).json({ error: '此任務沒有可用的來源影片（本機檔可能已移動）' });
  res.json({ ok: true, jobId, kind });
  op(jobId, kind, 'running', 0, '開始…');
  fn()
    .then((art) => { if (art) addArtifact(jobId, art); op(jobId, kind, 'done', 1, '完成'); })
    .catch((e) => op(jobId, kind, 'error', 0, e.message || String(e)));
}

// --- stream the source video (for preview in the editor) ---
router.get('/:id/media', (req, res) => {
  const p = getMediaPath(req.params.id);
  if (!p) return res.status(404).end();
  const stat = fs.statSync(p);
  const range = req.headers.range;
  const type = mimeFor(p);
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type
    });
    fs.createReadStream(p, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(p).pipe(res);
  }
});
function mimeFor(p) {
  const e = path.extname(p).toLowerCase();
  return { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }[e] || 'application/octet-stream';
}

// --- burn current subtitles into the video ---
// body: { format?: 'srt'|'ass' }  (defaults to srt; uses live segments)
router.post('/:id/burn', (req, res) => {
  const id = req.params.id;
  const segs = getSegments(id);
  if (!segs) return res.status(409).json({ error: '尚無逐字稿可燒錄' });
  const prefix = getJobPrefix(id);
  launch(res, id, 'burn', async () => {
    const tmpSrt = path.join(OUTPUT_DIR, `${prefix}.burnsrc.srt`);
    fs.writeFileSync(tmpSrt, toSRT(segs), 'utf8');
    const out = path.join(OUTPUT_DIR, `${prefix}.burned.mp4`);
    op(id, 'burn', 'running', 0.1, '燒錄字幕中（重新編碼）…');
    await burnSubtitles(getMediaPath(id), tmpSrt, out, (l) => {
      const m = /time=(\d+):(\d+):(\d+)/.exec(l);
      if (m) op(id, 'burn', 'running', 0.1, `處理中 ${m[1]}:${m[2]}:${m[3]}`);
    });
    fs.unlinkSync(tmpSrt);
    return { name: 'burned.mp4', kind: 'video', label: '已燒錄字幕的影片', path: out };
  });
});

// --- lossless cut a single [start,end] segment ---
// body: { start, end }
router.post('/:id/clip', (req, res) => {
  const { start, end } = req.body || {};
  if (!(end > start)) return res.status(400).json({ error: 'start/end invalid' });
  const id = req.params.id;
  const prefix = getJobPrefix(id);
  launch(res, id, 'clip', async () => {
    const src = getMediaPath(id);
    const ext = path.extname(src) || '.mp4';
    const out = path.join(OUTPUT_DIR, `${prefix}.clip${ext}`);
    await losslessCut(src, start, end, out);
    return { name: `clip${ext}`, kind: 'video', label: `無損裁切片段 ${Math.round(start)}s–${Math.round(end)}s`, path: out };
  });
});

// --- text-driven cut: keep only the chosen segments ---
// body: { keepIndexes: number[] }   indexes into the (live, possibly edited) segment list
// optional: { segments: [...] }     full edited segment list to use instead of stored ones
router.post('/:id/cut', (req, res) => {
  const id = req.params.id;
  const stored = getSegments(id);
  const segs = Array.isArray(req.body?.segments) ? req.body.segments : stored;
  if (!segs || !segs.length) return res.status(409).json({ error: '尚無逐字稿' });
  const keep = Array.isArray(req.body?.keepIndexes) ? req.body.keepIndexes : segs.map((_, i) => i);
  const ranges = keep
    .filter((i) => segs[i])
    .map((i) => [Number(segs[i].start) || 0, Number(segs[i].end) || 0])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return res.status(400).json({ error: '沒有要保留的片段' });
  // merge adjacent/overlapping ranges (with tiny gap tolerance) for smoother joins
  const merged = [ranges[0].slice()];
  for (let k = 1; k < ranges.length; k++) {
    const last = merged[merged.length - 1];
    if (ranges[k][0] <= last[1] + 0.05) last[1] = Math.max(last[1], ranges[k][1]);
    else merged.push(ranges[k].slice());
  }
  const prefix = getJobPrefix(id);
  launch(res, id, 'cut', async () => {
    const out = path.join(OUTPUT_DIR, `${prefix}.edited.mp4`);
    await keepRanges(getMediaPath(id), merged, out,
      () => {}, (done, total) => op(id, 'cut', 'running', done / total, `輸出片段 ${done}/${total}`));
    return { name: 'edited.mp4', kind: 'video', label: `文字驅動剪輯（保留 ${merged.length} 段）`, path: out };
  });
});

// --- AI auto-cut: remove silences via `auto-editor` (optional dependency) ---
router.post('/:id/autocut', async (req, res) => {
  const id = req.params.id;
  const j = getJob(id);
  if (!j || !j.hasMedia) return res.status(409).json({ error: '沒有可用的來源影片' });
  const ae = (await which('auto-editor')) || (await which('auto-editor.exe'));
  if (!ae) return res.status(501).json({ error: '未安裝 auto-editor。請執行: pip install auto-editor' });
  const margin = (req.body && req.body.margin) || '0.2sec';
  const prefix = getJobPrefix(id);
  launch(res, id, 'autocut', async () => {
    const src = getMediaPath(id);
    const out = path.join(OUTPUT_DIR, `${prefix}.autocut.mp4`);
    op(id, 'autocut', 'running', 0.1, 'auto-editor 去除靜音中…');
    const { code, stderr } = await run('auto-editor', [src, '--margin', margin, '-o', out], {
      onLine: (l) => op(id, 'autocut', 'running', 0.3, l.slice(0, 100))
    });
    if (code !== 0) throw new Error(`auto-editor 失敗 (code ${code})\n${stderr.slice(-600)}`);
    return { name: 'autocut.mp4', kind: 'video', label: 'AI 自動去靜音剪輯', path: out };
  });
});

// Encode a filename so non-ASCII (e.g. CJK) survives Content-Disposition.
function dispo(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// --- download a produced subtitle output or video artifact ---
router.get('/:id/output/:format', (req, res) => {
  const f = FORMATTERS[req.params.format];
  if (!f) return res.status(400).json({ error: 'unknown format' });
  const p = getOutputPath(req.params.id, req.params.format);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not available' });
  const prefix = getJobPrefix(req.params.id);
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', dispo(`${prefix}.${f.ext}`));
  fs.createReadStream(p).pipe(res);
});

router.get('/:id/artifact/:name', (req, res) => {
  const p = getArtifactPath(req.params.id, req.params.name);
  if (!p) return res.status(404).json({ error: 'not available' });
  const prefix = getJobPrefix(req.params.id);
  res.setHeader('Content-Type', mimeFor(p));
  res.setHeader('Content-Disposition', dispo(`${prefix}.${req.params.name}`));
  fs.createReadStream(p).pipe(res);
});

// --- Polish the cloned clip so it splices seamlessly into the source ---
// Two tiers:
//   1) Full Layer-1 (python venv): time-stretch + LUFS + matchering + room
//      tone + boundary crossfade. Best quality.
//   2) FFmpeg loudnorm fallback (zero-dep): measure src LUFS around [s,e]
//      and apply matching one-pass loudnorm to the clone. Solves the most
//      common "cloned wav is 30 dB quieter than the surrounding speech"
//      problem (the dominant cause of "replaced segment sounds silent").
//
// Either tier returns a 48 kHz stereo WAV ready for the concat filter.
async function polishReplacement(id, src, s, e, replacementPath) {
  const prefix = getJobPrefix(id);
  const polished = path.join(OUTPUT_DIR, `${prefix}.polished.wav`);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const venvPy = path.join(home, '.mediastudio-venv', 'voicefix', 'bin', 'python');
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'python', 'voicefix_post.py');

  // ---- Tier 1: full Layer-1 polish ----
  if (fs.existsSync(venvPy) && fs.existsSync(script)) {
    op(id, 'voicefix', 'running', 0.72, '後處理：時長 / LUFS / 頻譜 / 底噪 / 邊界 crossfade…');
    const r = await run(venvPy, [script, '--src', src, '--start', String(s), '--end', String(e),
                                  '--clone', replacementPath, '--out', polished]);
    if (r.code === 0) {
      let info = {};
      try { info = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { /* ignore */ }
      const applied = Array.isArray(info.applied) ? info.applied.join(', ') : 'ok';
      op(id, 'voicefix', 'running', 0.82, `後處理完成（Layer 1）：${applied}`);
      return polished;
    }
    op(id, 'voicefix', 'running', 0.74, `Layer 1 失敗（${r.stderr.slice(-160).trim()}），改用 ffmpeg loudnorm 兜底`);
  }

  // ---- Tier 2: ffmpeg loudnorm fallback ----
  return await loudnormFallback(id, src, s, e, replacementPath, polished);
}

// Single-pass loudnorm targeting the integrated LUFS of the source's surrounding
// audio. Also resamples to 48 kHz stereo so the downstream concat filter doesn't
// have to coerce sample format mid-graph (which has produced silent segments on
// some ffmpeg builds when combined with atrim on the same input twice).
async function loudnormFallback(id, src, s, e, replacementPath, outPath) {
  op(id, 'voicefix', 'running', 0.72, '量測週圍音量（loudnorm）…');
  const win = 1.0;                                          // seconds on each side for LUFS measurement
  const measureStart = Math.max(0, s - win);
  const measureDur = (e - s) + 2 * win;
  let targetLufs = -23.0;                                   // safe default if measurement fails
  try {
    const m = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(measureStart),
                                    '-t', String(measureDur), '-i', src,
                                    '-af', 'loudnorm=I=-23:TP=-1:print_format=json', '-f', 'null', '-']);
    // loudnorm prints a JSON block at the end of stderr; grab the last {...}
    const txt = m.stderr || '';
    const lastBrace = txt.lastIndexOf('{');
    const closeBrace = txt.lastIndexOf('}');
    if (lastBrace >= 0 && closeBrace > lastBrace) {
      const j = JSON.parse(txt.slice(lastBrace, closeBrace + 1));
      const inI = Number(j.input_i);
      if (Number.isFinite(inI) && inI > -70 && inI < 0) targetLufs = inI;
    }
  } catch { /* keep default */ }

  // Clamp into a sensible range so a one-off measurement glitch can't push gain insane.
  targetLufs = Math.max(-30, Math.min(-12, targetLufs));
  op(id, 'voicefix', 'running', 0.78, `對齊克隆音響度至 ${targetLufs.toFixed(1)} LUFS（ffmpeg loudnorm）…`);
  const r2 = await run('ffmpeg', ['-y', '-hide_banner', '-i', replacementPath,
                                   '-af', `loudnorm=I=${targetLufs.toFixed(2)}:TP=-1.0:LRA=11,aresample=48000`,
                                   '-ar', '48000', '-ac', '2', outPath]);
  if (r2.code !== 0 || !fs.existsSync(outPath)) {
    op(id, 'voicefix', 'running', 0.8, `loudnorm 失敗（${r2.stderr.slice(-160).trim()}），改用原始克隆音`);
    return replacementPath;
  }
  op(id, 'voicefix', 'running', 0.82, '後處理完成（ffmpeg loudnorm 兜底）');
  return outPath;
}

// Walk segments around `idx` and find a contiguous block totalling 4-9 seconds
// (best fit for GPT-SoVITS's 3-10s window). Returns {start, end, text} or null.
// Skips the segment being replaced so the reference never contains the very
// words we're trying to synthesize.
function pickAlignedRef(segs, idx) {
  if (!segs || !segs.length) return null;
  const inBand = (sec) => sec >= 3 && sec <= 10;
  // Try widening windows: single neighbour first, then 2-3 contiguous.
  const tryRange = (a, b) => {
    if (a < 0 || b >= segs.length || a > b) return null;
    let text = '', start = segs[a].start, end = segs[b].end;
    for (let i = a; i <= b; i++) text += (segs[i].text || '');
    const dur = end - start;
    if (!inBand(dur)) return null;
    return { start, end, text: text.trim(), dur };
  };
  const candidates = [];
  // Prefer segments BEFORE the edit (more likely clean / pre-context)
  for (let span = 1; span <= 4; span++) {
    for (let offset = 1; offset <= 5; offset++) {
      const before = tryRange(idx - offset - span + 1, idx - offset);
      if (before) candidates.push(before);
      const after = tryRange(idx + offset, idx + offset + span - 1);
      if (after) candidates.push(after);
    }
  }
  if (!candidates.length) return null;
  // Prefer 5-7s, closest to ideal sweet spot.
  candidates.sort((a, b) => Math.abs(a.dur - 6) - Math.abs(b.dur - 6));
  return candidates[0];
}

// --- voice fix assembly: splice a replacement clip over one segment's audio ---
async function assembleVoiceFix(id, idx, s, e, replacementPath) {
  const src = getMediaPath(id);
  const prefix = getJobPrefix(id);
  // Polish the raw cloned audio so it slots seamlessly into the surrounding
  // source audio (graceful fallback to raw if the venv isn't installed).
  replacementPath = await polishReplacement(id, src, s, e, replacementPath);
  const newAudio = path.join(OUTPUT_DIR, `${prefix}.fixedaudio.wav`);
  // CRITICAL: ffmpeg's `concat` audio filter requires identical sample rate +
  // channel layout across all inputs. GPT-SoVITS outputs 32 kHz mono, XTTS
  // outputs 24 kHz mono, F5-TTS outputs 24 kHz mono — but source videos are
  // usually 44.1/48 kHz stereo. With mismatch, ffmpeg either errors out OR
  // silently emits silence for the mismatched segment. We force every audio
  // stream through `aformat` to a common 48 kHz stereo s16 spec, then concat.
  const COMMON_FMT = 'aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo';
  const filter =
    `[0:a]atrim=start=0:end=${s},asetpts=PTS-STARTPTS,${COMMON_FMT}[a0];` +
    `[1:a]asetpts=PTS-STARTPTS,${COMMON_FMT}[a1];` +
    `[0:a]atrim=start=${e},asetpts=PTS-STARTPTS,${COMMON_FMT}[a2];` +
    `[a0][a1][a2]concat=n=3:v=0:a=1[out]`;
  op(id, 'voicefix', 'running', 0.88, '重組音軌（前段 + 新音 + 後段）…');
  const { code, stderr } = await run('ffmpeg', ['-y', '-i', src, '-i', replacementPath, '-filter_complex', filter, '-map', '[out]', newAudio]);
  if (code !== 0) throw new Error(`音軌重組失敗 (code ${code})\n${stderr.slice(-600)}`);
  op(id, 'voicefix', 'running', 0.94, '把新音軌封裝回影片…');
  const out = path.join(OUTPUT_DIR, `${prefix}.voicefixed.mp4`);
  await replaceAudio(src, newAudio, out);
  try { fs.unlinkSync(newAudio); } catch { /* ignore */ }
  // polished.wav lives in OUTPUT_DIR/<prefix>.polished.wav; safe to drop after mux
  try { const pol = path.join(OUTPUT_DIR, `${prefix}.polished.wav`); if (fs.existsSync(pol)) fs.unlinkSync(pol); } catch { /* ignore */ }
  return { name: 'voicefixed.mp4', kind: 'video', label: `口誤修正（第 ${idx + 1} 段聲音已替換）`, path: out };
}

// You generate `replacementAudioPath` externally (or via /voicefix-auto) and this
// endpoint stitches it back into the original audio at the segment's range.
// body: { segmentIndex:number, replacementAudioPath:string, segments?:[...] }
router.post('/:id/voicefix', (req, res) => {
  const id = req.params.id;
  const segs = Array.isArray(req.body?.segments) ? req.body.segments : getSegments(id);
  const idx = Number(req.body?.segmentIndex);
  const fix = req.body?.replacementAudioPath;
  if (!segs || !segs[idx]) return res.status(400).json({ error: 'segmentIndex 無效' });
  if (!fix || !fs.existsSync(fix)) return res.status(400).json({ error: `找不到替換音檔: ${fix}` });
  const s = Number(segs[idx].start) || 0;
  const e = Number(segs[idx].end) || 0;
  if (!(e > s)) return res.status(400).json({ error: '該段時間範圍無效' });
  launch(res, id, 'voicefix', () => assembleVoiceFix(id, idx, s, e, fix));
});

// --- voice fix AUTO: local voice-clone service generates the clip ---
// body: { segmentIndex, newText, language?, backend?:'xtts'|'f5tts'|'voicecraft', voiceId?, segments?:[...] }
//   - `backend`  selects the engine (defaults to whichever is ready: f5tts > xtts)
//   - `voiceId`  optional: use a saved voice profile's reference clip instead of auto-cutting
router.post('/:id/voicefix-auto', async (req, res) => {
  const id = req.params.id;
  const segs = Array.isArray(req.body?.segments) ? req.body.segments : getSegments(id);
  const idx = Number(req.body?.segmentIndex);
  const newText = String(req.body?.newText || '').trim();
  const language = req.body?.language;
  const voiceId = req.body?.voiceId;
  // Allow caller to pass trained GPT-SoVITS weights directly without saving a profile.
  const gptSovitsOverride = req.body?.gptSovitsModel || null;  // {sovitsPath, gptPath, version}
  let backend = (req.body?.backend || '').toLowerCase();
  if (!segs || !segs[idx]) return res.status(400).json({ error: 'segmentIndex 無效' });
  if (!newText) return res.status(400).json({ error: '請提供 newText（修正後的句子）' });
  const status = await voiceCloneStatus();
  if (!backend) backend = status.preferred || 'xtts';
  const bs = status.byBackend?.[backend];
  if (!bs || !bs.ok) return res.status(503).json({ error: notRunningHint(backend) });
  // If not yet loaded, the server will load on first /generate — accept and proceed.
  const j = getJob(id);
  if (!j || !j.hasMedia) return res.status(409).json({ error: '沒有可用的來源影片' });
  const s = Number(segs[idx].start) || 0;
  const e = Number(segs[idx].end) || 0;
  if (!(e > s)) return res.status(400).json({ error: '該段時間範圍無效' });
  launch(res, id, 'voicefix', async () => {
    let ref, refText = '', gptSovits = null;
    if (voiceId) {
      try {
        const vp = await import('../services/voiceProfiles.js');
        const profile = vp.getProfile(voiceId);
        if (!profile) throw new Error('找不到 voiceId: ' + voiceId);
        ref = profile.refAudio;
        refText = profile.refText || '';
        gptSovits = profile.gptSovits || null;   // {sovitsPath, gptPath, version} if trained
        const modelHint = gptSovits ? ` + 訓練模型 ${path.basename(gptSovits.sovitsPath || '')}` : '';
        op(id, 'voicefix', 'running', 0.15, `使用聲音庫「${profile.name}」(${path.basename(profile.refAudio)})${modelHint}`);
      } catch (e) {
        throw new Error('讀取聲音檔失敗：' + e.message);
      }
    } else if (backend === 'gptsovits') {
      // GPT-SoVITS demands ref audio in 3-10s AND prompt_text matching the
      // audio exactly. Build a ref by walking adjacent segments (skipping the
      // one being replaced) until we accumulate 4-9s of natural speech, then
      // cut that exact [start,end] from source — audio and concatenated text
      // are intrinsically aligned, no truncation needed.
      op(id, 'voicefix', 'running', 0.1, '擷取與字幕對齊的 3-10 秒參考音（GPT-SoVITS 嚴格要求）…');
      const aligned = pickAlignedRef(segs, idx);
      if (!aligned) throw new Error('附近找不到 3-10 秒可用片段；請改用聲音庫的訓練模型');
      ref = await cutExactRange(getMediaPath(id), aligned.start, aligned.end, getJobPrefix(id));
      refText = aligned.text;
    } else {
      op(id, 'voicefix', 'running', 0.1, '擷取說話者參考音（15 秒乾淨片段）…');
      ref = await cutReferenceClip(getMediaPath(id), s, e, j.duration || 0, getJobPrefix(id), 15);
      refText = segs[Math.max(0, idx - 1)]?.text || '';
    }
    // If the user explicitly chose a trained model via UI (no profile yet), honor it.
    if (gptSovitsOverride && (gptSovitsOverride.sovitsPath || gptSovitsOverride.gptPath)) {
      gptSovits = gptSovitsOverride;
    }
    op(id, 'voicefix', 'running', 0.3, `呼叫本機 ${backend} 生成新句子…（首次會載入模型）`);
    const r = await synthesize({
      referenceAudio: ref,
      referenceText: refText,
      targetText: newText,
      language,
      jobId: getJobPrefix(id),
      label: `synth.${idx}`,
      gptSovits,
      backend
    });
    op(id, 'voicefix', 'running', 0.7, `${backend} 生成完成 (model: ${r.model || '?'})，拼回原音軌…`);
    return await assembleVoiceFix(id, idx, s, e, r.path);
  });
});

// --- OCR burned-in subtitles from the video itself (PaddleOCR / RapidOCR) ---
// body: { fps?, bandTop?, bandBottom?, minDuration?, applyAsTranscript?:bool }
router.post('/:id/ocr', (req, res) => {
  const id = req.params.id;
  const j = getJob(id);
  if (!j || !j.hasMedia) return res.status(409).json({ error: '沒有可用的來源影片' });
  const opts = {
    fps: Number(req.body?.fps) || 2,
    bandTop: req.body?.bandTop != null ? Number(req.body.bandTop) : 0.70,
    bandBottom: req.body?.bandBottom != null ? Number(req.body.bandBottom) : 1.0,
    minDuration: Number(req.body?.minDuration) || 0.3
  };
  const apply = !!req.body?.applyAsTranscript;
  const prefix = getJobPrefix(id);
  launch(res, id, 'ocr', async () => {
    const outJson = path.join(OUTPUT_DIR, `${prefix}.ocr.json`);
    op(id, 'ocr', 'running', 0.05, 'OCR 啟動中…');
    const r = await ocrSubtitles(getMediaPath(id), outJson, opts, (pct, msg) => op(id, 'ocr', 'running', pct ?? null, msg));
    const segs = r.segments || [];
    if (apply && segs.length) {
      reExport(id, segs.map((x) => ({ start: x.start, end: x.end, text: x.text })));
      op(id, 'ocr', 'running', 0.98, `OCR 完成 (${segs.length} 段)，已套用為逐字稿並重新匯出字幕`);
    }
    // Also save an SRT next to the json for convenience
    const srtPath = path.join(OUTPUT_DIR, `${prefix}.ocr.srt`);
    fs.writeFileSync(srtPath, toSRT(segs), 'utf8');
    return { name: 'ocr.srt', kind: 'subtitle', label: `OCR 燒錄字幕 (${r.engine}, ${segs.length} 段)`, path: srtPath };
  });
});

// --- Claude AI plan: summary / chapters / shorts / titles ---
// body: { tasks?:['summary'|'chapters'|'shorts'|'titles'], language?, extra?, model? }
router.post('/:id/aiplan', async (req, res) => {
  const id = req.params.id;
  const segs = getSegments(id);
  if (!segs || !segs.length) return res.status(409).json({ error: '尚無逐字稿' });
  if (!claudeReady()) return res.status(503).json({ error: '未設定 ANTHROPIC_API_KEY' });
  const j = getJobRaw(id);
  launch(res, id, 'aiplan', async () => {
    op(id, 'aiplan', 'running', 0.2, '呼叫 Claude 中…');
    const r = await claudeAiPlan({
      segments: segs,
      tasks: req.body?.tasks,
      language: req.body?.language || j?.language || 'zh',
      extraInstructions: req.body?.extra || '',
      model: req.body?.model
    });
    const out = path.join(OUTPUT_DIR, `${getJobPrefix(id)}.aiplan.json`);
    fs.writeFileSync(out, JSON.stringify({ ...r.plan, _meta: { model: r.model, cacheHit: r.cacheHit, usage: r.usage } }, null, 2), 'utf8');
    if (j) j.aiPlan = r.plan;
    op(id, 'aiplan', 'running', 0.95, `Claude 完成${r.cacheHit ? '（命中快取）' : ''}`);
    return { name: 'aiplan.json', kind: 'data', label: `AI 規劃（${r.model}${r.cacheHit ? ' · 快取' : ''}）`, path: out };
  });
});

router.get('/:id/aiplan', (req, res) => {
  const j = getJobRaw(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json({ plan: j.aiPlan || null });
});

// Save a plan generated by an external agent (e.g. Claude Code / Cowork via MCP).
// No LLM call here — this is the persistence end of the MCP round-trip.
router.put('/:id/aiplan', (req, res) => {
  const id = req.params.id;
  const j = getJobRaw(id);
  if (!j) return res.status(404).json({ error: 'not found' });
  const plan = req.body && req.body.plan;
  if (!plan || typeof plan !== 'object') return res.status(400).json({ error: '請在 body.plan 提供 plan 物件' });
  j.aiPlan = plan;
  const out = path.join(OUTPUT_DIR, `${getJobPrefix(id)}.aiplan.json`);
  fs.writeFileSync(out, JSON.stringify(plan, null, 2), 'utf8');
  // Tell connected UIs (TranscriptEditor) that a new plan arrived.
  op(id, 'aiplan', 'done', 1, `MCP 已儲存規劃（${Object.keys(plan).join(', ')}）`);
  res.json({ ok: true, plan });
});

export default router;
