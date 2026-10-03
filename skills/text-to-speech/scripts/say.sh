#!/usr/bin/env bash
# pi text-to-speech via edge-tts — Italian, English, Chinese.
#
# Usage:
#   say.sh [-l it|en|zh] [-v VOICE] [-r RATE] [-n] [-o DIR] TEXT...
#   echo "text" | say.sh -l zh
#
# Options:
#   -l, --lang LANG     Language: it, en, zh (default: auto-detect)
#   -v, --voice VOICE   Full edge-tts voice name (overrides -l default)
#   -r, --rate RATE     Speaking rate, e.g. +10% / -20% (default: +0%)
#   -n, --no-play       Only synthesize, print the audio file path
#   -o, --out-dir DIR   Output directory (default: ~/.pi/agent/cache/tts)
#   -h, --help          Show this help
#
# Env overrides:
#   EDGE_TTS_BIN, TTS_VOICE_IT, TTS_VOICE_EN, TTS_VOICE_ZH, TTS_PLAYER
set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

LANG_OPT=""; VOICE=""; RATE="+0%"; PLAY=1
OUT_DIR="${TTS_OUT_DIR:-$HOME/.pi/agent/cache/tts}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -l|--lang)    LANG_OPT="${2:-}"; shift 2 ;;
    -v|--voice)   VOICE="${2:-}";    shift 2 ;;
    -r|--rate)    RATE="${2:-}";     shift 2 ;;
    -n|--no-play) PLAY=0;            shift ;;
    -o|--out-dir) OUT_DIR="${2:-}";  shift 2 ;;
    -h|--help)    usage 0 ;;
    --)           shift; break ;;
    -*)           echo "say.sh: unknown option: $1" >&2; usage 1 ;;
    *)            break ;;
  esac
done

if [[ $# -gt 0 ]]; then
  TEXT="$*"
else
  TEXT="$(cat)"
fi

if [[ -z "${TEXT//[[:space:]]/}" ]]; then
  echo "say.sh: no text provided" >&2
  exit 1
fi

# --- language detection -------------------------------------------------
detect_lang() {
  local t="$1"
  if printf '%s' "$t" | grep -qP '[\x{4E00}-\x{9FFF}\x{3400}-\x{4DBF}]'; then
    echo zh; return
  fi
  if printf '%s' "$t" | grep -qiE '[àèéìòùÀÈÉÌÒÙ]|\b(il|lo|la|gli|le|un|una|che|di|del|della|per|con|non|sono|come|questo|questa|più|già|però|anche|quando|perché|essere|avere|molto|bene|grazie|scusa|ciao)\b'; then
    echo it; return
  fi
  echo en
}

if [[ -z "$LANG_OPT" ]]; then
  LANG_OPT="$(detect_lang "$TEXT")"
fi

# --- voice selection ----------------------------------------------------
case "$LANG_OPT" in
  it) VOICE="${VOICE:-${TTS_VOICE_IT:-it-IT-ElsaNeural}}" ;;
  en) VOICE="${VOICE:-${TTS_VOICE_EN:-en-US-AriaNeural}}" ;;
  zh) VOICE="${VOICE:-${TTS_VOICE_ZH:-zh-CN-XiaoxiaoNeural}}" ;;
  *)  echo "say.sh: unsupported lang '$LANG_OPT' (use it, en, zh) or pass a full -v VOICE" >&2; exit 1 ;;
esac

# --- locate edge-tts ----------------------------------------------------
find_edge() {
  if [[ -n "${EDGE_TTS_BIN:-}" && -x "${EDGE_TTS_BIN}" ]]; then echo "$EDGE_TTS_BIN"; return; fi
  if command -v edge-tts >/dev/null 2>&1; then command -v edge-tts; return; fi
  local h="$HOME/.hermes/hermes-agent/venv/bin/edge-tts"
  if [[ -x "$h" ]]; then echo "$h"; return; fi
  if command -v uvx >/dev/null 2>&1; then echo "uvx edge-tts"; return; fi
  echo "" 
}
EDGE="$(find_edge)"
if [[ -z "$EDGE" ]]; then
  echo "say.sh: edge-tts not found. Set EDGE_TTS_BIN or install it (pip install edge-tts)." >&2
  exit 1
fi

# --- synthesize ---------------------------------------------------------
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUT_DIR/tts-$STAMP-$LANG_OPT.mp3"

# shellcheck disable=SC2086
$EDGE --voice "$VOICE" --rate "$RATE" --text "$TEXT" --write-media "$OUT" >/dev/null

if [[ ! -s "$OUT" ]]; then
  echo "say.sh: synthesis failed (no audio produced)" >&2
  exit 1
fi

# --- play ---------------------------------------------------------------
find_player() {
  if [[ -n "${TTS_PLAYER:-}" ]]; then echo "$TTS_PLAYER"; return; fi
  if command -v ffplay >/dev/null 2>&1; then echo "ffplay"; return; fi
  if command -v pw-play >/dev/null 2>&1; then echo "pw-play"; return; fi
  if command -v paplay >/dev/null 2>&1; then echo "paplay"; return; fi
  if command -v cvlc >/dev/null 2>&1; then echo "cvlc"; return; fi
  echo ""
}

if [[ "$PLAY" -eq 1 ]]; then
  PLAYER="$(find_player)"
  if [[ -z "$PLAYER" ]]; then
    echo "say.sh: no audio player found; file at $OUT" >&2
  else
    case "$PLAYER" in
      ffplay) ffplay -nodisp -autoexit -loglevel error "$OUT" ;;
      cvlc)   cvlc --play-and-exit --intf dummy "$OUT" >/dev/null 2>&1 ;;
      *)      "$PLAYER" "$OUT" ;;
    esac
  fi
fi

echo "$OUT"
