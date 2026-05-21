#!/usr/bin/env python3
"""
MediaStudio local voice-clone service. Multi-backend, lazy-loaded.

Endpoints:
  GET  /health
       → {"ok":true, "default":"xtts", "available":["xtts","f5tts","voicecraft"],
          "ready":{"xtts":true, "f5tts":false, "voicecraft":false},
          "models":{"xtts":"…", ...},
          "loading":{"xtts":false, "f5tts":false}}
  POST /load   {"backend": "xtts"|"f5tts"|"voicecraft"}
       → kicks off model loading for that backend (in background); returns immediately
  POST /generate
       {
         "backend":          "xtts"|"f5tts"|"voicecraft"   # optional, defaults to env or "xtts"
         "referenceAudio":   "/abs/path.wav"
         "referenceText":    "..."         # optional; F5-TTS auto-transcribes if empty
         "targetText":       "..."
         "language":         "zh-cn|en|ja|…"
         "outPath":          "/abs/path.wav"
         "speed":            1.0           # optional, only honored by some backends
       }
       → {"ok":true, "path":"...", "backend":"...", "model":"..."}

Run:
  python3 voice_server.py                         # default backend = xtts
  MEDIASTUDIO_VOICE_BACKEND=f5tts python3 …       # default backend = f5tts (needs Python 3.10+)
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock, Thread
import json
import os
import sys
import traceback

DEFAULT_BACKEND = os.environ.get('MEDIASTUDIO_VOICE_BACKEND', 'xtts').lower()
PORT = int(os.environ.get('MEDIASTUDIO_VOICE_PORT', '9811'))
HOST = os.environ.get('MEDIASTUDIO_VOICE_HOST', '127.0.0.1')

_engines = {}              # backend -> opaque engine object
_models  = {}              # backend -> str  (model name)
_loading = {}              # backend -> bool
_errors  = {}              # backend -> last error string
_locks   = {}              # backend -> Lock


def log(m):
    print(f'[voice-server] {m}', file=sys.stderr, flush=True)


# ---------- backend: Coqui XTTS-v2 ----------
def init_xtts():
    from TTS.api import TTS  # type: ignore
    model_name = os.environ.get('MEDIASTUDIO_XTTS_MODEL', 'tts_models/multilingual/multi-dataset/xtts_v2')
    log(f'loading XTTS model: {model_name}')
    tts = TTS(model_name)
    _engines['xtts'] = tts
    _models['xtts'] = model_name


def synthesize_xtts(req):
    tts = _engines['xtts']
    tts.tts_to_file(
        text=req['targetText'],
        speaker_wav=req['referenceAudio'],
        language=req.get('language') or 'zh-cn',
        file_path=req['outPath'],
    )
    return req['outPath']


# ---------- backend: F5-TTS (Flow-Matching, higher fidelity) ----------
def init_f5tts():
    from f5_tts.api import F5TTS  # type: ignore
    model = os.environ.get('MEDIASTUDIO_F5TTS_MODEL')
    log(f'loading F5-TTS{" model=" + model if model else ""} (first run downloads ~1.5 GB)…')
    _engines['f5tts'] = F5TTS(model=model) if model else F5TTS()
    _models['f5tts'] = f'F5-TTS{(":" + model) if model else ""}'


def synthesize_f5tts(req):
    tts = _engines['f5tts']
    tts.infer(
        ref_file=req['referenceAudio'],
        ref_text=req.get('referenceText') or '',
        gen_text=req['targetText'],
        file_wave=req['outPath'],
        seed=req.get('seed', 42),
        remove_silence=True,
    )
    return req['outPath']


# ---------- backend: VoiceCraft / VoiceCraft-X (speech editing) ----------
def init_voicecraft():
    repo = os.environ.get('MEDIASTUDIO_VOICECRAFT_REPO')
    if not repo or not os.path.isdir(repo):
        raise RuntimeError('請設定 MEDIASTUDIO_VOICECRAFT_REPO=/path/to/VoiceCraft-X 並下載權重')
    sys.path.insert(0, repo)
    from inference_speech_editing import inference_speech_editing  # type: ignore  # noqa: F401
    _engines['voicecraft'] = inference_speech_editing
    _models['voicecraft'] = 'VoiceCraft-X'


def synthesize_voicecraft(req):
    fn = _engines['voicecraft']
    return fn(
        orig_audio=req['referenceAudio'],
        orig_text=req.get('referenceText') or '',
        target_text=req['targetText'],
        out_path=req['outPath'],
    )


# ---------- backend: GPT-SoVITS (via the official api_v2.py HTTP API) ----------
# This backend does not load a model into THIS python process. Instead it
# proxies to a separately running `api_v2.py` HTTP server which MediaStudio
# spins up after the user installs + trains a model.
def init_gptsovits():
    import urllib.request, json
    url = os.environ.get('MEDIASTUDIO_GPTSOVITS_API', 'http://127.0.0.1:9880')
    # cheap reachability probe
    try:
        urllib.request.urlopen(url, timeout=2)
    except Exception:
        # api may not be up yet — that's OK, we lazy-call /set_model later
        log(f'gptsovits api at {url} not reachable yet; will retry on /generate')
    _engines['gptsovits'] = url
    _models['gptsovits'] = f'GPT-SoVITS @ {url}'


_gptsovits_loaded = {'sovits': None, 'gpt': None, '_yaml_seeded': False}


def _seed_loaded_from_yaml():
    """api_v2 boots with weights configured in tts_infer.yaml's `custom:` block
    pre-loaded into memory. If we naively call /set_*_weights with the SAME
    paths, the model reloads — and that reload corrupts internal state on
    macOS, causing every subsequent /tts to fail with [Errno 32] Broken pipe.

    Read the yaml once and seed our local cache so the existing dedup check
    treats those paths as already-loaded and skips the redundant reload.
    """
    if _gptsovits_loaded['_yaml_seeded']:
        return
    _gptsovits_loaded['_yaml_seeded'] = True
    yaml_path = os.environ.get('MEDIASTUDIO_GPTSOVITS_YAML') or os.path.expanduser(
        '~/.mediastudio-gpt-sovits/GPT_SoVITS/configs/tts_infer.yaml')
    try:
        import yaml
        with open(yaml_path, 'r', encoding='utf-8') as f:
            cfg = yaml.safe_load(f) or {}
        custom = cfg.get('custom') or {}
        s = custom.get('vits_weights_path')
        g = custom.get('t2s_weights_path')
        if s: _gptsovits_loaded['sovits'] = s
        if g: _gptsovits_loaded['gpt'] = g
        log(f'gptsovits: seeded loaded weights from yaml — sovits={s} gpt={g}')
    except Exception as e:
        log(f'gptsovits: yaml seed failed ({e!r}); will set_weights on first call')


def _ensure_ref_in_range(ref_path):
    """GPT-SoVITS api_v2 hard-rejects ref audio outside 3-10s with HTTP 400
    ("參考音頻在3~10秒範圍外，請更換！"). Voice profiles default to 20s, so
    almost every call would fail. Probe duration; if out of range, write a
    truncated/extended copy to /tmp and return that path. Idempotent +
    deterministic (hash by source path & mtime), so repeated calls hit cache.
    """
    import subprocess, hashlib, os
    if not os.path.exists(ref_path):
        return ref_path
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nokey=1:noprint_wrappers=1', ref_path],
            capture_output=True, text=True, timeout=10)
        dur = float((r.stdout or '0').strip())
    except Exception:
        return ref_path
    # 3 ≤ dur ≤ 10 → pass through
    if 3.0 <= dur <= 10.0:
        return ref_path
    # Out of range → re-encode to a clamped clip in /tmp, deterministic by mtime
    try:
        mt = os.path.getmtime(ref_path)
    except Exception:
        mt = 0
    key = hashlib.md5(f'{ref_path}|{mt}'.encode()).hexdigest()[:10]
    out = f'/tmp/gptsovits_ref_{key}.wav'
    if os.path.exists(out):
        return out
    # If too long → take first 8s (well inside 3-10 range, leaves headroom).
    # If too short → loop with -stream_loop. Re-encode to 24kHz mono pcm_s16le
    # for compatibility.
    if dur > 10.0:
        cmd = ['ffmpeg', '-y', '-i', ref_path, '-t', '8',
               '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out]
    else:
        # short: loop until ≥3.5s
        cmd = ['ffmpeg', '-y', '-stream_loop', '-1', '-i', ref_path, '-t', '4',
               '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if res.returncode != 0 or not os.path.exists(out):
        log(f'gptsovits: ref clamp failed: {res.stderr[-300:]}')
        return ref_path
    log(f'gptsovits: ref clamped {dur:.1f}s → {out}')
    return out


def _api_v2_call(method_url, *, data=None, headers=None, timeout=120):
    """urllib wrapper that surfaces api_v2's error body instead of swallowing
    it into a generic "HTTP Error 400: Bad Request" string. Returns the
    response bytes; raises RuntimeError with the full upstream detail on
    HTTP errors."""
    import urllib.request, urllib.error
    req = urllib.request.Request(method_url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'ignore')[:600]
        except Exception:
            pass
        # GPT-SoVITS api_v2 uses FastAPI which returns {"message":"..."} or
        # plain text. Surface whatever it gave us so the upstream UI can show
        # the real cause (e.g., "ref_audio_path does not exist" / "text empty").
        raise RuntimeError(f'api_v2 {e.code} {e.reason} at {method_url.split("?")[0]} :: {detail or "(empty body)"}')


def synthesize_gptsovits(req):
    import urllib.parse, json, shutil
    url = _engines['gptsovits']
    # Seed our local "already loaded" cache from api_v2's yaml so we don't
    # redundantly /set_*_weights with paths that are already in memory (that
    # reload corrupts model state on macOS — Broken pipe on next /tts).
    _seed_loaded_from_yaml()
    # If caller specified trained-model weight paths (from a voice profile with
    # gptSovits = {sovitsPath, gptPath, version}), load them via api_v2's
    # /set_sovits_weights and /set_gpt_weights endpoints before /tts. Cache so we
    # don't re-load on every request.
    sovits_path = req.get('gptSovitsSovits')
    gpt_path = req.get('gptSovitsGpt')
    if sovits_path and sovits_path != _gptsovits_loaded['sovits']:
        log(f'gptsovits: switching sovits weights → {sovits_path}')
        q = '?weights_path=' + urllib.parse.quote(sovits_path, safe='/')
        _api_v2_call(url + '/set_sovits_weights' + q, timeout=120)
        _gptsovits_loaded['sovits'] = sovits_path
    if gpt_path and gpt_path != _gptsovits_loaded['gpt']:
        log(f'gptsovits: switching gpt weights → {gpt_path}')
        q = '?weights_path=' + urllib.parse.quote(gpt_path, safe='/')
        _api_v2_call(url + '/set_gpt_weights' + q, timeout=120)
        _gptsovits_loaded['gpt'] = gpt_path
    # Clamp ref audio to GPT-SoVITS's required 3-10s window.
    ref_path = _ensure_ref_in_range(req['referenceAudio'])
    target = (req.get('targetText') or '').strip()
    if not target:
        raise ValueError('targetText is empty — nothing to synthesize')
    body = {
        'text': target,
        'text_lang': (req.get('language') or 'zh').split('-')[0],
        'ref_audio_path': ref_path,
        'prompt_text': req.get('referenceText') or '',
        'prompt_lang': (req.get('language') or 'zh').split('-')[0],
        'text_split_method': 'cut5',
        'batch_size': 1,
        'media_type': 'wav',
        'streaming_mode': False,
    }
    data = json.dumps(body).encode('utf-8')
    payload = _api_v2_call(url + '/tts', data=data,
                           headers={'Content-Type': 'application/json'}, timeout=300)
    out = req['outPath']
    with open(out, 'wb') as f:
        f.write(payload)
    return out


SYNTH = {
    'xtts':       (init_xtts,       synthesize_xtts),
    'f5tts':      (init_f5tts,      synthesize_f5tts),
    'voicecraft': (init_voicecraft, synthesize_voicecraft),
    'gptsovits':  (init_gptsovits,  synthesize_gptsovits),
}


def is_available(backend):
    """Whether the backend's deps can be imported at all (without loading model)."""
    try:
        if backend == 'xtts':
            import TTS  # noqa: F401
            return True
        if backend == 'f5tts':
            import f5_tts  # noqa: F401
            return True
        if backend == 'voicecraft':
            return bool(os.environ.get('MEDIASTUDIO_VOICECRAFT_REPO'))
        if backend == 'gptsovits':
            # Always "available" — we proxy to the external api_v2 HTTP server.
            # MediaStudio manages installing GPT-SoVITS + starting api_v2 separately.
            return True
    except Exception:
        return False
    return False


