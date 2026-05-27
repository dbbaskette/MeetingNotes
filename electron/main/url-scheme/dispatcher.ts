// electron/main/url-scheme/dispatcher.ts
//
// Map a parsed meetingnotes:// command to existing recording / window
// actions. Pure module — Electron-free for testability. The wiring in
// electron/main/index.ts injects the live deps; tests inject stubs.
//
// Trust model: this runs whenever any process on the user's Mac opens a
// meetingnotes:// URL. Same risk surface as a manual Record click — no
// authentication in v1. The parser already strips obviously-bad input;
// the dispatcher additionally guards against double-starting a recording
// and against opening an unknown meeting id.

import type { RecordingManager, StartResult } from '../recording/manager.js';
import type { AppEnumerator, AudioSource } from '../recording/app-enumerator.js';
import type { RecordingSessionsRepo } from '../storage/recording-sessions-repo.js';
import type { MeetingsRepo } from '../storage/meetings-repo.js';
import type { Logger } from '../logging/logger.js';
import {
  parseSchemeUrl,
  type SchemeCommand,
  SOURCE_KEYWORD_TO_BUNDLE_IDS,
  looksLikeBundleId,
} from './parser.js';

export interface SchemeDispatcherDeps {
  recordingManager: RecordingManager;
  appEnumerator: AppEnumerator;
  recordingSessionsRepo: RecordingSessionsRepo;
  meetings: MeetingsRepo;
  /** Called with the meeting id to focus in the renderer. The wiring in
   *  index.ts forwards this to all BrowserWindows via webContents.send. */
  emitOpenMeeting: (meetingId: string) => void;
  /** User-visible notification — typically a native macOS Notification.
   *  Tests pass a spy; production wiring uses Electron's Notification API. */
  notify: (input: { title: string; body: string }) => void;
  /** Brings the main app window forward. macOS opens the protocol-handler
   *  app but doesn't always raise an existing window — call this on every
   *  dispatch so the user actually sees what fired. */
  focusMainWindow: () => void;
  logger: Pick<Logger, 'info' | 'error'>;
}

export interface DispatchResult {
  ok: boolean;
  /** Human-readable summary suitable for the audit log and the notification
   *  body. Always populated, regardless of success. */
  message: string;
}

export class SchemeDispatcher {
  constructor(private readonly deps: SchemeDispatcherDeps) {}

  async dispatch(url: string): Promise<DispatchResult> {
    const parsed = parseSchemeUrl(url);
    this.deps.logger.info('url-scheme:dispatch', { url, parsed: redactCommand(parsed) });
    if (parsed.kind === 'error') {
      const message = `Ignored meetingnotes:// — ${parsed.reason}`;
      this.deps.notify({ title: 'MeetingNotes', body: message });
      return { ok: false, message };
    }
    this.deps.focusMainWindow();
    switch (parsed.kind) {
      case 'record': return this.handleRecord(parsed.source, parsed.title);
      case 'stop': return this.handleStop();
      case 'open': return this.handleOpen(parsed.meetingId);
    }
  }

  private async handleRecord(source: string, _title: string | null): Promise<DispatchResult> {
    const openSessions = this.deps.recordingSessionsRepo.findOpen();
    if (openSessions.length > 0) {
      const label = openSessions[0]!.targetLabel;
      const message = `Already recording: ${label}`;
      this.deps.notify({ title: 'MeetingNotes', body: message });
      return { ok: false, message };
    }
    const resolved = await this.resolveSource(source);
    if (!resolved.ok) {
      this.deps.notify({ title: 'MeetingNotes', body: resolved.reason });
      return { ok: false, message: resolved.reason };
    }
    let result: StartResult;
    try {
      result = await this.deps.recordingManager.start({
        targetPid: resolved.targetPid,
        targetLabel: resolved.label,
        mic: true,
      });
    } catch (e) {
      const message = `Could not start recording: ${(e as Error).message}`;
      this.deps.logger.error('url-scheme:record-failed', { source, err: String(e) });
      this.deps.notify({ title: 'MeetingNotes', body: message });
      return { ok: false, message };
    }
    const message = `Recording: ${resolved.label}`;
    this.deps.logger.info('url-scheme:record-started', {
      sessionId: result.sessionId, label: resolved.label,
    });
    return { ok: true, message };
  }

