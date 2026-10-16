# Models

MeetingNotes 1.15 offers two local speech engines and keeps summary generation separate.

## Native speech (recommended, Apple Silicon / macOS 26+)

Select **Apple transcription + SpeakerKit** in Settings → Processing and click **Prepare native speech**. This explicitly provisions Apple language assets and about 11 MB of hash-verified SpeakerKit models pinned to revision `556fc52a13327837688f02289457cded017802e9`, SDK 1.1.1. Cancel and retry are available. No Whisper, Python installation, Hugging Face account/token, or gated approval is needed. The downloaded public models are hosted on Hugging Face; meeting audio is not uploaded. Inference uses local assets only. Language support is checked by Apple's API; `en` selects en-US.

New supported installations use native speech; existing ones keep their current engine until switched. Old roster names and legacy vectors remain. Confirm voices in native meetings to train model-tagged profiles; suggestions are review-only similarities, not probabilities. Invalid/missing vectors permit manual naming. Never compare or copy legacy vectors into the native space.

The separate [comparison beta](speech-beta.md) remains available without writing its copied results back to the regular library. See [upgrade instructions](../../README.md#upgrading-to-1150-what-to-do) and [SDK/model notices](../speech-beta-notices.md).

## Summaries and action items (both engines)

MeetingNotes talks to any chat model in **LM Studio** or **Ollama** over an OpenAI-compatible API, and manages the runtime for you: with `summaryProvider` set to `lm-studio`/`ollama` it spawns the server, auto-loads `llmModel`, and idle-shuts-down after 10 min. The default is **`qwen/qwen3.5-9b`** — small enough to fit Apple Silicon VRAM on long transcripts.

**Reasoning models are supported but need care.** Models like Gemma, Qwen3, and DeepSeek-R1 "think" in a `<think>` channel before answering, which MeetingNotes handles at several layers:

- 🧠 **Badges** flag known reasoning models in the picker and onboarding.
- ✅ A **health-check canary** runs a cheap extraction on your chosen model and warns if it loops.
- 🔁 **Automatic re-sampling** — if a model spends its whole token budget thinking and returns nothing (an intermittent failure on some models), the stage re-samples at a higher temperature instead of hard-failing.
- ✂️ `<think>` blocks are **stripped** before rendering, and a **Disable model thinking** toggle sends `enable_thinking: false` where the model honors it.

> [!TIP]
> A **non-reasoning** chat model is the simplest, fastest choice and sidesteps the thinking-loop failure mode entirely. Reach for a reasoning model only if you specifically want its output quality.

## Legacy speech: Whisper + pyannote (macOS 14.2+)

Use **Legacy · Whisper + pyannote** in Processing to retain the old workflow. Whisper model management and legacy endpoint controls remain available. This path uses whisper.cpp and the Python sidecar (bundled in the installer), with the gated-model setup below. Switching is allowed only while processing/queue/setup are idle. Legacy automatic voice matching keeps its existing behavior; native profiles are not used by it.

### Hugging Face token (one-time, legacy diarization only)

pyannote's models are gated. Accept the license on all three:
- https://huggingface.co/pyannote/speaker-diarization-3.1
- https://huggingface.co/pyannote/segmentation-3.0
- https://huggingface.co/pyannote/speaker-diarization-community-1

Create a **fine-grained** token with "Read access to contents of all public gated repos you can access", and paste it when `setup.sh` prompts. It's saved to `~/.cache/huggingface/token` (chmod 600). After the first download the model is cached locally and inference needs **neither the token nor the network**.
