#!/bin/bash
# 雙擊此檔即可啟動 MediaStudio（會自動開啟瀏覽器）。
# 關閉此終端機視窗 (按 ✕ 或 Ctrl+C) 會自動停止整個程式服務。
#
# 原理：用 `exec` 讓 node 取代 bash 成為前景行程；
# macOS Terminal 在關窗 / Ctrl+C 時對整個 process group 發訊號，node 直接收到
# SIGHUP/SIGINT/SIGTERM 並透過 launcher.mjs 的 shutdown() 殺掉 server 子行程。
#
# 若 macOS 阻擋執行：到「系統設定 ▸ 隱私權與安全性」允許，或執行 `chmod +x` 此檔。

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 Node.js，請先安裝：https://nodejs.org/"
  read -r -p "按 Enter 關閉…" _
  exit 1
fi

echo "啟動 MediaStudio … 關閉此視窗即可停止服務。"
echo
# `exec` 讓 node 取代當前 shell；訊號直接到 node，不會被 bash 卡住。
exec node launcher.mjs
