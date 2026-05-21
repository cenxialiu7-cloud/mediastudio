# MediaStudio Desktop — build a single-file Windows installer

This folder produces **`MediaStudio-Setup-0.1.0.exe`** — a single double-clickable
installer for Windows 11/10. End users **do NOT need** Python, Node.js, FFmpeg,
winget, the command line, or anything technical. Everything is handled by the
in-app setup wizard (an Electron window, all in 繁體中文, no cmd, no encoding mess).

You only need to **build the installer once on a Windows machine**, then ship
the resulting `.exe` to as many users as you like.

---

## What you need on the build machine

A standard **Windows 10 or 11 PC** with:
- Node.js 20 LTS or newer — https://nodejs.org (just the official installer, click through)
- ~10 GB free disk
- Internet (to download Electron + Python embeddable during build)

That is the entire prerequisite. No Python, no Visual Studio, no admin rights.

---

## Build steps

1. Copy this whole folder (`MediaStudio-Electron`) and the sibling folder
   (`MediaStudio-Windows`) onto the Windows machine. Keep them side-by-side:

   ```
   YourDesktop\
   ├── MediaStudio-Electron\      ← this folder (the build tools)
   └── MediaStudio-Windows\       ← the actual MediaStudio source
   ```

2. **Double-click `build-on-windows.bat`** inside `MediaStudio-Electron\`.

   It will:
   1. `npm install`            (electron + electron-builder)
   2. `npm run prepare-app`    (copies MediaStudio source, npm install, vite build)
   3. `npm run fetch-python`   (downloads ~10 MB Python 3.11 embeddable)
   4. `electron-builder --win` (~5–10 minutes; produces NSIS installer)

3. When it finishes, your installer is at:

   ```
   MediaStudio-Electron\dist-installer\MediaStudio-Setup-0.1.0.exe
   ```

   That single `.exe` is everything an end user needs. **Email / share / upload that.**

---

## What the end user sees

1. Double-clicks `MediaStudio-Setup-0.1.0.exe`
2. NSIS installer (繁中) → pick install folder → next → install
3. Launches automatically. A wizard window opens:
   - **Welcome** — list of components, checkboxes for optional voice clone / GPU / model preload
   - **Progress** — live log + progress bar, all in 繁中
   - **Done** — button to launch MediaStudio main UI in a window
4. Subsequent runs: launches directly into the main app at `http://127.0.0.1:9810`
   (the window is Electron, not a browser; closing it shuts everything down cleanly)

If the wizard fails partway, the user can:
- Click **Open log file** (a `.log` opens in Notepad with full diagnostics)
- Click **Retry** to start over
- Click **Open data folder** to delete + start fresh

---

## What is bundled vs downloaded

| Bundled in the .exe (offline ready) | Downloaded on first run |
|---|---|
| Electron runtime (Node + Chromium) | Python pip packages (faster-whisper, RapidOCR, …) |
| MediaStudio source (server + client) | Optional: Coqui TTS + F5-TTS (each its own venv) |
| Python 3.11 embeddable (~10 MB) | Optional: Whisper / TTS model weights (~10 GB) |
| ffmpeg | (nothing — bundled by some pip packages, otherwise via PATH detection) |

Total installer size: ~150–200 MB. First-run setup downloads ~500 MB to ~13 GB
depending on the user's checkboxes.

---

## Customizing

- Version: edit `package.json` → `version`
- App icon: drop a `.ico` at `resources/icon.ico` (electron-builder picks it up)
- License text shown in NSIS: `resources/LICENSE.txt`
- Setup wizard texts: `renderer/setup.html` + `renderer/setup.js`
- What pip packages get installed on first run: `electron/main.js` → `setup:run` handler

---

## Troubleshooting build

- **`npm install` slow / fails on corporate network**: set
  `npm config set registry https://registry.npmmirror.com` then retry.
- **electron-builder hangs at code signing**: that's optional. Leave the
  `signtoolOptions` field unset (default) — the .exe will work but show a
  SmartScreen "publisher unknown" warning on first run. To remove that you
  need a code-signing cert ($200/year from DigiCert or similar).
- **`fetch-python.js` fails**: check the URL in the script
  (`https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip`)
  is reachable; pin a different version via `MEDIASTUDIO_PY_VERSION=3.11.10` etc.

---

## Source layout

```
MediaStudio-Electron/
├── package.json              electron + electron-builder config
├── build-on-windows.bat      ← run this on Windows
├── electron/main.js          main process; spawns Node server + manages wizard
├── renderer/                 setup wizard UI (HTML/CSS/JS, all 繁中)
├── scripts/
│   ├── prepare-app.js        copy MediaStudio source + build client
│   ├── fetch-python.js       download Python embeddable
│   └── installer.nsh         NSIS hooks
├── resources/
│   ├── python-embed/         (populated by fetch-python.js)
│   ├── icon.ico              (optional; drop your own)
│   └── LICENSE.txt
└── app/                      (populated by prepare-app.js — MediaStudio source)
```
