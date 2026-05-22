import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api, connectWS } from './api.js';

/**
 * Module install center — the single place to see what's ready vs. what needs
 * installing, and to install heavy optional modules with a persistent progress
 * bar, a live log, and visible errors (bug tracking). Embedded in Settings;
 * the voicefix error and the training "立即安裝" both deep-link here.
 *
 * Tracks two WS channels:
 *   - 'op'         kind = "install:<name>"   (pip deps: auto-editor / OCR / whisper / coqui-tts)
 *   - 'gpt-sovits' kind = "install"          (the Miniforge GPT-SoVITS installer)
 */

const MODULES = [
  { key: 'asr', title: '語音轉文字 (Whisper)', tier: 1, dep: 'whisper-asr',
    desc: '把聲音轉成逐字稿 — 字幕與文字驅動剪輯的基礎。', installName: 'mlx-whisper' },
  { key: 'autoedit', title: 'AI 去靜音粗剪', tier: 2, dep: 'auto-editor',
    desc: '自動移除無聲段落。', installName: 'auto-editor' },
  { key: 'ocr', title: '影片內字幕 OCR', tier: 2, dep: 'paddleocr/rapidocr',
    desc: '辨識畫面上已燒錄的字幕。', installName: 'paddleocr/rapidocr' },
  { key: 'xtts', title: '語音克隆 XTTS-v2', tier: 2, voice: 'xtts',
    desc: '快速 zero-shot 聲音克隆，供口誤聲音替換使用。', installName: 'coqui-tts' },
  { key: 'gptsovits', title: '聲音克隆 / 訓練 (GPT-SoVITS)', tier: 2, gps: true,
    desc: '高相似度聲音克隆與專屬模型訓練（含 Miniforge，約 10 GB）。' },
];

function Pill({ state }) {
  const map = {
    ready: ['✅ 可用', 'ok'], installing: ['⏳ 安裝中', 'installing'],
    error: ['❌ 失敗', 'err'], todo: ['⬇ 需安裝', 'todo'],
  };
  const [label, cls] = map[state] || map.todo;
  return <span className={`mm-pill ${cls}`}>{label}</span>;
}

export default function ModuleManager() {
  const [status, setStatus] = useState(null);
  const [gps, setGps] = useState(null);
  const [ops, setOps] = useState({});         // kind -> {state, progress, message}
  const [logs, setLogs] = useState({});       // kind -> [recent lines]
  const [err, setErr] = useState(null);
  const logRef = useRef(logs);
  logRef.current = logs;

  const refresh = useCallback(() => {
    api.status().then(setStatus).catch((e) => setErr(e.message));
    api.gpsStatus().then(setGps).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const pushLog = (kind, line) => {
      if (!line) return;
      setLogs((prev) => {
        const arr = (prev[kind] || []).concat(line).slice(-60);
        return { ...prev, [kind]: arr };
      });
    };
    const ws = connectWS((msg) => {
      if (msg.type === 'op' && msg.data?.kind?.startsWith('install:')) {
        const { kind, state, progress, message } = msg.data;
        setOps((p) => ({ ...p, [kind]: { state, progress, message } }));
        pushLog(kind, message);
        if (state === 'done' || state === 'error') refresh();
      } else if (msg.type === 'gpt-sovits' && msg.data?.kind === 'install') {
        const { state, progress, message } = msg.data;
        setOps((p) => ({ ...p, gpts: { state, progress, message } }));
        pushLog('gpts', message);
        if (state === 'done' || state === 'error' || state === 'stopped') refresh();
      }
    });
    return () => ws.close();
  }, [refresh]);

  function moduleState(m) {
    const kind = m.gps ? 'gpts' : `install:${m.installName}`;
    const op = ops[kind];
    if (op?.state === 'running') return 'installing';
    if (op?.state === 'error') return 'error';
    if (m.gps) return gps?.installed ? 'ready' : (gps?.installing ? 'installing' : 'todo');
    if (m.voice) {
      const b = status?.dependencies?.['voice-clone-server']?.backends?.[m.voice];
      return b?.ok ? 'ready' : 'todo';
    }
    return status?.dependencies?.[m.dep]?.ok ? 'ready' : 'todo';
  }

  async function install(m) {
    setErr(null);
    try {
      if (m.gps) {
        setOps((p) => ({ ...p, gpts: { state: 'running', progress: 0.01, message: '啟動安裝…' } }));
        await api.gpsInstall({ skipPretrained: false });
      } else {
        const kind = `install:${m.installName}`;
        setOps((p) => ({ ...p, [kind]: { state: 'running', progress: 0.05, message: '啟動安裝…' } }));
        await api.installDep(m.installName);
        // Voice backends also need the local server started after the dep installs.
        if (m.voice) await api.voiceCloneStart(m.voice).catch(() => {});
      }
    } catch (e) { setErr(`啟動安裝失敗：${e.message}`); }
  }

  const Row = ({ m }) => {
    const st = moduleState(m);
    const kind = m.gps ? 'gpts' : `install:${m.installName}`;
    const op = ops[kind];
    const log = logs[kind] || [];
    const canInstall = (m.gps || m.installName) && st !== 'ready' && st !== 'installing';
    return (
      <div className="mm-row">
        <div className="mm-row-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mm-title">{m.title} <Pill state={st} /></div>
            <div className="mm-desc">{m.desc}</div>
          </div>
          {canInstall && <button className="primary" onClick={() => install(m)}>⬇ {m.voice ? '安裝並啟動' : '安裝'}</button>}
        </div>
        {op?.state === 'running' && (
          <div className="mm-progress"><div className="mm-progress-fill" style={{ width: `${Math.round((op.progress || 0) * 100)}%` }} /></div>
        )}
        {op && (op.state === 'running' || op.state === 'error') && (
          <div className={`mm-status ${op.state}`}>{op.message || (op.state === 'running' ? '安裝中…' : '失敗')}</div>
        )}
        {!!log.length && (
          <details className="mm-loglet">
            <summary>安裝日誌 / 錯誤追蹤（{log.length} 行）</summary>
            <pre>{log.slice(-40).join('\n')}</pre>
          </details>
        )}
      </div>
    );
  };

  const tier1 = MODULES.filter((m) => m.tier === 1);
  const tier2 = MODULES.filter((m) => m.tier === 2);

  return (
    <div className="mm">
      <h4 style={{ margin: '0 0 4px' }}>功能與模組</h4>
      <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
        基礎功能下載即用；進階模組較大，可在此一鍵安裝，下方會顯示即時進度與錯誤日誌。
      </p>
      {err && <div className="banner err" style={{ margin: '8px 0' }}>{err}</div>}

      <div className="mm-group-label">基礎功能</div>
      {tier1.map((m) => <Row key={m.key} m={m} />)}
      <div className="mm-group-label" style={{ marginTop: 12 }}>進階模組（選配）</div>
      {tier2.map((m) => <Row key={m.key} m={m} />)}

      <button className="mm-refresh" onClick={refresh}>🔄 重新偵測狀態</button>
    </div>
  );
}
