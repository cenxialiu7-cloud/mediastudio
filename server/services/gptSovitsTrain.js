// Headless GPT-SoVITS training orchestrator.
//
// Bypasses the upstream Gradio WebUI entirely — we spawn the underlying Python
// scripts (1A dataset prep + 1B s1/s2 trainers) ourselves, with the exact env
// vars and config files that webui.py would build.
//
// Validated 2026-05-15 on macOS arm64 (M5 MPS) against Dream-31ef6e21 dataset:
//   1Aa text+BERT       ~10s
//   1Ab HuBERT+wav32k   ~60s
//   1Ab_sv v2Pro SV emb ~30s    (only when version=v2Pro/v2ProPlus)
//   1Ac semantic        ~40s
//   1Ba SoVITS  ~2.5min/epoch  (batch=2 MPS fp32)
//   1Bb GPT     ~1min/epoch
//
// Reference recipe: webui.py functions open1a/open1b/open1c/open1Ba/open1Bb.

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { spawn } from 'child_process';
import { v4 as uuid } from 'uuid';
import { broadcast } from '../ws.js';
import { GS_ROOT, ENV_PY } from './gptSovits.js';
import { DATA_DIR } from '../config.js';

const ENV_BIN = path.dirname(ENV_PY);

// Persist job state to disk so a Node restart can detect orphaned jobs and
// reconcile them against actually-produced weight files (the user's #1 pain:
// "training was running, I restarted server, UI froze at 71%; turns out the
// child python was killed but weights up to e4 had already been saved").
const JOBS_FILE = path.join(DATA_DIR, 'gpts-train-jobs.json');
function saveJobs() {
  try {
    const arr = order.map((id) => {
      const j = jobs.get(id);
      if (!j) return null;
      // Only persist serializable fields — no activeChild handle
      return {
        id: j.id, datasetId: j.datasetId, listPath: j.listPath, wavsDir: j.wavsDir,
        expName: j.expName, version: j.version, sovitsEpochs: j.sovitsEpochs,
        gptEpochs: j.gptEpochs, batchSize: j.batchSize,
        state: j.state, stage: j.stage, stageIndex: j.stageIndex, totalStages: j.totalStages,
        progress: j.progress, message: j.message, error: j.error,
        sovitsWeight: j.sovitsWeight, gptWeight: j.gptWeight,
        createdAt: j.createdAt, finishedAt: j.finishedAt
      };
    }).filter(Boolean);
    fs.writeFileSync(JOBS_FILE, JSON.stringify(arr, null, 2));
  } catch { /* persistence is best-effort */ }
}
function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const j of arr) {
      // Any "running" job from before this restart is orphaned — reconcile.
      if (j.state === 'running') {
        const reconciled = reconcileOrphan(j);
        Object.assign(j, reconciled);
      }
      j.activeChild = null;
      j.canceled = false;
      jobs.set(j.id, j);
      order.push(j.id);
    }
  } catch (e) { /* if corrupt, start fresh */ }
}

// Given an orphaned job, check the weights dirs to see if it actually completed
// or was interrupted mid-flight. Updates state to 'done' / 'interrupted'.
function reconcileOrphan(j) {
  const v = j.version || 'v2Pro';
  const usePro = v === 'v2Pro' || v === 'v2ProPlus';
  const proSuffix = v === 'v2ProPlus' ? 'v2ProPlus' : 'v2Pro';
  const weightSubdir = usePro ? `SoVITS_weights_${proSuffix}` : 'SoVITS_weights_v2';
  const gptSubdir = usePro ? `GPT_weights_${proSuffix}` : 'GPT_weights_v2';
  const sovits = latestWeightFile(path.join(GS_ROOT, weightSubdir), j.expName);
  const gpt = latestWeightFile(path.join(GS_ROOT, gptSubdir), j.expName);
  const expectedSovitsEpoch = j.sovitsEpochs;
  const expectedGptEpoch = j.gptEpochs;
  const sovitsEpochInFile = sovits ? Number((path.basename(sovits).match(/_e(\d+)_/) || [])[1] || 0) : 0;
  const gptEpochInFile = gpt ? Number((path.basename(gpt).match(/-e(\d+)\.ckpt$/) || [])[1] || 0) : 0;
  if (sovits && gpt && sovitsEpochInFile >= expectedSovitsEpoch && gptEpochInFile >= expectedGptEpoch) {
    return { state: 'done', sovitsWeight: sovits, gptWeight: gpt,
      message: `已完成（伺服器重啟前，從磁碟回補）。SoVITS: ${path.basename(sovits)}, GPT: ${path.basename(gpt)}`,
      progress: 1, finishedAt: j.finishedAt || Date.now() };
  }
  return {
    state: 'interrupted',
    sovitsWeight: sovits, gptWeight: gpt,
    message: `中斷（Node 重啟）。已存 SoVITS e${sovitsEpochInFile}/${expectedSovitsEpoch}、GPT e${gptEpochInFile}/${expectedGptEpoch}。可用既有權重或重新訓練。`,
    finishedAt: j.finishedAt || Date.now()
  };
}

