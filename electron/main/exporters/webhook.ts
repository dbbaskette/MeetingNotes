// electron/main/exporters/webhook.ts
//
// Push a meeting.completed payload to a user-configured endpoint. Used in
// two modes:
//   1. Manual export — registered with the rest of the exporters and
//      invoked via IPC_CHANNELS.exportRun. Returns a status string.
//   2. Auto-fire on completion — the pipeline calls `runForMeeting()`
//      when a meeting transitions to status='done'. Settings gate
//      controls whether this fires at all.
//
// Retries: 5xx and network errors retry up to 3 times with exponential
// backoff (1s / 5s / 30s). 4xx (other than 429) is treated as a config
// error and fails fast — no point hammering an endpoint that already
// said "your payload is malformed" or "you're not authorized."
//
// Issue #79.

import type { Exporter, ExportInput } from './interface.js';
import { renderWebhookBody, type WebhookPayload, type WebhookTemplate } from './webhook-templates.js';

export interface WebhookConfig {
  url: string;
  secret: string;
  template: WebhookTemplate;
  ownerFilter: 'mine' | 'all' | 'none';
}

export interface WebhookDeliveryResult {
  ts: string;
  status: number | null;
  error: string | null;
}

export interface WebhookExporterDeps {
  /** Returns the live config snapshot. Read on each export so a Settings
   *  edit takes effect on the very next delivery. */
  getConfig: () => WebhookConfig;
  /** Persist the most recent delivery result so the Settings card can
   *  show it without us having to maintain in-memory state. */
  setLastResult: (r: WebhookDeliveryResult) => void;
  /** Test-injectable fetch. Production wiring passes globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Test-injectable sleep. Production wiring passes a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Append a structured line to the audit log. Secrets are stripped
   *  before they reach this callback. */
  log?: (msg: string, data: Record<string, unknown>) => void;
}

const DEFAULT_BACKOFFS_MS = [1_000, 5_000, 30_000];
const RETRYABLE_BACKOFFS_ON_429: number[] = DEFAULT_BACKOFFS_MS;

export class WebhookExporter implements Exporter {
  name = 'webhook';

  constructor(private readonly deps: WebhookExporterDeps) {}

  async export(input: ExportInput): Promise<string> {
    const cfg = this.deps.getConfig();
    const validation = validateUrl(cfg.url);
    if (!validation.ok) throw new Error(validation.reason);
    const payload = buildPayload(input, cfg);
    const result = await this.deliver(cfg, payload);
    this.deps.setLastResult(result);
    if (result.error != null) throw new Error(result.error);
    return `Posted to ${redactUrl(cfg.url)} (HTTP ${result.status ?? '???'})`;
  }

  /** Auto-fire entry point. Distinct from `export()` so the pipeline
   *  can call this without needing the file-export inputs (folder,
   *  outputPath) the Exporter interface still expects. */
  async deliverPayload(payload: WebhookPayload): Promise<WebhookDeliveryResult> {
    const cfg = this.deps.getConfig();
    const validation = validateUrl(cfg.url);
    if (!validation.ok) {
      const result: WebhookDeliveryResult = {
        ts: new Date().toISOString(), status: null, error: validation.reason,
      };
      this.deps.setLastResult(result);
      return result;
    }
    const result = await this.deliver(cfg, payload);
    this.deps.setLastResult(result);
    return result;
  }

  private async deliver(cfg: WebhookConfig, payload: WebhookPayload): Promise<WebhookDeliveryResult> {
    const rendered = renderWebhookBody(payload, cfg.template);
    const headers: Record<string, string> = {
      'content-type': rendered.contentType,
      'user-agent': 'MeetingNotes/0.2 (+https://github.com/dbbaskette/MeetingNotes)',
    };
    if (cfg.secret) headers['authorization'] = `Bearer ${cfg.secret}`;
    const fetcher = this.deps.fetchImpl ?? globalThis.fetch;
    const sleep = this.deps.sleep ?? defaultSleep;

    let attempt = 0;
    let lastError: string | null = null;
    let lastStatus: number | null = null;
    while (attempt < DEFAULT_BACKOFFS_MS.length + 1) {
      try {
        const resp = await fetcher(cfg.url, {
          method: 'POST', headers, body: rendered.body,
          signal: AbortSignal.timeout(15_000),
        });
        lastStatus = resp.status;
        if (resp.ok) {
          this.deps.log?.('webhook:delivered', { url: redactUrl(cfg.url), status: resp.status });
          return { ts: new Date().toISOString(), status: resp.status, error: null };
        }
        // 4xx other than 429 is a config error — no point retrying.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          lastError = `HTTP ${resp.status} from endpoint — check URL / auth header`;
          this.deps.log?.('webhook:client-error', { url: redactUrl(cfg.url), status: resp.status });
          break;
        }
        lastError = `HTTP ${resp.status} from endpoint`;
        this.deps.log?.('webhook:retryable-error', { url: redactUrl(cfg.url), status: resp.status, attempt });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        lastStatus = null;
        this.deps.log?.('webhook:network-error', { url: redactUrl(cfg.url), err: lastError, attempt });
      }
      if (attempt >= DEFAULT_BACKOFFS_MS.length) break;
      const backoff = lastStatus === 429
        ? RETRYABLE_BACKOFFS_ON_429[attempt]!
        : DEFAULT_BACKOFFS_MS[attempt]!;
      await sleep(backoff);
      attempt += 1;
    }
    return { ts: new Date().toISOString(), status: lastStatus, error: lastError ?? 'unknown failure' };
  }
}

