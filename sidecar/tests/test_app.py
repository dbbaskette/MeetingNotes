from unittest.mock import patch
from fastapi.testclient import TestClient
from meeting_notes_diarize.app import app
from meeting_notes_diarize.schemas import DiarizeResponse, Segment

client = TestClient(app)

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

def test_diarize_rejects_missing_file():
    r = client.post("/diarize", json={"audio_path": "/does/not/exist.mp3"})
    assert r.status_code == 400

@patch("meeting_notes_diarize.app.diarize_audio")
def test_diarize_happy_path(mock_diarize, tmp_path):
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"x")
    mock_diarize.return_value = DiarizeResponse(
        segments=[Segment(start=0, end=1, speaker="SPEAKER_00", embedding=[0.0]*512)],
        num_speakers=1,
    )
    r = client.post("/diarize", json={"audio_path": str(audio)})
    assert r.status_code == 200
    assert r.json()["num_speakers"] == 1
