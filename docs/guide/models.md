# Models

How MeetingNotes talks to your local LLM, and the one-time Hugging Face setup that diarization needs.

MeetingNotes talks to any chat model in **LM Studio** or **Ollama** over an OpenAI-compatible API, and manages the runtime for you: with `summaryProvider` set to `lm-studio`/`ollama` it spawns the server, auto-loads `llmModel`, and idle-shuts-down after 10 min. The default is **`qwen/qwen3.5-9b`** — small enough to fit Apple Silicon VRAM on long transcripts.

**Reasoning models are supported but need care.** Models like Gemma, Qwen3, and DeepSeek-R1 "think" in a `<think>` channel before answering, which MeetingNotes handles at several layers:

- 🧠 **Badges** flag known reasoning models in the picker and onboarding.
- ✅ A **health-check canary** runs a cheap extraction on your chosen model and warns if it loops.
- 🔁 **Automatic re-sampling** — if a model spends its whole token budget thinking and returns nothing (an intermittent failure on some models), the stage re-samples at a higher temperature instead of hard-failing.
- ✂️ `<think>` blocks are **stripped** before rendering, and a **Disable model thinking** toggle sends `enable_thinking: false` where the model honors it.

> [!TIP]
> A **non-reasoning** chat model is the simplest, fastest choice and sidesteps the thinking-loop failure mode entirely. Reach for a reasoning model only if you specifically want its output quality.

## Hugging Face token (one-time, for diarization)

pyannote's models are gated. Accept the license on all three:
- https://huggingface.co/pyannote/speaker-diarization-3.1
- https://huggingface.co/pyannote/segmentation-3.0
- https://huggingface.co/pyannote/speaker-diarization-community-1

Create a **fine-grained** token with "Read access to contents of all public gated repos you can access", and paste it when `setup.sh` prompts. It's saved to `~/.cache/huggingface/token` (chmod 600). After the first download the model is cached locally and inference needs **neither the token nor the network**.