def ensure_loaded(backend):
    """Synchronously load model if not yet loaded. Returns when ready or raises."""
    if backend not in SYNTH:
        raise ValueError(f'unknown backend: {backend}')
    if not is_available(backend):
        raise RuntimeError(f'backend "{backend}" 的相依模組未安裝（請 pip install 對應套件）')
    if backend in _engines:
        return
    lock = _locks.setdefault(backend, Lock())
    with lock:
        if backend in _engines:
            return
        _loading[backend] = True
        _errors.pop(backend, None)
        try:
            SYNTH[backend][0]()
        except Exception as e:
            _errors[backend] = str(e)
            raise
        finally:
            _loading[backend] = False


def health():
    return {
        'ok': True,
        'default': DEFAULT_BACKEND,
        'available': [b for b in SYNTH if is_available(b)],
        'ready': {b: (b in _engines) for b in SYNTH},
        'loading': {b: _loading.get(b, False) for b in SYNTH},
        'models': dict(_models),
        'errors': dict(_errors),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a, **kw):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _read_body(self):
        n = int(self.headers.get('Content-Length', '0') or 0)
        try:
            return json.loads(self.rfile.read(n) or b'{}')
        except Exception as e:
            raise ValueError(f'invalid JSON: {e}')

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, health())
        return self._json(404, {'error': 'not found'})

    def do_POST(self):
        try:
            if self.path == '/load':
                req = self._read_body()
                backend = (req.get('backend') or DEFAULT_BACKEND).lower()
                if backend not in SYNTH:
                    return self._json(400, {'error': f'unknown backend: {backend}'})
                # kick off load in background
                def _go():
                    try: ensure_loaded(backend)
                    except Exception as e: log(f'load {backend} failed: {e}')
                Thread(target=_go, daemon=True).start()
                return self._json(202, {'ok': True, 'loading': backend})

            if self.path == '/generate':
                req = self._read_body()
                for k in ('referenceAudio', 'targetText', 'outPath'):
                    if not req.get(k):
                        return self._json(400, {'error': f'missing field: {k}'})
                backend = (req.get('backend') or DEFAULT_BACKEND).lower()
                if backend not in SYNTH:
                    return self._json(400, {'error': f'unknown backend: {backend}'})
                try:
                    ensure_loaded(backend)
                except Exception as e:
                    return self._json(503, {'error': f'backend {backend} unavailable: {e}'})
                try:
                    out = SYNTH[backend][1](req)
                    size = os.path.getsize(out) if os.path.isfile(out) else 0
                    return self._json(200, {'ok': True, 'path': out, 'size': size, 'backend': backend, 'model': _models.get(backend)})
                except Exception as e:
                    return self._json(500, {'error': str(e), 'trace': traceback.format_exc(limit=2)})

            return self._json(404, {'error': 'not found'})
        except ValueError as e:
            return self._json(400, {'error': str(e)})
        except Exception as e:
            return self._json(500, {'error': str(e)})


def main():
    log(f'voice server starting on http://{HOST}:{PORT}; default backend = {DEFAULT_BACKEND}')
    log(f'available backends: {", ".join(b for b in SYNTH if is_available(b)) or "(none — install Coqui TTS or F5-TTS)"}')
    # Optionally pre-load the default backend so the first request is fast.
    if os.environ.get('MEDIASTUDIO_VOICE_PRELOAD', '1') == '1' and is_available(DEFAULT_BACKEND):
        def _go():
            try: ensure_loaded(DEFAULT_BACKEND); log(f'preloaded {DEFAULT_BACKEND}')
            except Exception as e: log(f'preload {DEFAULT_BACKEND} failed: {e}')
        Thread(target=_go, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    try: srv.serve_forever()
    except KeyboardInterrupt: pass


if __name__ == '__main__':
    main()
