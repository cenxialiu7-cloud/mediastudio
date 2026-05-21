#!/usr/bin/env python3
"""
Install GPT-SoVITS the *officially supported* way: Miniforge (open-source conda)
+ a Python 3.10 conda env + the upstream `install.sh` from the repo.

Why not raw venv + pip:
  - GPT-SoVITS transitive deps (funasr → python_mecab_ko, pyopenjtalk, pydantic-core)
    require system-level build tooling (mecab-config, cmake) that pip alone can't
    install on macOS. Python 3.14+ also lacks pre-built wheels for several deps.
  - The upstream install.sh uses conda-forge to pull mecab/cmake/ffmpeg cross-
    platform, then pip-installs Python pkgs into the conda env. This is the
    path their team ships and supports.

This script prints NDJSON progress events on stdout so the Node side can show a
GUI progress bar + live log:
  {"event":"step","name":"miniforge","progress":0.05,"msg":"…"}
  {"event":"log","line":"…"}
  {"event":"done"}
  {"event":"error","message":"…"}

Re-running is safe — every step is idempotent.

Layout produced:
  ~/.mediastudio-miniforge/          conda installation (one-time, ~400 MB)
  ~/.mediastudio-miniforge/envs/gpt-sovits/   conda env with Python 3.10
  <root>/                            git clone of GPT-SoVITS
"""
import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


def emit(**kw):
    sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def step(name, progress=None, msg=None):
    emit(event='step', name=name, progress=progress, msg=msg)


def err(message):
    emit(event='error', message=str(message))
    sys.exit(1)


def run(cmd, cwd=None, env=None, label=None, check=True):
    if label:
        step('run', msg=f'{label}: {" ".join(map(str, cmd))[:160]}')
    # install.sh uses `tput cuu1` to redraw progress lines; without $TERM set
    # tput fails with exit 2 and install.sh aborts. Provide a generic value so
    # tput resolves to a no-op cursor-up sequence.
    base_env = {'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1', 'TERM': os.environ.get('TERM') or 'xterm-256color'}
    proc = subprocess.Popen(
        cmd, cwd=cwd,
        env={**os.environ, **base_env, **(env or {})},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding='utf-8', errors='replace'
    )
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            emit(event='log', line=line)
    proc.wait()
    if check and proc.returncode != 0:
        raise RuntimeError(f'{cmd[0]} exited {proc.returncode}')
    return proc.returncode


def detect_machine():
    s = platform.system().lower()
    m = platform.machine().lower()
    if s == 'darwin' and m in ('arm64', 'aarch64'):
        return 'macos-arm64'
    if s == 'darwin':
        return 'macos-x86'
    if s == 'linux':
        return 'linux-arm64' if m in ('arm64', 'aarch64') else 'linux-x86'
    if s == 'windows':
        return 'windows-x86'
    return 'unknown'


def miniforge_url(mach):
    base = "https://github.com/conda-forge/miniforge/releases/latest/download"
    table = {
        'macos-arm64': f"{base}/Miniforge3-MacOSX-arm64.sh",
        'macos-x86':   f"{base}/Miniforge3-MacOSX-x86_64.sh",
        'linux-x86':   f"{base}/Miniforge3-Linux-x86_64.sh",
        'linux-arm64': f"{base}/Miniforge3-Linux-aarch64.sh",
        'windows-x86': f"{base}/Miniforge3-Windows-x86_64.exe",
    }
    return table.get(mach)


def download_with_progress(url, dst):
    step('download', msg=f'下載 {url}')
    dst = Path(dst); dst.parent.mkdir(parents=True, exist_ok=True)
    last_pct = -1
    def hook(blocknum, blocksize, total):
        nonlocal last_pct
        if total > 0:
            pct = int(min(100, blocknum * blocksize * 100 / total))
            if pct != last_pct and pct % 5 == 0:
                last_pct = pct
                emit(event='log', line=f'  {pct}% ({(blocknum*blocksize)/1e6:.1f} MB / {total/1e6:.1f} MB)')
    urllib.request.urlretrieve(url, dst, reporthook=hook)
    return str(dst)


