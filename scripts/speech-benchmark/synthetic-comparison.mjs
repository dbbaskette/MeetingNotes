// Starts only a task-owned Whisper process on a newly allocated loopback port.
// All inputs/outputs are generated synthetic fixtures under the ignored benchmark directory.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { findWhisperBinary, resolveModelPath } from '../../dist/electron/main/whisper/supervisor.js';

const root = path.resolve('speech-benchmark-results/synthetic-comparison'); fs.mkdirSync(root, { recursive: true });
const cases = [
  { id: 'clean-business', voice: 'Samantha', reference: 'We approved the release but do not delete the backup. Keith will review the security report on Friday. The deployment is blocked until we finish the audit.' },
  { id: 'different-voice', voice: 'Daniel', reference: 'The customer asked us to keep the original recording. We should compare the speaker profiles before we change the settings. The migration must preserve all saved names.' },
];
for (const item of cases) {
  item.audio = `${item.id}.wav`;
  execFileSync('/usr/bin/say', ['-v', item.voice, '--data-format=LEI16@16000', '-o', path.join(root, item.audio), item.reference]);
}
const manifest = path.join(root, 'manifest.json');
fs.writeFileSync(manifest, JSON.stringify({ description: 'Two short clean synthetic system-voice fixtures, not real meetings. WER uses basic text normalization; written/spoken number equivalents are not expanded.',
  license: 'Locally generated synthetic speech for development evaluation only; no private meetings or third-party audio redistributed.', cases }, null, 2));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const model = resolveModelPath();
const whisper = spawn(findWhisperBinary(), ['--model', model, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'ignore', 'ignore'] });
const stop = () => { whisper.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (whisper.exitCode !== null) throw new Error('Task-owned Whisper exited before readiness.');
    try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); ready = response.ok && (await response.json()).status === 'ok'; } catch { /* model loading */ }
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Task-owned Whisper failed readiness. No existing server was adopted.');
  const parakeet = path.resolve('scripts/speech-benchmark/parakeet/.build/release/parakeet-comparison');
  execFileSync(process.execPath, ['scripts/speech-benchmark/compare.mjs', manifest, `--whisper=http://127.0.0.1:${port}`, `--parakeet=${parakeet}`],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 20 * 60_000 });
  console.log(JSON.stringify({ whisperModel: path.basename(model), corpus: manifest, scope: 'Short synthetic feasibility only; no promotion gate passed.' }));
} finally {
  stop(); await new Promise(resolve => { if (whisper.exitCode !== null) resolve(); else { const timer = setTimeout(() => { whisper.kill('SIGKILL'); resolve(); }, 2000); whisper.once('exit', () => { clearTimeout(timer); resolve(); }); } });
}
