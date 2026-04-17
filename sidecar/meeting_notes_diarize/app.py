import os
from fastapi import FastAPI, HTTPException
from .schemas import DiarizeRequest, DiarizeResponse
from .diarize import diarize_audio

app = FastAPI(title="MeetingNotes Diarization Sidecar")


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
        raise HTTPException(status_code=500, detail=str(e)) from e
