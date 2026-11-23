// electron/renderer/src/views/meeting-detail/ArtifactFeedback.tsx
// Moved out of MeetingDetailView.tsx (#256).
import type { DetailArtifactState } from '../../lib/detail-artifacts';
import { MiniSpinner } from './StageTimeline';

export function ArtifactFeedback({ label, state, onRetry }: {
  label: string;
  state: DetailArtifactState<unknown>;
  onRetry: () => void;
}): JSX.Element | null {
  if (state.error) return (
    <div role="alert" className="mb-2 flex items-center gap-2 text-xs text-danger">
      <span className="min-w-0">Could not load {label}: {state.error}</span>
      <button type="button" onClick={onRetry} disabled={state.loading}
        className="shrink-0 font-semibold underline disabled:opacity-40">Retry</button>
    </div>
  );
  if (state.loading && state.data === undefined) return (
    <div role="status" className="mb-2 flex items-center gap-1.5 text-xs text-ink-muted">
      <MiniSpinner /> Loading {label}…
    </div>
  );
  return null;
}
