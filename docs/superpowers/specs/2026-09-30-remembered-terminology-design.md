# Remembered terminology corrections

Status: approved by the user's “do it” on 2026-09-30 and implemented on `codex/remembered-terminology`. The user subsequently authorized PR, merge, release, and local installer publication for 1.12.7.

## Outcome

Teach MeetingNotes preferred words and phrases from deliberate corrections, such as `Salsa → SLSA`, so later transcripts and summaries can suggest or apply the same correction. Store this knowledge in the existing local library database. Keep learning unobtrusive and distinguish remembering a term from authorizing automatic replacement.

## Current code

- `electron/renderer/src/views/MeetingDetailView.tsx`: SummaryPanel has an explicit save action and the previous saved value, suitable for detecting short substitutions after a successful save.
- `electron/main/ipc/handlers.ts`: meetingsSaveSummary writes summary.md and invalidates the artifact cache.
- `electron/renderer/src/views/MeetingTranscriptPanel.tsx`: transcript reading/playback exists; a general transcript editor is not implemented on this branch. Older editable-transcript plans are not evidence of a shipped editor.
- `electron/main/pipeline/stages/merging.ts`: remergeTranscript rebuilds transcript.md from raw segments after speaker naming. Corrections must survive this path.
- `electron/main/pipeline/stages/summarizing.ts`: reads transcript.md and generates summary.md. Action extraction reads the saved summary.
- `electron/main/storage/db.ts` and migrations.ts: existing SQLite database and migrations can hold the dictionary and application history.
- `electron/main/lm-studio/client.ts`: STT client sends no vocabulary prompt today.

## Interaction

### Learn from a summary edit

After a successful save containing a small replacement, display one nonmodal inline card:

> Remember this correction?
>
> Salsa → SLSA
>
> Use in: [This group / All meetings]
>
> [ ] Automatically replace exact matches in future generated text
>
> [Remember] [Not now]

Default scope is the current named group, otherwise All meetings. Automatic replacement is unchecked by default. The saved edit is complete regardless of the learning choice. Dismissing or ignoring the card cannot prevent navigation or discard the saved document.

Detect isolated substitutions of 1–5 words and at most 80 characters on either side, including case-only corrections. Exclude insertions, deletions, paragraph rewrites, formatting-only changes, links, code, numbers-only edits, and ambiguous alignments. Use bounded local diffing with a work budget; if a large edit exceeds it, omit the suggestion. Do not make an LLM request to classify edits. Batch multiple candidates into one compact review control. Remember only explicitly selected pairs. Do not repeatedly prompt for existing rules or dismissed pairs in the same edit session. Provide an option to turn off learning offers while retaining manual dictionary management.

### Correct a transcript term

Add a keyboard-accessible `Correct term…` action to the transcript toolbar. A small panel accepts the existing term and preferred spelling, previews matching sentences, and lets the user choose occurrences in the current transcript. An optional Remember control uses the same scope and automatic-replacement choices as the summary flow. Full freeform transcript editing is outside this feature.

A manual dictionary Add action also supports corrections when diff detection is uncertain. Speaker identities and names continue to use the existing speaker-naming workflow.

### Reuse corrections

- Suggest mode: future matching prose offers a compact `Review terminology (N)` entry. Show source context and preferred wording; accept individual occurrences or selected matches, or dismiss them for that artifact revision. Unaccepted suggestions do not rewrite text or influence generation prompts.
- Automatic mode: apply approved exact whole-word/phrase rules within their scope when generating new transcripts and summaries. Show a small `N terminology corrections` detail link with before/after context and undo support.
- Summary generation receives the corrected transcript and a bounded glossary of automatic rules and explicitly accepted terminology for that meeting. Entries are terminology data, with instructions to preserve meaning and never invent mentions. Apply deterministic approved rules to eligible generated prose as well; prompt adherence alone is insufficient.
- Existing meetings are unchanged when a rule is saved, enabled, edited, deleted, or its scope changes. Applying to the current meeting requires an occurrence preview. No automatic historical backfill.
- Correcting a transcript marks its summary as out of date and offers regeneration. Do not automatically regenerate notes or action items. Correcting a summary does not silently edit its source transcript or existing action items.
- Search, exports, and later pipeline stages consume the saved corrected artifact, so the display and exported text agree.

### Manage memory

