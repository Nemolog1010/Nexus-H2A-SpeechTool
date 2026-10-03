#!/usr/bin/env python3
"""Local speech-to-text with faster-whisper (CTranslate2). Prints transcript to stdout."""

from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description="Transcribe audio with faster-whisper.")
    ap.add_argument("audio", help="Path to a 16 kHz mono WAV file.")
    ap.add_argument("--model", default="base", help="faster-whisper model size (tiny/base/small/medium/large-v3).")
    ap.add_argument("--language", default=None, help="Language code (it/en/zh). Omit for auto-detect.")
    ap.add_argument("--device", default="cpu", help="cpu or cuda.")
    ap.add_argument("--compute-type", default="int8", help="int8, int8_float16, float16, float32.")
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--vad", action="store_true", help="Enable Silero VAD (slower; off by default).")
    ap.add_argument("--cpu-threads", type=int, default=0, help="CPU threads (0 = library default).")
    ap.add_argument("--no-speech-threshold", type=float, default=0.6,
                    help="Drop a clip as silence when every segment has no_speech_prob above this (default 0.6).")
    ap.add_argument("--logprob-threshold", type=float, default=-1.0,
                    help="Drop a clip as silence when every segment has avg_logprob below this (default -1.0).")
    ap.add_argument("--json", action="store_true", help="Emit JSON with text, language and probability.")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed for this interpreter", file=sys.stderr)
        return 2

    language = None if not args.language or args.language == "auto" else args.language

    kwargs = {}
    if args.cpu_threads > 0:
        kwargs["cpu_threads"] = args.cpu_threads
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        local_files_only=True,  # no HuggingFace network check (it can hang)
        **kwargs,
    )
    segments, info = model.transcribe(
        args.audio,
        beam_size=args.beam_size,
        vad_filter=args.vad,
        language=language,
    )
    seg_list = list(segments)

    # Suppress Whisper hallucinations on silence/noise: if no segment looks like
    # confident speech, treat the whole clip as silent.
    def is_speech(seg) -> bool:
        no_speech = getattr(seg, "no_speech_prob", 0.0)
        logprob = getattr(seg, "avg_logprob", 0.0)
        return no_speech <= args.no_speech_threshold and logprob >= args.logprob_threshold

    if seg_list and not any(is_speech(seg) for seg in seg_list):
        text = ""
    else:
        text = "".join(segment.text for segment in seg_list).strip()

    if args.json:
        print(
            json.dumps(
                {
                    "text": text,
                    "language": getattr(info, "language", None),
                    "probability": getattr(info, "language_probability", None),
                },
                ensure_ascii=False,
            )
        )
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
