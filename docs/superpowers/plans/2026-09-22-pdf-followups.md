# PDF export follow-up implementation

Scope: implement the ten improvements discussed after PDF export, including the Weekly timer and Google connection handling identified in the review. Preserve the existing uncommitted PDF work.

1. Split optional renderer views with a loading boundary; compare production bundles.
2. Add meeting-stage notifications to the IPC contract and pipeline; switch detail refresh to notifications with a slower fallback poll.
3. Lower Weekly narrative timer frequency and centralize Weekly payload types in the shared IPC contract.
4. Extract cohesive detail-view and IPC domains without changing their public behavior.
5. Define pure exporter metadata shared by main and renderer; use it for selection and save-dialog decisions.
6. Remove summary-embedded Action Items before Markdown/Google Doc append selected database items.
7. Clarify completed-item selection, show notes-only save confirmation, and surface/retry Google status failures.
8. Run focused tests at functional boundaries, then the full relevant suite and production build once on the final source tree. Update the review document with implementation status and residual limitations.
