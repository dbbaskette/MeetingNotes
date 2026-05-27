# Exporters

MeetingNotes can push the results of a completed meeting to external surfaces. Today: Apple Reminders, Markdown (writes to disk), and a generic webhook.

## Webhook exporter

The webhook exporter POSTs a JSON payload to an HTTPS endpoint when the pipeline finishes a meeting. Use it to forward summaries and action items into Telegram, Slack, Discord, Mattermost, or any custom automation.

Configured in **Settings → Webhook exporter**:

| Setting | Default | What it does |
| --- | --- | --- |
| `exporterWebhook` | `false` | Master on/off switch. Nothing fires when off. |
| `webhookUrl` | `""` | HTTPS endpoint. HTTP is rejected unless the host is `localhost` / `127.0.0.1` / `::1`. |
| `webhookSecret` | `""` | Optional bearer token. Sent as `Authorization: Bearer <secret>` when non-empty. Redacted from logs and the test-payload preview. |
| `webhookTemplate` | `compact` | One of `compact`, `full`, `telegram-markdown`, `slack-blocks`. |
| `webhookOwnerFilter` | `mine` | `mine` (only your action items), `all`, or `none` (summary only). |

### Triggers

- **Auto.** Every meeting that reaches `status='done'` is delivered (if the master toggle is on). Auto-fire never blocks meeting completion — a webhook failure logs a line and surfaces in the Settings card, but the meeting still flips to done.
- **Test.** The **Send test payload** button in Settings POSTs a synthetic meeting against the active config so you can verify the endpoint before a real meeting runs.
- **Manual.** The webhook also registers as an Exporter on the meeting detail view's export menu, so you can re-deliver a specific meeting.

### Retries

Webhook delivery retries up to 3 times with exponential backoff: **1s → 5s → 30s**.

- **5xx / network errors** retry up to the limit.
- **429** retries (rate-limited responses are treated as transient).
- **Other 4xx** fails fast (no retry). 4xx usually means the endpoint or auth is misconfigured — hammering it doesn't help.

After all retries fail, the last result is written to `settings.webhookLastResult` so the Settings card can show it.

### Payload (compact template)

```json
{
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
  "text": "*Team standup*\n_2026-05-27T14:30:00Z · 28 min_\n\n…",
  "parse_mode": "Markdown"
}
```

Wire this to your bot by pointing `webhookUrl` at `https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>` (Telegram accepts the chat_id either as a query param or in the body — query is easiest if you don't control the body).

Markdown specials (`_*[]()`) in user-supplied titles, summaries, and action items are escaped so a colon-tagged name like `Bug_report` doesn't accidentally start italic.

### Slack template

`slack-blocks` returns Block Kit JSON ready for [chat.postMessage](https://api.slack.com/methods/chat.postMessage) or an incoming-webhook URL:

```json
{
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "Team standup" } },
    { "type": "context", "elements": [{ "type": "mrkdwn", "text": "2026-05-27T14:30:00Z · 28 min · with Jamie, Alex" }] },
    { "type": "section", "text": { "type": "mrkdwn", "text": "Three-sentence overview…" } },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Action items*\n• …" } },
    { "type": "actions", "elements": [{ "type": "button", "text": { "type": "plain_text", "text": "Open in MeetingNotes" }, "url": "meetingnotes://open?id=…" }] }
  ]
}
```

### Security

- HTTPS only (with the loopback exception above).
- The bearer secret is stored in the same SQLite settings table as other configuration. Never logged, never echoed in the test-payload preview, and never returned by `settings:get` to the renderer in plaintext if you'd prefer to wipe it after a session (the field is a `<input type="password">` in Settings, but you have to clear it yourself).
- No PII leaves your machine unless `exporterWebhook` is on and a URL is configured.

### Out of scope (v1)

- Per-meeting overrides (the global config always applies).
- Custom JS templates inside the app — pick a built-in template.
- Bidirectional webhooks (we don't accept inbound from the downstream tool).
- Per-exporter delivery history beyond the most recent result.
