import type { Exporter } from './interface.js';
import { MarkdownExporter } from './markdown.js';
import { AppleRemindersExporter } from './apple-reminders.js';
import { GoogleTasksStub } from './google-tasks-stub.js';
import { GoogleTasksExporter, type GoogleAuthLike } from './google-tasks.js';
import { GoogleDocExporter } from './google-doc.js';
import { WebhookExporter, type WebhookExporterDeps } from './webhook.js';

export interface ExporterRegistryDeps {
  /** Optional webhook-exporter deps. Omitted in tests / when the auto-fire
   *  feature isn't being used; the manual export path remains available
   *  for any exporter that doesn't need extra wiring. (#79) */
  webhook?: WebhookExporterDeps;
  /** Google auth provider. When present, the real Google Tasks + Doc
   *  exporters are registered; otherwise google-tasks falls back to the
   *  "not implemented" stub and google-doc is unavailable. */
  google?: GoogleAuthLike;
  fetchImpl?: typeof fetch;
}

export function buildExporterRegistry(deps: ExporterRegistryDeps = {}): Record<string, Exporter> {
  const out: Record<string, Exporter> = {
    markdown: new MarkdownExporter(),
    reminders: new AppleRemindersExporter(),
    'google-tasks': new GoogleTasksStub(),
  };
  if (deps.google) {
    out['google-tasks'] = new GoogleTasksExporter({ auth: deps.google, fetchImpl: deps.fetchImpl });
    out['google-doc'] = new GoogleDocExporter({ auth: deps.google, fetchImpl: deps.fetchImpl });
  }
  if (deps.webhook) {
    out.webhook = new WebhookExporter(deps.webhook);
  }
  return out;
}
