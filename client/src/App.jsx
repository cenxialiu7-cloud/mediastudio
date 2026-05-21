import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, connectWS } from './api.js';
import TranscriptEditor from './TranscriptEditor.jsx';
import SettingsDialog from './SettingsDialog.jsx';
import ModelHelp from './ModelHelp.jsx';
import VoiceLibrary from './VoiceLibrary.jsx';
import VoiceTrainWizard from './VoiceTrainWizard.jsx';
import FirstRunOnboarding from './FirstRunOnboarding.jsx';

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3'];
const LANGS = [
  ['auto', '自動偵測'], ['zh', '中文'], ['en', '英文'], ['ja', '日文'],
  ['ko', '韓文'], ['es', '西班牙文'], ['fr', '法文'], ['de', '德文']
];
const STATE_LABEL = {
  queued: '排隊中', downloading: '下載中', extracting: '抽取音訊', transcribing: '轉錄中',
  writing: '輸出中', done: '完成', error: '失敗', canceled: '已取消'
};

function fmtDur(s) {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [opsByJob, setOpsByJob] = useState({}); // jobId -> { kind: {state,progress,message} }
  const [urls, setUrls] = useState('');
  const [files, setFiles] = useState('');
  const [opts, setOpts] = useState({ engine: 'asr', model: 'medium', language: 'auto', task: 'transcribe', diarize: false, formats: ['srt', 'vtt', 'txt-ts', 'txt', 'json'] });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showVoiceLib, setShowVoiceLib] = useState(false);
  const [showVoiceTrain, setShowVoiceTrain] = useState(false);
  // Once the training wizard has been opened we keep it mounted, just toggle
  // visibility. State (uploaded files, in-flight builds, GPT-SoVITS training
  // progress) survives close-reopen so a misclick never wipes the user's work.
  const [voiceTrainEverOpened, setVoiceTrainEverOpened] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return !localStorage.getItem('ms.onboarded.v1'); } catch { return true; }
  });
  const [pendingFiles, setPendingFiles] = useState([]);   // File[]
  const [uploadProgress, setUploadProgress] = useState(null); // {loaded,total}
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const dropTargetRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api.status(), api.listJobs()]);
      setStatus(s); setJobs(j.jobs);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => {
    refresh();
    const ws = connectWS((msg) => {
      if (msg.type === 'job') {
        setJobs((prev) => {
          const i = prev.findIndex((x) => x.id === msg.data.id);
          if (i < 0) return [msg.data, ...prev];
          const copy = prev.slice(); copy[i] = { ...copy[i], ...msg.data }; return copy;
        });
      } else if (msg.type === 'job-removed') {
        setJobs((prev) => prev.filter((x) => x.id !== msg.data.id));
      } else if (msg.type === 'op') {
        const { jobId, kind, state, progress, message } = msg.data;
        const k = jobId || '__sys__';
        setOpsByJob((prev) => ({ ...prev, [k]: { ...(prev[k] || {}), [kind]: { state, progress, message } } }));
        if (state === 'done') {
          api.listJobs().then((r) => setJobs(r.jobs)).catch(() => {});
          // refresh /api/status so dep list reflects newly-installed pkgs
          if (kind.startsWith('install:')) api.status().then(setStatus).catch(() => {});
        }
      }
    });
    // Onboarding "開啟訓練聲音" deep-link
    const openVT = () => { setShowVoiceTrain(true); setVoiceTrainEverOpened(true); };
    window.addEventListener('ms-open-voice-train', openVT);
    return () => { ws.close(); window.removeEventListener('ms-open-voice-train', openVT); };
  }, [refresh]);

  function acceptFiles(list) {
    const arr = Array.from(list || []).filter((f) => f && f.size > 0);
    if (!arr.length) return;
    // Loose filter: keep video/audio + common extensions; allow others if user insists.
    const okExt = /\.(mp4|mov|mkv|webm|avi|flv|wmv|m4v|mp3|wav|m4a|aac|flac|ogg|opus)$/i;
    const accepted = arr.filter((f) => (f.type && /^(video|audio)\//.test(f.type)) || okExt.test(f.name));
    const rejected = arr.length - accepted.length;
    setPendingFiles((prev) => [...prev, ...accepted]);
    if (rejected) setErr(`已忽略 ${rejected} 個非影音檔（副檔名不在常見清單）`);
  }
  function removePending(i) { setPendingFiles((p) => p.filter((_, k) => k !== i)); }

  function onDragEnter(e) { e.preventDefault(); e.stopPropagation(); setDragOver(true); }
  function onDragOver(e)  { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); }
  function onDragLeave(e) {
    if (e.target !== dropTargetRef.current && dropTargetRef.current?.contains(e.target)) return;
    setDragOver(false);
  }
  function onDrop(e) { e.preventDefault(); e.stopPropagation(); setDragOver(false); acceptFiles(e.dataTransfer.files); }

  async function submit() {
    setErr(null);
    const items = [];
    urls.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).forEach((u) => items.push({ type: 'url', value: u }));
    files.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).forEach((p) => items.push({ type: 'file', value: p }));
    if (!items.length && !pendingFiles.length) { setErr('請拖入檔案、或輸入網址 / 本機檔案絕對路徑'); return; }
    setBusy(true);
    try {
      if (pendingFiles.length) {
        setUploadProgress({ loaded: 0, total: pendingFiles.reduce((s, f) => s + f.size, 0) });
        const r = await api.upload(pendingFiles, (loaded, total) => setUploadProgress({ loaded, total }));
        for (const f of (r.files || [])) items.push({ type: 'file', value: f.path });
        setUploadProgress(null);
      }
      await api.createJobs(items, opts);
      setUrls(''); setFiles(''); setPendingFiles([]);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  const deps = status?.dependencies || {};
  const fmtMeta = status?.formats || {};
  // Backend renamed this dependency to "whisper-asr" (covers both mlx-whisper and faster-whisper);
  // keep the old name as a fallback for older builds.
  const asrReady = (deps['whisper-asr'] || deps['faster-whisper'])?.ok;
  const FORMATS = Object.keys(fmtMeta).length ? Object.keys(fmtMeta) : ['srt', 'vtt', 'txt-ts', 'txt', 'json'];
  const editingJob = editing && jobs.find((x) => x.id === editing);

  return (
    <div className="app">
      <header>
        <h1>MediaStudio <span className="tag">AI 影音工作站</span></h1>
        <div className="deps">
          {Object.entries(deps).map(([name, d]) => {
            const installable = ['auto-editor', 'paddleocr/rapidocr', 'mlx-whisper', 'coqui-tts'].includes(name);
            const installing = opsByJob['__sys__']?.[`install:${name}`]?.state === 'running';
            return (
              <span key={name} className={`dep ${d.ok ? 'ok' : (d.required === false ? 'opt' : 'bad')}`} title={d.purpose + (d.install ? ` — ${d.install}` : '')}>
                {d.ok ? '●' : '○'} {name}{d.version ? ` ${d.version}` : ''}{d.required === false && !d.ok ? '（選用）' : ''}
                {!d.ok && installable && (
                  <button className="dep-install" disabled={installing} onClick={async () => {
                    try { await api.installDep(name); }
                    catch (e) { setErr(`安裝失敗: ${e.message}`); }
                  }} title={`pip 安裝 ${name}`}>{installing ? '…安裝中' : '📦 安裝'}</button>
                )}
              </span>
            );
          })}
          <button className="cog"
            onClick={() => { setShowVoiceTrain(true); setVoiceTrainEverOpened(true); }}
            title="訓練聲音（為某位講者建立專屬克隆模型）— 抽屜面板，不會覆蓋主畫面">
            🎓 訓練聲音{voiceTrainEverOpened && !showVoiceTrain ? ' 📌' : ''}
          </button>
          <button className="cog" onClick={() => setShowVoiceLib(true)} title="聲音庫">🎙</button>
          <button className="cog" onClick={() => setShowOnboarding(true)} title="新手指南 / 功能就緒狀態">🚀 指南</button>
          <button className="cog" onClick={() => setShowSettings(true)} title="設定">⚙</button>
        </div>
      </header>

      {!asrReady && (
        <div className="banner warn">尚未偵測到轉錄引擎。下載 / 抽音 / 剪輯可正常運作，轉文字請先安裝（按右上角 <code>📦 安裝</code>，或在終端機執行 <code>pip install mlx-whisper</code>(Apple Silicon 推薦) / <code>pip install faster-whisper</code>）。</div>
      )}

      <section className="panel add">
        <h2>① 批次匯入影音來源（網址或本機檔）</h2>
        <div className="row">
          <div className="col">
            <label>網址（每行一個，支援 YouTube 等 yt-dlp 來源）</label>
            <textarea rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={'https://www.youtube.com/watch?v=...'} />
          </div>
          <div className="col">
            <label>本機檔案（拖入此區、點擊選檔，或直接貼絕對路徑）</label>
            <div
              ref={dropTargetRef}
              className={`dropzone ${dragOver ? 'over' : ''} ${pendingFiles.length ? 'has' : ''}`}
              onClick={(e) => { if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') fileInputRef.current?.click(); }}
              onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="video/*,audio/*,.mp4,.mov,.mkv,.webm,.avi,.flv,.wmv,.m4v,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
                style={{ display: 'none' }}
                onChange={(e) => { acceptFiles(e.target.files); e.target.value = ''; }}
              />
              {!pendingFiles.length && (
                <div className="dz-empty">
                  <div style={{ fontSize: 22 }}>⬇</div>
                  <div>把影音檔拖到這裡，或點此選檔</div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>大檔可直接拖入；會先上傳到伺服器再排入處理</div>
                </div>
              )}
              {!!pendingFiles.length && (
                <div className="dz-chips">
                  {pendingFiles.map((f, i) => (
                    <div key={i} className="chip">
                      <span className="chip-name" title={f.name}>{f.name}</span>
                      <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(f.size)}</span>
                      <button onClick={(ev) => { ev.stopPropagation(); removePending(i); }} title="移除">×</button>
                    </div>
                  ))}
                  <div className="muted" style={{ fontSize: 11, width: '100%' }}>點擊空白處可繼續加檔；按下方「加入佇列並開始」會先上傳。</div>
                </div>
              )}
            </div>
            {uploadProgress && (
              <div className="bar" style={{ marginTop: 6 }}><div className="fill" style={{ width: `${Math.round((uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}%` }} /></div>
            )}
            <details style={{ marginTop: 6 }}>
              <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>進階：手動輸入本機絕對路徑（每行一個）</summary>
              <textarea rows={2} value={files} onChange={(e) => setFiles(e.target.value)} placeholder={'/Users/you/Movies/a.mp4'} style={{ width: '100%', marginTop: 4 }} />
            </details>
          </div>
        </div>
        <div className="opts engine-row">
          <span className="muted" style={{ fontSize: 12 }}>處理方式：</span>
          <div className="segmented">
            <button type="button" className={opts.engine === 'asr' ? 'on' : ''} onClick={() => setOpts({ ...opts, engine: 'asr' })} title="用 Whisper 從聲音轉文字">🎙 語音轉文字 (Whisper)</button>
            <button type="button" className={opts.engine === 'ocr' ? 'on' : ''} disabled={status?.features?.ocr === false} onClick={() => setOpts({ ...opts, engine: 'ocr' })} title={status?.features?.ocr === false ? '需安裝 OCR 套件' : '從畫面辨識已燒錄的字幕（影片有字幕時最快）'}>📺 影片內字幕 OCR</button>
          </div>
        </div>
        <div className="opts">
          {opts.engine === 'asr' && (
            <>
              <label>模型
                <select value={opts.model} onChange={(e) => setOpts({ ...opts, model: e.target.value })}>{MODELS.map((m) => <option key={m}>{m}</option>)}</select>
                <ModelHelp />
              </label>
              <label>語言<select value={opts.language} onChange={(e) => setOpts({ ...opts, language: e.target.value })}>{LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label>任務<select value={opts.task} onChange={(e) => setOpts({ ...opts, task: e.target.value })}><option value="transcribe">原文逐字</option><option value="translate">翻譯成英文</option></select></label>
              <label className="chk"><input type="checkbox" checked={opts.diarize} onChange={(e) => setOpts({ ...opts, diarize: e.target.checked })} />說話者辨識</label>
            </>
          )}
          {opts.engine === 'ocr' && (
            <span className="muted" style={{ fontSize: 12 }}>OCR 引擎：{deps['paddleocr/rapidocr']?.version || '(未安裝)'}　預設掃描畫面下方 30% 區域、1–2 fps 取樣，輸出 SRT/TXT 等同 ASR。</span>
          )}
          <button className="primary" disabled={busy} onClick={submit}>{busy ? '加入中…' : '加入佇列並開始'}</button>
        </div>
        <div className="opts fmts">輸出格式：{FORMATS.map((f) => (
          <label key={f} className="chk" title={fmtMeta[f]?.timed ? '含時間軸' : '無時間軸'}>
            <input type="checkbox" checked={opts.formats.includes(f)} onChange={(e) => setOpts({ ...opts, formats: e.target.checked ? [...opts.formats, f] : opts.formats.filter((x) => x !== f) })} />
            {fmtMeta[f]?.label || f}{fmtMeta[f] ? (fmtMeta[f].timed ? ' ⏱' : '') : ''}
          </label>
        ))}</div>
        {err && <div className="banner err">{err}</div>}
      </section>

      <section className="panel">
        <h2>② 處理佇列（{jobs.length}）</h2>
        {!jobs.length && <p className="muted">尚無任務。</p>}
        <ul className="jobs">
          {jobs.map((j) => {
            const jops = opsByJob[j.id] || {};
            return (
              <li key={j.id} className={`job ${j.state}`}>
                <div className="job-head">
                  <span className={`badge ${j.state}`}>{STATE_LABEL[j.state] || j.state}</span>
                  <span className="job-title" title={j.source?.value}>{j.title}</span>
                  <span className="job-meta">{j.language ? `[${j.language}] ` : ''}{j.duration ? fmtDur(j.duration) : ''}{j.segmentCount ? ` · ${j.segmentCount} 段` : ''}</span>
                  <span className="spacer" />
                  {j.state === 'done' && j.outputs?.map((f) => (
                    <a key={f} className="dl" href={api.downloadUrl(j.id, f)} title={fmtMeta[f]?.label || f}>{fmtMeta[f]?.ext || f}</a>
                  ))}
                  {(j.segmentCount > 0) && <button onClick={() => setEditing(j.id)}>逐字稿 / 剪輯</button>}
                  {['queued', 'downloading', 'extracting', 'transcribing', 'writing'].includes(j.state) && <button onClick={() => api.cancel(j.id)}>取消</button>}
                  {['done', 'error', 'canceled'].includes(j.state) && <button onClick={() => api.remove(j.id)}>移除</button>}
                </div>
                <div className="bar"><div className="fill" style={{ width: `${Math.round((j.progress || 0) * 100)}%` }} /></div>
                <div className="job-msg">{j.error ? j.error.split('\n')[0] : j.message}</div>
                {Object.entries(jops).map(([k, o]) => (
                  <div key={k} className={`opbar ${o.state}`}>{k}: {o.state === 'running' ? `${Math.round((o.progress || 0) * 100)}% ${o.message || ''}` : o.state === 'done' ? '完成' : `失敗 — ${o.message}`}</div>
                ))}
                {!!(j.artifacts && j.artifacts.length) && (
                  <div className="artifacts">產出：{j.artifacts.map((a) => <a key={a.name} className="dl" href={api.artifactUrl(j.id, a.name)} title={a.label}>{a.label}</a>)}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {editing && <TranscriptEditor jobId={editing} ops={opsByJob[editing] || {}} artifacts={editingJob?.artifacts || []} features={status?.features || {}} jobMeta={{ language: editingJob?.language, duration: editingJob?.duration }} onClose={() => setEditing(null)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showVoiceLib && <VoiceLibrary onClose={() => setShowVoiceLib(false)} />}
      {showOnboarding && (
        <FirstRunOnboarding
          status={status}
          sysOps={opsByJob['__sys__'] || {}}
          onInstall={async (name) => { try { await api.installDep(name); } catch (e) { setErr(`啟用失敗: ${e.message}`); } }}
          onRefresh={setStatus}
          onClose={() => { setShowOnboarding(false); try { localStorage.setItem('ms.onboarded.v1', '1'); } catch {} }}
        />
      )}
      {voiceTrainEverOpened && (
        <VoiceTrainWizard visible={showVoiceTrain} onClose={() => setShowVoiceTrain(false)} jobs={jobs} />
      )}

      <footer className="muted">MediaStudio · FFmpeg + yt-dlp + faster-whisper · 批次轉錄 / 字幕 / 文字驅動剪輯 / 口誤聲音替換 · 跨平台 (macOS / Windows)</footer>
    </div>
  );
}
