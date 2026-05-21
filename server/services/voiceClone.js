import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { OUTPUT_DIR } from '../config.js';
import { run } from './proc.js';
import { broadcast } from '../ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const VOICE_SERVER_PY = path.join(ROOT, 'python', 'voice_server.py');

const HOST = process.env.MEDIASTUDIO_VOICE_HOST || '127.0.0.1';
// Two-server topology (different backends need different Python envs).
// Each instance of voice_server.py is started on its own port.
export const BACKEND_URLS = {
  xtts:       process.env.MEDIASTUDIO_VOICE_URL_XTTS  || `http://${HOST}:9811`,
  f5tts:      process.env.MEDIASTUDIO_VOICE_URL_F5TTS || `http://${HOST}:9812`,
  voicecraft: process.env.MEDIASTUDIO_VOICE_URL_VOICECRAFT || `http://${HOST}:9813`,
  // GPT-SoVITS lives in its own python venv; we let the xtts voice_server.py
  // (any one of them really) proxy the call to the GPT-SoVITS api_v2 HTTP server.
  gptsovits:  process.env.MEDIASTUDIO_VOICE_URL_GPTSOVITS || `http://${HOST}:9811`
};
// Back-compat: a generic VOICE_URL (legacy callers / status display).
export const VOICE_URL = BACKEND_URLS.xtts;

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = { raw: txt }; }
  if (!r.ok) throw new Error(body.error || `voice-server ${r.status}`);
  return body;
}

/**
 * Aggregate health across all configured backend URLs. Returns a per-backend
 * status map so the UI can show separately whether xtts / f5tts are up.
 */
export async function voiceCloneStatus() {
  const results = await Promise.all(Object.entries(BACKEND_URLS).map(async ([name, url]) => {
    try {
      const r = await fetchJson(`${url}/health`);
      return [name, { ok: true, url, ready: !!(r.ready && r.ready[name]), loading: !!(r.loading && r.loading[name]), model: r.models && r.models[name], available: (r.available || []).includes(name) }];
    } catch (e) {
      return [name, { ok: false, url, ready: false, error: e.message }];
    }
  }));
  const byBackend = Object.fromEntries(results);
  const anyOk = Object.values(byBackend).some((b) => b.ok);
  const anyReady = Object.values(byBackend).some((b) => b.ready);
  // Pick a "preferred" backend for the legacy /voicefix-auto path: f5tts if ready else xtts.
  const preferred = byBackend.f5tts?.ready ? 'f5tts' : (byBackend.xtts?.ready ? 'xtts' : null);
  return { ok: anyOk, ready: anyReady, byBackend, preferred };
}

/**
 * Cut a short reference clip from the original audio for the voice-clone model.
 * Picks ~6s of speech NOT inside the segment-to-replace (so the model sees the
 * speaker's clean voice without the words it's about to overwrite).
 * Returns the produced wav path.
 */
/**
 * Cut a clean reference clip from the original audio for the voice-clone model.
 * Quality of the clone scales with reference length & cleanliness. Defaults to 15 s
 * (XTTS / F5-TTS / CosyVoice all do markedly better with >10 s of same-speaker audio).
 * Prefers a window just before/after the segment to avoid the words being replaced.
 */
// Cut an EXACT [start, end] window from the source — used by GPT-SoVITS where
// the ref must align with a known transcript (the caller picked these times
// because they correspond to actual subtitle segments).
export async function cutExactRange(srcVideo, start, end, jobId) {
  const out = path.join(OUTPUT_DIR, `${jobId}.voiceref.wav`);
  const { code, stderr } = await run('ffmpeg', [
    '-y', '-ss', String(start), '-t', String(Math.max(0.1, end - start)), '-i', srcVideo,
    '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out
  ]);
  if (code !== 0) throw new Error(`ffmpeg exact-range cut failed (${code})\n${stderr.slice(-400)}`);
  return out;
}

