# MeetingNotes URL scheme

MeetingNotes registers itself as the handler for `meetingnotes://` URLs on macOS. This lets any external process — a Shortcut, an Alfred / Raycast action, a launchd job, a shell script — start a recording, stop the active recording, or focus a meeting in the library without touching the UI.

## Verbs

| URL | Action |
| --- | --- |
| `meetingnotes://record` | Start a recording of system audio (everything currently playing). |
| `meetingnotes://record?source=<keyword>` | Start a recording of a specific app. Known keywords: `zoom`, `teams`, `slack`, `facetime`, `discord`, `whatsapp`, `all`. |
| `meetingnotes://record?source=<bundle-id>` | Start a recording of a specific app by macOS bundle id (e.g. `us.zoom.xos`). |
| `meetingnotes://record?source=<x>&title=<slug>` | Same as above, with an optional title hint for the resulting meeting row. |
| `meetingnotes://stop` | Stop the active recording. |
| `meetingnotes://open?id=<meeting-id>` | Focus the MeetingNotes window on a specific meeting's detail view. |

If MeetingNotes is not running when one of these URLs is opened, macOS launches the app and the verb fires after startup.

## Behavior

- **Already-recording guard.** `record` is a no-op when a recording is already active. A macOS notification confirms which session blocked the request.
- **Source resolution.** Keyword and bundle-id sources resolve against the live set of audio-producing processes (the same list the in-app source picker uses). If the named app isn't producing audio yet, the verb fails fast with a notification ("Zoom isn't producing audio right now") rather than starting a silent recording.
- **Always-on audit log.** Every dispatch — including malformed URLs and ignored verbs — gets a JSON line in `~/Library/Logs/MeetingNotes/app.log` so you can see what fired and when.
- **Validated input.** Source must be alphanumeric (`A–Z`, `a–z`, `0–9`, `.`, `_`, `-`); title is capped at 200 chars; meeting ids must match `[A-Za-z0-9_-]{1,64}`. Anything else is rejected with a notification.

## Examples

```bash
# Start recording system audio from a launchd timer
open 'meetingnotes://record'

# Start recording a native Zoom call once it's connected
open 'meetingnotes://record?source=zoom'

# Stop whatever is recording
open 'meetingnotes://stop'

# Focus the library on a meeting by id
open 'meetingnotes://open?id=4d3a1c'
```

## Trust model

v1 trusts any caller — there is no token, OAuth, or bearer-secret check. The risk profile is the same as a manual click on the **⏺ Record** button: anything that can run `open(1)` on your Mac can also click the toolbar. If multi-user scenarios become a thing, the verb surface will gain a per-app authorization step. Until then: don't expose this to untrusted scripts.

## Out of scope (v1)

- Authentication / token gating.
- Verbs beyond `record`, `stop`, `open`.
- Returning structured success/failure to the caller. Notifications and the audit log are the only feedback channels.
