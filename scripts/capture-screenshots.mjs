// scripts/capture-screenshots.mjs
//
// Captures the README screenshots under docs/screenshots/ from the current
// renderer, using synthetic data only. Run by hand when the UI changes:
//
//   npm run dev:renderer      # Vite on :5174, in another terminal
//   npm run screenshots
//
// It runs inside Electron (no extra browser dependency) and relies on the
// browser-preview API in
// electron/renderer/src/dev/preview-api.ts for `window.api`. No Electron
// preload, main-process service, real meeting or real setting is involved.

import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'docs/screenshots');
const SIZE = { width: 1400, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A throwaway profile so nothing is read from or written to the real app's.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-screenshots-')));

const transcript = [
  '[Alice 00:00] Thanks for joining. Three things today: storage, the Q3 budget, and hiring.',
  '[Bob 00:12] On storage, the migration dry run finished last night with no data loss.',
  '[Alice 00:25] Good. Can we commit to cutting over before the end of the month?',
  '[Bob 00:31] Yes, if the rollback plan is reviewed this week. I will send it by Friday.',
  '[Priya 00:44] Budget is tracking four percent under. I would move that into the tooling line.',
  '[Alice 00:58] Agreed. Decision: reallocate the surplus to tooling.',
  '[Priya 01:10] For hiring, two candidates are at the final stage. Feedback is due Wednesday.',
].join('\n');

const summary = [
  '## Overview',
  'Quarterly planning covering the storage migration, the Q3 budget and open hiring. The migration dry run succeeded and the team committed to a cut-over date.',
  '',
  '## Key Discussion Points',
  '- **Storage migration:** the dry run completed with no data loss; the remaining risk is the rollback plan.',
  '- **Q3 budget:** spending is four percent under plan.',
  '- **Hiring:** two candidates are in the final stage.',
  '',
  '## Decisions',
  '- Cut over to the new storage tier before the end of the month.',
  '- Reallocate the Q3 surplus to the tooling line.',
  '',
  '## Action Items',
  '- **Bob** — send the rollback plan for review by Friday.',
  '- **Priya** — collect final-round interview feedback by Wednesday.',
  '',
  '## Open Questions',
  '- Who signs off on the cut-over window?',
].join('\n');

const base = {
  groupId: null, groupName: null, errorMessage: null, processingHistory: [], stageStartedAt: null,
  stageEtaMs: null, stageEtaRough: false, skipSpeakerId: false, rawTranscriptText: null,
  audioPath: '/tmp/meetingnotes-screenshot.m4a', userIdentified: true, models: { stt: 'large-v3-turbo', llm: 'qwen/qwen3.5-9b' },
};

const DONE = {
  ...base, id: 'a', slug: 'a', title: 'Quarterly planning review', startedAt: '2026-04-20T08:00:00', durationS: 3200,
  pipelineStage: 'done', status: 'done', transcriptMd: transcript, summaryMd: summary,
  speakers: [
    { localLabel: 'SPEAKER_00', rosterId: 'r1', displayName: 'Alice', confidence: 1 },
    { localLabel: 'SPEAKER_01', rosterId: 'r2', displayName: 'Bob', confidence: 0.94 },
    { localLabel: 'SPEAKER_02', rosterId: 'r3', displayName: 'Priya', confidence: 0.91 },
  ],
  actionItems: [
    { id: 'x1', text: 'Send the rollback plan for review', ownerName: 'Bob', dueDate: '2026-04-24', status: 'open', exportedTo: [], sourceQuote: 'I will send it by Friday.', isMine: false },
    { id: 'x2', text: 'Collect final-round interview feedback', ownerName: 'Priya', dueDate: '2026-04-22', status: 'open', exportedTo: [], sourceQuote: 'Feedback is due Wednesday.', isMine: false },
  ],
};

const GATE = {
  ...base, id: 'b', slug: 'b', title: 'Design critique — detail view', startedAt: '2026-04-20T11:00:00', durationS: 2100,
  pipelineStage: 'awaiting_speaker_id', status: 'awaiting_user', transcriptMd: transcript.replace(/Bob/g, 'SPEAKER_01').replace(/Priya/g, 'SPEAKER_02'),
  summaryMd: null, userIdentified: true,
  speakers: [
    { localLabel: 'SPEAKER_00', rosterId: 'r1', displayName: 'Alice', confidence: 1 },
    { localLabel: 'SPEAKER_01', rosterId: null, displayName: null, confidence: null },
    { localLabel: 'SPEAKER_02', rosterId: 'r3', displayName: 'Priya', confidence: 0.62 },
  ],
  actionItems: [],
};

