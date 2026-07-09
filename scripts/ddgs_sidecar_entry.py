#!/usr/bin/env python3
"""Zeus-bundled ddgs sidecar entry point.

Why this exists
---------------
The upstream `ddgs` CLI (>= 9.x) is broken on stdout: `-o json` writes
nothing to stdout in 9.14.4 (see scripts/build-ddgs-sidecar.sh for the
exact failure mode we worked around). This wrapper calls the ddgs
Python API directly and prints a stable JSON array on stdout so
Zeus's Rust sidecar can parse it without depending on the CLI flag
set.

Invocation (mirrors what Zeus's Rust sidecar issue):
    ddgs text -q QUERY -m LIMIT

Stdout (on success, exit 0): a JSON array of
    [{"title": "...", "href": "...", "body": "..."}, ...]

Stdout (on success, no hits): `[]`
Stderr (on failure, exit 2):  usage / argument errors
Stderr (on failure, exit 1):  upstream ddgs errors
"""
from __future__ import annotations

import argparse
import json
import sys

# ddgs 9.x changed its internal layout; import the high-level DDGS
# object which is the documented public entry point.
from ddgs import DDGS


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Accept the same surface as `ddgs text -q Q -m N` so the Rust sidecar
    doesn't need to know we replaced the CLI."""
    parser = argparse.ArgumentParser(prog="ddgs-sidecar", add_help=True)
    parser.add_argument("command", choices=["text"])
    parser.add_argument("-q", "--query", required=True)
    parser.add_argument("-m", "--max-results", type=int, default=8)
    parser.add_argument("-r", "--region", default="us-en")
    parser.add_argument("-t", "--timelimit", default=None,
                        help="d|w|m|y — restrict to recency window")
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])

    try:
        ddgs = DDGS()
        # ddgs accepts `query`, `region`, `timelimit`, `max_results` —
        # we forward only the ones the user actually passed to keep the
        # call shape simple.
        kwargs = {"query": args.query, "region": args.region, "max_results": args.max_results}
        if args.timelimit:
            kwargs["timelimit"] = args.timelimit
        hits = list(ddgs.text(**kwargs))
    except Exception as exc:  # noqa: BLE001 — surface upstream error verbatim
        # Print a JSON object (not array) on stderr so the Rust sidecar
        # can tell an upstream error from a 0-hits success.
        sys.stderr.write(json.dumps({"error": f"{type(exc).__name__}: {exc!r}"}) + "\n")
        return 1

    payload = [
        {
            "title": (h.get("title") or "").strip(),
            "href": (h.get("href") or "").strip(),
            "body": (h.get("body") or "").strip(),
        }
        for h in hits
        if (h.get("href") or "").strip()
    ]
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())