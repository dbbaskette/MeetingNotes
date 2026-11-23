// electron/renderer/src/views/meeting-detail/hooks/useNotesEditor.ts
// Lifted notes (summary) edit session and its unsaved-edits guard, moved
// out of MeetingDetailView.tsx (#256). Called from useMeetingDetail at the
// same point in the hook order the code had in the view.
import { useEffect, useRef, useState } from 'react';
import { setUnsavedGuard } from '../../../lib/unsaved-guard';
import type { MeetingDetail, SummaryMode } from '../types';

export function useNotesEditor(m: MeetingDetail | null) {
  // Summary edit session (#A2). Lives HERE, not in SummaryPanel: the panel
  // is conditionally rendered (`tab === 'summary' && …`), so a tab switch
  // unmounts it — state kept inside the panel died with it and silently
  // discarded the user's edits. `summarySaved` is the local baseline (what
  // we believe is on disk); it advances on save, ahead of `m.summaryMd`
  // catching up via reload. dirty = draft !== baseline.
  const [summaryMode, setSummaryMode] = useState<SummaryMode>('view');
  const [summaryDraft, setSummaryDraft] = useState('');
  const [summarySaved, setSummarySaved] = useState('');
  const summaryDirty = summaryDraft !== summarySaved;

  // Seed / reset the session, keyed on meeting id + on-disk summary. A
  // meeting switch always reseeds; a summaryMd change on the SAME meeting
  // (re-summarize, save-reload round trip) only reseeds when there are no
  // unsaved edits to lose. The ref makes re-runs from unrelated renders
  // (polls, dirty flips) cheap no-ops.
  const summarySeedRef = useRef<{ id: string; original: string } | null>(null);
  useEffect(() => {
    if (m === null) return;
    const original = m.summaryMd ?? '';
    const prev = summarySeedRef.current;
    if (prev !== null && prev.id === m.id && prev.original === original) return;
    const idChanged = prev === null || prev.id !== m.id;
    summarySeedRef.current = { id: m.id, original };
    if (idChanged || !summaryDirty) {
      setSummaryDraft(original);
      setSummarySaved(original);
      if (idChanged) setSummaryMode('view');
    }
  }, [m, summaryDirty]);

  // While dirty, register the global unsaved-edits guard so destructive
  // exits (back button below, App-level meeting switches via the search
  // palette / URL scheme / status bar / history) confirm before discarding.
  // The guard is asynchronous: it opens a styled ConfirmDialog and resolves
  // with the user's answer, replacing the old window.confirm (#192).
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardResolveRef = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => {
    if (!summaryDirty) return;
    setUnsavedGuard(() => new Promise<boolean>((resolve) => {
      // A second navigation attempt while the dialog is open resolves the
      // first (denied) so it can't dangle.
      discardResolveRef.current?.(false);
      discardResolveRef.current = resolve;
      setDiscardOpen(true);
    }));
    return () => {
      discardResolveRef.current = null;
      setUnsavedGuard(null);
    };
  }, [summaryDirty]);

  function settleDiscard(ok: boolean): void {
    setDiscardOpen(false);
    const resolve = discardResolveRef.current;
    discardResolveRef.current = null;
    resolve?.(ok);
    // If declined, the draft stays dirty and the effect re-registers the
    // guard on the next dirty flip — no action needed here.
  }

  return {
    summaryMode, setSummaryMode, summaryDraft, setSummaryDraft, summarySaved, setSummarySaved,
    discardOpen, settleDiscard,
  };
}
