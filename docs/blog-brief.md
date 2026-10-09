# Blog Brief: MeetingNotes

> **For:** Blogforge (or any writer drafting a blog post about MeetingNotes)
> **Purpose:** Everything you need to write an accurate, compelling blog post. Pick an angle below, follow the outline, hit the talking points, and respect the accuracy guardrails at the end.

---

## 1. One-paragraph elevator

**MeetingNotes** is a free, open-source (MIT) macOS app that turns any meeting into structured notes — transcript, identified speakers, a summary, and action items — without sending a single second of audio off your machine. You hit Record, pick which app's audio to capture (Zoom, Teams, FaceTime, Webex, etc.) plus your mic, and the whole pipeline — transcribe, diarize, identify speakers, summarize, extract action items — runs locally on Apple Silicon. No cloud, no uploads, no third-party recorder bot joining your call, and no API keys at inference time. You bring your own local AI models; MeetingNotes orchestrates everything else.

---

## 2. Recommended angle (primary)

**"The meeting notetaker that never uploads your meetings."**

The whole category — Otter, Fireflies, Fathom, Granola, Zoom AI Companion, and friends — is built on shipping your audio to someone's cloud, or dropping a bot into your call that everyone can see. MeetingNotes is the counter-position: same end result (clean summary + who-said-what + action items), but the audio, the transcription, the diarization, and the LLM summarization all happen on your own Mac. The hook is the tension between "I want AI meeting notes" and "I don't want my private conversations on someone else's servers" — and the resolution is local-first.

**Why this angle wins:** privacy-conscious professionals (legal, healthcare, finance, founders, anyone under NDA or compliance pressure) feel this pain acutely, and "local-first AI" is a rising, search-worthy theme. It's also simply true and easy to defend.

### Alternate angles (if a different framing fits the publication)
- **Build/engineering story:** *"How I stitched whisper.cpp, pyannote, and a local LLM into one on-device meeting pipeline."* Great for a dev/HN/Lobsters audience — focus on the architecture, the CoreAudio Process Tap, the managed-service lifecycle, the crash-safe pipeline.
- **"Bring your own models" / own-your-stack:** for the local-AI / LM Studio / Ollama community — MeetingNotes as the app layer on top of the local models they already run.

---

## 3. Audience & the takeaway

- **Primary reader:** a Mac user who takes a lot of meetings and is uneasy about cloud transcription tools — privacy-minded professionals, founders, consultants, people handling sensitive or regulated conversations, and the local-AI crowd.
- **What they should believe by the end:** "There's finally a way to get Otter-style meeting notes without my audio leaving my laptop — and it's free and open source."
- **What they should do:** clone the repo / read the README, try it, or star it on GitHub.

---

## 4. Working titles (headline options)

1. Your meetings shouldn't live in someone else's cloud
2. MeetingNotes: AI meeting notes that never leave your Mac
3. I built a local-first meeting notetaker — no cloud, no bots, no API keys
4. The privacy-first alternative to cloud meeting transcription
5. Meeting notes, transcription, and action items — 100% on-device
6. Stop uploading your meetings: a local-first notetaker for macOS

---

## 5. Suggested outline

1. **The hook (the problem).** You want AI meeting notes. You don't want your audio on a vendor's servers — or a bot visibly joining the call. Today you usually have to pick one.
2. **Meet MeetingNotes.** One sentence on what it is; the "all on your machine" promise.
3. **What it actually does — the flow.** Hit Record → pick the app's audio + mic → it records, transcribes, diarizes, identifies speakers, summarizes, and extracts action items. Walk the happy path.
4. **The part that matters: nothing leaves your Mac.** Spell out the local-first architecture in plain terms; contrast with cloud tools.
5. **The standout features.** Speaker ID with a roster you build over time; the speaker-ID gate; the structured summaries; the Weekly rollup; auto-detect + URL scheme; exporters (Apple Reminders, Markdown, webhooks, Google Tasks/Docs).
6. **Under the hood (optional, keep light for a general audience).** whisper.cpp, pyannote, a local LLM via LM Studio/Ollama, glued together on Apple Silicon.
7. **Honest requirements / who it's for.** macOS 14.2+ on Apple Silicon, ~16 GB RAM, bring your own local LLM, one-time HuggingFace setup. Not a one-click consumer app — it's for people who want control.
8. **Close.** Free, MIT-licensed, open source. Where to get it; the "you bring the models, it does the rest" line.

---

## 6. Key messages (hit these)