def install_miniforge(prefix, mach):
    """Install Miniforge (open-source conda) headlessly to `prefix`."""
    if (Path(prefix) / 'bin' / 'conda').exists() or (Path(prefix) / 'Scripts' / 'conda.exe').exists():
        emit(event='log', line=f'Miniforge already at {prefix}; skip download')
        return
    url = miniforge_url(mach)
    if not url:
        err(f'這個系統的 Miniforge 安裝包還不支援自動安裝：{mach}')
    if mach == 'windows-x86':
        installer = download_with_progress(url, Path(prefix).parent / 'Miniforge3.exe')
        step('miniforge', msg='安裝 Miniforge（無聲模式）…')
        run([installer, '/S', '/InstallationType=JustMe', '/RegisterPython=0', '/NoRegistry=1', f'/D={prefix}'],
            label='miniforge installer')
    else:
        installer = download_with_progress(url, Path(prefix).parent / 'Miniforge3.sh')
        step('miniforge', msg='安裝 Miniforge（-b -p $PREFIX）…')
        run(['bash', installer, '-b', '-p', str(prefix)], label='bash Miniforge3.sh')
        # bash installer leaves the .sh; we can delete to save disk
        try: os.remove(installer)
        except Exception: pass


def conda_bin(miniforge):
    p = Path(miniforge)
    return str(p / 'Scripts' / 'conda.exe' if platform.system() == 'Windows' else p / 'bin' / 'conda')


