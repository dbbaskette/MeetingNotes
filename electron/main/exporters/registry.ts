import type { Exporter } from './interface.js';
import { MarkdownExporter } from './markdown.js';
import { PdfExporter } from './pdf.js';
import { AppleRemindersExporter } from './apple-reminders.js';
import { GoogleTasksExporter, type GoogleAuthLike } from './google-tasks.js';
import { GoogleDocExporter } from './google-doc.js';
import { WebhookExporter, type WebhookExporterDeps } from './webhook.js';

export interface ExporterRegistryDeps {
  /** Optional webhook-exporter deps. Omitted in tests / when the auto-fire
   *  feature isn't being used; the manual export path remains available
   *  for any exporter that doesn't need extra wiring. (#79) */
  webhook?: WebhookExporterDeps;
  /** Google auth provider. When present, the Google Tasks and Google Doc
   *  exporters are registered; without it neither exists. The app always
   *  passes one; tests may omit it. */
  google?: GoogleAuthLike;
  fetchImpl?: typeof fetch;
}

export function buildExporterRegistry(deps: ExporterRegistryDeps = {}): Record<string, Exporter> {
  const out: Record<string, Exporter> = {
    markdown: new MarkdownExporter(),
    pdf: new PdfExporter(),
    reminders: new AppleRemindersExporter(),
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
