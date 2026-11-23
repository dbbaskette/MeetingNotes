# Models

MeetingNotes uses Apple SpeechTranscriber + SpeakerKit for speech, on Apple silicon/macOS 26+. It has been the only speech engine since 1.16.0. Notes and action items come from a separate LLM that you choose.

## Speech setup

Open Settings → Processing and click **Prepare native speech**. This explicitly provisions Apple language assets and about 11 MB of hash-verified SpeakerKit models pinned to revision `556fc52a13327837688f02289457cded017802e9`, SDK 1.1.1. Cancel and retry are available. No Whisper, Python installation, Hugging Face account/token, or gated approval is needed. The downloaded public models are hosted on Hugging Face; meeting audio is not uploaded. Inference uses local assets only. Language support is checked by Apple's API; `en` selects en-US.

Speech runs in a native helper that is started for each operation and exits afterwards. Transcription and speaker separation run in parallel. For a meeting of an hour or longer, a recording of unknown length, or when less than 2 GB of memory is free, they run one after the other so the two models are not loaded at the same time. The recording is never split into chunks for speaker separation, because that would change speaker identities across the recording.

Every installation uses native speech, including upgrades with saved legacy settings. Old roster names and legacy vectors remain. Confirm voices in native meetings to train model-tagged profiles; suggestions are similarities, not probabilities. Optional automatic matching in Settings → Processing is off by default and uses conservative score, separation and clean-speech checks; it is experimental, not calibrated identification. Automatic assignments do not train profiles. Only explicit human confirmations do. Invalid/missing vectors permit manual naming. Never compare or copy legacy vectors into the native space.

The [comparison beta](speech-beta.md) is a separate development app that is not part of the regular MeetingNotes app and never writes its copied results back to the regular library. See [upgrading from 1.15 or earlier](../../README.md#upgrading-from-115-or-earlier) and [SDK/model notices](../speech-beta-notices.md).

## Summaries and action items

MeetingNotes talks to any chat model in **LM Studio** or **Ollama** over an OpenAI-compatible API. By default (`summaryProvider` = `external`) you run the server yourself. With **Settings → Advanced → Summary provider** set to LM Studio (managed) or Ollama (managed), MeetingNotes spawns the server on demand, auto-loads `llmModel`, and shuts it down after 10 idle minutes. The default model is **`qwen/qwen3.5-9b`**, chosen to fit in Apple Silicon memory on long transcripts.

**Reasoning models are supported but need care.** Models like Gemma, Qwen3, and DeepSeek-R1 "think" in a `<think>` channel before answering, which MeetingNotes handles at several layers:

- 🧠 Known reasoning models are labelled **(reasoning)** in the model picker, in Settings and in first-run setup, with a warning under the picker.
- ✅ A **health-check canary** runs a cheap extraction on your chosen model and warns if it loops.
- 🔁 **Automatic re-sampling** — if a model spends its whole token budget thinking and returns nothing (an intermittent failure on some models), the stage re-samples at a higher temperature instead of hard-failing.
- ✂️ `<think>` blocks are **stripped** before rendering, and **Settings → Processing → Model thinking / reasoning effort** defaults to **Off**, which sends `enable_thinking: false` and `reasoning_effort: "none"` where the model honors them. **Minimal** and **Low** cap the effort; **Model default** sends no override.

> [!TIP]
> A **non-reasoning** chat model is the simplest, fastest choice and sidesteps the thinking-loop failure mode entirely. Reach for a reasoning model only if you specifically want its output quality.

## Removed legacy setup and rollback

The app no longer ships Python/PyTorch, starts Whisper/pyannote servers, downloads Whisper weights, accepts Hugging Face tokens or supports remote STT endpoints. Legacy setting rows, cached models, credentials and voice profiles are left on disk but ignored. They are not migrated into native profiles. To return to the old engine, quit and reinstall 1.15.0, preferably with a pre-upgrade Library backup.

SpeakerKit transitively uses WhisperKit audio utilities and pyannote-family Core ML models. That does not install or run Whisper ASR or the Python pyannote runtime. Public speaker-model downloads are still hosted on Hugging Face and require no account/token. See the [notices](../speech-beta-notices.md).
