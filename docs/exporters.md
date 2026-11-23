# Exporters

MeetingNotes can save meeting notes locally as Markdown or PDF, send selected action items to Apple Reminders or Google Tasks, create a Google Doc, and deliver meeting data to a webhook. Google exports require an account connection; see [Google setup](google-setup.md).

## PDF export

In a meeting's **Export** panel, choose **PDF**. Select the action items to include, or click **None** to save notes without action items. Choose a destination in the macOS Save dialog. The PDF is generated on your Mac from the saved summary and the selected action items; no upload is involved. The summary's own Action Items section is replaced by the selection so items do not appear twice.

## Webhook exporter

The webhook exporter POSTs a JSON payload to an HTTPS endpoint when the pipeline finishes a meeting. Use it to forward notes and action items into Telegram, Slack, or any custom automation that accepts JSON.

Configured in **Settings → Integrations → Webhook exporter**:

| Setting | Default | What it does |
| --- | --- | --- |
| `exporterWebhook` | `false` | Master on/off switch. Nothing fires when off. |
| `webhookUrl` | `""` | HTTPS endpoint. HTTP is rejected unless the host is `localhost` / `127.0.0.1` / `::1`. |
| `webhookSecret` | `""` | Optional bearer token. Sent as `Authorization: Bearer <secret>` when non-empty. Encrypted with the macOS keychain and redacted from logs. |
| `webhookTemplate` | `compact` | One of `compact`, `full`, `telegram-markdown`, `slack-blocks`. |
| `webhookOwnerFilter` | `mine` | `mine` (only your action items), `all`, or `none` (summary only). |

### Triggers

- **Auto.** Every meeting that reaches `status='done'` is delivered (if the master toggle is on). Auto-fire never blocks meeting completion — a webhook failure logs a line and surfaces in the Settings card, but the meeting still flips to done.
- **Test.** The **Send test payload** button in Settings POSTs a synthetic meeting against the active config so you can verify the endpoint before a real meeting runs.
- **Manual.** There is no per-meeting webhook button in a meeting's Export panel. To deliver a meeting again, re-run its notes (**Processing → Re-run from… → Notes and action items only**), which fires the webhook when the meeting finishes.

### Retries

Webhook delivery retries up to 3 times with exponential backoff: **1s → 5s → 30s**.

- **5xx / network errors** retry up to the limit.
- **429** retries (rate-limited responses are treated as transient).
- **Other 4xx** fails fast (no retry). 4xx usually means the endpoint or auth is misconfigured — hammering it doesn't help.

The result of the last delivery, successful or not, is written to the `webhookLastResult` setting so the Settings card can show it.

Every delivery sends an `Idempotency-Key` header; the `compact` and `full` templates carry the same value as `delivery_id`. Retries of one delivery reuse it; a new delivery gets a new one, so a receiver can deduplicate on it.

### Payload (compact template)

```json
{
  "delivery_id": "6f1c0c0e-4f0b-4c58-9d39-2f1f0c6f8a11",
  "event": "meeting.completed",
  "meeting": {
    "id": "abc123",
    "slug": "2026-05-27-team-standup",
    "title": "Team standup",
    "started_at": "2026-05-27T14:30:00Z",
    "duration_s": 1683,
    "attendees": ["Me", "Jamie", "Alex"]
  },
  "summary_markdown": "Three-sentence overview…",
  "action_items": [
    { "text": "File the spec by Friday", "owner": "Me", "due_date": null }
  ],
  "links": {
    "audio": "file:///Users/.../audio.m4a",
    "transcript_md": "file:///…/transcript.md",
    "summary_md": "file:///…/summary.md",
    "open_in_app": "meetingnotes://open?id=abc123"
  }
}
```

The `full` template adds a `transcript_markdown` field with the full transcript markdown. Use it when downstream automation actually consumes the transcript; otherwise stick with compact (transcripts can be hundreds of KB).

### Telegram template

`telegram-markdown` renders to a Telegram `sendMessage`-shaped body:

```json
{
  "text": "*Team standup*\n_2026\\-05\\-27T14:30:00Z · 28 min_\n\n…",
  "parse_mode": "MarkdownV2"
}
```

Wire this to your bot by pointing `webhookUrl` at `https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>` (Telegram accepts the chat_id either as a query param or in the body — query is easiest if you don't control the body).

The body uses Telegram's `MarkdownV2`. Its reserved characters (``_ * [ ] ( ) ~ ` > # + - = | { } . !`` and the backslash) are escaped in titles, notes and action items, so a name like `Bug_report` does not start italic text. The title is cut to 100 characters, the notes to 900, and at most five action items are listed, followed by a count of the rest.

### Slack template

`slack-blocks` returns Block Kit JSON ready for [chat.postMessage](https://api.slack.com/methods/chat.postMessage) or an incoming-webhook URL:

```json
{
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "Team standup", "emoji": true } },
    { "type": "context", "elements": [{ "type": "mrkdwn", "text": "2026-05-27T14:30:00Z · 28 min · with Jamie, Alex", "verbatim": true }] },
    { "type": "section", "text": { "type": "mrkdwn", "text": "Three-sentence overview…", "verbatim": true } },
    { "type": "divider" },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Action items*\n• …", "verbatim": true } },
    { "type": "actions", "elements": [{ "type": "button", "text": { "type": "plain_text", "text": "Open in MeetingNotes" }, "url": "meetingnotes://open?id=…" }] }
  ]
}
```

The notes and the action-item list are each cut to 580 characters, and `&`, `<` and `>` are escaped. The divider and action-item section appear only when there are action items.

### Security

- HTTPS only (with the loopback exception above).
- The bearer token is encrypted with the macOS keychain (Electron `safeStorage`) before it is written to the settings table; see [`secret-settings.ts`](../electron/main/storage/secret-settings.ts). It is never logged and never sent to the window: Settings shows a mask for a saved token. Clear the field to remove it. A token saved as plaintext by an older version is encrypted on the next launch. If keychain encryption is unavailable, the token is not saved.
- Markdown and PDF exports are saved locally. Google Tasks and Google Docs send the selected meeting data to Google when you use those buttons. An enabled webhook sends its configured payload to the destination URL.

### Out of scope (v1)

- Per-meeting overrides (the global config always applies).
- Custom JS templates inside the app — pick a built-in template.
- Bidirectional webhooks (we don't accept inbound from the downstream tool).
- Per-exporter delivery history beyond the most recent result.
