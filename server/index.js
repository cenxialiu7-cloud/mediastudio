import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import cors from 'cors';
import { setupWebSocket } from './ws.js';
import { PORT } from './config.js';
import jobsRoutes from './routes/jobs.js';
import editRoutes from './routes/edit.js';
import systemRoutes from './routes/system.js';
import settingsRoutes from './routes/settings.js';
import uploadRoutes from './routes/upload.js';
import voicesRoutes from './routes/voices.js';
import voiceTrainRoutes from './routes/voiceTrain.js';
import gptSovitsRoutes from './routes/gptSovits.js';
import gptSovitsTrainRoutes from './routes/gptSovitsTrain.js';
import voiceCloneRoutes from './routes/voiceClone.js';
import installRoutes from './routes/install.js';
import { load as loadSettings } from './settings.js';
import { execSync } from 'child_process';

loadSettings();

// Reap orphaned aux processes (voice_server.py on 9811/9812, api_v2.py on
// 9880) before we set up routes. Without this, "restart node" leaves the
// children alive with stale code — the most recent bug was voice_server.py
// running pre-yaml-seed code and triggering api_v2's broken /set_*_weights
// reload, causing every /tts to fail with [Errno 32] Broken pipe.
function reapStaleAuxProcesses() {
  const PORTS_AND_MARKERS = [
    [9811, /voice_server\.py/],   // gptsovits proxy + xtts backend
    [9812, /voice_server\.py/],   // f5tts backend
    [9880, /api_v2\.py/]          // GPT-SoVITS api
  ];
  for (const [port, marker] of PORTS_AND_MARKERS) {
    let pids = '';
    try { pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`).toString().trim(); }
    catch { continue; }
    for (const pid of pids.split(/\s+/).filter(Boolean)) {
      let cmd = '';
      try { cmd = execSync(`ps -o args= -p ${pid} 2>/dev/null`).toString(); } catch { continue; }
      if (!marker.test(cmd)) continue;            // not ours — leave it alone
      try { process.kill(Number(pid), 'SIGKILL'); console.log(`  cleaned orphan ${marker.source.replace(/\\\./g,'.')} pid=${pid} on :${port}`); }
      catch { /* already dead */ }
    }
  }
}
reapStaleAuxProcesses();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use('/api/jobs', jobsRoutes);
app.use('/api/jobs', editRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/voices', voicesRoutes);
app.use('/api/voice-train', voiceTrainRoutes);
app.use('/api/gpt-sovits', gptSovitsRoutes);
app.use('/api/gpt-sovits/train', gptSovitsTrainRoutes);
app.use('/api/voice-clone', voiceCloneRoutes);
app.use('/api/install', installRoutes);
app.use('/api', systemRoutes);

// Serve built client if present; otherwise serve the dev placeholder.
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>MediaStudio</title>
      <body style="font-family:system-ui;max-width:640px;margin:60px auto;line-height:1.6">
      <h1>MediaStudio API 已啟動</h1>
      <p>前端尚未建置。開發模式請另開終端機執行 <code>npm run client</code>（Vite，預設 <a href="http://localhost:5173">http://localhost:5173</a>），
      或執行 <code>npm run build</code> 後重新啟動。</p>
      <p>API 健康檢查：<a href="/api/status">/api/status</a></p></body>`);
  });
}

setupWebSocket(server);

server.listen(PORT, () => {
  console.log(`\n  MediaStudio 伺服器啟動於 http://localhost:${PORT}\n`);
});
