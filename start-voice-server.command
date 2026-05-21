#!/bin/bash
# 雙擊啟動本機語音克隆服務 (voice_server)。
#
# 預設啟動 **兩個** voice_server：
#   - xtts  on :9811  (系統 python — Coqui XTTS-v2)
#   - f5tts on :9812  (venv python 3.14 — F5-TTS，相似度更好的選擇)
#
# 想只跑一個：設環境變數 MEDIASTUDIO_VOICE_ONLY=xtts (或 =f5tts)
# 想關閉：直接關閉此視窗，兩個 server 都會一起停。

cd "$(dirname "$0")" || exit 1
ONLY="${MEDIASTUDIO_VOICE_ONLY:-}"

SYS_PY="$(command -v python3)"
VENV_PY="$HOME/.mediastudio-venv/f5tts/bin/python"

# Detect which backends each python has.
have_xtts_in_sys=$( "$SYS_PY"   -c 'import TTS' 2>/dev/null && echo yes )
have_f5_in_venv=$( [ -x "$VENV_PY" ] && "$VENV_PY" -c 'import f5_tts' 2>/dev/null && echo yes )

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill -TERM "$p" 2>/dev/null; done
  sleep 1
  for p in "${pids[@]}"; do kill -KILL "$p" 2>/dev/null; done
}
trap cleanup EXIT INT HUP TERM

start_xtts() {
  if [ -z "$have_xtts_in_sys" ]; then echo "(skip xtts: Coqui TTS not installed in system python)"; return; fi
  echo "▶ xtts on :9811  (system python)"
  COQUI_TOS_AGREED=1 MEDIASTUDIO_VOICE_BACKEND=xtts MEDIASTUDIO_VOICE_PORT=9811 \
    "$SYS_PY" python/voice_server.py >> /tmp/ms_voice_xtts.log 2>&1 &
  pids+=($!)
}
start_f5tts() {
  if [ -z "$have_f5_in_venv" ]; then
    echo "(skip f5tts: venv 未建立。手動建立："
    echo "  /opt/homebrew/bin/python3.14 -m venv ~/.mediastudio-venv/f5tts"
    echo "  ~/.mediastudio-venv/f5tts/bin/pip install f5-tts"
    echo ")"
    return
  fi
  echo "▶ f5tts on :9812  (venv python — 推薦)"
  MEDIASTUDIO_VOICE_BACKEND=f5tts MEDIASTUDIO_VOICE_PORT=9812 \
    "$VENV_PY" python/voice_server.py >> /tmp/ms_voice_f5tts.log 2>&1 &
  pids+=($!)
}

case "$ONLY" in
  xtts)   start_xtts ;;
  f5tts)  start_f5tts ;;
  *)      start_xtts; start_f5tts ;;
esac

if [ ${#pids[@]} -eq 0 ]; then
  echo "❌ 沒有可啟動的後端，請先安裝任一個："
  echo "  pip install --user coqui-tts pypinyin jieba          # XTTS"
  echo "  /opt/homebrew/bin/python3.14 -m venv ~/.mediastudio-venv/f5tts && \\"
  echo "    ~/.mediastudio-venv/f5tts/bin/pip install f5-tts   # F5-TTS"
  read -r -p "Enter 關閉…" _; exit 1
fi

echo
echo "logs:"
echo "  tail -f /tmp/ms_voice_xtts.log     (XTTS)"
echo "  tail -f /tmp/ms_voice_f5tts.log    (F5-TTS)"
echo
echo "關閉此視窗 → 兩個 server 一起停。"

# Wait for any one to exit (or signal to interrupt us).
wait -n "${pids[@]}" 2>/dev/null
