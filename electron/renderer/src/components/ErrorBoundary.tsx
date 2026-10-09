import { Component, type ErrorInfo, type ReactNode } from 'react';
import { buildErrorReport, formatErrorDetails, shouldResetBoundary, type ErrorReport } from '../lib/error-report';

/** Sends a caught error to the main-process log. Never throws: this runs on
 *  the failure path, where the IPC bridge itself may be the thing that broke. */
export function reportRendererError(report: ErrorReport): void {
  try { void window.api?.logs?.reportError?.(report)?.catch?.(() => {}); } catch { /* best-effort */ }
}

interface Props {
  /** Stable name for logs, e.g. `detail:notes`. Never include meeting text. */
  scope: string;
  /** What failed, in the user's words: "Notes", "This meeting". */
  label: string;
  /** `root` offers a window reload; `view` and `panel` retry in place. */
  variant?: 'root' | 'view' | 'panel';
  /** The error clears when this changes (e.g. another meeting is opened). */
  resetKey?: string;
  /** Navigation lives inside each view, so a failed view needs its own way
   *  out. When set, the fallback offers "Back to Library". */
  onLeave?: () => void;
  children: ReactNode;
}

interface State { report: ErrorReport | null; copied: boolean }

/** Contains a render failure to the part of the UI that threw, so one bad
 *  panel never blanks the window or hides an active recording (#251). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { report: null, copied: false };

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report = buildErrorReport('boundary', this.props.scope, error, info.componentStack);
    this.setState({ report });
    reportRendererError(report);
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // componentDidCatch fills in the component stack; this keeps the fallback
    // on screen for the render in between.
    return { report: buildErrorReport('boundary', 'pending', error), copied: false };
  }

  componentDidUpdate(prev: Props): void {
    if (shouldResetBoundary(this.state.report !== null, prev.resetKey, this.props.resetKey)) this.retry();
  }

  private retry = (): void => { this.setState({ report: null, copied: false }); };

  private copy = async (): Promise<void> => {
    if (!this.state.report) return;
    let version: string | undefined;
    try { version = await window.api.app.getVersion(); } catch { version = undefined; }
    try {
      await navigator.clipboard.writeText(formatErrorDetails({ ...this.state.report, scope: this.props.scope }, version));
      this.setState({ copied: true });
    } catch { /* clipboard unavailable — the log still has the details */ }
  };

  private openLogs = (): void => {
    try { void window.api.logs.reveal().catch(() => {}); } catch { /* best-effort */ }
  };

  render(): ReactNode {
    if (!this.state.report) return this.props.children;
    const { label, variant = 'view' } = this.props;
    const button = 'text-sm font-medium px-3 py-1.5 rounded-lg border border-surface-border bg-surface hover:bg-surface-sunken transition';
    return (
      <div role="alert" className={variant === 'panel' ? 'p-4' : 'p-8 max-w-xl mx-auto'}>
        <div className="rounded-xl border border-surface-border bg-surface p-5 space-y-3">
          <div className="font-semibold text-ink">{label} couldn’t be displayed</div>
          <p className="text-sm text-ink-muted">
            Something went wrong while showing this part of MeetingNotes. Your recordings and notes are not affected.
            {variant !== 'root' && ' The rest of the app keeps working.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {variant === 'root'
              ? <button className={button} onClick={() => window.location.reload()}>Reload window</button>
              : <button className={button} onClick={this.retry}>Try again</button>}
            {this.props.onLeave && <button className={button} onClick={() => { this.retry(); this.props.onLeave?.(); }}>Back to Library</button>}
            <button className={button} onClick={() => void this.copy()}>{this.state.copied ? 'Copied' : 'Copy details'}</button>
            <button className={button} onClick={this.openLogs}>Show log file</button>
          </div>
        </div>
      </div>
    );
  }
}
