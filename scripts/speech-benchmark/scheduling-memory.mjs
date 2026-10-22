// Physical-Mac measurement, using only the existing generated synthetic fixture.
// No model downloads, setup changes, microphone, or user meeting access.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const label = process.argv[2] ?? 'measured';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Use a simple measurement label.');
const root = path.resolve('speech-benchmark-results/scheduling-memory', label);
fs.mkdirSync(root, { recursive: true });
const revision = '556fc52a13327837688f02289457cded017802e9';
const audioPath = path.resolve('speech-benchmark-results/long-smoke/repeated-synthetic-75min.wav');
const modelFolder = path.resolve('speech-benchmark-results/synthetic-smoke/models', revision);
const helper = path.resolve('speech-engine/.build/release/meeting-notes-speech');
for (const file of [audioPath, modelFolder, helper]) if (!fs.existsSync(file)) throw new Error(`Missing existing synthetic fixture: ${file}`);
const active = new Set(); let peakKiB = 0, progressEvents = 0;
const timer = setInterval(() => {
  if (!active.size) return;
  try {
    const values = execFileSync('/bin/ps', ['-o', 'rss=', '-p', [...active].map(child => child.pid).join(',')], { encoding: 'utf8' });
    peakKiB = Math.max(peakKiB, values.trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0));
  } catch { /* child may have exited between snapshot and query */ }
}, 100);
async function operation(operation) {
  return new Promise((resolve, reject) => {
    const id = randomUUID(), child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] }); active.add(child);
    let pending = '', result, error;
    const deadline = setTimeout(() => { error = 'Synthetic inference timed out'; child.kill('SIGKILL'); }, 300000);
    child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      for (let newline; (newline = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.id !== id) continue;
          if (event.kind === 'progress') progressEvents++;
          if (event.kind === 'error') error = event.message;
          if (event.kind === 'result') result = event.result;
        } catch { error = 'Malformed helper output'; }
      }
    });
    child.once('error', caught => { error = String(caught); });
    child.once('close', code => {
      clearTimeout(deadline); active.delete(child);
      if (code || error || !result?.segments?.length) reject(new Error(error ?? 'No valid segments'));
      else resolve({ segments: result.segments.length, lastEnd: result.segments.at(-1).end, durationS: result.durationS });
    });
    child.stdin.end(JSON.stringify({ version: 1, id, operation, audioPath, locale: 'en-US', modelFolder, modelRevision: revision }) + '\n');
  });
}
const runs = [];
try {
  for (const sequential of [false, true, false, true]) {
    peakKiB = 0; progressEvents = 0; const start = performance.now();
    const result = sequential ? [await operation('transcribe'), await operation('diarize')]
      : await Promise.all([operation('transcribe'), operation('diarize')]);
    if (!result.every(value => value.lastEnd > 4490)) throw new Error('Incomplete synthetic timeline');
    const run = { sequential, elapsedMs: Math.round(performance.now() - start), peakHelperRssMiB: Math.round(peakKiB / 1024), progressEvents, result };
    runs.push(run); console.log(JSON.stringify(run));
  }
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ runs,
    limitations: 'Repeated 75-minute clean synthetic speech on this physical Mac; 100ms sampling of summed helper RSS only. Excludes Apple service/GPU allocations and is not a real-meeting accuracy or system-wide memory benchmark.' }, null, 2));
} finally { clearInterval(timer); for (const child of active) child.kill('SIGKILL'); }
