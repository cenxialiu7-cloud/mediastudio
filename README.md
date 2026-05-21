# MediaStudio — AI 影音工作站

跨平台（macOS / Windows）影音處理程式，UI 用瀏覽器開啟。功能：

- **批次語音轉文字 / 字幕**：一次丟多個影音檔或網址，批次輸出字幕與逐字稿。
  - 有時間軸：`.srt` / `.vtt` / `.ass`(含樣式) / 「逐字稿(含時間標記).txt」 / `.json`(含字級時間戳)
  - 無時間軸：「逐字稿(純文字).txt」
  - 可選：自動偵測語言、翻譯成英文、說話者辨識（pyannote，需 `HF_TOKEN`）
- **來源 = 網址或本機檔案**：網址用 `yt-dlp` 下載；或直接給本機絕對路徑。
- **逐字稿編輯器（含影片預覽）**：改字、調時間軸、切分/合併段落、說話者標註；存檔後自動重新匯出字幕。點時間碼可跳到影片該處。
- **文字驅動剪輯**：在逐字稿每段勾選「刪」→ 按「確認並剪輯」→ 系統把未刪段落重新拼接成新影片（影格精準，會重新編碼接點）。
- **燒錄字幕**：把目前的字幕燒進影片輸出 mp4。
- **無損裁切**：指定時間範圍 stream-copy 出片段（不重編碼）。
- **AI 去靜音粗剪**：呼叫 `auto-editor` 自動移除靜音/停頓（選用依賴）。
- **口誤聲音替換（assembly 端已實作）**：用語音編輯/克隆模型產生「修正後那句話」的配音 → 系統把它接回原音軌的該時間範圍並重新封裝影片，畫面不動、聲音對得上。模型選型見下方研究章節。

## 架構

```
client/   Vite + React 前端（瀏覽器 UI；dev 用 vite proxy 打後端）
server/   Node + Express + WebSocket；job 佇列；呼叫 yt-dlp / ffmpeg / python / auto-editor
  routes/jobs.js   建立/列表/取消/刪除/取得+儲存逐字稿/下載字幕
  routes/edit.js   影片串流預覽 / 燒字幕 / 無損裁切 / 文字驅動剪輯 / 去靜音 / 口誤聲音替換 / 下載產出
  services/        ytdlp.js ffmpeg.js transcribe.js subtitles.js proc.js
python/   transcribe.py — faster-whisper ASR worker（含選用 pyannote 說話者辨識）
launcher.mjs + start-macos.command + start-windows.bat   一鍵啟動（自動建置 UI、開瀏覽器）
data/     執行時產生：media/(下載) audio/(暫存wav) output/(字幕/逐字稿/剪輯產出)
```

## 需求

- Node.js 18+
- `ffmpeg`（含 `ffprobe`）在 PATH
- `yt-dlp` 在 PATH（僅網址來源需要）
- Python 3.9+ 與 `faster-whisper`（僅轉錄需要）— 首次執行會自動下載模型權重
- 選用：`auto-editor`（AI 去靜音）；`HF_TOKEN`（說話者辨識）
- 註：「燒錄字幕」需要 ffmpeg 編譯時帶 `libass`（多數官方/Homebrew 版本都有；若 `ffmpeg -filters | grep subtitles` 空白，請重裝 ffmpeg）。無 libass 時其餘功能不受影響，字幕仍可作為外掛檔輸出。

## 啟動

**一鍵（最簡單）**
- macOS：雙擊 `start-macos.command`
- Windows：雙擊 `start-windows.bat`
- 兩者都會：缺依賴就裝、缺前端就 build、啟動伺服器、自動開瀏覽器到 `http://localhost:9810`

**命令列**
```bash
cd MediaStudio
npm run setup        # 裝 server + client + python 依賴（一次做完）
npm run dev          # 開發模式：後端 :9810，前端 dev :9810→:5173(熱重載)
# 或：
npm run build && npm start          # 單一服務 http://localhost:9810
npm run launch                      # 等同雙擊啟動器
```

