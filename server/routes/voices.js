import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { MEDIA_DIR } from '../config.js';
import { listProfiles, getProfile, getPublicProfile, createFromUpload, createFromJobMedia, deleteProfile, refAudioPath, updateProfile } from '../services/voiceProfiles.js';
import { getJobRaw } from '../jobQueue.js';
import { decodeFilename } from '../utils/multerName.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_DIR),
    filename: (_req, file, cb) => {
      file.originalname = decodeFilename(file.originalname);
      cb(null, `${Date.now()}-voice-${file.originalname.replace(/[\/\\?%*:|"<>]/g, '_').slice(0, 100)}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

const router = express.Router();

router.get('/', (_req, res) => res.json({ voices: listProfiles() }));

router.get('/:id', (req, res) => {
  const p = getPublicProfile(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

// Stream the reference audio (for previewing in the UI).
router.get('/:id/ref', (req, res) => {
  const p = refAudioPath(req.params.id);
  if (!p) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/wav');
  fs.createReadStream(p).pipe(res);
});

// Create from an uploaded file.
// multipart: file=<audio/video>, fields: name, language, speaker, refText, maxSec
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  try {
    const p = await createFromUpload({
      sourcePath: path.join(MEDIA_DIR, req.file.filename),
      name: req.body.name,
      language: req.body.language || 'zh',
      speaker: req.body.speaker || '',
      refText: req.body.refText || '',
      maxSec: Number(req.body.maxSec) || 20,
      sourceLabel: req.file.originalname
    });
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Create from an existing job's media.
// body: { jobId, start, end, name?, language?, speaker?, refText? }
router.post('/from-job', async (req, res) => {
  const { jobId, start, end } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'missing jobId' });
  const j = getJobRaw(jobId);
  if (!j || !j.mediaPath) return res.status(404).json({ error: 'job not found / no media' });
  try {
    const p = await createFromJobMedia({
      jobId, mediaPath: j.mediaPath,
      start: Number(start) || 0,
      end: Number(end) || Math.min(30, j.duration || 20),
      name: req.body.name || (j.title || 'Voice'),
      language: req.body.language || (j.language || 'zh'),
      speaker: req.body.speaker || '',
      refText: req.body.refText || ''
    });
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/:id', (req, res) => {
  const p = updateProfile(req.params.id, req.body || {});
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

router.delete('/:id', (req, res) => res.json({ ok: deleteProfile(req.params.id) }));

export default router;
