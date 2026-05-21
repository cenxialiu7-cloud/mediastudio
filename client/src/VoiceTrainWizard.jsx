import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api, connectWS } from './api.js';

/**
 * Voice training workspace — task-oriented tabs (no forced linear wizard).
 *
 *   models : list trained GPT-SoVITS models; preview / import / retrain inline
 *   train  : pick an existing dataset → configure → run training (live progress)
 *   build  : create a new dataset from a video (compressed single-page form)
 *
 * A pinned banner surfaces any in-progress build/train job across all tabs.
 * Last-used tab is remembered in localStorage so users land where they left off.
 */

const TAB_KEY = 'mediastudio.voiceTrainTab';
const VALID_TABS = ['models', 'datasets', 'train', 'build'];

function loadTab() {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return VALID_TABS.includes(v) ? v : 'models';
  } catch { return 'models'; }
}

export default function VoiceTrainWizard({ onClose, jobs = [], visible = true }) {
  const [activeTab, setActiveTab] = useState(loadTab);
  const [err, setErr] = useState(null);

  // Shared backend snapshots — fetched on open, refreshed when something changes.
  const [gps, setGps] = useState(null);
  const [gpsModels, setGpsModels] = useState([]);          // legacy disk scan; for count only
  const [gpsDatasets, setGpsDatasets] = useState([]);
  const [trainJobs, setTrainJobs] = useState([]);          // all train jobs (recent first)
  const [gpsOp, setGpsOp] = useState({});                  // { install: {state,progress,message}, webui: {...} }
  const gpsAutoStartedRef = useRef(false);

  // Dataset preselection (from "retrain" jumps / build completion).
  const [selectedDatasetId, setSelectedDatasetId] = useState(null);
  // Build-tab live training meta + samples
  const [buildJob, setBuildJob] = useState(null);          // voice-train (dataset build) state
  const [buildSamples, setBuildSamples] = useState([]);

  function switchTab(tab) {
    setActiveTab(tab);
    try { localStorage.setItem(TAB_KEY, tab); } catch {}
  }

  const refreshAll = useCallback(async () => {
    try {
      const [s, m, d, t] = await Promise.all([
        api.gpsStatus().catch(() => null),
        api.gpsModels().catch(() => ({ models: [] })),
        api.gpsDatasets().catch(() => ({ datasets: [] })),
        api.gpsTrainList().catch(() => ({ jobs: [] }))
      ]);
      setGps(s);
      setGpsModels(m.models || []);
      setGpsDatasets(d.datasets || []);
      setTrainJobs((t.jobs || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      // Auto-install if missing
      if (s && !s.installed && !s.installing && !gpsAutoStartedRef.current && activeTab === 'train') {
        gpsAutoStartedRef.current = true;
        api.gpsInstall({ skipPretrained: false }).catch((e) => setErr(`自動安裝失敗：${e.message}`));
      }
    } catch (e) { setErr(e.message); }
  }, [activeTab]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // WebSocket subscriptions for live progress (build job + train job + install)
  useEffect(() => {
    const ws = connectWS((msg) => {
      if (msg.type === 'voice-train') {
        // dataset-build job
        setBuildJob((cur) => (cur && cur.id === msg.data.id) ? { ...cur, ...msg.data } : msg.data);
      } else if (msg.type === 'gpt-sovits') {
        const { kind, state, progress, message } = msg.data;
        setGpsOp((prev) => ({ ...prev, [kind]: { state, progress, message } }));
        if (state === 'done' || state === 'error' || state === 'stopped') {
          refreshAll();
        }
      } else if (msg.type === 'gpts-train') {
        setTrainJobs((prev) => {
          const i = prev.findIndex((j) => j.id === msg.data.id);
          if (i < 0) return [msg.data, ...prev];
          const next = prev.slice(); next[i] = { ...next[i], ...msg.data };
          return next;
        });
        if (msg.data.state === 'done') refreshAll();
      }
    });
    return () => ws.close();
  }, [refreshAll]);

  // Pull samples once a build finishes (for the Build tab preview).
  useEffect(() => {
    if (buildJob && buildJob.state === 'done' && !buildSamples.length) {
      api.voiceTrainSamples(buildJob.id, 5).then((r) => setBuildSamples(r.samples || [])).catch(() => {});
    }
  }, [buildJob?.state]);

  // Cross-tab navigation helpers
  function goRetrain(datasetId) { setSelectedDatasetId(datasetId); switchTab('train'); }
  function goBuild() { switchTab('build'); }

  // Pinned banner content (active build or training)
  const activeTrain = trainJobs.find((j) => j.state === 'running' || j.state === 'queued');
  const activeBuild = buildJob && !['done', 'error', 'canceled'].includes(buildJob.state) ? buildJob : null;
  const completedModels = trainJobs.filter((j) => j.state === 'done' && j.sovitsWeight && j.gptWeight);

  return (
    <aside className={`drawer-right ${visible ? '' : 'hidden'}`} aria-hidden={!visible}>
      <div className="drawer-head">
        <h3>🎓 聲音訓練工作站</h3>
        {(activeBuild || activeTrain) && <span className="drawer-pinned-hint">📌 進行中 — 關閉不會中斷</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <InstallChip gps={gps} gpsOp={gpsOp.install}
          onInstall={() => api.gpsInstall({ skipPretrained: false }).catch((e) => setErr(e.message))}
          onStartWebui={async () => { try { const r = await api.gpsStartWebui(); if (r?.url) window.open(r.url, '_blank', 'noopener'); } catch (e) { setErr(`WebUI 啟動失敗：${e.message}`); } }} />
        <button onClick={onClose} title="收合面板（保留所有進度）">— 收合</button>
      </div>

      {/* Tabs */}
      <div className="vt-tabs">
        <button className={`vt-tab ${activeTab === 'models' ? 'on' : ''}`} onClick={() => switchTab('models')}>
          📚 我的模型 <span className="vt-tab-count">{completedModels.length}</span>
        </button>
        <button className={`vt-tab ${activeTab === 'datasets' ? 'on' : ''}`} onClick={() => switchTab('datasets')}>
          📁 資料集 <span className="vt-tab-count">{gpsDatasets.length}</span>
        </button>
        <button className={`vt-tab ${activeTab === 'train' ? 'on' : ''}`} onClick={() => switchTab('train')}>
          🎓 訓練
        </button>
        <button className={`vt-tab ${activeTab === 'build' ? 'on' : ''}`} onClick={() => switchTab('build')}>
          ➕ 建立資料集
        </button>
      </div>

      {/* Pinned in-progress banner */}
      {(activeTrain || activeBuild) && (
        <PinnedJobBanner
          activeBuild={activeBuild}
          activeTrain={activeTrain}
          onJumpToBuild={() => switchTab('build')}
          onJumpToTrain={() => switchTab('train')}
        />
      )}

      {err && <div className="banner err" style={{ marginTop: 8 }}>{err} <button onClick={() => setErr(null)} style={{ marginLeft: 8 }}>×</button></div>}

      {activeTab === 'models' && (
        <ModelsTab
          completedModels={completedModels}
          gpsDatasets={gpsDatasets}
          onRetrain={goRetrain}
          onGoBuild={goBuild}
          onErr={setErr}
        />
      )}

      {activeTab === 'datasets' && (
        <DatasetsTab
          gpsDatasets={gpsDatasets}
          onRefresh={refreshAll}
          onUseForTraining={(id) => { setSelectedDatasetId(id); switchTab('train'); }}
          onGoBuild={goBuild}
          onErr={setErr}
        />
      )}

      {activeTab === 'train' && (
        <TrainTab
          gps={gps}
          gpsOp={gpsOp}
          gpsDatasets={gpsDatasets}
          trainJobs={trainJobs}
          preselectDatasetId={selectedDatasetId}
          onPreselectConsumed={() => setSelectedDatasetId(null)}
          onGoBuild={goBuild}
          onErr={setErr}
        />
      )}

      {activeTab === 'build' && (
        <BuildTab
          jobs={jobs}
          buildJob={buildJob}
          setBuildJob={setBuildJob}
          buildSamples={buildSamples}
          setBuildSamples={setBuildSamples}
          onJumpToTrain={(datasetId) => goRetrain(datasetId)}
          onErr={setErr}
        />
      )}
    </aside>
  );
}

// ─── Install status chip (top-right) ─────────────────────────────────────────
function InstallChip({ gps, gpsOp, onInstall, onStartWebui }) {
  const [open, setOpen] = useState(false);
  if (!gps) return <span className="vt-chip muted">⚙ 偵測中</span>;
  const installing = gpsOp?.state === 'running';
  const installed = gps.installed;
  return (
    <>
      <button className={`vt-chip ${installed ? 'ok' : 'bad'}`} onClick={() => setOpen((o) => !o)}
        title={installed ? `GPT-SoVITS 已就緒（${gps.pretrainedCount} 預訓練檔）` : '尚未安裝'}>
        ⚙ {installed ? '就緒' : (installing ? `安裝中 ${Math.round((gpsOp.progress || 0) * 100)}%` : '未安裝')}
      </button>
      {open && (
        <div className="vt-popover" onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <b>GPT-SoVITS</b>
            <button onClick={() => setOpen(false)}>×</button>
          </div>
          {!installed && (
            <>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                走官方 install.sh 路徑（Miniforge + Python 3.10 conda env）。約 10 GB 流量、15–40 分鐘。
              </div>
              {installing && gpsOp && (
                <div className="opbar running" style={{ marginTop: 8 }}>
                  {Math.round((gpsOp.progress || 0) * 100)}% · {gpsOp.message || ''}
                </div>
              )}
              {!installing && (
                <button className="primary" style={{ marginTop: 8, width: '100%' }} onClick={() => { onInstall(); setOpen(false); }}>
                  🚀 立即安裝
                </button>
              )}
            </>
          )}
          {installed && (
            <>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>已安裝 {gps.pretrainedCount} 預訓練檔。</div>
              <div style={{ marginTop: 8 }}>
                <button onClick={() => { onStartWebui(); setOpen(false); }} title="開官方 Gradio WebUI 做手動調參／進階流程">
                  {gps.webui?.running ? `✓ WebUI 已在 :${gps.webui.port}` : '🌐 開官方 WebUI（進階）'}
                </button>
                {gps.webui?.url && <a className="btn" style={{ marginLeft: 6 }} href={gps.webui.url} target="_blank" rel="noreferrer">{gps.webui.url}</a>}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ─── Pinned in-progress banner ───────────────────────────────────────────────
function PinnedJobBanner({ activeBuild, activeTrain, onJumpToBuild, onJumpToTrain }) {
  return (
    <div className="vt-pinned">
      {activeBuild && (
        <div className="vt-pinned-row" onClick={onJumpToBuild}>
          <span className="vt-pinned-tag">📁 建集</span>
          <span style={{ flex: 1 }}>{activeBuild.message || '進行中…'}</span>
          <span className="muted">{Math.round((activeBuild.progress || 0) * 100)}%</span>
          <span className="vt-pinned-arrow">→</span>
        </div>
      )}
      {activeTrain && (
        <div className="vt-pinned-row" onClick={onJumpToTrain}>
          <span className="vt-pinned-tag">🎓 訓練</span>
          <span style={{ flex: 1 }}>{activeTrain.stage} · {activeTrain.message}</span>
          <span className="muted">{Math.round((activeTrain.progress || 0) * 100)}%</span>
          <span className="vt-pinned-arrow">→</span>
        </div>
      )}
    </div>
  );
}

// ─── Tab A: my trained models ────────────────────────────────────────────────
function ModelsTab({ completedModels, gpsDatasets, onRetrain, onGoBuild, onErr }) {
  if (!completedModels.length) {
    return (
      <div className="vt-empty">
        <div style={{ fontSize: 32, marginBottom: 6 }}>📚</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>尚未訓練任何聲音模型</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
          流程：建立資料集 → 訓練 → 試聽 → 匯入聲音庫使用
        </div>
        <button className="primary" onClick={onGoBuild}>➕ 從影片建立第一個資料集</button>
      </div>
    );
  }
  return (
    <div className="vt-list">
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        共 {completedModels.length} 個已訓練模型。每張卡片可直接輸入文字試聽，並一鍵匯入聲音庫供「口誤聲音替換」使用。
      </div>
      {completedModels.map((m) => {
        const ds = gpsDatasets.find((d) => d.id === m.datasetId);
        return (
          <ModelCard key={m.id} model={m} dataset={ds} onRetrain={() => onRetrain(m.datasetId)} onErr={onErr} />
        );
      })}
    </div>
  );
}

function ModelCard({ model, dataset, onRetrain, onErr }) {
  const [imported, setImported] = useState(null);
  const speaker = dataset?.speaker || model.expName;
  const sovitsName = (model.sovitsWeight || '').split('/').pop();
  const gptName = (model.gptWeight || '').split('/').pop();
  const finished = model.finishedAt ? new Date(model.finishedAt).toLocaleString('zh-TW', { hour12: false }) : '';

  async function importToLibrary() {
    onErr(null);
    try {
      // Direct import — backend pulls the dataset's largest sample as ref clip
      // and creates a voice profile linked to this model's weights.
      const r = await api.gpsTrainImport(model.id);
      setImported(r);
    } catch (e) { onErr(`匯入失敗：${e.message}`); }
  }

  return (
    <div className="vt-card">
      <div className="vt-card-head">
        <div>
          <div className="vt-card-title">🎤 {speaker}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            GPT-SoVITS {model.version} · SoVITS {model.sovitsEpochs}ep · GPT {model.gptEpochs}ep
            {dataset && <> · 資料集 {dataset.chunks || '?'} 段 / {dataset.totalMinutes || '?'} 分</>}
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
            完成於 {finished} · <code>{sovitsName}</code> / <code>{gptName}</code>
          </div>
        </div>
        <div className="vt-card-actions">
          <button onClick={importToLibrary} disabled={!!imported} title="把此模型加到聲音庫，供口誤替換使用">
            {imported ? '✓ 已匯入' : '📥 匯入聲音庫'}
          </button>
          <button onClick={onRetrain} title="用同一份資料集重新訓練（可改 epochs / 版本）">🔄 重訓</button>
        </div>
      </div>
      <PreviewPanel trainJobId={model.id} />
    </div>
  );
}

// ─── Tab B: dataset management (list / audition / delete / use for training) ─
function DatasetsTab({ gpsDatasets, onRefresh, onUseForTraining, onGoBuild, onErr }) {
  if (!gpsDatasets.length) {
    return (
      <div className="vt-empty">
        <div style={{ fontSize: 32, marginBottom: 6 }}>📁</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>還沒有任何訓練資料集</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
          資料集是訓練的素材：一份「同講者」的乾淨人聲，切段 + 自動轉錄。
        </div>
        <button className="primary" onClick={onGoBuild}>➕ 建立第一個資料集</button>
      </div>
    );
  }
  return (
    <div className="vt-list">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>共 {gpsDatasets.length} 個資料集</span>
        <button onClick={onGoBuild}>➕ 建立新資料集</button>
      </div>
      {gpsDatasets.map((d) => (
        <DatasetCard key={d.id} dataset={d} onUseForTraining={() => onUseForTraining(d.id)} onDeleted={onRefresh} onErr={onErr} />
      ))}
    </div>
  );
}

function DatasetCard({ dataset, onUseForTraining, onDeleted, onErr }) {
  const [samples, setSamples] = useState(null);   // null = not loaded, [] = loading, [...] = loaded
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function loadSamples() {
    if (samples && samples.length) { setSamples(null); return; }   // toggle close
    setLoadingSamples(true);
    try {
      const r = await api.gpsDatasetSamples(dataset.id, 5);
      setSamples(r.samples || []);
    } catch (e) { onErr(`抽樣失敗：${e.message}`); }
    setLoadingSamples(false);
  }
  async function del() {
    if (!confirm(`確定刪除資料集「${dataset.speaker || dataset.id}」？\n\n會永久移除整個資料夾（含所有 wav 切段）：\n${dataset.dir}\n\n此操作無法復原。已用此資料集訓練出的模型不受影響。`)) return;
    setDeleting(true); onErr(null);
    try { await api.gpsDatasetDelete(dataset.id); onDeleted(); }
    catch (e) { onErr(`刪除失敗：${e.message}`); setDeleting(false); }
  }

  return (
    <div className="vt-card">
      <div className="vt-card-head">
        <div>
          <div className="vt-card-title">📁 {dataset.speaker || dataset.id}</div>
          <div className="muted" style={{ fontSize: 11 }}>
            {dataset.chunks || '?'} 段 · {dataset.totalMinutes ? `${dataset.totalMinutes} 分鐘` : '?'} · {dataset.language || 'zh'}
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
            <code>{dataset.dir.split('/').pop()}</code>
          </div>
        </div>
        <div className="vt-card-actions">
          <button className="primary" onClick={onUseForTraining}>🎓 用此訓練</button>
          <button onClick={loadSamples} disabled={loadingSamples}>{loadingSamples ? '抽樣中…' : (samples?.length ? '🎧 收合試聽' : '🎧 抽樣試聽')}</button>
          <button onClick={del} disabled={deleting} title="永久刪除資料集">{deleting ? '刪除中…' : '🗑'}</button>
        </div>
      </div>
      {samples && samples.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {samples.map((s, i) => (
            <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 4, background: 'var(--panel)', borderRadius: 4 }}>
              <audio controls src={s.audioUrl} style={{ height: 26 }} />
              <div style={{ flex: 1, fontSize: 11 }}>{s.text}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Tab C: training execution ───────────────────────────────────────────────
function TrainTab({ gps, gpsOp, gpsDatasets, trainJobs, preselectDatasetId, onPreselectConsumed, onGoBuild, onErr }) {
  const [selectedId, setSelectedId] = useState(preselectDatasetId || null);
  const [version, setVersion] = useState('v2Pro');
  const [sovitsEpochs, setSovitsEpochs] = useState(8);
  const [gptEpochs, setGptEpochs] = useState(15);

  // Consume preselection once (don't override user's later picks)
  useEffect(() => {
    if (preselectDatasetId) {
      setSelectedId(preselectDatasetId);
      onPreselectConsumed();
    }
  }, [preselectDatasetId]);
  // Pick first dataset if none chosen yet
  useEffect(() => {
    if (!selectedId && gpsDatasets.length) setSelectedId(gpsDatasets[0].id);
  }, [gpsDatasets, selectedId]);

  const selected = gpsDatasets.find((d) => d.id === selectedId);
  // Show the active training job if any, else the most recent for the picked dataset.
  const activeJob = trainJobs.find((j) => j.state === 'running' || j.state === 'queued');
  const recentForDataset = trainJobs.find((j) => j.datasetId === selectedId);
  const showJob = activeJob || recentForDataset;

  async function start() {
    if (!selected) { onErr('請先選擇訓練資料集'); return; }
    try {
      await api.gpsTrainStart({
        datasetId: selected.id, version, sovitsEpochs, gptEpochs,
        expName: `${selected.speaker || selected.id}_${version}`
      });
    } catch (e) { onErr(`啟動訓練失敗：${e.message}`); }
  }
  async function cancel() {
    if (!activeJob) return;
    try { await api.gpsTrainCancel(activeJob.id); } catch (e) { onErr(e.message); }
  }

  if (!gpsDatasets.length) {
    return (
      <div className="vt-empty">
        <div style={{ fontSize: 32, marginBottom: 6 }}>🎓</div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>還沒有可訓練的資料集</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
          先建立一份「同一講者」的訓練資料集，再回來這裡訓練。
        </div>
        <button className="primary" onClick={onGoBuild}>➕ 建立資料集</button>
      </div>
    );
  }

  return (
    <div className="vt-list">
      {gps && !gps.installed && (
        <div className="banner warn">
          ⚠ GPT-SoVITS 尚未安裝。請點右上 ⚙ 安裝。{gpsOp?.install?.state === 'running' && ' 安裝進行中。'}
        </div>
      )}

      <div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>選擇要訓練的資料集：</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {gpsDatasets.map((d) => (
            <label key={d.id} className="vt-dataset-card" style={{
              background: selectedId === d.id ? 'rgba(79,140,255,.10)' : 'var(--panel2)',
              borderColor: selectedId === d.id ? 'var(--acc)' : 'var(--line)'
            }}>
              <input type="radio" name="vt-train-ds" checked={selectedId === d.id} onChange={() => setSelectedId(d.id)} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{d.speaker || d.id}</div>
                <div className="muted" style={{ fontSize: 10 }}>
                  {d.chunks || '?'} 段 · {d.totalMinutes ? `${d.totalMinutes} 分` : '?'} · {d.language || 'zh'}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <label style={{ fontSize: 11 }}>
          <div className="muted">版本</div>
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={!!activeJob}>
            <option value="v2Pro">v2Pro（推薦）</option>
            <option value="v2ProPlus">v2ProPlus</option>
            <option value="v2">v2</option>
          </select>
        </label>
        <label style={{ fontSize: 11 }}>
          <div className="muted">SoVITS epochs</div>
          <input type="number" min={1} max={32} value={sovitsEpochs}
            onChange={(e) => setSovitsEpochs(Math.max(1, Math.min(32, Number(e.target.value) || 8)))} disabled={!!activeJob} />
        </label>
        <label style={{ fontSize: 11 }}>
          <div className="muted">GPT epochs</div>
          <input type="number" min={1} max={50} value={gptEpochs}
            onChange={(e) => setGptEpochs(Math.max(1, Math.min(50, Number(e.target.value) || 15)))} disabled={!!activeJob} />
        </label>
      </div>

      {!activeJob ? (
        <button className="primary" disabled={!selected || !gps?.installed} onClick={start} style={{ width: '100%' }}>
          🚀 一鍵全自動訓練（~{Math.round(sovitsEpochs * 2.5 + gptEpochs * 1 + 3)} 分鐘）
        </button>
      ) : (
        <button onClick={cancel} style={{ width: '100%' }}>取消訓練</button>
      )}

      {showJob && <TrainProgressCard job={showJob} />}
    </div>
  );
}

function TrainProgressCard({ job }) {
  return (
    <div className="vt-card" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span><b>階段 {(job.stageIndex || 0) + 1}/{job.totalStages}</b> · {job.stage}</span>
        <span className="muted">{Math.round((job.progress || 0) * 100)}% · {job.state}</span>
      </div>
      <div className="bar"><div className="fill" style={{ width: `${Math.round((job.progress || 0) * 100)}%`, background: job.state === 'error' ? '#e95151' : undefined }} /></div>
      <div className="muted" style={{ fontSize: 10, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 4 }}>
        {job.message}
      </div>
      {job.state === 'done' && (
        <div style={{ marginTop: 8, fontSize: 11 }}>
          ✓ <b>訓練完成</b> — 已加入「📚 我的模型」分頁，可前往試聽 / 匯入聲音庫。
          <PreviewPanel trainJobId={job.id} />
        </div>
      )}
      {job.state === 'error' && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ color: '#e95151', fontSize: 11 }}>展開錯誤詳情</summary>
          <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', marginTop: 4 }}>{job.error || job.message}</pre>
        </details>
      )}
    </div>
  );
}

// ─── Tab D: build a new dataset (steps 1+2 compressed) ───────────────────────
function BuildTab({ jobs, buildJob, setBuildJob, buildSamples, setBuildSamples, onJumpToTrain, onErr }) {
  const [pendingFile, setPendingFile] = useState(null);
  const [pathInput, setPathInput] = useState('');
  const [pickedJobId, setPickedJobId] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const [speaker, setSpeaker] = useState('speaker1');
  const [language, setLanguage] = useState('zh');
  const [limitMin, setLimitMin] = useState(30);
  const [model, setModel] = useState('large-v3-turbo');
  const [uploadPct, setUploadPct] = useState(null);

  const isRunning = buildJob && !['done', 'error', 'canceled'].includes(buildJob.state);
  const isDone = buildJob && buildJob.state === 'done';

  function ready() { return !!(pendingFile || pathInput.trim() || pickedJobId); }
  function describe() {
    if (pendingFile) return `本機檔案：${pendingFile.name} (${(pendingFile.size / 1024 / 1024).toFixed(1)} MB)`;
    if (pickedJobId) { const j = jobs.find((x) => x.id === pickedJobId); return `當前任務：${j?.title || pickedJobId}`; }
    if (pathInput.trim()) return `絕對路徑：${pathInput.trim()}`;
    return '';
  }

  async function start() {
    onErr(null);
    setBuildSamples([]);
    const options = { speaker, language, model, limitMin: Number(limitMin) || undefined };
    try {
      let t;
      if (pendingFile) {
        setUploadPct(0);
        t = await api.voiceTrainUpload(pendingFile, { ...options, limitMin: options.limitMin || '' },
          (l, total) => setUploadPct(l / total));
        setUploadPct(null);
      } else if (pickedJobId) {
        throw new Error('「當前任務」模式請改用「本機檔案」或填入該任務影片的絕對路徑（一般在 data/media/ 下）');
      } else if (pathInput.trim()) {
        t = await api.voiceTrainStartLocal({ type: 'file', value: pathInput.trim() }, options);
      }
      setBuildJob(t);
    } catch (e) { onErr(e.message); setUploadPct(null); }
  }

  function reset() { setBuildJob(null); setBuildSamples([]); setPendingFile(null); setPathInput(''); setPickedJobId(''); }

  // If a build is done, show the result panel with sample + "去訓練" button
  if (isDone) {
    return (
      <div className="vt-list">
        <div className="banner" style={{ background: 'rgba(62,207,142,.12)', border: '1px solid rgba(62,207,142,.4)' }}>
          ✓ <b>資料集已建立</b> — {buildJob.chunks} 段 · {(buildJob.totalSeconds / 60).toFixed(1)} 分鐘
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>輸出資料夾：<code>{buildJob.datasetDir}</code></div>
        </div>

        {!!buildSamples.length && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>🎧 抽樣試聽（5 段）</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {buildSamples.map((s, i) => (
                <li key={i} className="job" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 6 }}>
                  <audio controls src={s.audioUrl} style={{ height: 28 }} />
                  <div style={{ flex: 1, fontSize: 12 }}>{s.text}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" style={{ flex: 1 }} onClick={() => onJumpToTrain(buildJob.datasetId || pathDatasetId(buildJob.datasetDir))}>
            🎓 接著去訓練 →
          </button>
          <button onClick={reset}>建立另一個</button>
        </div>
      </div>
    );
  }

  return (
    <div className="vt-list">
      <div className="muted" style={{ fontSize: 12 }}>
        把「同一個人」的長影音切成 5–15 秒乾淨片段 + 自動轉錄 → 產出 GPT-SoVITS 訓練集。建議 <b>20–60 分鐘同講者乾淨人聲</b>。
      </div>

      <div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>① 聲音來源（同一講者）</div>
        <div
          className={`dropzone ${dragOver ? 'over' : ''} ${pendingFile ? 'has' : ''}`}
          onClick={(e) => { if (e.target.tagName !== 'BUTTON') fileRef.current?.click(); }}
          onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) setPendingFile(f); }}
        >
          <input ref={fileRef} type="file" accept="video/*,audio/*" style={{ display: 'none' }}
            onChange={(e) => { setPendingFile(e.target.files?.[0] || null); e.target.value = ''; }} />
          {!pendingFile ? (
            <div className="dz-empty">
              <div style={{ fontSize: 22 }}>⬇</div>
              <div>把含此講者的影片/音檔拖進來，或點此選檔</div>
            </div>
          ) : (
            <div className="dz-chips">
              <div className="chip">
                <span className="chip-name">{pendingFile.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>{(pendingFile.size / 1024 / 1024).toFixed(1)} MB</span>
                <button onClick={(e) => { e.stopPropagation(); setPendingFile(null); }}>×</button>
              </div>
            </div>
          )}
        </div>
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ fontSize: 11, cursor: 'pointer' }}>進階：填入資料夾或檔案絕對路徑</summary>
          <input style={{ width: '100%', marginTop: 4 }} placeholder="/Users/you/Movies/speaker/ 或 /path/to/video.mp4"
            value={pathInput} onChange={(e) => setPathInput(e.target.value)} />
        </details>
      </div>

      <div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>② 設定</div>
        <div className="row">
          <div className="col">
            <label>講者名稱（短英數）</label>
            <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="xiongao / john / mom" />
            <label>語言</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="zh">中文 (zh)</option><option value="en">English</option>
              <option value="ja">日本語</option><option value="ko">한국어</option>
            </select>
          </div>
          <div className="col">
            <label>目標長度（分鐘）</label>
            <input type="number" min="5" max="120" value={limitMin} onChange={(e) => setLimitMin(e.target.value)} />
            <label>轉錄模型</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="large-v3-turbo">large-v3-turbo（推薦）</option>
              <option value="medium">medium</option>
              <option value="small">small（快但較不準）</option>
            </select>
          </div>
        </div>
      </div>

      {uploadPct != null && (
        <div>
          <div className="muted">上傳檔案中… {Math.round(uploadPct * 100)}%</div>
          <div className="bar"><div className="fill" style={{ width: `${Math.round(uploadPct * 100)}%` }} /></div>
        </div>
      )}

      {isRunning && (
        <div className="vt-card">
          <div className={`opbar ${buildJob.state}`}>{buildJob.message || '進行中…'}</div>
          <div className="bar"><div className="fill" style={{ width: `${Math.round((buildJob.progress || 0) * 100)}%` }} /></div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {buildJob.chunks ? `已切 ${buildJob.chunks} 段、${(buildJob.totalSeconds / 60).toFixed(1)} 分鐘 · ` : ''}
            可隨時切到其他分頁，後台繼續跑。
          </div>
        </div>
      )}

      {!isRunning && (
        <button className="primary" disabled={!ready()} onClick={start} style={{ width: '100%' }}>
          🚀 開始建立訓練集（30 分鐘素材 ≈ 3–8 分鐘）
        </button>
      )}
    </div>
  );
}

function pathDatasetId(datasetDir) {
  // datasetDir is e.g. /…/data/voice_datasets/Dream-31ef6e21 → "Dream-31ef6e21"
  if (!datasetDir) return null;
  return datasetDir.split('/').filter(Boolean).pop() || null;
}

// ─── Audition a trained model: type text, get a wav back ─────────────────────
function PreviewPanel({ trainJobId }) {
  const [text, setText] = useState('今天天氣很好，我們一起去散步。');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);

  async function run() {
    setErr(null); setBusy(true); setResult(null);
    try {
      const r = await api.gpsTrainPreview(trainJobId, { text });
      setResult(r);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="vt-preview">
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>🔊 試聽</div>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="輸入要合成的句子" style={{ width: '100%', fontSize: 11, resize: 'vertical' }} />
      <button className="primary" disabled={busy || !text.trim()} onClick={run} style={{ marginTop: 4, width: '100%' }}>
        {busy ? '生成中…（首次載入模型 10-30 秒）' : '✨ 生成試聽'}
      </button>
      {err && <div style={{ color: '#e95151', fontSize: 10, marginTop: 4 }}>{err}</div>}
      {result?.audioUrl && (
        <div style={{ marginTop: 6 }}>
          <audio key={result.audioUrl} src={result.audioUrl} controls style={{ width: '100%', height: 32 }} />
          {result.reference?.text && (
            <details style={{ marginTop: 2 }}>
              <summary className="muted" style={{ fontSize: 10, cursor: 'pointer' }}>
                參考音原文（訓練集第 {(result.reference.index ?? 0) + 1} 筆 / 共 {result.reference.total} 筆）
              </summary>
              <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>{result.reference.text}</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
