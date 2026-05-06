#!/usr/bin/env node
// scripts/capture-screenshots.mjs
//
// Headless-Chromium capture of the renderer UI for the README screenshots
// referenced under docs/screenshots/. Not part of the release build — run
// by hand when the UI changes and the README shots need refreshing:
//
//   npm run dev:renderer &   # Vite on :5174
//   node scripts/capture-screenshots.mjs
//
// Uses the browser that ships with macOS (Google Chrome) via puppeteer-core
// so we don't have to download a separate Chromium. Relies on the dev-shim
// in index.html to provide window.api — no Electron preload in this path.

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_BASE = 'http://localhost:5174';

const VIEWPORT = { width: 1400, height: 900, deviceScaleFactor: 2 };

// Rich detail-view payload so the detail screenshots have meaningful content.
const RICH_DETAIL = {
  id: 'b',
  slug: 'b',
  title: 'Design critique — detail view',
  startedAt: '2026-04-20T11:00:00',
  durationS: 2100,
  pipelineStage: 'awaiting_speaker_id',
  status: 'awaiting_user',
  stageStartedAt: '2026-04-20T12:00:00',
  skipSpeakerId: false,
  unidentifiedCount: 2,
  actionItemsCount: 0,
  speakers: [
    { localLabel: 'SPEAKER_00', rosterId: null, displayName: null, confidence: null },
    { localLabel: 'SPEAKER_01', rosterId: null, displayName: null, confidence: null },
  ],
  transcriptMd: [
    '[You 00:00] Hey everyone, thanks for joining.',
    '[SPEAKER_00 00:04] Glad to be here.',
    '[You 00:08] Let\'s start with the critique results.',
    '[SPEAKER_01 00:14] The row chromatic noise observation stood out to me.',
    '[You 00:20] Agreed — we demoted the action-items pill already.',
  ].join('\n'),
  rawTranscriptText: null,
  summaryMd: [
    '## Overview',
    'Two-hour walkthrough of the library and detail views. Focused on row density,',
    'action-item visibility, and the awaiting-user gate.',
    '',
    '## Decisions',
    '- **Demote the action-items pill** to outline style so state reads first.',
    '- **Move the awaiting-user banner** above the pipeline timeline.',
    '- **Drop the InboxRow component** in favor of a unified list.',
    '',
    '## Follow-ups',
    '- Ship updated screenshots for the README.',
  ].join('\n'),
  audioPath: '/tmp/sample.m4a',
  actionItems: [],
  models: { stt: 'whisper-large-v3', llm: 'qwen3.5-9b' },
};

const DONE_DETAIL = {
  ...RICH_DETAIL,
  id: 'a',
  slug: 'a',
  title: 'Quarterly planning review',
  startedAt: '2026-04-20T08:00:00',
  durationS: 3200,
  pipelineStage: 'done',
  status: 'done',
  skipSpeakerId: false,
  unidentifiedCount: 0,
  actionItemsCount: 9,
  speakers: [
    { localLabel: 'SPEAKER_00', rosterId: 'r1', displayName: 'Alice', confidence: 0.95 },
    { localLabel: 'SPEAKER_01', rosterId: 'r2', displayName: 'Bob', confidence: 0.95 },
  ],
  actionItems: [
    { id: 'x1', text: 'Ship the storage plan by Friday', ownerName: 'Alice', dueDate: '2026-04-25', status: 'open', exportedTo: [] },
    { id: 'x2', text: 'Draft the budget review', ownerName: null, dueDate: null, status: 'open', exportedTo: [] },
  ],
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  defaultViewport: VIEWPORT,
});

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  // Headless Chrome inherits the OS color-scheme preference, which on
  // a dark-mode Mac flips the whole renderer to its dark palette.
  // README screenshots are documented in the light palette, so force
  // it here. (Override locally to capture dark-mode counterparts.)
  await page.emulateMediaFeatures([
    { name: 'prefers-color-scheme', value: 'light' },
  ]);
  return page;
}

async function installApiOverrides(page, { detailById }) {
  await page.evaluateOnNewDocument((detailByIdSerialized) => {
    const detailById = JSON.parse(detailByIdSerialized);
    const waitForApi = () => new Promise((resolve) => {
      const check = () => {
        if (window.api) return resolve();
        setTimeout(check, 10);
      };
      check();
    });
    waitForApi().then(() => {
      window.api.meetings.get = async (id) => detailById[id] ?? null;
      window.api.speakers.sample = async () => null;
    });
  }, JSON.stringify(detailById));
}

async function shoot(filename, setup) {
  const page = await newPage();
  await installApiOverrides(page, setup.overrides ?? { detailById: {} });
  await page.goto(URL_BASE, { waitUntil: 'networkidle2' });
  // Give the library's 3s polling refresh a beat to populate rows.
  await new Promise((r) => setTimeout(r, 800));
  if (setup.after) await setup.after(page);
  await new Promise((r) => setTimeout(r, 400));
  const outPath = path.join(OUT, filename);
  await page.screenshot({ path: outPath, type: 'png' });
  console.log('wrote', path.relative(REPO, outPath));
  await page.close();
}

try {
  // 1. Library — unified list as rendered by the dev shim.
  await shoot('library.png', {
    overrides: { detailById: {} },
  });

  // 2. Recording in progress — click Record → "All system audio" to set
  //    LiveRecordingRow state.
  await shoot('recording.png', {
    overrides: { detailById: {} },
    after: async (page) => {
      await page.evaluate(() => {
        const recordBtn = [...document.querySelectorAll('button')]
          .find((b) => /Record/.test(b.textContent ?? ''));
        recordBtn?.click();
      });
      await new Promise((r) => setTimeout(r, 300));
      await page.evaluate(() => {
        const sysAudio = [...document.querySelectorAll('button')]
          .find((b) => /All system audio/.test(b.textContent ?? ''));
        sysAudio?.click();
      });
      await new Promise((r) => setTimeout(r, 400));
    },
  });

  // 3. Speaker-ID gate — click the awaiting_user row to open detail view.
  await shoot('speaker-id.png', {
    overrides: { detailById: { b: RICH_DETAIL } },
    after: async (page) => {
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[class*="rounded-xl"][class*="cursor-pointer"]')];
        const target = rows.find((r) => (r.textContent ?? '').includes('Design critique'));
        target?.click();
      });
      await new Promise((r) => setTimeout(r, 500));
    },
  });

  // 4. Summary editor — click the done row; detail view defaults to Summary tab.
  await shoot('summary.png', {
    overrides: { detailById: { a: DONE_DETAIL } },
    after: async (page) => {
      await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[class*="rounded-xl"][class*="cursor-pointer"]')];
        const target = rows.find((r) => (r.textContent ?? '').includes('Quarterly planning'));
        target?.click();
      });
      await new Promise((r) => setTimeout(r, 500));
    },
  });
} finally {
  await browser.close();
}
