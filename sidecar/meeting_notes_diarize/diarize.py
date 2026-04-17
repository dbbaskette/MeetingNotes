from __future__ import annotations
import os
from functools import lru_cache
from typing import List, Any
import numpy as np

from .schemas import DiarizeResponse, Segment

EMBEDDING_DIM = 512


@lru_cache(maxsize=1)
def _get_pipeline() -> Any:
    """Lazy-loaded pyannote speaker-diarization pipeline. Imported on first use
    so the module can be imported in environments without pyannote installed
    (e.g., the lightweight test venv)."""
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN env var required to download pyannote models")
    from pyannote.audio import Pipeline  # noqa: PLC0415
    import torch  # noqa: PLC0415
    pipe = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", use_auth_token=token
    )
    if torch.backends.mps.is_available():
        pipe.to(torch.device("mps"))
    return pipe


@lru_cache(maxsize=1)
def _get_embedder() -> Any:
    token = os.environ.get("HF_TOKEN")
    from pyannote.audio import Inference  # noqa: PLC0415
    return Inference("pyannote/embedding", window="whole", use_auth_token=token)


def _embed_segment(audio_path: str, start: float, end: float) -> np.ndarray:
    import torchaudio  # noqa: PLC0415
    waveform, sr = torchaudio.load(
        audio_path,
        frame_offset=int(start * 16000),
        num_frames=int((end - start) * 16000),
    )
    embedder = _get_embedder()
    emb = embedder({"waveform": waveform, "sample_rate": sr})
    return np.asarray(emb, dtype=np.float32).flatten()


def diarize_audio(audio_path: str) -> DiarizeResponse:
    pipe = _get_pipeline()
    annotation = pipe(audio_path)
    segments: List[Segment] = []
    speakers: set[str] = set()
    for turn, _, label in annotation.itertracks(yield_label=True):
        emb = _embed_segment(audio_path, turn.start, turn.end)
        segments.append(Segment(
            start=float(turn.start),
            end=float(turn.end),
            speaker=str(label),
            embedding=emb.tolist(),
        ))
        speakers.add(str(label))
    return DiarizeResponse(segments=segments, num_speakers=len(speakers))
