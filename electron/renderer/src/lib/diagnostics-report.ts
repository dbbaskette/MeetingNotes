// electron/renderer/src/lib/diagnostics-report.ts
//
// Plain-text diagnostics for "Copy diagnostics" in Settings (#299): what a
// user pastes into an issue or a support thread. Everything in it is already
// shown on screen in Settings; this only gathers it.
export interface DiagnosticsInput {
  version: string;
  provider: string;
  model: string;
  llmUrl: string;
  health: { label: string; state: string; detail: string }[];
  /** Log entries as shown (already filtered), newest first. */
  entries: { ts: string | null; level: string; msg: string; data?: Record<string, unknown> }[];
  filterLabel: string;
  now?: Date;
}

/** How many log lines the report carries; the newest ones. */
export const DIAGNOSTICS_LOG_LINES = 100;

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const lines: string[] = [
    `MeetingNotes ${input.version || '(version unknown)'}`,
    `Copied ${(input.now ?? new Date()).toISOString()}`,
    '',
    'Summary model',
    `  Provider: ${input.provider}`,
    `  Endpoint: ${input.llmUrl}`,
    `  Model: ${input.model || '(none selected)'}`,
    '',
    'Setup & health',
    ...(input.health.length ? input.health.map((row) => `  ${row.label}: ${row.state} — ${row.detail}`) : ['  (unavailable)']),
    '',
    `Log (${input.filterLabel}, newest first, up to ${DIAGNOSTICS_LOG_LINES} lines)`,
  ];
  const shown = input.entries.slice(0, DIAGNOSTICS_LOG_LINES);
  if (shown.length === 0) lines.push('  (no entries at this level)');
  for (const entry of shown) {
    let data = '';
    if (entry.data && Object.keys(entry.data).length) {
      try { data = ` ${JSON.stringify(entry.data)}`; } catch { data = ' (unserializable data)'; }
    }
    lines.push(`  ${entry.ts ?? '-'} ${entry.level.toUpperCase()} ${entry.msg}${data}`);
  }
  return `${lines.join('\n')}\n`;
}
