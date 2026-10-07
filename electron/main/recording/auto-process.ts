/** Only runtime-finalized native captures enter this path. Watcher discovery,
 * imports, recovery and launch backfill deliberately do not call it. */
export class AutoProcessRecordings {
  private readonly handled = new Set<string>();
  constructor(private readonly deps: {
    enabled: () => boolean;
    catalog: (audioPath: string) => Promise<{ meeting: { id: string; status: string; durationS: number | null } }>;
    verify?: (audioPath: string) => Promise<{ durationS: number }>;
    enqueue: (id: string) => void;
    queued: (id: string) => void;
    failed: (sessionId: string, error: unknown) => void;
  }) {}
  async finalized(sessionId: string, audioPath: string): Promise<void> {
    if (this.handled.has(sessionId)) return;
    this.handled.add(sessionId);
    // Always catalog confirmed final output; setting controls processing only.
    const enabled = this.deps.enabled();
    try {
      const { meeting } = await this.deps.catalog(audioPath);
      if (!enabled || meeting.status !== 'pending' || !meeting.durationS || meeting.durationS <= 0) return;
      if (this.deps.verify && (await this.deps.verify(audioPath)).durationS <= 0) return;
      this.deps.queued(meeting.id);
      this.deps.enqueue(meeting.id); // existing queue owns pause/cancel/gates
    } catch (error) { this.deps.failed(sessionId, error); }
  }
}
