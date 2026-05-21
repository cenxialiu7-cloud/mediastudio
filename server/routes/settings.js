import express from 'express';
import { getSettings, updateSettings } from '../settings.js';

const router = express.Router();

router.get('/', (_req, res) => res.json(getSettings()));

router.put('/', (req, res) => {
  try { res.json(updateSettings(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

export default router;
