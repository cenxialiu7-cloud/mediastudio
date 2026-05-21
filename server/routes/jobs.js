import express from 'express';
import fs from 'fs';
import {
  addJob, listJobs, getJob, getSegments, getOutputPath, getJobPrefix,
  cancelJob, removeJob, reExport
} from '../jobQueue.js';
import { FORMATTERS } from '../services/subtitles.js';

const router = express.Router();

// Create one or more jobs. Body: { items:[{type:'url'|'file', value}], options:{...} }
router.post('/', (req, res) => {
  const { items, options } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items[] required' });
  }
  const created = [];
  for (const it of items) {
    if (!it || !it.value || !['url', 'file'].includes(it.type)) continue;
    created.push(addJob({ type: it.type, value: String(it.value).trim() }, options || {}));
  }
  if (!created.length) return res.status(400).json({ error: 'no valid items' });
  res.json({ jobs: created });
});

router.get('/', (_req, res) => res.json({ jobs: listJobs() }));

router.get('/:id', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// Full transcript with segments (for the editor).
router.get('/:id/segments', (req, res) => {
  const segs = getSegments(req.params.id);
  if (segs == null) return res.status(404).json({ error: 'not found or not transcribed yet' });
  res.json({ id: req.params.id, segments: segs });
});

// Save edited segments and re-export subtitle files.
router.put('/:id/segments', (req, res) => {
  const { segments } = req.body || {};
  if (!Array.isArray(segments)) return res.status(400).json({ error: 'segments[] required' });
  try {
    const j = reExport(req.params.id, segments);
    res.json(j);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Download an output file in the requested format.
router.get('/:id/download/:format', (req, res) => {
  const fmt = req.params.format;
  const f = FORMATTERS[fmt];
  if (!f) return res.status(400).json({ error: 'unknown format' });
  const p = getOutputPath(req.params.id, fmt);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'not available' });
  const prefix = getJobPrefix(req.params.id);
  const name = `${prefix}.${f.ext}`;
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  fs.createReadStream(p).pipe(res);
});

router.post('/:id/cancel', (req, res) => {
  res.json({ ok: cancelJob(req.params.id) });
});

router.delete('/:id', (req, res) => {
  res.json({ ok: removeJob(req.params.id) });
});

export default router;
