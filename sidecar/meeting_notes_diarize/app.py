import logging
import os
import traceback
from fastapi import FastAPI, HTTPException
from .schemas import DiarizeRequest, DiarizeResponse
from .diarize import diarize_audio

app = FastAPI(title="MeetingNotes Diarization Sidecar")
log = logging.getLogger("meeting_notes_diarize")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


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
