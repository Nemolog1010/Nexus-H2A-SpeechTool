#!/usr/bin/env bash
# pi speech-to-text — transcribe audio files or record from the microphone.
#
# Usage:
#   transcribe.sh [options] AUDIO_FILE
#   transcribe.sh [options] --record SECONDS
#   transcribe.sh --warmup           # start the daemon and preload the model
#
# Options:
#   -l, --lang it|en|zh|auto   Spoken language (default: auto)
#   -m, --model NAME           Model (local: small, base, ...; cloud: provider model)
#   -p, --provider auto|local|openai|groq
#   -o, --out FILE             Write the transcript to a file
#   -r, --record SECONDS       Record from the default mic, then transcribe
#       --warmup               Ensure the warm daemon + model are ready, then exit
#       --json                 Print JSON {text, language, probability}
#   -h, --help
#
# Env:
#   STT_PROVIDER, STT_PYTHON, STT_MODEL, STT_DEVICE, STT_COMPUTE_TYPE,
#   STT_CPU_THREADS, STT_VAD, STT_SILENCE_DB, STT_IDLE_SECONDS, STT_SOCKET,
#   STT_NO_DAEMON=1 (use a cold one-shot process instead of the daemon)
#   OPENAI_API_KEY / VOICE_TOOLS_OPENAI_KEY, GROQ_API_KEY
set -euo pipefail

# Avoid the HuggingFace hub network check on model load: it can hang for minutes.
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

LANG_OPT="auto"; MODEL="${STT_MODEL:-}"; PROVIDER="${STT_PROVIDER:-auto}"
OUT=""; RECORD=""; JSON=0; WARMUP=0; AUDIO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -l|--lang)     LANG_OPT="${2:-auto}"; shift 2 ;;
    -m|--model)    MODEL="${2:-}";        shift 2 ;;
    -p|--provider) PROVIDER="${2:-auto}"; shift 2 ;;
    -o|--out)      OUT="${2:-}";          shift 2 ;;
    -r|--record)   RECORD="${2:-}";       shift 2 ;;
    --warmup)      WARMUP=1;              shift ;;
    --json)        JSON=1;                shift ;;
    -h|--help)     usage 0 ;;
    --)            shift; break ;;
    -*)            echo "transcribe.sh: unknown option: $1" >&2; usage 1 ;;
    *)             AUDIO="$1";            shift ;;
  esac