> 想做成「真正的單檔 .exe / .app」：可用 [`pkg`](https://github.com/vercel/pkg) 把 `launcher.mjs`+`server/` 打包成單一執行檔，或用 [Tauri](https://tauri.app) / Electron 把 `client/dist` 包成桌面 app。目前的 `.command` / `.bat` 已可雙擊啟動，是最輕量的做法。

可選環境變數：`PORT`、`PYTHON_BIN`、`MEDIASTUDIO_DATA`、`MEDIASTUDIO_CONCURRENCY`、`HF_TOKEN`。

## API 摘要

- `GET  /api/status` — 依賴檢查 + 預設值 + 可用字幕格式
- `POST /api/jobs` — `{ items:[{type:'url'|'file', value}], options }`
- `GET  /api/jobs` / `GET /api/jobs/:id`
- `GET  /api/jobs/:id/segments` / `PUT /api/jobs/:id/segments` — 取得/儲存逐字稿（存檔後重新匯出字幕）
- `GET  /api/jobs/:id/download/:format` — 下載字幕/逐字稿（srt|vtt|ass|txt-ts|txt|json）
- `GET  /api/jobs/:id/media` — 串流來源影片（支援 Range，給編輯器預覽）
- `POST /api/jobs/:id/cut` — `{ keepIndexes:[...], segments?:[...] }` 文字驅動剪輯
- `POST /api/jobs/:id/clip` — `{ start, end }` 無損裁切
- `POST /api/jobs/:id/burn` — 燒錄目前字幕
- `POST /api/jobs/:id/autocut` — `{ margin?:'0.2sec' }` auto-editor 去靜音
- `POST /api/jobs/:id/voicefix` — `{ segmentIndex, replacementAudioPath, segments?:[...] }` 口誤聲音替換（assembly）
- `GET  /api/jobs/:id/artifact/:name` — 下載剪輯/燒字幕等產出影片
- `POST /api/jobs/:id/cancel` / `DELETE /api/jobs/:id`
- WebSocket `/ws` — `job`（佇列進度）、`op`（剪輯/燒字幕等操作進度）、`job-removed`

---

## 研究：文字驅動剪輯「進化版」— 在逐字稿改字後讓影片聲音也跟著改（口誤修正）

### 問題
影片中人物口誤，若只改字幕，聲音對不上 → 觀看者困擾。需要的是「編輯逐字稿文字 → 連聲音一起改」。商業界的代表是 Descript 的 **Overdub / Underlord** 與 **Vrew** 的 speech editor。開源要自己組。

### 兩條可行路線

**路線 A（首選）：in-context speech editing — 直接「就地改幾個字」**
- **VoiceCraft**（`jasonppy/VoiceCraft`）— Zero-Shot Speech Editing：給原始音檔 + 「目標逐字稿」，它只重生你改動的字詞，並沿用原說話者的音色與語調，接點自然。最貼近此需求的開源方案。Colab / Docker / Gradio 都有；社群另有 `lukaszliniewicz/VoiceCraft_API`（Windows 友善的 FastAPI）、`pselvana/VoiceCrafter`（Docker）。
- **VoiceCraft-X**（`zszheng147/VoiceCraft-X`）— VoiceCraft 的多語言版（含中文），統一 speech editing + zero-shot TTS。**你的影片是中文，建議用這個或下方中文 TTS。**
- 也可參考語音編輯論文/實作：A3T、FluentSpeech 等。

**路線 B（穩、易組）：voice clone + TTS 重生整句 + 對齊回貼**
1. 用 WhisperX / MFA（Montreal Forced Aligner）對原音檔做**強制對齊**，拿到要替換那句話的精確起訖時間（含字界）。
2. 用**零樣本語音克隆 TTS** 依「修正後的句子」生成新配音（拿同一說話者的幾秒乾淨語音當參考）：
   - 多語言/中文較佳：**CosyVoice2**、**IndexTTS**、**F5-TTS**、Coqui **XTTS-v2**（17 語）、**OpenVoice**（音色/情緒轉移）、Fish-Speech。
3. 把新配音**接回原音軌**的該時間範圍（前段原音 + 新配音 + 後段原音），必要時做 time-stretch（如 `rubberband` / ffmpeg `atempo`）讓長度貼齊、接點加 5–15ms crossfade。
4. 用原影片 + 新音軌 **重新封裝**（`-c:v copy`），畫面不動。

> MediaStudio 已實作路線 B 的「**第 3、4 步**」：`POST /api/jobs/:id/voicefix`（編輯器裡每段的「聲音替換…」按鈕）。你只要用 VoiceCraft-X / XTTS / F5-TTS 產出該句的 wav，填入路徑即可。把模型那一步包成本機服務（或 MCP 工具）後就能一鍵完成。

### 注意事項
- **語言**：英文用 VoiceCraft；中文優先 VoiceCraft-X / CosyVoice2 / IndexTTS / XTTS-v2。
- **算力**：speech editing / 高品質 TTS 多半要 GPU；CPU 可跑但慢。
- **長度對齊**：修正句的字數常與原句不同 → 需 time-stretch 或讓 TTS 控速；接點 crossfade 避免爆音。
- **倫理/法律**：聲音克隆務必取得當事人同意；建議在輸出檔加註「AI 修正」並保留原始檔。

### 相關開源（GitHub）
- VoiceCraft：https://github.com/jasonppy/VoiceCraft ｜ VoiceCraft-X：https://github.com/zszheng147/VoiceCraft-X ｜ VoiceCraft_API：https://github.com/lukaszliniewicz/VoiceCraft_API
- F5-TTS / XTTS(Coqui-TTS) / OpenVoice / CosyVoice / IndexTTS / Fish-Speech — 零樣本語音克隆 TTS
- WhisperX（強制對齊）：https://github.com/m-bain/whisperX ｜ Montreal Forced Aligner
- 文字驅動剪輯參考實作：autoEdit（pietrop/autoEdit_2）、Descript / Vrew（商業，可作 UX 參考）

## 進階功能（已實作）

### 影片內燒錄字幕 OCR（PaddleOCR / RapidOCR）
- 編輯器工具列「📺 影片內字幕 OCR」按鈕；後端 `POST /api/jobs/:id/ocr`。
- 自動取影格下方 30% 區域（可調），用 OCR 逐幀辨識並對連續相同/相似文字合併成 [start,end] 段；輸出 `ocr.json` + `ocr.srt`，可選 `applyAsTranscript:true` 取代目前逐字稿。
- 引擎自動偵測：優先 **PaddleOCR**（`pip install paddlepaddle paddleocr`），否則 **RapidOCR**（`pip install rapidocr-onnxruntime opencv-python`，較輕量）。

### AI 摘要 / 章節 / 短影片切點 / 標題（透過本機 MCP）
- 不需要 Anthropic API key。MediaStudio 內附一個 stdio MCP server（`mcp/server.js`），由你的 Claude 客戶端（**Claude Code** 或 **Cowork**）當作工具呼叫。
- 安裝（Claude Code）：`claude mcp add mediastudio -- node "$(pwd)/mcp/server.js"`
- 安裝（Cowork）：見 [`mcp/README.md`](./mcp/README.md)
- 工具：`mediastudio_get_status / list_jobs / get_transcript / list_artifacts / save_plan / cut_clip / transcribe_file`
- 用法：在編輯器點「🤖 摘要 / 章節 / 短影片（用 Claude Code / Cowork）」→ 對話框會生成現成的 prompt（含 jobId）→ 貼到 Claude 客戶端 → Claude 用 `get_transcript` 讀逐字稿、用 `save_plan` 寫回；MediaStudio 編輯器即時顯示章節（可點時間碼跳播）與短影片切點（旁邊有「✂ 裁出」按鈕）。叫 Claude「裁出第 N 個短影片」會觸發 `cut_clip`。
- 細節見 [`mcp/README.md`](./mcp/README.md)。

### VoiceCraft-X / XTTS-v2 本機語音克隆服務（一鍵口誤修正）
- 另起終端機跑：`python3 python/voice_server.py`（預設 backend = Coqui XTTS-v2；多語言含中文；首次啟動會下載模型）。
- 切換到 VoiceCraft / VoiceCraft-X：clone repo、裝依賴、下載權重，然後：
  ```
  export MEDIASTUDIO_VOICE_BACKEND=voicecraft
  export MEDIASTUDIO_VOICECRAFT_REPO=/path/to/VoiceCraft-X
  python3 python/voice_server.py
  ```
  並依 `voice_server.py` 內註解銜接該 repo 的推論函式（已預留 `synthesize_voicecraft()` 接點）。
- 用法：在編輯器點某段「聲音替換…」→ 輸入修正後的文字 → 按「✨ 自動生成 (VoiceCraft-X / XTTS)」。系統會：
  1. 從原音切 ~6 秒參考音（避開要替換的那段）
  2. POST 到本機 `:9811/generate`，拿生成的 wav
  3. 用前述 atrim/concat 把新音接回原音軌、重新封裝影片（畫面不動）
- 服務 API：`GET /health` ／ `POST /generate {referenceAudio, referenceText?, targetText, language?, outPath}`。

## 其他 Roadmap
- 把上述功能各包成 MCP 工具，讓內建 AI 助手直接驅動
- Tauri/Electron 桌面外殼、`pkg` 單檔執行檔
- 字級時間戳 + WhisperX 強制對齊（已在 transcribe.py 開 `word_timestamps`，下一步在 UI 做卡拉OK逐字字幕）
