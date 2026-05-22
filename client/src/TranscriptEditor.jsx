import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import McpDialog from './McpDialog.jsx';
import VoiceLibrary from './VoiceLibrary.jsx';

function tc(sec) {
  if (!Number.isFinite(sec)) return '00:00.000';
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60, m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (h ? p(h) + ':' : '') + `${p(m)}:${p(s)}.${p(ms, 3)}`;
}
function parseTc(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (Number(h || 0) * 3600) + Number(mm) * 60 + Number(ss) + Number(((ms || '0') + '00').slice(0, 3)) / 1000;
}
// HH:MM:SS → seconds
function parseHMS(str) {
  if (typeof str === 'number') return str;
  const m = String(str || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return parseTc(str) ?? 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(((m[4] || '0') + '00').slice(0, 3)) / 1000;
}

export default function TranscriptEditor({ jobId, onClose, ops, artifacts, features = {}, jobMeta = {} }) {
  const [segments, setSegments] = useState(null);
  const [deleted, setDeleted] = useState(() => new Set());
  const [err, setErr] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [voiceFixFor, setVoiceFixFor] = useState(null);
  const [voicePath, setVoicePath] = useState('');
  const [voiceNewText, setVoiceNewText] = useState('');
  const [voiceBackend, setVoiceBackend] = useState('');     // '' = auto-pick preferred
  const [pickedVoice, setPickedVoice] = useState(null);     // voice library profile
  const [trainedModels, setTrainedModels] = useState([]);   // GPT-SoVITS trained models for picker
  const [pickedTrained, setPickedTrained] = useState(null); // selected trained model
  const [startingBackend, setStartingBackend] = useState(null); // 'xtts' | 'f5tts' while booting
  const [vfBusy, setVfBusy] = useState(false);                  // synchronous click feedback for 自動生成
  const [voiceBackendsLive, setVoiceBackendsLive] = useState(null); // overrides features.voiceCloneBackends after autoStart
  const [showVoiceLibrary, setShowVoiceLibrary] = useState(false);
  const [aiPlan, setAiPlan] = useState(null);
  const [showMcp, setShowMcp] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => {
    api.getSegments(jobId).then((r) => setSegments(r.segments)).catch((e) => setErr(e.message));
    api.getAiPlan(jobId).then((r) => setAiPlan(r.plan || null)).catch(() => {});
  }, [jobId]);

  // When MCP saves a plan (server broadcasts op aiplan done), refetch.
  useEffect(() => {
    const o = ops?.aiplan;
    if (o && o.state === 'done') api.getAiPlan(jobId).then((r) => setAiPlan(r.plan || null)).catch(() => {});
  }, [ops?.aiplan?.state, ops?.aiplan?.message, jobId]);

  const op = ops || {};

  function update(i, patch) { setSegments((p) => { const c = p.slice(); c[i] = { ...c[i], ...patch }; return c; }); }
  function toggleDel(i) { setDeleted((d) => { const n = new Set(d); n.has(i) ? n.delete(i) : n.add(i); return n; }); }
  function removeRow(i) { setSegments((p) => p.filter((_, k) => k !== i)); setDeleted(new Set()); }
  function splitRow(i) {
    setSegments((p) => {
      const c = p.slice();
      const s = c[i];
      const text = String(s.text || '');
      // Smart split: if the user inserted ANY whitespace inside the text, split at every
      // whitespace run. Time boundaries are derived from word-level timestamps when
      // available, otherwise fall back to proportional time allocation by character count.
      const re = /\s+/g;
      const splits = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > 0 && m.index + m[0].length < text.length) splits.push([m.index, m.index + m[0].length]);
      }
      let pieces;
      if (splits.length) {
        pieces = [];
        let cur = 0;
        for (const [a, b] of splits) { pieces.push({ text: text.slice(cur, a).trim(), end: a }); cur = b; }
        pieces.push({ text: text.slice(cur).trim(), end: text.length });
      } else {
        // No whitespace in text → legacy behavior: split at midpoint (text empty on right side)
        pieces = [{ text: text.trim(), end: Math.floor(text.length / 2) }, { text: '', end: text.length }];
      }
      const newSegs = timeAllocate(s, pieces);
      c.splice(i, 1, ...newSegs);
      return c;
    });
    setDeleted(new Set());
  }

  /**
   * Allocate a segment's time range to N text pieces.
   * Prefers word-level timestamps (mlx-whisper / faster-whisper provide these); falls
   * back to proportional-by-character when words[] is absent (OCR segments etc).
   * `pieces` shape: [{ text, end: charIndexAtSplitBoundary }] where `end` is in the
   * ORIGINAL text's coordinate system (incl. the whitespace we removed).
   */
  function timeAllocate(seg, pieces) {
    const totalChars = pieces.length ? pieces[pieces.length - 1].end : 1;
    const segStart = Number(seg.start) || 0;
    const segEnd = Number(seg.end) || segStart;
    const out = [];
    let pieceStart = segStart;
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      let pieceEnd;
      if (i === pieces.length - 1) {
        pieceEnd = segEnd;
      } else {
        const tw = boundaryFromWords(seg, p.end);
        pieceEnd = tw != null ? tw : segStart + (segEnd - segStart) * (p.end / Math.max(1, totalChars));
      }
      if (pieceEnd < pieceStart) pieceEnd = pieceStart; // monotonic
      out.push({ start: pieceStart, end: pieceEnd, text: p.text, speaker: seg.speaker });
      pieceStart = pieceEnd;
    }
    return out;
  }

  function boundaryFromWords(seg, charIndex) {
    const words = Array.isArray(seg.words) ? seg.words : null;
    if (!words || !words.length) return null;
    // Reconstruct char-position → word-end-time map by accumulating word text lengths.
    // whisper word strings often include a leading space; strip whitespace for char counting.
    let acc = 0;
    for (const w of words) {
      const wt = String(w.word || '').replace(/\s+/g, '');
      acc += wt.length;
      if (acc >= charIndex && Number.isFinite(w.end)) return Number(w.end);
    }
    return null;
  }
  function mergeDown(i) {
    setSegments((p) => { if (i >= p.length - 1) return p; const c = p.slice(); const a = c[i], b = c[i + 1]; c.splice(i, 2, { start: a.start, end: b.end, text: (a.text + ' ' + b.text).trim(), speaker: a.speaker }); return c; });
    setDeleted(new Set());
  }
  function seek(sec) { const v = videoRef.current; if (v) { v.currentTime = Math.max(0, sec + 0.001); v.play().catch(() => {}); } }

  const cleanSegs = () => segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text || '', speaker: s.speaker || undefined }));

  async function saveSubs() {
    setErr(null);
    try { await api.saveSegments(jobId, cleanSegs()); setSavedAt(Date.now()); }
    catch (e) { setErr(e.message); }
  }
  async function doCut() {
    setErr(null);
    const keepIndexes = segments.map((_, i) => i).filter((i) => !deleted.has(i));
    if (!keepIndexes.length) { setErr('全部段落都被刪除了，沒有可保留的內容'); return; }
    if (!confirm(`將剪掉 ${deleted.size} 段、保留 ${keepIndexes.length} 段，產生新影片。確定？`)) return;
    try { await api.cut(jobId, { keepIndexes, segments: cleanSegs() }); }
    catch (e) { setErr(e.message); }
  }
  async function doBurn() { setErr(null); try { await api.saveSegments(jobId, cleanSegs()); await api.burn(jobId); } catch (e) { setErr(e.message); } }
  async function doAutocut() { setErr(null); try { await api.autocut(jobId); } catch (e) { setErr(e.message); } }
  async function doOcr() {
    setErr(null);
    if (!confirm('將以 OCR 從影片畫面辨識燒錄字幕（取代目前的逐字稿）。可能要一些時間。確定？')) return;
    try { await api.ocr(jobId, { applyAsTranscript: true, fps: 2 }); }
    catch (e) { setErr(e.message); }
    setTimeout(() => api.getSegments(jobId).then((r) => setSegments(r.segments)).catch(() => {}), 1500);
  }
  function openMcp() { setShowMcp(true); }
  async function doShortCut(start, end) {
    setErr(null);
    try { await api.clip(jobId, { start: parseHMS(start), end: parseHMS(end) }); }
    catch (e) { setErr(e.message); }
  }
  async function doVoiceFix(i) {
    setErr(null);
    if (!voicePath.trim()) { setErr('請填入替換音檔的絕對路徑'); return; }
    try { await api.voicefix(jobId, { segmentIndex: i, replacementAudioPath: voicePath.trim(), segments: cleanSegs() }); setVoiceFixFor(null); setVoicePath(''); }
    catch (e) { setErr(e.message); }
  }
  async function doVoiceFixAuto(i) {
    setErr(null);
    if (!Array.isArray(segments) || !segments[i]) { setErr('段落資料尚未載入，請稍候'); return; }
    const newText = (voiceNewText || '').trim() || (segments[i].text || '');
    if (!newText.trim()) { setErr('請輸入修正後的文字'); return; }
    // Synchronous feedback so the user sees something instantly on click.
    setVfBusy(true);
    // eslint-disable-next-line no-console
    console.info('[voicefix-auto] click', { i, backend: voiceBackend || '(auto)', pickedTrained: pickedTrained?.name || null, newText });
    try {
      // If the picked backend is offline, try to auto-start it first instead
      // of bailing out — this is the #1 UX trap (button used to be disabled
      // silently when no backend was up, so clicks looked like "no response").
      const liveBackends = voiceBackendsLive || features.voiceCloneBackends || {};
      const bs = voiceBackend ? liveBackends[voiceBackend] : null;
      if (voiceBackend && (!bs || !bs.ok)) {
        setVfBusy(true);
        // re-use the same auto-start logic, awaited
        await autoStartBackend(voiceBackend);
        // brief settle; if it still failed, server-side will return 503 with a
        // clear message and we surface that via setErr.
      }

      const gptSovitsModel = (voiceBackend === 'gptsovits' && pickedTrained && pickedTrained.sovits && pickedTrained.gpt)
        ? { sovitsPath: pickedTrained.sovits.path, gptPath: pickedTrained.gpt.path, version: pickedTrained.version || 'v2Pro' }
        : undefined;
      const r = await api.voicefixAuto(jobId, {
        segmentIndex: i,
        newText,
        segments: cleanSegs(),
        backend: voiceBackend || undefined,    // '' → server picks preferred
        voiceId: pickedVoice ? pickedVoice.id : undefined,
        language: pickedVoice ? pickedVoice.language : undefined,
        gptSovitsModel
      });
      // eslint-disable-next-line no-console
      console.info('[voicefix-auto] accepted', r);
      setVoiceFixFor(null); setVoiceNewText('');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[voicefix-auto] failed', e);
      setErr(e.message || String(e));
    } finally { setVfBusy(false); }
  }

  // Click an offline backend → ask server to spawn it, poll status, then enable.
  async function autoStartBackend(b) {
    if (!b) return;
    setStartingBackend(b);
    setErr(null);
    try {
      if (b === 'gptsovits') {
        // gptsovits needs BOTH:
        //   - voice_server.py on 9811 (the proxy that voiceCloneStatus probes)
        //   - api_v2.py on 9880 (the actual TTS engine voice_server forwards to)
        // Start them in parallel; otherwise bs.ok stays false (probe hits 9811)
        // and the server rejects voicefix-auto with 503.
        await Promise.all([
          api.voiceCloneStart('xtts').catch((e) => { console.warn('voice-clone xtts start:', e.message); }),
          api.gpsStartApi().catch((e) => { console.warn('gpt-sovits api start:', e.message); })
        ]);
      } else {
        await api.voiceCloneStart(b);
      }
      // The server already waited for the port (up to 60s) before responding.
      // Refresh feature flags so the UI updates. Use local state — never mutate the prop,
      // because mutation doesn't re-render and silently breaks the gating logic elsewhere.
      try { const s = await api.voiceCloneStatus(); setVoiceBackendsLive(s.byBackend); } catch { /* */ }
      setVoiceBackend(b);
    } catch (e) {
      setErr(`啟動 ${b} 失敗：${e.message}`);
    } finally { setStartingBackend(null); }
  }

  // Load trained GPT-SoVITS models when user picks gptsovits backend.
  useEffect(() => {
    if (voiceBackend !== 'gptsovits') return;
    api.gpsModels().then((r) => {
      setTrainedModels(r.models || []);
      if (!pickedTrained && (r.models || []).length) setPickedTrained(r.models[0]);
    }).catch(() => {});
  }, [voiceBackend]);

  const opRow = (kind, label) => {
    const o = op[kind]; if (!o) return null;
    return <div className={`opbar ${o.state}`}>{label}：{o.state === 'running' ? `${Math.round((o.progress || 0) * 100)}% ${o.message || ''}` : o.state === 'done' ? '完成' : `失敗 — ${o.message}`}</div>;
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>逐字稿 / 文字驅動剪輯</h3>
          <span className="spacer" />
          {savedAt && <span className="muted">字幕已重新匯出</span>}
          <button onClick={onClose}>關閉</button>
        </div>
        {err && <div className="banner err">{err}</div>}

        <div className="editor-grid">
          <div className="editor-video">
            <video ref={videoRef} src={api.mediaUrl(jobId)} controls preload="metadata" />
            <div className="toolbar">
              <button className="primary" disabled={!segments} onClick={doCut} title="刪除打勾的段落後重新拼接影片">✂ 確認並剪輯（刪 {deleted.size} 段）</button>
              <button disabled={!segments || features.burnSubtitles === false} onClick={doBurn} title={features.burnSubtitles === false ? 'ffmpeg 未含 libass，無法燒錄' : '把目前字幕燒進影片'}>燒錄字幕到影片{features.burnSubtitles === false ? '（需 libass）' : ''}</button>
              <button disabled={!segments} onClick={saveSubs}>儲存並重新匯出字幕</button>
              <button disabled={!segments} onClick={doAutocut} title="需先安裝 auto-editor">AI 去靜音粗剪</button>
              <button disabled={features.ocr === false} onClick={doOcr} title={features.ocr === false ? '未安裝 PaddleOCR/RapidOCR' : '從影片畫面辨識燒錄字幕，取代逐字稿'}>📺 影片內字幕 OCR{features.ocr === false ? '（需 OCR 套件）' : ''}</button>
              <button disabled={!segments} onClick={openMcp} title="開啟在 Claude Code / Cowork 用本機 MCP 跑此功能的指引">🤖 摘要 / 章節 / 短影片（用 Claude Code / Cowork）</button>
              <button onClick={() => setShowVoiceLibrary(true)} title="管理聲音庫：學習克隆此講者，之後可用於聲音替換">🎙 聲音庫</button>
            </div>
            {opRow('cut', '文字驅動剪輯')}
            {opRow('burn', '燒錄字幕')}
            {opRow('autocut', 'AI 去靜音')}
            {opRow('ocr', '影片內字幕 OCR')}
            {opRow('aiplan', 'MCP 規劃儲存')}
            {opRow('voicefix', '口誤聲音替換')}
            {opRow('clip', '無損裁切')}
            {!!(artifacts && artifacts.length) && (
              <div className="artifacts">產出檔案：{artifacts.map((a) => (
                <a key={a.name} className="dl" href={api.artifactUrl(jobId, a.name)} title={a.label}>{a.label}</a>
              ))}</div>
            )}
            {aiPlan && (
              <div className="aiplan">
                {aiPlan.summary && <div className="ap-block"><b>摘要</b><p>{aiPlan.summary}</p></div>}
                {!!aiPlan.titles?.length && <div className="ap-block"><b>建議標題</b><ul>{aiPlan.titles.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
                {!!aiPlan.chapters?.length && (
                  <div className="ap-block"><b>章節</b>
                    <ul className="ap-list">
                      {aiPlan.chapters.map((c, i) => (
                        <li key={i}><button className="ts" onClick={() => seek(parseHMS(c.start))}>{c.start}</button> {c.title}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!aiPlan.shorts?.length && (
                  <div className="ap-block"><b>建議短影片</b>
                    <ul className="ap-list">
                      {aiPlan.shorts.map((s, i) => (
                        <li key={i}>
                          <button className="ts" onClick={() => seek(parseHMS(s.start))}>{s.start}–{s.end}</button>
                          <b style={{ marginLeft: 6 }}>{s.title}</b>
                          <button style={{ marginLeft: 6 }} onClick={() => doShortCut(s.start, s.end)} title="無損裁切此片段">✂ 裁出</button>
                          {s.hook && <div className="muted">Hook：{s.hook}</div>}
                          {s.why && <div className="muted">理由：{s.why}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <p className="muted tip">提示：點時間碼跳播；打勾 = 標記刪除；剪輯鈕會輸出只含未刪段落的新影片。</p>
          </div>

          <div className="seg-list">
            {!segments && !err && <p className="muted">載入中…</p>}
            {segments && segments.map((s, i) => (
              <div className={`seg ${deleted.has(i) ? 'del' : ''}`} key={i}>
                <div className="seg-times">
                  <label className="chk" title="標記為刪除（剪輯時移除）">
                    <input type="checkbox" checked={deleted.has(i)} onChange={() => toggleDel(i)} /> 刪
                  </label>
                  <button className="ts" onClick={() => seek(s.start)} title="跳到影片這裡">▶ {tc(s.start)}</button>
                  <span>→</span>
                  <input value={tc(s.end)} onChange={(e) => { const v = parseTc(e.target.value); if (v != null) update(i, { end: v }); }} />
                  {s.speaker !== undefined && <input className="spk" value={s.speaker || ''} placeholder="講者" onChange={(e) => update(i, { speaker: e.target.value })} />}
                </div>
                <textarea rows={2} value={s.text} onChange={(e) => update(i, { text: e.target.value })} />
                <div className="seg-actions">
                  <button onClick={() => splitRow(i)} title={/\S\s+\S/.test(s.text || '') ? '在你插入的空白處切分（時間軸按字級時間戳/字數比例自動分配）；切分後的每段可獨立做聲音替換' : '在文字中插入一個空白後再按切分；否則會從中間切'}>{/\S\s+\S/.test(s.text || '') ? `切分 ${((s.text || '').trim().match(/\s+/g) || []).length + 1} 段` : '切分'}</button>
                  <button onClick={() => mergeDown(i)} title="與下一段合併">合併↓</button>
                  <button onClick={() => removeRow(i)} title="直接從清單刪掉這段">移除</button>
                  <button onClick={() => { setVoiceFixFor(voiceFixFor === i ? null : i); setVoicePath(''); setVoiceNewText(s.text || ''); }} title="替換這段的聲音（口誤修正）">聲音替換…</button>
                </div>
                {voiceFixFor === i && (
                  <div className="voicefix">
                    <div className="muted" style={{ marginBottom: 6 }}>
                      <b>口誤修正</b>：輸入修正後的文字 → 用本機語音克隆服務（XTTS / F5-TTS）自動生成 → 拼回影片。也可手動填 wav 路徑。
                      <button
                        onClick={() => window.dispatchEvent(new CustomEvent('ms-open-settings'))}
                        style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px' }}
                        title="若出現「相依模組未安裝」，到設定的「功能與模組」一鍵安裝並查看進度">
                        🔧 安裝/管理語音模組
                      </button>
                    </div>
                    <div className="vf-row">
                      <span className="muted" style={{ fontSize: 11 }}>後端：</span>
                      <div className="segmented small">
                        {[
                          ['', '自動', '依目前 ready 狀態挑選'],
                          ['xtts', 'XTTS-v2', 'Coqui XTTS-v2（多語言、快、相似度普通）'],
                          ['f5tts', 'F5-TTS ✨', 'Flow-Matching；zero-shot 相似度比 XTTS 高很多'],
                          ['gptsovits', '🎓 GPT-SoVITS', '用「訓練聲音」訓練出的專屬模型（需先完成訓練）']
                        ].map(([v, l, t]) => {
                          const bs = (voiceBackendsLive || features.voiceCloneBackends)?.[v];
                          const offline = v && (!bs || !bs.ok);
                          const isStarting = startingBackend === v;
                          const label = isStarting ? '啟動中…' : `${l}${v && bs && bs.ready ? ' ●' : ''}${offline ? '⚠' : ''}`;
                          return (
                            <button key={v} type="button"
                              className={voiceBackend === v ? 'on' : ''}
                              disabled={isStarting}
                              onClick={() => {
                                if (offline) autoStartBackend(v);
                                else setVoiceBackend(v);
                              }}
                              title={t + (offline ? '\n(服務未啟動 — 點此自動啟動)' : '')}>
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Trained-model picker for GPT-SoVITS */}
                    {voiceBackend === 'gptsovits' && (
                      <div className="vf-row">
                        <span className="muted" style={{ fontSize: 11 }}>訓練模型：</span>
                        {trainedModels.length === 0 ? (
                          <span className="muted" style={{ fontSize: 11 }}>(尚無訓練好的模型；可繼續用 zero-shot 參考音克隆)</span>
                        ) : (
                          <select value={pickedTrained?.name || ''}
                            onChange={(e) => setPickedTrained(trainedModels.find((m) => m.name === e.target.value) || null)}
                            style={{ fontSize: 11, padding: '4px 6px' }}>
                            <option value="">(不指定 — zero-shot)</option>
                            {trainedModels.map((m) => (
                              <option key={m.name} value={m.name}>{m.name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                    <div className="vf-row">
                      <span className="muted" style={{ fontSize: 11 }}>聲音：</span>
                      {pickedVoice ? (
                        <span className="chip"><span className="chip-name">🎙 {pickedVoice.name} [{pickedVoice.language}]</span><button onClick={() => setPickedVoice(null)}>×</button></span>
                      ) : (
                        <span className="muted" style={{ fontSize: 11 }}>(預設：自動從此影片截 15 秒)</span>
                      )}
                      <button onClick={() => setShowVoiceLibrary(true)} style={{ fontSize: 11, marginLeft: 'auto' }}>從聲音庫挑選…</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                      <input style={{ flex: 1 }} placeholder="修正後的這段文字" value={voiceNewText} onChange={(e) => setVoiceNewText(e.target.value)} />
                      {/* IMPORTANT: do NOT disable on `voiceClone === false`. When no backend is
                          running, the click handler auto-starts whichever backend the user picked.
                          Disabling here makes the button look "dead" — the #1 reported UX bug. */}
                      <button className="primary"
                        disabled={vfBusy || !!startingBackend}
                        onClick={() => doVoiceFixAuto(i)}
                        title="用本機語音克隆服務自動生成並拼回影片">
                        {vfBusy ? '送出中…' : (startingBackend ? `啟動 ${startingBackend}…` : '✨ 自動生成')}
                      </button>
                    </div>
                    {(() => {
                      // Inline status: tell the user what'll happen on click.
                      const liveBackends = voiceBackendsLive || features.voiceCloneBackends || {};
                      const bs = voiceBackend ? liveBackends[voiceBackend] : null;
                      if (!voiceBackend) {
                        return <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>「自動」模式 — 後端會挑可用的 backend（首次需先啟動，耗時 30-60 秒）</div>;
                      }
                      if (bs && bs.ok && bs.ready) {
                        return <div className="muted" style={{ fontSize: 10, marginTop: 4, color: 'var(--ok, #3ecf8e)' }}>✓ {voiceBackend} 就緒，點下立即生成</div>;
                      }
                      return <div className="muted" style={{ fontSize: 10, marginTop: 4, color: 'var(--warn, #d4a047)' }}>⚠ {voiceBackend} 尚未啟動 — 點下會自動啟動再生成（首次需 30-60 秒）</div>;
                    })()}
                    {opRow('voicefix', '口誤聲音替換')}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input style={{ flex: 1 }} placeholder="或填入手動產生的 wav 路徑：/path/to/replacement.wav" value={voicePath} onChange={(e) => setVoicePath(e.target.value)} />
                      <button onClick={() => doVoiceFix(i)}>用此 wav 替換</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        {showMcp && <McpDialog jobId={jobId} segmentCount={segments?.length} language={jobMeta.language} duration={jobMeta.duration} onClose={() => setShowMcp(false)} />}
        {showVoiceLibrary && (
          <VoiceLibrary
            onClose={() => setShowVoiceLibrary(false)}
            currentJobId={jobId}
            currentJobDuration={jobMeta.duration}
            onPick={voiceFixFor != null ? setPickedVoice : null}
          />
        )}
      </div>
    </div>
  );
}
