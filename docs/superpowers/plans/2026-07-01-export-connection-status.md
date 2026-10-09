# Export Connection Status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Google export connection status at a glance in the meeting detail Export panel, instead of only discovering it's disconnected when reading the "(connect in Settings)" suffix on a disabled button.

**Architecture:** `RightRail` in `MeetingDetailView.tsx` already calls `api.google.authStatus()` on mount and stores only the `signedIn` boolean — the `email` field the same call returns is fetched and discarded. Widen the stored state to the full status object and render a small status line (colored dot + email or "not connected") above the two Google export buttons. Pure rendering change; no new IPC, no backend work.

**Tech Stack:** React renderer (Electron). No new tests — this codebase has no component-testing setup (no `testing-library`/`jsdom` dependency; the only renderer tests cover extracted pure functions), so verification here is manual, matching the existing pattern for JSX-only changes in this file.

**Non-goal:** Apple Reminders access is a macOS system permission, not an OAuth session — there is no persisted "granted" state anywhere in the app (confirmed: `apple-reminders.ts`'s exporter just attempts the write and surfaces a friendly error on failure). Building a live status indicator for it would mean proactively shelling out to `osascript` just to render a dot, which is a meaningfully different (and riskier) change than this plan's scope. Out of scope here.

---

### Task 1: Surface Google connection status inline

**Files:**
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx:1591-1598` (the `googleSignedIn` state + fetch effect)
- Modify: `electron/renderer/src/views/MeetingDetailView.tsx` (insert the status line before the Google buttons, currently starting at line 1679)

- [ ] **Step 1: Widen the fetched state to include email**

Replace the existing state + effect (`MeetingDetailView.tsx:1591-1598`):

```tsx
  // Google exporters are enabled once the user has signed in (Settings →
  // Google account). Fetched once when the rail mounts.
  const [googleSignedIn, setGoogleSignedIn] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.google.authStatus().then((s) => { if (alive) setGoogleSignedIn(s.signedIn); });
    return () => { alive = false; };
  }, []);
```

with:

```tsx
  // Google exporters are enabled once the user has signed in (Settings →
  // Google account). Fetched once when the rail mounts. We keep the full
  // status (not just the boolean) so the panel can show which account is
  // connected instead of making the user discover connection state only by
  // trying to click a disabled button.
  const [googleStatus, setGoogleStatus] = useState<{ email: string | null; signedIn: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    void api.google.authStatus().then((s) => { if (alive) setGoogleStatus(s); });
    return () => { alive = false; };
  }, []);
  const googleSignedIn = googleStatus?.signedIn ?? false;
```

`googleSignedIn` keeps its name and boolean type, so every existing reference (`!googleSignedIn`, `googleSignedIn ? '' : ' (connect in Settings)'`, the `disabled`/`title` props on both Google buttons) needs no changes.

- [ ] **Step 2: Render the status line above the Google buttons**

In `electron/renderer/src/views/MeetingDetailView.tsx`, immediately before the Google Tasks button (currently starting at line 1679 — the button with `→ Google Tasks{googleSignedIn ? '' : ' (connect in Settings)'}`), insert:

```tsx
        {googleStatus && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted px-0.5">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${googleSignedIn ? 'bg-status-ok' : 'bg-ink-muted/40'}`}
              aria-hidden
            />
            <span className="truncate">
              {googleSignedIn ? `Google: ${googleStatus.email ?? 'connected'}` : 'Google: not connected'}
            </span>
          </div>
        )}
```

This renders once the initial `authStatus()` fetch resolves (guarding on `googleStatus` being non-null avoids a flash of "not connected" before the real state is known).

- [ ] **Step 3: Verify manually in the running app**

Run: `npm run dev`
- Open a meeting's detail view with a Google account **not** connected: confirm a muted dot + "Google: not connected" appears above the Google Tasks/Doc buttons.
- Go to Settings, connect a Google account, return to the meeting: confirm a green dot + the connected email appears.
- Confirm the existing "(connect in Settings)" button-suffix text and disabled states are unchanged.

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "feat(export): show Google connection status inline in the Export panel"
```

---

## Self-Review

**Spec coverage:** Idea #5 — "show connection state proactively, not just at click-time" — is fully covered for Google (the only exporter with a real connection concept). The Apple Reminders non-goal is explicitly documented rather than silently skipped.

**Placeholder scan:** No TBD/TODO; complete JSX and state changes.

**Type consistency:** `googleStatus` type (`{ email: string | null; signedIn: boolean }`) matches the return type of `api.google.authStatus()` exactly (per `electron/preload/index.ts`'s `Promise<{ email: string | null; hasCredentials: boolean; signedIn: boolean }>` — we only destructure/use the two fields we need, which is fine since we assign the whole object). `googleSignedIn` remains a plain boolean derived via `?? false`, so no downstream JSX changes anywhere else in the file.
