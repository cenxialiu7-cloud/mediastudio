# MediaStudio 發版 SOP（Release Standard Operating Procedure）

> 每次改版 / 新增功能後，照這份流程走就能更新安裝檔與下載頁。
> **重點：下載頁（landing page）會自動抓最新 Release，發完 Release 後網站「自動更新」，不必手動改網頁。**

---

## 0. 自動更新機制（先理解，省事）

| 對象 | 怎麼更新 | 需手動？ |
|---|---|---|
| 下載頁的版本號與下載連結 | `docs/app.js` 每次載入都呼叫 GitHub API 抓 **latest release** 的 assets，依檔名（`.dmg` arm64/x64、`.exe`）自動填到按鈕 | ❌ 全自動 |
| 下載頁本身（文案 / 截圖） | 改 `docs/` 後 push 到 `main`，GitHub Pages 自動重新發佈 | 只有改文案時 |
| GitHub Pages 站台 | 一次性開啟後永久自動 | ❌（開過一次就好） |
| 廣告代碼 | 註冊聯播網後貼進 `docs/index.html` 的 `AD_*_PLACEHOLDER` | 只有換廣告時 |

**結論：日常發新版＝(1) build 安裝檔 →(2) 發 GitHub Release。下載頁自己會更新。**

---

## 1. 版本號 bump

改兩個 `package.json` 的 `version`（保持一致）：
- `package.json`（repo 根，app 版本）
- `desktop/package.json`（Electron 桌面版本 → 決定 DMG/exe 檔名）

```bash
# 例：0.1.1 → 0.1.2
cd "<repo>"
npm version 0.1.2 --no-git-tag-version
cd desktop && npm version 0.1.2 --no-git-tag-version && cd ..
```

---

## 2. Build 安裝檔

### macOS（在 Mac 上）
```bash
cd "<repo>/desktop"
npm install            # 首次或依賴有變才需要
npm run build:mac      # prepare-app + fetch-ffmpeg(雙arch) + electron-builder
# 產物：desktop/dist-installer/MediaStudio-<ver>-arm64.dmg
#       desktop/dist-installer/MediaStudio-<ver>-x64.dmg
```

### Windows（在 Windows 機器上）
```bat
cd <repo>\desktop
build-on-windows.bat
:: 產物：desktop\dist-installer\MediaStudio-Setup-<ver>.exe
```
> Windows 版必須在 Windows 上 build（Python embeddable + NSIS 是 Windows-only）。

---

## 3. push 原始碼 + 發 Release

```bash
cd "<repo>"
git add -A && git commit -m "release: v0.1.2 — <一句話重點>"
git push

# 發 Release 並附上所有安裝檔（mac 兩個 arch；有 Windows 版就一起加）
gh release create v0.1.2 \
  "desktop/dist-installer/MediaStudio-0.1.2-arm64.dmg" \
  "desktop/dist-installer/MediaStudio-0.1.2-x64.dmg" \
  --repo cenxialiu7-cloud/mediastudio \
  --title "MediaStudio v0.1.2" \
  --notes "本版重點：…（條列新功能 / 修正）。未簽署：首次開啟請對 App 按右鍵 → 打開。"

# 若 Windows 版稍後才 build 好，補上傳：
gh release upload v0.1.2 "desktop\dist-installer\MediaStudio-Setup-0.1.2.exe" --repo cenxialiu7-cloud/mediastudio
```

發完後 **下載頁按鈕與版本號會自動指向 v0.1.2**（無需改網頁）。

---

## 4. 只有「改下載頁文案 / 截圖」時才需要

```bash
# 編輯 docs/index.html、docs/style.css 等
git add docs && git commit -m "docs: 更新下載頁文案" && git push
# GitHub Pages 約 1-2 分鐘後自動重新發佈
```

---

## 5. 一次性設定（只做一次）

### GitHub Pages（發佈下載頁）
```bash
gh api -X POST repos/cenxialiu7-cloud/mediastudio/pages \
  -f 'source[branch]=main' -f 'source[path]=/docs'
# 站台：https://cenxialiu7-cloud.github.io/mediastudio/
```

### 廣告（依 MediaGrab/MONETIZATION.md）
註冊 PropellerAds / Adsterra 後，把代碼貼進 `docs/index.html`：
- `<!-- AD_VERIFY_META_PLACEHOLDER -->` — 站台驗證 meta / 全站 script
- `<!-- AD_ZONE_LEADERBOARD_PLACEHOLDER -->` — 728×90 橫幅
- `<!-- AD_ZONE_RECTANGLE_PLACEHOLDER -->` — 300×250 方塊

---

## 6. 快速檢查清單（每次發版照打勾）

- [ ] `package.json` + `desktop/package.json` 版本號一致並 bump
- [ ] `npm run build:mac` 產出 arm64 + x64 DMG
- [ ] （如需）Windows 上 build 出 `.exe`
- [ ] `git push` 原始碼
- [ ] `gh release create v<ver>` 附上所有安裝檔
- [ ] 開下載頁確認按鈕指向新版本（約 1 分鐘後）
- [ ] 開一個乾淨環境實裝測試（右鍵→打開繞過 Gatekeeper）

---

## 7. 入口站（免費工具集）與新程式（每次都要做）

入口站 repo：`cenxialiu7-cloud/cenxialiu7-cloud.github.io`（網址 https://cenxialiu7-cloud.github.io/）。
每個程式在入口站的程式列表有一張卡片，連到各自的下載介紹頁。

### 7a. MediaStudio 改版時
- 下載頁（本 repo `docs/`）已含廣告代碼，發完 Release 會自動更新版本，**通常不必動入口站**。
- 若改了 MediaStudio 的簡介文案，更新入口站卡片描述（見下）。

### 7b. 發佈「全新程式」時（例如 MediaXxx）
務必三件事一起做：

1. **新程式的下載介紹頁**（在新程式 repo 的 `docs/`，或入口站的子資料夾）：
   - 複製本 repo `docs/` 當範本改文案
   - **一定要加廣告代碼**：`<head>` 放 Monetag + Adsterra 三段 script、頁面放 `ads/*.html` iframe 區塊
   - 廣告代碼來源：直接複製 MediaStudio `docs/index.html` 的 `<head>` 廣告 script + `docs/ads/` 整個資料夾

2. **入口站新增卡片**：編輯 `cenxialiu7-cloud.github.io/index.html` 的 `<div class="feature-grid">`，
   在「更多程式」placeholder 前加一張 `<a class="app-card" href="/新程式路徑/">`（參考 MediaStudio 卡片）。

3. **入口站 keywords**：把新程式名加進 `<meta name="keywords">`。

```bash
# 更新入口站
cd /tmp && gh repo clone cenxialiu7-cloud/cenxialiu7-cloud.github.io portal && cd portal
git config user.email "noreply@local" && git config user.name "Maintainer"
# 編輯 index.html 加卡片…
git add index.html && git commit -m "Add <新程式> to app grid" && git push
```

> ⚠️ 鐵則：**每個下載介紹頁都必須帶廣告代碼**（head 三段 script + ads/ iframe），否則沒有收益。

---

## 8. 進階：CI 自動化（選配）

未來若想「打 git tag 就自動 build + 發 Release」，可加 `.github/workflows/release.yml`，
用 `macos-latest`（build DMG）+ `windows-latest`（build exe）兩個 job，
on `push: tags: ['v*']` 觸發，最後用 `softprops/action-gh-release` 上傳 assets。
（需把 build:mac / build:win 接進 workflow；mac 雙 arch 在 Apple Silicon runner 上跑。）
