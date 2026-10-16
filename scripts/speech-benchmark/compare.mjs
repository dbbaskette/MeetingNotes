// Explicit local corpus only: never discovers or opens the user's meeting library.
// Usage: ELECTRON_RUN_AS_NODE=1 electron scripts/speech-benchmark/compare.mjs manifest.json [--parakeet=/absolute/binary] [--whisper=http://127.0.0.1:PORT]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { SpeechClient } from '../../dist/electron/main/speech/client.js';

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('Provide an explicit local benchmark manifest. See docs/guide/speech-beta.md.');
const corpus = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(corpus.cases) || !corpus.cases.length || !corpus.license || !corpus.description) throw new Error('A corpus description, license/permission statement, and nonempty cases list are required.');
const flags = Object.fromEntries(process.argv.slice(3).map(arg => { const split = arg.indexOf('='); return [arg.slice(2, split), arg.slice(split + 1)]; }));
let whisper;
if (flags.whisper) {
  whisper = new URL(flags.whisper);
  if (whisper.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(whisper.hostname)) throw new Error('Benchmark Whisper endpoint must be local.');
}
const helper = new SpeechClient(path.resolve('speech-engine/.build/release/meeting-notes-speech'));
const output = path.resolve('speech-benchmark-results', `comparison-${Date.now()}`); fs.mkdirSync(output, { recursive: true });
const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
function edits(reference, hypothesis) {
  let row = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i++) {
    const next = [i];
    for (let j = 1; j <= hypothesis.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
    row = next;
  }
  return row[hypothesis.length];
}
async function parakeet(audio) {
  return new Promise((resolve, reject) => {
    const child = spawn(flags.parakeet, [audio, path.resolve('speech-benchmark-results/parakeet-models')], { stdio: ['ignore', 'pipe', 'ignore'] });
    let data = ''; const timeout = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
    child.stdout.on('data', chunk => { data += chunk; if (data.length > 20_000_000) child.kill('SIGKILL'); });
    child.on('error', reject); child.on('close', code => { clearTimeout(timeout); if (code !== 0) reject(new Error(`Parakeet exited ${code}`)); else { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } } });
  });
}
const rows = [];
for (const item of corpus.cases) {
  if (typeof item.reference !== 'string' || typeof item.audio !== 'string') throw new Error('Each case needs audio and reference text.');
  const audio = path.resolve(path.dirname(manifestPath), item.audio);
  for (const engine of ['apple', ...(whisper ? ['whisper'] : []), ...(flags.parakeet ? ['parakeet'] : [])]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const begin = performance.now();
      let result;
      try {
        if (engine === 'apple') result = (await helper.request('transcribe', { audioPath: audio })).result;
        else if (engine === 'parakeet') result = await parakeet(audio);
        else {
          const form = new FormData(); form.append('file', new Blob([fs.readFileSync(audio)]), path.basename(audio)); form.append('response_format', 'verbose_json');
          const response = await fetch(new URL('/inference', whisper), { method: 'POST', body: form, signal: AbortSignal.timeout(30 * 60_000) });
          if (!response.ok) throw new Error(`Whisper ${response.status}`); result = await response.json();
        }
        const reference = normalize(item.reference), actual = normalize(result.text);
        rows.push({ case: item.id ?? item.audio, engine, repeat, elapsedMs: performance.now() - begin,
          words: reference.length, errors: edits(reference, actual), result });
      } catch (error) { rows.push({ case: item.id ?? item.audio, engine, repeat, error: error.message }); }
      fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ description: corpus.description, license: corpus.license,
        os: os.release(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), testedAt: new Date().toISOString(), rows,
        limitations: 'Two separate helper invocations include model loading; not steady-state streaming speed. Apple asset versions are OS-managed. No cross-meeting speaker calibration or real-meeting promotion is established by this harness alone.' }, null, 2));
    }
  }
}
console.log(JSON.stringify({ output, completed: rows.filter(row => !row.error).length, failed: rows.filter(row => row.error).length }));
if (rows.some(row => row.error)) process.exitCode = 1;
