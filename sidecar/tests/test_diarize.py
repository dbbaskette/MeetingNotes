from unittest.mock import MagicMock, patch
import numpy as np
from meeting_notes_diarize.diarize import diarize_audio


def make_fake_annotation():
    ann = MagicMock()
    # itertracks(yield_label=True) yields (segment, track, label) triples
    seg0 = MagicMock(); seg0.start = 0.0; seg0.end = 2.0
    seg1 = MagicMock(); seg1.start = 2.0; seg1.end = 5.0
    ann.itertracks.return_value = [
        (seg0, None, "SPEAKER_00"),
        (seg1, None, "SPEAKER_01"),
    ]
    return ann


@patch("meeting_notes_diarize.diarize._get_pipeline")
@patch("meeting_notes_diarize.diarize._embed_segment")
def test_diarize_audio_returns_segments_with_embeddings(mock_embed, mock_pipe):
    mock_embed.return_value = np.zeros(512, dtype=np.float32)
    pipe = MagicMock(return_value=make_fake_annotation())
    mock_pipe.return_value = pipe

    out = diarize_audio("/tmp/fake.mp3")
    assert out.num_speakers == 2
    assert len(out.segments) == 2
    assert out.segments[0].speaker == "SPEAKER_00"
    assert len(out.segments[0].embedding) == 512
