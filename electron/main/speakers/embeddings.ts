import fs from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('MNEMB');

export function embeddingFilePath(rootDir: string, speakerId: string): string {
  return path.join(rootDir, 'speakers', 'embeddings', `${speakerId}.bin`);
}

export function writeEmbedding(file: string, vec: readonly number[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.alloc(MAGIC.length + 4 + vec.length * 4);
  MAGIC.copy(buf, 0);
  buf.writeUInt32LE(vec.length, MAGIC.length);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i]!, MAGIC.length + 4 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

export function readEmbedding(file: string): number[] {
  const buf = fs.readFileSync(file);
  if (buf.length < MAGIC.length + 4 || !buf.slice(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`unrecognized embedding format in ${file}`);
  }
  const n = buf.readUInt32LE(MAGIC.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(MAGIC.length + 4 + i * 4);
  return out;
}
