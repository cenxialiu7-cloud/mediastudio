#!/usr/bin/env python3
"""
MediaStudio embedded-subtitle OCR worker.

Reads a video and OCRs the lower band of frames at a configurable rate, then
groups consecutive frames with the same text into [start,end] segments.

Output (NDJSON on stdout):
  {"event":"progress","pct":0.0..1.0,"msg":"..."}
  {"event":"result","segments":[{"start":..,"end":..,"text":..}], "fps":..., "duration":..., "engine":"paddleocr|rapidocr"}
  {"event":"error","message":"..."}

OCR engine selection (first available wins):
  - paddleocr   (`pip install paddlepaddle paddleocr`)
  - rapidocr_onnxruntime  (`pip install rapidocr-onnxruntime`)  ← lighter

Cropping defaults to the bottom 30% of the frame which is where burned-in
subtitles usually live; adjust with --band-top / --band-bottom (0..1 ratios).
"""
import argparse
import json
import os
import sys
import re

try:
    import cv2  # type: ignore
except Exception:
    cv2 = None


def emit(o):
    sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def err(m):
    emit({"event": "error", "message": str(m)})
    sys.exit(1)


def normalize(t):
    if not t:
        return ""
    t = re.sub(r"\s+", "", t)
    # strip common OCR junk and stray punctuation that flickers between frames
    return t.strip(" ,.;:!?，。；：！？、")


def similar(a, b):
    """Cheap similarity: equal after normalize, or one is a prefix/contains of the other (>=0.8 ratio)."""
    a, b = normalize(a), normalize(b)
    if not a or not b:
        return a == b
    if a == b:
        return True
    s, l = (a, b) if len(a) <= len(b) else (b, a)
    if s in l and len(s) / len(l) >= 0.7:
        return True
    # quick char-overlap ratio
    same = sum(1 for ch in s if ch in l)
    return same / max(1, len(l)) >= 0.85


def load_engine():
    """Return a callable f(image_bgr) -> list[str] of text lines."""
    try:
        from paddleocr import PaddleOCR  # type: ignore
        ocr = PaddleOCR(use_angle_cls=False, lang='ch', show_log=False)

        def run(img):
            res = ocr.ocr(img, cls=False)
            out = []
            if not res:
                return out
            for line in res:
                if not line:
                    continue
                for item in line:
                    try:
                        out.append(item[1][0])
                    except Exception:
                        pass
            return out
        return run, "paddleocr"
    except Exception:
        pass
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
        ocr = RapidOCR()

        def run(img):
            res, _ = ocr(img)
            return [r[1] for r in (res or [])]
        return run, "rapidocr"
    except Exception:
        pass
    err(
        "找不到 OCR 引擎。請擇一安裝：\n"
        "  pip install rapidocr-onnxruntime   # 較輕量、首選\n"
        "  pip install paddlepaddle paddleocr"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out-json", required=True)
    ap.add_argument("--fps", type=float, default=2.0, help="frames per second to sample")
    ap.add_argument("--band-top", type=float, default=0.70)
    ap.add_argument("--band-bottom", type=float, default=1.0)
    ap.add_argument("--min-duration", type=float, default=0.3)
    args = ap.parse_args()

    if cv2 is None:
        err("缺少 OpenCV：pip install opencv-python")
    if not os.path.isfile(args.video):
        err(f"找不到影片: {args.video}")

    ocr_fn, engine = load_engine()
    emit({"event": "progress", "pct": 0.02, "msg": f"OCR 引擎: {engine}"})

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        err("無法開啟影片")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = nframes / fps if fps else 0
    step = max(1, int(round(fps / max(0.2, args.fps))))

    segments = []
    last_text = ""
    last_start = None
    last_seen = None

    def flush(end):
        if last_text and last_start is not None and (end - last_start) >= args.min_duration:
            segments.append({"start": round(last_start, 3), "end": round(end, 3), "text": last_text})

    i = 0
    processed = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            h = frame.shape[0]
            y0 = int(h * max(0.0, min(1.0, args.band_top)))
            y1 = int(h * max(0.0, min(1.0, args.band_bottom)))
            band = frame[y0:y1, :, :]
            try:
                lines = ocr_fn(band)
            except Exception as e:
                lines = []
                emit({"event": "progress", "pct": None, "msg": f"OCR 例外（已略過該幀）: {e}"})
            text = " ".join([t for t in (lines or []) if t]).strip()
            t = i / fps
            if normalize(text):
                if last_text and similar(text, last_text):
                    last_seen = t
                else:
                    if last_text:
                        flush(last_seen if last_seen is not None else t)
                    last_text = text
                    last_start = t
                    last_seen = t
            else:
                if last_text:
                    flush(last_seen if last_seen is not None else t)
                    last_text = ""
                    last_start = None
                    last_seen = None
            processed += 1
            if nframes:
                emit({"event": "progress", "pct": min(0.98, i / nframes), "msg": f"frame {i}/{nframes} → {text[:40]}"})
        i += 1

    flush(duration)
    cap.release()

    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump({"segments": segments, "fps": fps, "duration": duration, "engine": engine}, f, ensure_ascii=False)

    emit({"event": "result", "segments": segments, "fps": fps, "duration": duration, "engine": engine})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        err(e)
