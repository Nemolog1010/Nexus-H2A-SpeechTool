# Nexus-H2A SpeechTool

Suite vocale per [pi](https://pi.dev): **text-to-speech** e **speech-to-text** in
italiano, inglese e cinese. Distribuita come *pi package* (estensioni + skill).

- **TTS** — sintesi vocale con `edge-tts` e riproduzione di sistema.
- **STT** — trascrizione con `faster-whisper` tenuto **caldo** in un daemon
  (modello in RAM), più fallback cloud opzionale.

---

## Installazione

```bash
# da percorso locale
pi install /path/to/Nexus-H2A-SpeechTool

# oppure da git
pi install git:github.com/Nemolog1010/Nexus-H2A-SpeechTool
```

Poi riavvia pi (o `/reload` in una sessione aperta). Verifica con `/hotkeys` e `/mcp`.

### Requisiti

| Componente | Requisito |
|---|---|
| TTS | `edge-tts` (o venv Hermes), `ffplay` / `pw-play` / `paplay` / `cvlc` |
| STT (locale) | `faster-whisper` (o venv Hermes), `ffmpeg`, `arecord` o `pw-record` |
| STT (cloud, opzionale) | `OPENAI_API_KEY` / `VOICE_TOOLS_OPENAI_KEY` oppure `GROQ_API_KEY` |

Il python locale viene risolto in ordine: `STT_PYTHON` → venv Hermes
(`~/.hermes/hermes-agent/venv/bin/python`) → `python3`.

---

## Uso — Text to Speech

| Interfaccia | Comando |
|---|---|
| Tool nativo | `speak(text, lang?, voice?, rate?, play?)` |
| Slash command | `/say [it\|en\|zh] <testo>` |
| Tasto rapido | `ctrl+shift+r` — legge l'ultima risposta; premuto di nuovo **ferma** |
| Script | `skills/text-to-speech/scripts/say.sh` |

```bash
say.sh "Ciao, questa è una prova."      # auto-detect IT
say.sh -l en "Hello world"
say.sh -l zh "你好，这是一个测试"
say.sh -n "solo genera il file"          # stampa il percorso .mp3
```

Voci di default: `it-IT-ElsaNeural`, `en-US-AriaNeural`, `zh-CN-XiaoxiaoNeural`
(override con `-v` o `TTS_VOICE_IT/EN/ZH`).

---

## Uso — Speech to Text

| Interfaccia | Comando |
|---|---|
| Tool nativo | `transcribe(audio, lang?, model?, provider?, output?)` |
| Tool nativo | `listen(seconds?, lang?, model?, provider?)` |
| Slash command | `/listen [secondi] [it\|en\|zh]` |
| Tasto rapido | `ctrl+b` — avvia/ferma la registrazione e inserisce il testo |
| Tasto rapido | `ctrl+shift+l` — registra 5 s e inserisce il testo |
| Script | `skills/speech-to-text/scripts/transcribe.sh` |

```bash
transcribe.sh file.m4a                    # auto-detect lingua
transcribe.sh -l it voce.mp3              # forza italiano (~2x più veloce)
transcribe.sh -l en -m small audio.wav    # più accuratezza
transcribe.sh --json audio.wav            # {"text":...,"language":...,"probability":...}
transcribe.sh -r 5                        # registra 5 s dal mic e trascrive
transcribe.sh --warmup                    # avvia il daemon e precarica il modello
```

---

## Architettura

```
┌────────────┐   unix socket   ┌──────────────────────────┐
│ extension  │ ───────────────▶│ stt_daemon.py            │
│ (node)     │  JSON lines      │  faster-whisper in RAM  │
└────────────┘                  │  idle-unload (10 min)   │
      │  fallback               └──────────────────────────┘
      ▼
 transcribe.sh ────────────────▶ daemon (client python) ─▶ cloud (openai/groq)
```

- Il daemon tiene il modello in memoria (come il *cached-model singleton* di
  Hermes), quindi le trascrizioni ripetute non ricaricano il modello.
- L'estensione parla **direttamente col daemon** via socket Unix: nessun
  processo python/ffmpeg per richiesta nel percorso interattivo.
- Socket: `${XDG_RUNTIME_DIR:-/tmp}/pi-stt-$(id -u).sock`.

---

## Prestazioni

- **`HF_HUB_OFFLINE=1`** è impostato automaticamente: senza, HuggingFace fa un
  check di rete al caricamento che su alcune reti/VPN **si blocca per minuti**.
- Modello di default **`base`**: veloce e sufficiente per comandi vocali.
  Usa `small`/`medium` per audio difficile.
- **Forza la lingua** quando la conosci: salta la language-detection (~2×).
- `STT_VAD=1` abilita il VAD Silero, ma qui è ~30× più lento: **da evitare**.

---

## Configurazione (variabili d'ambiente)

| Variabile | Default | Descrizione |
|---|---|---|
| `STT_MODEL` | `base` | Modello faster-whisper |
| `STT_LANG` | auto | Lingua di default |
| `STT_PYTHON` | auto | Interprete con `faster_whisper` |
| `STT_DEVICE` | `cpu` | `cpu` o `cuda` |
| `STT_COMPUTE_TYPE` | `int8` | `int8`, `float16`, … |
| `STT_CPU_THREADS` | auto | Thread CPU |
| `STT_IDLE_SECONDS` | `600` | Idle-unload del modello |
| `STT_SOCKET` | runtime dir | Percorso socket del daemon |
| `STT_NO_DAEMON` | — | `1` = processo freddo |
| `STT_SILENCE_DB` | `-50` | Soglia silenzio per le registrazioni |
| `TTS_VOICE_IT/EN/ZH` | voci edge | Voce per lingua |
| `TTS_PLAYER` | auto | Player audio |
| `NEXUS_H2A_HOME` | — | Root del package (se spostato) |

---

## Struttura del repository

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
│           └── stt_client.py
├── LICENSE
└── README.md
```

## Licenza

MIT — vedi [LICENSE](LICENSE).
