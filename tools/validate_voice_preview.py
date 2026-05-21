#!/usr/bin/env python3
"""Validate that GPT-SoVITS preview produces audio matching the requested text.

For each test sentence:
  1. POST to /api/gpt-sovits/train/{id}/preview
  2. Download the resulting wav
  3. Transcribe with faster-whisper
  4. Compare transcript vs requested text (char-level similarity, simplified-aware)
  5. Print PASS / FAIL with similarity score

Usage:
  python3 tools/validate_voice_preview.py <train_job_id> [sentence...]
"""

import sys, json, urllib.request, urllib.error, os, tempfile, re

TESTS_DEFAULT = [
    "今天天氣很好，我們一起去散步。",
    "我喜歡喝咖啡和吃蛋糕。",
    "明天會下雨，記得帶雨傘。",
    "這個方法很有用，謝謝你的幫忙。",
    "我們公司的會議在下午三點開始。",
]

BASE = os.environ.get("MS_BASE", "http://localhost:9810")


def normalize_chinese(s: str) -> str:
    """Strip punctuation + spaces + try simplified→traditional conversion via
    OpenCC if available. Whisper often produces simplified for Mandarin input."""
    s = re.sub(r"[，。、！？；：「」『』（）\(\)\.,!?;:\s]", "", s)
    try:
        import opencc                              # pip install opencc-python-reimplemented
        s = opencc.OpenCC("s2t").convert(s)
    except Exception:
        pass
    return s


def similarity(a: str, b: str) -> float:
    """Char-level Jaccard + difflib ratio average. 0..1."""
    from difflib import SequenceMatcher
    a, b = normalize_chinese(a), normalize_chinese(b)
    if not a or not b:
        return 0.0
    ratio = SequenceMatcher(None, a, b).ratio()
    aset, bset = set(a), set(b)
    jacc = len(aset & bset) / max(1, len(aset | bset))
    return (ratio + jacc) / 2, a, b


def call_preview(train_id: str, text: str) -> str:
    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(f"{BASE}/api/gpt-sovits/train/{train_id}/preview",
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        resp = json.loads(r.read())
    if not resp.get("ok"):
        raise RuntimeError(f"preview failed: {resp}")
    audio_url = BASE + resp["audioUrl"]
    out = tempfile.mktemp(suffix=".wav")
    with urllib.request.urlopen(audio_url, timeout=30) as r, open(out, "wb") as f:
        f.write(r.read())
    return out, resp.get("reference", {})


_whisper_model = None
def transcribe(wav_path: str) -> str:
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel("small", device="cpu", compute_type="int8")
    segs, _ = _whisper_model.transcribe(wav_path, language="zh", beam_size=1)
    return "".join(s.text for s in segs).strip()


def main():
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} <train_job_id> [sentence...]")
        sys.exit(2)
    train_id = sys.argv[1]
    sentences = sys.argv[2:] if len(sys.argv) > 2 else TESTS_DEFAULT

    print(f"validating train job {train_id[:8]} via {BASE}")
    pass_count = 0
    for i, s in enumerate(sentences):
        print(f"\n[{i+1}/{len(sentences)}] target: {s}")
        try:
            wav, ref = call_preview(train_id, s)
            print(f"            ref: idx={ref.get('index')} ({len(ref.get('text','') or '')} chars)")
            actual = transcribe(wav)
            print(f"        whisper: {actual}")
            score, a_norm, b_norm = similarity(s, actual)
            verdict = "PASS" if score >= 0.6 else ("WEAK" if score >= 0.4 else "FAIL")
            print(f"        similarity: {score:.2f} → {verdict}")
            if verdict == "PASS": pass_count += 1
        except Exception as e:
            print(f"        ERROR: {e}")
    print(f"\n=== summary: {pass_count}/{len(sentences)} PASS (>=0.6 similarity) ===")
    sys.exit(0 if pass_count == len(sentences) else 1)


if __name__ == "__main__":
    main()
