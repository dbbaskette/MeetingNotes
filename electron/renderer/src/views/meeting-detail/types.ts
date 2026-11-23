// electron/renderer/src/views/meeting-detail/types.ts
// Shared meeting-page types, moved out of MeetingDetailView.tsx (#256).
// MeetingDetailView.tsx re-exports MeetingDetail for existing importers.
import type { DetailSpeaker } from '../../lib/detail-artifacts';

// Audio is no longer a tab — it lives in a sticky footer below the
// center pane so playback stays alive while the user reads the summary
// or transcript. See #42. Actions tab exposes inline edit / add / delete
// for the action items that used to only surface in the export modal. #44
export type Tab = 'summary' | 'transcript' | 'actions';

export interface MeetingDetail {
  id: string;
  title: string;
  groupId: string | null;
  groupName: string | null;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  status: string;
  errorMessage: string | null;
  processingHistory?: { createdAt: string; kind: string; stage: string; message: string }[];
  stageStartedAt: string | null;
  stageEtaMs: number | null;
  stageEtaRough: boolean;
  skipSpeakerId: boolean;
  transcriptMd: string | null;
  rawTranscriptText: string | null;
  summaryMd: string | null;
  summaryStale?: boolean;
  audioPath: string;
  userIdentified: boolean;
  speakers: DetailSpeaker[];
  actionItems: {
    id: string;
    text: string;
    ownerName: string | null;
    dueDate: string | null;
    status: string;
    exportedTo: string[];
    sourceQuote: string | null;
    isMine: boolean;
  }[];
  models: { stt?: string; llm?: string };
}

export type MeetingShell = Omit<MeetingDetail, 'transcriptMd' | 'rawTranscriptText'>;

/** Summary panel mode; see the Summary panel notes in SummaryPanel.tsx. */
export type SummaryMode = 'view' | 'edit';
