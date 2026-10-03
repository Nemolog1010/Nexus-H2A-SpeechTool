---
name: speech-to-text
description: Transcribe audio files or microphone recordings to text in Italian, English, or Chinese, and dictate hands-free with a wake word. Use when the user asks to transcribe, "trascrivi", "che cosa ho detto", "converti audio in testo", "speech to text", "STT", "wake word", "hands-free", or provides an audio/voice recording.
---

# Speech to text (it / en / zh)

Transcribe audio with **faster-whisper** locally (default), or an OpenAI-compatible
cloud API. Handles any format `ffmpeg`/PyAV can decode (mp3, wav, m4a, ogg…).

## Usage

Run the bundled script relative to this skill directory:

```bash
scripts/transcribe.sh file.m4a               # auto-detect language
scripts/transcribe.sh -l it voce.mp3         # force Italian (~2x faster)
scripts/transcribe.sh -l en -m small audio.wav  # higher accuracy
scripts/transcribe.sh --json audio.wav       # {"text":..,"language":..,"probability":..}
scripts/transcribe.sh -r 5                   # record 5 s from the mic, then transcribe
scripts/transcribe.sh --warmup               # start the daemon + preload the model
```

Options: `-l it|en|zh|auto`, `-m MODEL`, `-p auto|local|openai|groq`, `-o FILE`, `-r SECONDS`, `--warmup`, `--json`.

## Warm daemon (why it is fast)

A long-lived **faster-whisper daemon** keeps the model in memory (like Hermes'
cached-model singleton), so repeated transcriptions skip the model load. The
script starts it on demand; the pi extension talks to it directly over a unix
socket (no python/ffmpeg process per request).

- Socket: `${XDG_RUNTIME_DIR:-/tmp}/pi-stt-$(id -u).sock` (`STT_SOCKET` to override).
- Idle unload after `STT_IDLE_SECONDS` (default 600) to free RAM.
- `STT_NO_DAEMON=1` uses a cold one-shot process instead.

## Wake word (hands-free start/stop)

`scripts/wake_daemon.py` owns the microphone and runs a streaming
**sherpa-onnx keyword spotter** (English, open-vocabulary: any typed phrase is
BPE-tokenized at runtime, no training). The pi extension uses it so you can
dictate without touching the keyboard:

- the **start phrase** (default `hey hermes`) begins a recording and streams
  live audio levels to the editor (the “volume graph”);
- the **stop phrase** (default `stop recording`) ends it, and the transcript is
  inserted into the editor.

```bash
# run standalone (needs a python with sherpa_onnx + sounddevice + numpy)
scripts/wake_daemon.py --socket /tmp/pi-wake.sock \
  --start-phrase "hey hermes" --stop-phrase "stop recording" --sensitivity 0.5
```

The KWS model is shared with Hermes: by default it uses
`~/.hermes/cache/wakewords/` if present, otherwise downloads it once (~13 MB) to
`~/.cache/pi-wakewords/`. Override with `WAKE_MODEL_DIR`.

In the pi UI use `/wake on|off|start|stop|status` or press `ctrl+shift+w` to
toggle listening. The extension also shows a live **volume graph** above the
editor while recording (any path: `ctrl+b`, `ctrl+shift+l`, `/listen`, or wake
word). Configuration: `WAKE_START_PHRASE`, `WAKE_STOP_PHRASE`,
`WAKE_SENSITIVITY`, `WAKE_INPUT_DEVICE`, `WAKE_PYTHON`, `WAKE_SOCKET`,
`WAKE_MAX_SECONDS`, `WAKE_IDLE_SECONDS`, and `WAKE_ENABLED=1` (auto-start with
the session).

## Performance notes

- **Always pass `-l`/`lang` when you know the language**: forcing it skips the
  language-detection pass (~2x faster: e.g. 0.7 s vs 1.8 s for a short clip).
- Default model is **`base`** (fast, good accuracy for voice commands). Use
  `small`/`medium` for hard audio. `tiny` is fastest.
- **`HF_HUB_OFFLINE=1` is set automatically**: without it, HuggingFace does a
  network check on load that can hang for minutes on some networks/VPNs.

## Providers

| Provider | Model default | Requires |
|---|---|---|
| `local` | `base` (faster-whisper) | `faster_whisper` importable |
| `openai` | `whisper-1` | `OPENAI_API_KEY` or `VOICE_TOOLS_OPENAI_KEY` |
| `groq` | `whisper-large-v3-turbo` | `GROQ_API_KEY` |

`auto` picks local when available, then groq, then openai.

## Other notes

- Local python resolved via `STT_PYTHON`, then the Hermes venv
  (`~/.hermes/hermes-agent/venv/bin/python`), then `python3`.
- Tuning: `STT_MODEL`, `STT_DEVICE` (cpu/cuda), `STT_COMPUTE_TYPE` (int8/float16),
  `STT_CPU_THREADS`, `STT_VAD=1` (Silero VAD, ~30x slower here: avoid).
- Recording uses `arecord` (preferred) or `pw-record`; default mic via PipeWire.
- Silent clips are dropped via `no_speech_prob`/`avg_logprob` gating, so no
  Whisper hallucinations.
- Whisper supports many languages, not just it/en/zh — pass the code with `-l`.
