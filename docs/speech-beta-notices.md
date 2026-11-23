# Native speech: third-party notices

These notices cover the native speech helper in the regular MeetingNotes app, which ships this file as `Contents/Resources/licenses/native-speech-notices.md` together with `licenses/Argmax-LICENSE` and `licenses/Argmax-NOTICES`. The separate comparison beta uses the same helper and models.

Speaker processing uses [Argmax SpeakerKit OSS](https://github.com/argmaxinc/argmax-oss-swift), pinned to v1.1.1 (see `speech-engine/Package.resolved`). SpeakerKit and its transitive Argmax modules use the MIT License, copyright Argmax, Inc. Their full [license](https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/LICENSE) and [third-party notices](https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/NOTICES) must accompany a distributed helper.

The downloaded [SpeakerKit Core ML models](https://huggingface.co/argmaxinc/speakerkit-coreml), by Argmax and the upstream pyannote contributors, declare [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). Revision: `556fc52a13327837688f02289457cded017802e9`. MeetingNotes uses the published W8A16 segmenter/embedder and W32A32 PLDA clusterer files without modifying their weights. Original per-model README attribution files are downloaded alongside the models. See the repository and the SDK's third-party notices for upstream contributors.

The optional WhisperKit transcription engine uses [Argmax WhisperKit](https://github.com/argmaxinc/argmax-oss-swift) from the same pinned v1.1.1 package and the same MIT License. Its model is downloaded only when you choose that engine in Settings → Processing and click **Prepare native speech**:

- [WhisperKit Core ML models](https://huggingface.co/argmaxinc/whisperkit-coreml) by Argmax, declared MIT. Variant `openai_whisper-large-v3-v20240930_626MB` (a compressed Core ML conversion of OpenAI's Whisper large-v3-turbo), revision `0f63a7800b00dd0226abd051b906c246e1907482`. The weights derive from [OpenAI Whisper](https://github.com/openai/whisper), MIT License, copyright OpenAI. MeetingNotes does not modify them.
- The Whisper tokenizer files `tokenizer.json` and `tokenizer_config.json` from [openai/whisper-large-v3](https://huggingface.co/openai/whisper-large-v3), declared Apache-2.0, revision `06f233fe06e710322aca913c1bc4249a0d71fce1`.

Every downloaded file is checked against a pinned size and hash before it is installed. These files are not included in the installer.

Apple SpeechTranscriber and system-managed speech assets are supplied by macOS, subject to Apple's terms. They are not included in the installer. MeetingNotes uses Apple's supported asset-provisioning API.

MeetingNotes does not use the Argmax Pro SDK or a paid Argmax service. Downloading public assets does not upload meeting recordings. Initial setup needs internet; native speech inference runs locally after setup.
