// Labels that help someone tell one unwanted capture from another. Capture
// files are named `recording-<stamp>-<uuid>.m4a`, which all look alike in
// Finder, so the app shows what each file is and when it was recorded.

export type RecoveryFileRole = 'combined' | 'microphone' | 'app';

export interface RecoveryFileInput {
  name: string;
  role: RecoveryFileRole;
  sizeBytes: number;
}

export function fileRoleLabel(role: RecoveryFileRole): string {
  return role === 'microphone' ? 'Your microphone'
    : role === 'app' ? 'App audio' : 'Combined recording';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Mon, Nov 3, 2:14 PM" in the viewer's locale; null when the date is unreadable. */
export function formatRecordedAt(iso: string, locale?: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString(locale, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** One line for the delete confirmation, e.g. "Your microphone · 4.2 MB". */
export function describeRecoveryFile(file: RecoveryFileInput): string {
  return `${fileRoleLabel(file.role)} · ${formatBytes(file.sizeBytes)}`;
}

export function discardSummary(files: RecoveryFileInput[]): string {
  if (files.length === 0) return 'No files from this recording are left on disk. Deleting removes it from this list.';
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const noun = files.length === 1 ? 'file' : 'files';
  return `${files.length} ${noun} (${formatBytes(total)}) will move to the Trash. You can put them back from the Trash in Finder until you empty it.`;
}