export async function cutReferenceClip(srcVideo, avoidStart, avoidEnd, duration, jobId, durationSec = 15) {
  let start, len;
  if (avoidStart >= durationSec + 0.5) {
    start = Math.max(0, avoidStart - durationSec - 0.2); len = Math.min(durationSec, avoidStart - 0.2 - start);
  } else if ((duration || 0) - avoidEnd >= durationSec + 0.5) {
    start = avoidEnd + 0.2; len = durationSec;
  } else if (duration && duration > durationSec + 1) {
    // Pick the longest window that avoids the edit zone.
    const beforeLen = Math.max(0, avoidStart - 0.2);
    const afterLen  = Math.max(0, (duration || 0) - avoidEnd - 0.2);
    if (beforeLen >= afterLen) { start = 0; len = beforeLen; }
    else { start = avoidEnd + 0.2; len = afterLen; }
  } else {
    // fallback: just take the segment itself
    start = avoidStart; len = Math.max(2, avoidEnd - avoidStart);
  }
  const out = path.join(OUTPUT_DIR, `${jobId}.voiceref.wav`);
  // 24 kHz mono PCM works across XTTS / F5-TTS / CosyVoice / GPT-SoVITS.
  const { code, stderr } = await run('ffmpeg', [
    '-y', '-ss', String(start), '-t', String(len), '-i', srcVideo,
    '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out
  ]);
  if (code !== 0) throw new Error(`ffmpeg reference cut failed (${code})\n${stderr.slice(-400)}`);
  return out;
}

/**
 * Ask a local voice-clone backend to synthesize `targetText` in the speaker's voice.
 * `backend` selects xtts / f5tts / voicecraft (different ports under the hood).
 * Returns the absolute path of the generated wav.
 */
