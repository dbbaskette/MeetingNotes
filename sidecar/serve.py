"""Bundled-app entry point. Runs uvicorn programmatically so PyInstaller can
package this as a single executable that doesn't need a Python interpreter
on the user's machine.

Usage:
    meeting-notes-diarize --host 127.0.0.1 --port 8765
"""
from __future__ import annotations

import argparse
import sys


def main() -> int:
    parser = argparse.ArgumentParser(prog="meeting-notes-diarize")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    # Import here so PyInstaller's static analysis still picks them up but
    # startup is fast (no double-import on errors).
    import uvicorn
    from meeting_notes_diarize.app import app

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
