#!/usr/bin/env bash
# Install the voicefix Layer-1 post-processing venv.
#
# Creates ~/.mediastudio-venv/voicefix and installs:
#   numpy, scipy, soundfile, pyloudnorm, pyrubberband, matchering
# Tries to install the rubberband CLI (used by pyrubberband for high-quality
# time-stretch) via homebrew on macOS / apt on Linux. If the install fails the
# python script falls back to scipy resample (works, just slightly lower quality).
set -e

VENV="$HOME/.mediastudio-venv/voicefix"
mkdir -p "$(dirname "$VENV")"

# Pick a system python. Prefer 3.11 (best matchering compat); fall back.
PY=""
for cand in python3.11 python3.12 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "錯誤：找不到 python3" >&2; exit 1
fi
echo "[voicefix] base python: $PY ($("$PY" --version 2>&1))"

if [ ! -x "$VENV/bin/python" ]; then
  echo "[voicefix] creating venv at $VENV"
  "$PY" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet \
  "numpy<2.0" scipy soundfile pyloudnorm pyrubberband matchering

# rubberband CLI (optional but recommended)
if ! command -v rubberband >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    echo "[voicefix] installing rubberband via brew"
    brew install rubberband || echo "[voicefix] brew install rubberband 失敗（非致命，將 fall back 到 scipy）" >&2
  elif command -v apt-get >/dev/null 2>&1; then
    echo "[voicefix] installing rubberband-cli via apt"
    sudo apt-get install -y rubberband-cli || echo "[voicefix] apt install 失敗（非致命）" >&2
  else
    echo "[voicefix] 未自動安裝 rubberband（手動安裝可提升 time-stretch 品質）" >&2
  fi
fi

echo "[voicefix] done. venv = $VENV/bin/python"
