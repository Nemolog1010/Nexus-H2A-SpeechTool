#!/usr/bin/env python3
"""Tiny client for the pi STT daemon (unix socket, newline-delimited JSON)."""

from __future__ import annotations

import argparse
import json
import socket
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description="Talk to the pi STT daemon.")
    ap.add_argument("--socket", required=True)
    ap.add_argument("--ping", action="store_true", help="Only check that the daemon is reachable.")
    ap.add_argument("--audio")
    ap.add_argument("--language")
    ap.add_argument("--model")
    ap.add_argument("--device")
    ap.add_argument("--compute-type")
    ap.add_argument("--cpu-threads", type=int, default=0)
    ap.add_argument("--beam-size", type=int)
    ap.add_argument("--no-speech-threshold", type=float)
    ap.add_argument("--logprob-threshold", type=float)
    ap.add_argument("--vad", action="store_true")
    ap.add_argument("--json", action="store_true", help="Print the full JSON response.")
    ap.add_argument("--timeout", type=float, default=600.0)
    args = ap.parse_args()

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(args.timeout)
    try:
        sock.connect(args.socket)
    except OSError as exc:
        print(f"connect failed: {exc}", file=sys.stderr)
        return 2

    if args.ping:
        return 0

    request = {"audio": args.audio}
    for field in ("language", "model", "device"):
        value = getattr(args, field)
        if value:
            request[field] = value
    if args.compute_type:
        request["compute_type"] = args.compute_type
    if args.cpu_threads:
        request["cpu_threads"] = args.cpu_threads
    if args.beam_size:
        request["beam_size"] = args.beam_size
    if args.no_speech_threshold is not None:
        request["no_speech_threshold"] = args.no_speech_threshold
    if args.logprob_threshold is not None:
        request["logprob_threshold"] = args.logprob_threshold
    if args.vad:
        request["vad"] = True

    sock.sendall((json.dumps(request) + "\n").encode())
    buffer = b""
    while b"\n" not in buffer:
        chunk = sock.recv(65536)
        if not chunk:
            break
        buffer += chunk

    raw = buffer.decode().strip()
    try:
        data = json.loads(raw)
    except ValueError:
        print(f"bad response: {raw}", file=sys.stderr)
        return 3

    if "error" in data:
        print(data["error"], file=sys.stderr)
        return 3

    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print((data.get("text") or "").strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
