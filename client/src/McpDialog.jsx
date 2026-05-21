import React, { useEffect, useState } from 'react';
import { api } from './api.js';

function Copy({ text, label = '複製' }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* ignore */ } }}>
      {done ? '✓ 已複製' : label}
    </button>
  );
}

export default function McpDialog({ jobId, segmentCount, language, duration, onClose }) {
  const [mcp, setMcp] = useState(null);
  const [tab, setTab] = useState('claude-code');

  useEffect(() => {
    api.status().then((s) => setMcp(s.mcp || null));
  }, []);

  const installCmd = mcp?.installClaudeCode || 'claude mcp add mediastudio -- node /path/to/MediaStudio/mcp/server.js';
  const coworkJson = mcp ? JSON.stringify(mcp.coworkConfig, null, 2) : '';

  const prompt =
`請用 MediaStudio MCP 幫我為這支影片產生內容規劃：
- jobId: ${jobId}
- 已轉錄段數: ${segmentCount || '?'}，語言: ${language || '?'}，長度: ${duration ? Math.round(duration) + 's' : '?'}

步驟：
1) 呼叫 mediastudio_get_transcript({ jobId: "${jobId}", withTimestamps: true }) 拿逐字稿。
2) 依照下列 schema 產生規劃：
   {
     "summary": "整體 2–4 句摘要（讀者導向）",
     "chapters": [ { "title": "...", "start": "HH:MM:SS", "end": "HH:MM:SS?" } ],   // 4–10 個，覆蓋全片
     "shorts":  [ { "title": "...", "start": "HH:MM:SS", "end": "HH:MM:SS", "hook": "前 3 秒鉤子", "why": "為什麼這段適合做短影片" } ],   // 3–6 個，每段 20–60 秒
     "titles":  [ "5 個 YouTube/社群標題候選" ]
   }
3) 呼叫 mediastudio_save_plan({ jobId: "${jobId}", plan: <上面的物件> }) 存回去；存好後 MediaStudio 編輯器會立刻顯示，章節時間碼可點擊跳播，短影片旁有「✂ 裁出」按鈕。
4) 如果我說「裁出第 N 個短影片」，請呼叫 mediastudio_cut_clip 把它做出來。`;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>🤖 用 Claude Code / Cowork 跑「摘要 / 章節 / 短影片」（透過本機 MCP）</h3>
          <span className="spacer" />
          <button onClick={onClose}>關閉</button>
        </div>

        <p className="muted" style={{ marginTop: 0 }}>
          AI 規劃這部分已不再需要 API Key —— MediaStudio 內附一個 MCP server，由你的 Claude 客戶端（Claude Code 或 Cowork）當作工具呼叫。下面是一次性安裝步驟，裝完之後在 Claude Code / Cowork 對話視窗就能用。
        </p>

        <div className="tabs">
          <button className={tab === 'claude-code' ? 'active' : ''} onClick={() => setTab('claude-code')}>Claude Code</button>
          <button className={tab === 'cowork' ? 'active' : ''} onClick={() => setTab('cowork')}>Cowork (Claude for Mac)</button>
          <button className={tab === 'prompt' ? 'active' : ''} onClick={() => setTab('prompt')}>3) 對話 prompt</button>
        </div>

        {tab === 'claude-code' && (
          <div>
            <p>在終端機執行一次（之後永久生效）：</p>
            <div className="codebox">
              <pre>{installCmd}</pre>
              <Copy text={installCmd} />
            </div>
            <p className="muted">完成後在 Claude Code 內輸入 <code>/mcp</code> 應能看到 <b>mediastudio</b>；其下 7 個工具（list_jobs / get_transcript / save_plan / cut_clip …）即可被呼叫。</p>
          </div>
        )}

        {tab === 'cowork' && (
          <div>
            <p>打開 Cowork 設定 → MCP servers → 新增；或直接編輯 <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>，把下面這段合併進 <code>mcpServers</code>：</p>
            <div className="codebox">
              <pre>{coworkJson}</pre>
              <Copy text={coworkJson} />
            </div>
            <p className="muted">儲存後重啟 Cowork。</p>
          </div>
        )}

        {tab === 'prompt' && (
          <div>
            <p>裝好後，在 Claude Code / Cowork 對話視窗貼下面這段 prompt（已填入這個任務的 jobId）：</p>
            <div className="codebox">
              <pre>{prompt}</pre>
              <Copy text={prompt} label="複製 prompt" />
            </div>
            <p className="muted">Claude 寫完並呼叫 save_plan 之後，這個編輯器面板會自動更新顯示章節、短影片、標題。</p>
          </div>
        )}

        <div className="codebox" style={{ marginTop: 12 }}>
          <div><b>Job ID</b>：<code>{jobId}</code></div>
          <Copy text={jobId} label="複製 jobId" />
        </div>
      </div>
    </div>
  );
}
