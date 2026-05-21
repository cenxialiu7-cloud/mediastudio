// Auto-start / stop endpoints for the local voice-clone servers (xtts:9811, f5tts:9812).
// Replaces the need to run start-voice-server.command in a separate terminal.
import express from 'express';
import { startVoiceServers, stopVoiceServers, voiceCloneStatus } from '../services/voiceClone.js';

const router = express.Router();

// POST /api/voice-clone/start  body: { backend?: 'xtts'|'f5tts' }
router.post('/start', async (req, res) => {
  try {
    const r = await startVoiceServers(req.body?.backend || null);
    res.json({ ok: true, started: r, status: await voiceCloneStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/stop', (_req, res) => res.json(stopVoiceServers()));

router.get('/status', async (_req, res) => {
  try { res.json(await voiceCloneStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
