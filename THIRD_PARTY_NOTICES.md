# Third-party notices

Nexus-H2A SpeechTool is released under the **MIT License** (see [LICENSE](LICENSE)).

The components below are **installed separately** and are **not bundled** in this
repository. They are used at runtime by invoking external programs or importing
packages installed in the user's environment. Each remains under its own license,
which applies to that component's code.

## Runtime dependencies

| Component | License | How it is used |
|---|---|---|
| [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | MIT | Host runtime and TUI |
| [TypeBox](https://github.com/sinclairzx81/typebox) | MIT | Tool parameter schemas |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT | Local speech-to-text |
| [sounddevice](https://github.com/spatialaudio/python-sounddevice) | MIT | Microphone capture (wake word) |
| [NumPy](https://numpy.org/) | BSD-3-Clause | Audio math (level, KWS) |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | Streaming keyword spotter (wake word) |
| [edge-tts](https://github.com/rany2/edge-tts) | LGPL-3.0 | Text-to-speech; invoked as a separate program, not linked into this project |
| [FFmpeg](https://ffmpeg.org/) | LGPL-2.1+/GPL (build-dependent) | Audio decode/convert; invoked as a separate program |

Optional cloud speech-to-text uses the OpenAI or Groq APIs only when you configure
the corresponding API keys; their own terms of service apply.

## Models and data

- The **sherpa-onnx KWS model** (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`)
  is downloaded on demand from the upstream k2-fsa release and is licensed
  **Apache-2.0**. It is trained on the **GigaSpeech** dataset; review the dataset's
  terms before redistributing the model.
- The **`hey_hermes` openWakeWord model** is provided by the user's own Hermes
  installation and is **not** part of this repository.

## External services

`edge-tts` synthesizes audio through Microsoft Edge's online "Read Aloud"
service. Use of that service is subject to Microsoft's terms; this project only
wraps the `edge-tts` client.

---

If you redistribute this project together with any of the components above,
keep their license texts and notices and comply with their terms (in particular
Apache-2.0 attribution for the KWS model and LGPL-3.0 for `edge-tts`).
