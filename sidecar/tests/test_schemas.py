import pytest
from meeting_notes_diarize.schemas import DiarizeRequest, DiarizeResponse, Segment

def test_diarize_request_requires_audio_path():
    with pytest.raises(Exception):
        DiarizeRequest()

def test_segment_validates_order():
    s = Segment(start=1.0, end=2.0, speaker="SPEAKER_00", embedding=[0.1]*512)
    assert s.end > s.start
    assert len(s.embedding) == 512

def test_response_serializes_to_json():
    r = DiarizeResponse(
        segments=[Segment(start=0, end=1, speaker="SPEAKER_00", embedding=[0.0]*512)],
        num_speakers=1,
    )
    data = r.model_dump()
    assert data["num_speakers"] == 1
