import express from 'express';
import fs from 'fs';
import path from 'path';
import { status, install, startWebui, stopWebui, startApi, stopApi, listTrainedModels, listLocalDatasets } from '../services/gptSovits.js';

const router = express.Router();

router.get('/status', (_req, res) => res.json(status()));

router.get('/datasets', (_req, res) => res.json({ datasets: listLocalDatasets() }));

// --- per-dataset audition + delete ---
function getDataset(id) { return listLocalDatasets().find((d) => d.id === id); }

router.get('/datasets/:id/samples', (req, res) => {
  const d = getDataset(req.params.id);
  if (!d) return res.status(404).json({ error: 'dataset not found' });
  const n = Math.max(1, Math.min(15, Number(req.query.n) || 5));
  try {
    const lines = fs.readFileSync(d.listPath, 'utf8').split(/\r?\n/).filter((x) => x.includes('|'));
    // shuffle + take n (stable for testing? no — random is fine for "抽樣試聽")
    const picks = lines.map((l, i) => ({ l, i })).sort(() => Math.random() - 0.5).slice(0, n);
    const samples = picks.map(({ l, i }) => {
      const [audioPath, , , text] = l.split('|');
      return {
        index: i,
        audioPath,
        text: text || '',
        audioUrl: `/api/gpt-sovits/datasets/${encodeURIComponent(d.id)}/audio?path=${encodeURIComponent(audioPath)}`
      };
    });
    res.json({ samples });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/datasets/:id/audio', (req, res) => {
  const d = getDataset(req.params.id);
  if (!d || !d.wavsDir) return res.status(404).end();
  const p = String(req.query.path || '');
  // Only serve files inside this dataset's wavs dir.
  if (!p.startsWith(d.wavsDir + path.sep) && !p.startsWith(d.wavsDir + '/')) return res.status(403).end();
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/wav');
  fs.createReadStream(p).pipe(res);
});

router.delete('/datasets/:id', (req, res) => {
  const d = getDataset(req.params.id);
  if (!d) return res.status(404).json({ error: 'dataset not found' });
  // Safety: refuse to delete anything outside data/voice_datasets/
  const expectedParent = path.join(process.cwd(), 'data', 'voice_datasets');
  if (!d.dir.startsWith(path.resolve(expectedParent)) && !d.dir.includes('voice_datasets')) {
    return res.status(400).json({ error: '拒絕刪除位於資料夾外的路徑' });
  }
  try {
    fs.rmSync(d.dir, { recursive: true, force: true });
    res.json({ ok: true, id: d.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/install', async (req, res) => {
  try {
    // Fire-and-forget; progress goes over WS
    install(req.body || {}).catch(() => { /* events already broadcast */ });
    res.json({ ok: true, started: true, ...status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/webui/start', async (_req, res) => {
  try { res.json(await startWebui()); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/webui/stop', async (_req, res) => res.json(await stopWebui()));

router.post('/api/start', async (_req, res) => {
  try { res.json(await startApi()); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/stop', async (_req, res) => res.json(await stopApi()));

router.get('/models', (_req, res) => res.json({ models: listTrainedModels() }));

export default router;
