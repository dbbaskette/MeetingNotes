export interface SourceItem {
  pid: number; name: string | null; bundleId: string | null;
  isMeetingApp: boolean; isRunningOutput: boolean;
  isUserApp?: boolean; ownerPid?: number; ownerName?: string | null;
}
export function groupAudioSources(sources: SourceItem[]): { key: number; name: string; sources: SourceItem[] }[] {
  const groups = new Map<number, { key: number; name: string; sources: SourceItem[] }>();
  for (const source of sources) {
    const key = source.isUserApp !== false ? source.ownerPid ?? source.pid : source.pid;
    const group = groups.get(key) ?? { key, name: source.ownerName ?? source.name ?? `PID ${source.pid}`, sources: [] };
    group.sources.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function audioSourceLabel(source: SourceItem): string {
  const name = source.ownerName ?? source.name ?? `PID ${source.pid}`;
  return source.ownerPid && source.ownerPid !== source.pid
    ? `${name} — ${source.name ?? 'Audio stream'} (PID ${source.pid})` : name;
}
