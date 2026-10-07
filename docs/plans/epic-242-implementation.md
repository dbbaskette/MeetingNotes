# Epic 242 execution record

Approved scope: GitHub #242 and its 12 child issues. Base: b28a1e7.
Branch: codex/epic-242. Publish as a PR and merge after required gates.
The owner subsequently requested a 1.14.0 minor-version bump and combined release
notes. No release publication, installation, real-account export or ambient recording.

## Slices

- [x] #167/#168/#216/#232: start arbitration, URL validation, detector latches,
  stop/restart reconciliation, preserved intent, source refresh.
- [x] #173: clock-driven bounded native mix; aligned stems; decoded synthetic
  fidelity/gap/stop tests. Keep mixed-input processing until stem acceptance.
- [x] #169/#172: ownership parity, transport/templates, stable delivery IDs,
  paginated single-flight task-list resolution.
- [x] #183: compact readiness, shared model picker/download verification,
  explicitly initiated disposable recording test, quiet stream diagnostics.
- [x] #180/#231: primary guided status, bounded inline speaker review, full
  attention backlog, technical details and retry history.
- [x] #198: opt-in processing only for finalized new native sessions.
- [x] #36: packaged compatibility baseline; safe resource policy; synthetic
  packaged smoke, measured sizes/build time and documented rollback.

## UI contract

Extend existing MeetingNotes tokens/typefaces rather than introduce a new theme.
Use sentence-case labels, compact readiness rows linked to existing Settings
sections, and one primary processing status. Keep detailed diagnostics and long
lists behind explicit disclosure. Refresh/Retry and test capture are explicit;
no implicit source/destination changes. Retain existing timeline, speaker samples,
bulk assignment, notes history, queue controls and Obsidian behavior.

## Verification

Targeted checks at coherent milestones; full clean-Mac CI for the final tracked
tree, packaged-app smoke for runtime claims, scoped lint/type/build, safe synthetic
UI fixtures and abuse/failure tests. Retain logs and limitations. Actual microphone
or call capture requires separate explicit intent; synthetic fixtures never establish
real hardware acceptance. The owner subsequently authorized issue closure while
deferring live hardware checks; document that limitation and provide the checklist.

## Progress/evidence

Implementation and automated verification complete. Source full-suite gates at
`0ff5e2a`: 1,166 pass / six skipped, native AAC/timeline/TTS, types/build/lint,
benchmark and seven UI fixtures. Affected 1.14.0 renderer/package follow-up at
`8d1a144`: PASS on a disposable clean Mac. Actual packaged normal/software Library
rendering on the granted host, real permission-gate rendering in the ungranted
VM, helper enumeration and offline synthetic-speech diarization pass.

The checked #173 slice reflects owner-authorized completion with live hardware
acceptance deferred, not hardware PASS. Mixed processing remains intentional;
independent stems are disabled. See the [verification report](../epic-242-verification.md)
and [device checklist](../reliable-capture-processing.md#user-verification-checklist-deferred-by-request).