/** Build a sanitised env: strip *_PROXY, force loopback no_proxy, set TERM, etc. */
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  env.no_proxy = 'localhost,127.0.0.1,::1,0.0.0.0';
  env.NO_PROXY = 'localhost,127.0.0.1,::1,0.0.0.0';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.TERM = process.env.TERM || 'xterm-256color';
  return { ...env, ...extra };
}

const jobs = new Map();   // jobId -> job
const order = [];

function publicJob(j) {
  return {
    id: j.id, datasetId: j.datasetId, expName: j.expName, version: j.version,
    state: j.state, stage: j.stage, stageIndex: j.stageIndex, totalStages: j.totalStages,
    progress: j.progress, message: j.message, error: j.error,
    sovitsWeight: j.sovitsWeight || null, gptWeight: j.gptWeight || null,
    createdAt: j.createdAt, finishedAt: j.finishedAt,
    sovitsEpochs: j.sovitsEpochs, gptEpochs: j.gptEpochs
  };
}

function emit(j) { broadcast('gpts-train', publicJob(j)); saveJobs(); }

function setStage(j, stageIndex, stage, message) {
  j.stageIndex = stageIndex; j.stage = stage; j.progress = stageIndex / j.totalStages;
  if (message != null) j.message = message;
  emit(j);
}

function setMessage(j, message, subProgress = null) {
  j.message = message;
  if (subProgress != null) j.progress = (j.stageIndex + subProgress) / j.totalStages;
  emit(j);
}

