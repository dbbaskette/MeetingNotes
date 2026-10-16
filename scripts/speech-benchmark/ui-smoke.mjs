import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { openDb } from '../../dist/electron/main/storage/db.js';
import { MeetingsRepo } from '../../dist/electron/main/storage/meetings-repo.js';
import { BetaLibraryImport } from '../../dist/electron/main/beta/library.js';
import { BetaService } from '../../dist/electron/main/beta/service.js';

const require = createRequire(import.meta.url), electron = require('electron');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-beta-ui-')));
const stable = path.join(root, 'stable'), profile = path.join(root, 'profile'); fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, '.speech-beta-fixture'), 'synthetic');
const audio = path.join(root, 'speech.wav');
execFileSync('/usr/bin/say', ['-v', 'Samantha', '--data-format=LEI16@16000', '-o', audio, 'This is a synthetic beta user interface test.']);
const db = openDb(path.join(stable, 'db.sqlite'));
new MeetingsRepo(db).insert({ id: 'meeting', slug: 'meeting', title: 'Weekly review', startedAt: null, durationS: 5, audioPath: audio, status: 'done', pipelineStage: 'done' });
db.close();
const folder = path.join(stable, 'meetings', 'meeting'); fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'transcript.md'), '[Dan 00:00] Original wording.');
fs.writeFileSync(path.join(folder, 'summary.md'), 'Original notes.');
const importer = new BetaLibraryImport(profile); await importer.preview(stable); await importer.run(new AbortController().signal, () => {});
const service = new BetaService(profile, { request: async operation => ({ elapsedMs: 1, result: operation === 'health' ? { installed: true } : {
  text: 'New wording.', segments: [{ start: 0, end: 2, text: 'New wording.' }], provider: 'apple', locale: 'en_US', osVersion: 'fixture', durationS: 5,
} }), cancel() {} });
await service.checkApple(); await service.run('meeting', 'transcript');
try {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, ['dist/electron/main/beta/index.js'], { stdio: 'inherit', env: { ...process.env,
      ELECTRON_RUN_AS_NODE: '', MN_SPEECH_BETA_TEST_ROOT: profile, MN_SPEECH_BETA_UI_SMOKE: '1' } });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Beta UI exceeded 60 seconds.')); }, 60_000);
    child.on('error', reject); child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Beta UI exited ${code}`)); });
  });
  const result = JSON.parse(fs.readFileSync(path.join(profile, 'ui-result.json'), 'utf8'));
  const output = path.resolve(process.env.MN_BETA_UI_RESULTS ?? 'speech-benchmark-results/ui'); fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(path.join(profile, 'comparison.png'), path.join(output, 'comparison.png'));
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, screenshot: path.join(output, 'comparison.png') }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
