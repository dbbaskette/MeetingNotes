# Models

MeetingNotes uses Apple SpeechTranscriber + SpeakerKit for speech, on Apple silicon/macOS 26+. An optional second transcription engine, WhisperKit, can be downloaded for harder audio. Notes and action items come from a separate LLM that you choose.

## Speech setup

Open Settings → Processing and click **Prepare native speech**. This explicitly provisions Apple language assets and about 11 MB of hash-verified SpeakerKit models pinned to revision `556fc52a13327837688f02289457cded017802e9`, SDK 1.1.1. Cancel and retry are available. No Whisper, Python installation, Hugging Face account/token, or gated approval is needed. The downloaded public models are hosted on Hugging Face; meeting audio is not uploaded. Inference uses local assets only. Language support is checked by Apple's API; `en` selects en-US.

Speech runs in a native helper that is started for each operation and exits afterwards. Transcription and speaker separation run in parallel. For a meeting of an hour or longer, a recording of unknown length, or when less than 2 GB of memory is free, they run one after the other so the two models are not loaded at the same time. The recording is never split into chunks for speaker separation, because that would change speaker identities across the recording.

### Optional: WhisperKit for higher accuracy

**Settings → Processing → Transcription engine** switches between **Apple Speech (Built-in)**, the default, and **WhisperKit Large-v3-Turbo (High accuracy)**. WhisperKit runs OpenAI's Whisper large-v3-turbo as a Core ML model inside the same native helper. There is still no Python, no server and no account or token.

- **Download:** choosing the engine downloads nothing. Click **Prepare native speech** to download about 627 MB from Hugging Face's public hosting (Argmax's `openai_whisper-large-v3-v20240930_626MB` build at a pinned revision, plus the Whisper tokenizer). Every file is checked against a pinned size and hash before it is installed. A cancelled or failed download resumes at the next file. Clicking the button again later re-verifies the installed files.
- **First use:** setup then loads the model once so macOS can optimize it for your Mac. On an M-series MacBook Pro this took about a minute; it can take several. macOS may repeat this after a system update, which makes the first meeting afterwards slower to start.
- **Speed:** slower than Apple Speech. In a test with 104 seconds of clean synthetic speech on that Mac, WhisperKit took about 7 seconds and Apple Speech about 1 second. Expect a few minutes for an hour-long meeting.
- **Accuracy:** in the same test WhisperKit spelled every name and product term correctly, and Apple Speech did not. One synthetic voice is not a benchmark; try it on your own meetings.
- **Your names and terms:** your Dictionary replacements and the people in your roster are given to the engine as vocabulary. With WhisperKit this changes spellings (for example "Kaitlynn" instead of "Caitlin"). Apple Speech accepts the same list, but on macOS 27.0 it made no difference in our tests.
- **Languages:** WhisperKit uses the language part of the speech language (`en`, `de`, `ja`) and supports languages Apple's assets may not.
- **Which meetings:** the choice applies to meetings processed from then on. Each run records the engine it used, shown under the meeting's processing details. To transcribe an existing meeting again with the other engine, reprocess it; its previous transcript and notes go to history. Processing never downloads a model: if the WhisperKit model is missing, processing stops with a message asking you to download it or switch back.
- **Storage:** `~/Library/Application Support/MeetingNotes/speech-models/whisperkit/`. It is outside the Library, so backups do not include it. Delete the folder to reclaim the space.

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

The app no longer ships Python/PyTorch, starts Whisper/pyannote servers, accepts Hugging Face tokens or supports remote STT endpoints. The optional WhisperKit engine above is a Core ML model run by the native helper, not the old `whisper-server` setup, and it is never downloaded unless you ask for it. Legacy setting rows, cached models, credentials and voice profiles are left on disk but ignored. They are not migrated into native profiles. To return to the old engine, quit and reinstall 1.15.0, preferably with a pre-upgrade Library backup.

SpeakerKit uses WhisperKit audio utilities and pyannote-family Core ML models. That does not run the Python pyannote runtime, and Whisper transcription runs only if you choose the WhisperKit engine. Public speaker-model downloads are still hosted on Hugging Face and require no account/token. See the [notices](../speech-beta-notices.md).
