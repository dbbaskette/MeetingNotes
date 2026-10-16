# Models

MeetingNotes 1.16 uses Apple SpeechTranscriber + SpeakerKit only, on Apple silicon/macOS 26+. Summary generation remains separate.

## Speech setup

Open Settings → Processing and click **Prepare native speech**. This explicitly provisions Apple language assets and about 11 MB of hash-verified SpeakerKit models pinned to revision `556fc52a13327837688f02289457cded017802e9`, SDK 1.1.1. Cancel and retry are available. No Whisper, Python installation, Hugging Face account/token, or gated approval is needed. The downloaded public models are hosted on Hugging Face; meeting audio is not uploaded. Inference uses local assets only. Language support is checked by Apple's API; `en` selects en-US.

Every installation uses native speech, including upgrades with saved legacy settings. Old roster names and legacy vectors remain. Confirm voices in native meetings to train model-tagged profiles; suggestions are review-only similarities, not probabilities. Invalid/missing vectors permit manual naming. Never compare or copy legacy vectors into the native space.

The separate [comparison beta](speech-beta.md) remains available without writing its copied results back to the regular library. See [upgrade instructions](../../README.md#upgrading-to-1160-what-to-do) and [SDK/model notices](../speech-beta-notices.md).

## Summaries and action items

MeetingNotes talks to any chat model in **LM Studio** or **Ollama** over an OpenAI-compatible API, and manages the runtime for you: with `summaryProvider` set to `lm-studio`/`ollama` it spawns the server, auto-loads `llmModel`, and idle-shuts-down after 10 min. The default is **`qwen/qwen3.5-9b`** — small enough to fit Apple Silicon VRAM on long transcripts.

**Reasoning models are supported but need care.** Models like Gemma, Qwen3, and DeepSeek-R1 "think" in a `<think>` channel before answering, which MeetingNotes handles at several layers:

- 🧠 **Badges** flag known reasoning models in the picker and onboarding.
- ✅ A **health-check canary** runs a cheap extraction on your chosen model and warns if it loops.
- 🔁 **Automatic re-sampling** — if a model spends its whole token budget thinking and returns nothing (an intermittent failure on some models), the stage re-samples at a higher temperature instead of hard-failing.
- ✂️ `<think>` blocks are **stripped** before rendering, and a **Disable model thinking** toggle sends `enable_thinking: false` where the model honors it.

> [!TIP]
> A **non-reasoning** chat model is the simplest, fastest choice and sidesteps the thinking-loop failure mode entirely. Reach for a reasoning model only if you specifically want its output quality.

## Removed legacy setup and rollback

The app no longer ships Python/PyTorch, starts Whisper/pyannote servers, downloads Whisper weights, accepts HF tokens or supports remote STT endpoints. Legacy setting rows, cached models, credentials and voice profiles are left on disk but ignored. They are not migrated into native profiles. To return to the old engine, quit and reinstall 1.15.0, preferably with a pre-upgrade Library backup.

SpeakerKit transitively uses WhisperKit audio utilities and pyannote-family Core ML models. That does not install or run Whisper ASR or the Python pyannote runtime. Public speaker-model downloads are still hosted on Hugging Face and require no account/token. See the [notices](../speech-beta-notices.md).