export async function synthesize({ referenceAudio, referenceText, targetText, language, jobId, label = 'synth', backend = 'xtts', gptSovits = null }) {
  const url = BACKEND_URLS[backend] || BACKEND_URLS.xtts;
  const outPath = path.join(OUTPUT_DIR, `${jobId}.${label}.wav`);
  if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch { /* ignore */ }
  const body = { backend, referenceAudio, referenceText: referenceText || '', targetText, language: language || 'zh-cn', outPath };
  // When using a trained GPT-SoVITS model, hand the weight paths to the proxy
  // so it can /set_gpt_weights + /set_sovits_weights on api_v2 before /tts.
  if (backend === 'gptsovits' && gptSovits && (gptSovits.sovitsPath || gptSovits.gptPath)) {
    body.gptSovitsSovits = gptSovits.sovitsPath || null;
    body.gptSovitsGpt = gptSovits.gptPath || null;
    body.gptSovitsVersion = gptSovits.version || null;
  }
  const r = await fetchJson(`${url}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { path: r.path || outPath, backend: r.backend || backend, model: r.model };
}

export function notRunningHint(backend) {
  return `本機 ${backend} 語音克隆服務未啟動。請呼叫 /api/voice-clone/start 自動啟動，或執行 ./start-voice-server.command`;
}

// --- auto-start voice servers (xtts on 9811, f5tts on 9812) ---
// In-process spawn so the user doesn't need to run a separate terminal script.
const voiceProcs = { xtts: null, f5tts: null };
let voiceLastErr = { xtts: '', f5tts: '' };

function emitVoice(backend, state, message) {
  broadcast('voice-clone', { backend, state, message, ts: Date.now() });
}

// IMPORTANT: don't actually `import TTS` here — Coqui's import loads torch +
// numpy + ~30 transitive deps and takes 8-15s on cold start, which trips a
// short spawn timeout and we'd falsely conclude "not installed". Use
// `importlib.util.find_spec` which inspects the metadata without executing
// module code (~40ms regardless of package weight).
function pyHasModule(py, mod, timeoutMs = 8000) {
  try {
    const r = spawnSync(py, ['-c', `import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('${mod}') else 1)`],
      { timeout: timeoutMs });
    return r.status === 0;
  } catch { return false; }
}
function findXttsPython() {
  // Try the system python (xtts uses Coqui TTS — needs system python where TTS was installed)
  const candidates = ['/usr/bin/python3', 'python3', '/opt/homebrew/bin/python3'];
  for (const py of candidates) if (pyHasModule(py, 'TTS')) return py;
  return null;
}
function findF5ttsPython() {
  const home = process.env.HOME || '';
  const venvPy = path.join(home, '.mediastudio-venv', 'f5tts', 'bin', 'python');
  if (fs.existsSync(venvPy) && pyHasModule(venvPy, 'f5_tts')) return venvPy;
  for (const py of ['python3', '/opt/homebrew/bin/python3']) if (pyHasModule(py, 'f5_tts')) return py;
  return null;
}

function spawnVoiceServer(backend, py, port) {
  if (voiceProcs[backend] && !voiceProcs[backend].killed) return voiceProcs[backend];
  const env = {
    ...process.env,
    COQUI_TOS_AGREED: '1',
    MEDIASTUDIO_VOICE_BACKEND: backend,
    MEDIASTUDIO_VOICE_PORT: String(port),
    PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'
  };
  const proc = spawn(py, [VOICE_SERVER_PY], { env, cwd: ROOT });
  voiceProcs[backend] = proc;
  voiceLastErr[backend] = '';
  emitVoice(backend, 'starting', `${backend} 啟動中（首次會載模型）…`);
  const onChunk = (b) => {
    const s = b.toString('utf8');
    voiceLastErr[backend] = (voiceLastErr[backend] + s).slice(-2500);
    const last = s.split('\n').filter((l) => l.trim()).pop();
    if (last) emitVoice(backend, 'starting', last.slice(0, 200));
  };
  proc.stdout.on('data', onChunk);
  proc.stderr.on('data', onChunk);
  proc.on('close', (code) => {
    voiceProcs[backend] = null;
    emitVoice(backend, code === 0 ? 'stopped' : 'error', `${backend} 結束 (exit ${code})\n${voiceLastErr[backend].slice(-400)}`);
  });
  proc.on('error', (e) => { voiceProcs[backend] = null; emitVoice(backend, 'error', e.message); });
  return proc;
}

async function waitReachable(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

/** Auto-start one or more voice servers. If `which` is omitted, starts both whose deps are available. */
export async function startVoiceServers(which) {
  const targets = which ? [which] : ['xtts', 'f5tts'];
  const started = {};
  if (targets.includes('xtts')) {
    if (voiceProcs.xtts && !voiceProcs.xtts.killed) started.xtts = { ok: true, alreadyRunning: true };
    else {
      const py = findXttsPython();
      if (!py) started.xtts = { ok: false, error: 'Coqui TTS 未安裝在系統 python（pip install --user coqui-tts 或 TTS）' };
      else { spawnVoiceServer('xtts', py, 9811); started.xtts = { ok: true, python: py }; }
    }
  }
  if (targets.includes('f5tts')) {
    if (voiceProcs.f5tts && !voiceProcs.f5tts.killed) started.f5tts = { ok: true, alreadyRunning: true };
    else {
      const py = findF5ttsPython();
      if (!py) started.f5tts = { ok: false, error: 'F5-TTS 未安裝在 ~/.mediastudio-venv/f5tts。請手動建 venv 後 pip install f5-tts' };
      else { spawnVoiceServer('f5tts', py, 9812); started.f5tts = { ok: true, python: py }; }
    }
  }
  // Wait for ports to come up (max 60s total)
  const waits = [];
  if (started.xtts?.ok) waits.push(waitReachable(BACKEND_URLS.xtts).then((ok) => started.xtts.ready = ok));
  if (started.f5tts?.ok) waits.push(waitReachable(BACKEND_URLS.f5tts).then((ok) => started.f5tts.ready = ok));
  await Promise.all(waits);
  return started;
}

export function stopVoiceServers() {
  for (const k of ['xtts', 'f5tts']) {
    const p = voiceProcs[k];
    if (p && !p.killed) { try { p.kill('SIGTERM'); } catch { /* */ } }
    voiceProcs[k] = null;
  }
  return { ok: true };
}
