@echo off
REM 雙擊此檔即可啟動 MediaStudio（會自動開啟瀏覽器）。
REM 關閉此命令提示字元視窗 (按 ✕ 或 Ctrl+C) 會自動停止整個程式服務。
REM
REM 行為說明：
REM   - launcher.mjs 註冊了 SIGINT/SIGTERM/SIGHUP 訊號處理；
REM   - Windows 在 cmd 視窗被關閉時會結束整個 console process tree，
REM     node launcher 與其 server 子行程都會一併終止；
REM   - 同時 launcher 偵測到 stdout 中斷也會主動關閉伺服器。

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，請先安裝：https://nodejs.org/
  pause
  exit /b 1
)

REM Title for clarity in taskbar / process list.
title MediaStudio - 關閉此視窗即停止服務

echo 啟動 MediaStudio ... 關閉此視窗即可停止服務。
echo.

node launcher.mjs
set EC=%errorlevel%

REM Normal exit OR exit caused by window close → no pause.
if "%EC%"=="0" exit /b 0
if "%EC%"=="3221225786" exit /b 0
REM ^ 0xC000013A = STATUS_CONTROL_C_EXIT (Ctrl+C)

echo.
echo 啟動失敗 (exit code: %EC%)。請看上方訊息。
pause
exit /b %EC%
