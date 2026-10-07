import sys
from unittest.mock import patch
from fastapi.testclient import TestClient
from meeting_notes_diarize.app import _read_build_id, app
from meeting_notes_diarize.schemas import DiarizeResponse, Segment

client = TestClient(app)

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

def test_read_build_id_from_frozen_bundle_sibling(monkeypatch, tmp_path):
    executable = tmp_path / "dist" / "meeting-notes-diarize" / "meeting-notes-diarize"
    executable.parent.mkdir(parents=True)
    (tmp_path / "dist" / "BUILD_ID").write_text("frozen-build-123\n")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))

    assert _read_build_id() == "frozen-build-123"

def test_read_build_id_from_packaged_app_sidecar_root(monkeypatch, tmp_path):
    sidecar_dir = tmp_path / "Resources" / "sidecar"
    executable = sidecar_dir / "dist" / "meeting-notes-diarize" / "meeting-notes-diarize"
    executable.parent.mkdir(parents=True)
    (sidecar_dir / "BUILD_ID").write_text("packaged-build-456\n")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))

    assert _read_build_id() == "packaged-build-456"

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
