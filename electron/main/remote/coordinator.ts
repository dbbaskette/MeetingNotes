import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PipelineContext } from '../pipeline/context.js';
import { remergeTranscript } from '../pipeline/stages/merging.js';
import { RemoteCreateJobSchema, RemoteTextInputSchema, type RemoteCapabilities } from '../../../shared/remote-contracts.js';
import { RemoteClient, RemoteClientError, endpointUrl, hashFile } from './client.js';
import { RemoteRepository, type RemoteRun, type RunConfiguration } from './repository.js';
import { RemoteCredentials } from './credentials.js';
import { RemoteImporter, durableWrite } from './importer.js';
import { RemoteEmbeddings } from './embeddings.js';

export interface RemoteStatus {
  runId: string; phase: string; bytesUploaded: number; totalBytes: number | null;
  lastContact: string | null; error: string | null; endpoint: string;
}
export class RemoteCoordinator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller = new AbortController();
  private busy = new Set<string>();
  private completion: (meetingId: string) => Promise<void> = async () => {};
  private gate: (meetingId: string) => void = () => {};
  constructor(readonly repository: RemoteRepository, private credentials: RemoteCredentials,
    private ctx: PipelineContext, readonly importer: RemoteImporter,
    private options: { allowLoopback?: boolean; fetcher?: typeof fetch; changed?: (id: string) => void } = {}) {}
  onComplete(callback: (meetingId: string) => Promise<void>): void { this.completion = callback; }
  onAwaitingSpeakerId(callback: (meetingId: string) => void): void { this.gate = callback; }
  isRemote(id: string): boolean { return !!this.repository.current(id); }
  usesRemote(): boolean { return this.repository.configuration().mode === 'remote'; }
  configuration() {
    const config = this.repository.configuration();
    return { mode: config.mode, endpoint: config.endpoint, testedAt: config.testedAt,
      profile: config.capabilities?.profiles[0]?.id ?? null, serviceId: config.capabilities?.serviceId ?? null,
      ownerId: config.capabilities?.ownerId ?? null };
  }
  async test(endpoint: string, token: string): Promise<ReturnType<RemoteCoordinator['configuration']>> {
    const url = endpointUrl(endpoint, this.options.allowLoopback);
    if (token.length < 32 || token.length > 4096 || /\s/.test(token)) throw new Error('Enter a valid API token');
    const client = new RemoteClient(url, () => token, this.controller.signal, this.options.allowLoopback, this.options.fetcher);
    const capabilities = await client.capabilities();
    if (!capabilities.profiles[0] || !capabilities.schemaVersions.includes(1)) throw new Error('Server has no compatible processing profile');
    this.credentials.set(url, capabilities.ownerId, token);
    // Test never grants upload consent. Endpoint/profile changes require Save remote mode again.
    this.repository.saveConfiguration({ mode: 'local', endpoint: url, capabilities, testedAt: new Date().toISOString() });
    return this.configuration();
  }
  setMode(mode: 'local' | 'remote'): ReturnType<RemoteCoordinator['configuration']> {
    const config = this.repository.configuration();
    if (mode === 'remote' && (!config.capabilities || !config.testedAt)) throw new Error('Test the server connection before choosing remote processing');
    this.repository.saveConfiguration({ ...config, mode }); return this.configuration();
  }
  status(id: string): RemoteStatus | null {
    const run = this.repository.current(id); if (!run) return null;
    return { runId: run.id, phase: run.phase, bytesUploaded: run.bytesUploaded, totalBytes: run.request?.source.bytes ?? null,
      lastContact: run.lastContact, error: run.error, endpoint: run.configuration.endpoint };
  }
  startLifecycle(): void {
    this.importer.replay();
    if (this.timer) return;
    this.controller = new AbortController();
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref(); this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.controller.abort(); }
  private snapshotConfiguration(): RunConfiguration {
    const config = this.repository.configuration();
    if (config.mode !== 'remote' || !config.capabilities?.profiles[0]) throw new Error('Remote processing is not configured');
    return { endpoint: config.endpoint, serviceId: config.capabilities.serviceId, ownerId: config.capabilities.ownerId,
      profile: config.capabilities.profiles[0], limits: config.capabilities.limits };
  }
  /** Synchronous durable acceptance keeps bulk counts exact even while offline. */
  start(meetingId: string, pinned?: RunConfiguration): string {
    const existing = this.repository.current(meetingId);
    if (existing && !['done', 'cancelled', 'failed', 'conflict'].includes(existing.phase)) return existing.id;
    const meeting = this.ctx.meetings.findById(meetingId);
    if (!meeting || meeting.deletedAt) throw new Error('Meeting not found');
    const configuration = pinned ?? this.snapshotConfiguration();
    const stat = fs.statSync(meeting.audioPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > Math.min(configuration.limits.sourceBytes, 1_073_741_824)) throw new Error('Recording exceeds server upload limits');
    if (meeting.durationS && meeting.durationS > configuration.limits.durationSeconds) throw new Error('Recording exceeds server duration limit');
    const run = this.newRun(meetingId, 'audio_analysis', configuration);
    run.originalPath = meeting.audioPath;
    run.sourceStamp = JSON.stringify([stat.size, stat.mtimeMs, stat.ino]);
    this.repository.db.transaction(() => {
      if (existing) this.repository.patch(existing.id, { active: false, deleteRequested: true });
      this.repository.save(run); this.ctx.meetings.updateStage(meetingId, 'transcribing'); this.ctx.meetings.updateStatus(meetingId, 'processing');
    })();
    this.options.changed?.(meetingId); return run.id;
  }
  private newRun(meetingId: string, kind: RemoteRun['kind'], configuration: RunConfiguration): RemoteRun {
    const id = randomUUID();
    return { id, meetingId, active: true, kind, configuration,
      sourcePath: path.join(this.importer.folder(meetingId), '.remote-outbox', id, 'source'), originalPath: null, sourceStamp: null,
      request: null, jobId: null, phase: 'pending_upload', expected: this.importer.fingerprint(meetingId), bytesUploaded: 0,
      createdAt: new Date().toISOString(), lastContact: null, error: null, failures: 0, nextAttempt: 0,
      manifestDigest: null, acknowledged: false, deleteRequested: false, deletedRemote: false,
      summaryDetail: this.ctx.settings.get('summaryDetail'), disableThinking: this.ctx.settings.get('disableThinking') };
  }
  continueFromSpeakerId(meetingId: string): string {
    const previous = this.repository.current(meetingId);
    if (!previous) throw new Error('Remote run not found');
    if (previous.kind === 'text_generation' && !['failed', 'cancelled', 'done'].includes(previous.phase)) return previous.id;
    if (previous.kind === 'audio_analysis' && previous.phase !== 'needs_speaker_names') throw new Error('Remote analysis is not ready');
    remergeTranscript(meetingId, { ...this.ctx, userName: this.ctx.settings.get('userName') });
    const run = this.newRun(meetingId, 'text_generation', previous.configuration);
    // Settings are pinned at the audio intent, not silently changed while naming speakers.
    run.summaryDetail = previous.summaryDetail; run.disableThinking = previous.disableThinking;
    const meeting = this.ctx.meetings.findById(meetingId)!;
    const input = RemoteTextInputSchema.parse({ transcript: fs.readFileSync(path.join(this.importer.folder(meetingId), 'transcript.md'), 'utf8'),
      title: meeting.title, summaryDetail: run.summaryDetail, disableThinking: run.disableThinking });
    const bytes = JSON.stringify(input);
    if (input.transcript.length > run.configuration.limits.textCharacters || Buffer.byteLength(bytes) > Math.min(2_000_000, run.configuration.limits.textBytes)) throw new Error('Transcript exceeds server context limit; use local processing');
    durableWrite(run.sourcePath, bytes);
    this.repository.db.transaction(() => {
      this.repository.patch(previous.id, { active: false }); this.repository.save(run);
      this.ctx.meetings.updateStage(meetingId, 'summarizing'); this.ctx.meetings.updateStatus(meetingId, 'processing');
    })();
    this.options.changed?.(meetingId); return run.id;
  }
  /** Immediate local fence; network cancellation/deletion is durable best effort, including offline. */
  cancel(meetingId: string, deactivate = false): void {
    const run = this.repository.current(meetingId);
    if (deactivate) for (const previous of this.repository.all().filter(r => r.meetingId === meetingId)) {
      this.repository.patch(previous.id, { active: false, phase: 'cancelled', deleteRequested: true });
    }
    if (!run) return;
    this.repository.patch(run.id, { phase: 'cancelled', active: !deactivate, deleteRequested: true, error: null });
    this.ctx.meetings.updateStatus(meetingId, 'pending'); this.options.changed?.(meetingId);
  }
  confirmSpeaker(meetingId: string, label: string, rosterId: string): void {
    new RemoteEmbeddings(this.repository.db).confirm(this.importer.folder(meetingId), label, rosterId);
  }
  fallback(meetingId: string, startLocal: () => void): void {
    this.cancel(meetingId, true); startLocal();
  }
  retry(meetingId: string): void {
    const run = this.repository.current(meetingId); if (!run) throw new Error('Remote run not found');
    if (run.phase === 'conflict') throw new Error('Review the conflicting result first');
    if (['failed', 'cancelled'].includes(run.phase)) {
      if (run.kind === 'text_generation' && run.phase === 'failed') this.continueFromSpeakerId(meetingId);
      else this.start(meetingId, run.configuration);
    } else this.repository.patch(run.id, { nextAttempt: 0, failures: 0, error: null,
      ...(run.phase === 'reconnect_required' ? { phase: 'offline' } : {}) });
  }
  rerun(meetingId: string, fromStage: string): void {
    const previous = this.repository.current(meetingId);
    if (!previous) { this.start(meetingId); return; }
    if (['summarizing', 'extracting'].includes(fromStage) && ['needs_speaker_names', 'done', 'failed'].includes(previous.phase)) {
      this.continueFromSpeakerId(meetingId); return;
    }
    this.cancel(meetingId); this.start(meetingId, previous.configuration);
  }
  resolve(meetingId: string, runId: string, accept: boolean, localFingerprint: string): void {
    const run = this.repository.current(meetingId);
    if (!run || run.id !== runId || run.phase !== 'conflict') throw new Error('Conflict changed; review again');
    if (this.importer.fingerprint(meetingId) !== localFingerprint) throw new Error('Local content changed during review; review again');
    if (!accept) { this.cancel(meetingId); return; }
    this.importer.publish(run.id, true); this.options.changed?.(meetingId);
  }
  private tick(): void {
    if (this.controller.signal.aborted) return;
    for (const run of this.repository.all()) {
      if (this.busy.size >= 2) break;
      const pendingAck = run.manifestDigest && !run.acknowledged && ['done', 'needs_speaker_names'].includes(run.phase);
      const pendingDelete = run.deleteRequested && !run.deletedRemote;
      const effect = run.phase === 'done' ? 'completion' : 'speaker_gate';
      const pendingEffect = run.active && ['done', 'needs_speaker_names'].includes(run.phase) && !this.repository.db.prepare('SELECT 1 FROM remote_effects WHERE run_id=? AND effect=?').get(run.id, effect);
      if (this.busy.has(run.id) || run.nextAttempt > Date.now() || (!pendingAck && !pendingDelete && !pendingEffect && (!run.active || ['done', 'failed', 'reconnect_required', 'cancelled', 'conflict', 'needs_speaker_names'].includes(run.phase)))) continue;
      this.busy.add(run.id);
      void this.step(run.id).then(() => { if (!this.controller.signal.aborted) this.repository.patch(run.id, { failures: 0 }); }).catch(error => {
        if (this.controller.signal.aborted) return;
        const current = this.repository.get(run.id); if (!current) return;
        if (error instanceof RemoteClientError && error.code === 'RUN_FENCED') return;
        const failure = error instanceof RemoteClientError ? error : new RemoteClientError('OFFLINE_OR_CREDENTIALS', true);
        // Only a terminal server job or explicitly invalidated local source may
        // create a new execution on Retry. Authentication/protocol failures are
        // reconciliation failures, not evidence the accepted job failed.
        const failedPhase = ['SOURCE_CHANGED', 'INTENT_EXPIRED_REVIEW_REQUIRED'].includes(failure.code) ? 'failed' : 'reconnect_required';
        this.repository.patch(run.id, { error: failure.code, failures: current.failures + 1,
          phase: current.deleteRequested || ['done', 'needs_speaker_names'].includes(current.phase) ? current.phase : failure.retryable ? 'offline' : failedPhase,
          nextAttempt: Date.now() + Math.max(failure.retryAfterMs, Math.min(60_000, 5000 * 2 ** Math.min(current.failures, 4))) });
        if (!failure.retryable && failedPhase === 'failed' && current.active && !current.deleteRequested && !['done', 'needs_speaker_names'].includes(current.phase)) this.ctx.meetings.recordFailure(current.meetingId, failure.code);
      }).finally(() => { this.busy.delete(run.id); this.options.changed?.(run.meetingId); });
    }
  }
  private live(id: string): RemoteRun {
    if (this.controller.signal.aborted) throw new RemoteClientError('STOPPED', true);
    const run = this.repository.get(id)!;
    if (!run.active || run.deleteRequested || this.ctx.meetings.findById(run.meetingId)?.deletedAt) throw new RemoteClientError('RUN_FENCED', false);
    return run;
  }
  private checkIdentity(caps: RemoteCapabilities, run: RemoteRun): void {
    const pin = run.configuration;
    if (caps.serviceId !== pin.serviceId || caps.ownerId !== pin.ownerId || (!run.deleteRequested && !run.manifestDigest && !caps.profiles.some(p => p.id === pin.profile.id && p.digest === pin.profile.digest))) throw new RemoteClientError('SERVER_IDENTITY_OR_PROFILE_CHANGED', false);
  }
  private async finishLocal(run: RemoteRun): Promise<void> {
    if (!run.active || run.deleteRequested || this.repository.current(run.meetingId)?.id !== run.id || this.ctx.meetings.findById(run.meetingId)?.deletedAt) return;
    if (run.phase === 'done' && this.repository.claimEffect(run.id, 'completion')) {
      await this.completion(run.meetingId); this.repository.finishEffect(run.id, 'completion');
    }
    if (run.phase === 'needs_speaker_names') {
      if (this.ctx.meetings.findById(run.meetingId)?.skipSpeakerId) this.continueFromSpeakerId(run.meetingId);
      else if (this.repository.claimEffect(run.id, 'speaker_gate')) { this.gate(run.meetingId); this.repository.finishEffect(run.id, 'speaker_gate'); }
    }
  }
  async step(id: string): Promise<void> {
    let run = this.repository.get(id)!;
    // Local import completion and the speaker gate do not depend on network acknowledgement.
    await this.finishLocal(run);
    run = this.repository.get(id)!;
    const client = new RemoteClient(run.configuration.endpoint, () => this.credentials.get(run.configuration.endpoint, run.configuration.ownerId),
      this.controller.signal, this.options.allowLoopback, this.options.fetcher);
    this.checkIdentity(await client.capabilities(), run);
    this.repository.patch(id, { lastContact: new Date().toISOString(), error: null, nextAttempt: Date.now() + 5000 });
    run = this.repository.get(id)!;
    if (run.deleteRequested) {
      // A create response may have been lost. Reconcile its stable key before deleting it.
      if (!run.jobId && run.request) {
        if (Date.now() - Date.parse(run.createdAt) >= 90 * 86400_000) throw new RemoteClientError('INTENT_EXPIRED_REVIEW_REQUIRED', false);
        run = this.repository.patch(id, { jobId: (await client.create(run.request)).id });
      }
      if (run.jobId) {
        try { await client.cancel(run.jobId, id); await client.remove(run.jobId, id); }
        catch (error) {
          // A lost DELETE response is reconciled by the tombstone's 404. Cleanup
          // remains the server janitor's responsibility; this is not erasure proof.
          if (!(error instanceof RemoteClientError) || !['NOT_FOUND', 'HTTP_404'].includes(error.code)) throw error;
        }
      }
      try { fs.unlinkSync(run.sourcePath); } catch { /* moved to trash or already removed */ }
      this.repository.patch(id, { deletedRemote: true }); return;
    }
    if (run.manifestDigest && ['done', 'needs_speaker_names'].includes(run.phase)) {
      if (!run.acknowledged) { await client.ack(run.jobId!, id, run.manifestDigest); this.repository.patch(id, { acknowledged: true }); }
      try { fs.unlinkSync(run.sourcePath); } catch { /* cache only; authoritative recording is untouched */ }
      return;
    }
    this.live(id);
    if (!run.request) {
      if (run.originalPath) {
        const before = fs.statSync(run.originalPath);
        if (JSON.stringify([before.size, before.mtimeMs, before.ino]) !== run.sourceStamp) throw new RemoteClientError('SOURCE_CHANGED', false);
        fs.mkdirSync(path.dirname(run.sourcePath), { recursive: true, mode: 0o700 });
        await fs.promises.copyFile(run.originalPath, run.sourcePath);
        const copied = fs.openSync(run.sourcePath, 'r');
        try { fs.fsyncSync(copied); } finally { fs.closeSync(copied); }
        const directory = fs.openSync(path.dirname(run.sourcePath), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        const after = fs.statSync(run.originalPath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new RemoteClientError('SOURCE_CHANGED', false);
      }
      const sha256 = await hashFile(run.sourcePath); this.live(id);
      if (run.originalPath && await hashFile(run.originalPath) !== sha256) throw new RemoteClientError('SOURCE_CHANGED', false);
      const request = RemoteCreateJobSchema.parse({ schemaVersion: 1, kind: run.kind, clientMeetingId: run.meetingId, clientRunId: id,
        profileId: run.configuration.profile.id, profileDigest: run.configuration.profile.digest,
        source: { bytes: fs.statSync(run.sourcePath).size, sha256, contentType: run.kind === 'text_generation' ? 'application/json' : 'application/octet-stream' } });
      run = this.repository.patch(id, { request });
    }
    if (!run.jobId) {
      if (Date.now() - Date.parse(run.createdAt) >= 90 * 86400_000) throw new RemoteClientError('INTENT_EXPIRED_REVIEW_REQUIRED', false);
      const job = await client.create(run.request!); run = this.repository.patch(id, { jobId: job.id });
    }
    this.live(id);
    const job = await client.job(run.jobId!);
    this.live(id);
    if (job.clientRunId !== id || job.kind !== run.kind) throw new RemoteClientError('JOB_IDENTITY_MISMATCH', false);
    this.repository.patch(id, { phase: job.phase });
    if (job.phase === 'diarizing') this.ctx.meetings.updateStage(run.meetingId, 'diarizing');
    if (job.state === 'failed' || job.state === 'cancelled') {
      this.repository.patch(id, { phase: job.state, error: job.error?.code ?? null });
      this.ctx.meetings.updateStatus(run.meetingId, 'failed'); return;
    }
    if (job.state === 'uploading') {
      const upload = await client.upload(run.jobId!);
      this.live(id);
      if (upload.state === 'verifying' || upload.state === 'complete') return;
      if (upload.partSize !== 16_777_216) throw new RemoteClientError('INVALID_PART_SIZE', false);
      if (await hashFile(run.sourcePath) !== run.request!.source.sha256 || (run.originalPath && await hashFile(run.originalPath) !== run.request!.source.sha256)) throw new RemoteClientError('SOURCE_CHANGED', false);
      this.live(id);
      const total = run.request!.source.bytes, count = Math.ceil(total / upload.partSize);
      if (upload.parts.some(p => p.partNumber > count || p.bytes !== Math.min(upload.partSize, total - (p.partNumber - 1) * upload.partSize))) throw new RemoteClientError('INVALID_UPLOAD_CHECKPOINT', false);
      const confirmed = new Set(upload.parts.map(p => p.partNumber));
      this.repository.patch(id, { phase: 'uploading', bytesUploaded: upload.parts.reduce((n, p) => n + p.bytes, 0) });
      const file = await fs.promises.open(run.sourcePath, 'r');
      try {
        for (let number = 1; number <= count; number++) {
          if (confirmed.has(number)) continue;
          this.live(id); const bytes = Buffer.alloc(Math.min(upload.partSize, total - (number - 1) * upload.partSize));
          const read = await file.read(bytes, 0, bytes.length, (number - 1) * upload.partSize);
          if (read.bytesRead !== bytes.length) throw new RemoteClientError('SOURCE_CHANGED', false);
          await client.uploadPart(run.jobId!, id, number, bytes); this.live(id);
          const current = this.repository.get(id)!; this.repository.patch(id, { bytesUploaded: current.bytesUploaded + bytes.length });
          this.options.changed?.(run.meetingId);
        }
      } finally { await file.close(); }
      this.live(id); await client.complete(run.jobId!, id); return;
    }
    if (job.state === 'succeeded') {
      this.repository.patch(id, { phase: 'downloading' });
      const output = await client.result(run.jobId!, run.request!, path.join(path.dirname(run.sourcePath), 'downloads')); this.live(id);
      if (run.originalPath && await hashFile(run.originalPath) !== run.request!.source.sha256) throw new RemoteClientError('SOURCE_CHANGED', false);
      this.live(id); this.importer.stage(run, output.result.manifestDigest, output.artifacts); this.importer.publish(id);
    }
  }
}
