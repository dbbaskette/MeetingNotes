// electron/renderer/src/views/meeting-detail/RightRail.tsx
// Speakers/export rail, moved out of MeetingDetailView.tsx (#256).
import { memo } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import type { DetailArtifactState } from '../../lib/detail-artifacts';
import { MeetingExportPanel } from '../MeetingExportPanel';
import { SpeakersPanel } from '../MeetingSpeakersPanel';
import { ArtifactFeedback } from './ArtifactFeedback';
import type { MeetingDetail } from './types';

export const RightRail = memo(function RightRail({ meeting, onReload, speakerReviewState, onRetrySpeakerReview }: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
  speakerReviewState: DetailArtifactState<unknown>;
  onRetrySpeakerReview: () => void;
}): JSX.Element {
  return <div id="meeting-speakers" tabIndex={-1} className="border-l border-surface-border p-4 space-y-3">
    <ArtifactFeedback label="speaker review" state={speakerReviewState} onRetry={onRetrySpeakerReview} />
    <ErrorBoundary scope="detail:speakers" label="Speakers" variant="panel" resetKey={meeting.id}><SpeakersPanel meeting={meeting} onReload={onReload} /></ErrorBoundary>
    <ErrorBoundary scope="detail:export" label="Export" variant="panel" resetKey={meeting.id}><MeetingExportPanel meeting={meeting} onReload={onReload} /></ErrorBoundary>
  </div>;
});
