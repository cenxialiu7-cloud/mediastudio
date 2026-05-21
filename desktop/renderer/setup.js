// Setup wizard renderer — talks to main process via the `window.ms` bridge from preload.
const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll('.step')) s.classList.remove('active');
  $(id).classList.add('active');
};
const log = (line, kind = 'info') => {
  const el = $('log');
  const div = document.createElement('div');
  div.textContent = line;
  if (kind === 'err') div.style.color = '#ffb3b3';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
};

let state = null;
let progressPct = 0;
let totalSteps = 0;
let doneSteps = 0;

async function init() {
  state = await window.ms.getState();
  // Pre-fill the paths block
  const lines = [
    `MediaStudio v${state.version}`,
    `安裝資料夾   : ${state.paths.appRoot}`,
    `使用者資料夾 : ${state.paths.userData}`,
    `嵌入式 Python: ${state.paths.pythonExe}  ${state.have.python ? '✓' : '✗ (不應該)'}`,
    `FFmpeg       : ${state.have.ffmpeg ? '✓ 在 PATH' : '✗ 未在 PATH (套件會自動下載 imageio-ffmpeg 或啟動時提示)'}`,
    `Log 檔       : ${state.paths.log}`
  ];
  $('paths-pre').textContent = lines.join('\n');

  // If F5-TTS venv was already installed last time, skip by default
  // (We just default the checkbox — user can re-tick)
}

$('btn-show-paths').addEventListener('click', () => {
  const d = $('paths');
  d.hidden = !d.hidden;
});

$('btn-start').addEventListener('click', async () => {
  const form = $('options');
  const fd = new FormData(form);
  // Checkboxes that aren't ticked don't appear in FormData; use querySelectorAll instead.
  const get = (name) => form.querySelector(`input[name="${name}"]`).checked;
  const options = {
    installCorePackages: true,
    installXtts: get('installXtts'),
    installF5tts: get('installF5tts'),
    installCuda: get('installCuda'),
    downloadModels: get('downloadModels')
  };
  totalSteps = 1
    + (options.installXtts ? 1 : 0)
    + (options.installF5tts ? 1 : 0)
    + (options.installCuda ? 1 : 0)
    + (options.downloadModels ? 1 : 0);
  doneSteps = 0;
  show('step-progress');
  $('phase-title').textContent = '準備中…';
  $('bar-fill').style.width = '2%';

  // Wire progress events.
  let lastPhase = '';
  window.ms.onProgress(({ phase, message }) => {
    if (phase && phase !== lastPhase) {
      // bump counter on phase change (best-effort)
      if (phase === '安裝' || phase === '下載') { doneSteps += 1; updateBar(); }
      lastPhase = phase;
      $('phase-title').textContent = phase;
    }
    if (message) {
      $('phase-msg').textContent = message.length > 200 ? message.slice(0, 200) + '…' : message;
      log(`[${phase}] ${message}`, phase === '錯誤' ? 'err' : 'info');
    }
  });

  try {
    await window.ms.runSetup(options);
    $('phase-title').textContent = '完成';
    $('bar-fill').style.width = '100%';
    show('step-done');
  } catch (e) {
    $('error-pre').textContent = (e && e.message) ? e.message : String(e);
    show('step-error');
  }
});

function updateBar() {
  // crude: assume each phase is ~equal share. Bias toward 5..95 so we never look frozen.
  const t = Math.max(1, totalSteps);
  const pct = Math.min(95, 5 + (doneSteps / t) * 90);
  $('bar-fill').style.width = `${pct}%`;
}

$('btn-open-log').addEventListener('click', () => window.ms.openLog());
$('btn-open-log-err').addEventListener('click', () => window.ms.openLog());
$('btn-open-userdata').addEventListener('click', () => window.ms.openUserData());

$('btn-start-voice').addEventListener('click', async () => {
  $('btn-start-voice').disabled = true;
  $('btn-start-voice').textContent = '正在啟動…';
  try {
    await window.ms.startVoice({});
    $('btn-start-voice').textContent = '✓ 已啟動 (xtts:9811 + f5tts:9812)';
  } catch (e) {
    alert('啟動失敗：' + e.message);
    $('btn-start-voice').disabled = false;
  }
});

$('btn-launch').addEventListener('click', () => window.ms.launchMain());
$('btn-launch-anyway').addEventListener('click', () => window.ms.launchMain());

$('btn-retry').addEventListener('click', () => show('step-welcome'));

init().catch((e) => {
  $('error-pre').textContent = e.message || String(e);
  show('step-error');
});
