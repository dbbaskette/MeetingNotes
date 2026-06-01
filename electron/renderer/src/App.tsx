// electron/renderer/src/App.tsx
import { useEffect, useRef, useState } from 'react';
import { LibraryView } from './views/LibraryView';
import { MeetingDetailView } from './views/MeetingDetailView';
import { SettingsView } from './views/SettingsView';
import { WeeklyView } from './views/WeeklyView';
import { PermissionsModal } from './components/PermissionsModal';
import { ToastHost, useToast } from './components/Toasts';
import { LiveRecordingRow } from './components/LiveRecordingRow';
import { SearchPalette, type PaletteTarget } from './components/SearchPalette';
import { OnboardingView } from './views/OnboardingView';
import { api } from './ipc/client';

type View =
  | { kind: 'library' }
  | {
      kind: 'detail';
      id: string;
      seekSeconds?: number;
      /** Optional row hints so the detail view's loading skeleton can
       *  render the title + stage chips immediately, before the full
       *  meetings:get IPC resolves. Long meetings with hundreds of KB
       *  of transcript markdown can take 200-500ms; without these
       *  hints the user stares at "Loading…" twice over a blank page. */
      hint?: { title?: string; pipelineStage?: string; status?: string };
    }
  | { kind: 'settings' }
  | { kind: 'weekly' };
/** Lives at the App level (not inside LibraryView) so navigating between
 *  Library / Detail / Settings doesn't wipe the recording state. The Swift
 *  helper is a separate process and keeps running regardless; this state is
 *  just the UI's memory of "we've got a capture going". */
export interface LiveRecording {
  sessionId: string;
  label: string;
  startedAt: string;
}

/** Outer wrapper just mounts ToastHost — the rest of the app lives in
 *  AppInner so it can call useToast for drag-drop import feedback. */
export function App(): JSX.Element {
  return (
    <ToastHost>
      <AppInner />
    </ToastHost>
  );
}

