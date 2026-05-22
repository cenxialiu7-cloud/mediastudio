import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import ModuleManager from './ModuleManager.jsx';

export default function SettingsDialog({ onClose }) {
  const [s, setS] = useState(null);
  const [outputDir, setOutputDir] = useState('');
  const [concurrency, setConcurrency] = useState(1);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getSettings().then((r) => { setS(r); setOutputDir(r.outputDir || ''); setConcurrency(r.concurrency || 1); }).catch((e) => setErr(e.message));
  }, []);

  async function save() {
    setErr(null); setSaved(false); setSaving(true);
    try {
      const r = await api.saveSettings({ outputDir: outputDir.trim(), concurrency: Number(concurrency) });
      setS(r); setSaved(true);
    } catch (e) { setErr(e.message); }
    setSaving(false);
  }

  async function pickFolder() {
    // Modern Chromium: showDirectoryPicker — gives a handle but no absolute path.
    // We fall back to letting the user paste the path. Add a tiny helper to read
    // the picked handle's `name` so the field shows at least the folder name as
    // a hint; the user still types the absolute path.
    if (window.showDirectoryPicker) {
      try {
        const h = await window.showDirectoryPicker({ mode: 'readwrite' });
        // Browsers don't expose the absolute path for security reasons.
        setErr(`已選擇資料夾「${h.name}」。但瀏覽器不允許顯示完整路徑，請手動輸入該資料夾的絕對路徑後按儲存。`);
      } catch { /* user cancelled */ }
    } else {
      setErr('此瀏覽器不支援資料夾選擇器，請手動貼上絕對路徑。');
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>⚙ 設定</h3>
          <span className="spacer" />
          <button onClick={onClose}>關閉</button>
        </div>
        {err && <div className="banner err">{err}</div>}

        {/* Module install center — the main reason newbies open Settings */}
        <ModuleManager />
        <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '18px 0' }} />

        {!s && !err && <p className="muted">載入中…</p>}
        {s && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 4 }}>輸出檔案預設資料夾</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input style={{ flex: 1 }} value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="/Users/you/MediaStudio/output" />
                <button onClick={pickFolder} title="開啟資料夾選擇器（部分瀏覽器支援，會提示輸入路徑）">📁 瀏覽</button>
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>字幕、逐字稿、剪輯/燒字幕/口誤修正的影片，全部輸出到這裡。修改後立即生效（已產出的舊檔不會搬移）。</p>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 4 }}>同時處理任務數（1–8）</label>
              <input type="number" min="1" max="8" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} style={{ width: 120 }} />
              <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>越多越快但越吃資源；GPU 通常 1–2 即可，CPU 建議 1。改完需要重啟服務才生效。</p>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="primary" disabled={saving} onClick={save}>{saving ? '儲存中…' : '儲存設定'}</button>
              {saved && <span className="muted">已儲存</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
