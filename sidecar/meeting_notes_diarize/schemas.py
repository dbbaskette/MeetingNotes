from typing import List
from pydantic import BaseModel, Field, field_validator

class DiarizeRequest(BaseModel):
    audio_path: str

class Segment(BaseModel):
    start: float
    end: float
    speaker: str
    embedding: List[float] = Field(min_length=1)

    @field_validator("end")
    @classmethod
    def end_after_start(cls, v: float, info):
        if "start" in info.data and v <= info.data["start"]:
            raise ValueError("end must be > start")
        return v

class DiarizeResponse(BaseModel):
    segments: List[Segment]
    num_speakers: int
