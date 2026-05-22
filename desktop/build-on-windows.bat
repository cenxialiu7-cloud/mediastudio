@echo off
REM ============================================================
REM  MediaStudio Desktop -- Windows installer build
REM  Run this on a Windows 10/11 machine to produce
REM  dist-installer\MediaStudio-Setup-<version>.exe
REM
REM  Pre-requisites (one time):
REM    1) Node.js 20+ LTS  : https://nodejs.org
REM
REM  This tooling lives INSIDE the MediaStudio repo at desktop\, so the
REM  app source is the repo root (one level up). No separate source folder
REM  is needed.
REM
REM  NOTE: ASCII-only on purpose (no CJK) to avoid cmd codepage issues.
REM ============================================================

setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install Node 20+ LTS from https://nodejs.org
  pause & exit /b 1
)

REM Confirm the app source (repo root, one level up) is present.
if not exist "..\server\index.js" (
  if not defined MEDIASTUDIO_SRC (
    echo [X] MediaStudio source not found at ..\server\index.js
    echo     Run this .bat from inside the repo's desktop\ folder,
    echo     or set MEDIASTUDIO_SRC=path\to\MediaStudio
    pause & exit /b 1
  )
)

echo.
echo [1/2] npm install (Electron + electron-builder + ffmpeg-static)
call npm install --no-fund --no-audit
if errorlevel 1 ( echo [X] npm install failed & pause & exit /b 1 )

echo.
echo [2/2] build:win  (prepare-app + fetch-python + fetch-ffmpeg + electron-builder)
echo       This takes 5-10 minutes.
call npm run build:win
if errorlevel 1 ( echo [X] build:win failed & pause & exit /b 1 )

echo.
echo ============================================================
echo  DONE. Installer is in dist-installer\
dir /b dist-installer\*.exe
echo ============================================================
echo  Hand the .exe to the end user. They double-click it; the setup
echo  wizard opens in a window (no cmd), installs everything and
echo  launches MediaStudio. FFmpeg is bundled -- no manual install.
echo ============================================================
pause
endlocal
