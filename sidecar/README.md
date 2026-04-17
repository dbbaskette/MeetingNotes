# MeetingNotes Diarization Sidecar

FastAPI service that runs pyannote.audio locally.

## Setup

```bash
./scripts/install.sh
export HF_TOKEN=<your-huggingface-token>  # pyannote model download
```

## Run

```bash
source .venv/bin/activate
uvicorn meeting_notes_diarize.app:app --host 127.0.0.1 --port 8765
```

## Test

```bash
source .venv/bin/activate
pytest
```
