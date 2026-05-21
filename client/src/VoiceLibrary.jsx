import React, { useEffect, useState, useRef } from 'react';
import { api } from './api.js';

export default function VoiceLibrary({ onClose, onPick, currentJobId, currentJobDuration }) {
  const [voices, setVoices] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('zh');
  const [speaker, setSpeaker] = useState('');
  const [fromJobStart, setFromJobStart] = useState(0);
  const [fromJobEnd, setFromJobEnd] = useState(20);
  const fileInputRef = useRef(null);

  async function refresh() {
    try { const r = await api.listVoices(); setVoices(r.voices); }
    catch (e) { setErr(e.message); }
  }
  useEffect(() => { refresh(); }, []);

  async function createFromFile() {
    if (!pendingFile) { setErr('請先選一個音／影片檔'); return; }
    setBusy(true); setErr(null);
    try {
      await api.uploadVoice(pendingFile, { name: name || pendingFile.name, language, speaker, maxSec: 20 });
      setPendingFile(null); setName(''); setSpeaker('');
      await refresh();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function createFromJob() {
    if (!currentJobId) { setErr('沒有當前任務'); return; }
    setBusy(true); setErr(null);
    try {
      await api.createVoiceFromJob({ jobId: currentJobId, start: Number(fromJobStart), end: Number(fromJobEnd), name: name || '從當前影片建立', language, speaker });
      setName(''); setSpeaker('');
      await refresh();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function del(id) {
    if (!confirm('刪除這個聲音檔？')) return;
    try { await api.deleteVoice(id); await refresh(); }
    catch (e) { setErr(e.message); }
  }

  function fmtDate(ts) { try { return new Date(ts).toLocaleString(); } catch { return ''; } }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>🎙 聲音庫 — 學習與管理克隆聲音</h3>
          <span className="spacer" />
          <button onClick={onClose}>關閉</button>
        </div>
        {err && <div className="banner err">{err}</div>}

        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          系統會把你提供的乾淨人聲存成「參考音」(15–20 秒，自動去頭尾靜音)。之後做「聲音替換」時可直接從這裡挑一個聲音檔，模型依此模仿。<b>要更好的相似度</b>：稍後用 <code>tools/build_voice_dataset.py</code> 對該講者做 GPT-SoVITS 微調（見 <code>docs/voice-cloning.md</code>）。
        </div>

        <div className="row">
          <div className="col" style={{ minWidth: 320 }}>
            <h4 style={{ margin: '4px 0' }}>新增聲音 — 從本機檔案</h4>
            <input ref={fileInputRef} type="file" accept="video/*,audio/*" onChange={(e) => setPendingFile(e.target.files?.[0] || null)} />
            <input placeholder="聲音名稱 (e.g. 熊敖)" value={name} onChange={(e) => setName(e.target.value)} />
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} style={{ flex: 1 }}>
                <option value="zh">中文 (zh)</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option>
              </select>
              <input placeholder="講者標籤" value={speaker} onChange={(e) => setSpeaker(e.target.value)} style={{ flex: 1 }} />
            </div>
            <button className="primary" disabled={busy || !pendingFile} onClick={createFromFile}>{busy ? '上傳中…' : '建立聲音檔（會抽前 20 秒並存為參考音）'}</button>
          </div>

          {currentJobId && (
            <div className="col" style={{ minWidth: 280 }}>
              <h4 style={{ margin: '4px 0' }}>新增聲音 — 從當前影片擷取</h4>
              <div className="muted" style={{ fontSize: 12 }}>從這部影片 [start, end] 秒擷取，會自動轉成 24 kHz 單聲道乾淨樣本。</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" min="0" max={currentJobDuration || 0} value={fromJobStart} onChange={(e) => setFromJobStart(e.target.value)} style={{ width: 90 }} />
                <span style={{ alignSelf: 'center' }}>→</span>
                <input type="number" min="0" max={currentJobDuration || 0} value={fromJobEnd} onChange={(e) => setFromJobEnd(e.target.value)} style={{ width: 90 }} />
                <span className="muted" style={{ alignSelf: 'center' }}>秒</span>
              </div>
              <button className="primary" disabled={busy} onClick={createFromJob}>從影片擷取並建立</button>
            </div>
          )}
        </div>

        <h4 style={{ marginTop: 14 }}>聲音庫（{voices.length}）</h4>
        {!voices.length && <p className="muted">尚未建立聲音檔。</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {voices.map((v) => (
            <li key={v.id} className="job" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{v.name} <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>[{v.language}] {v.speaker || ''}</span></div>
                <div className="muted" style={{ fontSize: 11 }}>{fmtDate(v.createdAt)} · {v.duration?.toFixed?.(1) || v.duration} s · {v.refText ? `「${v.refText.slice(0, 30)}…」` : '(無參考文字)'}</div>
              </div>
              <audio controls src={api.voiceRefUrl(v.id)} style={{ height: 28 }} />
              {onPick && <button className="primary" onClick={() => { onPick(v); onClose(); }}>使用此聲音</button>}
              <button onClick={() => del(v.id)} title="刪除">🗑</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