- **Local-first, full stop.** The entire pipeline runs on-device. No cloud, no uploads, no API keys at inference time, no third-party recorder to install.
- **It does the whole job, not half.** Many tools either just transcribe, or just summarize. MeetingNotes goes end-to-end: record → transcribe → diarize → identify speakers → summarize → extract action items → export.
- **No bot in your meeting.** It captures the audio your Mac is already playing (via a macOS system API), so there's no awkward "Recorder has joined the call." It records *your* machine, not the meeting service.
- **Who-said-what, not just a wall of text.** Diarization plus a voice-recognition roster you build over time means the transcript and summary attribute lines to real, named people.
- **You own your data and your models.** Everything is files and a local SQLite DB on your disk. You choose the local LLM (via LM Studio or Ollama). It's open source under MIT.
- **It fits how you already work.** Auto-detect meetings, a `meetingnotes://record` URL scheme for Shortcuts/Stream Deck, a weekly rollup, global search, and exporters into Reminders, Markdown, Slack/Telegram webhooks, and Google Tasks/Docs.

---

## 7. The "why" (problem framing for the intro)

Most meeting-transcription tools do one of three things you might not want:
1. **Ship your audio to a SaaS** — your private conversations live on someone else's infrastructure, subject to their retention, breaches, and training policies.
2. **Lock you into their recorder/bot** — a visible participant joins your call, and you're stuck in their ecosystem.
3. **Only do half the job** — transcript but no summary, or summary but no speaker attribution or action items.

MeetingNotes' answer: run the entire pipeline locally, capture the audio your Mac is already producing (no bot), and go all the way from raw audio to exportable action items.

---

## 8. How it works (accurate, plain-English version)

The flow, in order:

1. **Capture.** A small bundled macOS helper uses the **CoreAudio Process Tap** (the API Apple shipped in macOS 14.2 for exactly this) to record any app's audio plus your microphone into a mixed audio file — no virtual audio devices, no meeting bot.
2. **Transcribe.** Local speech-to-text via **whisper.cpp**, Metal-accelerated on Apple Silicon, with a filter that suppresses common transcription hallucinations.
3. **Diarize.** **pyannote** (running in a local Python helper) figures out *when* each distinct voice is speaking, on the same audio so timestamps line up with the transcript.
4. **Identify speakers.** Voice embeddings are matched against a **roster you build over time**, so "Speaker 1" becomes a real name. Unknown voices pause the pipeline at a **speaker-ID gate** where you can play an 8-second sample and name them (or skip).
5. **Summarize + extract action items.** A **local LLM** (your choice, run via LM Studio or Ollama) produces a structured summary and pulls out action items. Reasoning models are supported — internal "thinking" is stripped before rendering.
6. **Export.** Push results to Apple Reminders, Markdown, an HTTPS webhook (Slack/Telegram/JSON templates), or Google Tasks/Docs.

The local model runtimes (whisper, the diarization helper, the LLM) **start on demand and shut down when idle** to keep memory use low. The pipeline is crash-safe — if the app dies mid-run, it resumes on next launch.

---

## 9. Standout features worth calling out

| Feature | What to say about it |
| --- | --- |
| **Capture without a bot** | Records the audio your Mac is already playing via a native macOS API — nothing joins the meeting. |
| **Speaker ID + roster** | Learns voices over time; attributes the transcript and summary to named people, not "Speaker 1." |
| **Speaker-ID gate** | Pauses to let you name unknown voices (with a play-sample button) before summarizing — or skip it. |
| **Structured summaries** | Overview, Key Discussion Points, Decisions, Action Items, Follow-ups, Open Questions — with small talk shunted to an "Off-topic" section so the business stays front-and-center. Editable in-app. |
| **Weekly rollup** | A Mon–Sun view: an LLM narrative of the week, cross-meeting "Themes," open action items grouped by owner, and key decisions — cached so it's instant. |
| **Meeting auto-detect** | Optional: spots known meeting URLs in your browser, or native calls in Zoom/Teams/Webex/FaceTime, and offers one-click record (or auto-records Zoom). |
| **URL scheme + automation** | `meetingnotes://record?source=zoom.us` — wire it into a Shortcut, Stream Deck, or calendar trigger. |
| **Exporters** | Apple Reminders, Markdown (with editor + live preview), HTTPS webhooks (Slack blocks / Telegram / JSON), and Google Tasks + Google Docs. |
| **Global search** | ⌘K across every title, summary, and transcript. |
| **Click-to-play transcript** | Timestamps seek the audio player; it keeps playing while you edit. |

---

## 10. Proof points / facts to anchor the piece (verified)

