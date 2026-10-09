// Shapes a caught renderer error for the main-process log and for the
// "Copy details" button. Kept free of React and IPC so it is unit-testable.

export type ErrorSource = 'boundary' | 'window' | 'promise';

export interface ErrorReport {
  source: ErrorSource;
  scope: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

export function buildErrorReport(source: ErrorSource, scope: string, error: unknown, componentStack?: string | null): ErrorReport {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === 'string' ? error : 'Unknown error';
  const stack = error instanceof Error && error.stack ? error.stack : undefined;
  return {
    source,
    scope,
    message,
    ...(stack ? { stack } : {}),
    ...(componentStack ? { componentStack: componentStack.trim() } : {}),
  };
}

export function formatErrorDetails(report: ErrorReport, appVersion?: string): string {
  return [
    `MeetingNotes${appVersion ? ` ${appVersion}` : ''} — ${report.scope}`,
    report.message,
    report.stack,
    report.componentStack ? `Component stack:\n${report.componentStack}` : undefined,
  ].filter(Boolean).join('\n\n');
}

/** A boundary clears its error when the thing it wraps changes identity,
 *  e.g. navigating to another meeting. */
export function shouldResetBoundary(hasError: boolean, previousKey: string | undefined, nextKey: string | undefined): boolean {
  return hasError && previousKey !== nextKey;
}
