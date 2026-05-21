# 聲音克隆 — 為什麼 XTTS 聽起來不像，以及怎麼解決

> 結論：XTTS-v2 在 **跨語言短參考音** 的場景表現最差，這就是你聽到「完全不像」的主因。換到更新的開源模型（**F5-TTS / IndexTTS-2 / CosyVoice2**）通常立刻好很多；要做到「幾乎一樣」就針對該講者做微調（**GPT-SoVITS** 或 **F5-TTS finetune**，~20–30 分鐘乾淨人聲即可）。

## 你目前的狀況分析

1. **參考音太短**：6 秒。所有 zero-shot TTS 都靠參考音長度提升相似度；XTTS 官方建議 ≥10 秒、F5-TTS / CosyVoice ≥15 秒。
   - ✅ 已修正：`voiceClone.js` 預設改成 **15 秒**參考音，並挑離編輯段最遠、最乾淨的視窗。
2. **參考音語言與目標語言不同**（你的參考是中文，但 XTTS 對中文 zero-shot 弱，且取樣率受限）。
3. **XTTS-v2 本身在中文（zh-cn）相似度排倒數**：MOS / SECS（Speaker Similarity）evaluation 中，XTTS-v2 中文 SECS 通常落在 ~0.6–0.7，遠輸 F5-TTS（~0.8）、CosyVoice2 / IndexTTS-2（~0.85+）。

## 開源 zero-shot 語音克隆比較（2026 視角）

| 模型 | 中文相似度 | 自然度 | 速度 | 易用度 | 備註 |
|---|---|---|---|---|---|
| **Coqui XTTS-v2** | 中 | 中 | 快 | ⭐⭐⭐ | 目前 MediaStudio 預設。多語言但中文偏弱 |
| **F5-TTS** | ★ 高 | 高 | 中 | ⭐⭐⭐ | Flow-Matching；裝起來最快（`pip install f5-tts`）；參考音可自動轉錄；推薦升級首選 |
| **CosyVoice2**（阿里） | ★★ 最高 | 高 | 中 | ⭐⭐ | 中文 SOTA 之一；要 clone repo + 較大模型 |
| **IndexTTS-2**（BiliBili） | ★★ 最高 | 高 | 中 | ⭐⭐ | 工業級中文；情感控制；要 clone repo |
| **GPT-SoVITS** | 微調後接近原音 | 高 | 中 | ⭐⭐ | **支援單一講者微調 ✓**；社群最強；20 分鐘音檔可做 |
| **Fish-Speech v1.5 / S1** | 高 | 高 | 中 | ⭐⭐ | 多語言；持續更新 |
| **OpenVoice v2** | 中 | 高 | 快 | ⭐⭐⭐ | 樣式/情感轉移強，相似度不如 F5-TTS |
| **MaskGCT** | 高 | 高 | 慢 | ⭐⭐ | 非自迴歸；學術界推 |
| **VoiceCraft / VoiceCraft-X** | — | — | 慢 | ⭐⭐ | **不是純 TTS**；專做「就地編輯幾個字」— 跟你「切分後只換錯字」的需求最契合 |

## 推薦升級路線（由易到難）

### Tier 1 — 換 backend，不微調（**今天就能做**）
- **F5-TTS**：已預先安裝中（背景），MediaStudio voice_server 已加入 `f5tts` backend。
  - 啟動：`MEDIASTUDIO_VOICE_BACKEND=f5tts python3 python/voice_server.py`
- **IndexTTS-2 / CosyVoice2**：要 clone GitHub repo + 下載權重；之後在 `voice_server.py` 的 `SYNTH` 字典加 `init_cosyvoice` / `init_indextts2` 函式（同 `synthesize_f5tts` 的格式）。  
  - https://github.com/index-tts/index-tts
  - https://github.com/FunAudioLLM/CosyVoice

預期效果：相似度 +20–40%；若參考音乾淨 (>15s)，很多時候已經夠用。

