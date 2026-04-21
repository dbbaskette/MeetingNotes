from __future__ import annotations
import os
import shutil
import subprocess
from functools import lru_cache
from typing import List, Any, Tuple
import numpy as np

from .schemas import DiarizeResponse, Segment

EMBEDDING_DIM = 512
TARGET_SR = 16000

# Common locations to look for ffmpeg, in order. PATH may be restricted when
# launched from Finder so we hardcode the usual brew paths.
FFMPEG_CANDIDATES = (
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/local/bin/ffmpeg",
)


@lru_cache(maxsize=1)
def _ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    for c in FFMPEG_CANDIDATES:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    raise RuntimeError(
        "ffmpeg not found. Install with: brew install ffmpeg",
    )


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
        "pyannote/speaker-diarization-3.1", token=token
    )
    if torch.backends.mps.is_available():
        pipe.to(torch.device("mps"))
    return pipe


@lru_cache(maxsize=1)
def _get_embedder() -> Any:
    token = os.environ.get("HF_TOKEN")
    from pyannote.audio import Inference  # noqa: PLC0415
    return Inference("pyannote/embedding", window="whole", token=token)


def _load_audio(audio_path: str) -> Tuple[Any, int]:
    """Decode any audio file (MP3/WAV/M4A/etc.) to a (waveform, sample_rate)
    pair where waveform is a 2-D torch tensor (channel=1, time) at 16 kHz mono.

    pyannote 3.4+ and torchaudio 2.11+ both delegate audio decoding to
    torchcodec, which fails on macOS unless FFmpeg's shared libraries are
    version-pinned exactly right. We sidestep both by shelling out to ffmpeg
    directly to produce raw PCM, then build the tensor ourselves. Pyannote's
    pipeline accepts the in-memory dict form
    `{'waveform': tensor, 'sample_rate': int}`, which never touches torchcodec.
    """
    import torch  # noqa: PLC0415
    proc = subprocess.run(
        [
            _ffmpeg(),
            "-nostdin",
            "-i", audio_path,
            "-f", "s16le",         # raw PCM
            "-acodec", "pcm_s16le",
            "-ar", str(TARGET_SR), # resample to 16k
            "-ac", "1",            # mono
            "-loglevel", "error",
            "-",                   # stdout
        ],
        check=True,
        capture_output=True,
        timeout=600,
    )
    raw = np.frombuffer(proc.stdout, dtype=np.int16)
    if raw.size == 0:
        raise RuntimeError(f"ffmpeg produced empty output for {audio_path}")
    # Normalize int16 to float32 in [-1, 1], shape (1, time).
    waveform = torch.from_numpy(raw.astype(np.float32) / 32768.0).unsqueeze(0)
    return waveform, TARGET_SR


def _slice(waveform: Any, sr: int, start: float, end: float) -> Any:
    """Slice an in-memory waveform tensor by seconds."""
    s = max(0, int(start * sr))
    e = min(waveform.shape[1], int(end * sr))
    return waveform[:, s:e]


def _embed_segment(waveform: Any, sr: int, start: float, end: float) -> np.ndarray:
    chunk = _slice(waveform, sr, start, end)
    embedder = _get_embedder()
    emb = embedder({"waveform": chunk, "sample_rate": sr})
    return np.asarray(emb, dtype=np.float32).flatten()


def diarize_audio(audio_path: str) -> DiarizeResponse:
    waveform, sr = _load_audio(audio_path)
    pipe = _get_pipeline()
    result = pipe({"waveform": waveform, "sample_rate": sr})

    # pyannote 3.4+ returns a DiarizeOutput wrapper around the Annotation.
    # Older builds returned the Annotation directly. Accept both.
    if hasattr(result, "itertracks"):
        annotation = result
        speaker_embeddings = None
        speaker_order: List[str] = []
    else:
        annotation = result.speaker_diarization
        speaker_embeddings = getattr(result, "speaker_embeddings", None)
        # DiarizeOutput.speaker_embeddings rows are sorted in labels() order.
        speaker_order = list(annotation.labels()) if speaker_embeddings is not None else []

    # Prefer the per-speaker embeddings the pipeline already computed — saves
    # one additional forward pass per turn.
    label_to_emb: dict[str, np.ndarray] = {}
    if speaker_embeddings is not None:
        for i, label in enumerate(speaker_order):
            label_to_emb[str(label)] = np.asarray(speaker_embeddings[i], dtype=np.float32).flatten()

    segments: List[Segment] = []
    speakers: set[str] = set()
    for turn, _, label in annotation.itertracks(yield_label=True):
        label_s = str(label)
        if label_s in label_to_emb:
            emb = label_to_emb[label_s]
        else:
            emb = _embed_segment(waveform, sr, turn.start, turn.end)
        segments.append(Segment(
            start=float(turn.start),
            end=float(turn.end),
            speaker=label_s,
            embedding=emb.tolist(),
        ))
        speakers.add(label_s)
    return DiarizeResponse(segments=segments, num_speakers=len(speakers))
