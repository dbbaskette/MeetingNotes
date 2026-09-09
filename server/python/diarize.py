"""Offline CPU-only adapter. Model assets are staged explicitly, never fetched here."""
import json
import sys
import wave
import numpy as np
import torch
from pyannote.audio import Pipeline, Inference, Model

torch.set_num_threads(2)
audio_path, output_path, pipeline_path, embedding_path = sys.argv[1:]
with wave.open(audio_path, "rb") as source:
    if source.getnchannels() != 1 or source.getframerate() != 16000 or source.getsampwidth() != 2:
        raise ValueError("Expected mono 16k PCM16")
    waveform = torch.from_numpy(np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16).copy().astype(np.float32) / 32768).unsqueeze(0)
pipeline = Pipeline.from_pretrained(pipeline_path)
pipeline.to(torch.device("cpu"))
embedder = Inference(Model.from_pretrained(embedding_path), window="whole", device=torch.device("cpu"))
audio = {"waveform": waveform, "sample_rate": 16000}
result = pipeline(audio)
annotation = result if hasattr(result, "itertracks") else result.speaker_diarization
segments = []
for turn, _, speaker in annotation.itertracks(yield_label=True):
    chunk = waveform[:, max(0, int(turn.start * 16000)):int(turn.end * 16000)]
    # Never mislabel the pipeline's internal embedding model as pyannote/embedding.
    vector = np.asarray(embedder({"waveform": chunk, "sample_rate": 16000}), dtype=np.float32).flatten()
    embedding = vector.tolist() if np.isfinite(vector).all() else []
    segments.append({"start": float(turn.start), "end": float(turn.end), "speaker": str(speaker), "embedding": embedding})
with open(output_path, "x", encoding="utf8") as output:
    json.dump({"segments": segments}, output, allow_nan=False)
