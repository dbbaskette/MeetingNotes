// electron/renderer/src/App.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { LibraryView } from './views/LibraryView';
import { MeetingDetailView } from './views/MeetingDetailView';
import { SettingsView } from './views/SettingsView';
import { WeeklyView } from './views/WeeklyView';
import { PermissionsModal } from './components/PermissionsModal';
import { ToastHost, useToast } from './components/Toasts';
import { LiveRecordingRow } from './components/LiveRecordingRow';
import { SearchPalette, type PaletteTarget } from './components/SearchPalette';
import { PipelineStatusBar } from './components/PipelineStatusBar';
import { Icon } from './components/icons';
import { OnboardingView } from './views/OnboardingView';
import { api } from './ipc/client';
import { resolveDark, type ThemeChoice } from './lib/theme';
import { firstRunStatus } from './lib/setup-wizard';
import { requestLeave } from './lib/unsaved-guard';
import { createNavHistory, viewsEqual, type NavHistory } from './lib/nav-history';

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

/** The exact arguments a recording was started with. Kept on the live-
 *  recording state so an unexpected termination can offer "Record again"
 *  with the same source (#191) instead of making the user re-pick. */
export interface RecordingStartInput {
  targetPid: number | 'system';
  targetLabel: string;
  mic: boolean;
}

/** Lives at the App level (not inside LibraryView) so navigating between
 *  Library / Detail / Settings doesn't wipe the recording state. The Swift
 *  helper is a separate process and keeps running regardless; this state is
 *  just the UI's memory of "we've got a capture going". */
export interface LiveRecording {
  sessionId: string;
  label: string;
  startedAt: string;
  /** How the capture was started — powers the "Record again" retry. */
  startInput?: RecordingStartInput;
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

  // Navigation history (#190). Semantics live in lib/nav-history (unit-
  // tested there): de-dup via viewsEqual, forward-truncation on navigate,
  // 50-entry cap, and guard gating on every transition so a dirty summary
  // draft blocks back/forward/navigate exactly once — callers must not
  // pre-guard, or the discard dialog would appear twice.
  const navRef = useRef<NavHistory<View> | null>(null);
  if (navRef.current === null) {
    navRef.current = createNavHistory<View>({ kind: 'library' }, {
      equal: viewsEqual,
      guard: requestLeave,
      onChange: setView,
    });
  }
  // Methods are closures over the history's internal state (no `this`),
  // so destructuring is safe.
  const { navigate, back: goBack, forward: goForward } = navRef.current;

  const [permsOk, setPermsOk] = useState(true);
  const [liveRecording, setLiveRecordingState] = useState<LiveRecording | null>(null);
  // Ref mirror so the once-registered onStateChange listener can read the
  // current session without re-subscribing on every state change.
  const liveRecordingRef = useRef<LiveRecording | null>(null);
  const setLiveRecording = useCallback((r: LiveRecording | null): void => {
    liveRecordingRef.current = r;
    setLiveRecordingState(r);
  }, []);
  // Cmd+K global search palette state (#45). Opens over any view.
  const [searchOpen, setSearchOpen] = useState(false);
  // Drag-and-drop import state (#1 from the UX review). Tracks whether
  // a user is currently dragging files over the window so we can paint
  // an overlay; the actual file paths arrive via the drop handler.
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const toast = useToast();

  // Theme: read the persisted choice, apply it, and keep it live. 'system'
  // follows the OS; 'light'/'dark' override. We mirror the resolved choice to
  // localStorage so the inline script in index.html can paint flash-free on
  // the next launch. SettingsView dispatches 'mn:theme-changed' when the user
  // picks a different option.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    let choice: ThemeChoice = 'system';

    const apply = (): void => {
      const dark = resolveDark(choice, mq.matches);
      document.documentElement.classList.toggle('dark', dark);
      try { localStorage.setItem('mn-theme', choice); } catch { /* ignore */ }
    };

