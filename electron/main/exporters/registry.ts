import type { Exporter } from './interface';
import { MarkdownExporter } from './markdown';
import { AppleRemindersExporter } from './apple-reminders';
import { GoogleTasksStub } from './google-tasks-stub';

export function buildExporterRegistry(): Record<string, Exporter> {
  return {
    markdown: new MarkdownExporter(),
    reminders: new AppleRemindersExporter(),
    'google-tasks': new GoogleTasksStub(),
  };
}
