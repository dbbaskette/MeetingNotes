// electron/renderer/src/views/MeetingDetailView.tsx
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

type Tab = 'summary' | 'transcript' | 'audio';

interface MeetingDetail {
  id: string;
  title: string;
  startedAt: string | null;
  durationS: number | null;
  pipelineStage: string;
  transcriptMd: string | null;
  summaryMd: string | null;
  audioPath: string;
  speakers: { localLabel: string; rosterId: string | null; displayName: string | null }[];
  actionItems: {
    id: string;
    text: string;
    ownerName: string | null;
    dueDate: string | null;
    status: string;
    exportedTo: string[];
  }[];
  models: { stt?: string; llm?: string };
}

export function MeetingDetailView({ id, onBack }: { id: string; onBack: () => void }): JSX.Element {
  const [m, setM] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>('summary');

  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      const d = (await api.meetings.get(id)) as MeetingDetail;
      if (alive) setM(d);
    }
    void load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  if (!m) return <div className="p-8 text-ink-muted">Loading…</div>;

  return (
    <div className="max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm">
          ← Library
        </button>
        <div className="flex-1 text-center font-semibold">{m.title}</div>
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-xl
          ${m.pipelineStage === 'done' ? 'bg-status-okBg text-status-ok' : 'bg-status-processingBg text-status-processing'}`}
        >
          {m.pipelineStage.toUpperCase()}
        </span>
      </div>

      <div className="grid grid-cols-[220px_1fr_240px] min-h-[560px]">
        <LeftRail meeting={m} />
        <CenterPane meeting={m} tab={tab} onTab={setTab} />
        <RightRail meeting={m} />
      </div>
    </div>
  );
}

function LeftRail({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  return (
    <div className="border-r border-surface-border p-4 space-y-3">
      <div>
        <div className="text-xs font-bold text-ink-muted uppercase">Title</div>
        <div className="font-semibold">{meeting.title}</div>
      </div>
      <div>
        <div className="text-xs font-bold text-ink-muted uppercase">Date</div>
        <div className="text-sm">{meeting.startedAt?.slice(0, 10) ?? '—'}</div>
      </div>
      <div>
        <div className="text-xs font-bold text-ink-muted uppercase">Models</div>
        {meeting.models.stt && <div className="text-xs">STT: {meeting.models.stt}</div>}
        {meeting.models.llm && <div className="text-xs">LLM: {meeting.models.llm}</div>}
      </div>
      <div className="pt-3 border-t border-surface-border space-y-1">
        <div className="text-xs font-bold text-ink-muted uppercase mb-1">Re-run</div>
        {(['transcribing', 'diarizing', 'summarizing'] as const).map((stage) => (
          <button
            key={stage}
            onClick={() => api.meetings.rerun(meeting.id, stage)}
            className="w-full text-left bg-surface-sunken border border-surface-border rounded-lg py-1 px-2 text-xs hover:border-brand-indigo hover:text-brand-indigo"
          >
            ↻ {stage}
          </button>
        ))}
      </div>
    </div>
  );
}

function CenterPane({
  meeting,
  tab,
  onTab,
}: {
  meeting: MeetingDetail;
  tab: Tab;
  onTab: (t: Tab) => void;
}): JSX.Element {
  return (
    <div>
      <div className="flex border-b border-surface-border px-4">
        {(['summary', 'transcript', 'audio'] as const).map((t) => (
          <button
            key={t}
            onClick={() => onTab(t)}
            className={`px-3 py-3 text-sm ${tab === t ? 'text-brand-indigo border-b-2 border-brand-indigo font-semibold' : 'text-ink-muted'}`}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="p-5">
        {tab === 'summary' && (
          <div className="prose prose-sm max-w-none whitespace-pre-wrap">
            {meeting.summaryMd ?? 'No summary yet.'}
          </div>
        )}
        {tab === 'transcript' && (
          <pre className="text-sm whitespace-pre-wrap leading-relaxed">
            {meeting.transcriptMd ?? 'No transcript yet.'}
          </pre>
        )}
        {tab === 'audio' && (
          <audio controls src={`file://${meeting.audioPath}`} className="w-full" />
        )}
      </div>
    </div>
  );
}

function RightRail({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  async function runExport(which: string): Promise<void> {
    try {
      await api.export.run(which, meeting.id);
    } catch (e) {
      alert((e as Error).message);
    }
  }
  return (
    <div className="border-l border-surface-border p-4 space-y-3">
      <div className="text-xs font-bold text-ink-muted uppercase">Speakers</div>
      {meeting.speakers.map((sp) => (
        <div
          key={sp.localLabel}
          className={`rounded-lg p-2 ${sp.rosterId ? 'bg-surface-sunken' : 'bg-status-warnBg border border-dashed border-status-warn'}`}
        >
          <div className="text-sm font-semibold">{sp.displayName ?? sp.localLabel}</div>
        </div>
      ))}
      <div className="pt-3 border-t border-surface-border space-y-2">
        <div className="text-xs font-bold text-ink-muted uppercase">Export</div>
        <button
          onClick={() => runExport('reminders')}
          className="w-full bg-brand-indigo text-white text-xs font-semibold rounded-lg py-2"
        >
          → Apple Reminders
        </button>
        <button
          onClick={() => runExport('markdown')}
          className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2"
        >
          ↓ Markdown
        </button>
        <button
          disabled
          className="w-full bg-surface-sunken text-ink-muted text-xs font-semibold rounded-lg py-2 cursor-not-allowed"
        >
          → Google Tasks (soon)
        </button>
      </div>
    </div>
  );
}