- **Platform:** macOS 14.2 (Sonoma) or later, **Apple Silicon only**.
- **Cost / license:** Free, **open source, MIT-licensed**.
- **Current version:** 1.6.x (latest release line; v1.6.0 added focus-mode action items plus Google Tasks/Docs export).
- **On-device components:** whisper.cpp (transcription), pyannote 3.1 (diarization), a local LLM via LM Studio or Ollama (summarization + action items).
- **Default LLM:** `qwen/qwen3.5-9b` (configurable; any chat model your runtime can load).
- **Storage:** meetings, transcripts, summaries, and a SQLite DB live under your `~/Documents` and `~/Music` folders — plain files you own.
- **Recording format:** AAC mono; a one-hour meeting is roughly 60 MB.
- **Privacy posture:** no data leaves the machine unless *you* turn on the webhook/cloud exporters and configure a destination.

---

## 11. Honest requirements & limits (don't oversell — include these)

- **Apple Silicon Mac on macOS 14.2+**, ~16 GB RAM minimum (Whisper + a ~9B LLM run locally).
- **Bring your own LLM runtime:** LM Studio or Ollama with a chat model installed. The app manages the runtime lifecycle, but you install the runtime.
- **One-time setup friction:** accept three pyannote model licenses on Hugging Face and paste a (free) HF token once; install a couple of command-line tools via Homebrew. This is a power-user / control-oriented app, not a one-tap consumer install — say so.
- **macOS permissions:** grants for microphone and "Screen & System Audio Recording" on first record (this is normal and scoped to MeetingNotes).
- **Experimental:** the "All system audio" catch-all capture path is still experimental; per-app capture is the solid path.

---

## 12. Quotable lines / pull quotes (use or adapt)

- "No cloud, no uploads, no API keys at inference time, no third-party recorder to install."
- "You bring the models. MeetingNotes orchestrates everything else."
- "It records your machine — not the meeting. Nothing joins your call."
- "Who said what, and what to do next — without your audio ever leaving your Mac."
- "Local-first meeting notes for macOS."

---

## 13. SEO keywords & phrases to weave in

Primary: *local meeting transcription*, *on-device meeting notes*, *private meeting transcription*, *offline meeting notes app*, *local-first AI meeting notes*, *macOS meeting transcription*.

Secondary: *Otter alternative privacy*, *Fireflies alternative self-hosted / local*, *transcribe Zoom locally*, *speaker diarization on Mac*, *whisper.cpp meeting notes*, *Ollama / LM Studio meeting summary*, *meeting action items extraction*, *no bot meeting recorder*.

---

## 14. Tone & style

- Confident, plain-spoken, a little opinionated — it's fine to take a clear stance on privacy.
- Technical-credible but not jargon-heavy; explain whisper/pyannote/LLM in a sentence each for a general reader.
- Avoid generic SaaS filler ("streamline your workflow," "revolutionize meetings"). Be specific and concrete.
- Length: a 700–1,100-word post fits the primary angle well; the build-story angle can run longer.

---

## 15. Call to action & links

- **Repo / get it:** https://github.com/dbbaskette/MeetingNotes
- Suggested CTA: "It's free and open source — clone it, try it, and if your meetings shouldn't live in someone else's cloud, star it."

---

## 16. Visual assets available (in the repo)

- `docs/banner.png` — project banner.
- `docs/screenshots/` — `library.png` (the meeting list), `recording.png` (live recording with VU meter), `speaker-id.png` (the naming gate), `summary.png` (finished summary + speakers). Good for inline figures.
- `brag-output/brag.mp4` — a ~19s launch/teaser video; embeddable at the top of the post or for social.

---

## 17. Accuracy guardrails (please respect)

**Do:**
- Frame competitors as a *category* ("cloud meeting tools," and you may name examples like Otter/Fireflies/Fathom/Granola/Zoom AI Companion as context). Keep all *claims about MeetingNotes* exact, per this brief.
- Make clear that capture is of the audio on your Mac via a macOS system API — it does **not** join or integrate with the meeting service itself.

**Don't:**
- Don't claim it's cross-platform — it's **macOS + Apple Silicon only**.
- Don't claim "zero setup" or "one click" — there's a real one-time setup (LLM runtime, HF token, Homebrew tools).
- Don't say it ships with or downloads an LLM for you in a turnkey way — **you bring the model** (via LM Studio/Ollama).
- Don't assert specific negative claims about named competitors' security/policies — stick to the general, defensible contrast (cloud upload vs. on-device).
- Don't imply it works without internet for *setup* — initial model/license downloads need the network; *inference* afterward does not.
- Don't overstate the experimental "All system audio" mode as a finished feature.
