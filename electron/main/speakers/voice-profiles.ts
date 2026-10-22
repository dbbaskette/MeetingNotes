import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
interface Person { id: string; displayName: string; }
export function rankVoiceProfiles(vector: readonly number[], profiles: (Person & { vector: number[] })[]): (Person & { similarity: number })[] {
  const observed = normalized(vector); if (!observed) return [];
  return profiles.flatMap(profile => {
    if (profile.vector.length !== observed.length) return [];
    const similarity = Math.max(-1, Math.min(1, profile.vector.reduce((sum, value, i) => sum + value * observed[i]!, 0)));
    return [{ id: profile.id, displayName: profile.displayName, similarity }];
  }).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}

const Vector = z.array(z.number().finite()).min(1).max(8192);
const Profile = z.object({ version: z.literal(1), space: z.string().min(1).max(500), rosterId: z.string().max(200), vector: Vector,
  confirmedAt: z.string().optional(), source: z.string().optional(),
  history: z.array(z.object({ vector: Vector.nullable(), confirmedAt: z.string().optional(), source: z.string().optional(), mergedFrom: z.array(z.string()).optional() })).max(20).optional(),
  mergedFrom: z.array(z.string()).optional(),
});
export interface VoiceProfileInfo { space: string; confirmedAt?: string; source?: string; canUndo: boolean }
export function normalized(vector: readonly number[]): number[] | null {
  if (!vector.length || vector.length > 8192 || vector.some(x => !Number.isFinite(x))) return null;
  const norm = Math.hypot(...vector);
  return norm > 1e-6 && Number.isFinite(norm) ? vector.map(x => x / norm) : null;
}
export function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export class VoiceProfiles {
  // Shared between short-lived service instances. File identity invalidates external
  // changes; writes explicitly evict. Bounded to avoid retaining a growing roster.
  private static cache = new Map<string, { stamp: string; value: z.infer<typeof Profile>; bytes: number }>();
  private static cacheBytes = 0;
  private static evict(file: string): void {
    this.cacheBytes -= this.cache.get(file)?.bytes ?? 0;
    this.cache.delete(file);
  }
  private readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private file(space: string, rosterId: string): string {
    const target = path.join(this.root, 'voice-profiles', createHash('sha256').update(space).digest('hex'), createHash('sha256').update(rosterId).digest('hex') + '.json');
    let current = target;
    while (current !== this.root) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Voice profiles cannot use symbolic links.'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      current = path.dirname(current);
    }
    return target;
  }
  private read(space: string, rosterId: string): z.infer<typeof Profile> | null {
    try {
      const file = this.file(space, rosterId), stat = fs.statSync(file);
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      const cached = VoiceProfiles.cache.get(file);
      if (cached?.stamp === stamp) return cached.value;
      const value = Profile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (value.space !== space || value.rosterId !== rosterId || !normalized(value.vector)) return null;
      const bytes = (value.vector.length + (value.history ?? []).reduce((sum, item) => sum + (item.vector?.length ?? 0), 0)) * 8 + stat.size;
      VoiceProfiles.evict(file);
      while (VoiceProfiles.cache.size && (VoiceProfiles.cache.size >= 512 || VoiceProfiles.cacheBytes + bytes > 16 * 1024 * 1024)) VoiceProfiles.evict(VoiceProfiles.cache.keys().next().value!);
      if (bytes <= 16 * 1024 * 1024) { VoiceProfiles.cache.set(file, { stamp, value, bytes }); VoiceProfiles.cacheBytes += bytes; }
      return value;
    } catch { return null; }
  }
  confirm(space: string, rosterId: string, vector: readonly number[], source?: string): void {
    const observed = normalized(vector);
    if (!observed) throw new Error('This voice has no usable sample. You can name it, but it cannot train a profile yet.');
    const previous = this.read(space, rosterId);
    const old = previous ? normalized(previous.vector) : null;
    const updated = old?.length === observed.length ? normalized(old.map((v, i) => v * 0.7 + observed[i]! * 0.3))! : observed;
    atomicJson(this.file(space, rosterId), { version: 1, space, rosterId, vector: updated,
      confirmedAt: new Date().toISOString(), source,
      history: [...(previous?.history ?? []), { vector: previous?.vector ?? null, confirmedAt: previous?.confirmedAt, source: previous?.source, mergedFrom: previous?.mergedFrom }].slice(-20),
      mergedFrom: previous?.mergedFrom,
    });
    VoiceProfiles.evict(this.file(space, rosterId));
  }
  load(space: string, rosterId: string): number[] | null {
    const value = this.read(space, rosterId);
    return value ? normalized(value.vector) : null;
  }
  /** Discover model spaces without trusting filenames or following symlinks. */
  info(rosterId: string): VoiceProfileInfo[] {
    const root = path.join(this.root, 'voice-profiles');
    if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) return [];
    const result: VoiceProfileInfo[] = [];
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
      const file = path.join(root, dir.name, createHash('sha256').update(rosterId).digest('hex') + '.json');
      try {
        if (fs.lstatSync(file).isSymbolicLink()) continue;
        const value = Profile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
        if (this.file(value.space, rosterId) !== file || value.rosterId !== rosterId) continue;
        result.push({ space: value.space, confirmedAt: value.confirmedAt, source: value.source, canUndo: !!value.history?.length });
      } catch { /* unrelated/corrupt profiles never become identity evidence */ }
    }
    return result;
  }
  undo(space: string, rosterId: string): void {
    const value = this.read(space, rosterId), previous = value?.history?.at(-1);
    if (!value || !previous) throw new Error('No voice confirmation to undo.');
    const file = this.file(space, rosterId);
    if (previous.vector === null) fs.unlinkSync(file);
    else atomicJson(file, { ...value, ...previous, mergedFrom: previous.mergedFrom, history: value.history!.slice(0, -1) });
    VoiceProfiles.evict(file);
  }
  /** Preserve source files as recovery copies. Copy absent model spaces; combine
   * only compatible vectors. Idempotent if a crash occurs before the DB commit. */
  merge(sourceId: string, targetId: string, commit?: () => void): void {
    const writes: { file: string; value: unknown; before: string | null }[] = [];
    for (const { space } of this.info(sourceId)) {
      const source = this.read(space, sourceId), target = this.read(space, targetId);
      if (!source || target?.mergedFrom?.includes(sourceId)) continue;
      if (!target && fs.existsSync(this.file(space, targetId))) throw new Error('The target voiceprint could not be read. Re-confirm that voice before merging; original profiles were retained.');
      if (target && target.vector.length !== source.vector.length) throw new Error('These voiceprints have incompatible dimensions. Keep both people until their voices are re-confirmed.');
      const vector = target ? normalized(target.vector.map((v, i) => v + source.vector[i]!)) : normalized(source.vector);
      if (!vector) throw new Error('These voiceprints cannot be combined safely.');
      const file = this.file(space, targetId);
      writes.push({ file, before: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, value: { ...(target ?? source), rosterId: targetId, vector,
        history: [...(target?.history ?? []), { vector: target?.vector ?? null, confirmedAt: target?.confirmedAt, source: target?.source, mergedFrom: target?.mergedFrom }].slice(-20),
        source: `Merged voiceprint from ${sourceId}`, mergedFrom: [...(target?.mergedFrom ?? []), sourceId],
      } });
    }
    const written: typeof writes = [];
    try {
      for (const write of writes) { atomicJson(write.file, write.value); VoiceProfiles.evict(write.file); written.push(write); }
      commit?.();
    } catch (error) {
      for (const write of written.reverse()) {
        if (write.before === null) fs.rmSync(write.file, { force: true });
        else atomicJson(write.file, JSON.parse(write.before));
        VoiceProfiles.evict(write.file);
      }
      throw error;
    }
  }
  suggestions(space: string, vector: readonly number[], roster: Person[]): (Person & { similarity: number })[] {
    if (!normalized(vector)) return [];
    return rankVoiceProfiles(vector, roster.flatMap(person => {
      const saved = this.load(space, person.id);
      return saved ? [{ ...person, vector: saved }] : [];
    }));
  }
}
