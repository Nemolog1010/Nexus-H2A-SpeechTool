---
name: text-to-speech
description: Speak text aloud or generate audio files in Italian, English, or Chinese. Use when the user asks to read something out loud, "dimmi a voce", "leggi ad alta voce", "pronuncia", "text to speech", "TTS", "voce", or wants an .mp3 of text.
---

# Text to speech (it / en / zh)

Synthesize speech with `edge-tts` and play it through the system audio.
Supports **Italian**, **English**, and **Chinese** (auto-detected, or forced with `-l`).

## Usage

Run the bundled script (path is relative to this skill directory):

```bash
scripts/say.sh "Ciao, questa è una prova."          # auto-detects Italian
scripts/say.sh -l en "Hello, this is a test."
scripts/say.sh -l zh "你好，这是一个测试。"
echo "Testo lungo..." | scripts/say.sh -l it
scripts/say.sh -n "Only save, do not play"          # prints path of the .mp3
```

Options: `-l it|en|zh`, `-v VOICE`, `-r RATE` (e.g. `+15%`, `-10%`), `-n` (no play), `-o DIR`.

The last line of output is the audio file path. Report it to the user when relevant.

## Default voices

| Lang | Voice |
|---|---|
| it | `it-IT-ElsaNeural` |
| en | `en-US-AriaNeural` |
| zh | `zh-CN-XiaoxiaoNeural` |

Override per call with `-v`, or permanently with `TTS_VOICE_IT`, `TTS_VOICE_EN`, `TTS_VOICE_ZH`.

## Notes

- `edge-tts` is resolved from `EDGE_TTS_BIN`, then `PATH`, then the Hermes venv
  (`~/.hermes/hermes-agent/venv/bin/edge-tts`), then `uvx edge-tts`.
- Audio plays via `ffplay` (or `pw-play` / `paplay` / `cvlc`). Override with `TTS_PLAYER`.
- Output files go to `~/.pi/agent/cache/tts/` unless `-o` is given.
- List available voices: `edge-tts --list-voices` (or the Hermes venv binary).
- Prefer `-n` when the user only wants a file (e.g. to attach/send), and play
  otherwise. Keep spoken text plain: strip Markdown, code blocks, and URLs first.