done
[[ -z "$AUDIO" && $# -gt 0 ]] && AUDIO="$1"

[[ "$LANG_OPT" == "auto" ]] && WLANG="" || WLANG="$LANG_OPT"

# --- locate a python that can import faster_whisper --------------------
find_python() {
  local c
  for c in "${STT_PYTHON:-}" "$HOME/.hermes/hermes-agent/venv/bin/python" "$(command -v python3)"; do
    [[ -n "$c" ]] || continue
    if "$c" -c 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("faster_whisper") else 1)' >/dev/null 2>&1; then
      echo "$c"; return
    fi
  done
  echo ""
}

# The daemon client only needs the stdlib, so the system python3 is enough
# (and starts much faster than the faster-whisper venv).
CLIENT_PY="$(command -v python3 2>/dev/null || true)"
CLIENT_PY="${CLIENT_PY:-${STT_PYTHON:-$HOME/.hermes/hermes-agent/venv/bin/python}}"

# --- local daemon (warm model, shared across calls) --------------------
SOCK="${STT_SOCKET:-${XDG_RUNTIME_DIR:-/tmp}/pi-stt-$(id -u).sock}"
IDLE="${STT_IDLE_SECONDS:-600}"

daemon_alive() { "$CLIENT_PY" "$SCRIPT_DIR/stt_client.py" --socket "$SOCK" --ping >/dev/null 2>&1; }

ensure_daemon() {
  daemon_alive && return 0
  mkdir -p "$(dirname "$SOCK")" 2>/dev/null || true
  exec 9>"${SOCK}.lock"
  flock 9
  if ! daemon_alive; then
    rm -f "$SOCK"
    nohup "$PY" "$SCRIPT_DIR/stt_daemon.py" \
      --socket "$SOCK" --model "${MODEL:-base}" --device "${STT_DEVICE:-cpu}" \
      --compute-type "${STT_COMPUTE_TYPE:-int8}" --cpu-threads "${STT_CPU_THREADS:-0}" \
      --idle "$IDLE" >"${SOCK}.log" 2>&1 &
    for _ in $(seq 1 240); do
      sleep 0.25
      daemon_alive && break
    done
  fi
  exec 9>&-
  daemon_alive
}

transcribe_local_daemon() {
  local cargs=(--socket "$SOCK" --audio "$WAV")
  [[ -n "$WLANG" ]] && cargs+=(--language "$WLANG")
  [[ -n "$MODEL" ]] && cargs+=(--model "$MODEL")
  cargs+=(--device "${STT_DEVICE:-cpu}" --compute-type "${STT_COMPUTE_TYPE:-int8}")
  [[ -n "${STT_CPU_THREADS:-}" ]] && cargs+=(--cpu-threads "$STT_CPU_THREADS")
  [[ "${STT_VAD:-0}" == "1" ]] && cargs+=(--vad)
  [[ "$JSON" -eq 1 ]] && cargs+=(--json)
  "$CLIENT_PY" "$SCRIPT_DIR/stt_client.py" "${cargs[@]}"
}

transcribe_local_direct() {
  local args=(--model "${MODEL:-base}" --device "${STT_DEVICE:-cpu}" --compute-type "${STT_COMPUTE_TYPE:-int8}")
  [[ -n "$WLANG" ]] && args+=(--language "$WLANG")
  [[ "${STT_VAD:-0}" == "1" ]] && args+=(--vad)
  [[ -n "${STT_CPU_THREADS:-}" ]] && args+=(--cpu-threads "$STT_CPU_THREADS")
  [[ "$JSON" -eq 1 ]] && args+=(--json)
  "$PY" "$SCRIPT_DIR/transcribe.py" "$WAV" "${args[@]}"
}

# --- warmup short-circuit ----------------------------------------------
if [[ "$WARMUP" -eq 1 ]]; then
  PY="$(find_python)"
  [[ -n "$PY" ]] || { echo "transcribe.sh: faster-whisper not found" >&2; exit 1; }
  if [[ "${STT_NO_DAEMON:-0}" == "1" ]]; then exit 0; fi
  ensure_daemon && exit 0 || exit 1
fi

# --- acquire audio ------------------------------------------------------
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [[ -n "$RECORD" ]]; then
  raw="$TMP/rec.wav"
  if command -v arecord >/dev/null 2>&1; then
    arecord -q -f S16_LE -r 16000 -c 1 -d "$RECORD" "$raw"
  elif command -v pw-record >/dev/null 2>&1; then
    timeout "$RECORD" pw-record --rate 16000 --channels 1 --format s16 "$raw" || true
  else
    echo "transcribe.sh: no microphone recorder found (need arecord or pw-record)" >&2; exit 1
  fi
  AUDIO="$raw"
fi

if [[ -z "$AUDIO" ]]; then
  echo "transcribe.sh: no audio input (pass a file or use --record SECONDS)" >&2; exit 1
fi
if [[ ! -f "$AUDIO" ]]; then
  echo "transcribe.sh: file not found: $AUDIO" >&2; exit 1
fi

# --- normalize to 16 kHz mono PCM --------------------------------------
WAV="$TMP/audio.wav"
if ! ffmpeg -y -loglevel error -i "$AUDIO" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$WAV"; then
  echo "transcribe.sh: ffmpeg could not decode the audio" >&2; exit 1
fi

# Guard against Whisper hallucinations on silent recordings.
if [[ -n "$RECORD" ]]; then
  mean_vol="$(ffmpeg -hide_banner -i "$WAV" -af volumedetect -f null - 2>&1 \
    | grep -oE 'mean_volume: -?[0-9.]+' | head -1 | grep -oE '\-?[0-9.]+' || true)"
  if [[ -n "$mean_vol" ]] && awk "BEGIN{exit !($mean_vol < ${STT_SILENCE_DB:--50})}"; then
    [[ -n "$OUT" ]] && : > "$OUT"
    exit 0
  fi
fi

# --- provider resolution -----------------------------------------------
openai_key="${VOICE_TOOLS_OPENAI_KEY:-${OPENAI_API_KEY:-}}"
groq_key="${GROQ_API_KEY:-}"

if [[ "$PROVIDER" == "auto" ]]; then
  LOCAL_PY="$(find_python)"
  if [[ -n "$LOCAL_PY" ]]; then PROVIDER="local"
  elif [[ -n "$groq_key" ]]; then PROVIDER="groq"
  elif [[ -n "$openai_key" ]]; then PROVIDER="openai"
  else PROVIDER="local"; fi
fi

cloud_call() { # $1=base_url $2=key $3=model
  local resp
  resp="$(curl -sS -X POST "$1/audio/transcriptions" \
    -H "Authorization: Bearer $2" \
    -F "file=@$WAV;type=audio/wav" \
    -F "model=$3" \
    ${WLANG:+-F "language=$WLANG"})"
  printf '%s' "$resp" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("text","").strip())'
}

case "$PROVIDER" in
  local)
    PY="${LOCAL_PY:-$(find_python)}"
    if [[ -z "$PY" ]]; then
      echo "transcribe.sh: faster-whisper not found (set STT_PYTHON or install it)" >&2; exit 1
    fi
    RESULT=""
    if [[ "${STT_NO_DAEMON:-0}" != "1" ]] && ensure_daemon; then
      RESULT="$(transcribe_local_daemon)" || RESULT=""
    fi
    # Fall back to a cold one-shot process if the daemon path failed.
    [[ -n "$RESULT" ]] || RESULT="$(transcribe_local_direct)"
    ;;
  openai)
    [[ -n "$openai_key" ]] || { echo "transcribe.sh: OPENAI_API_KEY/VOICE_TOOLS_OPENAI_KEY not set" >&2; exit 1; }
    RESULT="$(cloud_call "https://api.openai.com/v1" "$openai_key" "${MODEL:-whisper-1}")"
    ;;
  groq)
    [[ -n "$groq_key" ]] || { echo "transcribe.sh: GROQ_API_KEY not set" >&2; exit 1; }
    RESULT="$(cloud_call "https://api.groq.com/openai/v1" "$groq_key" "${MODEL:-whisper-large-v3-turbo}")"
    ;;
  *)
    echo "transcribe.sh: unknown provider '$PROVIDER' (auto|local|openai|groq)" >&2; exit 1 ;;
esac

if [[ -n "$OUT" ]]; then
  printf '%s\n' "$RESULT" > "$OUT"
fi
printf '%s\n' "$RESULT"
