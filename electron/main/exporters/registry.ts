import type { Exporter } from './interface.js';
import { MarkdownExporter } from './markdown.js';
import { AppleRemindersExporter } from './apple-reminders.js';
import { GoogleTasksStub } from './google-tasks-stub.js';

export function buildExporterRegistry(): Record<string, Exporter> {
  return {
    markdown: new MarkdownExporter(),
    reminders: new AppleRemindersExporter(),
    'google-tasks': new GoogleTasksStub(),
  };
}