/** Run a python step inside the GPT-SoVITS repo. Returns when exit==0; throws otherwise. */
function spawnStep(j, label, argv, extraEnv = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    if (j.canceled) return reject(new CancelError());
    const env = baseEnv(extraEnv);
    // Make env bin first on PATH so the conda env's binaries win.
    env.PATH = `${ENV_BIN}${path.delimiter}${env.PATH || ''}`;
    const child = spawn(ENV_PY, argv, { cwd: GS_ROOT, env });
    j.activeChild = child;
    let tail = '';
    const onChunk = (b) => {
      const s = b.toString('utf8');
      tail = (tail + s).slice(-3000);
      // tqdm updates the same terminal line via \r (carriage return); without
      // splitting on \r we'd see all the in-place updates concatenated into
      // one giant "line" and pick the FIRST percentage out of the regex.
      // Split on BOTH \r and \n to get the most recent progress fragment.
      const fragments = s.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      const lastLine = fragments[fragments.length - 1];
      if (lastLine) {
        // Find the LAST (most recent) tqdm percentage in the chunk, not the first.
        const matches = [...lastLine.matchAll(/(\d+)%\|/g)];
        const lastMatch = matches[matches.length - 1];
        const sub = lastMatch ? Math.min(0.999, +lastMatch[1] / 100) : null;
        setMessage(j, `[${label}] ${lastLine.slice(0, 200)}`, sub);
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      j.activeChild = null;
      if (j.canceled) return reject(new CancelError());
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}\n${tail.slice(-1500)}`));
    });
  });
}

class CancelError extends Error { constructor() { super('canceled'); this.name = 'CancelError'; } }

function pretrainedPaths(version) {
  const v = version;  // 'v2Pro' | 'v2ProPlus' | 'v2'
  const usePro = v === 'v2Pro' || v === 'v2ProPlus';
  const proSuffix = v === 'v2ProPlus' ? 'v2ProPlus' : 'v2Pro';
  return {
    bert: 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large',
    hubert: 'GPT_SoVITS/pretrained_models/chinese-hubert-base',
    sv: 'GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt',
    s1: 'GPT_SoVITS/pretrained_models/s1v3.ckpt',
    s2G: usePro
      ? `GPT_SoVITS/pretrained_models/${proSuffix}/s2G${proSuffix}.pth`
      : 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth',
    s2D: usePro
      ? `GPT_SoVITS/pretrained_models/${proSuffix}/s2D${proSuffix}.pth`
      : 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2D2333k.pth',
    s2Config: usePro
      ? (v === 'v2ProPlus' ? 'GPT_SoVITS/configs/s2v2ProPlus.json' : 'GPT_SoVITS/configs/s2v2Pro.json')
      : 'GPT_SoVITS/configs/s2.json',
    s1Yaml: 'GPT_SoVITS/configs/s1longer-v2.yaml',
    needsSv: usePro,
    weightSubdir: usePro ? `SoVITS_weights_${proSuffix}` : 'SoVITS_weights_v2',
    gptSubdir: usePro ? `GPT_weights_${proSuffix}` : 'GPT_weights_v2',
    logsSubdir: usePro ? `logs_s2_${proSuffix}` : 'logs_s2_v2',
    logsS1Subdir: usePro ? `logs_s1_${proSuffix}` : 'logs_s1_v2'
  };
}

function commonPrepEnv(j, P) {
  return {
    inp_text: j.listPath,
    inp_wav_dir: j.wavsDir,
    exp_name: j.expName,
    opt_dir: `logs/${j.expName}`,
    i_part: '0',
    all_parts: '1',
    _CUDA_VISIBLE_DEVICES: '0',
    is_half: 'False',
    version: j.version,
    TEMP: path.join(GS_ROOT, 'TEMP')
  };
}

async function runPrepStage(j, P) {
  const od = path.join(GS_ROOT, 'logs', j.expName);
  fs.mkdirSync(od, { recursive: true });
  fs.mkdirSync(path.join(GS_ROOT, 'TEMP'), { recursive: true });

  // 1Aa text + BERT
  setStage(j, 0, '1Aa-文本與BERT特徵提取', '抽取文本拼音與 BERT 特徵…');
  await spawnStep(j, '1Aa', ['-s', 'GPT_SoVITS/prepare_datasets/1-get-text.py'], {
    ...commonPrepEnv(j, P),
    bert_pretrained_dir: P.bert
  });
  // Merge 2-name2text-*.txt -> 2-name2text.txt
  const textParts = fs.readdirSync(od).filter((f) => /^2-name2text-\d+\.txt$/.test(f)).sort();
  const merged = textParts.map((f) => fs.readFileSync(path.join(od, f), 'utf8')).join('');
  fs.writeFileSync(path.join(od, '2-name2text.txt'), merged);

  // 1Ab HuBERT + wav32k
  setStage(j, 1, '1Ab-語音SSL特徵', '抽取 HuBERT 特徵與 32k 取樣 wav…');
  await spawnStep(j, '1Ab', ['-s', 'GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py'], {
    ...commonPrepEnv(j, P),
    cnhubert_base_dir: P.hubert,
    sv_path: P.sv
  });

  // 1Ab_sv speaker embedding (v2Pro/v2ProPlus only)
  if (P.needsSv) {
    setStage(j, 2, '1Ab-SV聲紋特徵', '抽取 v2Pro 聲紋 embedding…');
    await spawnStep(j, '1Ab_sv', ['-s', 'GPT_SoVITS/prepare_datasets/2-get-sv.py'], {
      ...commonPrepEnv(j, P),
      cnhubert_base_dir: P.hubert,
      sv_path: P.sv
    });
  }

  // 1Ac semantic
  setStage(j, P.needsSv ? 3 : 2, '1Ac-語義 Token', '抽取語義 token…');
  await spawnStep(j, '1Ac', ['-s', 'GPT_SoVITS/prepare_datasets/3-get-semantic.py'], {
    ...commonPrepEnv(j, P),
    pretrained_s2G: P.s2G,
    s2config_path: P.s2Config
  });
  // Merge 6-name2semantic-*.tsv with header
  const semParts = fs.readdirSync(od).filter((f) => /^6-name2semantic-\d+\.tsv$/.test(f)).sort();
  const semBody = semParts.map((f) => fs.readFileSync(path.join(od, f), 'utf8')).join('');
  fs.writeFileSync(path.join(od, '6-name2semantic.tsv'), 'item_name\tsemantic_audio\n' + semBody);
}

function buildS2Config(j, P) {
  const template = JSON.parse(fs.readFileSync(path.join(GS_ROOT, P.s2Config), 'utf8'));
  template.train = template.train || {};
  template.train.batch_size = j.batchSize;
  template.train.epochs = j.sovitsEpochs;
  template.train.text_low_lr_rate = 0.4;
  template.train.if_save_latest = true;
  template.train.if_save_every_weights = true;
  template.train.save_every_epoch = Math.max(1, Math.floor(j.sovitsEpochs / 2));
  template.train.gpu_numbers = '0';
  template.train.pretrained_s2G = P.s2G;
  template.train.pretrained_s2D = P.s2D;
  template.train.fp16_run = false;
  template.train.grad_ckpt = false;
  template.train.lora_rank = 32;
  template.model = template.model || {};
  template.model.version = j.version;
  template.data = template.data || {};
  template.data.exp_dir = `logs/${j.expName}`;
  template.s2_ckpt_dir = `logs/${j.expName}`;
  template.save_weight_dir = P.weightSubdir;
  template.name = j.expName;
  template.version = j.version;
  const out = path.join(GS_ROOT, 'TEMP', 'tmp_s2.json');
  fs.writeFileSync(out, JSON.stringify(template, null, 2));
  return out;
}

function buildS1Config(j, P) {
  const template = yaml.load(fs.readFileSync(path.join(GS_ROOT, P.s1Yaml), 'utf8'));
  template.train = template.train || {};
  template.train.batch_size = j.batchSize;
  template.train.epochs = j.gptEpochs;
  template.train.save_every_n_epoch = Math.max(1, Math.floor(j.gptEpochs / 3));
  template.train.if_save_every_weights = true;
  template.train.if_save_latest = true;
  template.train.if_dpo = false;
  template.train.precision = '32';
  template.train.half_weights_save_dir = P.gptSubdir;
  template.train.exp_name = j.expName;
  template.pretrained_s1 = P.s1;
  template.train_semantic_path = `logs/${j.expName}/6-name2semantic.tsv`;
  template.train_phoneme_path = `logs/${j.expName}/2-name2text.txt`;
  template.output_dir = `logs/${j.expName}/${P.logsS1Subdir}`;
  const out = path.join(GS_ROOT, 'TEMP', 'tmp_s1.yaml');
  fs.writeFileSync(out, yaml.dump(template));
  return out;
}

function latestWeightFile(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix + '_') || f.startsWith(prefix + '-'));
  if (!files.length) return null;
  // Sort by mtime descending — newest first.
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, files[0]);
}

async function runTrainStage(j, P) {
  const baseIdx = P.needsSv ? 4 : 3;

  // mkdir checkpoint dirs that webui makes for us
  fs.mkdirSync(path.join(GS_ROOT, 'logs', j.expName, P.logsSubdir), { recursive: true });
  fs.mkdirSync(path.join(GS_ROOT, 'logs', j.expName, P.logsS1Subdir), { recursive: true });
  fs.mkdirSync(path.join(GS_ROOT, P.weightSubdir), { recursive: true });
  fs.mkdirSync(path.join(GS_ROOT, P.gptSubdir), { recursive: true });

  // 1Ba SoVITS
  setStage(j, baseIdx, '1Ba-SoVITS訓練', `訓練 SoVITS (${j.sovitsEpochs} epochs)…`);
  buildS2Config(j, P);
  await spawnStep(j, '1Ba', ['-s', 'GPT_SoVITS/s2_train.py', '--config', 'TEMP/tmp_s2.json'], {
    _CUDA_VISIBLE_DEVICES: '0', is_half: 'False'
  });
  j.sovitsWeight = latestWeightFile(path.join(GS_ROOT, P.weightSubdir), j.expName);
  emit(j);

  // 1Bb GPT
  setStage(j, baseIdx + 1, '1Bb-GPT訓練', `訓練 GPT (${j.gptEpochs} epochs)…`);
  buildS1Config(j, P);
  await spawnStep(j, '1Bb', ['-s', 'GPT_SoVITS/s1_train.py', '--config_file', 'TEMP/tmp_s1.yaml'], {
    _CUDA_VISIBLE_DEVICES: '0', hz: '25hz', is_half: 'False'
  });
  j.gptWeight = latestWeightFile(path.join(GS_ROOT, P.gptSubdir), j.expName);
  emit(j);
}

let activeJobId = null;

// On module load, restore jobs from disk and reconcile any "running" entries
// against actual weight files on disk. This is what un-freezes the UI after
// a server restart: orphaned jobs become 'done' (if weights match expected
// epochs) or 'interrupted' (otherwise).
loadJobs();

export async function startTrainJob(opts) {
  // opts: { datasetId, listPath, wavsDir, expName, version?, sovitsEpochs?, gptEpochs?, batchSize? }
  if (!opts.listPath || !fs.existsSync(opts.listPath)) throw new Error(`找不到 list.txt: ${opts.listPath}`);
  if (!opts.wavsDir || !fs.existsSync(opts.wavsDir)) throw new Error(`找不到 wavs 目錄: ${opts.wavsDir}`);
  if (activeJobId && jobs.get(activeJobId)?.state === 'running') {
    throw new Error('已有訓練任務在跑，請先取消或等它完成');
  }

  const version = opts.version || 'v2Pro';
  const P = pretrainedPaths(version);
  const needsSv = P.needsSv;
  const id = uuid();
  const totalStages = (needsSv ? 4 : 3) + 2; // prep + 2 trainings
  const job = {
    id,
    datasetId: opts.datasetId || null,
    listPath: opts.listPath,
    wavsDir: opts.wavsDir,
    expName: opts.expName || `voice_${Date.now()}`,
    version,
    sovitsEpochs: opts.sovitsEpochs || 8,
    gptEpochs: opts.gptEpochs || 15,
    batchSize: opts.batchSize || 2,
    state: 'running',
    stage: 'init',
    stageIndex: 0,
    totalStages,
    progress: 0,
    message: '初始化…',
    error: null,
    sovitsWeight: null,
    gptWeight: null,
    createdAt: Date.now(),
    finishedAt: null,
    canceled: false,
    activeChild: null
  };
  jobs.set(id, job);
  order.push(id);
  activeJobId = id;
  emit(job);

  // Fire and forget; UI tracks via WS broadcasts.
  (async () => {
    try {
      await runPrepStage(job, P);
      if (job.canceled) throw new CancelError();
      await runTrainStage(job, P);
      job.state = 'done';
      job.message = `完成。SoVITS: ${path.basename(job.sovitsWeight || '')}, GPT: ${path.basename(job.gptWeight || '')}`;
      job.progress = 1;
      job.finishedAt = Date.now();
      emit(job);
    } catch (e) {
      job.finishedAt = Date.now();
      if (e instanceof CancelError || job.canceled) {
        job.state = 'canceled';
        job.message = '已取消';
      } else {
        job.state = 'error';
        job.error = e.message || String(e);
        job.message = `失敗: ${job.error.split('\n')[0]}`;
      }
      emit(job);
    } finally {
      if (activeJobId === id) activeJobId = null;
    }
  })();

  return publicJob(job);
}

export function cancelTrainJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.state !== 'running') return false;
  j.canceled = true;
  try { if (j.activeChild && !j.activeChild.killed) j.activeChild.kill('SIGTERM'); } catch { /* ignore */ }
  return true;
}

export function getTrainJob(id) {
  const j = jobs.get(id);
  return j ? publicJob(j) : null;
}

export function listTrainJobs() {
  return order.map((id) => publicJob(jobs.get(id))).reverse();
}

export function activeTrainJob() {
  if (!activeJobId) return null;
  return publicJob(jobs.get(activeJobId));
}

// Manually drop a job from the list (UI "remove" button for done/error/interrupted)
export function removeTrainJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  if (j.state === 'running') return false;
  jobs.delete(id);
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  saveJobs();
  return true;
}
