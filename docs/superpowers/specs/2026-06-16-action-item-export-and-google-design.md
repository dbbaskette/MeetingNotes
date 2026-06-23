# Focused Action-Item Export + Google Integration — Design

**Date:** 2026-06-16
**Status:** Approved (brainstormed)

## Problem / Goals

Improve how action items leave the app, for maximum usability and flexibility:

1. **Only my items to task apps.** Exports to Apple Reminders and Google
   Tasks should contain only the action items assigned to *me*, with an
   on-screen reminder so it's never a surprise. Document exports (Markdown,
   Google Doc) stay complete — they're shareable records, not a personal
   to-do list.
2. **Google Tasks for real.** The current `GoogleTasksStub` throws; replace
   it with a working exporter.
3. **Google Doc export.** Alongside Markdown, export a meeting to a real
   Google Doc and hand back its URL.
4. **Google account sign-in in Settings.** Writing to a user's Tasks/Docs
   *requires* OAuth user auth (there is no API-key or service-account path
   for personal accounts), so add a "Sign in with Google" flow.

## Key decisions (resolved during brainstorming)

- **OAuth is mandatory** for Tasks/Docs writes. Confirmed: no API-key path.
- **BYO credentials, hybrid-ready.** The auth layer reads an OAuth Client
  ID + Secret from Settings (the user creates a Google Cloud "Desktop"
  client once, guided). This avoids any dependency on us getting the app
  Google-verified and the "testing mode" 7-day refresh-token expiry. The
  layer falls back to a baked-in default client ID when the BYO fields are
  empty, so a shipped one-click default can be added later without rework.
- **Filter scope:** "only mine" applies to **task apps** (Reminders, Google
  Tasks). Markdown + Google Doc export the full meeting.
- **Refresh token stored via Electron `safeStorage`** (OS keychain
  encryption), not plaintext SQLite.

## Existing architecture (anchors)

- Exporter interface: `electron/main/exporters/interface.ts` —
  `Exporter { name; export(input: ExportInput): Promise<string> }`,
  `ExportableItem`, `ExportInput`.
- Registry: `electron/main/exporters/registry.ts` `buildExporterRegistry()`.
  Today: `markdown`, `reminders`, `google-tasks` (stub), optional `webhook`.
- IPC dispatch: `export:run` in `electron/main/ipc/handlers.ts` — looks up
  the exporter, passes `items` (resolved from `itemIds` or all open),
  `summaryMd`, `outputPath`, `onItemExported`.
- Owner filter (webhook only today): `filterActionItems(items,
  userSpeakerId, 'mine'|'all'|'none')` in `exporters/webhook.ts`.
- Action items: `action_items` table has `owner_speaker_id` (roster FK),
  `owner_name` (freetext), `status`, `exported_to`. `ActionItemsRepo`
  (`listByMeeting`, `markExported`, …).
- Settings: `electron/main/storage/settings-repo.ts` — `userSpeakerId`,
  `exporterApple/Markdown/Webhook`, `webhookOwnerFilter`, etc.
- Export UI: `MeetingDetailView.tsx` RightRail — buttons → `ExportPickerModal`
  with per-item checkboxes → `api.export.run(...)`.
- No Google/OAuth/keytar/safeStorage anywhere today. Secrets are plaintext
  in SQLite.

---

## Part A — "Only my items" for task apps + reminder (Phase 1, no auth)

### "Mine" matching
New shared helper (e.g. `electron/main/exporters/owner-filter.ts`):
```
isMyItem(item, { userSpeakerId, userDisplayName }): boolean
```
True when `item.ownerSpeakerId === userSpeakerId`, OR (`userDisplayName` set
and `item.ownerName` trim/case-insensitively equals it). Handles the
freetext-owner case the webhook filter misses. `userDisplayName` is resolved
from the roster entry for `userSpeakerId`.

### Enforcement
- **Server-side (defense-in-depth):** in the `export:run` handler, for
  task-app exporters (`reminders`, `google-tasks`) filter the resolved items
  to `isMyItem` open items before calling `exporter.export`. If
  `userSpeakerId` is null, return a typed "identify yourself" result.
- **Client-side:** the export modal, when the target is a task app, lists
  only my items and shows a banner: *"Only action items assigned to you are
  sent to Reminders / Google Tasks."* The RightRail shows a persistent
  one-liner under those buttons. If `userSpeakerId` is unset, the task-app
  buttons are disabled with a "Set who you are in Settings → You are…" hint.

### Tests
`owner-filter.test.ts`: speaker-id match, freetext-name match (case/space),
null userSpeakerId → none, done items excluded. Handler test: task export
drops others' items; document export keeps all.

---

## Part B — Google auth layer (Phase 2)

### `GoogleAuth` module (`electron/main/google/auth.ts`)
A small, testable (injected `fetch`) controller:
- `getClientCredentials()` → BYO from settings, else baked-in default
  (initially empty → BYO required).
- `startSignIn()`:
  1. Spin up a one-shot loopback HTTP server on `127.0.0.1:<random>` with a
     `/callback` route.
  2. Build the consent URL (scopes `auth/tasks` + `auth/drive.file`,
     `access_type=offline`, `prompt=consent`, random `state`), open it in the
     system browser via `shell.openExternal`.
  3. On callback: verify `state`, exchange `code` → `{access_token,
     refresh_token, expiry}` at Google's token endpoint.
  4. Fetch the account email (userinfo or `tasks`/Drive `about`), persist:
     refresh token encrypted via `safeStorage`, email + expiry in settings.
  5. Close the loopback server; resolve with the email.
