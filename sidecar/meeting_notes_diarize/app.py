import logging
import os
import sys
import traceback
from pathlib import Path
from fastapi import FastAPI, HTTPException
from .schemas import DiarizeRequest, DiarizeResponse
from .diarize import diarize_audio

app = FastAPI(title="MeetingNotes Diarization Sidecar")
log = logging.getLogger("meeting_notes_diarize")

# Build identifier captured at process start. The supervisor compares this to
# the current on-disk BUILD_ID next to the sidecar bundle; if they differ, the
# sidecar is stale (e.g. app was rebuilt while a prior instance was running)
# and the supervisor will kill + relaunch with the fresh code.
def _read_build_id() -> str:
    # File is written during `npm run build:sidecar` and shipped next to the
    # PyInstaller onedir bundle / dev module. Missing file = dev run: use
    # this process's own module mtime as a poor-man's build id so at least
    # repeated dev launches are distinguishable.
    candidates = []
    if getattr(sys, "frozen", False):
        # PyInstaller's onedir executable lives at
        # dist/meeting-notes-diarize/meeting-notes-diarize. Raw bundles keep
        # BUILD_ID in dist/, while the packaged .app keeps it in sidecar/ so
        # the Electron supervisor and frozen service read the same stamp.
        executable_dir = Path(sys.executable).parent
        candidates.extend([
            executable_dir.parent / "BUILD_ID",
            executable_dir.parent.parent / "BUILD_ID",
        ])
    candidates.extend([
        Path(__file__).parent.parent / "BUILD_ID",          # dev: sidecar/BUILD_ID
        Path(__file__).parent.parent / "dist" / "BUILD_ID", # packaged sibling
    ])
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate.read_text().strip()
        except OSError:
            continue
    try:
        return f"dev-{int(Path(__file__).stat().st_mtime)}"
    except OSError:
        return "unknown"


BUILD_ID = _read_build_id()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "build_id": BUILD_ID}


@app.post("/diarize", response_model=DiarizeResponse)
def diarize(req: DiarizeRequest) -> DiarizeResponse:
    if not os.path.isfile(req.audio_path):
        raise HTTPException(status_code=400, detail=f"audio file not found: {req.audio_path}")
    try:
        return diarize_audio(req.audio_path)
    except Exception as e:
        # Bare str(e) on errors like OSError(2) yields "[Errno 2] No such file
        # or directory" with no path — useless for debugging. Log the full
        # traceback to stderr (which supervisor pipes to app.log) and include
        # the exception class in the client-facing detail.
        log.error("diarize failed:\n%s", traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e
