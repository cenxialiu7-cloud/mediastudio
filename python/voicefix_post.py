#!/usr/bin/env python3
"""Layer-1 splice polisher for voicefix.

Given the source video, the [start,end] segment being replaced, and the
raw cloned audio from GPT-SoVITS / XTTS / F5-TTS, produce a 48 kHz stereo
WAV that:

  1. is time-stretched to exactly the target duration (so it slots into
     the original timing without de-syncing the rest of the video)
  2. is loudness-matched (LUFS) to the speaker's surrounding audio
  3. is spectrum/RMS/peak-matched to the surrounding audio (matchering)
  4. has the original room tone re-injected at -40 dB under it (so the
     ambient noise floor does not dip on the replaced section)
  5. has its first/last `margin` seconds equal-power-crossfaded with the
     source audio at the splice boundaries (so the hard ffmpeg concat
     downstream is perceptually seamless)

Each layer degrades gracefully if its optional dep is missing; the
script always returns SOMETHING usable (worst case: just resampled +
LUFS-matched).

stdout JSON: {ok, layers:[...], applied:[...], duration, error?}
"""

import argparse, json, os, subprocess, sys, tempfile, traceback
import numpy as np

SR = 48000              # work sample rate
CHANNELS = 2            # output channels


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def ffmpeg_extract(src, start, end, out_wav):
    """Extract a window of src to mono 48 kHz wav (start<0 is clamped)."""
    s = max(0.0, float(start))
    dur = max(0.001, float(end) - s)
    cmd = ['ffmpeg', '-y', '-loglevel', 'error',
           '-ss', f'{s:.3f}', '-t', f'{dur:.3f}', '-i', src,
           '-vn', '-ac', '1', '-ar', str(SR), '-f', 'wav', out_wav]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f'ffmpeg extract failed: {r.stderr.decode("utf-8","ignore")[-300:]}')


