# Meeting groups — design

Status: approved and implemented locally; mockups remain design references rather than screenshots.

## Goal and product shape

Let people collect related recordings (for example, a customer, project, or recurring meeting) without changing how capture, processing, or the existing Library work. A group is an optional organizational label, not a folder on disk. One meeting belongs to at most one group in this first version. Existing meetings remain ungrouped. This keeps the everyday action unambiguous: **Move to group**. Multiple simultaneous memberships would need a different label and interaction model; that is deliberately out of scope.

The Library remains the single home for recordings. Do not add a Groups tab or permanent sidebar. Put a compact scope selector in its existing section header, above the status filters. The default is **All meetings**; the menu also contains named groups, **Ungrouped**, and **New group…**. A selected group changes the Library title, count, rows, search scope, and status counts; status chips and sort keep their current behavior within that scope. The global queue and Needs attention panel stay outside the scope and continue to show actionable items from all groups.

Mockups: [all-meetings selector](../../mockups/meeting-groups-library.png), [group-scoped Library](../../mockups/meeting-groups-scoped.png), and [capture picker](../../mockups/meeting-groups-capture.png). These are interaction proposals, not screenshots of implemented code.

## Core interactions

1. The scope selector lists `All meetings`, alphabetized named groups with live meeting counts, `Ungrouped`, then a separated `+ New group…`. A long menu scrolls and includes a name filter. Empty groups remain visible. The selected scope persists locally across navigation/restart. If the group is removed, fall back to All meetings with a toast.
2. Create group asks for a name in a small dialog, validates trimmed, nonblank, case-insensitively unique names, and then selects it. Group rename and delete live in the selected group's `…` menu, not on every row. Delete confirmation says that recordings are not deleted; their group assignment is cleared. No audio or meeting folder moves.
3. A row `…` menu gains **Move to group…** with `Ungrouped`, existing groups, and `+ New group…`. The detail header displays a quiet, clickable group chip under the title; choosing it opens the same picker. An All-meetings row shows its group as small metadata only when one exists; group-scoped rows need no repeated group badge. Bulk selection gains **Move to group** alongside current Process/Delete actions. Preserve selected IDs when moving, show moved/failed counts, and offer Undo for successfully changed IDs. If moved out of the current scope, the row leaves the list immediately after refresh.
4. Capture keeps source selection as one click. A subordinate **Save to group** dropdown sits in the source picker, defaulting to the currently selected named group when launched from that scope and otherwise `Ungrouped`. Changing it does not select a source or start capture. The meeting-detected banner gets a small changeable `Save to: …` chip beside its one-click Record action, with the same default. It is optional and never blocks recording. Record session metadata stores the group ID before the capture can be cataloged. The watcher/capture recovery path applies that assignment atomically when the meeting is first cataloged, including if the app restarts before finalization. Auto-restart and manual fallback/restart carry forward the same intended group; a user can change it later. Imports and Audio Hijack files stay ungrouped until assigned.
5. Inline Library search is scoped to the selected group (or Ungrouped); its helper copy says where it is searching. This filtering must happen before any hit cap, not merely after hydration. `⌘K` quick search remains global and shows each result's group name for orientation. Opening a result does not silently change the selected Library scope. Back follows existing navigation behavior.

## Layout and accessibility

Keep the app's white surfaces, subtle borders, indigo accent, type scale, row height, status chips, and current three-column detail layout. The selector is the only new primary visual element; its small indigo folder mark indicates an active named group. The capture field is secondary to the audible source list. Group names truncate in rows, menus, and the detail chip, with full names in accessible labels/tooltips. At narrow widths, the Library header wraps before the status chips; the existing search field keeps its minimum width. Menus use buttons, focus management, Escape to close, visible focus rings, arrow-key navigation, and screen-reader labels. No color alone communicates group membership.

Empty states distinguish `No meetings in this group`, `No matches in this group`, and `No meetings with this status in this group`, each with a relevant escape (`Show all meetings` or clear search/filter). Removing a group never changes processing state or notes. Weekly view stays cross-group.

## Data and API contract

Migration 17 adds `groups(id, name, created_at, updated_at)` with a normalized-name uniqueness key, nullable `meetings.group_id` referencing groups, and nullable `recording_sessions.group_id` for capture intent. Group deletion sets both references to null in a transaction. Preserve group ID on soft delete/restore; hard deletion follows existing meeting cleanup. Index live meetings by group for paging/counts. Do not rename or move on-disk meeting folders.

Extend `MeetingSummary`/detail responses with optional group ID/name. Add validated IPC for group list/create/rename/delete and a bulk assignment endpoint that takes explicit meeting IDs and a nullable group ID, validates existence and limits batch size, and returns per-ID outcomes plus prior assignments for Undo. `meetings:list-page`, scoped counts, list-IDs, and inline content search accept an optional scope (`all` | `ungrouped` | group ID). Cursors must bind to scope as well as sort/filter so they cannot silently continue into another group. Keep older calls defaulting to `all`. Use parameterized SQL; no group ID/name becomes SQL text or a filesystem path.

Recording start accepts an optional validated group ID. Persist it in the session row as part of starting capture, not after the renderer receives a session ID. Thread that intent through the source picker, detected-meeting banner, and any restart/fallback path. Cataloging looks up the session by canonical output path and applies its group ID in the same database transaction as meeting insert; repeated watcher events are idempotent. If a group was deleted while recording, catalog as ungrouped. If the built-in helper never creates a meeting, no ghost meeting or group entry appears.

## Alternatives considered

- Permanent sidebar: efficient for dozens of groups, but crowds the current compact Library and the three-column detail UI. A searchable selector scales without rearranging the app.
- Top-level Groups tab: separates recordings from their existing filters/search and makes a routine organizational action feel like navigation to another product area.
- Tags/many-to-many groups: useful for overlapping themes, but changes **Move** into **Add/Remove**, complicates count and bulk semantics, and is more than the stated need. Revisit if real use cases require a meeting in two places at once.
- Physical folders: risks breaking audio paths and recovery; organization should remain database metadata.

## Acceptance and risk checks

- All existing meetings, search, recording, recovery, processing, export, and weekly summaries behave as before with no groups created.
- New group, rename, assign, bulk assign, remove, and delete all work; deleting a group leaves every meeting/audio file intact.
- Scoped counts, paging, search hit limits, select-all-matching, and status filters agree on the same set of live meetings at large Library sizes. A cursor from one scope is rejected in another.
- Capture group assignment survives stop/catalog race and restart/recovery. Tests cover duplicate watcher callbacks and deletion during capture.
- Keyboard and narrow-window use are checked; popovers remain reachable above the bottom status bar.
