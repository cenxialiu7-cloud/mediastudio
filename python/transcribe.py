#!/usr/bin/env python3
"""
MediaStudio transcription worker.

Reads a 16kHz mono WAV, runs faster-whisper, and emits newline-delimited JSON
events on stdout:

  {"event":"progress","pct":0.0..1.0,"msg":"..."}
  {"event":"result","segments":[{"start":..,"end":..,"text":..,"words":[...],"speaker":..}],
   "language":"zh","duration":123.4,"info":{...}}
  {"event":"error","message":"..."}

Optional speaker diarization (--diarize) requires `pyannote.audio` and a HF token
in the HF_TOKEN environment variable.
"""
import argparse
import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def err(msg):
    emit({"event": "error", "message": str(msg)})
    sys.exit(1)


def diarize_segments(audio_path):
    """Return list of (start, end, speaker_label) or None on failure."""
    token = os.environ.get("HF_TOKEN")
    if not token:
        emit({"event": "progress", "pct": None, "msg": "diarize 已要求，但未設定 HF_TOKEN，略過"})
        return None
    try:
        from pyannote.audio import Pipeline  # type: ignore
    except Exception:
        emit({"event": "progress", "pct": None, "msg": "未安裝 pyannote.audio，略過說話者辨識"})
        return None
    try:
        emit({"event": "progress", "pct": None, "msg": "載入說話者辨識模型…"})
        pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
        diar = pipe(audio_path)
        turns = []
        for turn, _, speaker in diar.itertracks(yield_label=True):
            turns.append((turn.start, turn.end, str(speaker)))
        return turns
    except Exception as e:  # noqa: BLE001
        emit({"event": "progress", "pct": None, "msg": f"說話者辨識失敗: {e}"})
        return None


def assign_speakers(segments, turns):
    if not turns:
        return segments
    for seg in segments:
        mid = (seg["start"] + seg["end"]) / 2.0
        best = None
        for (s, e, spk) in turns:
            if s <= mid <= e:
                best = spk
                break
        if best is None:
            # fall back to max-overlap
            best_ov = 0.0
            for (s, e, spk) in turns:
                ov = max(0.0, min(seg["end"], e) - max(seg["start"], s))
                if ov > best_ov:
                    best_ov, best = ov, spk
        if best:
            seg["speaker"] = best
    return segments


MLX_REPO = {
    "tiny":           "mlx-community/whisper-tiny-mlx",
    "base":           "mlx-community/whisper-base-mlx",
    "small":          "mlx-community/whisper-small-mlx",
    "medium":         "mlx-community/whisper-medium-mlx",
    "large-v3":       "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


def transcribe_mlx(audio, model, language, task):
    """Apple Silicon MLX backend. Returns (segments, language, duration, info)."""
    import mlx_whisper  # type: ignore
    repo = MLX_REPO.get(model, MLX_REPO["medium"])
    emit({"event": "progress", "pct": 0.05, "msg": f"MLX 載入 {repo}（首次會下載）…"})
    out = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=repo,
        language=None if language in (None, "", "auto") else language,
        task=task,
        word_timestamps=True,
        verbose=False,
    )
    segs_raw = out.get("segments", []) or []
    segments = []
    for s in segs_raw:
        words = None
        if s.get("words"):
            words = [{"start": float(w["start"]), "end": float(w["end"]), "word": w.get("word", "")} for w in s["words"] if w.get("start") is not None]
        segments.append({
            "start": float(s.get("start", 0.0)),
            "end": float(s.get("end", 0.0)),
            "text": (s.get("text") or "").strip(),
            "words": words,
        })
    last_end = segments[-1]["end"] if segments else 0.0
    return segments, out.get("language"), last_end, {"backend": "mlx-whisper", "model": model, "repo": repo, "device": "mlx (Apple Silicon)"}


def transcribe_faster_whisper(audio, model, language, task, compute_type):
    """Fallback CPU/GPU backend via CTranslate2."""
    from faster_whisper import WhisperModel  # type: ignore
    device = "cpu"
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            device = "cuda"
    except Exception:
        pass
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"

    emit({"event": "progress", "pct": 0.02, "msg": f"faster-whisper 載入 {model} ({device}/{compute_type})…"})
    try:
        m = WhisperModel(model, device=device, compute_type=compute_type)
    except Exception as e:
        if compute_type != "float32":
            emit({"event": "progress", "pct": 0.02, "msg": f"{compute_type} 不可用，改 float32…"})
            m = WhisperModel(model, device="cpu", compute_type="float32")
        else:
            raise

    emit({"event": "progress", "pct": 0.05, "msg": "開始轉錄…"})
    seg_iter, info = m.transcribe(audio, language=language if language not in (None, "auto", "") else None,
                                  task=task, vad_filter=True, word_timestamps=True)
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    segments = []
    for seg in seg_iter:
        words = None
        if getattr(seg, "words", None):
            words = [{"start": float(w.start), "end": float(w.end), "word": w.word} for w in seg.words if w.start is not None]
        segments.append({"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip(), "words": words})
        if duration > 0:
            emit({"event": "progress", "pct": min(0.95, 0.05 + 0.9 * (float(seg.end) / duration)), "msg": seg.text.strip()[:60]})
    return segments, getattr(info, "language", None), duration, {"backend": "faster-whisper", "model": model, "device": device, "compute_type": compute_type}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="medium")
    ap.add_argument("--language", default=None)
    ap.add_argument("--task", default="transcribe", choices=["transcribe", "translate"])
    ap.add_argument("--compute-type", default="auto")
    ap.add_argument("--backend", default="auto", choices=["auto", "mlx", "faster"], help="auto = prefer mlx on darwin/arm64")
    ap.add_argument("--diarize", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        err(f"audio file not found: {args.audio}")

    # Decide backend
    import platform
    is_apple_silicon = platform.system() == "Darwin" and platform.machine() in ("arm64", "aarch64")
    backend = args.backend
    if backend == "auto":
        backend = "mlx" if is_apple_silicon else "faster"

    segments = language = duration = info = None
    try:
        if backend == "mlx":
            segments, language, duration, info = transcribe_mlx(args.audio, args.model, args.language, args.task)
        else:
            segments, language, duration, info = transcribe_faster_whisper(args.audio, args.model, args.language, args.task, args.compute_type)
    except ImportError as e:
        if backend == "mlx":
            emit({"event": "progress", "pct": 0.02, "msg": f"mlx-whisper 未安裝（{e}）— 改用 faster-whisper。"})
            try:
                segments, language, duration, info = transcribe_faster_whisper(args.audio, args.model, args.language, args.task, args.compute_type)
            except Exception as e2:
                err(f"兩個後端都不可用：mlx-whisper={e}; faster-whisper={e2}\n請執行: pip install mlx-whisper  或  pip install faster-whisper")
        else:
            err(f"faster-whisper 不可用：{e}。請執行: pip install faster-whisper")
    except Exception as e:
        err(f"transcribe ({backend}) 失敗: {e}")

    if args.diarize:
        turns = diarize_segments(args.audio)
        segments = assign_speakers(segments, turns)

    emit({"event": "progress", "pct": 0.99, "msg": "完成轉錄"})
    emit({
        "event": "result",
        "segments": segments,
        "language": language,
        "duration": duration,
        "info": info,
    })


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        err(e)
