/** Pure metadata shared by the main process and renderer. Exporter classes
 * implement the actual destinations; this describes their UI/selection rules. */
export const EXPORT_TARGETS = {
  markdown: { label: 'Markdown', kind: 'file', extension: 'md', allowsEmptySelection: true, ownOpenItemsOnly: false, requiresGoogle: false },
  pdf: { label: 'PDF', kind: 'file', extension: 'pdf', allowsEmptySelection: true, ownOpenItemsOnly: false, requiresGoogle: false },
  reminders: { label: 'Apple Reminders', kind: 'task', extension: null, allowsEmptySelection: false, ownOpenItemsOnly: true, requiresGoogle: false },
  'google-tasks': { label: 'Google Tasks', kind: 'task', extension: null, allowsEmptySelection: false, ownOpenItemsOnly: true, requiresGoogle: true },
  'google-doc': { label: 'Google Doc', kind: 'document', extension: null, allowsEmptySelection: true, ownOpenItemsOnly: false, requiresGoogle: true },
  webhook: { label: 'Webhook', kind: 'integration', extension: null, allowsEmptySelection: false, ownOpenItemsOnly: false, requiresGoogle: false },
} as const;

export type ExportTargetId = keyof typeof EXPORT_TARGETS;
export function exportTarget(id: string): (typeof EXPORT_TARGETS)[ExportTargetId] | null {
  return Object.prototype.hasOwnProperty.call(EXPORT_TARGETS, id)
    ? EXPORT_TARGETS[id as ExportTargetId] : null;
}