    void (async () => {
      const all = (await api.settings.getAll()) as { theme?: ThemeChoice };
      choice = all.theme ?? 'system';
      apply();
    })();

    const onSystemChange = (): void => { if (choice === 'system') apply(); };
    const onThemeChanged = (e: Event): void => {
      choice = (e as CustomEvent<ThemeChoice>).detail ?? 'system';
      apply();
    };
    mq.addEventListener('change', onSystemChange);
    window.addEventListener('mn:theme-changed', onThemeChanged as EventListener);
    return () => {
      mq.removeEventListener('change', onSystemChange);
      window.removeEventListener('mn:theme-changed', onThemeChanged as EventListener);
    };
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
      // History navigation (#190). ⌘[ back / ⌘] forward — the same
      // convention Safari and Finder use. The menu items in menu.ts emit
      // the same actions via mn:menu-action; this listener covers the
      // bare keystroke.
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault();
        void goBack();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault();
        void goForward();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, goForward]);
  const onPaletteOpen = (t: PaletteTarget): void => {
    // Meeting switch is destructive to an in-flight summary edit session in
    // the detail view — it registers an unsaved-edits guard while dirty.
    // navigate() itself consults the guard, so no separate check here.
    void navigate({
      kind: 'detail',
      id: t.meetingId,
      seekSeconds: t.seekSeconds,
      hint: { title: t.title },
    });
  };

  // Wizard state (#43). `null` = not loaded yet (show nothing),
  // 'needed' = show wizard, 'done' = past onboarding. `forceOpen` is set by
  // the Settings "Run setup again" button to re-open the wizard without
  // clearing onboardedAt — firstRunStatus() folds both inputs into one answer.
  const [onboardStatus, setOnboardStatus] = useState<null | 'needed' | 'done'>(null);
  const [forceOpenSetup, setForceOpenSetup] = useState(false);
  useEffect(() => {
    void (async () => {
      const all = (await api.settings.getAll()) as { onboardedAt: string | null };
      setOnboardStatus(firstRunStatus(all.onboardedAt));
    })();
  }, []);
  // Re-open path: recompute from the flag once it flips. onboardedAt stays put.
  useEffect(() => {
    if (forceOpenSetup) setOnboardStatus(firstRunStatus('forced', { forceOpen: true }));
  }, [forceOpenSetup]);

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
  // idle stop), the main process broadcasts a state change. A USER-initiated
  // stop never produces an 'idle'/'error' broadcast (that path goes through
  // 'stopping' and the LiveRecordingRow's own onStopped callback), so seeing
  // one here means the capture died unexpectedly — surface it loudly with
  // the helper's reason instead of silently swallowing the banner (#191).
  // The partial audio file still lands in the library via the watcher.
  useEffect(() => {
    const off = api.recording.onStateChange(({ sessionId, state, reason }) => {
      if (state !== 'idle' && state !== 'error') return;
      const cur = liveRecordingRef.current;
      if (cur?.sessionId !== sessionId) return;
      setLiveRecording(null);
      const why = state === 'error'
        ? reason ?? 'the recorder hit an error'
        : reason ?? 'the capture process exited';
      toast.show({
        message: `Recording stopped unexpectedly — ${why}. Audio captured so far was saved.`,
        variant: 'error',
        durationMs: 10_000,
        action: cur.startInput
          ? {
              label: 'Record again',
              onClick: async () => {
                try {
                  const r = await api.recording.start(cur.startInput!) as { sessionId: string };
                  setLiveRecording({
                    sessionId: r.sessionId,
                    label: cur.label,
                    startedAt: new Date().toISOString(),
                    startInput: cur.startInput,
                  });
                } catch (e) {
                  toast.show({
                    message: `Couldn't restart recording: ${(e as Error).message}`,
                    variant: 'error',
                  });
                }
              },
            }
          : undefined,
      });
    });
    return () => { off(); };
  }, [toast, setLiveRecording]);

  // Application menu actions. Items in the View / File menus emit named
  // actions; we map them to local state. (#5 from the UX review.)
  useEffect(() => {
    const off = api.onMenuAction((action) => {
      switch (action) {
        case 'toggle-record':
          window.dispatchEvent(new CustomEvent('mn:toggle-record'));
          break;
        case 'view-library':
          void navigate({ kind: 'library' });
          break;
        case 'view-weekly':
          void navigate({ kind: 'weekly' });
          break;
        case 'view-settings':
          void navigate({ kind: 'settings' });
          break;
        case 'nav-back':
          void goBack();
          break;
        case 'nav-forward':
          void goForward();
          break;
        case 'open-search':
          setSearchOpen(true);
          break;
      }
    });
    return () => { off(); };
  }, [goBack, goForward, navigate]);

  // meetingnotes://open?id=… — main process emits this when an external
  // caller invokes the URL scheme (#77). Navigate to the detail view.
  // navigate() consults the unsaved-edits guard.
  useEffect(() => {
    const off = api.onOpenMeeting((id) => {
      void navigate({ kind: 'detail', id });
    });
    return () => { off(); };
  }, [navigate]);

  // Auto-record-started — main process started a recording on its own
  // (Zoom + autoRecordZoom). Route into LiveRecording so the in-progress
  // card appears without a manual click. (#78 follow-up)
  useEffect(() => {
    const off = api.onAutoRecordingStarted(({ sessionId, label, startedAt }) => {
      setLiveRecording({ sessionId, label, startedAt });
    });
    return () => { off(); };
  }, [setLiveRecording]);

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
    <OnboardingView onFinished={() => { setForceOpenSetup(false); setOnboardStatus('done'); }} />
  ) : !permsOk ? (
    <PermissionsModal onAllGranted={() => setPermsOk(true)} />
  ) : view.kind === 'library' ? (
    <LibraryView
      onOpen={(id, hint, opts) => void navigate({ kind: 'detail', id, hint, seekSeconds: opts?.seekSeconds })}
      onNav={(target) => { if (target !== 'library') void navigate({ kind: target }); }}
      onOpenSearch={() => setSearchOpen(true)}
      liveRecording={liveRecording}
      onStartRecording={setLiveRecording}
      onRecordingStopped={(summary) => {
        setLiveRecording(null);
        toast.show({ message: summary, durationMs: 5000 });
      }}
    />
  ) : view.kind === 'detail' ? (
    <MeetingDetailView
      id={view.id}
      seekSeconds={view.seekSeconds}
      hint={view.hint}
      onBack={() => void goBack()}
    />
  ) : view.kind === 'weekly' ? (
    <WeeklyView
      onNav={(target) => { if (target !== 'weekly') void navigate({ kind: target }); }}
      onOpenMeeting={(id) => void navigate({ kind: 'detail', id })}
    />
  ) : (
    <SettingsView
      onNav={(target) => { if (target !== 'settings') void navigate({ kind: target }); }}
      onRunSetupAgain={() => { void navigate({ kind: 'library' }); setForceOpenSetup(true); }}
    />
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
              onStopped={(summary) => {
                setLiveRecording(null);
                toast.show({ message: summary, durationMs: 5000 });
              }}
              onRestarted={setLiveRecording}
            />
          </div>
        )}
        <div className="flex-1 min-h-0">
          {body}
        </div>
        {onboardStatus === 'done' && (
          <PipelineStatusBar onOpenMeeting={(id) => void navigate({ kind: 'detail', id })} />
        )}
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
        <Icon name="download" className="w-9 h-9 text-ink-muted opacity-60 mb-1" />
        <div className="text-base font-semibold">Drop audio to import</div>
        <div className="text-xs text-ink-muted">
          .m4a, .mp3, .wav, .aac, .flac — files land in your inbox as
          new pending meetings.
        </div>
      </div>
    </div>
  );
}
