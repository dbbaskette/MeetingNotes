import type { Exporter } from './interface.js';
import { MarkdownExporter } from './markdown.js';
import { AppleRemindersExporter } from './apple-reminders.js';
import { GoogleTasksStub } from './google-tasks-stub.js';
import { WebhookExporter, type WebhookExporterDeps } from './webhook.js';

export interface ExporterRegistryDeps {
  /** Optional webhook-exporter deps. Omitted in tests / when the auto-fire
   *  feature isn't being used; the manual export path remains available
   *  for any exporter that doesn't need extra wiring. (#79) */
  webhook?: WebhookExporterDeps;
}

export function buildExporterRegistry(deps: ExporterRegistryDeps = {}): Record<string, Exporter> {
  const out: Record<string, Exporter> = {
    markdown: new MarkdownExporter(),
    reminders: new AppleRemindersExporter(),
    'google-tasks': new GoogleTasksStub(),
  };
  if (deps.webhook) {
    out.webhook = new WebhookExporter(deps.webhook);
  }
  return out;
}