def env_python(miniforge, env_name):
    p = Path(miniforge) / 'envs' / env_name
    return str(p / 'Scripts' / 'python.exe' if platform.system() == 'Windows' else p / 'bin' / 'python')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True, help='where to clone GPT-SoVITS')
    ap.add_argument('--miniforge', required=True, help='where to install Miniforge')
    ap.add_argument('--env-name', default='gpt-sovits', help='conda env name')
    ap.add_argument('--device', default=None, help='MPS / CU121 / CU128 / CPU (auto-pick if unset)')
    ap.add_argument('--source', default='HF', choices=['HF', 'HF-Mirror', 'ModelScope'],
                    help='where to pull base models from')
    ap.add_argument('--skip-pretrained', action='store_true', help='do not pre-download base models')
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    miniforge = Path(args.miniforge).expanduser().resolve()
    env_name = args.env_name
    mach = detect_machine()

    # 0) auto-pick device flag for install.sh
    device = args.device
    if not device:
        if mach.startswith('macos'):
            device = 'MPS'   # Apple Silicon / Intel both fall back gracefully
        elif platform.system() == 'Windows':
            device = 'CU121'  # most users have CUDA 12.x; install.sh handles non-NVIDIA
        else:
            device = 'CPU'
    emit(event='log', line=f'platform={mach} device={device} source={args.source}')

    # 1) Miniforge
    step('miniforge', 0.05, '檢查 / 安裝 Miniforge（無聲）…')
    install_miniforge(miniforge, mach)
    cb = conda_bin(miniforge)
    if not Path(cb).exists():
        err(f'安裝完成後找不到 conda：{cb}')

    # 2) conda env — explicitly include every CLI install.sh uses bare-style
    #    (pip, wget, git, unzip, ffmpeg, cmake). The upstream install.sh calls
    #    `pip ...` not `python -m pip ...` (script line 44), so the env MUST
    #    have a `bin/pip` script. `python=3.10` alone is not enough on some
    #    conda-forge configurations — we hit this on macOS arm64 (Miniforge
    #    25.x) where pip isn't pulled as a hard dep.
    env_pkgs = ['python=3.10', 'pip', 'wget', 'git', 'unzip', 'ffmpeg', 'cmake']
    step('env', 0.15, f'建立 conda env「{env_name}」(Python 3.10 + pip/wget/git/ffmpeg/cmake)…')
    envs = subprocess.run([cb, 'env', 'list'], capture_output=True, text=True)
    if env_name not in envs.stdout:
        run([cb, 'create', '-y', '-n', env_name, '-c', 'conda-forge', *env_pkgs],
            label='conda create')
    else:
        emit(event='log', line=f'conda env "{env_name}" already exists; ensuring tools are present')

    env_py = env_python(miniforge, env_name)
    if not Path(env_py).exists():
        err(f'conda env 建立後找不到 Python：{env_py}')

    # 2b) Idempotently ensure every required CLI exists in the env. If the env
    #     was created by a previous run without pip/wget, this is the place
    #     where the install becomes self-healing.
    step('env-tools', 0.22, '確認 conda env 內有 pip / wget / git / unzip / ffmpeg / cmake…')
    run([cb, 'install', '-y', '-n', env_name, '-c', 'conda-forge', *env_pkgs[1:]],
        label='conda install env tools')

    # 2c) Sanity-check pip exists as a script (install.sh requires `bin/pip`).
    env_bin = Path(env_py).parent
    pip_script = env_bin / ('pip.exe' if platform.system() == 'Windows' else 'pip')
    if not pip_script.exists():
        # Bootstrap pip into the env via `python -m ensurepip` then upgrade.
        emit(event='log', line=f'pip script missing at {pip_script}; bootstrapping via ensurepip…')
        run([env_py, '-m', 'ensurepip', '--upgrade'], label='ensurepip', check=False)
        run([env_py, '-m', 'pip', 'install', '--upgrade', 'pip'], label='pip self-upgrade', check=False)
        if not pip_script.exists():
            err(f'仍然找不到 pip 執行檔（{pip_script}）— install.sh 會失敗。請手動執行：\n'
                f'  {cb} install -y -n {env_name} -c conda-forge pip')
    else:
        emit(event='log', line=f'pip OK: {pip_script}')

    # 3) clone repo
    step('clone', 0.25, '抓取 GPT-SoVITS 程式碼…')
    if (root / '.git').exists():
        run(['git', '-C', str(root), 'pull', '--ff-only'], label='git pull', check=False)
    else:
        if root.exists(): shutil.rmtree(root)
        run(['git', 'clone', '--depth', '1', 'https://github.com/RVC-Boss/GPT-SoVITS.git', str(root)],
            label='git clone')

    # 4) Make sure the env has activatable conda hooks, then run their install.sh
    #    We invoke via `conda run -n <env>` so the env is activated transparently.
    if mach == 'windows-x86':
        # install.sh is a bash script — Windows users need git-bash or WSL.
        # Fallback: do a manual subset ourselves.
        step('install', 0.35, 'Windows 上跳過 install.sh；直接 pip install requirements…')
        run([cb, 'install', '-y', '-n', env_name, '-c', 'conda-forge', 'ffmpeg', 'cmake'], label='conda install ffmpeg/cmake')
        run([env_py, '-m', 'pip', 'install', '--upgrade', 'pip', 'wheel'], label='pip bootstrap')
        run([env_py, '-m', 'pip', 'install', '-r', str(root / 'requirements.txt')], label='pip install -r requirements.txt')
        extra = root / 'extra-req.txt'
        if extra.exists():
            run([env_py, '-m', 'pip', 'install', '-r', str(extra)], label='pip install -r extra-req.txt')
    else:
        step('install', 0.35, '執行 GPT-SoVITS 官方 install.sh（會自動下載基底模型，~3 GB）…')
        # install.sh uses conda activate internally; conda run handles activation.
        run([cb, 'run', '--no-capture-output', '-n', env_name,
             'bash', 'install.sh', '--device', device, '--source', args.source],
            cwd=str(root), label='install.sh')

    # 5) Pin starlette/fastapi to Gradio-4.44-compatible versions.
    #    GPT-SoVITS's requirements.txt floats these and pip resolves to the
    #    latest, but starlette 1.0.0 removed the old `TemplateResponse(name, dict)`
    #    signature that gradio 4.44 still uses → every page load 500s with
    #    `TypeError: unhashable type: 'dict'` (jinja2 cache lookup on a dict).
    #    Fix per fastapi/fastapi#15198 and gradio-app/gradio#10009.
    step('pin-deps', 0.95, '鎖定 starlette / fastapi 版本以相容 gradio 4.44…')
    run([env_py, '-m', 'pip', 'install', '--upgrade', 'starlette==0.41.3', 'fastapi==0.115.6'],
        label='pip pin starlette+fastapi', check=False)

    # 6) Install torch.load compatibility shim for PyTorch >= 2.6.
    #    PyTorch 2.6 flipped torch.load's `weights_only` default to True; the
    #    GPT-SoVITS pretrained checkpoints (and Lightning resume_from_checkpoint
    #    paths) contain pathlib.PosixPath which isn't in the safe-globals
    #    allow-list, so the 1Bb-GPT training stage fails with UnpicklingError.
    #    A site-wide .pth hook patches torch.load to default to weights_only=False
    #    and add pathlib classes to the allow-list. Trusted because every
    #    checkpoint loaded by this env is either bundled or locally produced.
    step('torch-compat', 0.97, '安裝 torch.load 相容性 patch（PyTorch 2.6+ + pathlib checkpoints）…')
    try:
        sp_out = subprocess.run([env_py, '-c', 'import site; import sys; sys.stdout.write(site.getsitepackages()[0])'],
                                 capture_output=True, text=True, check=True)
        site_packages = sp_out.stdout.strip()
        shim_py = Path(site_packages) / 'mediastudio_torch_compat.py'
        shim_pth = Path(site_packages) / 'mediastudio_torch_compat.pth'
        shim_py.write_text(
            '"""PyTorch 2.6+ compat: default weights_only=False, allow pathlib globals."""\n'
            'import pathlib\n'
            'try:\n'
            '    import torch\n'
            '    from torch import serialization as _ts\n'
            '    try:\n'
            '        _ts.add_safe_globals([pathlib.PosixPath, pathlib.WindowsPath, pathlib.Path,\n'
            '                              pathlib.PurePosixPath, pathlib.PureWindowsPath, pathlib.PurePath])\n'
            '    except Exception:\n'
            '        pass\n'
            '    _orig = torch.load\n'
            '    def _patched(f, *a, **kw):\n'
            '        kw.setdefault("weights_only", False)\n'
            '        return _orig(f, *a, **kw)\n'
            '    _patched.__mediastudio_patched__ = True\n'
            '    torch.load = _patched\n'
            'except Exception:\n'
            '    pass\n'
        )
        shim_pth.write_text('import mediastudio_torch_compat\n')
    except Exception as e:
        # Non-fatal: training may still work if torch < 2.6 is installed.
        emit(event='warn', message=f'torch compat shim 安裝失敗（非致命）: {e}')

    step('finalize', 0.98, '驗證安裝結果…')
    # quick sanity: import the critical modules
    probe = ("import importlib, json, sys\n"
             "mods = ['torch', 'gradio', 'librosa', 'psutil', 'yaml', 'transformers']\n"
             "missing = [m for m in mods if not _try(m)]\n"
             "def _try(m):\n"
             "  try: importlib.import_module(m); return True\n"
             "  except Exception: return False\n")
    # simpler probe (the snippet above has fwd-reference; rewrite)
    probe = ("import importlib, json, sys\n"
             "ok = []; bad = []\n"
             "for m in ['torch','gradio','librosa','psutil','yaml','transformers']:\n"
             "  try: importlib.import_module(m); ok.append(m)\n"
             "  except Exception: bad.append(m)\n"
             "sys.stdout.write(json.dumps({'ok': ok, 'missing': bad}))")
    out = subprocess.run([env_py, '-c', probe], capture_output=True, text=True)
    try:
        check = json.loads(out.stdout)
    except Exception:
        check = {'ok': [], 'missing': ['(probe failed)']}
    if check.get('missing'):
        err(f'安裝完成但 venv 缺：{check["missing"]}；請查看 install.sh 的日誌')

    emit(event='done', root=str(root), miniforge=str(miniforge), env_python=env_py, env_name=env_name)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        err(e)
