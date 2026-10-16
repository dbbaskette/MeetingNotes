import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BetaCandidate, BetaRoster } from '../../shared/speech-beta.js';
import { ownedPath } from './library.js';

const Profile = z.object({ version: z.literal(1), space: z.string().min(1), rosterId: z.string(), vector: z.array(z.number().finite()).min(1) });
export function normalized(vector: readonly number[]): number[] | null {
  if (!vector.length || vector.some(x => !Number.isFinite(x))) return null;
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
  constructor(private readonly root: string) {}
  private file(space: string, rosterId: string): string {
    return ownedPath(this.root, 'voice-profiles', createHash('sha256').update(space).digest('hex'), createHash('sha256').update(rosterId).digest('hex') + '.json');
  }
  confirm(space: string, rosterId: string, vector: readonly number[]): void {
    const observed = normalized(vector);
    if (!observed) throw new Error('This voice has no usable sample. You can name it, but it cannot train a profile yet.');
    const old = this.load(space, rosterId);
    const updated = old?.length === observed.length ? normalized(old.map((v, i) => v * 0.7 + observed[i]! * 0.3))! : observed;
    atomicJson(this.file(space, rosterId), { version: 1, space, rosterId, vector: updated });
  }
  private load(space: string, rosterId: string): number[] | null {
    try {
      const value = Profile.parse(JSON.parse(fs.readFileSync(this.file(space, rosterId), 'utf8')));
      return value.space === space && value.rosterId === rosterId ? normalized(value.vector) : null;
    } catch { return null; }
  }
  suggestions(space: string, vector: readonly number[], roster: BetaRoster[]): BetaCandidate[] {
    const observed = normalized(vector); if (!observed) return [];
    return roster.flatMap(person => {
      const saved = this.load(space, person.id);
      if (!saved || saved.length !== observed.length) return [];
      const similarity = Math.max(-1, Math.min(1, saved.reduce((sum, value, i) => sum + value * observed[i]!, 0)));
      return [{ ...person, similarity }];
    }).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  }
}
