@echo off
REM ============================================================
REM  MediaStudio Desktop -- Windows installer build
REM  Run this on a Windows 10/11 machine to produce
REM  dist-installer\MediaStudio-Setup-0.1.0.exe
REM
REM  Pre-requisites (one time):
REM    1) Node.js 20+ LTS  : https://nodejs.org
REM    2) Git (only to clone if needed) : https://git-scm.com
REM
REM  NOTE: ASCII-only on purpose. Output contains no CJK characters
REM        so it cannot trigger cmd codepage issues.
REM ============================================================

setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found. Install Node 20+ LTS from https://nodejs.org
  pause & exit /b 1
)

REM Confirm a sibling MediaStudio-Windows source folder exists
if not exist "..\MediaStudio-Windows\server\index.js" (
  if not defined MEDIASTUDIO_SRC (
    echo [X] MediaStudio source not found at ..\MediaStudio-Windows
    echo     Either place the MediaStudio-Windows folder next to this one,
    echo     or set MEDIASTUDIO_SRC=path\to\MediaStudio-Windows
    pause & exit /b 1
  )
)

echo.
echo [1/4] npm install (Electron + electron-builder)
call npm install --no-fund --no-audit
if errorlevel 1 ( echo [X] npm install failed & pause & exit /b 1 )

echo.
echo [2/4] Stage app/ (copy MediaStudio source, npm install, vite build)
call npm run prepare-app
if errorlevel 1 ( echo [X] prepare-app failed & pause & exit /b 1 )

echo.
echo [3/4] Download embedded Python 3.11 (resources\python-embed)
call npm run fetch-python
if errorlevel 1 ( echo [X] fetch-python failed & pause & exit /b 1 )

echo.
echo [4/4] electron-builder --win  (this takes 5-10 minutes)
call npx electron-builder --win
if errorlevel 1 ( echo [X] electron-builder failed & pause & exit /b 1 )

echo.
echo ============================================================
echo  DONE. Installer is in dist-installer\
dir /b dist-installer\*.exe
echo ============================================================
echo  Hand the .exe to the end user. They double-click it,
echo  the setup wizard opens in a window (no cmd, no encoding issues),
echo  it installs everything and launches MediaStudio.
echo ============================================================
pause
endlocal
