import React, { useMemo } from 'react';
import { api } from './api.js';

/**
 * First-run onboarding overlay. Translates the raw /api/status dependency map
 * into a newbie-friendly, tiered capability dashboard:
 *
 *   Tier 1 — 基礎功能（下載即用）: yt-dlp + ffmpeg + whisper-asr
 *   Tier 2 — 進階功能（按需啟用）: auto-editor / OCR / 聲音克隆 / 聲音訓練
 *
 * Each row shows a plain-language status and a one-click 啟用 button wired to
 * the existing /api/install endpoints (progress streams over the same WS op
 * channel App already listens to, passed in via `sysOps`).
 */

const TIER1 = [
  { key: 'yt-dlp', title: '網址下載', desc: '從 YouTube 等網址抓影音', installable: false },
  { key: 'ffmpeg', title: '影音處理', desc: '抽音 / 裁切 / 燒字幕 / 文字驅動剪輯', installable: false },
  { key: 'whisper-asr', title: '語音轉文字', desc: '把聲音轉成逐字稿（字幕的基礎）', installable: true, installName: 'mlx-whisper' },
];

const TIER2 = [
  { key: 'auto-editor', title: 'AI 去靜音粗剪', desc: '自動移除無聲段落', installable: true, installName: 'auto-editor' },
  { key: 'paddleocr/rapidocr', title: '影片內字幕 OCR', desc: '辨識已燒錄在畫面上的字幕', installable: true, installName: 'paddleocr/rapidocr' },
];

function pill(state) {
  if (state === 'ready') return <span className="ob-pill ok">✅ 可用</span>;
  if (state === 'installing') return <span className="ob-pill installing">⬇ 安裝中…</span>;
  return <span className="ob-pill todo">⬇ 需啟用</span>;
}

export default function FirstRunOnboarding({ status, sysOps = {}, onInstall, onRefresh, onClose }) {
  const deps = status?.dependencies || {};
  const features = status?.features || {};

  const rowState = (key, installName) => {
    const d = deps[key];
    const installing = installName && sysOps[`install:${installName}`]?.state === 'running';
    if (installing) return 'installing';
    return d?.ok ? 'ready' : 'todo';
  };

  const tier1Ready = TIER1.every((r) => deps[r.key]?.ok);

  // Voice clone / training are a special tier — they need the GPT-SoVITS conda
  // env (installed from inside the 🎓 訓練聲音 panel) or the voice-clone server.
  const voiceReady = features.voiceCloneRunning || features.voiceClone;

  const Row = ({ r }) => {
    const st = rowState(r.key, r.installName);
    const op = r.installName ? sysOps[`install:${r.installName}`] : null;
    return (
      <div className="ob-row">
        <div className="ob-row-main">
          <div className="ob-row-title">{r.title} {pill(st)}</div>
          <div className="ob-row-desc">{r.desc}</div>
          {op?.state === 'running' && (
            <div className="ob-progress"><div className="ob-progress-fill" style={{ width: `${Math.round((op.progress || 0) * 100)}%` }} /></div>
          )}
        </div>
        {r.installable && st !== 'ready' && (
          <button className="primary" disabled={st === 'installing'}
            onClick={() => onInstall(r.installName)}>
            {st === 'installing' ? '安裝中…' : '⬇ 啟用'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="ob-backdrop">
      <div className="ob-modal">
        <div className="ob-head">
          <h2>👋 歡迎使用 MediaStudio</h2>
          <button className="ob-x" onClick={onClose} title="關閉引導">×</button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          MediaStudio 是離線的 AI 影音工作站。下面是各功能的就緒狀態 —
          <b>基礎功能下載即用</b>，進階功能（聲音克隆 / 訓練）較大，可按需啟用。
        </p>

        {/* Tier 1 */}
        <div className="ob-tier">
          <div className="ob-tier-head">
            <span className="ob-tier-badge t1">基礎功能</span>
            {tier1Ready ? <span className="muted">全部就緒，可以開始用了 🎉</span>
                        : <span className="muted">缺少項目請點「啟用」</span>}
          </div>
          {TIER1.map((r) => <Row key={r.key} r={r} />)}
        </div>

        {/* Tier 2 */}
        <div className="ob-tier">
          <div className="ob-tier-head">
            <span className="ob-tier-badge t2">進階功能（選配）</span>
            <span className="muted">用到再啟用，不影響基礎功能</span>
          </div>
          {TIER2.map((r) => <Row key={r.key} r={r} />)}

          {/* Voice clone / training — points into the dedicated panel */}
          <div className="ob-row">
            <div className="ob-row-main">
              <div className="ob-row-title">聲音克隆 / 訓練 {voiceReady ? pill('ready') : pill('todo')}</div>
              <div className="ob-row-desc">
                克隆講者音色做口誤替換、或訓練專屬聲音模型。需較大的模型（首次啟用約數 GB）。
              </div>
            </div>
            <button onClick={() => { onClose(); window.dispatchEvent(new CustomEvent('ms-open-voice-train')); }}>
              開啟訓練聲音 →
            </button>
          </div>
        </div>

        <div className="ob-actions">
          <button className="muted-btn" onClick={() => { api.status().then(onRefresh).catch(() => {}); }}>🔄 重新偵測</button>
          <button className="primary" onClick={onClose}>
            {tier1Ready ? '開始使用 →' : '先這樣，開始使用 →'}
          </button>
        </div>
      </div>
    </div>
  );
}
