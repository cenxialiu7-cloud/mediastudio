#!/usr/bin/env python3
"""
Build a single-speaker dataset suitable for GPT-SoVITS / F5-TTS / IndexTTS
fine-tuning, from a folder of long videos / audios of one speaker.

Pipeline:
  1. ffmpeg → 16 kHz mono wav per source file
  2. silero-VAD (preferred) or ffmpeg silencedetect → speech-only segments
  3. Filter to 2.5–15 s chunks (the sweet spot for these models)
  4. Whisper transcribe each chunk (auto-prefers mlx-whisper on Apple Silicon)
  5. Write GPT-SoVITS list file:    out/list.txt        (`audio|speaker|lang|text`)
     + F5-TTS metadata.csv:         out/metadata.csv    (`audio|text`)
     + a summary JSON

Usage:
  python3 tools/build_voice_dataset.py \\
      --input /path/to/speaker_videos/ \\
      --out   /path/to/dataset_out/ \\
      --speaker xiongao --language zh --model large-v3-turbo

Tip: for the cleanest dataset, pick the 5–10 highest-quality videos (good mic,
no music bed, no co-host). 20–30 min of speech is usually enough for a great
GPT-SoVITS / F5-TTS fine-tune; 60+ min gets you closer to indistinguishable.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

MEDIA_EXT = {'.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi', '.flv', '.wmv', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'}

# When run from MediaStudio's voice training UI, emit one JSON line per progress
# update on stdout. Detected by passing --json-events.
_EMIT_JSON = False
def emit(event, **kw):
    if _EMIT_JSON:
        print(json.dumps({'event': event, **kw}, ensure_ascii=False), flush=True)
    else:
        # human-readable
        if event == 'progress':
            print(kw.get('msg') or '', flush=True)
        elif event == 'file':
            print(f"[+] {kw.get('name')}", flush=True)
        elif event == 'done':
            pass


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError(f'{" ".join(cmd)} failed: {r.stderr[-500:]}')
    return r.stdout


def ffprobe_duration(p):
    try:
        return float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', str(p)]).strip())
    except Exception:
        return 0.0


def extract_wav(src, dst, sr=16000):
    run(['ffmpeg', '-y', '-i', str(src), '-vn', '-ac', '1', '-ar', str(sr), '-c:a', 'pcm_s16le', str(dst), '-loglevel', 'error'])


def vad_segments(wav_path, min_s=2.5, max_s=15.0):
    """Speech segments via silero-vad (preferred) or ffmpeg silencedetect fallback."""
    try:
        import torch  # type: ignore
        torch.set_num_threads(1)
        from silero_vad import load_silero_vad, get_speech_timestamps, read_audio  # type: ignore
        model = load_silero_vad()
        audio = read_audio(str(wav_path), sampling_rate=16000)
        ts = get_speech_timestamps(audio, model, sampling_rate=16000, min_silence_duration_ms=400, min_speech_duration_ms=int(min_s * 1000))
        segs = [(t['start'] / 16000.0, t['end'] / 16000.0) for t in ts]
    except Exception:
        # Fallback: ffmpeg silencedetect
        out = subprocess.run(['ffmpeg', '-i', str(wav_path), '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'],
                             capture_output=True, text=True).stderr
        silences = []
        for line in out.splitlines():
            ms = re.search(r'silence_start: ([\d.]+)', line)
            me = re.search(r'silence_end: ([\d.]+)', line)
            if ms: silences.append(['s', float(ms.group(1))])
            elif me: silences.append(['e', float(me.group(1))])
        dur = ffprobe_duration(wav_path)
        segs = []
        cursor = 0.0
        for kind, t in silences:
            if kind == 's' and t > cursor:
                segs.append((cursor, t))
            elif kind == 'e':
                cursor = t
        if cursor < dur:
            segs.append((cursor, dur))
    # Slice / merge to [min_s, max_s]
    cleaned = []
    for s, e in segs:
        if e - s < min_s:
            continue
        # split long segments
        while e - s > max_s:
            cleaned.append((s, s + max_s))
            s = s + max_s
        if e - s >= min_s:
            cleaned.append((s, e))
    return cleaned


def transcribe_chunk(wav, language, model_size):
    """Use mlx-whisper on Apple Silicon (fast); else faster-whisper. Returns text."""
    try:
        import platform
        if platform.system() == 'Darwin' and platform.machine() in ('arm64', 'aarch64'):
            import mlx_whisper  # type: ignore
            repo_map = {
                'tiny': 'mlx-community/whisper-tiny-mlx',
                'base': 'mlx-community/whisper-base-mlx',
                'small': 'mlx-community/whisper-small-mlx',
                'medium': 'mlx-community/whisper-medium-mlx',
                'large-v3': 'mlx-community/whisper-large-v3-mlx',
                'large-v3-turbo': 'mlx-community/whisper-large-v3-turbo',
            }
            r = mlx_whisper.transcribe(str(wav), path_or_hf_repo=repo_map.get(model_size, repo_map['large-v3-turbo']),
                                      language=None if language in ('auto', '') else language, verbose=False)
            return (r.get('text') or '').strip()
    except Exception:
        pass
    from faster_whisper import WhisperModel  # type: ignore
    m = WhisperModel(model_size, device='cpu', compute_type='int8')
    segs, _ = m.transcribe(str(wav), language=None if language in ('auto', '') else language, vad_filter=False)
    return ' '.join(s.text.strip() for s in segs).strip()


def main():
    global _EMIT_JSON
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='folder OR a single file (audio/video) of the speaker')
    ap.add_argument('--out', required=True, help='output folder for the prepared dataset')
    ap.add_argument('--speaker', default='speaker1', help='speaker label written into the list file')
    ap.add_argument('--language', default='zh', help='ISO code (zh / en / ja …) for both transcription & list file')
    ap.add_argument('--model', default='large-v3-turbo', help='whisper model used to transcribe chunks')
    ap.add_argument('--min-sec', type=float, default=2.5)
    ap.add_argument('--max-sec', type=float, default=15.0)
    ap.add_argument('--sr', type=int, default=22050, help='output sample rate (22050 for GPT-SoVITS, 24000 for F5-TTS — both work)')
    ap.add_argument('--limit-min', type=float, default=None, help='stop once total dataset reaches this many minutes')
    ap.add_argument('--json-events', action='store_true', help='emit machine-readable JSON progress on stdout (used by MediaStudio UI)')
    args = ap.parse_args()
    _EMIT_JSON = args.json_events

    src_path = Path(args.input)
    out_dir = Path(args.out)
    wavs_dir = out_dir / 'wavs'
    wavs_dir.mkdir(parents=True, exist_ok=True)

    list_path = out_dir / 'list.txt'        # GPT-SoVITS format
    meta_path = out_dir / 'metadata.csv'    # F5-TTS / IndexTTS friendly
    summary  = {'inputs': [], 'chunks': 0, 'total_seconds': 0.0, 'speaker': args.speaker, 'language': args.language}

    if src_path.is_file():
        sources = [src_path]
    else:
        sources = sorted([p for p in src_path.rglob('*') if p.suffix.lower() in MEDIA_EXT])
    emit('start', sources=len(sources), out=str(out_dir))
    print(f'found {len(sources)} source file(s) in {src_path}')

    list_lines, meta_lines = [], []
    total_sec = 0.0
    chunk_n = 0

    for idx_src, src in enumerate(sources):
        if args.limit_min and total_sec >= args.limit_min * 60:
            emit('progress', msg='已達 --limit-min 上限，停止'); print('limit reached; stopping.'); break
        emit('file', name=src.name, index=idx_src, total=len(sources))
        print(f'[+] {src.name}')
        try:
            tmp_wav = wavs_dir / f'_src_{src.stem}.wav'
            extract_wav(src, tmp_wav, sr=16000)  # VAD wants 16k
            emit('progress', msg=f'{src.name}：分析語音片段（VAD）…')
            segs = vad_segments(tmp_wav, args.min_sec, args.max_sec)
            emit('progress', msg=f'{src.name}：{len(segs)} 段語音；開始轉錄…')
            print(f'    {len(segs)} speech segments')
            for (s, e) in segs:
                chunk_n += 1
                name = f'{args.speaker}_{chunk_n:05d}.wav'
                out_wav = wavs_dir / name
                run(['ffmpeg', '-y', '-ss', f'{s:.3f}', '-to', f'{e:.3f}', '-i', str(tmp_wav),
                     '-ar', str(args.sr), '-ac', '1', '-c:a', 'pcm_s16le', str(out_wav), '-loglevel', 'error'])
                text = transcribe_chunk(out_wav, args.language, args.model)
                if not text:
                    out_wav.unlink(missing_ok=True); continue
                list_lines.append(f'{out_wav.as_posix()}|{args.speaker}|{args.language}|{text}')
                meta_lines.append(f'{name}|{text}')
                total_sec += (e - s)
                if chunk_n % 5 == 0 or args.json_events:
                    pct = (total_sec / (args.limit_min * 60)) if args.limit_min else None
                    emit('chunk', n=chunk_n, total_seconds=round(total_sec, 1), pct=pct, sample=text[:60])
                if chunk_n % 25 == 0:
                    print(f'    progress: {chunk_n} chunks, {total_sec/60:.1f} min')
                if args.limit_min and total_sec >= args.limit_min * 60:
                    break
            tmp_wav.unlink(missing_ok=True)
            summary['inputs'].append({'file': str(src), 'segments': len(segs)})
        except Exception as exc:
            emit('error', file=str(src), message=str(exc))
            print(f'    ERROR: {exc}', file=sys.stderr)

    list_path.write_text('\n'.join(list_lines) + '\n', encoding='utf-8')
    meta_path.write_text('\n'.join(meta_lines) + '\n', encoding='utf-8')
    summary['chunks'] = chunk_n
    summary['total_seconds'] = total_sec
    summary['list_path'] = str(list_path)
    summary['metadata_path'] = str(meta_path)
    summary['wavs_dir'] = str(wavs_dir)
    (out_dir / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

    emit('done', chunks=chunk_n, total_seconds=round(total_sec, 1),
         list_path=str(list_path), metadata_path=str(meta_path), wavs_dir=str(wavs_dir))
    print()
    print(f'✓ Built {chunk_n} chunks, total {total_sec/60:.1f} min')
    print(f'  Audio:        {wavs_dir}')
    print(f'  GPT-SoVITS:   {list_path}')
    print(f'  F5-TTS meta:  {meta_path}')


if __name__ == '__main__':
    main()