function AppInner(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'library' });
  const [permsOk, setPermsOk] = useState(true);
  const [liveRecording, setLiveRecording] = useState<LiveRecording | null>(null);
  // Cmd+K global search palette state (#45). Opens over any view.
  const [searchOpen, setSearchOpen] = useState(false);
  // Drag-and-drop import state (#1 from the UX review). Tracks whether
  // a user is currently dragging files over the window so we can paint
  // an overlay; the actual file paths arrive via the drop handler.
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const toast = useToast();

  // Track the OS dark-mode preference and toggle the `dark` class on
  // <html> so the CSS-variable palette in index.css swaps the whole UI.
  // Class-based (not pure media-query) so a future Settings toggle can
  // override the OS preference without re-architecting.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark: boolean): void => {
      document.documentElement.classList.toggle('dark', dark);
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Global keyboard shortcuts. Cmd+K opens search palette; Cmd+R is
  // dispatched as a custom event the LibraryView's RecordButton wrapper
  // listens for (#5 from the UX review), so the same shortcut works from
  // any view but only acts when the recording UI is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Skip when the user is editing text — Cmd+R inside a textarea
      // shouldn't trigger Record.
      const target = e.target as HTMLElement | null;
      const editable = target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      );
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if (!editable && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('mn:toggle-record'));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onPaletteOpen = (t: PaletteTarget): void => {
    setView({
      kind: 'detail',
      id: t.meetingId,
      seekSeconds: t.seekSeconds,
      hint: { title: t.title },
    });
  };

  // Wizard state (#43). `null` = not loaded yet (show nothing),
  // 'needed' = show wizard, 'done' = past onboarding.
  const [onboardStatus, setOnboardStatus] = useState<null | 'needed' | 'done'>(null);
  useEffect(() => {
    void (async () => {
      const all = (await api.settings.getAll()) as { onboardedAt: string | null };
      setOnboardStatus(all.onboardedAt ? 'done' : 'needed');
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      // Use the authoritative Electron mic-status API, not the helper's
      // probe — the helper falsely reports 'granted' because its audio_capture
      // check creates an empty tap which always succeeds. Audio-capture grant
      // is checked at first Record click via the actual Process Tap call.
      const mic = (await api.permissions.micStatus()) as string;
      setPermsOk(mic === 'granted');
    })();
  }, []);

  // If the helper exits on its own (target app quit, parent-watch timeout,
  // idle stop), the main process broadcasts a state change. Clear the UI's
  // live-recording memory so the banner disappears and the next Record
  // click starts fresh.
  useEffect(() => {
    const off = api.recording.onStateChange(({ sessionId, state }) => {
      if (state === 'idle' || state === 'error') {
        setLiveRecording((cur) => (cur?.sessionId === sessionId ? null : cur));
      }
    });
    return () => { off(); };
  }, []);

  // Application menu actions. Items in the View / File menus emit named
  // actions; we map them to local state. (#5 from the UX review.)
  useEffect(() => {
    const off = api.onMenuAction((action) => {
      switch (action) {
        case 'toggle-record':
          window.dispatchEvent(new CustomEvent('mn:toggle-record'));
          break;
        case 'view-library':
          setView({ kind: 'library' });
          break;
        case 'view-weekly':
          setView({ kind: 'weekly' });
          break;
        case 'view-settings':
          setView({ kind: 'settings' });
          break;
        case 'open-search':
          setSearchOpen(true);
          break;
      }
    });
    return () => { off(); };
  }, []);

  // meetingnotes://open?id=… — main process emits this when an external
  // caller invokes the URL scheme (#77). Navigate to the detail view.
  useEffect(() => {
    const off = api.onOpenMeeting((id) => {
      setView({ kind: 'detail', id });
    });
    return () => { off(); };
  }, []);

  // Auto-record-started — main process started a recording on its own
  // (Zoom + autoRecordZoom). Route into LiveRecording so the in-progress
  // card appears without a manual click. (#78 follow-up)
  useEffect(() => {
    const off = api.onAutoRecordingStarted(({ sessionId, label, startedAt }) => {
      setLiveRecording({ sessionId, label, startedAt });
    });
    return () => { off(); };
  }, []);

  // Window-level drag-and-drop. We listen on document so a drop anywhere
  // in the window works — not just over the library list. The dragCounter
  // ref handles the dragenter/dragleave fires from child elements, which
  // would otherwise toggle the overlay off-and-on as the cursor crosses
  // internal boundaries. (#1 from the UX review.)
  useEffect(() => {
    const onDragEnter = (e: DragEvent): void => {
      // Only react when the dragged payload is files. Text drags from
      // inside the app shouldn't paint the import overlay.
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      e.preventDefault();
      dragCounter.current += 1;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent): void => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent): void => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      // Electron exposes the absolute path on File via `path`; the DOM
      // type doesn't admit it, so we cast through unknown.
      const paths = files
        .map((f) => (f as unknown as { path?: string }).path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (paths.length === 0) return;
      void (async () => {
        try {
          const r = await api.meetings.importDropped(paths);
          if (r.imported > 0 && r.skipped.length === 0) {
            toast.show({
              message: `Imported ${r.imported} recording${r.imported === 1 ? '' : 's'} to inbox`,
              durationMs: 4000,
            });
          } else if (r.imported > 0 && r.skipped.length > 0) {
            toast.show({
              message: `Imported ${r.imported}, skipped ${r.skipped.length} (${r.skipped[0]!.reason})`,
              durationMs: 5000,
            });
          } else if (r.skipped.length > 0) {
            toast.show({
              message: `Couldn't import: ${r.skipped[0]!.reason}`,
              durationMs: 5000,
            });
          }
        } catch (e) {
          toast.show({
            message: `Import failed: ${(e as Error).message}`,
            durationMs: 5000,
          });
        }
      })();
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [toast]);

  const body = onboardStatus === null ? (
    <div className="p-8 text-sm text-ink-muted">Loading…</div>
  ) : onboardStatus === 'needed' ? (
    <OnboardingView onFinished={() => setOnboardStatus('done')} />
  ) : !permsOk ? (
    <PermissionsModal onAllGranted={() => setPermsOk(true)} />
  ) : view.kind === 'library' ? (
    <LibraryView
      onOpen={(id, hint, opts) => setView({ kind: 'detail', id, hint, seekSeconds: opts?.seekSeconds })}
      onSettings={() => setView({ kind: 'settings' })}
      onWeekly={() => setView({ kind: 'weekly' })}
      liveRecording={liveRecording}
      onStartRecording={setLiveRecording}
      onRecordingStopped={() => setLiveRecording(null)}
    />
  ) : view.kind === 'detail' ? (
    <MeetingDetailView
      id={view.id}
      seekSeconds={view.seekSeconds}
      hint={view.hint}
      onBack={() => setView({ kind: 'library' })}
    />
  ) : view.kind === 'weekly' ? (
    <WeeklyView
      onBack={() => setView({ kind: 'library' })}
      onOpenMeeting={(id) => setView({ kind: 'detail', id })}
    />
  ) : (
    <SettingsView onBack={() => setView({ kind: 'library' })} />
  );

  // Persistent recording banner on views that don't show the LibraryView's
  // inline live row. Keeps the user aware that capture is still going even
  // when they've drilled into a meeting or wandered into settings.
  const showTopBanner = liveRecording && view.kind !== 'library';

  return (
    <>
      <div className="window-drag-strip" />
      {/* The shell is a flex column that fills #root (height: 100% from
          index.css). Views below render inside the flex-1 slot and own
          their own scroll regions — the document itself doesn't scroll
          anymore, which is what lets Library / Detail keep their
          headers and filter chips pinned in place. */}
      <div className="h-full flex flex-col">
        {showTopBanner && (
          <div className="shrink-0 z-[900] max-w-6xl mx-auto w-full px-6 pt-2">
            <LiveRecordingRow
              sessionId={liveRecording!.sessionId}
              label={liveRecording!.label}
              startedAt={liveRecording!.startedAt}
              onStopped={() => setLiveRecording(null)}
            />
          </div>
        )}
        <div className="flex-1 min-h-0">
          {body}
        </div>
      </div>
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenMeeting={onPaletteOpen}
      />
      {dragActive && <DropOverlay />}
    </>
  );
}

/** Full-window translucent overlay shown while files are being dragged
 *  in. Pure visual feedback — the actual drop is handled by the
 *  document-level listener in AppInner. */
function DropOverlay(): JSX.Element {
  return (
    <div className="fixed inset-0 z-[2000] pointer-events-none flex items-center justify-center bg-brand-indigo/15 backdrop-blur-[2px]">
      <div className="bg-surface rounded-2xl shadow-pop border-2 border-dashed border-brand-indigo px-10 py-8 flex flex-col items-center gap-3 max-w-md text-center">
        <div className="text-3xl">⬇︎</div>
        <div className="text-base font-semibold">Drop audio to import</div>
        <div className="text-xs text-ink-muted">
          .m4a, .mp3, .wav, .aac, .flac — files land in your inbox as
          new pending meetings.
        </div>
      </div>
    </div>
  );
}
