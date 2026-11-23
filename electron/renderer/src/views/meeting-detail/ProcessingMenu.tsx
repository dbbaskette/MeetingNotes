// electron/renderer/src/views/meeting-detail/ProcessingMenu.tsx
// Moved out of MeetingDetailView.tsx (#256).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../ipc/client';
import { MeetingTemplatePicker } from '../../components/SummaryTemplates';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon, IconLabel } from '../../components/icons';
import { useMenuKeyboard } from '../../lib/menu-keyboard';
import { useToast } from '../../components/Toasts';
import type { MeetingDetail } from './types';

/** Processing actions for the meeting page header (#252). They used to fill
 *  a permanent 220px column beside the notes; they are needed rarely, so they
 *  now sit behind one button. The exception is a recording that has never
 *  been processed, where Process is the primary action and shown directly. */
export function ProcessingMenu({
  meeting, onReload,
}: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rerunStage, setRerunStage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const toast = useToast();
  const closePanel = useCallback(() => setOpen(false), []);
  // The panel mixes a template picker with action buttons, so it is a small
  // dialog rather than a menu: Tab moves through it, arrows step the buttons.
  useMenuKeyboard(panel, trigger, open, closePanel, { mixed: true });
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent): void => { if (!container.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);
  async function startProcessing(): Promise<void> {
    setBusy(true); setOperationError(null);
    try { await api.meetings.start(meeting.id); await onReload(); }
    catch (error) { setOperationError((error as Error).message); }
    finally { setBusy(false); }
  }
  // Cancel the in-progress run for this meeting (#298). Until now the only
  // Cancel was on the Library's queue banner.
  async function cancelRun(): Promise<void> {
    setCancelling(true); setOperationError(null);
    try {
      await api.pipeline.cancel(meeting.id);
      toast.show({ message: 'Stopping this meeting only. Original audio is retained.', durationMs: 4000 });
      await onReload();
    } catch (error) { setOperationError((error as Error).message); }
    finally { setCancelling(false); }
  }
  async function rerunFrom(stage: string): Promise<void> {
    setRerunStage(null); setOpen(false); setBusy(true); setOperationError(null);
    try { await api.meetings.rerun(meeting.id, stage); await onReload(); }
    catch (error) { setOperationError((error as Error).message); }
    finally { setBusy(false); }
  }

  // "Never been processed" = still sitting in the Inbox. The appropriate
  // control here is Process, not Re-run. Re-run only makes sense once there's
  // something to re-do (i.e. the pipeline has at least started).
  const neverProcessed =
    meeting.pipelineStage === 'discovered' && meeting.status === 'pending';
  const isProcessing = meeting.status === 'processing';
  const hasModels = !!(meeting.models.stt || meeting.models.llm);

  return (
    <div ref={container} className="relative shrink-0">
      <ConfirmDialog open={rerunStage !== null} title="Re-run processing?" body="Generated results from the selected stage onward will be replaced. Notes and action items are saved in history. When a transcript is replaced, its previous version (including edits) is kept as a snapshot in the meeting folder. Original audio and remembered terminology are kept." confirmLabel="Re-run" onCancel={() => setRerunStage(null)} onConfirm={() => { if (rerunStage) void rerunFrom(rerunStage); }}/>
      <div className="flex items-center gap-2">
        {neverProcessed && (
          <button
            type="button"
            onClick={() => void startProcessing()}
            disabled={busy}
            className="bg-brand-solid text-white text-sm font-semibold rounded-lg px-3 py-1.5 hover:bg-brand-solid/90 transition inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <Icon name="play" className="w-3.5 h-3.5" />
            Process recording
          </button>
        )}
        {isProcessing && (
          <button
            type="button"
            onClick={() => void cancelRun()}
            disabled={cancelling}
            className="text-xs font-semibold text-danger-text border border-danger-border rounded-lg px-2.5 py-1.5 hover:bg-danger-bg transition disabled:opacity-50"
          >
            {cancelling ? 'Cancelling…' : 'Cancel processing'}
          </button>
        )}
        {/* Shown before the first run too, so a notes template can be chosen
            up front instead of processing once and re-running (#298). */}
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-ink-muted hover:text-ink border border-surface-border rounded-lg px-2.5 py-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-indigo"
        >
          <IconLabel icon="chevron-down" className="flex-row-reverse">{neverProcessed ? 'Options' : 'Processing'}</IconLabel>
        </button>
      </div>
      {operationError && <p role="alert" className="absolute right-0 top-full mt-1 w-64 text-xs text-danger bg-surface border border-surface-border rounded-lg p-2 z-30">Could not queue processing: {operationError}</p>}
      {open && (
        <div ref={panel} role="dialog" aria-label="Processing options" tabIndex={-1} className="material-popover absolute right-0 top-full mt-1 z-30 w-72 bg-surface border border-surface-border rounded-lg shadow-pop p-3 space-y-3 text-left">
          {hasModels && (
            <div>
              <div className="text-[11px] text-ink-muted font-medium">Models used</div>
              {meeting.models.stt && <div className="text-xs">Transcription: {meeting.models.stt}</div>}
              {meeting.models.llm && <div className="text-xs">Notes: {meeting.models.llm}</div>}
            </div>
          )}
          <MeetingTemplatePicker meetingId={meeting.id} disabled={isProcessing} />
          {neverProcessed ? (
            <div className="text-xs text-ink-muted">
              The template applies when you process this recording.
            </div>
          ) : isProcessing ? (
            <div className="text-xs text-ink-muted italic">
              Processing in progress — re-run options will be available once it finishes or fails.
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="text-[11px] text-ink-muted font-medium">Re-run from…</div>
              {([
                ['transcribing', 'Transcription, then everything after'],
                ['diarizing', 'Speaker separation, then everything after'],
                ['summarizing', 'Notes and action items only'],
              ] as const).map(([stage, label]) => (
                <button
                  key={stage}
                  type="button"
                  onClick={() => { setOpen(false); setRerunStage(stage); }}
                  disabled={busy}
                  className="w-full text-left border border-surface-border rounded-lg py-1.5 px-2.5 text-[13px] text-ink-soft hover:border-brand-indigo/50 hover:text-ink transition disabled:opacity-50"
                >
                  <Icon name="rotate-cw" className="inline w-3.5 h-3.5 mr-1.5 align-[-2px]" />{label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
