export interface DetailArtifactState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
}

export interface DetailSpeaker {
  localLabel: string;
  rosterId: string | null;
  displayName: string | null;
  confidence: number | null;
  state?: 'unknown' | 'probable' | 'confirmed';
  needsReview?: boolean;
  segmentCount?: number;
  durationS?: number;
  lineCount?: number;
}

/** The shell owns membership and identity; retained review data can only
 * enrich those speakers, never restore removed links or hide new ones. */
export function mergeSpeakerReview(shell: DetailSpeaker[], review?: DetailSpeaker[]): DetailSpeaker[] {
  const byLabel = new Map(review?.map((speaker) => [speaker.localLabel, speaker]));
  return shell.map((speaker) => {
    const cached = byLabel.get(speaker.localLabel);
    if (!cached) return speaker;
    // Counts belong to the local voice, but review badges describe a
    // particular roster assignment/confidence and become stale on mutation.
    const compatibleIdentity = cached.rosterId === speaker.rosterId
      && cached.confidence === speaker.confidence;
    return {
      ...speaker,
      segmentCount: cached.segmentCount,
      durationS: cached.durationS,
      lineCount: cached.lineCount,
      ...(compatibleIdentity ? { state: cached.state, needsReview: cached.needsReview } : {}),
    };
  });
}

/** Per-detail request generations. Refreshes retain content but supersede
 * pending reads; switching meetings also invalidates every old completion. */
export function createDetailArtifacts<T extends Record<string, unknown>>(
  loaders: { [K in keyof T]: (meetingId: string) => Promise<T[K]> },
  onChange: () => void = () => {},
) {
  type Entry<K extends keyof T> = DetailArtifactState<T[K]> & {
    requested: boolean;
    generation: number;
    pending?: Promise<void>;
  };
  let meetingId: string | null = null;
  let generation = 0;
  let entries: { [K in keyof T]?: Entry<K> } = {};

  function entry<K extends keyof T>(kind: K): Entry<K> {
    return entries[kind] ??= {
      data: undefined, loading: false, error: null, requested: false, generation: 0,
    };
  }

  function request<K extends keyof T>(id: string, kind: K, refresh = false): Promise<void> {
    if (id !== meetingId) return Promise.resolve();
    const state = entry(kind);
    if (!refresh && state.pending) return state.pending;
    if (!refresh && state.requested && state.error === null) return Promise.resolve();
    const meetingGeneration = generation;
    const requestGeneration = ++state.generation;
    const isCurrent = (): boolean => meetingId === id && generation === meetingGeneration
      && state.generation === requestGeneration;
    state.requested = true;
    state.loading = true;
    state.error = null;
    state.pending = Promise.resolve().then(() => loaders[kind](id)).then(
      (data) => { if (isCurrent()) state.data = data; },
      (error: unknown) => {
        if (isCurrent()) state.error = error instanceof Error ? error.message : String(error);
      },
    ).then(() => {
      if (!isCurrent()) return;
      state.loading = false;
      state.pending = undefined;
      onChange();
    });
    onChange();
    return state.pending;
  }

  return {
    selectMeeting(id: string | null): void {
      if (id === meetingId) return;
      meetingId = id;
      generation += 1;
      entries = {};
    },
    get<K extends keyof T>(kind: K): DetailArtifactState<T[K]> { return entry(kind); },
    request,
    async refresh(id: string): Promise<void> {
      if (id !== meetingId) return;
      await Promise.all((Object.keys(entries) as (keyof T)[])
        .filter((kind) => entry(kind).requested)
        .map((kind) => request(id, kind, true)));
    },
  };
}
