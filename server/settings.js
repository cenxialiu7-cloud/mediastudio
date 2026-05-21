// Runtime-mutable settings, persisted to data/settings.json.
// Place this BEFORE any other modules that need OUTPUT_DIR — settings.load()
// updates config.js's live bindings.
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import * as cfg from './config.js';

const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  outputDir: path.join(DATA_DIR, 'output'),
  concurrency: Number(process.env.MEDIASTUDIO_CONCURRENCY || 1)
};

let current = { ...DEFAULTS };

function readFromDisk() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch { return {}; }
}

function writeToDisk() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2), 'utf8');
}

function applyToConfig() {
  // Make sure the directory exists, then push into config.js's live binding.
  fs.mkdirSync(current.outputDir, { recursive: true });
  cfg.setOutputDir(current.outputDir);
}

export function load() {
  const persisted = readFromDisk();
  current = { ...DEFAULTS, ...persisted };
  applyToConfig();
  return current;
}

export function getSettings() { return { ...current }; }

export function updateSettings(patch) {
  const next = { ...current };
  if (typeof patch.outputDir === 'string' && patch.outputDir.trim()) {
    const p = path.resolve(patch.outputDir.trim());
    try { fs.mkdirSync(p, { recursive: true }); fs.accessSync(p, fs.constants.W_OK); }
    catch (e) { throw new Error(`輸出資料夾無法寫入：${p} (${e.code || e.message})`); }
    next.outputDir = p;
  }
  if (patch.concurrency != null) {
    const n = Number(patch.concurrency);
    if (!(n >= 1 && n <= 8)) throw new Error('concurrency 需介於 1–8');
    next.concurrency = Math.floor(n);
  }
  current = next;
  writeToDisk();
  applyToConfig();
  return getSettings();
}
