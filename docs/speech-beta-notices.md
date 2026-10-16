# Native speech: third-party notices (regular app and comparison beta)

Speaker processing uses [Argmax SpeakerKit OSS](https://github.com/argmaxinc/argmax-oss-swift), pinned to v1.1.1 (see `speech-engine/Package.resolved`). SpeakerKit and its transitive Argmax modules use the MIT License, copyright Argmax, Inc. Their full [license](https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/LICENSE) and [third-party notices](https://github.com/argmaxinc/argmax-oss-swift/blob/v1.1.1/NOTICES) must accompany a distributed helper.

The downloaded [SpeakerKit Core ML models](https://huggingface.co/argmaxinc/speakerkit-coreml), by Argmax and the upstream pyannote contributors, declare [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). Revision: `556fc52a13327837688f02289457cded017802e9`. The beta uses the published W8A16 segmenter/embedder and W32A32 PLDA clusterer files without modifying their weights. Original per-model README attribution files are downloaded alongside the models. See the repository and the SDK's third-party notices for upstream contributors.

Apple SpeechTranscriber and system-managed speech assets are supplied by macOS, subject to Apple's terms. They are not included in the installer. The beta uses Apple's supported asset-provisioning API.

This beta does not use Argmax Pro SDK or a paid Argmax service. Downloading public assets does not upload meeting recordings. Initial setup needs internet; native speech inference runs locally after setup.
