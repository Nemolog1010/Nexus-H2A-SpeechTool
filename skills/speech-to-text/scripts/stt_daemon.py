#!/usr/bin/env python3
"""Warm faster-whisper daemon for pi speech-to-text.

Keeps the model resident in memory so repeated transcriptions skip the model
load (mirrors Hermes' cached-model singleton). Newline-delimited JSON over a
unix socket. Idle-unloads the model to free RAM after a configurable period.

Request  (one JSON object per line):
  {"audio": "/path.wav", "language": "it"|null, "model": "small",
   "device": "cpu", "compute_type": "int8", "cpu_threads": 0,
   "beam_size": 5, "no_speech_threshold": 0.6, "logprob_threshold": -1.0,
   "vad": false}
Response (one JSON object per line):
  {"text": "...", "language": "it", "probability": 0.99}  or  {"error": "..."}
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time


def log(msg: str) -> None:
    print(f"[stt-daemon] {msg}", file=sys.stderr, flush=True)


class ModelCache:
    """Holds one warm WhisperModel, keyed by load parameters, with idle unload."""

    def __init__(self, idle_seconds: int) -> None:
        self._lock = threading.Lock()
        self._model = None
        self._key = None
        self._last = 0.0
        self._idle = idle_seconds
        threading.Thread(target=self._watch, name="idle-unload", daemon=True).start()

    def _watch(self) -> None:
        interval = 30 if self._idle <= 0 else max(5, min(30, self._idle // 4))
        while True:
            time.sleep(interval)
            if self._idle <= 0:
                continue
            with self._lock:
                if self._model is not None and (time.time() - self._last) > self._idle:
                    log("idle unload")
                    self._model = None
                    self._key = None

    def get(self, model: str, device: str, compute_type: str, cpu_threads: int):
        key = (model, device, compute_type, cpu_threads)
        with self._lock:
            if self._model is not None and self._key == key:
                self._last = time.time()
                return self._model

        from faster_whisper import WhisperModel

        kwargs = {"device": device, "compute_type": compute_type, "local_files_only": True}
        if cpu_threads:
            kwargs["cpu_threads"] = cpu_threads
        started = time.time()
        loaded = WhisperModel(model, **kwargs)
        log(f"loaded {model} ({device}/{compute_type}) in {time.time() - started:.2f}s")
        with self._lock:
            self._model = loaded
            self._key = key
            self._last = time.time()
        return loaded

    def touch(self) -> None:
        with self._lock:
            self._last = time.time()


def handle(req: dict, cache: ModelCache) -> dict:
    audio = req.get("audio")
    if not audio or not os.path.isfile(audio):
        return {"error": f"audio file not found: {audio}"}

    model = req.get("model") or "small"
    device = req.get("device") or "cpu"
    compute_type = req.get("compute_type") or "int8"
    cpu_threads = int(req.get("cpu_threads") or 0)
    language = req.get("language") or None
    beam_size = int(req.get("beam_size") or 5)
    no_speech_threshold = float(req.get("no_speech_threshold", 0.6))
    logprob_threshold = float(req.get("logprob_threshold", -1.0))
    vad = bool(req.get("vad", False))

    active = cache.get(model, device, compute_type, cpu_threads)
    segments, info = active.transcribe(
        audio,
        beam_size=beam_size,
        vad_filter=vad,
        language=language,
        condition_on_previous_text=False,
    )
    seg_list = list(segments)

    def is_speech(seg) -> bool:
        return (
            getattr(seg, "no_speech_prob", 0.0) <= no_speech_threshold
            and getattr(seg, "avg_logprob", 0.0) >= logprob_threshold
        )

    if seg_list and not any(is_speech(seg) for seg in seg_list):
        text = ""
    else:
        text = "".join(seg.text for seg in seg_list).strip()

    cache.touch()
    probability = getattr(info, "language_probability", None)
    if probability is None:
        probability = getattr(info, "probability", None)
    return {"text": text, "language": getattr(info, "language", None), "probability": probability}


def serve_conn(conn: socket.socket, cache: ModelCache) -> None:
    try:
        stream = conn.makefile("rwb")
        while True:
            line = stream.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                response = handle(json.loads(line), cache)
            except Exception as exc:  # noqa: BLE001 - report to client
                response = {"error": str(exc)}
            stream.write((json.dumps(response, ensure_ascii=False) + "\n").encode())
            stream.flush()
    except Exception as exc:  # noqa: BLE001
        log(f"connection error: {exc}")
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Warm faster-whisper daemon.")
    ap.add_argument("--socket", required=True)
    ap.add_argument("--model", default="base")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--cpu-threads", type=int, default=0)
    ap.add_argument("--idle", type=int, default=int(os.environ.get("STT_IDLE_SECONDS", "600")))
    args = ap.parse_args()

    if os.path.exists(args.socket):
        try:
            os.unlink(args.socket)
        except OSError:
            pass

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    os.chmod(args.socket, 0o600)
    server.listen(8)

    cache = ModelCache(args.idle)
    try:
        cache.get(args.model, args.device, args.compute_type, args.cpu_threads)
    except Exception as exc:  # noqa: BLE001 - keep serving, retry per request
        log(f"eager load failed: {exc}")

    log(f"listening on {args.socket} (idle unload {args.idle}s)")
    while True:
        try:
            conn, _ = server.accept()
        except OSError:
            break
        threading.Thread(target=serve_conn, args=(conn, cache), daemon=True).start()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        pass
