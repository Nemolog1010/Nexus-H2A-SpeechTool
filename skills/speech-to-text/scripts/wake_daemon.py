#!/usr/bin/env python3
"""Wake-word listener daemon for pi speech-to-text.

Owns the microphone and runs a streaming sherpa-onnx keyword spotter so the
user can start/stop dictation hands-free:

    <start phrase>   -> begin recording, stream live audio levels
    <stop phrase>    -> finish recording, hand the WAV back to pi

One process owns the mic (two concurrent input streams on one device are
unreliable), so recording happens here too and the pi extension just renders
the level meter and transcribes the resulting file.

Newline-delimited JSON over a unix socket (one client at a time: the pi
extension). The daemon exits when its client disconnects so a reload never
leaves a zombie holding the microphone.

Events  (daemon -> client):
  {"event":"ready","start":"hey hermes","stop":"stop recording"}
  {"event":"state","state":"listen"|"record"|"paused"}
  {"event":"start"}
  {"event":"level","rms":1234,"elapsed":1.2}
  {"event":"stop","audio":"/tmp/pi-wake-*.wav","duration":3.4,"reason":"keyword"}
  {"event":"error","message":"..."}

Commands (client -> daemon):
  {"cmd":"pause"}   release the mic (used while an explicit recording runs)
  {"cmd":"resume"}  re-arm the listener
  {"cmd":"record"}  start recording manually (no wake word needed)
  {"cmd":"stop"}    stop the current recording
  {"cmd":"status"}  re-emit the current state
  {"cmd":"quit"}    shut down
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import tarfile
import threading
import time
import urllib.request
import wave
from pathlib import Path
from typing import Any, Optional

SAMPLE_RATE = 16000
FRAME = 1280  # 80 ms at 16 kHz — what the streaming zipformer expects.
LEVEL_INTERVAL = 0.05  # Emit at most ~20 level events/s.
MAX_SECONDS_DEFAULT = 120.0
# When the stop word fires, the phrase itself is already in the buffer. Drop the
# tail (~the phrase duration) so it doesn't show up in the transcript.
STOP_TRIM_SECONDS = 0.9

# Same open-vocabulary KWS model Hermes uses (English, ~13 MB, downloaded once).
SHERPA_KWS_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"
    "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2"
)
SHERPA_KWS_DIR = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"

START_LABEL = "START"
STOP_LABEL = "STOP"


def log(msg: str) -> None:
    print(f"[wake-daemon] {msg}", file=sys.stderr, flush=True)


def default_model_root() -> Path:
    """Where the sherpa KWS model lives: WAKE_MODEL_DIR, else the Hermes cache
    (reuse the copy Hermes already downloaded), else an XDG cache dir."""
    env = os.environ.get("WAKE_MODEL_DIR")
    if env:
        return Path(env).expanduser()
    hermes = Path.home() / ".hermes" / "cache" / "wakewords"
    if (hermes / SHERPA_KWS_DIR / "tokens.txt").exists():
        return hermes
    cache = os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache")
    return Path(cache) / "pi-wakewords"


def ensure_model(root: Path) -> Path:
    """Return the unpacked model dir, downloading it once if needed. ``root``
    may be either the model directory itself or a parent that contains it."""
    if (root / "tokens.txt").exists():
        return root
    target = root / SHERPA_KWS_DIR
    if (target / "tokens.txt").exists():
        return target
    root.mkdir(parents=True, exist_ok=True)
    archive = root / f"{SHERPA_KWS_DIR}.tar.bz2"
    log("downloading sherpa KWS model (one-time, ~13 MB)…")
    urllib.request.urlretrieve(SHERPA_KWS_URL, archive)  # noqa: S310
    with tarfile.open(archive, "r:bz2") as tf:
        tf.extractall(root, filter="data")
    archive.unlink(missing_ok=True)
    if not (target / "tokens.txt").exists():
        raise RuntimeError(f"sherpa KWS model unpack failed: {target}")
    return target


def _model_file(model_dir: Path, part: str) -> str:
    hits = sorted(model_dir.glob(f"{part}-*[!8].onnx"))
    if not hits:
        raise RuntimeError(f"sherpa KWS model file missing: {model_dir}/{part}-*[!8].onnx")
    return str(hits[0])


def build_spotter(model_dir: Path, start_phrase: str, stop_phrase: str, sensitivity: float):
    """Open-vocabulary keyword spotter with the start and stop phrases."""
    import sherpa_onnx
    from sherpa_onnx import text2token

    phrases = {START_LABEL: start_phrase.upper().strip(), STOP_LABEL: stop_phrase.upper().strip()}
    tokens = text2token(
        list(phrases.values()),
        tokens=str(model_dir / "tokens.txt"),
        tokens_type="bpe",
        bpe_model=str(model_dir / "bpe.model"),
    )
    keywords_file = model_dir / f".pi-wake-keywords-{os.getpid()}.txt"
    with keywords_file.open("w", encoding="utf-8") as fh:
        for label, toks in zip(phrases, tokens):
            fh.write(" ".join(toks) + f" @{label}\n")

    # Shared sensitivity 0..1 -> sherpa keywords_threshold (Hermes' mapping).
    threshold = 0.05 + 0.4 * sensitivity
    spotter = sherpa_onnx.KeywordSpotter(
        tokens=str(model_dir / "tokens.txt"),
        encoder=_model_file(model_dir, "encoder"),
        decoder=_model_file(model_dir, "decoder"),
        joiner=_model_file(model_dir, "joiner"),
        keywords_file=str(keywords_file),
        keywords_threshold=threshold,
        num_threads=1,
    )
    return spotter, keywords_file


class WakeDaemon:
    """State machine: listen for the start word, record, listen for the stop word."""

    def __init__(
        self,
        spotter,
        max_seconds: float,
        input_device: Optional[Any],
        start_phrase: str,
        stop_phrase: str,
    ) -> None:
        self._spotter = spotter
        self._max_seconds = max_seconds
        self._device = input_device
        self._start_phrase = start_phrase
        self._stop_phrase = stop_phrase

        self._lock = threading.RLock()
        self._state = "paused"  # paused | listen | record
        self._stream = self._spotter.create_stream()
        self._pcm: list[bytes] = []
        self._record_start = 0.0
        self._last_level = 0.0
        self._pcm_bytes = 0

        self._client: Optional[socket.socket] = None
        self._send_lock = threading.Lock()
        self._capture: Optional["MicCapture"] = None

    # -- client plumbing -------------------------------------------------
    def attach(self, conn: socket.socket) -> None:
        with self._lock:
            self._client = conn
        # Do NOT arm capture here: a liveness probe connects and disconnects
        # immediately, and must not touch the microphone. The client arms with
        # {"cmd":"resume"} once it is ready to receive events.
        self._send({"event": "ready", "start": self._start_phrase, "stop": self._stop_phrase})

    def detach(self) -> None:
        self.pause()
        with self._lock:
            self._client = None

    def _send(self, payload: dict) -> None:
        with self._lock:
            conn = self._client
        if conn is None:
            return
        line = (json.dumps(payload) + "\n").encode("utf-8")
        try:
            with self._send_lock:
                conn.sendall(line)
        except OSError:
            pass

    # -- capture control -------------------------------------------------
    def resume(self) -> None:
        with self._lock:
            if self._state == "record":
                return
            self._state = "listen"
            self._reset_stream()
        self._start_capture()
        self._send({"event": "state", "state": "listen"})

    def pause(self) -> None:
        self._stop_capture()
        with self._lock:
            self._state = "paused"
        self._send({"event": "state", "state": "paused"})

    def _start_capture(self) -> None:
        if self._capture is not None:
            return
        self._capture = MicCapture(self._on_frame, self._device, self._on_capture_error)
        self._capture.start()

    def _on_capture_error(self, message: str) -> None:
        log(f"capture failed: {message}")
        self._send({"event": "error", "message": f"microphone unavailable: {message}"})

    def _stop_capture(self) -> None:
        cap = self._capture
        self._capture = None
        if cap is not None:
            cap.stop()

    def _reset_stream(self) -> None:
        with self._lock:
            try:
                self._stream = self._spotter.create_stream()
            except Exception:
                pass

    # -- state transitions ----------------------------------------------
    def _begin_record(self, reason: str = "keyword") -> None:
        with self._lock:
            if self._state == "record":
                return
            self._state = "record"
            self._pcm = []
            self._pcm_bytes = 0
            self._record_start = time.monotonic()
            self._last_level = 0.0
            self._reset_stream()
        self._send({"event": "start", "reason": reason})

    def _finish_record(self, reason: str) -> None:
        with self._lock:
            if self._state != "record":
                return
            self._state = "listen"
            pcm = b"".join(self._pcm)
            self._pcm = []
            duration = time.monotonic() - self._record_start
            self._reset_stream()
        # The stop word is part of the buffer; trim its tail before transcribing.
        if reason == "keyword":
            trim = int(STOP_TRIM_SECONDS * SAMPLE_RATE) * 2
            if len(pcm) > trim * 2:
                pcm = pcm[:-trim]
        path = ""
        if pcm:
            path = self._write_wav(pcm)
        self._send({"event": "stop", "audio": path, "duration": round(duration, 2), "reason": reason})
        # Stay armed for the next utterance.
        self._send({"event": "state", "state": "listen"})

    @staticmethod
    def _write_wav(pcm: bytes) -> str:
        tmp = os.environ.get("TMPDIR") or "/tmp"
        path = os.path.join(tmp, f"pi-wake-{int(time.time() * 1000)}.wav")
        with wave.open(path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(pcm)
        return path

    # -- audio callback (runs on the capture thread) ---------------------
    def _on_frame(self, data) -> None:
        import numpy as np

        frame = data[:, 0] if getattr(data, "ndim", 1) > 1 else data
        fire = self._decode(frame)
        with self._lock:
            state = self._state

        if fire == START_LABEL and state == "listen":
            self._begin_record()
        elif fire == STOP_LABEL and state == "record":
            self._finish_record("keyword")

        with self._lock:
            state = self._state
        if state != "record":
            return

        raw = frame.astype(np.int16).tobytes()
        now = time.monotonic()
        rms = int(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))
        with self._lock:
            self._pcm.append(raw)
            self._pcm_bytes += len(raw)
            elapsed = now - self._record_start
            emit = (now - self._last_level) >= LEVEL_INTERVAL
            if emit:
                self._last_level = now
            too_long = elapsed >= self._max_seconds
        if emit:
            self._send({"event": "level", "rms": rms, "elapsed": round(elapsed, 2)})
        if too_long:
            self._finish_record("max")

    def _decode(self, frame) -> Optional[str]:
        """Feed one frame to the spotter, returning START/STOP when it fires."""
        import numpy as np

        try:
            self._stream.accept_waveform(SAMPLE_RATE, np.asarray(frame, dtype=np.float32) / 32768.0)
            while self._spotter.is_ready(self._stream):
                self._spotter.decode_stream(self._stream)
                result = self._spotter.get_result(self._stream)
                if result:
                    self._spotter.reset_stream(self._stream)
                    return str(result).strip().upper()
        except Exception as exc:  # keep the listener alive on a transient decode error
            log(f"spotter error: {exc}")
        return None

    # -- commands --------------------------------------------------------
    def command(self, cmd: dict) -> bool:
        name = str(cmd.get("cmd") or "")
        if name == "pause":
            self.pause()
        elif name == "resume":
            self.resume()
        elif name == "record":
            self._begin_record("manual")
        elif name == "stop":
            self._finish_record("manual")
        elif name == "status":
            with self._lock:
                state = self._state
            self._send({"event": "state", "state": state})
        elif name == "quit":
            self.pause()
            return False
        return True

    def shutdown(self) -> None:
        self._stop_capture()
        with self._lock:
            self._state = "paused"
            self._client = None


class MicCapture(threading.Thread):
    """Blocking sounddevice reader; pushes int16 frames to ``on_frame``."""

    def __init__(self, on_frame, device, on_error) -> None:
        super().__init__(daemon=True, name="wake-capture")
        self._on_frame = on_frame
        self._device = device
        self._on_error = on_error
        self._stop_evt = threading.Event()

    def run(self) -> None:
        try:
            import sounddevice as sd

            with sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="int16",
                blocksize=FRAME,
                device=self._device,
            ) as stream:
                while not self._stop_evt.is_set():
                    data, _overflowed = stream.read(FRAME)
                    self._on_frame(data)
        except Exception as exc:  # pragma: no cover - device dependent
            self._on_error(str(exc))

    def stop(self) -> None:
        self._stop_evt.set()
        self.join(timeout=1.0)


def serve(socket_path: str, daemon: WakeDaemon, idle_seconds: float = 300.0) -> None:
    path = Path(socket_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(path))
    os.chmod(path, 0o600)
    server.listen(1)
    server.settimeout(1.0)
    log(f"listening on {path}")

    last_client = time.monotonic()
    try:
        while True:
            try:
                conn, _ = server.accept()
            except socket.timeout:
                # No client for a while (e.g. pi was killed): exit so we never
                # leave an orphan process behind.
                if idle_seconds > 0 and (time.monotonic() - last_client) > idle_seconds:
                    log("idle timeout, exiting")
                    break
                continue
            last_client = time.monotonic()
            daemon.attach(conn)
            buffer = b""
            keep_running = True
            try:
                while keep_running:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        try:
                            cmd = json.loads(line.decode("utf-8"))
                        except json.JSONDecodeError:
                            continue
                        if not daemon.command(cmd):
                            keep_running = False
                            break
            except OSError:
                pass
            finally:
                daemon.detach()
                conn.close()
            if not keep_running:
                break
    finally:
        daemon.shutdown()
        server.close()
        path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="pi wake-word listener daemon")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--start-phrase", default=os.environ.get("WAKE_START_PHRASE", "hey hermes"))
    parser.add_argument("--stop-phrase", default=os.environ.get("WAKE_STOP_PHRASE", "stop recording"))
    parser.add_argument("--sensitivity", type=float, default=float(os.environ.get("WAKE_SENSITIVITY", "0.5")))
    parser.add_argument("--max-seconds", type=float, default=float(os.environ.get("WAKE_MAX_SECONDS", MAX_SECONDS_DEFAULT)))
    parser.add_argument("--model-dir", default=os.environ.get("WAKE_MODEL_DIR", ""))
    parser.add_argument("--input-device", default=os.environ.get("WAKE_INPUT_DEVICE", ""))
    parser.add_argument("--idle", type=float, default=float(os.environ.get("WAKE_IDLE_SECONDS", "300")))
    args = parser.parse_args()

    try:
        model_root = Path(args.model_dir).expanduser() if args.model_dir else default_model_root()
        model_dir = ensure_model(model_root)
        start_phrase = (args.start_phrase or "hey hermes").strip()
        stop_phrase = (args.stop_phrase or "stop recording").strip()
        spotter, _keywords = build_spotter(model_dir, start_phrase, stop_phrase, args.sensitivity)
    except Exception as exc:
        log(f"init failed: {exc}")
        return 1

    device: Optional[Any] = None
    if args.input_device:
        device = int(args.input_device) if args.input_device.isdigit() else args.input_device

    daemon = WakeDaemon(spotter, args.max_seconds, device, start_phrase, stop_phrase)
    # Fail fast and clearly if the mic can't be opened.
    try:
        import sounddevice  # noqa: F401
    except Exception as exc:
        log(f"sounddevice unavailable: {exc}")
        return 1

    serve(args.socket, daemon, args.idle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