  private async handleStop(): Promise<DispatchResult> {
    const open = this.deps.recordingSessionsRepo.findOpen();
    if (open.length === 0) {
      const message = 'No active recording to stop.';
      this.deps.notify({ title: 'MeetingNotes', body: message });
      return { ok: false, message };
    }
    let stopped = 0;
    for (const session of open) {
      try {
        await this.deps.recordingManager.stop(session.id);
        stopped += 1;
      } catch (e) {
        this.deps.logger.error('url-scheme:stop-failed', { sessionId: session.id, err: String(e) });
      }
    }
    const message = `Stopped ${stopped} recording${stopped === 1 ? '' : 's'}.`;
    this.deps.notify({ title: 'MeetingNotes', body: message });
    return { ok: stopped > 0, message };
  }

  private handleOpen(meetingId: string): DispatchResult {
    const meeting = this.deps.meetings.findById(meetingId);
    if (!meeting) {
      const message = `Meeting not found: ${meetingId}`;
      this.deps.notify({ title: 'MeetingNotes', body: message });
      return { ok: false, message };
    }
    this.deps.emitOpenMeeting(meetingId);
    return { ok: true, message: `Opening meeting: ${meeting.title}` };
  }

  // Maps the user-supplied source string into the targetPid/label pair the
  // recording manager expects. Three branches:
  //   • 'all' / '' — record system audio (no per-app pid).
  //   • bundle id (looksLikeBundleId == true) — look up the matching live
  //     audio process. Fails if no app with that bundle is running output.
  //   • keyword (zoom / teams / etc.) — same lookup against the keyword
  //     allowlist.
  private async resolveSource(
    source: string,
  ): Promise<
    | { ok: true; targetPid: number | 'system'; label: string }
    | { ok: false; reason: string }
  > {
    const trimmed = source.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'all' || trimmed === 'system') {
      return { ok: true, targetPid: 'system', label: 'System Audio' };
    }
    let candidateBundles: string[] = [];
    if (looksLikeBundleId(source)) {
      candidateBundles = [source];
    } else if (SOURCE_KEYWORD_TO_BUNDLE_IDS[trimmed]) {
      candidateBundles = SOURCE_KEYWORD_TO_BUNDLE_IDS[trimmed]!;
    } else {
      return { ok: false, reason: `Unknown source "${source}". Try zoom, teams, slack, facetime, discord, whatsapp, all, or a bundle id.` };
    }
    let sources: AudioSource[];
    try {
      sources = await this.deps.appEnumerator.list();
    } catch (e) {
      return { ok: false, reason: `Could not enumerate audio sources: ${(e as Error).message}` };
    }
    const match = sources.find(
      (s) => s.bundleId != null && candidateBundles.includes(s.bundleId),
    );
    if (!match) {
      return {
        ok: false,
        reason: `${humanizeSource(source, trimmed)} isn't producing audio right now — start the call first, then retry.`,
      };
    }
    if (!match.isRunningOutput) {
      return {
        ok: false,
        reason: `${humanizeSource(source, trimmed)} is idle (not playing audio yet) — wait for the call to actually start.`,
      };
    }
    const label = match.name ?? humanizeSource(source, trimmed);
    return { ok: true, targetPid: match.pid, label };
  }
}

function humanizeSource(original: string, lowered: string): string {
  if (lowered === 'facetime') return 'FaceTime';
  if (lowered in SOURCE_KEYWORD_TO_BUNDLE_IDS) return lowered[0]!.toUpperCase() + lowered.slice(1);
  return original;
}

// Used in the audit log — strips anything that could carry user-typed PII
// (the optional title) so the log line is a stable shape.
function redactCommand(c: SchemeCommand | { kind: 'error'; reason: string }): unknown {
  if (c.kind === 'record') return { kind: 'record', source: c.source, hasTitle: c.title !== null };
  if (c.kind === 'open') return { kind: 'open', meetingId: c.meetingId };
  if (c.kind === 'stop') return { kind: 'stop' };
  return { kind: 'error', reason: c.reason };
}