const review = (meeting) => ({
  speakers: meeting.speakers.map((sp, i) => ({
    ...sp,
    state: !sp.rosterId ? 'unknown' : (sp.confidence ?? 0) >= 0.999 ? 'confirmed' : 'probable',
    needsReview: !sp.rosterId || (sp.confidence ?? 0) < 0.8,
    segmentCount: 12 - i * 3, durationS: 600 - i * 150, lineCount: 40 - i * 9,
  })),
});

/** Runs in the page: replace preview-API methods with meeting-page data. */
function installFixtures(serialized) {
  const { details, reviews } = JSON.parse(serialized);
  const strip = (m) => { const { transcriptMd, rawTranscriptText, ...shell } = m; return shell; };
  const api = window.api;
  api.meetings.get = async (id) => (details[id] ? strip(details[id]) : null);
  api.meetings.getTranscript = async (id) => (details[id] ? { transcriptMd: details[id].transcriptMd, rawTranscriptText: null } : null);
  api.meetings.getSpeakerReview = async (id) => reviews[id] ?? null;
  api.meetings.getStatus = async (id) => (details[id] ? { ...strip(details[id]) } : null);
  api.speakers.list = async () => [
    { id: 'r1', displayName: 'Alice' }, { id: 'r2', displayName: 'Bob' }, { id: 'r3', displayName: 'Priya' },
  ];
  api.speakers.suggestions = async () => [];
  api.recording.listSources = async () => [];
  return true;
}

/** Runs in the page: click the innermost element whose text matches, so the
 *  click bubbles to whatever row or button owns it. */
function clickText(pattern, selector) {
  const re = new RegExp(pattern);
  const matches = [...document.querySelectorAll(selector)].filter((node) => re.test((node.textContent ?? '').trim()));
  const el = matches.find((node) => !matches.some((other) => other !== node && node.contains(other)));
  if (!el) return false;
  el.click();
  return true;
}

async function shoot(url, filename, steps = []) {
  const win = new BrowserWindow({
    ...SIZE, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message.slice(0, 200)); });
  // Vite may restart once while it pre-bundles dependencies on a cold cache.
  for (let attempt = 1; ; attempt++) {
    try { await win.loadURL(url); break; }
    catch (error) { if (attempt === 5) throw error; await sleep(1000); }
  }
  // The preview API is installed during bootstrap; wait for the app to mount.
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('!!window.api && document.getElementById("root").children.length > 0')) break;
    await sleep(50);
  }
  const fixtures = JSON.stringify({ details: { a: DONE, b: GATE }, reviews: { a: review(DONE), b: review(GATE) } });
  await win.webContents.executeJavaScript(`(${installFixtures.toString()})(${JSON.stringify(fixtures)})`);
  await sleep(900);
  for (const [pattern, selector] of steps) {
    const clicked = await win.webContents.executeJavaScript(`(${clickText.toString()})(${JSON.stringify(pattern)}, ${JSON.stringify(selector)})`);
    if (!clicked) throw new Error(`${filename}: nothing matched ${pattern} in ${selector}`);
    await sleep(900);
  }
  const failed = await win.webContents.executeJavaScript('[...document.querySelectorAll("[role=alert]")].map((n) => n.textContent.slice(0, 80))');
  if (failed.length) throw new Error(`${filename}: a view failed to render: ${failed.join(' | ')}\n${errors.slice(-3).join('\n')}`);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, filename), image.toPNG());
  console.log('wrote', path.join('docs/screenshots', filename), `${image.getSize().width}x${image.getSize().height}`);
  win.destroy();
}

// Each shot uses its own window; closing one must not quit the app.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  fs.mkdirSync(OUT, { recursive: true });
  const url = process.env.MN_SCREENSHOT_URL ?? 'http://localhost:5174/';
  try { await fetch(url, { signal: AbortSignal.timeout(3000) }); }
  catch { console.error(`No dev server at ${url}. Start it with: npm run dev:renderer`); app.exit(1); return; }
  let code = 0;
  try {
    await shoot(url, 'library.png');
    await shoot(url, 'recording.png', [['Record', 'button'], ['All system audio', 'button']]);
    await shoot(url, 'speaker-id.png', [['^Name speakers$', 'button']]);
    await shoot(url, 'summary.png', [['^Quarterly planning review$', 'main *, #root *']]);
    await shoot(url, 'weekly.png', [['^Weekly$', 'button']]);
  } catch (error) {
    console.error(String(error));
    code = 1;
  } finally {
    app.exit(code);
  }
});