export interface BuildPayloadOpts {
  meetingId: string;
  slug: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  audioPath: string;
  /** Folder where transcript.md / summary.md live on disk. Used to build
   *  the `links.transcript_md` / `links.summary_md` file:// URLs. */
  meetingFolder: string;
  summaryMd: string | null;
  transcriptMd: string | null;
  attendees: string[];
  actionItems: {
    text: string;
    ownerName: string | null;
    ownerSpeakerId: string | null;
    dueDate: string | null;
    status: string;
  }[];
  userSpeakerId: string | null;
}

export function buildPayloadFromMeeting(opts: BuildPayloadOpts, cfg: WebhookConfig): WebhookPayload {
  const filtered = filterActionItems(opts.actionItems, opts.userSpeakerId, cfg.ownerFilter);
  const transcriptUrl = opts.transcriptMd != null ? toFileUrl(opts.meetingFolder, 'transcript.md') : null;
  const summaryUrl = opts.summaryMd != null ? toFileUrl(opts.meetingFolder, 'summary.md') : null;
  return {
    event: 'meeting.completed',
    meeting: {
      id: opts.meetingId,
      slug: opts.slug,
      title: opts.title,
      started_at: opts.startedAt,
      duration_s: opts.durationS,
      attendees: opts.attendees,
    },
    summary_markdown: opts.summaryMd,
    transcript_markdown: opts.transcriptMd,
    action_items: filtered.map((ai) => ({
      text: ai.text,
      owner: ai.ownerName,
      due_date: ai.dueDate,
    })),
    links: {
      audio: toFileUrlAbsolute(opts.audioPath),
      transcript_md: transcriptUrl,
      summary_md: summaryUrl,
      open_in_app: `meetingnotes://open?id=${encodeURIComponent(opts.meetingId)}`,
    },
  };
}

// ExportInput coming from the manual IPC path can't carry every field
// buildPayloadFromMeeting needs, so we adapt down to what the interface
// has. The auto-fire path uses buildPayloadFromMeeting directly.
function buildPayload(input: ExportInput, _cfg: WebhookConfig): WebhookPayload {
  return {
    event: 'meeting.completed',
    meeting: {
      id: '',
      slug: '',
      title: input.meetingTitle,
      started_at: null,
      duration_s: null,
      attendees: [],
    },
    summary_markdown: input.summaryMd ?? null,
    transcript_markdown: null,
    action_items: input.items.map((it) => ({
      text: it.text,
      owner: it.ownerName,
      due_date: it.dueDate,
    })),
    links: {
      audio: null,
      transcript_md: null,
      summary_md: null,
      open_in_app: 'meetingnotes://open',
    },
  };
}

export function filterActionItems<T extends { ownerSpeakerId: string | null }>(
  items: T[],
  userSpeakerId: string | null,
  filter: 'mine' | 'all' | 'none',
): T[] {
  if (filter === 'none') return [];
  if (filter === 'all') return items;
  if (!userSpeakerId) return []; // user opted into "mine" but never tagged themselves — best-effort none
  return items.filter((it) => it.ownerSpeakerId === userSpeakerId);
}

export interface UrlValidation {
  ok: boolean;
  reason: string;
}

/** HTTPS-only, with a localhost / 127.0.0.1 exception for dev. Mirrors the
 *  guard in the issue spec: no PII leaves the machine over plaintext. */
export function validateUrl(url: string): UrlValidation {
  if (!url || typeof url !== 'string') return { ok: false, reason: 'webhook URL not set' };
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { ok: false, reason: 'webhook URL is not a valid URL' }; }
  if (parsed.protocol === 'https:') return { ok: true, reason: '' };
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { ok: true, reason: '' };
    return { ok: false, reason: 'webhook URL must be HTTPS (plaintext only allowed for localhost dev)' };
  }
  return { ok: false, reason: `webhook URL must be HTTPS (got ${parsed.protocol})` };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Hide everything that can carry a credential in log output: userinfo,
 *  query string, AND the path — Slack incoming-webhook URLs and Telegram
 *  bot URLs put their secret in the path (/services/T/B/TOKEN, /bot<TOKEN>/),
 *  which the docs explicitly tell users to configure. Scheme + host + port
 *  remain so the user can still see where the request went. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const hasPath = u.pathname && u.pathname !== '/';
    return `${u.protocol}//${u.host}${hasPath ? '/…' : ''}`;
  } catch {
    return '[invalid url]';
  }
}

function toFileUrl(folder: string, filename: string): string {
  return `file://${encodeURI(folder)}/${encodeURIComponent(filename)}`;
}

function toFileUrlAbsolute(absolutePath: string): string {
  return `file://${encodeURI(absolutePath)}`;
}
