import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { RemoteDiarizationSchema, type RemoteDiarization } from '../../../shared/remote-contracts.js';
import { canonical } from './client.js';

function average(diar: RemoteDiarization, label: string): number[] | null {
  const vectors = diar.segments.filter(s => s.speaker === label && s.speaker !== 'unknown').map(s => s.embedding)
    .filter(v => v.length === diar.embeddingIdentity.dimension && v.some(x => x !== 0));
  if (!vectors.length) return null;
  const sum = Array.from({ length: diar.embeddingIdentity.dimension }, (_, i) => vectors.reduce((n, v) => n + v[i]!, 0) / vectors.length);
  const norm = Math.hypot(...sum); return norm > 0 && Number.isFinite(norm) ? sum.map(n => n / norm) : null;
}
/** Legacy binary roster vectors have no verified provenance and never enter this namespace. */
export class RemoteEmbeddings {
  constructor(private db: Database.Database) {}
  confirm(folder: string, label: string, speakerId: string): void {
    const diar = RemoteDiarizationSchema.parse(JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8')));
    const vector = average(diar, label); if (!vector) return;
    this.db.prepare('INSERT INTO remote_roster_embeddings VALUES (?,?,?) ON CONFLICT(speaker_id,identity) DO UPDATE SET vector=excluded.vector')
      .run(speakerId, canonical(diar.embeddingIdentity), JSON.stringify(vector));
  }
  match(diar: RemoteDiarization, label: string): { id: string; confidence: number } | null {
    const vector = average(diar, label); if (!vector) return null;
    const rows = this.db.prepare('SELECT speaker_id,vector FROM remote_roster_embeddings WHERE identity=?').all(canonical(diar.embeddingIdentity)) as { speaker_id: string; vector: string }[];
    const scores = rows.map(r => {
      const stored = JSON.parse(r.vector) as number[];
      return { id: r.speaker_id, confidence: vector.reduce((sum, n, i) => sum + n * (stored[i] ?? 0), 0) };
    }).sort((a, b) => b.confidence - a.confidence);
    const best = scores[0];
    return best && best.confidence >= 0.85 && (!scores[1] || best.confidence - scores[1].confidence >= 0.1) ? best : null;
  }
}
