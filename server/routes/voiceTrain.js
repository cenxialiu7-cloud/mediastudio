import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { MEDIA_DIR } from '../config.js';
import { listTrainings, getTraining, deleteTraining, startBuild, sampleDataset } from '../services/voiceTraining.js';
import { createFromUpload as voiceCreateFromUpload } from '../services/voiceProfiles.js';
import { decodeFilename } from '../utils/multerName.js';

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => {
      file.originalname = decodeFilename(file.originalname);
      cb(null, `${Date.now()}-train-${file.originalname.replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 100)}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 * 1024 }
});

router.get('/', (_req, res) => res.json({ trainings: listTrainings() }));

router.get('/:id', (req, res) => {
  const t = getTraining(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

router.get('/:id/sample', (req, res) => {
  const n = Math.max(1, Math.min(15, Number(req.query.n) || 5));
  const picks = sampleDataset(req.params.id, n);
  if (!picks) return res.status(404).json({ error: 'not ready' });
  res.json({ samples: picks.map((p) => ({ ...p, audioUrl: `/api/voice-train/${req.params.id}/audio?path=${encodeURIComponent(p.audioPath)}` })) });
});

router.get('/:id/audio', (req, res) => {
  const t = getTraining(req.params.id);
  if (!t || !t.wavsDir) return res.status(404).end();
  const p = String(req.query.path || '');
  // Security: only serve files inside this training's wavs dir.
  if (!p.startsWith(t.wavsDir + path.sep) && !p.startsWith(t.wavsDir + '/')) return res.status(403).end();
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/wav');
  fs.createReadStream(p).pipe(res);
});

// Start a build. Three source modes:
//   { source: { type:'file'|'folder', value }, options }           — local path the server can see
//   multipart: file=<audio/video>, fields: speaker, language, …    — uploads then triggers
router.post('/', (req, res) => {
  const { source, options } = req.body || {};
  if (!source || !source.value) return res.status(400).json({ error: 'source required ({type,value})' });
  try { res.json(startBuild(source, options || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const sourcePath = path.join(MEDIA_DIR, req.file.filename);
  try {
    const opts = {
      speaker: req.body.speaker || 'speaker1',
      language: req.body.language || 'zh',
      model: req.body.model || 'large-v3-turbo',
      limitMin: req.body.limitMin ? Number(req.body.limitMin) : undefined
    };
    res.json(startBuild({ type: 'file', value: sourcePath }, opts));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// After a build completes, register the speaker's longest/best chunk as a Voice Library profile.
router.post('/:id/save-as-voice', async (req, res) => {
  const t = getTraining(req.params.id);
  if (!t || t.state !== 'done') return res.status(409).json({ error: '訓練尚未完成' });
  const samples = sampleDataset(req.params.id, 3) || [];
  if (!samples.length) return res.status(404).json({ error: '沒有可用片段' });
  // Pick the LONGEST chunk for best reference quality.
  let bestPath = null, bestLen = 0;
  try {
    for (const s of samples) {
      const sz = fs.statSync(s.audioPath).size;
      if (sz > bestLen) { bestLen = sz; bestPath = s.audioPath; }
    }
  } catch { /* ignore */ }
  if (!bestPath) bestPath = samples[0].audioPath;
  try {
    const profile = await voiceCreateFromUpload({
      sourcePath: bestPath,
      name: req.body?.name || `${t.options?.speaker || 'speaker'} (訓練集樣本)`,
      language: t.options?.language || 'zh',
      speaker: t.options?.speaker || '',
      refText: samples.find((s) => s.audioPath === bestPath)?.text || '',
      maxSec: 20,
      sourceLabel: `voice-train:${t.id.slice(0, 8)}`,
      gptSovits: req.body?.gptSovits || null  // { sovitsPath, gptPath, version } — links a trained model
    });
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => res.json({ ok: deleteTraining(req.params.id, { removeFiles: req.query.removeFiles === '1' }) }));

export default router;
