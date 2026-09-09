import type Database from 'better-sqlite3';
import type { RemoteCapabilities, RemoteCreateJob, RemoteProfile } from '../../../shared/remote-contracts.js';

export interface RemoteConfiguration {
  mode: 'local' | 'remote'; endpoint: string; capabilities: RemoteCapabilities | null;
  testedAt: string | null;
}
export interface RunConfiguration {
  endpoint: string; serviceId: string; ownerId: string; profile: RemoteProfile;
  limits: RemoteCapabilities['limits'];
}
export interface RemoteRun {
  id: string; meetingId: string; active: boolean; configuration: RunConfiguration;
  kind: RemoteCreateJob['kind']; sourcePath: string; originalPath: string | null;
  sourceStamp: string | null;
  request: RemoteCreateJob | null; jobId: string | null;
  phase: string; expected: string; bytesUploaded: number; createdAt: string;
  lastContact: string | null; error: string | null; failures: number; nextAttempt: number;
  manifestDigest: string | null; acknowledged: boolean; deleteRequested: boolean; deletedRemote: boolean;
  summaryDetail: 'concise' | 'standard' | 'detailed'; disableThinking: boolean;
}
export class RemoteRepository {
  constructor(readonly db: Database.Database) {}
  configuration(): RemoteConfiguration {
    const row = this.db.prepare('SELECT value FROM remote_configuration WHERE id=1').get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { mode: 'local', endpoint: '', capabilities: null, testedAt: null };
  }
  saveConfiguration(value: RemoteConfiguration): void {
    this.db.prepare('INSERT INTO remote_configuration VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
  }
  get(id: string): RemoteRun | null {
    const row = this.db.prepare('SELECT value FROM remote_runs WHERE id=?').get(id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  current(meetingId: string): RemoteRun | null {
    const row = this.db.prepare('SELECT value FROM remote_runs WHERE meeting_id=? AND active=1').get(meetingId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }
  all(): RemoteRun[] {
    return (this.db.prepare('SELECT value FROM remote_runs').all() as { value: string }[]).map(r => JSON.parse(r.value));
  }
  bumpRevision(meetingId: string): void {
    this.db.prepare('INSERT INTO remote_revisions VALUES (?,1) ON CONFLICT(meeting_id) DO UPDATE SET revision=revision+1').run(meetingId);
  }
  save(run: RemoteRun): void {
    this.db.prepare('INSERT INTO remote_runs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,value=excluded.value')
      .run(run.id, run.meetingId, Number(run.active), JSON.stringify(run));
  }
  patch(id: string, patch: Partial<RemoteRun>): RemoteRun {
    const run = this.get(id);
    if (!run) throw new Error('Remote run not found');
    const next = { ...run, ...patch }; this.save(next); return next;
  }
  /** Persist attempt BEFORE a non-transactional effect. Unknown outcomes are never auto-replayed. */
  claimEffect(id: string, effect: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO remote_effects VALUES (?,?,'attempted')").run(id, effect).changes === 1;
  }
  finishEffect(id: string, effect: string): void {
    this.db.prepare("UPDATE remote_effects SET state='completed' WHERE run_id=? AND effect=?").run(id, effect);
  }
}
