// REST endpoints for headless GPT-SoVITS training.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { startTrainJob, cancelTrainJob, getTrainJob, listTrainJobs, activeTrainJob, removeTrainJob } from '../services/gptSovitsTrain.js';
import { listLocalDatasets, startApi as startSovitsApi, stopApi as stopSovitsApi, GS_ROOT } from '../services/gptSovits.js';
import { voiceCloneStatus, synthesize, startVoiceServers } from '../services/voiceClone.js';
import { OUTPUT_DIR } from '../config.js';
import { createFromUpload } from '../services/voiceProfiles.js';

// Read api_v2's tts_infer.yaml `custom:` block to learn which weights were
// pre-loaded at api_v2 boot time. If a caller's requested weights match these,
// we MUST NOT call /set_*_weights (the reload corrupts model state on macOS,
// causing every subsequent /tts to fail with [Errno 32] Broken pipe).
let _yamlCustomCache = null;
function readApiV2CustomWeights() {
  if (_yamlCustomCache) return _yamlCustomCache;
  const yamlPath = path.join(GS_ROOT, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
  const out = { sovits: null, gpt: null, version: null };
  try {
    const txt = fs.readFileSync(yamlPath, 'utf8');
    // Tiny YAML parser sufficient for the flat `custom:` block. Avoids adding
    // a yaml dep just for this one read.
    const lines = txt.split(/\r?\n/);
    let inCustom = false;
    for (const raw of lines) {
      if (/^custom:\s*$/.test(raw)) { inCustom = true; continue; }
      if (inCustom && /^[A-Za-z]/.test(raw)) break;                // next top-level key
      if (!inCustom) continue;
      const m = raw.match(/^\s+([A-Za-z_]+):\s*(.+?)\s*$/);
      if (!m) continue;
      if (m[1] === 'vits_weights_path') out.sovits = m[2];
      else if (m[1] === 't2s_weights_path') out.gpt = m[2];
      else if (m[1] === 'version') out.version = m[2];
    }
  } catch { /* yaml missing — leave nulls */ }
  _yamlCustomCache = out;
  return out;
}

const router = express.Router();

// List datasets available for training (same source as the wizard's Step 4).
router.get('/datasets', (_req, res) => res.json({ datasets: listLocalDatasets() }));

// Start a training job. Body: { datasetId, expName?, version?, sovitsEpochs?, gptEpochs?, batchSize? }
router.post('/', async (req, res) => {
  const { datasetId, expName, version, sovitsEpochs, gptEpochs, batchSize } = req.body || {};
  if (!datasetId) return res.status(400).json({ error: 'datasetId required' });
  const ds = listLocalDatasets().find((d) => d.id === datasetId);
  if (!ds) return res.status(404).json({ error: `dataset not found: ${datasetId}` });
  try {
    const job = await startTrainJob({
      datasetId: ds.id, listPath: ds.listPath, wavsDir: ds.dir + '/wavs',
      expName: expName || `${ds.speaker || ds.id}_${(version || 'v2Pro')}`.replace(/[^A-Za-z0-9_-]/g, '_'),
      version: version || 'v2Pro',
      sovitsEpochs: Number(sovitsEpochs) || 8,
      gptEpochs: Number(gptEpochs) || 15,
      batchSize: Number(batchSize) || 2
    });
    res.json({ job });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/', (_req, res) => res.json({ jobs: listTrainJobs(), active: activeTrainJob() }));

router.get('/:id', (req, res) => {
  const j = getTrainJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

router.post('/:id/cancel', (req, res) => res.json({ ok: cancelTrainJob(req.params.id) }));
router.delete('/:id', (req, res) => res.json({ ok: removeTrainJob(req.params.id) }));

// --- preview / audition the trained model ---
// Pulls a reference clip from the original training dataset (so the model's
// voice is grounded on something it actually trained on) and asks the
// GPT-SoVITS api_v2 backend to synthesize `text` with the freshly trained
// weights. Caches the wav under OUTPUT_DIR and returns a path the GET
// /preview-audio endpoint can stream.
// GPT-SoVITS api_v2 STRICTLY requires the reference audio to be 3-10 seconds
// AND the prompt_text must match what's actually said in that clip. Earlier
// code naïvely picked dataset chunk[0] which is often >10s; voice_server.py
// then truncated it to 8s but kept the full transcript as prompt_text. The
// audio/text mismatch caused GPT-SoVITS to hallucinate the reference's
// content into every generated output. Fix: filter to chunks NATURALLY in
// 3-10s so the bundled (audio,text) pair is internally consistent and
// passes through without truncation.
function pickReferenceFromDataset(j, refIndex) {
  const dataset = listLocalDatasets().find((d) => d.id === j.datasetId);
  if (!dataset) throw new Error(`找不到對應的訓練資料集（datasetId=${j.datasetId}），可能已被刪除`);
  if (!fs.existsSync(dataset.listPath)) throw new Error(`找不到 list.txt: ${dataset.listPath}`);
  const rawLines = fs.readFileSync(dataset.listPath, 'utf8').split(/\r?\n/).filter((x) => x.includes('|'));
  if (!rawLines.length) throw new Error('list.txt 沒有可用的訓練樣本');

  // Probe each line's duration. Pick those between 4-9s (sweet spot inside
  // api_v2's 3-10s window). Fall back to wider band if pickings are slim.
  const probed = [];
  for (let i = 0; i < rawLines.length; i++) {
    const parts = rawLines[i].split('|');
    const [audioPath, , lang, text] = parts;
    if (!audioPath || !fs.existsSync(audioPath)) continue;
    try {
      const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
                                            '-of', 'default=nokey=1:noprint_wrappers=1', audioPath],
                                { timeout: 5000 }).toString().trim();
      const dur = parseFloat(out);
      if (Number.isFinite(dur)) probed.push({ index: i, audioPath, text: text || '', lang: lang || dataset.language || 'zh', dur });
    } catch { /* skip un-probeable */ }
  }
  if (!probed.length) throw new Error('資料集所有 wav 都讀不到 duration（ffprobe 可能未安裝）');

  // Honor explicit refIndex if the caller asked for one AND it's valid.
  if (refIndex != null) {
    const wanted = probed.find((p) => p.index === Number(refIndex));
    if (wanted && wanted.dur >= 3 && wanted.dur <= 10) {
      return { ...wanted, total: rawLines.length };
    }
  }

  // Otherwise prefer 4-9s (sweet spot); fall back to 3-10s; else throw.
  const sweet = probed.filter((p) => p.dur >= 4 && p.dur <= 9);
  const ok = probed.filter((p) => p.dur >= 3 && p.dur <= 10);
  const pool = sweet.length ? sweet : ok;
  if (!pool.length) throw new Error(`資料集 ${probed.length} 段中沒有 3-10 秒的 wav；GPT-SoVITS 無法使用此資料集`);

  // Pick the median-length one for stable balance of content density.
  pool.sort((a, b) => a.dur - b.dur);
  const chosen = pool[Math.floor(pool.length / 2)];
  return { ...chosen, total: rawLines.length };
}

router.post('/:id/preview', async (req, res) => {
  const j = getTrainJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'training job not found' });
  if (j.state !== 'done' || !j.sovitsWeight || !j.gptWeight) {
    return res.status(409).json({ error: '模型尚未訓練完成（缺少 SoVITS / GPT 權重）' });
  }
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '請提供要試聽的文字' });

  try {
    const ref = pickReferenceFromDataset(j, req.body?.refIndex);

    // Bring up both halves of the gptsovits stack if not already running:
    //   - api_v2.py on :9880 (the actual TTS engine)
    //   - voice_server.py on :9811 (the HTTP proxy that synthesize() talks to)
    // Both calls are idempotent.
    const st = await voiceCloneStatus();
    if (!st.byBackend?.gptsovits?.ok) {
      await Promise.all([
        startSovitsApi().catch(() => null),
        startVoiceServers('xtts').catch(() => null)
      ]);
    }

    // If the requested weights are EXACTLY what api_v2 already auto-loaded
    // from tts_infer.yaml at boot, omit gptSovits so voice_server.py doesn't
    // trigger the model-state-corrupting /set_*_weights reload. Otherwise
    // pass the weights through (legitimate model switch).
    const yamlCustom = readApiV2CustomWeights();
    const sameAsBoot = (
      yamlCustom.sovits && yamlCustom.gpt &&
      yamlCustom.sovits === j.sovitsWeight &&
      yamlCustom.gpt === j.gptWeight
    );
    const synthArgs = {
      referenceAudio: ref.audioPath,
      referenceText: ref.text,
      targetText: text,
      language: req.body?.language || ref.lang || 'zh',
      jobId: 'train',
      backend: 'gptsovits',
      gptSovits: sameAsBoot ? null : { sovitsPath: j.sovitsWeight, gptPath: j.gptWeight, version: j.version }
    };

    let r;
    try {
      r = await synthesize({ ...synthArgs, label: `train-preview.${j.id.slice(0, 8)}.${Date.now()}` });
    } catch (e) {
      // Known macOS MPS + multiprocessing flake: api_v2 worker dies silently,
      // then every subsequent /tts call returns "Broken pipe". Auto-restart
      // api_v2 once and retry — fully recovers in our testing.
      const msg = String(e.message || e);
      const isBrokenPipe = /Broken pipe/i.test(msg) || /Errno 32/.test(msg);
      if (!isBrokenPipe) throw e;
      // Restart api_v2 and re-issue the synth.
      await stopSovitsApi().catch(() => null);
      await startSovitsApi().catch(() => null);
      // Wait briefly for api_v2 to come back; synthesize() will also probe on first call.
      await new Promise((resolve) => setTimeout(resolve, 4000));
      r = await synthesize({ ...synthArgs, label: `train-preview.${j.id.slice(0, 8)}.${Date.now()}.retry` });
    }

    const fname = path.basename(r.path);
    res.json({
      ok: true,
      audioUrl: `/api/gpt-sovits/train/${j.id}/preview-audio/${encodeURIComponent(fname)}`,
      model: r.model || null,
      reference: { audioPath: ref.audioPath, text: ref.text, index: ref.index, total: ref.total }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Import a trained model into the voice library, without depending on the
// voice-training record (which may have been deleted). Picks the dataset's
// longest sample as the reference clip.
router.post('/:id/import-to-library', async (req, res) => {
  const j = getTrainJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'training job not found' });
  if (j.state !== 'done' || !j.sovitsWeight || !j.gptWeight) {
    return res.status(409).json({ error: '模型尚未訓練完成' });
  }
  const dataset = listLocalDatasets().find((d) => d.id === j.datasetId);
  if (!dataset) return res.status(404).json({ error: '找不到對應的訓練資料集（可能已被刪除）' });
  try {
    // Reuse the same 3-10s-aware picker so the saved voice profile's refAudio
    // matches its refText — otherwise every口誤替換 using this profile will
    // hallucinate the original training clip's content (same bug class as
    // the preview "garbage output" issue).
    const picked = pickReferenceFromDataset(j, null);
    const best = { path: picked.audioPath, text: picked.text };
    if (!best.path) throw new Error('找不到任何可用的參考音檔');
    const speaker = dataset.speaker || j.expName;
    const profile = await createFromUpload({
      sourcePath: best.path,
      name: req.body?.name || `${speaker} (GPT-SoVITS ${j.version})`,
      language: dataset.language || 'zh',
      speaker,
      refText: best.text,
      maxSec: 20,
      sourceLabel: `gpt-sovits-train:${j.id.slice(0, 8)}`,
      gptSovits: { sovitsPath: j.sovitsWeight, gptPath: j.gptWeight, version: j.version }
    });
    res.json(profile);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/preview-audio/:name', (req, res) => {
  // Only serve files that match the preview naming convention so this
  // endpoint cannot be used to read arbitrary files from OUTPUT_DIR.
  const name = req.params.name;
  if (!/^train\.train-preview\.[0-9a-f]+\.\d+(\.retry)?\.wav$/.test(name) || name.includes('/') || name.includes('..')) {
    return res.status(400).end();
  }
  const p = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.setHeader('Content-Type', 'audio/wav');
  fs.createReadStream(p).pipe(res);
});

export default router;
