// electron/renderer/src/views/meeting-detail/hooks/useContentVersion.ts
// Moved out of MeetingDetailView.tsx (#256).
import { useRef } from 'react';

/** A short token that changes whenever the transcript or notes text does.
 *  TerminologyPanel only needs "did the content change", and concatenating
 *  two multi-hundred-KB strings on every render to tell it was pure waste
 *  (#301). Comparing against the previous strings is a pointer check on
 *  ordinary re-renders. */
export function useContentVersion(transcriptMd: string | null, summaryMd: string | null): string | null {
  const previous = useRef<{ transcriptMd: string | null; summaryMd: string | null; revision: number }>(
    { transcriptMd, summaryMd, revision: 0 });
  if (previous.current.transcriptMd !== transcriptMd || previous.current.summaryMd !== summaryMd) {
    previous.current = { transcriptMd, summaryMd, revision: previous.current.revision + 1 };
  }
  return transcriptMd || summaryMd ? `r${previous.current.revision}` : null;
}