- `getAccessToken()`: returns a live token, refreshing via the stored refresh
  token when expired. In-memory cache.
- `getConnectedEmail()` / `isSignedIn()` / `signOut()` (clears token + email).

### Token storage
- `googleRefreshTokenEnc` (base64 of `safeStorage.encryptString`) — settings.
- `googleAccountEmail`, `googleClientId`, `googleClientSecret`,
  `googleTokenExpiry` — settings. Secret stored as-is (desktop-client secret
  is non-confidential per Google's model); refresh token always encrypted.
- If `safeStorage.isEncryptionAvailable()` is false (rare), fall back to a
  clear note that Google export is unavailable rather than storing plaintext.

### IPC
- `google:auth-start` → runs `startSignIn`, returns `{ email }` or throws.
- `google:auth-status` → `{ email | null, hasCredentials: boolean }`.
- `google:sign-out` → clears tokens.

### Tests
`auth.test.ts` with injected fetch + fake token endpoints: code→token
exchange, refresh-on-expiry, state mismatch rejected, signOut clears. Loopback
server logic factored so the URL/state building is unit-testable without a
real browser.

---

## Part C — Google Tasks exporter (Phase 3)

`electron/main/exporters/google-tasks.ts` (replaces the stub), constructed
with a `GoogleAuth` (injected via registry deps, like webhook):
- Resolve/create a "MeetingNotes" task list (GET tasklists, match by title,
  POST if absent — idempotent).
- For each item passed in (already filtered to *mine* + open by the handler):
  POST a task: `title = item.text`, `notes` = meeting title for context,
  `due` = `dueDate` as RFC3339 when present. Call `onItemExported(id)` per
  success.
- Returns `"N tasks added to Google Tasks"`; partial failures reported.
- Auth/token errors surface as a clear "reconnect Google" message.

### Tests
Injected fetch + fake auth: list-or-create list, insert tasks, due-date
formatting, partial failure, unauthenticated → typed error.

---

## Part D — Google Doc exporter (Phase 4)

`electron/main/exporters/google-doc.ts`, constructed with `GoogleAuth`:
- Build the **same content as the Markdown exporter** (summary + all action
  items). Convert markdown → HTML for fidelity (add `remark-html`/`marked` as
  a small main-process dep — the renderer's `react-markdown` doesn't expose a
  string→HTML path), or, if we want zero new deps, upload as `text/markdown`
  which Drive can also import to a Doc (slightly lower formatting fidelity).
  Decide at implementation; HTML is preferred.
- Resolve/create a "MeetingNotes" Drive folder (idempotent by name + query).
- `files.create` multipart upload: HTML body with target mimeType
  `application/vnd.google-apps.document` (Drive converts to a Doc), parent =
  the folder, name = meeting title (+ date).
- Return the Doc's `webViewLink`; the renderer shows an "Open in Google Docs"
  link and copies the URL.

### Tests
Injected fetch + fake auth: folder resolve/create, multipart payload shape
(mimeType conversion), returns link, error handling.

---

## Settings & UI

- **Settings → "Google account"** section:
  - Not configured: Client ID + Secret inputs + **"How to get these"** link
    to `docs/google-setup.md` (Cloud Console walk-through: create project,
    enable Tasks + Drive APIs, configure consent screen, create Desktop
    OAuth client, publish to production for non-expiring tokens).
  - **Sign in with Google** button (enabled once credentials present).
  - Connected: shows account email + **Sign out**; enables the Google
    exporters.
- **Export UI (RightRail / modal):**
  - Google Tasks button enabled only when signed in (replaces "(soon)").
  - New **Google Doc** button next to Markdown (enabled when signed in).
  - Task-app reminder line + modal banner (Part A).
- New IPC surfaced via preload `api.google.{ authStart, authStatus, signOut }`.

## Security

- Refresh token: `safeStorage` (OS keychain). Never logged.
- OAuth: random `state`, loopback `127.0.0.1` only, one-shot server torn down
  after the exchange; PKCE if the flow supports it cleanly.
- Desktop client secret is non-confidential by Google's design; documented as
  such.

## Non-goals (YAGNI)

- No auto-fire of Google exports on pipeline completion (manual, like
  Reminders/Markdown today). Possible later via the webhook-style second
  entry point.
- No full Drive scope (only `drive.file`).
- No shipped default client ID in v1 (architecture supports it; ship BYO).

## Implementation phasing

1. **Part A** — owner filter + reminder UI (no Google).
2. **Part B** — `GoogleAuth` + Settings sign-in + IPC + `safeStorage`.
3. **Part C** — Google Tasks exporter (uses A's filter + B's auth).
4. **Part D** — Google Doc exporter (uses B's auth).

Each phase is independently shippable and testable.

## Risks

- **Google verification / consent UX:** BYO sidesteps it; the setup guide
  must be clear or users stall. Mitigate with a thorough `docs/google-setup.md`
  and inline hints.
- **Drive markdown/HTML → Doc conversion fidelity:** HTML upload is the most
  reliable; complex markdown may render imperfectly — acceptable for a
  meeting summary.
- **`safeStorage` availability** on first run before the app is "ready" —
  guard with `isEncryptionAvailable()`.
- **Token revocation / scope changes:** surface a "reconnect Google" path
  rather than silent failures.