Add a searchable `Settings → Terminology` section listing `Heard/written as`, `Use instead`, scope, and Suggest/Automatic mode. Support Add, Edit, Disable, and Delete. Deleting a rule stops future use; it does not revert previously corrected documents. This is a local dictionary, not model training or a new remote service.

## Data and application rules

Use a `terminology_rules` repository/table in the existing library database: id, source text, normalized source key, replacement preserving exact capitalization, scope type (library/group), optional group id, mode, enabled, revision, and timestamps. Validate nonempty bounded plain-text terms in the main process; no user-supplied regex. Store a separate application/decision record identifying the meeting, artifact revision, rule revision or manual correction, selected occurrence, before/after text, and undo state. Limit stored context to what review/undo needs.

Use Unicode-aware whole-word/phrase matching, case-insensitive by default, while always emitting the user's exact replacement spelling. Support explicit case-sensitive matching in rule editing. Do not match substrings such as `Salsa` inside `Salsalito`. Exclude Markdown destinations, code spans/blocks, transcript timestamps, and speaker labels. Detect conflicting duplicate/overlapping rules; prefer the most specific group rule over a library rule, with longest nonconflicting phrase first. Apply against original text in one pass, never cascading replacements. Reject replacement cycles and conflicting mappings within a scope, and flag conflicts introduced by scope changes.

Preserve transcript.raw.json as the transcription output. Apply terminology to segment text before Markdown formatting. Bind occurrence decisions to the raw artifact fingerprint, segment identity, and original span, preserving times and speaker attribution. Speaker renaming/remerge reapplies the same persisted decisions. A fresh transcription must not reuse occurrence offsets from the old raw output; mark unmatched decisions for review and process new output with current applicable rules.

Snapshot applicable rule revisions and group scope when a stage begins. Editing a rule or moving a meeting during generation must not produce a mixture of old and new behavior. Moving meetings never rewrites their existing artifacts. Deleting a group removes or disables its rules; never promote them to library-wide rules through a nullable foreign key.

Persist correction decisions and derived artifact updates with a recoverable write protocol: stage writes, retain before/after fingerprints, invalidate caches, and publish completion only after required persistence succeeds. Reconcile interrupted pending applications on reopening. Reject stale preview commits if the document changed. Undo restores only the recorded correction when its expected text still matches; if subsequent manual edits overlap, show a conflict instead of restoring the entire old document. Undoing an automatic occurrence also records an exception for that artifact so the next speaker remerge does not immediately reapply it.

## Why this design

A global replace-all dictionary is predictable but can turn legitimate food-related “salsa” into “SLSA.” Automatic inference from every edit can learn stylistic rewrites or factual changes as spelling rules. Prompt-only guidance can be ignored by a model. Explicit learning, scoped rules, and deterministic opt-in application handle recurring terminology while keeping context-sensitive cases reviewable.

Whisper vocabulary hints are a later enhancement. Upstream whisper.cpp accepts a request prompt, but the app supports different server versions and endpoints and deliberately uses anti-hallucination settings. Validate compatibility and accuracy on repeatable audio fixtures before enabling hints; vocabulary bias is not a guarantee of correct transcription. Reference: https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/server.cpp

## Acceptance criteria

1. Saving `Salsa → SLSA` offers remembering the pair once and never saves a rule without confirmation; ordinary sentence rewrites do not prompt.
2. Suggest mode leaves future text unchanged until accepted; Automatic mode applies only eligible matches in the chosen scope.
3. Group-only rules do not affect ungrouped/other-group meetings. Deleting a group cannot broaden rule scope.
4. Case, punctuation, Unicode boundaries, phrase overlap, cycles, code, links, speaker labels, and timestamps have meaningful fixture coverage.
5. Raw transcript output stays intact. Corrected transcript text survives speaker remerge, matches exports/search, and preserves audio seeking.
6. Rule changes, meeting moves, stale previews, retranscription, and undo cannot overwrite unrelated edits or silently reinterpret old occurrences.
7. Dictionary persistence survives restart and library backup; settings can edit/disable/delete rules. Model endpoints receive only terminology needed for the relevant generation through the existing configured provider.
8. Detection and matching are bounded and local, with large-document checks; no extra model calls are required for learning or applying corrections.

## Scope exclusions

Model fine-tuning, cloud synchronization, semantic/fuzzy auto-replacement, full transcript editing, rewriting historical meetings in bulk, modifying speaker identities, and automatic regeneration of summaries/action items are follow-ups.
