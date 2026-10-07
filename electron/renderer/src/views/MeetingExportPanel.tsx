import { useEffect, useRef, useState } from 'react';
import { api } from '../ipc/client';
import { useToast } from '../components/Toasts';
import { Icon } from '../components/icons';
import { exportTarget } from '../../../main/ipc/export-targets';
import type { MeetingDetail } from './MeetingDetailView';

export function MeetingExportPanel({ meeting, onReload }: {
  meeting: MeetingDetail;
  onReload: () => Promise<void>;
}): JSX.Element {
  const toast = useToast();
  // Two-step export: clicking a destination opens a modal listing every action
  // item with a checkbox, so the user can opt out of the ones that aren't
  // theirs (LLMs love to turn "somebody should do X" into an action item
  // regardless of who X is). `exporting` holds both the exporter id and a
  // human label so the modal knows where it's sending.
  const [exporting, setExporting] = useState<{ id: string; label: string } | null>(null);
  const [fileExportError, setFileExportError] = useState<string | null>(null);
  // Google exporters are enabled once the user has signed in (Settings →
  // Google account). Fetched once when the rail mounts. We keep the full
  // status (not just the boolean) so the panel can show which account is
  // connected instead of making the user discover connection state only by
  // trying to click a disabled button.
  const [googleStatus, setGoogleStatus] = useState<{ email: string | null; signedIn: boolean } | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleCheck, setGoogleCheck] = useState(0);
  useEffect(() => {
    let alive = true;
    void api.google.authStatus().then((s) => {
      if (alive) { setGoogleStatus(s); setGoogleError(null); }
    }).catch((error: unknown) => {
      if (alive) { setGoogleStatus(null); setGoogleError((error as Error).message || 'Unable to check Google connection'); }
    });
    return () => { alive = false; };
  }, [googleCheck]);
  const googleSignedIn = googleStatus?.signedIn ?? false;
  const hasItems = meeting.actionItems.length > 0;
  // Markdown export includes the summary + a checklist of action items,
  // so it's useful whenever there's something on disk to export — even a
  // summary with zero action items is worth downloading. Apple Reminders
  // and (future) Google Tasks only sync action items, so those stay
  // gated on hasItems.
  const hasSummary = Boolean(meeting.summaryMd && meeting.summaryMd.trim().length > 0);
  const canDocumentExport = hasItems || hasSummary;
  // Task-app exports (Reminders, Google Tasks) only send items assigned to
  // the user, so they're gated on the user having identified themselves AND
  // actually owning at least one open item.
  const myOpenItemCount = meeting.actionItems.filter((it) => it.isMine && it.status !== 'done').length;
  const canTaskExport = meeting.userIdentified && myOpenItemCount > 0;
  const taskDisabledReason = !meeting.userIdentified
    ? 'Set who you are in Settings → "You are…" to export your action items'
    : myOpenItemCount === 0
      ? 'No open action items are assigned to you'
      : undefined;

  // When there are action items the user probably wants to pick which ones
  // to include, so open the item-picker modal. When there aren't (summary-
  // only export), bypass the modal — just prompt for a save location and
  // write the file with an empty items array (the markdown exporter
  // renders just the summary + an empty "## Action Items" section).
  async function exportFile(format: 'markdown' | 'pdf'): Promise<void> {
    const target = exportTarget(format)!;
    const label = target.label;
    if (hasItems) { setExporting({ id: format, label }); return; }
    setFileExportError(null);
    try {
      const safeTitle = meeting.title.replace(/[^\w\s-]+/g, '').trim() || 'meeting';
      const picked = await api.dialog.save({
        defaultPath: `${safeTitle}.${target.extension}`,
        filters: [{ name: label, extensions: [target.extension!] }],
      });
      if (!picked) return;
      const savedPath = await api.export.run(format, meeting.id, [], picked);
      await onReload();
      toast.show({ message: `Saved ${label} to ${savedPath}`, durationMs: 6000 });
    } catch (e) {
      setFileExportError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <div className="pt-3 border-t border-surface-border space-y-2">
        <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-ink-muted font-semibold flex items-center justify-between">
          <span>Export</span>
          {hasItems && (
            <span className="text-ink-muted/80 font-normal tabular-nums">
              {meeting.actionItems.length} action{meeting.actionItems.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {/* All available exporters render with the same ghost-button
            treatment so the panel doesn't claim a winner. The earlier
            design painted Apple Reminders as the hero (saturated
            indigo) and Markdown as the quiet alternative — but most
            users export to Markdown for distribution and Reminders is
            the platform-specific niche. Equal weight lets the user
            choose without the UI nudging. Disabled exporters keep the
            muted treatment so it's clear which options are live, and
            their reason renders as an inline hint line (#202) — the old
            title-only tooltips were invisible to trackpad and keyboard
            users. */}
        <div className="space-y-2">
          <button
            disabled={!canTaskExport}
            onClick={() => setExporting({ id: 'reminders', label: 'Apple Reminders' })}
            className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 hover:text-ink transition"
          >
            → Apple Reminders
          </button>
          {!canTaskExport && (
            <DisabledHint text={taskDisabledReason ?? 'Needs action items — run Extract first'} />
          )}
        </div>
        <div className="space-y-2">
          <button
            disabled={!canDocumentExport}
            onClick={() => void exportFile('markdown')}
            className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 hover:text-ink transition"
          >
            ↓ Markdown
          </button>
          {!canDocumentExport && <DisabledHint text="Needs notes or action items to export" />}
        </div>
        <div className="space-y-2">
          <button
            disabled={!canDocumentExport}
            onClick={() => void exportFile('pdf')}
            className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 hover:text-ink transition"
          >
            ↓ PDF
          </button>
          {!canDocumentExport && <DisabledHint text="Needs notes or action items to export" />}
        </div>
        {fileExportError && (
          <div className="text-[11px] text-danger">{fileExportError}</div>
        )}
        {googleStatus && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted px-0.5">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${googleSignedIn ? 'bg-status-ok' : 'bg-ink-muted/40'}`}
              aria-hidden
            />
            <span className="truncate">
              {googleSignedIn ? `Google: ${googleStatus.email ?? 'connected'}` : 'Google: not connected'}
            </span>
          </div>
        )}
        {googleError && (
          <div className="text-[11px] text-danger px-0.5" role="alert">
            Google connection check failed: {googleError}{' '}
            <button className="underline font-semibold" onClick={() => setGoogleCheck((n) => n + 1)}>Retry</button>
          </div>
        )}
        <div className="space-y-2">
          <button
            disabled={!googleSignedIn || !canTaskExport}
            onClick={() => setExporting({ id: 'google-tasks', label: 'Google Tasks' })}
            className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 hover:text-ink transition"
          >
            → Google Tasks{googleSignedIn ? '' : ' (connect in Settings)'}
          </button>
          {!googleSignedIn && <DisabledHint text={googleError ? 'Connection status unavailable — retry above' : 'Connect a Google account in Settings'} />}
          {googleSignedIn && !canTaskExport && taskDisabledReason && (
            <DisabledHint text={taskDisabledReason} />
          )}
        </div>
        <div className="space-y-2">
          <button
            disabled={!googleSignedIn || !canDocumentExport}
            onClick={() => setExporting({ id: 'google-doc', label: 'Google Doc' })}
            className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2 disabled:opacity-40 disabled:cursor-not-allowed hover:border-ink/30 hover:text-ink transition"
          >
            → Google Doc{googleSignedIn ? '' : ' (connect in Settings)'}
          </button>
          {!googleSignedIn && <DisabledHint text={googleError ? 'Connection status unavailable — retry above' : 'Connect a Google account in Settings'} />}
          {googleSignedIn && !canDocumentExport && <DisabledHint text="Needs a summary — run Summarize first" />}
        </div>
        {/* Persistent reminder: task-app exports are scoped to the user's own
            items, so this is never a surprise. */}
        <div className="text-[11px] text-ink-muted flex items-start gap-1.5 pt-0.5">
          <Icon name="lock" className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>
            Reminders &amp; Google Tasks send <strong className="font-semibold">only items assigned to you</strong>
            {meeting.userIdentified ? '.' : ' — set "You are…" in Settings first.'}
          </span>
        </div>
        {!hasItems && hasSummary && (
          <div className="text-[11px] text-ink-muted italic mt-1">
            Summary ready — no action items extracted. Markdown and PDF downloads
            still work; Reminders needs action items.
          </div>
        )}
        {!hasSummary && !hasItems && (
          <div className="text-[11px] text-ink-muted italic mt-1">
            No summary or action items yet. Run Summarize + Extract.
          </div>
        )}
      </div>
      {exporting && (
        <ExportPickerModal
          meeting={meeting}
          exporter={exporting}
          onClose={() => setExporting(null)}
          onReload={onReload}
        />
      )}
    </div>
  );
}

/** Inline reason line under a disabled export button (#202). Replaces the
 *  hover-only `title` tooltip, which trackpad and keyboard users could
 *  never see. */
function DisabledHint({ text }: { text: string }): JSX.Element {
  return (
    <div className="text-[11px] text-ink-muted italic leading-snug -mt-1">{text}</div>
  );
}

function ExportPickerModal({
  meeting, exporter, onClose, onReload,
}: {
  meeting: MeetingDetail;
  exporter: { id: string; label: string };
  onClose: () => void;
  onReload: () => Promise<void>;
}): JSX.Element {
  // Task-app exporters only send the user's own items, so the picker lists
  // only those (the rest of the meeting's items aren't relevant to a personal
  // to-do list). Document exporters list everything.
  const target = exportTarget(exporter.id);
  const isTaskApp = target?.ownOpenItemsOnly ?? false;
  // Document exporters render the full meeting and are
  // valid even with no items selected (the summary still exports).
  const isDocumentExport = target?.allowsEmptySelection ?? false;
  const visibleItems = isTaskApp
    ? meeting.actionItems.filter((it) => it.isMine && it.status !== 'done')
    : meeting.actionItems;
  const openItems = visibleItems.filter((it) => it.status !== 'done');
  const completedItems = visibleItems.filter((it) => it.status === 'done');
  const orderedItems = [...openItems, ...completedItems];
  // Default: every open visible item pre-selected. Done items (already checked
  // off in the app) start unchecked because you rarely want to re-export them.
  const [selected, setSelected] = useState<Set<string>>(() => {
    return new Set(visibleItems.filter((it) => it.status !== 'done').map((it) => it.id));
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAll(): void { setSelected(new Set(visibleItems.map((it) => it.id))); }
  function selectNone(): void { setSelected(new Set()); }

  async function run(): Promise<void> {
    if (selected.size === 0 && !isDocumentExport) return;
    setBusy(true); setError(null);
    try {
      let outputPath: string | undefined;
      // File exporters ask where to
      // save before running so the user doesn't have to hunt for the file
      // inside the meeting folder afterwards. Apple Reminders writes into
      // the OS, not a file, so no prompt needed.
      if (target?.kind === 'file') {
        const safeTitle = meeting.title.replace(/[^\w\s-]+/g, '').trim() || 'action-items';
        const picked = await api.dialog.save({
          defaultPath: `${safeTitle}.${target.extension}`,
          filters: [{ name: target.label, extensions: [target.extension!] }],
        });
        if (!picked) { setBusy(false); return; } // user cancelled; stay open
        outputPath = picked;
      }
      const message = (await api.export.run(exporter.id, meeting.id, [...selected], outputPath)) as string;
      // Google Doc returns the Doc URL — copy it so the user can paste/open it.
      if (exporter.id === 'google-doc' && /^https?:\/\//.test(message)) {
        try { await navigator.clipboard.writeText(message); } catch { /* clipboard blocked */ }
      }
      setResult(message);
      await onReload();
      // Auto-close after a beat so the ✓ message is visible but the user
      // doesn't have to click Close.
      closeTimer.current = setTimeout(onClose, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl shadow-2xl border border-surface-border w-full max-w-xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-surface-border flex items-baseline gap-3">
          <h3 className="font-semibold text-sm">{isDocumentExport ? 'Export' : 'Send to'} {exporter.label}</h3>
          <span className="text-xs text-ink-muted tabular-nums">
            {selected.size}/{visibleItems.length} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={selectAll}
            className="text-[11px] font-semibold text-brand-indigo hover:underline"
          >All</button>
          <button
            onClick={selectNone}
            className="text-[11px] font-semibold text-ink-muted hover:underline"
          >None</button>
        </div>

        {isTaskApp && (
          <div className="mx-3 mt-2 text-[11px] text-ink-soft bg-brand-indigo/5 border border-brand-indigo/20 rounded-lg px-3 py-2 flex items-start gap-1.5">
            <Icon name="lock" className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>Only action items assigned to <strong className="font-semibold">you</strong> are sent to {exporter.label}.</span>
          </div>
        )}
        {exporter.id === 'pdf' && (
          <p className="mx-5 mt-3 text-xs text-ink-muted">
            Select action items to include, or choose None for notes only.
          </p>
        )}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {visibleItems.length === 0 && (
            <div className="text-sm text-ink-muted italic p-3">
              {isTaskApp
                ? 'No open action items are assigned to you.'
                : 'No action items yet. This export will contain notes only.'}
            </div>
          )}
          {orderedItems.map((it, index) => {
            const checked = selected.has(it.id);
            return (
              <div key={it.id}>
              {(index === 0 || (it.status === 'done' && orderedItems[index - 1]?.status !== 'done')) && (
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  {it.status === 'done' ? `Completed — ${completedItems.length} (not selected by default)` : `Open — ${openItems.length}`}
                </div>
              )}
              <label
                className={`flex items-start gap-3 p-2.5 rounded-lg cursor-pointer transition-colors
                  ${checked ? 'bg-brand-indigo/5' : 'hover:bg-surface-sunken'}
                  ${it.status === 'done' ? 'opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(it.id)}
                  className="mt-1 w-4 h-4 accent-brand-indigo shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink">{it.text}</div>
                  <div className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-2">
                    {it.ownerName && (
                      <span className="inline-flex items-center gap-1">
                        <Icon name="user" className="w-3 h-3" />
                        {it.ownerName}
                      </span>
                    )}
                    {it.dueDate && (
                      <span className="inline-flex items-center gap-1">
                        <Icon name="calendar" className="w-3 h-3" />
                        {it.dueDate}
                      </span>
                    )}
                    {it.status === 'done' && (
                      <span className="bg-status-okBg text-status-ok font-semibold px-1.5 rounded">DONE</span>
                    )}
                    {it.exportedTo.includes(exporter.id) && (
                      <span className="bg-surface-sunken text-ink-muted font-semibold px-1.5 rounded">
                        already sent
                      </span>
                    )}
                  </div>
                </div>
              </label>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-surface-border flex items-center gap-3">
          {error && <div className="text-xs text-danger flex-1 truncate" title={error}>{error}</div>}
          {result && /^https?:\/\//.test(result) ? (
            <div className="text-xs text-status-ok flex-1 truncate" title={result}>
              ✓ Google Doc created —{' '}
              <a href={result} target="_blank" rel="noreferrer" className="underline">open</a>
              {' '}(link copied)
            </div>
          ) : result ? (
            <div className="text-xs text-status-ok flex-1 truncate" title={result}>✓ {result}</div>
          ) : null}
          {!error && !result && <div className="flex-1" />}
          <button
            onClick={onClose}
            className="text-sm text-ink-muted hover:text-ink px-3 py-1.5 rounded-lg hover:bg-surface-sunken transition"
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              disabled={busy || (selected.size === 0 && !isDocumentExport)}
              onClick={run}
              className="text-sm font-semibold bg-brand-indigo text-white px-4 py-1.5 rounded-lg hover:bg-brand-indigo/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {exporter.id === 'google-doc'
                ? (busy ? 'Creating…' : 'Create Doc')
                : isDocumentExport
                  ? (busy ? 'Exporting…' : `Export ${exporter.label}`)
                  : (busy ? 'Sending…' : `Send ${selected.size}`)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
