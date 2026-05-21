const base = '';

async function j(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const e = await r.json(); if (e.error) msg = e.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.headers.get('content-type')?.includes('application/json') ? r.json() : r.text();
}

export const api = {
  status: () => j('GET', '/api/status'),
  listJobs: () => j('GET', '/api/jobs'),
  createJobs: (items, options) => j('POST', '/api/jobs', { items, options }),
  getSegments: (id) => j('GET', `/api/jobs/${id}/segments`),
  saveSegments: (id, segments) => j('PUT', `/api/jobs/${id}/segments`, { segments }),
  cancel: (id) => j('POST', `/api/jobs/${id}/cancel`),
  remove: (id) => j('DELETE', `/api/jobs/${id}`),
  downloadUrl: (id, fmt) => `/api/jobs/${id}/download/${fmt}`,
  // editing / artifacts
  mediaUrl: (id) => `/api/jobs/${id}/media`,
  artifactUrl: (id, name) => `/api/jobs/${id}/artifact/${encodeURIComponent(name)}`,
  cut: (id, body) => j('POST', `/api/jobs/${id}/cut`, body),
  clip: (id, body) => j('POST', `/api/jobs/${id}/clip`, body),
  burn: (id, body) => j('POST', `/api/jobs/${id}/burn`, body || {}),
  autocut: (id, body) => j('POST', `/api/jobs/${id}/autocut`, body || {}),
  voicefix: (id, body) => j('POST', `/api/jobs/${id}/voicefix`, body),
  voicefixAuto: (id, body) => j('POST', `/api/jobs/${id}/voicefix-auto`, body),
  // Voice library
  listVoices: () => j('GET', '/api/voices'),
  voiceRefUrl: (id) => `/api/voices/${id}/ref`,
  createVoiceFromJob: (body) => j('POST', '/api/voices/from-job', body),
  uploadVoice: (file, fields, onProgress) => new Promise((resolve, reject) => {
    const fd = new FormData(); fd.append('file', file, file.name);
    for (const k of Object.keys(fields || {})) fd.append(k, fields[k]);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/voices/upload', true);
    xhr.upload.onprogress = (ev) => onProgress && ev.lengthComputable && onProgress(ev.loaded, ev.total);
    xhr.onload = () => { let b; try { b = JSON.parse(xhr.responseText); } catch { b = { error: xhr.responseText }; }
      if (xhr.status < 300) resolve(b); else reject(new Error(b.error || `upload ${xhr.status}`)); };
    xhr.onerror = () => reject(new Error('上傳失敗'));
    xhr.send(fd);
  }),
  deleteVoice: (id) => j('DELETE', `/api/voices/${id}`),
  // One-click install of optional deps
  installDep: (name) => j('POST', `/api/install/${encodeURIComponent(name)}`),
  // Voice training (build fine-tune dataset)
  listVoiceTrainings: () => j('GET', '/api/voice-train'),
  getVoiceTraining: (id) => j('GET', `/api/voice-train/${id}`),
  voiceTrainStartLocal: (source, options) => j('POST', '/api/voice-train', { source, options }),
  voiceTrainSamples: (id, n = 5) => j('GET', `/api/voice-train/${id}/sample?n=${n}`),
  voiceTrainAudioUrl: (id, audioPath) => `/api/voice-train/${id}/audio?path=${encodeURIComponent(audioPath)}`,
  voiceTrainSaveAsVoice: (id, name, extras = {}) => j('POST', `/api/voice-train/${id}/save-as-voice`, { name, ...extras }),
  voiceTrainDelete: (id, removeFiles = false) => j('DELETE', `/api/voice-train/${id}${removeFiles ? '?removeFiles=1' : ''}`),
  // GPT-SoVITS auto-installer + WebUI launcher + trained models
  gpsStatus: () => j('GET', '/api/gpt-sovits/status'),
  gpsInstall: (body) => j('POST', '/api/gpt-sovits/install', body || {}),
  gpsStartWebui: () => j('POST', '/api/gpt-sovits/webui/start'),
  gpsStopWebui: () => j('POST', '/api/gpt-sovits/webui/stop'),
  gpsStartApi: () => j('POST', '/api/gpt-sovits/api/start'),
  gpsModels: () => j('GET', '/api/gpt-sovits/models'),
  gpsDatasets: () => j('GET', '/api/gpt-sovits/datasets'),
  // Headless GPT-SoVITS training (bypasses Gradio WebUI; back-end orchestrates 1A/1B steps)
  gpsTrainStart: (body) => j('POST', '/api/gpt-sovits/train', body || {}),
  gpsTrainList: () => j('GET', '/api/gpt-sovits/train'),
  gpsTrainGet: (id) => j('GET', `/api/gpt-sovits/train/${id}`),
  gpsTrainCancel: (id) => j('POST', `/api/gpt-sovits/train/${id}/cancel`),
  gpsTrainPreview: (id, body) => j('POST', `/api/gpt-sovits/train/${id}/preview`, body),
  gpsTrainImport: (id, body) => j('POST', `/api/gpt-sovits/train/${id}/import-to-library`, body || {}),
  gpsDatasetSamples: (id, n = 5) => j('GET', `/api/gpt-sovits/datasets/${encodeURIComponent(id)}/samples?n=${n}`),
  gpsDatasetDelete: (id) => j('DELETE', `/api/gpt-sovits/datasets/${encodeURIComponent(id)}`),
  // Voice-clone auto-start (xtts on 9811, f5tts on 9812)
  voiceCloneStart: (backend) => j('POST', '/api/voice-clone/start', backend ? { backend } : {}),
  voiceCloneStop: () => j('POST', '/api/voice-clone/stop'),
  voiceCloneStatus: () => j('GET', '/api/voice-clone/status'),
  voiceTrainUpload: (file, fields, onProgress) => new Promise((resolve, reject) => {
    const fd = new FormData(); fd.append('file', file, file.name);
    for (const k of Object.keys(fields || {})) fd.append(k, String(fields[k] ?? ''));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/voice-train/upload', true);
    xhr.upload.onprogress = (ev) => onProgress && ev.lengthComputable && onProgress(ev.loaded, ev.total);
    xhr.onload = () => { let b; try { b = JSON.parse(xhr.responseText); } catch { b = { error: xhr.responseText }; }
      if (xhr.status < 300) resolve(b); else reject(new Error(b.error || `upload ${xhr.status}`)); };
    xhr.onerror = () => reject(new Error('上傳失敗'));
    xhr.send(fd);
  }),
  ocr: (id, body) => j('POST', `/api/jobs/${id}/ocr`, body || {}),
  aiplan: (id, body) => j('POST', `/api/jobs/${id}/aiplan`, body || {}),
  getAiPlan: (id) => j('GET', `/api/jobs/${id}/aiplan`),
  // settings
  getSettings: () => j('GET', '/api/settings'),
  saveSettings: (patch) => j('PUT', '/api/settings', patch),
  // upload (multipart). onProgress(loaded, total)
  upload: (fileList, onProgress) => new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const f of fileList) fd.append('files', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.upload.onprogress = (ev) => onProgress && ev.lengthComputable && onProgress(ev.loaded, ev.total);
    xhr.onload = () => {
      let body; try { body = JSON.parse(xhr.responseText); } catch { body = { error: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(new Error(body.error || `upload ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('上傳失敗（網路錯誤）'));
    xhr.send(fd);
  })
};

export function connectWS(onMessage) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch { /* ignore */ } };
  ws.onclose = () => setTimeout(() => connectWS(onMessage), 2000);
  return ws;
}
