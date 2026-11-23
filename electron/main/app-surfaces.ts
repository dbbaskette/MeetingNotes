import { app, BrowserWindow, globalShortcut, nativeTheme, Notification } from 'electron';
import { MenuBarController } from './menu-bar/controller.js';
import { formatElapsed } from './menu-bar/model.js';
import { RecordShortcut } from './menu-bar/shortcut.js';
import { SILENCE_AUTO_STOP_REASON } from './recording/manager.js';
import { IPC_CHANNELS } from './ipc/contracts.js';
import { MeetingDetector } from './meeting-detector/detector.js';
import { NativeAppDetector } from './meeting-detector/native-app-detector.js';
import { SchemeDispatcher } from './url-scheme/dispatcher.js';
import { shouldNotifyGate } from './pipeline/gate-alert.js';
import { createWindow } from './app-window.js';
import { setSchemeDispatcher } from './scheme-urls.js';
import type { Services } from './services.js';

/**
 * Wires the user-facing surfaces onto the services: notifications, meeting
 * detectors, the meetingnotes:// dispatcher, the menu-bar item, the global
 * record shortcut and the silence and speaker-gate prompts.
 */
export function wireAppSurfaces(services: Services, smokeRoot: string | null) {
  const {
    s, settings, meetings, logger, recordingManager, recordingSessionsRepo, appEnumerator, pipeline, gateNotified,
  } = services;

  // Window helpers shared by notifications, the menu bar and the URL scheme.
  const focusMainWindow = (): void => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) return;
    const target = wins[0]!;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  };
  const openMainWindow = (): void => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(nativeTheme.shouldUseDarkColors ? '#171615' : '#fafaf9');
    else focusMainWindow();
  };

  // A Notification that has been garbage-collected no longer delivers its
  // click, so the most recent ones are held until newer ones replace them.
  const recentNotifications: Notification[] = [];
  const showNotification = (n: Notification): void => {
    recentNotifications.push(n);
    if (recentNotifications.length > 20) recentNotifications.shift();
    n.show();
  };

  // A detected meeting shows a banner in the window. When no MeetingNotes
  // window has focus the banner goes unseen, so say it with a notification
  // too (#297). The detectors fire once per meeting and honour dismissals and
  // their own on/off settings, so there is nothing to de-duplicate here.
  const notifyMeetingDetected = (what: string): void => {
    if (BrowserWindow.getFocusedWindow()) return;
    try {
      if (!Notification.isSupported()) return;
      // A browser tab title can span lines and run long.
      const text = what.replace(/\s+/g, ' ').trim();
      const name = text.length > 60 ? `${text.slice(0, 59)}…` : text;
      const n = new Notification({ title: `Meeting detected — ${name}`, body: 'Click to open MeetingNotes and record it.' });
      n.on('click', openMainWindow);
      showNotification(n);
    } catch (err) {
      logger.error('meeting-detector:notify-failed', { err: String(err) });
    }
  };

  // Meeting auto-detect (#12 browser tabs, #78 native apps). Two detectors,
  // each opt-in via its own toggle inside the autoDetectMeetings setting
  // object. Both broadcast on the same renderer event channel so the
  // banner can switch on `source` to pick its copy.
  const meetingDetector = new MeetingDetector({
    isSuppressed: () => recordingManager.active().length > 0 || recordingSessionsRepo.findOpen().length > 0,
  });
  meetingDetector.onDetected((m) => {
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.meetingDetectedEvent, { source: 'browser-tab', ...m }));
    notifyMeetingDetected(m.title?.trim() || m.platform);
  });
  const nativeAppDetector = new NativeAppDetector({
    appEnumerator,
    getSilenceMs: () => settings.get('autoDetectMeetings').silenceMs,
    isSuppressed: () => recordingManager.active().length > 0 || recordingSessionsRepo.findOpen().length > 0,
    log: (msg, data) => logger.info(msg, data),
  });
  nativeAppDetector.onDetected((m) => {
    // Zoom auto-record path (#78 follow-up). When the user has opted into
    // "always record Zoom", skip the banner and start a recording right
    // away. Any other meeting app still surfaces the confirm-first banner.
    // Existing recordings, dismissals, and the silenceMs debounce are
    // already handled inside the detector — by the time we get here the
    // detector has decided this is a fresh, undismissed call worth
    // surfacing.
    if (m.bundleId === 'us.zoom.xos' && settings.get('autoRecordZoom')) {
      void (async () => {
        try {
          const { sessionId } = await recordingManager.start({
            targetPid: m.pid,
            targetLabel: m.appName,
            mic: true,
          });
          const startedAt = new Date().toISOString();
          logger.info('native-detector:auto-record-started', {
            bundleId: m.bundleId, sessionId, label: m.appName,
          });
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send('mn:auto-recording-started', {
              sessionId, label: m.appName, startedAt,
              startInput: { targetPid: m.pid, targetLabel: m.appName, mic: true },
            });
          }
        } catch (err) {
          // If auto-record fails (helper not running, mic perm denied),
          // fall back to the banner so the user has a clear path forward
          // instead of a silent failure.
          logger.error('native-detector:auto-record-failed', {
            bundleId: m.bundleId, err: String(err),
          });
          for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send(IPC_CHANNELS.meetingDetectedEvent, m);
          }
          notifyMeetingDetected(m.appName);
        }
      })();
      return;
    }
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.meetingDetectedEvent, m));
    notifyMeetingDetected(m.appName);
  });
  if (s.autoDetectMeetings.browserTabs) meetingDetector.start();
  if (s.autoDetectMeetings.nativeApps) nativeAppDetector.start();

  // meetingnotes:// URL scheme dispatcher (#77). Wires the protocol-handler
  // verbs (record / stop / open) into the existing recording + window
  // surfaces. Pending URLs that arrived before whenReady completes are
  // flushed here.
  // Used by both the URL-scheme dispatcher and the speaker-gate notification
  // below, so a notification click routes exactly like a
  // meetingnotes://open?id=… deeplink.
  const emitOpenMeeting = (meetingId: string): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('mn:open-meeting', meetingId);
    }
  };
  const schemeDispatcher = new SchemeDispatcher({
    recordingManager,
    appEnumerator,
    recordingSessionsRepo,
    meetings,
    emitOpenMeeting,
    notify: ({ title, body }) => {
      try {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      } catch (err) {
        logger.error('url-scheme:notify-failed', { err: String(err) });
      }
    },
    focusMainWindow,
    logger,
  });
  setSchemeDispatcher(schemeDispatcher);

  // Menu-bar item and global shortcut (#253). Both act through the URL-scheme
  // dispatcher, so they share its single recorder reservation and its
  // "already recording" guidance, and neither raises the window.
  const dispatcher = schemeDispatcher;
  const menuBar = new MenuBarController({
    getState: () => {
      const open = recordingSessionsRepo.findOpen()[0];
      const status = pipeline.getStatus();
      const silence = recordingManager.silenceState();
      return {
        silencePrompt: silence ? { autoStopAt: silence.autoStopAtMs } : null,
        recording: open ? { label: open.targetLabel, startedAt: Date.parse(open.startedAt) || Date.now() } : null,
        processingTitle: status.currentId ? meetings.findById(status.currentId)?.title ?? null : null,
        queued: status.queueLength,
        paused: status.paused,
      };
    },
    onAction: (action) => {
      switch (action) {
        case 'record-system': void dispatcher.dispatch('meetingnotes://record?source=all', { focusWindow: false }); break;
        case 'stop': void dispatcher.dispatch('meetingnotes://stop', { focusWindow: false }); break;
        case 'continue-silence': {
          const pending = recordingManager.silenceState();
          if (pending) recordingManager.continueSilence(pending.sessionId);
          break;
        }
        case 'record-choose': {
          const hadWindow = BrowserWindow.getAllWindows().length > 0;
          openMainWindow();
          // The source picker lives in the renderer. A window created just now
          // is not listening yet; it opens on the Library with Record in view.
          if (hadWindow) BrowserWindow.getAllWindows()[0]?.webContents.send('mn:menu-action', 'toggle-record');
          break;
        }
        case 'open-window': openMainWindow(); break;
        case 'toggle-queue': if (pipeline.getStatus().paused) pipeline.resume(); else pipeline.pause(); break;
        case 'quit': app.quit(); break;
      }
    },
  });
  recordingManager.on('state-change', () => menuBar.refresh());
  pipeline.onStatusChange(() => menuBar.refresh());

  // Silence prompt (#305). The recorder decides in the main process, so this
  // works with the window unfocused or closed: every window is told, the menu
  // bar offers the same two answers, and a notification asks the question
  // when no MeetingNotes window has focus.
  let silenceNotification: Notification | null = null;
  const closeSilenceNotification = (): void => {
    try { silenceNotification?.close(); } catch { /* already dismissed */ }
    silenceNotification = null;
  };
  recordingManager.on('silence-prompt', (prompt) => {
    logger.info('recording:silence-prompt', { ...prompt });
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingSilencePromptEvent, prompt));
    menuBar.refresh();
    closeSilenceNotification();
    if (BrowserWindow.getFocusedWindow()) return;
    try {
      if (!Notification.isSupported()) return;
      // macOS shows the buttons only for a signed app whose notifications are
      // set to Alerts; otherwise the click still opens the window.
      const n = new Notification({
        title: 'Audio went silent',
        body: `Recording will stop in ${formatElapsed(prompt.autoStopAtMs - Date.now())} unless you continue.`,
        actions: [{ type: 'button', text: 'Continue recording' }, { type: 'button', text: 'Stop now' }],
      });
      n.on('click', openMainWindow);
      n.on('action', (details) => {
        if (details.actionIndex === 0) recordingManager.continueSilence(prompt.sessionId);
        else if (details.actionIndex === 1) void dispatcher.dispatch('meetingnotes://stop', { focusWindow: false });
      });
      showNotification(n);
      silenceNotification = n;
    } catch (err) {
      logger.error('recording:silence-notify-failed', { err: String(err) });
    }
  });
  recordingManager.on('silence-cleared', (sessionId, reason) => {
    logger.info('recording:silence-cleared', { sessionId, reason });
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send(IPC_CHANNELS.recordingSilenceClearedEvent, { sessionId, reason }));
    closeSilenceNotification();
    menuBar.refresh();
  });
  // An automatic stop reaches the window as this state change. Nobody asked
  // for it, so also say so where it is seen with the window closed.
  recordingManager.on('state-change', (_sessionId, state, reason) => {
    if (state !== 'idle' || reason !== SILENCE_AUTO_STOP_REASON) return;
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: 'Recording stopped', body: `${SILENCE_AUTO_STOP_REASON}. The recording was saved.` });
      n.on('click', openMainWindow);
      showNotification(n);
    } catch (err) {
      logger.error('recording:auto-stop-notify-failed', { err: String(err) });
    }
  });
  const recordShortcut = new RecordShortcut(globalShortcut, () => {
    const url = recordingSessionsRepo.findOpen().length > 0 ? 'meetingnotes://stop' : 'meetingnotes://record?source=all';
    void dispatcher.dispatch(url, { focusWindow: false });
  });
  // Never in the CI package smoke: no menu-bar item or system-wide shortcut
  // may be left behind on the host that runs it.
  if (!smokeRoot) {
    menuBar.setVisible(settings.get('showMenuBarIcon'));
    try { recordShortcut.apply(settings.get('recordShortcut')); }
    catch (err) { logger.warn('record-shortcut:unavailable', { reason: (err as Error).message }); }
    app.on('will-quit', () => recordShortcut.clear());
  }

  // Native nudge when a meeting parks at the speaker-ID gate. The pipeline
  // otherwise sits blocked on the user with no proactive signal if they've
  // navigated away. Clicking the notification raises the window and lands on
  // the meeting via the same route a meetingnotes://open deeplink uses.
  pipeline.onAwaitingSpeakerId((meetingId) => {
    if (!shouldNotifyGate(meetingId, gateNotified)) return;
    const meeting = meetings.findById(meetingId);
    if (!meeting) return; // deleted between transition and callback — nothing to route to
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: 'MeetingNotes',
        body: `"${meeting.title}" needs you to confirm speakers to keep processing.`,
      });
      n.on('click', () => {
        focusMainWindow();
        emitOpenMeeting(meetingId);
      });
      n.show();
    } catch (err) {
      logger.error('speaker-gate:notify-failed', { meetingId, err: String(err) });
    }
  });

  return { meetingDetector, nativeAppDetector, menuBar, recordShortcut };
}

export type AppSurfaces = ReturnType<typeof wireAppSurfaces>;
