# Capture, Recovery, Attention, and Speaker Review UX

Issues: #176, #177, #178, #179

## Goals

Make recording failures understandable while a call is still running, keep usable audio recoverable when finalization or indexing fails, collect meetings that need intervention in one place, and reduce the work needed to confirm speaker identities.

## Capture health (#176)

The native helper will report levels independently for microphone, captured app/system audio, and the mixed recording stream. The renderer will treat the first few seconds as a startup preflight and then show three compact, source-named indicators instead of one ambiguous meter.

Warnings will name the failing path:

- microphone active, app silent: app audio is not detected;
- app active, microphone silent: microphone audio is not detected;
- both silent: neither input is detected;
- inputs active, mixed output silent: the recording output is not updating.

Any healthy stream prevents the old generic “No audio detected” message. When app capture is silent, the row offers a confirmed restart using All System Audio. Stopping reports which streams were observed so a mic-only capture is not described as empty.

For compatibility with an older helper, level events without a source are treated as mixed output.

## Recovery inbox (#177)

Recovery is based on durable `recording_sessions` records, not an unrestricted filesystem scan. This avoids presenting arbitrary media files as failed meetings. The scanner re-evaluates primary, voice, and system stems each time the inbox is loaded and excludes any audio already present in the meeting catalog.

Each item shows when it was captured, the app/source label, duration, size, and a plain-language reason. Actions are:

- Recover: index the valid primary recording, or copy a valid microphone stem to a new recovered file and index that copy.
- Trim and recover: create a new trimmed file and index it.
- Reveal in Finder: show the original recording.
- Dismiss: persist dismissal on the recording session.

Original files and stems are never modified. A successful recovery becomes a normal pending meeting and disappears from recovery on the next scan. Repeated actions are idempotent because catalog lookup uses the resolved audio path.

## Needs attention (#178)

The Library gets a single compact panel generated from meetings plus recovery items. It orders items by urgency and age and groups them as:

1. capture/recovery warnings;
2. failed processing;
3. waiting for speaker confirmation;
4. pending processing.

Every item has one primary next action and links directly to the relevant meeting or recovery action. The panel is omitted when there are no items. “Incomplete review” is represented by the existing speaker-identification gate; transient, unsaved editor state remains local to the editor instead of being guessed globally.

## Speaker review (#179)

The speaker panel will augment its existing playable samples and ranked suggestions with review metadata derived from diarization and transcript data:

- confidence label: Unknown, Probably <name>, or Confirmed;
- a “Needs review” cue for unlinked, low-confidence, or very small samples;
- speaking duration and affected transcript-line count;
- a preview count before rename, merge, or assignment.

Unresolved speakers can be selected and assigned to one roster person in one bulk operation. The main process applies all links and performs transcript re-merge once, so the operation is atomic from the user’s perspective and substantially cheaper than repeating single assignments. Existing one-click suggestions remain available.

## Safety and failure behavior

- Recovery creates new files and does not rewrite capture originals.
- Empty or unreadable media stays visible with an explanation and Reveal/Dismiss actions.
- A failed bulk speaker assignment reports an error and refreshes only after success.
- Restarting capture with All System Audio requires explicit confirmation because it stops the current session.
- Existing single-source helper events and existing meetings remain supported.

