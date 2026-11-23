// electron/renderer/src/views/meeting-detail/hooks/useMeetingDetail.ts
// All state and effects of the meeting page, moved out of
// MeetingDetailView.tsx (#256). The hooks run in exactly the order they had
// in the view: usePlayback and useNotesEditor are called at the point where
// their code used to sit, so effect order is unchanged.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../ipc/client';
import { createDetailArtifacts, mergeSpeakerReview } from '../../../lib/detail-artifacts';
import type { MeetingDetail, MeetingShell, Tab } from '../types';
import { usePlayback } from './usePlayback';
import { useNotesEditor } from './useNotesEditor';

// User-facing pipeline step model lives in lib/pipeline-steps so the
// LibraryRow chip and the StageTimeline below agree on counts and labels.

const RAIL_PREFERENCE_KEY = 'mn-detail-rail';

export function useMeetingDetail({ id, seekSeconds }: { id: string; seekSeconds?: number }) {
  const [shell, setShell] = useState<MeetingShell | null>(null);
  // Why there is nothing to show for `id`: the meeting is gone (stale search
  // hit, old link, purged while open) or the read failed. Without this the
  // loading skeleton would stay up forever.
  const [problem, setProblem] = useState<{ id: string; kind: 'missing' | 'error'; message?: string } | null>(null);
  const [moveGroupOpen, setMoveGroupOpen] = useState(false);
  const [, setArtifactVersion] = useState(0);
  const [artifacts] = useState(() => createDetailArtifacts({
    transcript: async (meetingId: string) => {
      const result = await api.meetings.getTranscript(meetingId);
      if (result === null) throw new Error('Meeting is no longer available.');
      return result;
    },
    speakerReview: async (meetingId: string) => {
      const result = await api.meetings.getSpeakerReview(meetingId);
      if (result === null) throw new Error('Meeting is no longer available.');
      return result;
    },
  }, () => setArtifactVersion((version) => version + 1)));
  useEffect(() => {
    artifacts.selectMeeting(id);
    return () => artifacts.selectMeeting(null);
  }, [artifacts, id]);
  const transcript = artifacts.get('transcript');
  const speakerReview = artifacts.get('speakerReview');
  // Shell refreshes must never erase optional content already on screen.
  const m: MeetingDetail | null = useMemo(() => shell?.id === id ? {
    ...shell,
    transcriptMd: transcript.data?.transcriptMd ?? null,
    rawTranscriptText: transcript.data?.rawTranscriptText ?? null,
    speakers: mergeSpeakerReview(shell.speakers, speakerReview.data?.speakers),
  } : null, [shell, id, transcript.data, speakerReview.data]);
  const [tab, setTab] = useState<Tab>('summary');
  // The speakers/export rail can be hidden so notes use the full width; the
  // choice is a per-device reading preference, so it lives in localStorage.
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_PREFERENCE_KEY) !== 'closed'; } catch { return true; }
  });
  // "Open full speaker review" (compact speakers panel) opens the rail if
  // it is collapsed, then moves to it. The link used to point at a hidden
  // element and do nothing (#298).
  useEffect(() => {
    const open = (): void => {
      setRailOpen(true);
      try { localStorage.setItem(RAIL_PREFERENCE_KEY, 'open'); } catch { /* preference only */ }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rail = document.getElementById('meeting-speakers');
        rail?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        rail?.focus({ preventScroll: true });
      }));
    };
    window.addEventListener('mn:open-speaker-review', open);
    return () => window.removeEventListener('mn:open-speaker-review', open);
  }, []);
  const toggleRail = useCallback(() => {
    setRailOpen((open) => {
      try { localStorage.setItem(RAIL_PREFERENCE_KEY, open ? 'closed' : 'open'); } catch { /* preference only */ }
      return !open;
    });
  }, []);
  useEffect(() => {
    if (shell?.id === id && (tab === 'transcript' || seekSeconds !== undefined)) {
      void artifacts.request(id, 'transcript');
    }
  }, [artifacts, id, shell?.id, tab, seekSeconds]);
  useEffect(() => {
    if (shell?.id !== id) return;
    // Two frames put the optional review request after the first shell paint.
    let nextFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => { void artifacts.request(id, 'speakerReview'); });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (nextFrame !== undefined) cancelAnimationFrame(nextFrame);
    };
  }, [artifacts, id, shell?.id]);
  // Provenance jump (#provenance): when the user clicks "Show source" on an
  // action item, we switch to the Summary tab and ask SummaryPanel to
  // highlight the bullet whose text matches `quote`. `nonce` lets re-clicking
  // the same item re-trigger the scroll/highlight even though `quote` is
  // unchanged. Mirrors how `seekSeconds` drives the transcript jump.
  const [provenance, setProvenance] = useState<{ quote: string; nonce: number } | null>(null);
  const showSource = (quote: string): void => {
    setTab('summary');
    setProvenance((p) => ({ quote, nonce: (p?.nonce ?? 0) + 1 }));
  };

  const playback = usePlayback({ id, m, seekSeconds, setTab });

  const notes = useNotesEditor(m);

  // `kick` is a deliberate re-run trigger for the polling effect. Mutations
  // that change the meeting's live state (rerun, speaker assign) bump it so
  // the effect tears down its old timer and starts fresh — polling resumes
  // even after the meeting had already settled at 'done'.
  const [kick, setKick] = useState(0);
  // Stable identity: the memoized RightRail and panels receive it as a prop.
  const reload = useCallback(async (): Promise<void> => {
    setKick((k) => k + 1);
  }, []);
  const retrySpeakerReview = useCallback(() => { void artifacts.request(id, 'speakerReview'); }, [artifacts, id]);

  // Stage events refresh the shell immediately. A slower DB-only poll covers
  // events missed while the renderer was suspended or reloading.
  const lastLiveStateRef = useRef<{
    pipelineStage: string; status: string; errorMessage: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    let requestSerial = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function load(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      const request = ++requestSerial;
      let d: MeetingShell | null;
      try {
        d = (await api.meetings.get(id)) as MeetingShell | null;
      } catch (error) {
        // Keep whatever is on screen; only an empty page needs the message.
        if (alive && request === requestSerial) setProblem({ id, kind: 'error', message: (error as Error).message });
        return;
      }
      if (!alive || request !== requestSerial) return;
      setShell(d);
      setProblem(d === null ? { id, kind: 'missing' } : null);
      if (d === null) return;
      void artifacts.refresh(id);
      lastLiveStateRef.current = {
        pipelineStage: d.pipelineStage,
        status: d.status,
        errorMessage: d.errorMessage,
      };
      // Poll while anything is in flight. A rerun puts the meeting back into
      // 'processing', which re-enters this branch via the `kick` dependency.
      if (d.status === 'processing') {
        timer = setTimeout(poll, 15000);
      }
    }
    // Light poll tick: DB-only status snapshot. Refreshes the shell
    // the moment stage/status/error changed (or the meeting vanished
    // — load()'s null handling is the same either way).
    async function poll(): Promise<void> {
      let st: Awaited<ReturnType<typeof api.meetings.getStatus>>;
      try {
        st = await api.meetings.getStatus(id);
      } catch {
        st = null;
      }
      if (!alive) return;
      if (st === null) {
        // Meeting vanished (deleted?) or the IPC failed — let the full
        // load path decide what to render.
        await load();
        return;
      }
      const last = lastLiveStateRef.current;
      const changed = last === null
        || st.pipelineStage !== last.pipelineStage
        || st.status !== last.status
        || st.errorMessage !== last.errorMessage;
      if (changed) {
        // Stage advanced / failed / finished — refresh the shell and
        // previously requested artifacts, including any raw preview.
        // load() reschedules polling itself while still processing.
        await load();
        return;
      }
      // No state change: keep the cheap live fields (eta, counts) fresh
      // without re-shipping the transcript, and keep polling.
      const snap = st;
      setShell((prev) => (prev === null || prev.id !== id ? prev : {
        ...prev,
        title: snap.title,
        stageStartedAt: snap.stageStartedAt,
        stageEtaMs: snap.stageEtaMs,
        stageEtaRough: snap.stageEtaRough,
        skipSpeakerId: snap.skipSpeakerId,
      }));
      if (snap.status === 'processing') {
        timer = setTimeout(poll, 15000);
      }
    }
    const unsubscribeStage = api.pipeline.onMeetingStageChange((meetingId) => {
      if (meetingId === id) void load();
    });
    void load();
    return () => {
      alive = false;
      unsubscribeStage();
      if (timer) clearTimeout(timer);
    };
  }, [artifacts, id, kick]);

  return {
    m, problem, setProblem, moveGroupOpen, setMoveGroupOpen, artifacts, transcript, speakerReview,
    tab, setTab, railOpen, toggleRail, provenance, showSource, playback, notes, reload, retrySpeakerReview,
  };
}
