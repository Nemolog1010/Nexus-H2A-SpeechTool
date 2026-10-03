# Nexus-H2A SpeechTool

Voice suite for [pi](https://pi.dev): **text-to-speech** and **speech-to-text**
in Italian, English, and Chinese. Distributed as a *pi package* (extensions +
skills).

- **TTS** — speech synthesis with `edge-tts` and system playback.
- **STT** — transcription with `faster-whisper` kept **warm** in a daemon (model
  in RAM), plus an optional cloud fallback.
- **Wake word** — hands-free dictation: a start phrase begins recording, a stop
  phrase ends it (streaming sherpa-onnx keyword spotter).
- **Live level meter** — a small audio-volume graph shown above the editor while
  recording.

---

## Install

```bash
# from a local path
pi install /path/to/Nexus-H2A-SpeechTool

# or from git
pi install git:github.com/Nemolog1010/Nexus-H2A-SpeechTool
```

Then restart pi (or run `/reload` in an open session). Verify with `/hotkeys`
and `/mcp`.

### Requirements

| Component | Requirement |
|---|---|
| TTS | `edge-tts` (or the Hermes venv), `ffplay` / `pw-play` / `paplay` / `cvlc` |
| STT (local) | `faster-whisper` (or the Hermes venv), `ffmpeg`, `arecord` or `pw-record` |
| STT (cloud, optional) | `OPENAI_API_KEY` / `VOICE_TOOLS_OPENAI_KEY` or `GROQ_API_KEY` |
| Wake word (optional) | a python with `sherpa-onnx` + `sounddevice` + `numpy` (the Hermes venv) |

The local python is resolved in order: `STT_PYTHON` → Hermes venv
(`~/.hermes/hermes-agent/venv/bin/python`) → `python3`.

---

## Usage — Text to Speech

| Interface | Command |
|---|---|
| Native tool | `speak(text, lang?, voice?, rate?, play?)` |
| Slash command | `/say [it\|en\|zh] <text>` |
| Shortcut | `ctrl+shift+r` — reads the last reply; press again to **stop** |
| Script | `skills/text-to-speech/scripts/say.sh` |

```bash
say.sh "Ciao, questa è una prova."      # auto-detect IT
say.sh -l en "Hello world"
say.sh -l zh "你好，这是一个测试"
say.sh -n "only generate the file"       # prints the .mp3 path
```

Default voices: `it-IT-ElsaNeural`, `en-US-AriaNeural`, `zh-CN-XiaoxiaoNeural`
(override with `-v` or `TTS_VOICE_IT/EN/ZH`).

---

## Usage — Speech to Text

| Interface | Command |
|---|---|
| Native tool | `transcribe(audio, lang?, model?, provider?, output?)` |
| Native tool | `listen(seconds?, lang?, model?, provider?)` |
| Slash command | `/listen [seconds] [it\|en\|zh]` |
| Shortcut | `ctrl+b` — start/stop recording and insert the transcript |
| Shortcut | `ctrl+shift+l` — record 5 s and insert the transcript |
| Shortcut | `ctrl+shift+w` — toggle the **wake word** |
| Slash command | `/wake on\|off\|start\|stop\|status` — hands-free dictation |
| Script | `skills/speech-to-text/scripts/transcribe.sh` |

```bash
transcribe.sh file.m4a                    # auto-detect language
transcribe.sh -l it voce.mp3              # force Italian (~2x faster)
transcribe.sh -l en -m small audio.wav    # higher accuracy
transcribe.sh --json audio.wav            # {"text":...,"language":...,"probability":...}
transcribe.sh -r 5                        # record 5 s from the mic, then transcribe
transcribe.sh --warmup                    # start the daemon and preload the model
```

While recording, a **volume meter** (a small scrolling bar graph) is shown next
to the editor, like in Hermes.

### Wake word (hands-free dictation)

An optional listener owns the microphone and uses a **sherpa-onnx keyword
spotter** (open-vocabulary: any phrase, tokenized at runtime) to start and stop
dictation by voice:

- **start phrase** (default `hey hermes`) → starts recording and shows the
  volume meter;
- **stop phrase** (default `stop recording`) → ends recording and inserts the
  transcript into the editor.

```bash
# in pi
/wake on                 # enable listening (or ctrl+shift+w)
/wake status             # show state and active phrases
/wake off                # disable

# standalone
skills/speech-to-text/scripts/wake_daemon.py \
  --socket /tmp/pi-wake.sock \
  --start-phrase "hey hermes" --stop-phrase "stop recording"
```

The KWS model is shared with Hermes: it uses `~/.hermes/cache/wakewords/` when
present, otherwise downloads it once (~13 MB) to `~/.cache/pi-wakewords/`.
Phrases, sensitivity, and device are configured with `WAKE_*` (see the table
below). Note: if Hermes also has its wake word enabled, use **different**
phrases for the two, otherwise both will react to the same phrase.

Privacy: the wake listener is **opt-in** and only arms the mic after `/wake on`
(or `WAKE_ENABLED=1`). Everything runs on-device; no audio leaves the machine.

---

## Architecture

```
                              ┌──────────────────────────┐
   extension  ── unix socket ─▶│ stt_daemon.py            │
   (node)       JSON lines     │  faster-whisper in RAM   │
      │                        │  idle-unload (10 min)    │
      │  fallback              └──────────────────────────┘
      ▼
 transcribe.sh ───────────────▶ daemon (python client) ─▶ cloud (openai/groq)

                              ┌──────────────────────────┐
   extension  ── unix socket ─▶│ wake_daemon.py           │
   (node)       JSON events     │  sherpa-onnx KWS (mic)  │
                               │  start/stop + RMS level │
                               └──────────────────────────┘
```

- The daemon keeps the model in memory (like Hermes' *cached-model singleton*),
  so repeated transcriptions do not reload the model.
- The extension talks **directly to the daemon** over a Unix socket: no
  python/ffmpeg process per request on the interactive path.
- The wake daemon is the single owner of the microphone (explicit recordings
  pause it first), so there is never more than one input stream per device.
- Sockets: `${XDG_RUNTIME_DIR:-/tmp}/pi-stt-$(id -u).sock` and
  `${XDG_RUNTIME_DIR:-/tmp}/pi-wake-$(id -u).sock`.

---

## Performance

- **`HF_HUB_OFFLINE=1`** is set automatically: without it, HuggingFace does a
  network check on load that can **hang for minutes** on some networks/VPNs.
- Default model **`base`**: fast and good enough for voice commands. Use
  `small`/`medium` for difficult audio.
- **Force the language** when you know it: it skips the language-detection pass
  (~2×).
- `STT_VAD=1` enables the Silero VAD, but it is ~30× slower here: **avoid**.
- The wake daemon unloads the mic when idle and exits after `WAKE_IDLE_SECONDS`
  with no client, so it never leaves an orphan process holding the microphone.

---

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `STT_MODEL` | `base` | faster-whisper model |
| `STT_LANG` | auto | Default language |
| `STT_PYTHON` | auto | Interpreter with `faster_whisper` |
| `STT_DEVICE` | `cpu` | `cpu` or `cuda` |
| `STT_COMPUTE_TYPE` | `int8` | `int8`, `float16`, … |
| `STT_CPU_THREADS` | auto | CPU threads |
| `STT_IDLE_SECONDS` | `600` | Model idle-unload |
| `STT_SOCKET` | runtime dir | STT daemon socket path |
| `STT_NO_DAEMON` | — | `1` = cold one-shot process |
| `STT_SILENCE_DB` | `-50` | Silence threshold for recordings |
| `WAKE_START_PHRASE` | `hey hermes` | Wake word start phrase |
| `WAKE_STOP_PHRASE` | `stop recording` | Wake word stop phrase |
| `WAKE_SENSITIVITY` | `0.5` | Sensitivity 0–1 (higher = stricter) |
| `WAKE_INPUT_DEVICE` | auto | Input device (`sounddevice`/PortAudio) |
| `WAKE_PYTHON` | auto | Interpreter with `sherpa_onnx` + `sounddevice` |
| `WAKE_MODEL_DIR` | Hermes cache | KWS model directory |
| `WAKE_SOCKET` | runtime dir | Wake daemon socket path |
| `WAKE_ENABLED` | — | `1` = enable the wake word at session start |
| `WAKE_MAX_SECONDS` | `120` | Maximum length of a wake recording |
| `WAKE_IDLE_SECONDS` | `300` | Daemon exits if no client connects for N s |
| `TTS_VOICE_IT/EN/ZH` | edge voices | Voice per language |
| `TTS_PLAYER` | auto | Audio player |
| `NEXUS_H2A_HOME` | — | Package root (if moved) |

---

## Repository layout

```
Nexus-H2A-SpeechTool/
├── package.json
├── extensions/
│   ├── text-to-speech.ts
│   └── speech-to-text.ts
├── skills/
│   ├── text-to-speech/
│   │   ├── SKILL.md
│   │   └── scripts/say.sh
│   └── speech-to-text/
│       ├── SKILL.md
│       └── scripts/
│           ├── transcribe.sh
│           ├── transcribe.py
│           ├── stt_daemon.py
│           ├── stt_client.py
│           └── wake_daemon.py
├── LICENSE
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
