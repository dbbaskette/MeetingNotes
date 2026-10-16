import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SPEAKER_REVISION } from './client.js';

// Immutable Hub revision, metadata read 2026-10-16. LFS files use SHA-256;
// regular Git files use Git's blob hash (header + bytes), not raw SHA-1.
const files: [string, number, string, 'sha256' | 'git'][] = [
  ['speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc/analytics/coremldata.bin',243,'3e13c8f4df77ea27cbbcdd6d083c63f5e7b3f32566cc5bf223fab92d40b81b8b','sha256'],
  ['speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc/coremldata.bin',327,'6f6820ccf221d4cc7c107101d0ae4d716eb224e4fdffaf8f7ca36af70ae64c40','sha256'],
  ['speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc/metadata.json',1766,'7f62e72b27bd0709860ef2dcbaeb18750348ec36','git'],
  ['speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc/model.mil',8128,'860a885a2b6a461570d8580c4ef8bb32f74be725','git'],
  ['speaker_clusterer/pyannote-v4/W32A32/PldaProjector.mlmodelc/weights/weight.bin',199040,'a1dbbb651a0a67fcfe5334672f459df090fa960917a6ee3a5423245a7ab92ced','sha256'],
  ['speaker_clusterer/pyannote-v4/W32A32/README.txt',98,'858a6ac596e8cad262b6065860a38cbbd4dc7b5a','git'],
  ['speaker_embedder/pyannote-v3/W8A16/README.txt',122,'8d67f4e9dc64b398be4e6c7a270a797d6528f180','git'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedder.mlmodelc/analytics/coremldata.bin',243,'ba8405dfc9b9348ade705e052888b4bdc7fb8d079ef3ff71108a5f692d0209f2','sha256'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedder.mlmodelc/coremldata.bin',370,'1597d6c037ac52436b5c2e1abc47e6c68483c19eeac75267dfb8795a78ec07c5','sha256'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedder.mlmodelc/metadata.json',2367,'9cba75642fae5eb180fb875a4c33ed994d1b8562','git'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedder.mlmodelc/model.mil',451487,'10e869fd4cb6b96bdf378ad7b9a0d965182d152e','git'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedder.mlmodelc/weights/weight.bin',6661888,'a02861969f47cf3a67e3b0d276e54b3c8bc3a6e43d40d77d1cccbd57da0e5795','sha256'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedderPreprocessor.mlmodelc/analytics/coremldata.bin',243,'ce9bef9fb3125a5401300b5c5998c5d8f211094692cae780645d3e2757410f2c','sha256'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedderPreprocessor.mlmodelc/coremldata.bin',330,'b4ebd0b9ce5a84768672663aff426eb19f9648d4b9f74286f0e19fc753ad76ba','sha256'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedderPreprocessor.mlmodelc/metadata.json',1979,'c02bf57b58519e991a1763545a5790d0066187b8','git'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedderPreprocessor.mlmodelc/model.mil',14224,'37391f6a0a980f0fb0da50b729dd76ae9cfd3d07','git'],
  ['speaker_embedder/pyannote-v3/W8A16/SpeakerEmbedderPreprocessor.mlmodelc/weights/weight.bin',2181696,'5f2c284bd22f1f7ab76901c1c6e57f82d4ebbf057fa0b924aad057f124f77a89','sha256'],
  ['speaker_segmenter/pyannote-v3/W8A16/README.txt',105,'565bacee7df54b23b7929cffebf9b96502008a1d','git'],
  ['speaker_segmenter/pyannote-v3/W8A16/SpeakerSegmenter.mlmodelc/analytics/coremldata.bin',243,'40637aa0cb2a073bc303c7ca9ee79da35fa81d2cad1ead180e93b134005b95de','sha256'],
  ['speaker_segmenter/pyannote-v3/W8A16/SpeakerSegmenter.mlmodelc/coremldata.bin',497,'6c356ed983b2a3332ce51299ca0f9747a35cb6c2a67b0ac24c69dbef3f989634','sha256'],
  ['speaker_segmenter/pyannote-v3/W8A16/SpeakerSegmenter.mlmodelc/metadata.json',3757,'8c71ca244a2d67d993ac9c2a6aa2dafd97a9522c','git'],
  ['speaker_segmenter/pyannote-v3/W8A16/SpeakerSegmenter.mlmodelc/model.mil',193092,'158ce216548ccddd75173c13609948457715cc92','git'],
  ['speaker_segmenter/pyannote-v3/W8A16/SpeakerSegmenter.mlmodelc/weights/weight.bin',1520986,'75ff1725ef4e58dacf9176466ec274a8a13a6132c296d6b571fb78ddad5455c4','sha256'],
];
export const SPEAKER_DOWNLOAD_BYTES = files.reduce((sum, [, size]) => sum + size, 0);
export function verifyModelBytes(data: Buffer, expectedSize: number, hash: string, algorithm: 'sha256' | 'git'): boolean {
  if (data.length !== expectedSize) return false;
  const digest = createHash(algorithm === 'git' ? 'sha1' : 'sha256');
  if (algorithm === 'git') digest.update(`blob ${data.length}\0`);
  return digest.update(data).digest('hex') === hash;
}
export function modelsReady(folder: string): boolean {
  try {
    return files.every(([name, size, hash, algorithm]) => {
      const file = path.join(folder, name);
      return !fs.lstatSync(file).isSymbolicLink() && verifyModelBytes(fs.readFileSync(file), size, hash, algorithm);
    });
  } catch { return false; }
}
export async function installSpeakerModels(folder: string, signal: AbortSignal, progress: (fraction: number) => void): Promise<void> {
  if (modelsReady(folder)) { progress(1); return; }
  const parent = path.dirname(folder);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const disk = fs.statfsSync(parent);
  if (disk.bavail * disk.bsize < SPEAKER_DOWNLOAD_BYTES * 3 + 100 * 1024 * 1024) throw new Error('Free at least 150 MB for speaker model setup.');
  const temporary = path.join(parent, `.speaker-download-${randomUUID()}`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    let completed = 0;
    for (const [name, size, hash, algorithm] of files) {
      signal.throwIfAborted();
      const url = `https://huggingface.co/argmaxinc/speakerkit-coreml/resolve/${SPEAKER_REVISION}/${name}`;
      const response = await fetch(url, { signal, credentials: 'omit' });
      if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}). Retry while online.`);
      const chunks: Buffer[] = []; let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > size) throw new Error('Model download exceeded the expected size.');
        chunks.push(Buffer.from(chunk)); progress((completed + received) / SPEAKER_DOWNLOAD_BYTES);
      }
      const data = Buffer.concat(chunks);
      if (!verifyModelBytes(data, size, hash, algorithm)) throw new Error('Model integrity verification failed. Retry the download.');
      const target = path.join(temporary, name);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data, { flag: 'wx' });
      completed += size;
    }
    signal.throwIfAborted();
    if (fs.existsSync(folder)) fs.renameSync(folder, `${folder}.invalid-${randomUUID()}`);
    fs.renameSync(temporary, folder); progress(1);
  } finally {
    // Only this operation's newly created directory, never a user-selected path.
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