def read_wav_mono(path):
    """Read any audio file as mono 48 kHz float32."""
    import soundfile as sf
    data, sr = sf.read(path, always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    data = data.astype(np.float32)
    if sr != SR:
        # use scipy poly resample (high quality, no extra dep)
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(int(sr), SR)
        data = resample_poly(data, SR // g, sr // g).astype(np.float32)
    return data


def write_wav_stereo(path, mono, sr=SR):
    import soundfile as sf
    stereo = np.stack([mono, mono], axis=1)
    sf.write(path, stereo, sr, subtype='PCM_16')


def time_stretch(mono, ratio, applied):
    """Stretch to ratio*len. Prefer rubberband; fall back to no-op if close to 1."""
    if abs(ratio - 1.0) < 0.01:
        return mono
    # rubberband stays natural-sounding for speech up to ~1.7x; beyond that
    # we clamp the ratio rather than skipping entirely, so the polished clip
    # at least fills more of the slot (the residual gap is padded with room
    # tone downstream, which is far less jarring than dropping the stretch).
    clamped = float(np.clip(ratio, 0.55, 1.7))
    if clamped != ratio:
        log(f'[stretch] requested ratio {ratio:.3f} clamped to {clamped:.3f}')
        ratio = clamped
    try:
        import pyrubberband as pyrb
        out = pyrb.time_stretch(mono, SR, 1.0 / ratio).astype(np.float32)
        applied.append(f'time_stretch(ratio={ratio:.3f},rubberband)')
        return out
    except Exception as e:
        log(f'[stretch] rubberband unavailable ({e!r}); falling back to scipy resample')
        from scipy.signal import resample
        n = max(1, int(round(len(mono) * ratio)))
        applied.append(f'time_stretch(ratio={ratio:.3f},resample_fallback)')
        return resample(mono, n).astype(np.float32)


def lufs_match(target_mono, ref_mono, applied):
    """Match integrated LUFS of target to ref. Returns adjusted target."""
    try:
        import pyloudnorm as pyln
        meter = pyln.Meter(SR)
        ref_lufs = meter.integrated_loudness(ref_mono)
        tgt_lufs = meter.integrated_loudness(target_mono)
        if not np.isfinite(ref_lufs) or not np.isfinite(tgt_lufs):
            log(f'[lufs] non-finite (ref={ref_lufs}, tgt={tgt_lufs}); skip')
            return target_mono
        gain_db = ref_lufs - tgt_lufs
        # cap to avoid catastrophic amplification of near-silent clones
        gain_db = float(np.clip(gain_db, -20.0, 12.0))
        gain = 10.0 ** (gain_db / 20.0)
        applied.append(f'lufs_match(ref={ref_lufs:.1f},gain={gain_db:+.1f}dB)')
        return (target_mono * gain).astype(np.float32)
    except Exception as e:
        log(f'[lufs] failed ({e!r}); skip')
        return target_mono


def matchering_match(target_path, ref_path, out_path, applied):
    """Spectrum + RMS + peak match using matchering. Returns out_path or None."""
    try:
        import matchering as mg
        mg.log(warning_handler=lambda *a, **k: None, info_handler=lambda *a, **k: None)
        mg.process(
            target=target_path,
            reference=ref_path,
            results=[mg.pcm16(out_path)],
        )
        applied.append('matchering(spectrum+rms+peak)')
        return out_path
    except Exception as e:
        log(f'[matchering] failed ({e!r}); skip')
        return None


def extract_room_tone(ref_mono, min_ms=120):
    """Find the quietest ~min_ms window in ref and return it as a loopable bed."""
    win = int(SR * min_ms / 1000)
    if len(ref_mono) < win * 2:
        return None
    # sliding RMS, pick min
    sq = ref_mono.astype(np.float64) ** 2
    csum = np.cumsum(np.concatenate([[0.0], sq]))
    rms = np.sqrt(np.maximum(0, (csum[win:] - csum[:-win]) / win))
    if len(rms) == 0:
        return None
    i = int(np.argmin(rms))
    tone = ref_mono[i:i + win].astype(np.float32)
    return tone


def inject_room_tone(target_mono, tone, db_under=-40.0, applied=None):
    if tone is None or len(tone) < 100:
        return target_mono
    gain = 10.0 ** (db_under / 20.0)
    # tile tone to length, with random offsets to avoid metallic loop
    out_len = len(target_mono)
    reps = out_len // len(tone) + 2
    bed = np.tile(tone, reps)[:out_len].astype(np.float32) * gain
    # tiny fade in/out on bed to avoid clicks
    fade = min(int(SR * 0.005), len(bed) // 4)
    if fade > 0:
        bed[:fade] *= np.linspace(0, 1, fade, dtype=np.float32)
        bed[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    if applied is not None:
        applied.append(f'room_tone({db_under:+.0f}dB)')
    return (target_mono + bed).astype(np.float32)


def crossfade_edges(polished, src_pre_tail, src_post_head, margin_s, applied):
    """Equal-power (cos^2) crossfade polished's first/last `margin` with src
    boundary samples, so a downstream hard concat is perceptually seamless."""
    m = int(SR * margin_s)
    if m <= 0 or len(polished) <= 2 * m:
        return polished
    out = polished.copy()
    # equal-power weights
    t = np.linspace(0, np.pi / 2, m, dtype=np.float32)
    w_in = np.sin(t) ** 2     # rises 0->1
    w_out = np.cos(t) ** 2    # falls 1->0
    if src_pre_tail is not None and len(src_pre_tail) >= m:
        out[:m] = polished[:m] * w_in + src_pre_tail[-m:] * w_out
    if src_post_head is not None and len(src_post_head) >= m:
        out[-m:] = polished[-m:] * w_out + src_post_head[:m] * w_in
    applied.append(f'crossfade({int(margin_s*1000)}ms)')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='source video/audio')
    ap.add_argument('--start', type=float, required=True)
    ap.add_argument('--end', type=float, required=True)
    ap.add_argument('--clone', required=True, help='raw cloned wav from TTS')
    ap.add_argument('--out', required=True, help='polished wav out (48k stereo PCM16)')
    ap.add_argument('--margin', type=float, default=0.03, help='crossfade seconds at each splice boundary')
    ap.add_argument('--ref-window', type=float, default=0.6, help='seconds of src on each side used as LUFS/spectrum reference')
    args = ap.parse_args()

    result = {'ok': False, 'applied': [], 'duration': 0.0}
    try:
        s = float(args.start); e = float(args.end)
        target_dur = max(0.05, e - s)
        rw = float(args.ref_window)

        with tempfile.TemporaryDirectory() as td:
            # reference windows from src: [s-rw, s] and [e, e+rw], plus an
            # immediate edge for crossfade [s, s+margin] / [e-margin, e]
            pre_ref_path = os.path.join(td, 'pre_ref.wav')
            post_ref_path = os.path.join(td, 'post_ref.wav')
            ffmpeg_extract(args.src, s - rw, s, pre_ref_path)
            ffmpeg_extract(args.src, e, e + rw, post_ref_path)
            pre_ref = read_wav_mono(pre_ref_path)
            post_ref = read_wav_mono(post_ref_path)

            # boundary slices that will replace polished's first/last margin
            pre_edge_path = os.path.join(td, 'pre_edge.wav')
            post_edge_path = os.path.join(td, 'post_edge.wav')
            ffmpeg_extract(args.src, s - args.margin, s, pre_edge_path)
            ffmpeg_extract(args.src, e, e + args.margin, post_edge_path)
            pre_edge = read_wav_mono(pre_edge_path)
            post_edge = read_wav_mono(post_edge_path)

            # load clone, resample to 48k mono
            clone = read_wav_mono(args.clone)
            clone_dur = len(clone) / SR
            log(f'[in] clone_dur={clone_dur:.3f}s target_dur={target_dur:.3f}s')

            # 1) time stretch to target duration
            ratio = target_dur / max(0.001, clone_dur)
            clone = time_stretch(clone, ratio, result['applied'])

            # length-exact: pad or trim to target_dur samples
            n_target = int(round(target_dur * SR))
            if len(clone) < n_target:
                clone = np.pad(clone, (0, n_target - len(clone)))
            else:
                clone = clone[:n_target]

            # 2) LUFS match using concat of both ref windows
            ref_concat = np.concatenate([pre_ref, post_ref])
            clone = lufs_match(clone, ref_concat, result['applied'])

            # 3) spectrum / RMS / peak match via matchering (writes through wav files)
            t_in = os.path.join(td, 'mg_in.wav')
            t_ref = os.path.join(td, 'mg_ref.wav')
            t_out = os.path.join(td, 'mg_out.wav')
            write_wav_stereo(t_in, clone)
            write_wav_stereo(t_ref, ref_concat)
            if matchering_match(t_in, t_ref, t_out, result['applied']):
                clone = read_wav_mono(t_out)
                # matchering preserves length but be safe
                if len(clone) != n_target:
                    clone = np.resize(clone, n_target)

            # 4) room tone injection (use the quieter of the two ref windows)
            tone = extract_room_tone(ref_concat)
            clone = inject_room_tone(clone, tone, db_under=-40.0, applied=result['applied'])

            # 5) edge crossfade so downstream hard concat is seamless
            clone = crossfade_edges(clone, pre_edge, post_edge, args.margin, result['applied'])

            # safety: hard clip just under 0 dBFS to prevent inter-sample peaks
            peak = float(np.max(np.abs(clone))) if len(clone) else 0.0
            if peak > 0.98:
                clone *= (0.98 / peak)
                result['applied'].append(f'peak_limit({peak:.2f}->0.98)')

            write_wav_stereo(args.out, clone)
            result['ok'] = True
            result['duration'] = float(len(clone) / SR)
    except Exception as ex:
        result['error'] = f'{type(ex).__name__}: {ex}'
        result['trace'] = traceback.format_exc().splitlines()[-6:]

    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result['ok'] else 2)


if __name__ == '__main__':
    main()