### Tier 2 — 用「就地編輯」模型（**針對你 #1 的工作流最匹配**）
**VoiceCraft / VoiceCraft-X**：給原音 + 目標逐字稿，**只重生你改動的字詞**，沿用原說話者的音色與韻律。切分出 3 個字的小片段 → 替換那 3 個字 → 接點自然。
- https://github.com/jasonppy/VoiceCraft
- https://github.com/zszheng147/VoiceCraft-X （含中文）
- MediaStudio 的 `voice_server.py` 已預留 `voicecraft` backend hook，需你 clone 該 repo 並調整 `synthesize_voicecraft()` 對接其推論函式。

### Tier 3 — 針對該講者**微調**（**幾乎一樣**）

對你的「投資頻道-熊敖」這種長期穩定的單一講者，這是最終答案。MediaStudio 內附自動化工具：

#### Step 1：用 MediaStudio 內附工具建立資料集
```bash
cd MediaStudio
python3 tools/build_voice_dataset.py \
    --input  ~/Downloads/MediaGrab/投資影片 \
    --out    ~/voice_datasets/xiongao \
    --speaker xiongao --language zh \
    --model large-v3-turbo \
    --limit-min 30
```
工具自動：① 抽音 ② silero-VAD 切成 2.5–15 秒片段 ③ 用 mlx-whisper（M5 Neural Engine）轉錄 ④ 輸出 GPT-SoVITS / F5-TTS 都吃得下的格式：
```
out/wavs/xiongao_00001.wav, _00002.wav, ...
out/list.txt        # GPT-SoVITS: path|speaker|lang|text
out/metadata.csv    # F5-TTS:     name|text
out/summary.json
```
> 30 分鐘乾淨音檔通常夠用；建議挑 5–10 部高品質的（同麥克風、無 BGM、無來賓干擾）。

#### Step 2-A：微調 GPT-SoVITS（推薦，社群最成熟）
```bash
git clone https://github.com/RVC-Boss/GPT-SoVITS && cd GPT-SoVITS
pip install -r requirements.txt
python3 webui.py
```
Web UI 走「1A 預處理 → 1B 提取 SSL → 1C SoVITS 訓練 → 1D GPT 訓練 → 2 推論」。M5 GPU 約 1–3 小時可訓完一個 v2 模型。最後 `inference_webui` 可即時試聽，覺得像了就把 checkpoint 放到一個固定路徑、寫個 `synthesize_gptsovits()` 函式接進 `voice_server.py`。

#### Step 2-B：微調 F5-TTS
F5-TTS 也支援微調（需要 ~10 GB 顯存 / Apple Metal）；社群文檔在：
- https://github.com/SWivid/F5-TTS#training
- 用前面同一份 `metadata.csv` 即可

#### Step 2-C：用商業 API（最快但要錢）
- ElevenLabs Voice Cloning（Professional）— 30 分鐘音檔，效果接近原音，但要付費 / 上傳到雲端
- 我假設你想留在本機，所以 A/B 是主推

## MediaStudio 端已做的改進

1. **參考音 6s → 15s**（`voiceClone.js`）
2. **multi-backend voice_server**：`MEDIASTUDIO_VOICE_BACKEND=xtts|f5tts|voicecraft` 切換
3. **F5-TTS 後端**：`synthesize_f5tts()`，自動轉錄參考音，支援中文
4. **資料集自動化**：`tools/build_voice_dataset.py`（mlx-whisper + silero-VAD）
5. **智慧切分**（你的 #1）：在逐字稿插入空白後按「切分」，會：
   - 在每個空白處切
   - 依字級時間戳/字數比例自動分配時間軸
   - 切出的片段各自獨立可編輯、可單獨做聲音替換 → 配上 VoiceCraft / 微調後的 F5-TTS / GPT-SoVITS 即可「只替換錯字、聲音不變」

## 快速行動建議

| 你的目標 | 做什麼 |
|---|---|
| 「我只想立刻好一點點」 | F5-TTS（已預載），啟動指令見上 |
| 「我常常做這個講者的影片，想要近乎完美」 | `build_voice_dataset.py` → GPT-SoVITS 微調 |
| 「只想改影片裡的少數錯字」 | 用智慧切分把錯字單獨切出 → VoiceCraft / 微調後 F5-TTS 替換那 3–5 個字 |
| 「我不想自己訓練」 | F5-TTS + 15 秒高品質參考音通常已足；不行才升 CosyVoice2 / IndexTTS-2 |
