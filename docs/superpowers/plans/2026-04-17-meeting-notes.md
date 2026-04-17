# MeetingNotes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Mac desktop app that records biz meetings via Audio Hijack, transcribes + diarizes them using LM Studio and a Python pyannote sidecar, identifies speakers against a persistent roster, produces structured summaries with action items, and exports to Apple Reminders / Markdown.

**Architecture:** Electron (TypeScript + React + Tailwind renderer; Node main process) + a Python FastAPI sidecar for speaker diarization. LM Studio (external, user-managed) serves Whisper and chat models via its OpenAI-compatible API. SQLite indexes a filesystem that is the source of truth. Pipeline is a persisted state machine that survives crashes.

**Tech Stack:** Electron 30, Vite, React 18, TypeScript 5, Tailwind CSS, Zustand, better-sqlite3, chokidar, zod, Vitest, FastAPI, uvicorn, pyannote.audio 3, pytest.

---

## Reference Docs (read before starting)

- Spec: `docs/superpowers/specs/2026-04-17-meeting-notes-design.md`
- Mockups: `mockups/index.html`

## File Structure

```
MeetingNotes/
  package.json
  tsconfig.json · tsconfig.node.json
  vite.config.ts · vitest.config.ts
  electron-builder.yml
  .eslintrc.cjs · .prettierrc
  tailwind.config.js · postcss.config.js
  electron/
    main/
      index.ts                     ← app bootstrap, window, IPC wiring
      lib/                         ← PURE functions (no side effects)
        slug.ts
        title-from-filename.ts
        cosine.ts
        merge-transcript.ts
        stage-machine.ts
        action-item-schema.ts
      storage/
        db.ts                      ← better-sqlite3 connection + migrations
        meetings-repo.ts
        speakers-repo.ts
        action-items-repo.ts
        settings-repo.ts
        meeting-folder.ts          ← filesystem artifacts per meeting
      lm-studio/
        client.ts                  ← OpenAI-compatible wrapper
      diarization/
        client.ts                  ← HTTP client for sidecar
        supervisor.ts              ← spawn/restart Python process
      audio-hijack/
        bridge.ts                  ← osascript wrapper
      library/
        watcher.ts                 ← chokidar folder watcher
      speakers/
        embeddings.ts              ← .npy read/write (simple float32 format)
        matcher.ts                 ← cosine similarity + roster update
      pipeline/
        pipeline.ts                ← orchestrator / queue
        recovery.ts                ← resume from crash on startup
        stages/
          discovered.ts
          transcribing.ts
          diarizing.ts
          merging.ts
          identifying.ts
          summarizing.ts
          extracting.ts
      exporters/
        interface.ts
        markdown.ts
        apple-reminders.ts
        google-tasks-stub.ts
      ipc/
        contracts.ts               ← zod-shared types
        handlers.ts                ← ipcMain.handle bindings
      logging/
        logger.ts                  ← JSON-lines logger
    preload/
      index.ts                     ← contextBridge exposure
    renderer/
      index.html
      src/
        main.tsx
        App.tsx
        ipc/
          client.ts                ← typed wrapper around window.api
          hooks.ts                 ← React Query / Zustand bindings
        store/
          meetings.ts
          settings.ts
          activity.ts
        views/
          LibraryView.tsx
          MeetingDetailView.tsx
          SettingsView.tsx
        components/
          RecordButton.tsx
          RecordingOverlay.tsx
          MeetingCard.tsx
          SpeakerCard.tsx
          ExportPanel.tsx
          ActionItemsList.tsx
          TranscriptView.tsx
          AudioPlayer.tsx
          ErrorBanner.tsx
          ActivityDrawer.tsx
          ProgressBar.tsx
        theme/
          tokens.ts                ← Clean Studio palette constants
  sidecar/
    pyproject.toml
    meeting_notes_diarize/
      __init__.py
      app.py                       ← FastAPI + uvicorn entry
      diarize.py                   ← pyannote wrapper
      schemas.py                   ← pydantic models
    tests/
      test_app.py
      test_diarize.py
    scripts/
      install.sh                   ← first-run venv setup
  samples/
    short-meeting.mp3              ← shared test fixture
    short-meeting.expected.json
  docs/
    superpowers/specs/...
    superpowers/plans/...
    testing.md
```

---

## Phases

- **Phase 1: Project scaffolding** (Tasks 1–4) — Electron + Vite + TS + React + Tailwind + Vitest + lint
- **Phase 2: Pure-function libraries** (Tasks 5–10) — slug, title parser, cosine, merger, stage machine, action-item schema
- **Phase 3: Storage layer** (Tasks 11–17) — SQLite migrations, meeting folder, repos
- **Phase 4: Python diarization sidecar** (Tasks 18–22) — pyproject, FastAPI, pyannote, pytest, install script
- **Phase 5: External clients** (Tasks 23–27) — LM Studio client, diarization client, sidecar supervisor
- **Phase 6: Audio Hijack + library watcher** (Tasks 28–30)
- **Phase 7: Speaker roster** (Tasks 31–33)
- **Phase 8: Pipeline** (Tasks 34–42) — stage handlers, orchestrator, crash recovery
- **Phase 9: Exporters** (Tasks 43–46)
- **Phase 10: IPC layer** (Tasks 47–49)
- **Phase 11: Renderer UI** (Tasks 50–61)
- **Phase 12: Integration + polish** (Tasks 62–65)

Each task follows TDD: write failing test → verify failure → minimal implementation → verify pass → commit.

---

## PHASE 1: Project Scaffolding

### Task 1: Initialize Electron + Vite + TypeScript + React project

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `electron/main/index.ts`, `electron/preload/index.ts`, `electron/renderer/index.html`, `electron/renderer/src/main.tsx`, `electron/renderer/src/App.tsx`, `.gitignore` updates

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "meeting-notes",
  "version": "0.1.0",
  "description": "Local-first meeting notes for macOS — Audio Hijack + LM Studio + pyannote",
  "main": "dist/electron/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "concurrently -k \"npm:dev:renderer\" \"npm:dev:main\"",
    "dev:renderer": "vite",
    "dev:main": "tsc -p tsconfig.node.json --watch & wait-on tcp:5173 && electron .",
    "build": "tsc -p tsconfig.node.json && vite build",
    "start": "electron .",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@vitejs/plugin-react": "^4.2.0",
    "autoprefixer": "^10.4.0",
    "concurrently": "^8.2.0",
    "electron": "^30.0.0",
    "electron-builder": "^24.13.0",
    "eslint": "^8.57.0",
    "eslint-plugin-react": "^7.33.0",
    "eslint-plugin-react-hooks": "^4.6.0",
    "postcss": "^8.4.0",
    "prettier": "^3.2.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.5.0",
    "wait-on": "^7.2.0"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "chokidar": "^3.6.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "zod": "^3.23.0",
    "zustand": "^4.5.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` (renderer)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": false,
    "baseUrl": ".",
    "paths": {
      "@renderer/*": ["electron/renderer/src/*"]
    }
  },
  "include": ["electron/renderer/src/**/*", "electron/renderer/**/*.ts", "electron/renderer/**/*.tsx"]
}
```

- [ ] **Step 3: Create `tsconfig.node.json` (main + preload)**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "@main/*": ["electron/main/*"]
    }
  },
  "include": ["electron/main/**/*", "electron/preload/**/*"]
}
```

- [ ] **Step 4: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'electron/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@renderer': path.resolve(__dirname, 'electron/renderer/src') },
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
```

- [ ] **Step 5: Create `electron/main/index.ts`**

```ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafaf9',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    await win.loadURL('http://localhost:5173');
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
```

- [ ] **Step 6: Create `electron/preload/index.ts`**

```ts
import { contextBridge } from 'electron';

// Placeholder — real API exposed in Phase 10 (IPC).
contextBridge.exposeInMainWorld('api', { ping: () => 'pong' });
```

- [ ] **Step 7: Create `electron/renderer/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MeetingNotes</title>
  </head>
  <body class="bg-stone-50">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Create `electron/renderer/src/main.tsx`**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');
createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);
```

- [ ] **Step 9: Create `electron/renderer/src/App.tsx`**

```tsx
export function App(): JSX.Element {
  return (
    <main className="min-h-screen flex items-center justify-center text-stone-900">
      <h1 className="text-2xl font-semibold">MeetingNotes — coming online…</h1>
    </main>
  );
}
```

- [ ] **Step 10: Install dependencies**

Run: `npm install`
Expected: exits 0, `node_modules/` created, no peer-dep errors.

- [ ] **Step 11: Verify main process compiles and renderer serves**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: exits 0 with no output.

Run: `npx vite build`
Expected: "built in …ms" and `dist/renderer/index.html` exists.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig*.json vite.config.ts electron/
git commit -m "scaffold: Electron + Vite + TypeScript + React project"
```

---

### Task 2: Add Tailwind CSS (Clean Studio theme)

**Files:**
- Create: `tailwind.config.js`, `postcss.config.js`, `electron/renderer/src/index.css`, `electron/renderer/src/theme/tokens.ts`

- [ ] **Step 1: Create `tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./electron/renderer/index.html', './electron/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#1c1917', soft: '#44403c', muted: '#78716c' },
        surface: { DEFAULT: '#ffffff', sunken: '#fafaf9', border: '#e7e5e4' },
        brand: {
          indigo: '#6366f1',
          violet: '#8b5cf6',
          gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
        },
        status: {
          ok: '#16a34a',
          okBg: '#dcfce7',
          warn: '#f59e0b',
          warnBg: '#fef3c7',
          warnText: '#92400e',
          processing: '#6366f1',
          processingBg: '#e0e7ff',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.08)',
        pop: '0 10px 40px rgba(0,0,0,0.08)',
      },
      borderRadius: { xl: '14px' },
    },
  },
  plugins: [],
};
```

- [ ] **Step 2: Create `postcss.config.js`**

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 3: Create `electron/renderer/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body { font-family: theme('fontFamily.sans'); color: theme('colors.ink.DEFAULT'); background: theme('colors.surface.sunken'); }
```

- [ ] **Step 4: Create `electron/renderer/src/theme/tokens.ts`**

```ts
export const tokens = {
  indigo: '#6366f1',
  violet: '#8b5cf6',
  gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
  amber: '#f59e0b',
  amberBg: '#fef3c7',
  amberText: '#92400e',
  okGreen: '#16a34a',
  speakerPalette: ['#6366f1', '#8b5cf6', '#ec4899', '#0ea5e9', '#22c55e', '#f97316'],
} as const;

export function colorForSpeakerIndex(idx: number): string {
  return tokens.speakerPalette[idx % tokens.speakerPalette.length]!;
}
```

- [ ] **Step 5: Verify build**

Run: `npx vite build`
Expected: "built in …ms"; inspect `dist/renderer/assets/*.css` contains Tailwind reset classes.

- [ ] **Step 6: Commit**

```bash
git add tailwind.config.js postcss.config.js electron/renderer/src/index.css electron/renderer/src/theme/tokens.ts
git commit -m "style: add Tailwind with Clean Studio theme tokens"
```

---

### Task 3: Add Vitest test infrastructure

**Files:**
- Create: `vitest.config.ts`, `electron/main/lib/.keep`, `electron/main/lib/sanity.test.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['electron/**/*.test.ts', 'electron/**/*.test.tsx'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'electron/main'),
      '@renderer': path.resolve(__dirname, 'electron/renderer/src'),
    },
  },
});
```

- [ ] **Step 2: Write `electron/main/lib/sanity.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts electron/main/lib/sanity.test.ts
git commit -m "test: add Vitest configuration and sanity test"
```

---

### Task 4: Add ESLint + Prettier

**Files:**
- Create: `.eslintrc.cjs`, `.prettierrc`, `.eslintignore`, `.prettierignore`

- [ ] **Step 1: Create `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
  },
};
```

- [ ] **Step 2: Create `.prettierrc`**

```json
{ "singleQuote": true, "semi": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 3: Create `.eslintignore` and `.prettierignore`**

`.eslintignore`:
```
dist
node_modules
mockups
.superpowers
```

`.prettierignore`:
```
dist
node_modules
mockups
.superpowers
package-lock.json
```

- [ ] **Step 4: Verify lint + format run clean**

Run: `npm run lint`
Expected: exit 0 (no violations).

Run: `npx prettier --check .`
Expected: "All matched files use Prettier code style!"

- [ ] **Step 5: Commit**

```bash
git add .eslintrc.cjs .prettierrc .eslintignore .prettierignore
git commit -m "tooling: add ESLint + Prettier"
```

---

## PHASE 2: Pure-Function Libraries

These are side-effect-free utilities consumed by storage, pipeline, and UI. TDD-first; each is tiny.

### Task 5: Slug generator

**Files:**
- Create: `electron/main/lib/slug.ts`, `electron/main/lib/slug.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// electron/main/lib/slug.test.ts
import { describe, it, expect } from 'vitest';
import { makeSlug, shortId } from './slug';

describe('makeSlug', () => {
  it('combines date, kebab title, and short id', () => {
    expect(makeSlug('2026-04-17', 'Q2 Planning', 'a3f8')).toBe('2026-04-17-q2-planning-a3f8');
  });
  it('strips punctuation and lowercases', () => {
    expect(makeSlug('2026-04-17', "Sarah's 1:1!", 'xyz1')).toBe('2026-04-17-sarahs-1-1-xyz1');
  });
  it('collapses multiple spaces/dashes', () => {
    expect(makeSlug('2026-04-17', '  Product — Sync  ', 'z9')).toBe('2026-04-17-product-sync-z9');
  });
  it('truncates very long titles', () => {
    const long = 'a'.repeat(100);
    const out = makeSlug('2026-04-17', long, 'id1');
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('-id1')).toBe(true);
  });
});

describe('shortId', () => {
  it('returns 4 lowercase alphanumeric chars', () => {
    const id = shortId();
    expect(id).toMatch(/^[a-z0-9]{4}$/);
  });
  it('is reasonably unique across calls', () => {
    const set = new Set(Array.from({ length: 500 }, () => shortId()));
    expect(set.size).toBeGreaterThan(490);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- slug`
Expected: FAIL — cannot find `./slug`.

- [ ] **Step 3: Implement `electron/main/lib/slug.ts`**

```ts
const MAX_SLUG_LEN = 80;

export function makeSlug(dateIso: string, title: string, id: string): string {
  const kebab = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `${dateIso}-${kebab}`;
  const room = MAX_SLUG_LEN - id.length - 1;
  const trimmed = base.length > room ? base.slice(0, room).replace(/-+$/, '') : base;
  return `${trimmed}-${id}`;
}

export function shortId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- slug`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/slug.ts electron/main/lib/slug.test.ts
git commit -m "lib: add slug + shortId generators"
```

---

### Task 6: Filename → title parser

**Files:**
- Create: `electron/main/lib/title-from-filename.ts`, `electron/main/lib/title-from-filename.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseAudioHijackFilename } from './title-from-filename';

describe('parseAudioHijackFilename', () => {
  it('extracts ISO date and title from AH default format', () => {
    const r = parseAudioHijackFilename('Session 2026-04-17 14.32.mp3');
    expect(r.startedAtIso).toBe('2026-04-17T14:32:00');
    expect(r.autoTitle).toBe('Session');
  });
  it('handles session names with spaces', () => {
    const r = parseAudioHijackFilename('Q2 Planning 2026-04-17 09.05.mp3');
    expect(r.startedAtIso).toBe('2026-04-17T09:05:00');
    expect(r.autoTitle).toBe('Q2 Planning');
  });
  it('falls back when format is unexpected', () => {
    const r = parseAudioHijackFilename('random-recording.mp3');
    expect(r.autoTitle).toBe('random-recording');
    expect(r.startedAtIso).toBeNull();
  });
  it('accepts full absolute paths', () => {
    const r = parseAudioHijackFilename('/Users/x/Music/Audio Hijack/Session 2026-04-17 14.32.mp3');
    expect(r.autoTitle).toBe('Session');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- title-from-filename`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// electron/main/lib/title-from-filename.ts
import path from 'node:path';

const AH_REGEX = /^(.+?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2})\.(\d{2})$/;

export interface ParsedFilename {
  autoTitle: string;
  startedAtIso: string | null;
}

export function parseAudioHijackFilename(filename: string): ParsedFilename {
  const base = path.basename(filename).replace(/\.[^.]+$/, '');
  const m = base.match(AH_REGEX);
  if (!m) return { autoTitle: base, startedAtIso: null };
  const [, title, date, hh, mm] = m;
  return { autoTitle: title!.trim(), startedAtIso: `${date}T${hh}:${mm}:00` };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- title-from-filename`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/title-from-filename.ts electron/main/lib/title-from-filename.test.ts
git commit -m "lib: parse Audio Hijack filenames into title + started-at"
```

---

### Task 7: Cosine similarity utility

**Files:**
- Create: `electron/main/lib/cosine.ts`, `electron/main/lib/cosine.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { cosineSimilarity, normalize } from './cosine';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 6);
  });
  it('throws on mismatched length', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(/length/i);
  });
  it('throws on zero vector', () => {
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow(/zero/i);
  });
});

describe('normalize', () => {
  it('makes the vector unit length', () => {
    const u = normalize([3, 4]);
    expect(Math.hypot(...u)).toBeCloseTo(1, 6);
    expect(u[0]!).toBeCloseTo(0.6, 6);
    expect(u[1]!).toBeCloseTo(0.8, 6);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- cosine`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// electron/main/lib/cosine.ts
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) throw new Error('cannot compute cosine for zero vector');
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function normalize(v: readonly number[]): number[] {
  const n = Math.hypot(...v);
  if (n === 0) throw new Error('cannot normalize zero vector');
  return v.map((x) => x / n);
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- cosine`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/cosine.ts electron/main/lib/cosine.test.ts
git commit -m "lib: cosine similarity + vector normalize"
```

---

### Task 8: Transcript/diarization merger

**Files:**
- Create: `electron/main/lib/merge-transcript.ts`, `electron/main/lib/merge-transcript.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mergeTranscriptWithDiarization, mergedToMarkdown,
  type WhisperSegment, type DiarSegment } from './merge-transcript';

const whisper: WhisperSegment[] = [
  { start: 0.0, end: 2.0, text: 'Hello there.' },
  { start: 2.0, end: 5.0, text: 'General Kenobi.' },
  { start: 5.0, end: 7.5, text: 'You are a bold one.' },
];
const diar: DiarSegment[] = [
  { start: 0.0, end: 2.2, speaker: 'SPEAKER_00' },
  { start: 2.2, end: 5.1, speaker: 'SPEAKER_01' },
  { start: 5.1, end: 8.0, speaker: 'SPEAKER_00' },
];

describe('mergeTranscriptWithDiarization', () => {
  it('assigns each whisper segment to the speaker whose diar segment overlaps most', () => {
    expect(mergeTranscriptWithDiarization(whisper, diar)).toEqual([
      { start: 0.0, end: 2.0, speaker: 'SPEAKER_00', text: 'Hello there.' },
      { start: 2.0, end: 5.0, speaker: 'SPEAKER_01', text: 'General Kenobi.' },
      { start: 5.0, end: 7.5, speaker: 'SPEAKER_00', text: 'You are a bold one.' },
    ]);
  });

  it('labels UNKNOWN when no diar segment overlaps', () => {
    const out = mergeTranscriptWithDiarization(
      [{ start: 10, end: 11, text: 'lone' }], diar,
    );
    expect(out[0]!.speaker).toBe('UNKNOWN');
  });
});

describe('mergedToMarkdown', () => {
  it('renders with mm:ss timestamps', () => {
    const md = mergedToMarkdown(mergeTranscriptWithDiarization(whisper, diar));
    expect(md).toContain('[SPEAKER_00 00:00] Hello there.');
    expect(md).toContain('[SPEAKER_01 00:02] General Kenobi.');
    expect(md.split('\n')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- merge-transcript`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// electron/main/lib/merge-transcript.ts
export interface WhisperSegment { start: number; end: number; text: string; }
export interface DiarSegment { start: number; end: number; speaker: string; }
export interface MergedSegment extends WhisperSegment { speaker: string; }

function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function mergeTranscriptWithDiarization(
  whisper: readonly WhisperSegment[],
  diar: readonly DiarSegment[],
): MergedSegment[] {
  return whisper.map((w) => {
    let best: DiarSegment | null = null;
    let bestOverlap = 0;
    for (const d of diar) {
      const o = overlap(w, d);
      if (o > bestOverlap) { bestOverlap = o; best = d; }
    }
    return { ...w, speaker: best ? best.speaker : 'UNKNOWN' };
  });
}

export function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function mergedToMarkdown(merged: readonly MergedSegment[]): string {
  return merged.map((s) => `[${s.speaker} ${formatTimestamp(s.start)}] ${s.text}`).join('\n');
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- merge-transcript`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/merge-transcript.ts electron/main/lib/merge-transcript.test.ts
git commit -m "lib: merge Whisper segments with pyannote diarization"
```

---

### Task 9: Stage machine

**Files:**
- Create: `electron/main/lib/stage-machine.ts`, `electron/main/lib/stage-machine.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  STAGES, nextStage, previousCompletedOnCrash, downstreamOf, isValidTransition,
} from './stage-machine';

describe('stage-machine', () => {
  it('lists stages in canonical order', () => {
    expect(STAGES).toEqual([
      'discovered', 'transcribing', 'diarizing', 'merging',
      'identifying', 'summarizing', 'extracting', 'done',
    ]);
  });

  it('nextStage advances one step; null at done', () => {
    expect(nextStage('discovered')).toBe('transcribing');
    expect(nextStage('extracting')).toBe('done');
    expect(nextStage('done')).toBeNull();
  });

  it('isValidTransition allows forward single-step only (+ restart from any stage)', () => {
    expect(isValidTransition('discovered', 'transcribing')).toBe(true);
    expect(isValidTransition('discovered', 'merging')).toBe(false);
    expect(isValidTransition('done', 'transcribing')).toBe(true);
  });

  it('previousCompletedOnCrash returns the stage to restart at after an interrupted run', () => {
    // transcribing + diarizing run in parallel from discovered; either crash means re-run both
    expect(previousCompletedOnCrash('transcribing')).toBe('discovered');
    expect(previousCompletedOnCrash('diarizing')).toBe('discovered');
    // Other stages re-run themselves (they are fully recomputable from prior artifacts)
    expect(previousCompletedOnCrash('merging')).toBe('merging');
    expect(previousCompletedOnCrash('summarizing')).toBe('summarizing');
    expect(previousCompletedOnCrash('done')).toBe('done');
    expect(previousCompletedOnCrash('discovered')).toBe('discovered');
  });

  it('downstreamOf returns all stages after a given one', () => {
    expect(downstreamOf('merging')).toEqual(['identifying', 'summarizing', 'extracting', 'done']);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- stage-machine`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/lib/stage-machine.ts
export const STAGES = [
  'discovered', 'transcribing', 'diarizing', 'merging',
  'identifying', 'summarizing', 'extracting', 'done',
] as const;
export type Stage = (typeof STAGES)[number];

export function nextStage(s: Stage): Stage | null {
  const i = STAGES.indexOf(s);
  if (i < 0 || i === STAGES.length - 1) return null;
  return STAGES[i + 1]!;
}

export function isValidTransition(from: Stage, to: Stage): boolean {
  const fi = STAGES.indexOf(from);
  const ti = STAGES.indexOf(to);
  if (fi < 0 || ti < 0) return false;
  if (ti <= fi) return true;
  return ti === fi + 1;
}

export function previousCompletedOnCrash(stage: Stage): Stage {
  // transcribing + diarizing run in parallel from 'discovered' — if either was
  // interrupted, safest is to re-run both by rolling back to 'discovered'.
  if (stage === 'transcribing' || stage === 'diarizing') return 'discovered';
  // Other stages are fully recomputable from their inputs and can re-run themselves.
  return stage;
}

export function downstreamOf(stage: Stage): Stage[] {
  const i = STAGES.indexOf(stage);
  return STAGES.slice(i + 1) as Stage[];
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- stage-machine`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/stage-machine.ts electron/main/lib/stage-machine.test.ts
git commit -m "lib: pipeline stage machine"
```

---

### Task 10: Action-item schema (zod) + lenient parser

**Files:**
- Create: `electron/main/lib/action-item-schema.ts`, `electron/main/lib/action-item-schema.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { ActionItemSchema, parseActionItemsLoose } from './action-item-schema';

describe('ActionItemSchema', () => {
  it('accepts a full item', () => {
    const v = ActionItemSchema.parse({ text: 'do X', owner: 'Dan', due_date: '2026-04-22' });
    expect(v.text).toBe('do X');
  });
  it('accepts nulls for owner / due_date', () => {
    const v = ActionItemSchema.parse({ text: 'follow up', owner: null, due_date: null });
    expect(v.owner).toBeNull();
  });
  it('rejects empty text', () => {
    expect(() => ActionItemSchema.parse({ text: '', owner: null, due_date: null })).toThrow();
  });
});

describe('parseActionItemsLoose', () => {
  it('extracts a JSON array from messy LLM output', () => {
    const raw = 'Sure:\n```json\n[{"text":"a","owner":null,"due_date":null}]\n```\nCheers!';
    expect(parseActionItemsLoose(raw)).toHaveLength(1);
  });
  it('returns [] when no JSON array is present', () => {
    expect(parseActionItemsLoose('no items today')).toEqual([]);
  });
  it('discards invalid items but keeps valid ones', () => {
    const raw = '[{"text":"ok","owner":null,"due_date":null},{"owner":"Dan"}]';
    expect(parseActionItemsLoose(raw)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- action-item-schema`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/lib/action-item-schema.ts
import { z } from 'zod';

export const ActionItemSchema = z.object({
  text: z.string().min(1),
  owner: z.string().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type ActionItem = z.infer<typeof ActionItemSchema>;

export const ActionItemsArraySchema = z.array(ActionItemSchema);

export function parseActionItemsLoose(raw: string): ActionItem[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: ActionItem[] = [];
  for (const item of parsed) {
    const r = ActionItemSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- action-item-schema`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lib/action-item-schema.ts electron/main/lib/action-item-schema.test.ts
git commit -m "lib: action-item zod schema + lenient LLM parser"
```

---

## PHASE 3: Storage Layer

SQLite index + filesystem artifacts. Every write goes through a repo; the filesystem is authoritative.

### Task 11: SQLite migrations

**Files:**
- Create: `electron/main/storage/db.ts`, `electron/main/storage/migrations.ts`, `electron/main/storage/db.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// electron/main/storage/db.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from './db';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mn-db-'));
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('openDb', () => {
  it('creates schema with expected tables', () => {
    const dir = tmp(); dirs.push(dir);
    const db = openDb(path.join(dir, 'db.sqlite'));
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'meetings', 'speakers', 'meeting_speakers', 'action_items', 'settings', 'schema_version',
    ]));
  });

  it('is idempotent (running twice keeps version)', () => {
    const dir = tmp(); dirs.push(dir);
    const dbPath = path.join(dir, 'db.sqlite');
    openDb(dbPath).close();
    const db = openDb(dbPath);
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- storage/db`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement migrations**

```ts
// electron/main/storage/migrations.ts
import type Database from 'better-sqlite3';

interface Migration { version: number; up: string; }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (0);

      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        started_at TEXT,
        duration_s INTEGER,
        audio_path TEXT NOT NULL,
        status TEXT NOT NULL,
        pipeline_stage TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_meetings_stage ON meetings(pipeline_stage);
      CREATE INDEX idx_meetings_started ON meetings(started_at);

      CREATE TABLE speakers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        notes TEXT
      );

      CREATE TABLE meeting_speakers (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        local_label TEXT NOT NULL,
        roster_speaker_id TEXT REFERENCES speakers(id),
        confidence REAL,
        PRIMARY KEY (meeting_id, local_label)
      );

      CREATE TABLE action_items (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        owner_speaker_id TEXT REFERENCES speakers(id),
        due_date TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        exported_to TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec('BEGIN');
      try {
        db.exec(m.up);
        db.prepare('UPDATE schema_version SET version = ?').run(m.version);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  }
}
```

- [ ] **Step 4: Implement db wrapper**

```ts
// electron/main/storage/db.ts
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import path from 'node:path';
import fs from 'node:fs';

export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
```

- [ ] **Step 5: Run, expect pass**

Run: `npm test -- storage/db`
Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add electron/main/storage/db.ts electron/main/storage/migrations.ts electron/main/storage/db.test.ts
git commit -m "storage: SQLite schema with versioned migrations"
```

---

### Task 12: Meeting folder helper

**Files:**
- Create: `electron/main/storage/meeting-folder.ts`, `electron/main/storage/meeting-folder.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMeetingFolder, readMeetingJson, writeMeetingJson, type MeetingRecord } from './meeting-folder';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mn-folder-'));
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('createMeetingFolder', () => {
  it('creates folder and symlinks audio', () => {
    const root = tmp(); dirs.push(root);
    const audio = path.join(root, 'source.mp3');
    fs.writeFileSync(audio, Buffer.from('x'));
    const folder = createMeetingFolder(root, '2026-04-17-test-abc1', audio);
    expect(fs.existsSync(folder)).toBe(true);
    const stat = fs.lstatSync(path.join(folder, 'audio.mp3'));
    expect(stat.isSymbolicLink()).toBe(true);
  });
});

describe('read/writeMeetingJson', () => {
  it('round-trips a meeting record', () => {
    const root = tmp(); dirs.push(root);
    const audio = path.join(root, 'a.mp3');
    fs.writeFileSync(audio, Buffer.from('x'));
    const folder = createMeetingFolder(root, '2026-04-17-t-xyz1', audio);
    const rec: MeetingRecord = {
      id: 'xyz1', slug: '2026-04-17-t-xyz1', title: 'T',
      startedAt: null, durationS: null, audioPath: audio,
      pipelineStage: 'discovered', speakers: [], models: {},
    };
    writeMeetingJson(folder, rec);
    expect(readMeetingJson(folder)).toEqual(rec);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- meeting-folder`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/storage/meeting-folder.ts
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const MeetingRecordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  startedAt: z.string().nullable(),
  durationS: z.number().nullable(),
  audioPath: z.string(),
  pipelineStage: z.string(),
  speakers: z.array(z.object({
    label: z.string(),
    rosterId: z.string().nullable(),
    confidence: z.number().nullable(),
  })),
  models: z.record(z.string(), z.string()),
});
export type MeetingRecord = z.infer<typeof MeetingRecordSchema>;

export function meetingFolderPath(root: string, slug: string): string {
  return path.join(root, 'meetings', slug);
}

export function createMeetingFolder(root: string, slug: string, audioPath: string): string {
  const folder = meetingFolderPath(root, slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(folder, 'exports'), { recursive: true });
  const link = path.join(folder, 'audio.mp3');
  if (!fs.existsSync(link)) fs.symlinkSync(audioPath, link);
  return folder;
}

export function writeMeetingJson(folder: string, rec: MeetingRecord): void {
  fs.writeFileSync(path.join(folder, 'meeting.json'), JSON.stringify(rec, null, 2));
}

export function readMeetingJson(folder: string): MeetingRecord {
  const raw = fs.readFileSync(path.join(folder, 'meeting.json'), 'utf8');
  return MeetingRecordSchema.parse(JSON.parse(raw));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- meeting-folder`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/meeting-folder.ts electron/main/storage/meeting-folder.test.ts
git commit -m "storage: meeting folder creator + meeting.json reader/writer"
```

---

### Task 13: Meetings repository

**Files:**
- Create: `electron/main/storage/meetings-repo.ts`, `electron/main/storage/meetings-repo.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { MeetingsRepo } from './meetings-repo';

let repo: MeetingsRepo;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rm-'));
  repo = new MeetingsRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('MeetingsRepo', () => {
  it('insert + findById round-trips', () => {
    repo.insert({
      id: 'a3f8', slug: '2026-04-17-q2-a3f8', title: 'Q2',
      startedAt: '2026-04-17T14:32:00', durationS: 2341,
      audioPath: '/x/a.mp3', status: 'processing', pipelineStage: 'transcribing',
    });
    const got = repo.findById('a3f8');
    expect(got?.title).toBe('Q2');
    expect(got?.pipelineStage).toBe('transcribing');
  });

  it('updateStage updates pipeline_stage and updated_at', () => {
    repo.insert({ id: 'x', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/a', status: 'processing', pipelineStage: 'discovered' });
    repo.updateStage('x', 'transcribing');
    expect(repo.findById('x')?.pipelineStage).toBe('transcribing');
  });

  it('listAll returns newest first', () => {
    repo.insert({ id: 'a', slug: 'a', title: 'A', startedAt: '2026-04-16', durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
    repo.insert({ id: 'b', slug: 'b', title: 'B', startedAt: '2026-04-17', durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });
    expect(repo.listAll().map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('findNonTerminal returns meetings not in `done`', () => {
    repo.insert({ id: 'a', slug: 'a', title: 'A', startedAt: null, durationS: null, audioPath: '/a', status: 'processing', pipelineStage: 'transcribing' });
    repo.insert({ id: 'b', slug: 'b', title: 'B', startedAt: null, durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });
    expect(repo.findNonTerminal().map((m) => m.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- meetings-repo`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/storage/meetings-repo.ts
import type Database from 'better-sqlite3';

export interface MeetingRow {
  id: string; slug: string; title: string;
  startedAt: string | null; durationS: number | null;
  audioPath: string; status: string; pipelineStage: string;
  createdAt: string; updatedAt: string;
}

export interface MeetingInsert {
  id: string; slug: string; title: string;
  startedAt: string | null; durationS: number | null;
  audioPath: string; status: string; pipelineStage: string;
}

function rowToMeeting(r: Record<string, unknown>): MeetingRow {
  return {
    id: r.id as string,
    slug: r.slug as string,
    title: r.title as string,
    startedAt: (r.started_at as string) ?? null,
    durationS: (r.duration_s as number) ?? null,
    audioPath: r.audio_path as string,
    status: r.status as string,
    pipelineStage: r.pipeline_stage as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export class MeetingsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(m: MeetingInsert): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO meetings (id, slug, title, started_at, duration_s, audio_path, status, pipeline_stage, created_at, updated_at)
      VALUES (@id, @slug, @title, @startedAt, @durationS, @audioPath, @status, @pipelineStage, @createdAt, @updatedAt)
    `).run({ ...m, createdAt: now, updatedAt: now });
  }

  findById(id: string): MeetingRow | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToMeeting(row) : null;
  }

  listAll(): MeetingRow[] {
    const rows = this.db.prepare('SELECT * FROM meetings ORDER BY COALESCE(started_at, created_at) DESC').all() as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  findNonTerminal(): MeetingRow[] {
    const rows = this.db.prepare("SELECT * FROM meetings WHERE pipeline_stage != 'done'").all() as Record<string, unknown>[];
    return rows.map(rowToMeeting);
  }

  updateStage(id: string, stage: string): void {
    this.db.prepare('UPDATE meetings SET pipeline_stage = ?, updated_at = ? WHERE id = ?')
      .run(stage, new Date().toISOString(), id);
  }

  updateTitle(id: string, title: string): void {
    this.db.prepare('UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, new Date().toISOString(), id);
  }

  updateStatus(id: string, status: string): void {
    this.db.prepare('UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  updateDuration(id: string, durationS: number): void {
    this.db.prepare('UPDATE meetings SET duration_s = ?, updated_at = ? WHERE id = ?')
      .run(durationS, new Date().toISOString(), id);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- meetings-repo`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/meetings-repo.ts electron/main/storage/meetings-repo.test.ts
git commit -m "storage: meetings repository"
```

---

### Task 14: Speakers repository

**Files:**
- Create: `electron/main/storage/speakers-repo.ts`, `electron/main/storage/speakers-repo.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { SpeakersRepo } from './speakers-repo';

let repo: SpeakersRepo;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sp-'));
  repo = new SpeakersRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('SpeakersRepo', () => {
  it('create + list', () => {
    const id = repo.create({ displayName: 'Dan B.' });
    expect(repo.list()).toEqual([expect.objectContaining({ id, displayName: 'Dan B.' })]);
  });

  it('rename', () => {
    const id = repo.create({ displayName: 'Temp' });
    repo.rename(id, 'Dan Baskette');
    expect(repo.findById(id)?.displayName).toBe('Dan Baskette');
  });

  it('delete', () => {
    const id = repo.create({ displayName: 'Gone' });
    repo.delete(id);
    expect(repo.findById(id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- speakers-repo`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/storage/speakers-repo.ts
import type Database from 'better-sqlite3';
import { shortId } from '../lib/slug';

export interface SpeakerRow { id: string; displayName: string; createdAt: string; notes: string | null; }

function row(r: Record<string, unknown>): SpeakerRow {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    createdAt: r.created_at as string,
    notes: (r.notes as string) ?? null,
  };
}

export class SpeakersRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: { displayName: string; notes?: string }): string {
    const id = `spk_${shortId()}`;
    this.db.prepare('INSERT INTO speakers (id, display_name, created_at, notes) VALUES (?, ?, ?, ?)')
      .run(id, input.displayName, new Date().toISOString(), input.notes ?? null);
    return id;
  }

  findById(id: string): SpeakerRow | null {
    const r = this.db.prepare('SELECT * FROM speakers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? row(r) : null;
  }

  list(): SpeakerRow[] {
    const rows = this.db.prepare('SELECT * FROM speakers ORDER BY display_name').all() as Record<string, unknown>[];
    return rows.map(row);
  }

  rename(id: string, displayName: string): void {
    this.db.prepare('UPDATE speakers SET display_name = ? WHERE id = ?').run(displayName, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM speakers WHERE id = ?').run(id);
  }

  linkToMeeting(meetingId: string, localLabel: string, rosterId: string, confidence: number): void {
    this.db.prepare(`
      INSERT INTO meeting_speakers (meeting_id, local_label, roster_speaker_id, confidence)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(meeting_id, local_label) DO UPDATE SET
        roster_speaker_id = excluded.roster_speaker_id,
        confidence = excluded.confidence
    `).run(meetingId, localLabel, rosterId, confidence);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- speakers-repo`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/speakers-repo.ts electron/main/storage/speakers-repo.test.ts
git commit -m "storage: speakers repository"
```

---

### Task 15: Action items repository

**Files:**
- Create: `electron/main/storage/action-items-repo.ts`, `electron/main/storage/action-items-repo.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { MeetingsRepo } from './meetings-repo';
import { ActionItemsRepo } from './action-items-repo';

let repo: ActionItemsRepo;
let meetings: MeetingsRepo;
let meetingId: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-ai-'));
  const db = openDb(path.join(dir, 'db.sqlite'));
  meetings = new MeetingsRepo(db);
  repo = new ActionItemsRepo(db);
  meetingId = 'm1';
  meetings.insert({ id: meetingId, slug: 's', title: 't', startedAt: null, durationS: null, audioPath: '/a', status: 'done', pipelineStage: 'done' });
});

describe('ActionItemsRepo', () => {
  it('replace + listByMeeting', () => {
    repo.replaceForMeeting(meetingId, [
      { text: 'a', owner: null, due_date: null },
      { text: 'b', owner: 'Dan', due_date: '2026-04-22' },
    ]);
    const all = repo.listByMeeting(meetingId);
    expect(all).toHaveLength(2);
    expect(all[0]!.text).toBe('a');
  });

  it('setStatus', () => {
    repo.replaceForMeeting(meetingId, [{ text: 'x', owner: null, due_date: null }]);
    const [item] = repo.listByMeeting(meetingId);
    repo.setStatus(item!.id, 'done');
    expect(repo.listByMeeting(meetingId)[0]!.status).toBe('done');
  });

  it('markExported appends to exported_to JSON', () => {
    repo.replaceForMeeting(meetingId, [{ text: 'x', owner: null, due_date: null }]);
    const [item] = repo.listByMeeting(meetingId);
    repo.markExported(item!.id, 'reminders');
    expect(repo.listByMeeting(meetingId)[0]!.exportedTo).toEqual(['reminders']);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- action-items-repo`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/storage/action-items-repo.ts
import type Database from 'better-sqlite3';
import { shortId } from '../lib/slug';
import type { ActionItem } from '../lib/action-item-schema';

export interface ActionItemRow {
  id: string; meetingId: string; text: string;
  ownerSpeakerId: string | null; dueDate: string | null;
  status: string; exportedTo: string[]; createdAt: string;
}

function row(r: Record<string, unknown>): ActionItemRow {
  return {
    id: r.id as string,
    meetingId: r.meeting_id as string,
    text: r.text as string,
    ownerSpeakerId: (r.owner_speaker_id as string) ?? null,
    dueDate: (r.due_date as string) ?? null,
    status: r.status as string,
    exportedTo: JSON.parse((r.exported_to as string) || '[]'),
    createdAt: r.created_at as string,
  };
}

export class ActionItemsRepo {
  constructor(private readonly db: Database.Database) {}

  replaceForMeeting(meetingId: string, items: readonly ActionItem[]): void {
    const del = this.db.prepare('DELETE FROM action_items WHERE meeting_id = ?');
    const ins = this.db.prepare(`
      INSERT INTO action_items (id, meeting_id, text, owner_speaker_id, due_date, status, exported_to, created_at)
      VALUES (?, ?, ?, NULL, ?, 'open', '[]', ?)
    `);
    const tx = this.db.transaction(() => {
      del.run(meetingId);
      const now = new Date().toISOString();
      for (const it of items) ins.run(`ai_${shortId()}`, meetingId, it.text, it.due_date, now);
    });
    tx();
  }

  listByMeeting(meetingId: string): ActionItemRow[] {
    const rows = this.db.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at').all(meetingId) as Record<string, unknown>[];
    return rows.map(row);
  }

  setStatus(id: string, status: string): void {
    this.db.prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, id);
  }

  markExported(id: string, target: string): void {
    const r = this.db.prepare('SELECT exported_to FROM action_items WHERE id = ?').get(id) as { exported_to: string } | undefined;
    if (!r) return;
    const list: string[] = JSON.parse(r.exported_to || '[]');
    if (!list.includes(target)) list.push(target);
    this.db.prepare('UPDATE action_items SET exported_to = ? WHERE id = ?').run(JSON.stringify(list), id);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- action-items-repo`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/action-items-repo.ts electron/main/storage/action-items-repo.test.ts
git commit -m "storage: action items repository"
```

---

### Task 16: Settings repository

**Files:**
- Create: `electron/main/storage/settings-repo.ts`, `electron/main/storage/settings-repo.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { SettingsRepo, DEFAULT_SETTINGS } from './settings-repo';

let repo: SettingsRepo;
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-set-'));
  repo = new SettingsRepo(openDb(path.join(dir, 'db.sqlite')));
});

describe('SettingsRepo', () => {
  it('falls back to defaults when unset', () => {
    expect(repo.get('lmStudioUrl')).toBe(DEFAULT_SETTINGS.lmStudioUrl);
  });
  it('set + get round-trips', () => {
    repo.set('sttModel', 'whisper-large-v3');
    expect(repo.get('sttModel')).toBe('whisper-large-v3');
  });
  it('getAll returns merged defaults + overrides', () => {
    repo.set('sttModel', 'x');
    const all = repo.getAll();
    expect(all.sttModel).toBe('x');
    expect(all.lmStudioUrl).toBe(DEFAULT_SETTINGS.lmStudioUrl);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- settings-repo`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/storage/settings-repo.ts
import type Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

export interface Settings {
  lmStudioUrl: string;
  sttModel: string;
  llmModel: string;
  audioHijackSessionName: string;
  libraryPath: string;
  audioWatchPath: string;
  sttLanguage: string;
  exporterApple: boolean;
  exporterMarkdown: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  lmStudioUrl: 'http://localhost:1234',
  sttModel: '',
  llmModel: '',
  audioHijackSessionName: 'Meeting',
  libraryPath: path.join(os.homedir(), 'Documents', 'MeetingNotes'),
  audioWatchPath: path.join(os.homedir(), 'Music', 'Audio Hijack'),
  sttLanguage: 'en',
  exporterApple: true,
  exporterMarkdown: true,
};

type Key = keyof Settings;

export class SettingsRepo {
  constructor(private readonly db: Database.Database) {}

  get<K extends Key>(key: K): Settings[K] {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!r) return DEFAULT_SETTINGS[key];
    return JSON.parse(r.value) as Settings[K];
  }

  set<K extends Key>(key: K, value: Settings[K]): void {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  }

  getAll(): Settings {
    const out = { ...DEFAULT_SETTINGS };
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const { key, value } of rows) {
      if (key in DEFAULT_SETTINGS) {
        (out as Record<string, unknown>)[key] = JSON.parse(value);
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- settings-repo`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/storage/settings-repo.ts electron/main/storage/settings-repo.test.ts
git commit -m "storage: settings repository with defaults"
```

---

### Task 17: Logger

**Files:**
- Create: `electron/main/logging/logger.ts`, `electron/main/logging/logger.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from './logger';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('Logger', () => {
  it('writes newline-delimited JSON with level, msg, ts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-log-')); dirs.push(dir);
    const log = new Logger(path.join(dir, 'app.log'));
    log.info('hello', { k: 1 });
    log.error('bad', { e: 'boom' });
    log.close();
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    expect(a.level).toBe('info');
    expect(a.msg).toBe('hello');
    expect(a.k).toBe(1);
    expect(typeof a.ts).toBe('string');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npm test -- logging/logger`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/logging/logger.ts
import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private stream: fs.WriteStream;
  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }
  private write(level: Level, msg: string, data?: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), level, msg, ...(data ?? {}) };
    this.stream.write(JSON.stringify(entry) + '\n');
  }
  debug(msg: string, data?: Record<string, unknown>): void { this.write('debug', msg, data); }
  info(msg: string, data?: Record<string, unknown>): void { this.write('info', msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void { this.write('warn', msg, data); }
  error(msg: string, data?: Record<string, unknown>): void { this.write('error', msg, data); }
  close(): void { this.stream.end(); }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- logging/logger`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/logging/logger.ts electron/main/logging/logger.test.ts
git commit -m "logging: JSON-lines logger"
```

---

## PHASE 4: Python Diarization Sidecar

FastAPI service that receives an audio path and returns pyannote speaker-labeled segments with 512-dim embeddings. This is the **only** service that touches pyannote; the Node side just calls HTTP.

### Task 18: Sidecar skeleton (pyproject + install script)

**Files:**
- Create: `sidecar/pyproject.toml`, `sidecar/meeting_notes_diarize/__init__.py`, `sidecar/scripts/install.sh`, `sidecar/README.md`

- [ ] **Step 1: Create `sidecar/pyproject.toml`**

```toml
[project]
name = "meeting-notes-diarize"
version = "0.1.0"
description = "Speaker diarization sidecar for MeetingNotes"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.110",
  "uvicorn[standard]>=0.29",
  "pyannote.audio>=3.1",
  "torch>=2.2",
  "torchaudio>=2.2",
  "pydantic>=2.6",
  "python-multipart>=0.0.9",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-asyncio>=0.23", "httpx>=0.27"]

[build-system]
requires = ["setuptools>=69", "wheel"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["."]
include = ["meeting_notes_diarize*"]
```

- [ ] **Step 2: Create `sidecar/meeting_notes_diarize/__init__.py`**

```python
__version__ = "0.1.0"
```

- [ ] **Step 3: Create `sidecar/scripts/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip
pip install -e ".[dev]"
echo "Sidecar venv ready at sidecar/.venv"
```

Make executable:
```bash
chmod +x sidecar/scripts/install.sh
```

- [ ] **Step 4: Create `sidecar/README.md`**

```markdown
# MeetingNotes Diarization Sidecar

FastAPI service that runs pyannote.audio locally.

## Setup

```bash
./scripts/install.sh
export HF_TOKEN=<your-huggingface-token>  # pyannote model download
```

## Run

```bash
source .venv/bin/activate
uvicorn meeting_notes_diarize.app:app --host 127.0.0.1 --port 8765
```

## Test

```bash
source .venv/bin/activate
pytest
```
```

- [ ] **Step 5: Commit**

```bash
git add sidecar/pyproject.toml sidecar/meeting_notes_diarize/__init__.py sidecar/scripts/install.sh sidecar/README.md
git commit -m "sidecar: pyproject + venv install script"
```

---

### Task 19: Pydantic schemas

**Files:**
- Create: `sidecar/meeting_notes_diarize/schemas.py`, `sidecar/tests/test_schemas.py`

- [ ] **Step 1: Write failing test**

```python
# sidecar/tests/test_schemas.py
import pytest
from meeting_notes_diarize.schemas import DiarizeRequest, DiarizeResponse, Segment

def test_diarize_request_requires_audio_path():
    with pytest.raises(Exception):
        DiarizeRequest()

def test_segment_validates_order():
    s = Segment(start=1.0, end=2.0, speaker="SPEAKER_00", embedding=[0.1]*512)
    assert s.end > s.start
    assert len(s.embedding) == 512

def test_response_serializes_to_json():
    r = DiarizeResponse(
        segments=[Segment(start=0, end=1, speaker="SPEAKER_00", embedding=[0.0]*512)],
        num_speakers=1,
    )
    data = r.model_dump()
    assert data["num_speakers"] == 1
```

- [ ] **Step 2: Install venv and run, expect fail**

```bash
cd sidecar && ./scripts/install.sh && source .venv/bin/activate && pytest tests/test_schemas.py
```
Expected: FAIL — `schemas` module missing.

- [ ] **Step 3: Implement `sidecar/meeting_notes_diarize/schemas.py`**

```python
from typing import List
from pydantic import BaseModel, Field, field_validator

class DiarizeRequest(BaseModel):
    audio_path: str

class Segment(BaseModel):
    start: float
    end: float
    speaker: str
    embedding: List[float] = Field(min_length=1)

    @field_validator("end")
    @classmethod
    def end_after_start(cls, v: float, info):
        if "start" in info.data and v <= info.data["start"]:
            raise ValueError("end must be > start")
        return v

class DiarizeResponse(BaseModel):
    segments: List[Segment]
    num_speakers: int
```

- [ ] **Step 4: Run, expect pass**

```bash
cd sidecar && source .venv/bin/activate && pytest tests/test_schemas.py -v
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/meeting_notes_diarize/schemas.py sidecar/tests/test_schemas.py
git commit -m "sidecar: pydantic schemas for diarize request/response"
```

---

### Task 20: Diarization wrapper (pyannote)

**Files:**
- Create: `sidecar/meeting_notes_diarize/diarize.py`, `sidecar/tests/test_diarize.py`

- [ ] **Step 1: Write test (mocked pyannote)**

```python
# sidecar/tests/test_diarize.py
from unittest.mock import MagicMock, patch
import numpy as np
from meeting_notes_diarize.diarize import diarize_audio

def make_fake_annotation():
    # Build a minimal annotation-like object
    ann = MagicMock()
    ann.itertracks.return_value = [
        (MagicMock(start=0.0, end=2.0), None, "SPEAKER_00"),
        (MagicMock(start=2.0, end=5.0), None, "SPEAKER_01"),
    ]
    return ann

@patch("meeting_notes_diarize.diarize._get_pipeline")
@patch("meeting_notes_diarize.diarize._embed_segment")
def test_diarize_audio_returns_segments_with_embeddings(mock_embed, mock_pipe):
    mock_embed.return_value = np.zeros(512, dtype=np.float32)
    pipe = MagicMock(return_value=make_fake_annotation())
    mock_pipe.return_value = pipe

    out = diarize_audio("/tmp/fake.mp3")
    assert out.num_speakers == 2
    assert len(out.segments) == 2
    assert out.segments[0].speaker == "SPEAKER_00"
    assert len(out.segments[0].embedding) == 512
```

- [ ] **Step 2: Run, expect fail**

```bash
cd sidecar && source .venv/bin/activate && pytest tests/test_diarize.py
```
Expected: FAIL — `diarize` module missing.

- [ ] **Step 3: Implement**

```python
# sidecar/meeting_notes_diarize/diarize.py
from __future__ import annotations
import os
from functools import lru_cache
from typing import List
import numpy as np
import torch
import torchaudio
from pyannote.audio import Pipeline
from pyannote.audio import Inference

from .schemas import DiarizeResponse, Segment

EMBEDDING_DIM = 512

@lru_cache(maxsize=1)
def _get_pipeline() -> Pipeline:
    token = os.environ.get("HF_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN env var required to download pyannote models")
    pipe = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
    if torch.backends.mps.is_available():
        pipe.to(torch.device("mps"))
    return pipe

@lru_cache(maxsize=1)
def _get_embedder() -> Inference:
    token = os.environ.get("HF_TOKEN")
    return Inference("pyannote/embedding", window="whole", use_auth_token=token)

def _embed_segment(audio_path: str, start: float, end: float) -> np.ndarray:
    waveform, sr = torchaudio.load(audio_path, frame_offset=int(start * 16000), num_frames=int((end - start) * 16000))
    embedder = _get_embedder()
    emb = embedder({"waveform": waveform, "sample_rate": sr})
    return np.asarray(emb, dtype=np.float32).flatten()

def diarize_audio(audio_path: str) -> DiarizeResponse:
    pipe = _get_pipeline()
    annotation = pipe(audio_path)
    segments: List[Segment] = []
    speakers: set[str] = set()
    for turn, _, label in annotation.itertracks(yield_label=True):
        emb = _embed_segment(audio_path, turn.start, turn.end)
        segments.append(Segment(
            start=float(turn.start),
            end=float(turn.end),
            speaker=str(label),
            embedding=emb.tolist(),
        ))
        speakers.add(str(label))
    return DiarizeResponse(segments=segments, num_speakers=len(speakers))
```

- [ ] **Step 4: Run, expect pass**

```bash
pytest tests/test_diarize.py -v
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add sidecar/meeting_notes_diarize/diarize.py sidecar/tests/test_diarize.py
git commit -m "sidecar: pyannote diarization wrapper with per-segment embeddings"
```

---

### Task 21: FastAPI app + /health + /diarize endpoint

**Files:**
- Create: `sidecar/meeting_notes_diarize/app.py`, `sidecar/tests/test_app.py`

- [ ] **Step 1: Write test**

```python
# sidecar/tests/test_app.py
from unittest.mock import patch
from fastapi.testclient import TestClient
from meeting_notes_diarize.app import app
from meeting_notes_diarize.schemas import DiarizeResponse, Segment

client = TestClient(app)

def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

def test_diarize_rejects_missing_file():
    r = client.post("/diarize", json={"audio_path": "/does/not/exist.mp3"})
    assert r.status_code == 400

@patch("meeting_notes_diarize.app.diarize_audio")
def test_diarize_happy_path(mock_diarize, tmp_path):
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"x")
    mock_diarize.return_value = DiarizeResponse(
        segments=[Segment(start=0, end=1, speaker="SPEAKER_00", embedding=[0.0]*512)],
        num_speakers=1,
    )
    r = client.post("/diarize", json={"audio_path": str(audio)})
    assert r.status_code == 200
    assert r.json()["num_speakers"] == 1
```

- [ ] **Step 2: Run, expect fail**

```bash
pytest tests/test_app.py
```
Expected: FAIL.

- [ ] **Step 3: Implement**

```python
# sidecar/meeting_notes_diarize/app.py
import os
from fastapi import FastAPI, HTTPException
from .schemas import DiarizeRequest, DiarizeResponse
from .diarize import diarize_audio

app = FastAPI(title="MeetingNotes Diarization Sidecar")

@app.get("/health")
def health() -> dict:
    return {"status": "ok"}

@app.post("/diarize", response_model=DiarizeResponse)
def diarize(req: DiarizeRequest) -> DiarizeResponse:
    if not os.path.isfile(req.audio_path):
        raise HTTPException(status_code=400, detail=f"audio file not found: {req.audio_path}")
    try:
        return diarize_audio(req.audio_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
```

- [ ] **Step 4: Run, expect pass**

```bash
pytest tests/ -v
```
Expected: all sidecar tests pass.

- [ ] **Step 5: Smoke-run the server locally**

```bash
uvicorn meeting_notes_diarize.app:app --host 127.0.0.1 --port 8765 &
sleep 2 && curl -s http://127.0.0.1:8765/health
kill %1
```
Expected output: `{"status":"ok"}`.

- [ ] **Step 6: Commit**

```bash
git add sidecar/meeting_notes_diarize/app.py sidecar/tests/test_app.py
git commit -m "sidecar: FastAPI app with /health and /diarize endpoints"
```

---

### Task 22: Sidecar fixture capture for contract tests

**Files:**
- Create: `samples/short-meeting.mp3` (placeholder), `samples/short-meeting.expected.json`, `samples/README.md`

- [ ] **Step 1: Create a 5-second synthetic MP3 with two alternating tones**

Run (requires ffmpeg, already installed):

```bash
mkdir -p samples
ffmpeg -y -f lavfi -i "sine=frequency=200:duration=2.5" -f lavfi -i "sine=frequency=500:duration=2.5" -filter_complex "[0][1]concat=n=2:v=0:a=1" samples/short-meeting.mp3
```
Expected: `samples/short-meeting.mp3` (~5s) created.

- [ ] **Step 2: Write expected contract JSON**

```json
{
  "description": "Shared contract fixture. Schema-only — exact values depend on model.",
  "schema": {
    "segments": [{ "start": "number", "end": "number", "speaker": "string", "embedding": "number[512]" }],
    "num_speakers": "integer >= 1"
  }
}
```

Save to `samples/short-meeting.expected.json`.

- [ ] **Step 3: Write `samples/README.md`**

```markdown
# Samples

- `short-meeting.mp3` — 5s synthetic audio (two tones) used in contract tests.
  Regenerate with: `ffmpeg -y -f lavfi -i "sine=frequency=200:duration=2.5" -f lavfi -i "sine=frequency=500:duration=2.5" -filter_complex "[0][1]concat=n=2:v=0:a=1" samples/short-meeting.mp3`
- `short-meeting.expected.json` — schema contract both sides must conform to.
```

- [ ] **Step 4: Commit**

```bash
git add samples/
git commit -m "samples: add synthetic MP3 fixture + contract schema"
```

---

## PHASE 5: External Clients

### Task 23: LM Studio client — /v1/models

**Files:**
- Create: `electron/main/lm-studio/client.ts`, `electron/main/lm-studio/client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LMStudioClient } from './client';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('LMStudioClient.listModels', () => {
  it('returns model IDs from /v1/models', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b' }],
    }), { status: 200 }));
    const c = new LMStudioClient('http://localhost:1234');
    expect(await c.listModels()).toEqual(['whisper-large-v3', 'llama-3.1-8b']);
  });

  it('throws descriptive error on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = new LMStudioClient('http://localhost:1234');
    await expect(c.listModels()).rejects.toThrow(/LM Studio/);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- lm-studio/client`
Expected: FAIL.

- [ ] **Step 3: Implement skeleton + listModels**

```ts
// electron/main/lm-studio/client.ts
export class LMStudioError extends Error {
  constructor(message: string, public cause?: unknown) { super(message); }
}

export class LMStudioClient {
  constructor(private readonly baseUrl: string) {}

  async listModels(): Promise<string[]> {
    const url = `${this.baseUrl}/v1/models`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new LMStudioError(`LM Studio unreachable at ${this.baseUrl}`, e);
    }
    if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/models`);
    const body = (await resp.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- lm-studio/client`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lm-studio/client.ts electron/main/lm-studio/client.test.ts
git commit -m "lm-studio: client skeleton + listModels"
```

---

### Task 24: LM Studio client — transcribe

**Files:**
- Modify: `electron/main/lm-studio/client.ts`, `electron/main/lm-studio/client.test.ts`

- [ ] **Step 1: Add failing test**

Append to `client.test.ts`:

```ts
describe('LMStudioClient.transcribe', () => {
  it('POSTs multipart form to /v1/audio/transcriptions and returns segments', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      text: 'hello world',
      segments: [{ start: 0, end: 1, text: 'hello world' }],
    }), { status: 200 }));
    const c = new LMStudioClient('http://localhost:1234');
    const result = await c.transcribe({
      audioPath: '/tmp/x.mp3', model: 'whisper-large-v3', language: 'en',
      readFile: async () => new Uint8Array([1, 2, 3]),
    });
    expect(result.text).toBe('hello world');
    expect(result.segments[0]!.start).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:1234/v1/audio/transcriptions');
    expect((init as RequestInit).method).toBe('POST');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- lm-studio/client`
Expected: FAIL — `transcribe` missing.

- [ ] **Step 3: Implement transcribe**

Append to `client.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

export interface TranscribeInput {
  audioPath: string;
  model: string;
  language?: string;
  readFile?: (p: string) => Promise<Uint8Array>;
}
export interface TranscribeResult {
  text: string;
  segments: { start: number; end: number; text: string }[];
}

export class LMStudioClient_Transcribe {} // marker only; augmenting existing class below

// (Augmentation: add method to the class above)
declare module './client' {
  interface LMStudioClient {
    transcribe(input: TranscribeInput): Promise<TranscribeResult>;
  }
}

LMStudioClient.prototype.transcribe = async function (input: TranscribeInput): Promise<TranscribeResult> {
  const read = input.readFile ?? ((p) => fs.readFile(p));
  const bytes = await read(input.audioPath);
  const form = new FormData();
  form.append('model', input.model);
  form.append('response_format', 'verbose_json');
  if (input.language) form.append('language', input.language);
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), path.basename(input.audioPath));

  const url = `${(this as any).baseUrl}/v1/audio/transcriptions`;
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60 * 1000) });
  } catch (e) {
    throw new LMStudioError(`LM Studio transcribe failed: network`, e);
  }
  if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/audio/transcriptions`);
  const body = (await resp.json()) as { text: string; segments?: { start: number; end: number; text: string }[] };
  return { text: body.text, segments: body.segments ?? [] };
};
```

Note: declaring `baseUrl` as private interferes with the augmentation above. Adjust the class to store `baseUrl` as `protected` or use a public readonly property. Final class shape:

```ts
export class LMStudioClient {
  constructor(public readonly baseUrl: string) {}
  async listModels(): Promise<string[]> { /* unchanged */ }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- lm-studio/client`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lm-studio/client.ts electron/main/lm-studio/client.test.ts
git commit -m "lm-studio: transcribe via /v1/audio/transcriptions"
```

---

### Task 25: LM Studio client — chat completions

**Files:**
- Modify: `electron/main/lm-studio/client.ts`, `electron/main/lm-studio/client.test.ts`

- [ ] **Step 1: Add failing test**

Append:

```ts
describe('LMStudioClient.chat', () => {
  it('POSTs JSON to /v1/chat/completions and returns assistant content', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Summary text' } }],
    }), { status: 200 }));
    const c = new LMStudioClient('http://localhost:1234');
    const result = await c.chat({
      model: 'llama-3.1-8b',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });
    expect(result).toBe('Summary text');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- lm-studio/client`
Expected: FAIL — `chat` missing.

- [ ] **Step 3: Implement**

Append to `client.ts`:

```ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatInput {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

declare module './client' {
  interface LMStudioClient {
    chat(input: ChatInput): Promise<string>;
  }
}

LMStudioClient.prototype.chat = async function (input: ChatInput): Promise<string> {
  const url = `${(this as any).baseUrl}/v1/chat/completions`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens,
      }),
      signal: AbortSignal.timeout(2 * 60 * 1000),
    });
  } catch (e) {
    throw new LMStudioError('LM Studio chat failed: network', e);
  }
  if (!resp.ok) throw new LMStudioError(`LM Studio ${resp.status} on /v1/chat/completions`);
  const body = (await resp.json()) as { choices: { message: { content: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- lm-studio/client`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/lm-studio/client.ts electron/main/lm-studio/client.test.ts
git commit -m "lm-studio: chat completions"
```

---

### Task 26: Diarization HTTP client

**Files:**
- Create: `electron/main/diarization/client.ts`, `electron/main/diarization/client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DiarizationClient } from './client';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('DiarizationClient', () => {
  it('health returns true when sidecar responds ok', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    const c = new DiarizationClient('http://127.0.0.1:8765');
    expect(await c.health()).toBe(true);
  });

  it('health returns false on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const c = new DiarizationClient('http://127.0.0.1:8765');
    expect(await c.health()).toBe(false);
  });

  it('diarize POSTs audio path and returns segments', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00', embedding: new Array(512).fill(0) }],
      num_speakers: 1,
    }), { status: 200 }));
    const c = new DiarizationClient('http://127.0.0.1:8765');
    const result = await c.diarize('/x/a.mp3');
    expect(result.segments[0]!.speaker).toBe('SPEAKER_00');
    expect(result.segments[0]!.embedding).toHaveLength(512);
    expect(result.num_speakers).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- diarization/client`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/diarization/client.ts
import { z } from 'zod';

export const DiarSegmentSchema = z.object({
  start: z.number(), end: z.number(), speaker: z.string(), embedding: z.array(z.number()),
});
export const DiarResponseSchema = z.object({
  segments: z.array(DiarSegmentSchema),
  num_speakers: z.number().int(),
});
export type DiarResponse = z.infer<typeof DiarResponseSchema>;

export class DiarizationError extends Error {}

export class DiarizationClient {
  constructor(public readonly baseUrl: string) {}

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  }

  async diarize(audioPath: string): Promise<DiarResponse> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/diarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio_path: audioPath }),
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
    } catch (e) {
      throw new DiarizationError(`Diarization sidecar unreachable: ${(e as Error).message}`);
    }
    if (!resp.ok) throw new DiarizationError(`Sidecar ${resp.status}: ${await resp.text()}`);
    const body = await resp.json();
    return DiarResponseSchema.parse(body);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- diarization/client`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/diarization/client.ts electron/main/diarization/client.test.ts
git commit -m "diarization: HTTP client with zod-validated response"
```

---

### Task 27: Sidecar supervisor (spawn + restart)

**Files:**
- Create: `electron/main/diarization/supervisor.ts`, `electron/main/diarization/supervisor.test.ts`

- [ ] **Step 1: Write test (spawn abstraction injected)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DiarizationSupervisor } from './supervisor';

function fakeProc() {
  const ee = new EventEmitter() as EventEmitter & { kill: () => void; pid: number };
  ee.kill = () => setImmediate(() => ee.emit('exit', 0, null));
  ee.pid = 12345;
  return ee;
}

describe('DiarizationSupervisor', () => {
  it('spawns the sidecar on start()', () => {
    const spawn = vi.fn(() => fakeProc() as any);
    const sup = new DiarizationSupervisor({ spawn, sidecarDir: '/tmp' });
    sup.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    sup.stop();
  });

  it('restarts on unexpected exit, up to max retries', async () => {
    let procs = 0;
    const spawn = vi.fn(() => {
      procs += 1;
      const p = fakeProc();
      setImmediate(() => p.emit('exit', 1, null));
      return p as any;
    });
    const sup = new DiarizationSupervisor({ spawn, sidecarDir: '/tmp', maxRestarts: 2, restartDelayMs: 0 });
    sup.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(procs).toBe(3); // initial + 2 restarts
    sup.stop();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- diarization/supervisor`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/diarization/supervisor.ts
import type { ChildProcess } from 'node:child_process';
import { spawn as realSpawn } from 'node:child_process';
import path from 'node:path';

export interface SupervisorDeps {
  spawn?: typeof realSpawn;
  sidecarDir: string;
  host?: string;
  port?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  onLog?: (line: string) => void;
}

export class DiarizationSupervisor {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private stopped = false;
  private readonly spawn: typeof realSpawn;
  private readonly maxRestarts: number;
  private readonly restartDelay: number;

  constructor(private readonly deps: SupervisorDeps) {
    this.spawn = deps.spawn ?? realSpawn;
    this.maxRestarts = deps.maxRestarts ?? 3;
    this.restartDelay = deps.restartDelayMs ?? 1000;
  }

  start(): void {
    if (this.proc) return;
    const venvPython = path.join(this.deps.sidecarDir, '.venv', 'bin', 'python');
    const host = this.deps.host ?? '127.0.0.1';
    const port = this.deps.port ?? 8765;
    const proc = this.spawn(
      venvPython,
      ['-m', 'uvicorn', 'meeting_notes_diarize.app:app', '--host', host, '--port', String(port)],
      { cwd: this.deps.sidecarDir },
    );
    this.proc = proc;
    proc.stdout?.on('data', (d: Buffer) => this.deps.onLog?.(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => this.deps.onLog?.(d.toString()));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      if (this.restarts >= this.maxRestarts) return;
      this.restarts += 1;
      setTimeout(() => this.start(), this.restartDelay);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }

  isRunning(): boolean { return this.proc !== null; }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- diarization/supervisor`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/diarization/supervisor.ts electron/main/diarization/supervisor.test.ts
git commit -m "diarization: supervisor with spawn + restart backoff"
```

---

## PHASE 6: Audio Hijack + Library Watcher

### Task 28: Audio Hijack bridge (osascript)

**Files:**
- Create: `electron/main/audio-hijack/bridge.ts`, `electron/main/audio-hijack/bridge.test.ts`

- [ ] **Step 1: Write test (injected runner)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { AudioHijackBridge } from './bridge';

describe('AudioHijackBridge', () => {
  it('startSession issues the expected AppleScript tell', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const b = new AudioHijackBridge({ runner });
    await b.startSession('Meeting');
    expect(runner).toHaveBeenCalled();
    const [cmd, args] = runner.mock.calls[0]!;
    expect(cmd).toBe('osascript');
    expect((args as string[]).some((a) => a.includes('start session "Meeting"'))).toBe(true);
  });

  it('throws friendly error if stderr non-empty', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: 'Audio Hijack is not running' }));
    const b = new AudioHijackBridge({ runner });
    await expect(b.startSession('x')).rejects.toThrow(/Audio Hijack/);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- audio-hijack/bridge`
Expected: FAIL.

- [ ] **Step 3: Implement (inject runner so tests don't shell out)**

```ts
// electron/main/audio-hijack/bridge.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: Runner = (cmd, args) => pExecFile(cmd, args, { timeout: 10000 });

export class AudioHijackError extends Error {}

export class AudioHijackBridge {
  private readonly runner: Runner;
  constructor(deps: { runner?: Runner } = {}) { this.runner = deps.runner ?? defaultRunner; }

  private async runScript(script: string): Promise<string> {
    const { stdout, stderr } = await this.runner('osascript', ['-e', script]);
    if (stderr.trim()) throw new AudioHijackError(`Audio Hijack error: ${stderr.trim()}`);
    return stdout.trim();
  }

  async startSession(name: string): Promise<void> {
    const safe = name.replace(/"/g, '\\"');
    await this.runScript(`tell application "Audio Hijack" to start session "${safe}"`);
  }

  async stopSession(name: string): Promise<void> {
    const safe = name.replace(/"/g, '\\"');
    await this.runScript(`tell application "Audio Hijack" to stop session "${safe}"`);
  }

  async sessionState(name: string): Promise<'running' | 'stopped' | 'unknown'> {
    const safe = name.replace(/"/g, '\\"');
    const s = await this.runScript(`tell application "Audio Hijack" to get running of session "${safe}"`);
    if (s === 'true') return 'running';
    if (s === 'false') return 'stopped';
    return 'unknown';
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- audio-hijack/bridge`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/audio-hijack/bridge.ts electron/main/audio-hijack/bridge.test.ts
git commit -m "audio-hijack: AppleScript bridge (start/stop/state)"
```

---

### Task 29: Library watcher (chokidar with stability check)

**Files:**
- Create: `electron/main/library/watcher.ts`, `electron/main/library/watcher.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryWatcher } from './watcher';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('LibraryWatcher', () => {
  it('emits a stable-file event once the file size stops changing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch-')); dirs.push(dir);
    const w = new LibraryWatcher({ path: dir, stabilityMs: 100, pollMs: 40 });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    const file = path.join(dir, 'new.mp3');
    fs.writeFileSync(file, Buffer.alloc(100));
    await new Promise((r) => setTimeout(r, 250));
    await w.stop();
    expect(seen).toContain(file);
  });

  it('filters to .mp3 only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-watch2-')); dirs.push(dir);
    const w = new LibraryWatcher({ path: dir, stabilityMs: 80, pollMs: 40 });
    const seen: string[] = [];
    w.onStableFile((p) => seen.push(p));
    await w.start();
    fs.writeFileSync(path.join(dir, 'x.txt'), 'hi');
    await new Promise((r) => setTimeout(r, 200));
    await w.stop();
    expect(seen.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- library/watcher`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/library/watcher.ts
import chokidar from 'chokidar';
import fs from 'node:fs';

export interface WatcherOptions {
  path: string;
  stabilityMs?: number;
  pollMs?: number;
}

export class LibraryWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly listeners: Array<(p: string) => void> = [];
  private readonly stability: number;
  private readonly poll: number;

  constructor(private readonly opts: WatcherOptions) {
    this.stability = opts.stabilityMs ?? 2000;
    this.poll = opts.pollMs ?? 500;
  }

  onStableFile(fn: (p: string) => void): void { this.listeners.push(fn); }

  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.opts.path, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: this.stability, pollInterval: this.poll },
    });
    this.watcher.on('add', (p) => {
      if (!p.toLowerCase().endsWith('.mp3')) return;
      try { fs.accessSync(p); } catch { return; }
      for (const fn of this.listeners) fn(p);
    });
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- library/watcher`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/library/watcher.ts electron/main/library/watcher.test.ts
git commit -m "library: chokidar watcher with stability check"
```

---

### Task 30: ffprobe validation

**Files:**
- Create: `electron/main/library/ffprobe.ts`, `electron/main/library/ffprobe.test.ts`

- [ ] **Step 1: Write failing test (injected runner)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { probeAudio } from './ffprobe';

describe('probeAudio', () => {
  it('parses duration from ffprobe JSON output', async () => {
    const runner = vi.fn(async () => ({
      stdout: JSON.stringify({ format: { duration: '12.5' } }), stderr: '',
    }));
    const info = await probeAudio('/x.mp3', { runner });
    expect(info.durationS).toBe(12.5);
  });

  it('throws on empty or invalid file', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: 'Invalid data' }));
    await expect(probeAudio('/x.mp3', { runner })).rejects.toThrow(/invalid|empty/i);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- library/ffprobe`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/library/ffprobe.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);
type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface AudioInfo { durationS: number; }

export async function probeAudio(file: string, deps: { runner?: Runner } = {}): Promise<AudioInfo> {
  const runner: Runner = deps.runner ?? ((c, a) => pExecFile(c, a, { timeout: 10000 }));
  const { stdout, stderr } = await runner('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', file,
  ]);
  if (stderr.trim() || !stdout.trim()) throw new Error(`ffprobe: invalid or empty file: ${stderr.trim()}`);
  const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
  const dur = parsed.format?.duration;
  if (!dur) throw new Error('ffprobe: no duration');
  return { durationS: Number(dur) };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- library/ffprobe`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/library/ffprobe.ts electron/main/library/ffprobe.test.ts
git commit -m "library: ffprobe-based MP3 validation"
```

---

## PHASE 7: Speaker Roster

### Task 31: Embedding file persistence

**Files:**
- Create: `electron/main/speakers/embeddings.ts`, `electron/main/speakers/embeddings.test.ts`

Uses a simple binary format (magic bytes `MNEMB` + uint32 length + float32 vector) — not true .npy, which is overkill.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeEmbedding, readEmbedding, embeddingFilePath } from './embeddings';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('embeddings', () => {
  it('writes and reads a 512-float vector round-trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-emb-')); dirs.push(dir);
    const vec = Array.from({ length: 512 }, (_, i) => i * 0.001);
    const file = embeddingFilePath(dir, 'spk_x1');
    writeEmbedding(file, vec);
    const got = readEmbedding(file);
    expect(got).toHaveLength(512);
    expect(got[10]).toBeCloseTo(vec[10]!, 6);
  });

  it('rejects wrong magic bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-emb2-')); dirs.push(dir);
    const f = path.join(dir, 'bad.bin');
    fs.writeFileSync(f, Buffer.from('XXX'));
    expect(() => readEmbedding(f)).toThrow(/magic|format/i);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- speakers/embeddings`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/speakers/embeddings.ts
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
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- speakers/embeddings`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/speakers/embeddings.ts electron/main/speakers/embeddings.test.ts
git commit -m "speakers: embedding file read/write (custom binary format)"
```

---

### Task 32: Speaker matcher

**Files:**
- Create: `electron/main/speakers/matcher.ts`, `electron/main/speakers/matcher.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { matchSpeakers, updateRunningAverage, MATCH_THRESHOLD } from './matcher';

describe('matchSpeakers', () => {
  const roster = [
    { id: 'spk_a', embedding: [1, 0, 0] },
    { id: 'spk_b', embedding: [0, 1, 0] },
  ];

  it('auto-links when cosine >= threshold', () => {
    const out = matchSpeakers([{ label: 'Speaker 1', embedding: [0.99, 0.01, 0] }], roster);
    expect(out[0]!.rosterId).toBe('spk_a');
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('leaves unlinked when no match exceeds threshold', () => {
    const out = matchSpeakers([{ label: 'Speaker 2', embedding: [0, 0, 1] }], roster);
    expect(out[0]!.rosterId).toBeNull();
  });

  it('handles empty roster', () => {
    const out = matchSpeakers([{ label: 'S', embedding: [1, 0, 0] }], []);
    expect(out[0]!.rosterId).toBeNull();
  });
});

describe('updateRunningAverage', () => {
  it('uses 0.7 old + 0.3 new', () => {
    const r = updateRunningAverage([1, 0], [0, 1]);
    expect(r[0]).toBeCloseTo(0.7, 6);
    expect(r[1]).toBeCloseTo(0.3, 6);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- speakers/matcher`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/speakers/matcher.ts
import { cosineSimilarity } from '../lib/cosine';

export const MATCH_THRESHOLD = 0.75;
export const OLD_WEIGHT = 0.7;

export interface RosterEntry { id: string; embedding: number[]; }
export interface DetectedSpeaker { label: string; embedding: number[]; }
export interface Match { label: string; rosterId: string | null; confidence: number | null; }

export function matchSpeakers(detected: readonly DetectedSpeaker[], roster: readonly RosterEntry[]): Match[] {
  return detected.map((d) => {
    let bestId: string | null = null;
    let bestScore = -Infinity;
    for (const r of roster) {
      if (r.embedding.length !== d.embedding.length) continue;
      const s = cosineSimilarity(d.embedding, r.embedding);
      if (s > bestScore) { bestScore = s; bestId = r.id; }
    }
    if (bestId !== null && bestScore >= MATCH_THRESHOLD) {
      return { label: d.label, rosterId: bestId, confidence: bestScore };
    }
    return { label: d.label, rosterId: null, confidence: null };
  });
}

export function updateRunningAverage(old: readonly number[], observed: readonly number[]): number[] {
  if (old.length !== observed.length) throw new Error('length mismatch');
  const out = new Array<number>(old.length);
  for (let i = 0; i < old.length; i++) {
    out[i] = OLD_WEIGHT * old[i]! + (1 - OLD_WEIGHT) * observed[i]!;
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- speakers/matcher`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/speakers/matcher.ts electron/main/speakers/matcher.test.ts
git commit -m "speakers: matcher with cosine threshold + running-average update"
```

---

### Task 33: Roster service (combines repo + embeddings + matcher)

**Files:**
- Create: `electron/main/speakers/roster-service.ts`, `electron/main/speakers/roster-service.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db';
import { SpeakersRepo } from '../storage/speakers-repo';
import { RosterService } from './roster-service';

let svc: RosterService;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-roster-'));
  const db = openDb(path.join(tmp, 'db.sqlite'));
  svc = new RosterService(new SpeakersRepo(db), tmp);
});

describe('RosterService', () => {
  it('confirmSpeaker creates a new speaker and persists embedding', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: new Array(512).fill(0.1) });
    expect(svc.loadEmbedding(id)).toHaveLength(512);
  });

  it('identifyUnknowns auto-links when above threshold', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0, 0] });
    const m = svc.identifyUnknowns([{ label: 'Speaker 1', embedding: [0.99, 0.01, 0] }]);
    expect(m[0]!.rosterId).toBe(id);
  });

  it('confirm on existing speaker updates running average embedding', () => {
    const id = svc.confirmSpeaker({ displayName: 'Dan', embedding: [1, 0, 0] });
    svc.confirmSpeakerFor(id, [0, 1, 0]);
    const e = svc.loadEmbedding(id);
    expect(e[0]).toBeCloseTo(0.7, 6);
    expect(e[1]).toBeCloseTo(0.3, 6);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- speakers/roster-service`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/speakers/roster-service.ts
import type { SpeakersRepo } from '../storage/speakers-repo';
import { embeddingFilePath, writeEmbedding, readEmbedding } from './embeddings';
import { matchSpeakers, updateRunningAverage, type DetectedSpeaker, type Match } from './matcher';

export class RosterService {
  constructor(private readonly repo: SpeakersRepo, private readonly libraryRoot: string) {}

  confirmSpeaker(input: { displayName: string; embedding: number[]; notes?: string }): string {
    const id = this.repo.create({ displayName: input.displayName, notes: input.notes });
    writeEmbedding(embeddingFilePath(this.libraryRoot, id), input.embedding);
    return id;
  }

  confirmSpeakerFor(id: string, observed: number[]): void {
    const old = this.loadEmbedding(id);
    const updated = updateRunningAverage(old, observed);
    writeEmbedding(embeddingFilePath(this.libraryRoot, id), updated);
  }

  loadEmbedding(id: string): number[] {
    return readEmbedding(embeddingFilePath(this.libraryRoot, id));
  }

  identifyUnknowns(detected: readonly DetectedSpeaker[]): Match[] {
    const rosterEntries = this.repo.list().map((s) => ({ id: s.id, embedding: this.safeLoad(s.id) }))
      .filter((r): r is { id: string; embedding: number[] } => r.embedding !== null);
    return matchSpeakers(detected, rosterEntries);
  }

  private safeLoad(id: string): number[] | null {
    try { return this.loadEmbedding(id); } catch { return null; }
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- speakers/roster-service`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/speakers/roster-service.ts electron/main/speakers/roster-service.test.ts
git commit -m "speakers: roster service combining repo + embeddings + matcher"
```

---

## PHASE 8: Pipeline

### Task 34: Stage context (shared dependencies passed to every stage)

**Files:**
- Create: `electron/main/pipeline/context.ts`

- [ ] **Step 1: Define context type**

```ts
// electron/main/pipeline/context.ts
import type { LMStudioClient } from '../lm-studio/client';
import type { DiarizationClient } from '../diarization/client';
import type { MeetingsRepo } from '../storage/meetings-repo';
import type { SpeakersRepo } from '../storage/speakers-repo';
import type { ActionItemsRepo } from '../storage/action-items-repo';
import type { SettingsRepo } from '../storage/settings-repo';
import type { RosterService } from '../speakers/roster-service';
import type { Logger } from '../logging/logger';

export interface PipelineContext {
  libraryRoot: string;
  lmStudio: LMStudioClient;
  diarization: DiarizationClient;
  meetings: MeetingsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  settings: SettingsRepo;
  roster: RosterService;
  logger: Logger;
}

export interface StageInput { meetingId: string; }
export type StageHandler = (input: StageInput, ctx: PipelineContext) => Promise<void>;
```

- [ ] **Step 2: Commit**

```bash
git add electron/main/pipeline/context.ts
git commit -m "pipeline: shared stage context type"
```

---

### Task 35: Transcribing stage

**Files:**
- Create: `electron/main/pipeline/stages/transcribing.ts`, `electron/main/pipeline/stages/transcribing.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTranscribing } from './transcribing';

describe('runTranscribing', () => {
  it('calls LMStudio.transcribe and writes transcript.raw.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-t-'));
    const mFolder = path.join(dir, 'meetings', 'slug');
    fs.mkdirSync(mFolder, { recursive: true });
    fs.writeFileSync(path.join(mFolder, 'audio.mp3'), 'x');

    const ctx: any = {
      libraryRoot: dir,
      lmStudio: { transcribe: vi.fn(async () => ({ text: 'hi', segments: [{ start: 0, end: 1, text: 'hi' }] })) },
      settings: { get: (k: string) => k === 'sttModel' ? 'whisper-large-v3' : 'en' },
      meetings: { findById: () => ({ slug: 'slug', audioPath: path.join(mFolder, 'audio.mp3') }), updateStage: vi.fn() },
      logger: { info: vi.fn(), error: vi.fn() },
    };
    await runTranscribing({ meetingId: 'm1' }, ctx);
    const written = JSON.parse(fs.readFileSync(path.join(mFolder, 'transcript.raw.json'), 'utf8'));
    expect(written.text).toBe('hi');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/stages/transcribing`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/pipeline/stages/transcribing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';

export const runTranscribing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  ctx.logger.info('transcribe:start', { meetingId });
  const result = await ctx.lmStudio.transcribe({
    audioPath: meeting.audioPath,
    model: ctx.settings.get('sttModel'),
    language: ctx.settings.get('sttLanguage'),
  });
  fs.writeFileSync(path.join(folder, 'transcript.raw.json'), JSON.stringify(result, null, 2));
  ctx.logger.info('transcribe:done', { meetingId, segments: result.segments.length });
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- pipeline/stages/transcribing`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/stages/transcribing.ts electron/main/pipeline/stages/transcribing.test.ts
git commit -m "pipeline: transcribing stage"
```

---

### Task 36: Diarizing stage

**Files:**
- Create: `electron/main/pipeline/stages/diarizing.ts`, `electron/main/pipeline/stages/diarizing.test.ts`

- [ ] **Step 1: Write test (pattern mirrors transcribing)**

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDiarizing } from './diarizing';

describe('runDiarizing', () => {
  it('calls diarization client and writes diarization.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-d-'));
    const mFolder = path.join(dir, 'meetings', 'slug'); fs.mkdirSync(mFolder, { recursive: true });

    const ctx: any = {
      libraryRoot: dir,
      diarization: { diarize: vi.fn(async () => ({
        segments: [{ start: 0, end: 1, speaker: 'SPEAKER_00', embedding: new Array(512).fill(0) }],
        num_speakers: 1,
      })) },
      meetings: { findById: () => ({ slug: 'slug', audioPath: '/x.mp3' }) },
      logger: { info: vi.fn() },
    };
    await runDiarizing({ meetingId: 'm' }, ctx);
    const got = JSON.parse(fs.readFileSync(path.join(mFolder, 'diarization.json'), 'utf8'));
    expect(got.num_speakers).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/stages/diarizing`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/pipeline/stages/diarizing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';

export const runDiarizing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  ctx.logger.info('diarize:start', { meetingId });
  const result = await ctx.diarization.diarize(meeting.audioPath);
  fs.writeFileSync(path.join(folder, 'diarization.json'), JSON.stringify(result, null, 2));
  ctx.logger.info('diarize:done', { meetingId, speakers: result.num_speakers });
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- pipeline/stages/diarizing`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/stages/diarizing.ts electron/main/pipeline/stages/diarizing.test.ts
git commit -m "pipeline: diarizing stage"
```

---

### Task 37: Merging stage

**Files:**
- Create: `electron/main/pipeline/stages/merging.ts`, `electron/main/pipeline/stages/merging.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMerging } from './merging';

describe('runMerging', () => {
  it('reads transcript.raw.json + diarization.json, writes transcript.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-m-'));
    const f = path.join(dir, 'meetings', 'slug'); fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.raw.json'), JSON.stringify({
      text: 'Hi. There.', segments: [{ start: 0, end: 1, text: 'Hi.' }, { start: 1, end: 2, text: 'There.' }],
    }));
    fs.writeFileSync(path.join(f, 'diarization.json'), JSON.stringify({
      segments: [
        { start: 0, end: 1.2, speaker: 'SPEAKER_00', embedding: [] },
        { start: 1.2, end: 3, speaker: 'SPEAKER_01', embedding: [] },
      ], num_speakers: 2,
    }));
    const ctx: any = { libraryRoot: dir, meetings: { findById: () => ({ slug: 'slug' }) }, logger: { info: () => {} } };
    await runMerging({ meetingId: 'm' }, ctx);
    const md = fs.readFileSync(path.join(f, 'transcript.md'), 'utf8');
    expect(md).toContain('[SPEAKER_00 00:00] Hi.');
    expect(md).toContain('[SPEAKER_01 00:01] There.');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/stages/merging`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/pipeline/stages/merging.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';
import { mergeTranscriptWithDiarization, mergedToMarkdown } from '../../lib/merge-transcript';

export const runMerging: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const whisper = JSON.parse(fs.readFileSync(path.join(folder, 'transcript.raw.json'), 'utf8')).segments;
  const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8')).segments;
  const merged = mergeTranscriptWithDiarization(whisper, diar);
  fs.writeFileSync(path.join(folder, 'transcript.md'), mergedToMarkdown(merged));
  ctx.logger.info('merge:done', { meetingId, segments: merged.length });
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- pipeline/stages/merging`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/stages/merging.ts electron/main/pipeline/stages/merging.test.ts
git commit -m "pipeline: merging stage"
```

---

### Task 38: Identifying stage

**Files:**
- Create: `electron/main/pipeline/stages/identifying.ts`, `electron/main/pipeline/stages/identifying.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIdentifying } from './identifying';

describe('runIdentifying', () => {
  it('averages embeddings per speaker and links via roster service', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-i-'));
    const f = path.join(dir, 'meetings', 'slug'); fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'diarization.json'), JSON.stringify({
      segments: [
        { start: 0, end: 1, speaker: 'SPEAKER_00', embedding: [1, 0, 0] },
        { start: 1, end: 2, speaker: 'SPEAKER_00', embedding: [1, 0, 0] },
        { start: 2, end: 3, speaker: 'SPEAKER_01', embedding: [0, 1, 0] },
      ], num_speakers: 2,
    }));
    const linkFn = vi.fn();
    const ctx: any = {
      libraryRoot: dir,
      meetings: { findById: () => ({ slug: 'slug' }) },
      roster: { identifyUnknowns: vi.fn(() => [
        { label: 'SPEAKER_00', rosterId: 'spk_a', confidence: 0.9 },
        { label: 'SPEAKER_01', rosterId: null, confidence: null },
      ]) },
      speakers: { linkToMeeting: linkFn },
      logger: { info: () => {} },
    };
    await runIdentifying({ meetingId: 'm' }, ctx);
    expect(linkFn).toHaveBeenCalledWith('m', 'SPEAKER_00', 'spk_a', 0.9);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/stages/identifying`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/pipeline/stages/identifying.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';

export const runIdentifying: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const diar = JSON.parse(fs.readFileSync(path.join(folder, 'diarization.json'), 'utf8'));

  // Average embedding per speaker label.
  const byLabel: Record<string, { sum: number[]; count: number }> = {};
  for (const s of diar.segments as { speaker: string; embedding: number[] }[]) {
    if (!byLabel[s.speaker]) byLabel[s.speaker] = { sum: s.embedding.slice(), count: 1 };
    else {
      const entry = byLabel[s.speaker]!;
      for (let i = 0; i < s.embedding.length; i++) entry.sum[i] = (entry.sum[i] ?? 0) + s.embedding[i]!;
      entry.count += 1;
    }
  }
  const detected = Object.entries(byLabel).map(([label, { sum, count }]) => ({
    label, embedding: sum.map((x) => x / count),
  }));

  const matches = ctx.roster.identifyUnknowns(detected);
  for (const m of matches) {
    if (m.rosterId !== null && m.confidence !== null) {
      ctx.speakers.linkToMeeting(meetingId, m.label, m.rosterId, m.confidence);
    }
  }
  ctx.logger.info('identify:done', { meetingId, matched: matches.filter((m) => m.rosterId).length, total: matches.length });
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- pipeline/stages/identifying`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/stages/identifying.ts electron/main/pipeline/stages/identifying.test.ts
git commit -m "pipeline: identifying stage"
```

---

### Task 39: Summarizing stage (with prompt)

**Files:**
- Create: `electron/main/pipeline/stages/summarizing.ts`, `electron/main/pipeline/stages/summarizing.test.ts`, `electron/main/pipeline/prompts.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSummarizing } from './summarizing';

describe('runSummarizing', () => {
  it('reads transcript.md, calls LLM, writes summary.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-s-'));
    const f = path.join(dir, 'meetings', 'slug'); fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '[SPEAKER_00 00:00] Hi.');

    const chat = vi.fn(async () => '## Overview\nshort meeting.');
    const ctx: any = {
      libraryRoot: dir,
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug' }) },
      settings: { get: (k: string) => (k === 'llmModel' ? 'llama-3.1-8b' : '') },
      logger: { info: () => {} },
    };
    await runSummarizing({ meetingId: 'm' }, ctx);
    expect(fs.readFileSync(path.join(f, 'summary.md'), 'utf8')).toContain('Overview');
    expect(chat).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/stages/summarizing`
Expected: FAIL.

- [ ] **Step 3: Implement prompts**

```ts
// electron/main/pipeline/prompts.ts
export const SUMMARY_SYSTEM_PROMPT = `You are a precise meeting-notes assistant for a professional setting.

Given the speaker-labeled transcript of a business meeting, produce a faithful, self-contained summary in Markdown.

Use these sections as relevant — SKIP any section that has nothing substantive:
## Overview
## Key Discussion Points
## Decisions
## Action Items
## Follow-ups
## Open Questions

Rules:
- Be concrete. Name people, systems, numbers where the transcript supports it.
- Action Items must have owner and due date if the transcript gives them; otherwise write "(owner TBD)" or "(no date)".
- Do NOT invent attendees, decisions, or commitments that the transcript does not support.
- Output only the summary Markdown — no preamble, no closing remarks.`;

export const ACTION_ITEM_SYSTEM_PROMPT = `Extract action items from the meeting transcript as a JSON array.

Each item: { "text": string, "owner": string | null, "due_date": "YYYY-MM-DD" | null }

Return ONLY the JSON array — no prose, no code fences. If there are no action items, return [].`;
```

- [ ] **Step 4: Implement summarizing stage**

```ts
// electron/main/pipeline/stages/summarizing.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';
import { SUMMARY_SYSTEM_PROMPT } from '../prompts';

export const runSummarizing: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  const content = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0.2,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
  });
  fs.writeFileSync(path.join(folder, 'summary.md'), content);
  ctx.logger.info('summarize:done', { meetingId, chars: content.length });
};
```

- [ ] **Step 5: Run, expect pass**

Run: `npm test -- pipeline/stages/summarizing`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add electron/main/pipeline/prompts.ts electron/main/pipeline/stages/summarizing.ts electron/main/pipeline/stages/summarizing.test.ts
git commit -m "pipeline: summarizing stage + prompt"
```

---

### Task 40: Extracting stage (action items)

**Files:**
- Create: `electron/main/pipeline/stages/extracting.ts`, `electron/main/pipeline/stages/extracting.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExtracting } from './extracting';

describe('runExtracting', () => {
  it('calls LLM, parses JSON, writes action-items.json + repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-e-'));
    const f = path.join(dir, 'meetings', 'slug'); fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'transcript.md'), '...');

    const chat = vi.fn(async () => '[{"text":"Send update","owner":"Dan","due_date":"2026-04-22"}]');
    const replace = vi.fn();
    const ctx: any = {
      libraryRoot: dir,
      lmStudio: { chat },
      meetings: { findById: () => ({ slug: 'slug' }) },
      actionItems: { replaceForMeeting: replace },
      settings: { get: () => 'llama-3.1-8b' },
      logger: { info: () => {} },
    };
    await runExtracting({ meetingId: 'm' }, ctx);
    expect(replace).toHaveBeenCalledWith('m', expect.arrayContaining([
      expect.objectContaining({ text: 'Send update' }),
    ]));
    const written = JSON.parse(fs.readFileSync(path.join(f, 'action-items.json'), 'utf8'));
    expect(written).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/stages/extracting`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/pipeline/stages/extracting.ts
import fs from 'node:fs';
import path from 'node:path';
import type { StageHandler } from '../context';
import { meetingFolderPath } from '../../storage/meeting-folder';
import { ACTION_ITEM_SYSTEM_PROMPT } from '../prompts';
import { parseActionItemsLoose } from '../../lib/action-item-schema';

export const runExtracting: StageHandler = async ({ meetingId }, ctx) => {
  const meeting = ctx.meetings.findById(meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const folder = meetingFolderPath(ctx.libraryRoot, meeting.slug);
  const transcript = fs.readFileSync(path.join(folder, 'transcript.md'), 'utf8');
  const raw = await ctx.lmStudio.chat({
    model: ctx.settings.get('llmModel'),
    temperature: 0,
    messages: [
      { role: 'system', content: ACTION_ITEM_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
  });
  const items = parseActionItemsLoose(raw);
  fs.writeFileSync(path.join(folder, 'action-items.json'), JSON.stringify(items, null, 2));
  ctx.actionItems.replaceForMeeting(meetingId, items);
  ctx.logger.info('extract:done', { meetingId, items: items.length });
};
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- pipeline/stages/extracting`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/stages/extracting.ts electron/main/pipeline/stages/extracting.test.ts
git commit -m "pipeline: extracting stage"
```

---

### Task 41: Pipeline orchestrator (queue + stage dispatch)

**Files:**
- Create: `electron/main/pipeline/pipeline.ts`, `electron/main/pipeline/pipeline.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db';
import { MeetingsRepo } from '../storage/meetings-repo';
import { Pipeline } from './pipeline';

describe('Pipeline', () => {
  it('advances a meeting through all stages, running transcribe + diarize in parallel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null, audioPath: '/x.mp3', status: 'processing', pipelineStage: 'discovered' });

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const p = new Pipeline({
      ctx: { meetings, logger: { info: () => {}, error: () => {} } } as any,
      stages: {
        transcribing: mk('t'), diarizing: mk('d'), merging: mk('m'),
        identifying: mk('i'), summarizing: mk('s'), extracting: mk('e'),
      },
    });
    await p.run('m');
    expect(meetings.findById('m')?.pipelineStage).toBe('done');
    expect(calls).toContain('t'); expect(calls).toContain('d'); expect(calls).toContain('m');
  });

  it('re-running from "transcribing" runs only transcribe + downstream (no diarize)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-pl2-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'm', slug: 's', title: 't', startedAt: null, durationS: null,
      audioPath: '/x.mp3', status: 'processing', pipelineStage: 'transcribing' });

    const calls: string[] = [];
    const mk = (name: string) => async () => { calls.push(name); };
    const p = new Pipeline({
      ctx: { meetings, logger: { info: () => {}, error: () => {} } } as any,
      stages: {
        transcribing: mk('t'), diarizing: mk('d'), merging: mk('m'),
        identifying: mk('i'), summarizing: mk('s'), extracting: mk('e'),
      },
    });
    await p.run('m');
    expect(calls).toContain('t');
    expect(calls).not.toContain('d');
    expect(calls).toContain('m');
    expect(meetings.findById('m')?.pipelineStage).toBe('done');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/pipeline`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/pipeline/pipeline.ts
import type { PipelineContext, StageHandler, StageInput } from './context';
import { nextStage, type Stage } from '../lib/stage-machine';

export interface PipelineDeps {
  ctx: PipelineContext;
  stages: Record<Exclude<Stage, 'discovered' | 'done'>, StageHandler>;
}

export class Pipeline {
  private queue: string[] = [];
  private running = false;

  constructor(private readonly deps: PipelineDeps) {}

  enqueue(meetingId: string): void {
    if (!this.queue.includes(meetingId)) this.queue.push(meetingId);
    void this.tick();
  }

  async run(meetingId: string): Promise<void> {
    await this.process(meetingId);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        try { await this.process(id); }
        catch (e) { this.deps.ctx.logger.error('pipeline:failure', { id, err: String(e) }); }
      }
    } finally { this.running = false; }
  }

  private async process(meetingId: string): Promise<void> {
    const input: StageInput = { meetingId };
    const m = this.deps.ctx.meetings.findById(meetingId);
    if (!m) return;

    let stage = m.pipelineStage as Stage;

    // From 'discovered', run transcribe + diarize in parallel.
    if (stage === 'discovered') {
      this.deps.ctx.meetings.updateStage(meetingId, 'transcribing');
      await Promise.all([
        this.deps.stages.transcribing(input, this.deps.ctx),
        this.deps.stages.diarizing(input, this.deps.ctx),
      ]);
      stage = 'merging';
    } else if (stage === 'transcribing' || stage === 'diarizing') {
      // Single-stage re-run: run only the requested one, then continue linearly.
      this.deps.ctx.meetings.updateStage(meetingId, stage);
      if (stage === 'transcribing') await this.deps.stages.transcribing(input, this.deps.ctx);
      if (stage === 'diarizing') await this.deps.stages.diarizing(input, this.deps.ctx);
      stage = 'merging';
    }

    const linear = ['merging', 'identifying', 'summarizing', 'extracting'] as const;
    const startIdx = linear.indexOf(stage as (typeof linear)[number]);
    if (startIdx >= 0) {
      for (let i = startIdx; i < linear.length; i++) {
        const s = linear[i]!;
        this.deps.ctx.meetings.updateStage(meetingId, s);
        await this.deps.stages[s](input, this.deps.ctx);
      }
    }
    this.deps.ctx.meetings.updateStage(meetingId, 'done');
    this.deps.ctx.meetings.updateStatus(meetingId, 'done');
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- pipeline/pipeline`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/pipeline.ts electron/main/pipeline/pipeline.test.ts
git commit -m "pipeline: orchestrator with queue + parallel transcribe/diarize"
```

---

### Task 42: Crash recovery

**Files:**
- Create: `electron/main/pipeline/recovery.ts`, `electron/main/pipeline/recovery.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../storage/db';
import { MeetingsRepo } from '../storage/meetings-repo';
import { recoverPendingMeetings } from './recovery';

describe('recoverPendingMeetings', () => {
  it('rolls non-terminal meetings back one stage and enqueues them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-rec-'));
    const db = openDb(path.join(dir, 'db.sqlite'));
    const meetings = new MeetingsRepo(db);
    meetings.insert({ id: 'a', slug: 'a', title: 'A', startedAt: null, durationS: null, audioPath: '/a', status: 'processing', pipelineStage: 'transcribing' });
    meetings.insert({ id: 'b', slug: 'b', title: 'B', startedAt: null, durationS: null, audioPath: '/b', status: 'done', pipelineStage: 'done' });

    const enqueue = vi.fn();
    const logger = { info: vi.fn() };
    recoverPendingMeetings({ meetings, enqueue, logger } as any);

    expect(meetings.findById('a')?.pipelineStage).toBe('discovered');
    expect(enqueue).toHaveBeenCalledWith('a');
    expect(enqueue).not.toHaveBeenCalledWith('b');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- pipeline/recovery`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/pipeline/recovery.ts
import type { MeetingsRepo } from '../storage/meetings-repo';
import type { Logger } from '../logging/logger';
import { previousCompletedOnCrash, type Stage } from '../lib/stage-machine';

export interface RecoveryDeps {
  meetings: MeetingsRepo;
  enqueue: (meetingId: string) => void;
  logger: Logger;
}

export function recoverPendingMeetings(deps: RecoveryDeps): void {
  for (const m of deps.meetings.findNonTerminal()) {
    const rolled = previousCompletedOnCrash(m.pipelineStage as Stage);
    if (rolled !== m.pipelineStage) deps.meetings.updateStage(m.id, rolled);
    deps.logger.info('recovery:resume', { meetingId: m.id, from: rolled });
    deps.enqueue(m.id);
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- pipeline/recovery`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/pipeline/recovery.ts electron/main/pipeline/recovery.test.ts
git commit -m "pipeline: crash recovery on startup"
```

---

## PHASE 9: Exporters

### Task 43: Exporter interface + Markdown exporter

**Files:**
- Create: `electron/main/exporters/interface.ts`, `electron/main/exporters/markdown.ts`, `electron/main/exporters/markdown.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarkdownExporter } from './markdown';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('MarkdownExporter', () => {
  it('writes a markdown file with items as a checklist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-md-')); dirs.push(dir);
    const exp = new MarkdownExporter();
    const outPath = await exp.export({
      items: [
        { id: '1', text: 'do A', ownerName: 'Dan', dueDate: '2026-04-22', status: 'open' },
        { id: '2', text: 'do B', ownerName: null, dueDate: null, status: 'done' },
      ],
      meetingTitle: 'Q2',
      meetingFolder: dir,
    });
    const md = fs.readFileSync(outPath, 'utf8');
    expect(md).toContain('# Q2 — Action Items');
    expect(md).toContain('- [ ] do A — Dan — due 2026-04-22');
    expect(md).toContain('- [x] do B');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- exporters/markdown`
Expected: FAIL.

- [ ] **Step 3: Implement interface**

```ts
// electron/main/exporters/interface.ts
export interface ExportableItem {
  id: string; text: string; ownerName: string | null; dueDate: string | null; status: string;
}
export interface ExportInput {
  items: ExportableItem[];
  meetingTitle: string;
  meetingFolder: string;
}
export interface Exporter {
  name: string;
  export(input: ExportInput): Promise<string>; // returns a user-facing result path or id
}
```

- [ ] **Step 4: Implement Markdown exporter**

```ts
// electron/main/exporters/markdown.ts
import fs from 'node:fs';
import path from 'node:path';
import type { ExportInput, Exporter } from './interface';

export class MarkdownExporter implements Exporter {
  name = 'markdown';

  async export(input: ExportInput): Promise<string> {
    const lines: string[] = [`# ${input.meetingTitle} — Action Items`, ''];
    for (const it of input.items) {
      const box = it.status === 'done' ? '[x]' : '[ ]';
      const parts = [it.text];
      if (it.ownerName) parts.push(it.ownerName);
      if (it.dueDate) parts.push(`due ${it.dueDate}`);
      lines.push(`- ${box} ${parts.join(' — ')}`);
    }
    const out = path.join(input.meetingFolder, 'exports', 'action-items.md');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, lines.join('\n'));
    return out;
  }
}
```

- [ ] **Step 5: Run, expect pass**

Run: `npm test -- exporters/markdown`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add electron/main/exporters/interface.ts electron/main/exporters/markdown.ts electron/main/exporters/markdown.test.ts
git commit -m "exporters: interface + Markdown exporter"
```

---

### Task 44: Apple Reminders exporter

**Files:**
- Create: `electron/main/exporters/apple-reminders.ts`, `electron/main/exporters/apple-reminders.test.ts`

- [ ] **Step 1: Write failing test (injected runner)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { AppleRemindersExporter } from './apple-reminders';

describe('AppleRemindersExporter', () => {
  it('creates one reminder per item via osascript', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const exp = new AppleRemindersExporter({ runner, listName: 'MeetingNotes' });
    await exp.export({
      items: [
        { id: '1', text: 'do A', ownerName: 'Dan', dueDate: '2026-04-22', status: 'open' },
        { id: '2', text: 'do B', ownerName: null, dueDate: null, status: 'done' },
      ],
      meetingTitle: 'Q2',
      meetingFolder: '/tmp',
    });
    // Called once per open item only (skip 'done')
    expect(runner).toHaveBeenCalledTimes(1);
    const [cmd, args] = runner.mock.calls[0]!;
    expect(cmd).toBe('osascript');
    expect((args as string[]).join(' ')).toContain('do A');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- exporters/apple-reminders`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/exporters/apple-reminders.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Exporter, ExportInput } from './interface';

const pExecFile = promisify(execFile);
type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultRunner: Runner = (c, a) => pExecFile(c, a, { timeout: 10000 });

export class AppleRemindersExporter implements Exporter {
  name = 'reminders';
  private readonly runner: Runner;
  private readonly listName: string;

  constructor(deps: { runner?: Runner; listName?: string } = {}) {
    this.runner = deps.runner ?? defaultRunner;
    this.listName = deps.listName ?? 'MeetingNotes';
  }

  async export(input: ExportInput): Promise<string> {
    const list = this.listName.replace(/"/g, '\\"');
    const open = input.items.filter((i) => i.status !== 'done');
    for (const it of open) {
      const body = it.text.replace(/"/g, '\\"');
      const nameParts = [body];
      if (it.ownerName) nameParts.push(`(${it.ownerName})`);
      const name = nameParts.join(' ');
      const due = it.dueDate ? `, remind me date: date "${it.dueDate}"` : '';
      const script = `tell application "Reminders" to make new reminder at list "${list}" with properties {name:"${name}"${due}}`;
      const { stderr } = await this.runner('osascript', ['-e', script]);
      if (stderr.trim()) throw new Error(`Reminders export failed: ${stderr.trim()}`);
    }
    return `${open.length} reminders added to "${this.listName}"`;
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- exporters/apple-reminders`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/exporters/apple-reminders.ts electron/main/exporters/apple-reminders.test.ts
git commit -m "exporters: Apple Reminders via osascript"
```

---

### Task 45: Google Tasks stub

**Files:**
- Create: `electron/main/exporters/google-tasks-stub.ts`, `electron/main/exporters/google-tasks-stub.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { GoogleTasksStub } from './google-tasks-stub';

describe('GoogleTasksStub', () => {
  it('throws NotImplemented so UI can surface "coming soon"', async () => {
    const exp = new GoogleTasksStub();
    await expect(exp.export({ items: [], meetingTitle: 'x', meetingFolder: '/' }))
      .rejects.toThrow(/not implemented/i);
  });
  it('name is "google-tasks"', () => { expect(new GoogleTasksStub().name).toBe('google-tasks'); });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- exporters/google-tasks-stub`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/exporters/google-tasks-stub.ts
import type { Exporter } from './interface';

export class GoogleTasksStub implements Exporter {
  name = 'google-tasks';
  async export(): Promise<string> {
    throw new Error('Google Tasks exporter not implemented yet');
  }
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- exporters/google-tasks-stub`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/exporters/google-tasks-stub.ts electron/main/exporters/google-tasks-stub.test.ts
git commit -m "exporters: Google Tasks stub"
```

---

### Task 46: Exporter registry

**Files:**
- Create: `electron/main/exporters/registry.ts`

- [ ] **Step 1: Implement**

```ts
// electron/main/exporters/registry.ts
import type { Exporter } from './interface';
import { MarkdownExporter } from './markdown';
import { AppleRemindersExporter } from './apple-reminders';
import { GoogleTasksStub } from './google-tasks-stub';

export function buildExporterRegistry(): Record<string, Exporter> {
  return {
    markdown: new MarkdownExporter(),
    reminders: new AppleRemindersExporter(),
    'google-tasks': new GoogleTasksStub(),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add electron/main/exporters/registry.ts
git commit -m "exporters: registry for UI lookup"
```

---

## PHASE 10: IPC Layer

### Task 47: IPC contracts (zod schemas + request/response types)

**Files:**
- Create: `electron/main/ipc/contracts.ts`

- [ ] **Step 1: Implement**

```ts
// electron/main/ipc/contracts.ts
import { z } from 'zod';

export const MeetingSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  startedAt: z.string().nullable(),
  durationS: z.number().nullable(),
  pipelineStage: z.string(),
  status: z.string(),
  unidentifiedCount: z.number(),
  actionItemsCount: z.number(),
  speakers: z.array(z.object({
    localLabel: z.string(),
    rosterId: z.string().nullable(),
    displayName: z.string().nullable(),
    confidence: z.number().nullable(),
  })),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

export const MeetingDetailSchema = MeetingSummarySchema.extend({
  transcriptMd: z.string().nullable(),
  summaryMd: z.string().nullable(),
  audioPath: z.string(),
  actionItems: z.array(z.object({
    id: z.string(),
    text: z.string(),
    ownerName: z.string().nullable(),
    dueDate: z.string().nullable(),
    status: z.string(),
    exportedTo: z.array(z.string()),
  })),
  models: z.object({ stt: z.string().optional(), llm: z.string().optional() }),
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

export const IPC_CHANNELS = {
  meetingsList: 'meetings:list',
  meetingsGet: 'meetings:get',
  meetingsRename: 'meetings:rename',
  meetingsRerun: 'meetings:rerun',
  recordStart: 'record:start',
  recordStop: 'record:stop',
  recordState: 'record:state',
  speakersList: 'speakers:list',
  speakersConfirm: 'speakers:confirm',
  speakersRename: 'speakers:rename',
  actionItemsSetStatus: 'action-items:set-status',
  exportRun: 'export:run',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  modelsList: 'models:list',
  activity: 'activity:subscribe',
  meetingChanged: 'event:meeting-changed',
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add electron/main/ipc/contracts.ts
git commit -m "ipc: contracts (zod + channel names)"
```

---

### Task 48: Main-side IPC handlers

**Files:**
- Create: `electron/main/ipc/handlers.ts`, `electron/main/ipc/handlers.test.ts`

- [ ] **Step 1: Write failing test (exercises the registerHandlers wiring with a fake ipcMain)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerIpcHandlers } from './handlers';

describe('registerIpcHandlers', () => {
  it('registers all known channels', () => {
    const handle = vi.fn();
    const fakeIpc = { handle } as any;
    const services: any = {
      meetings: { listAll: () => [] },
      speakers: { list: () => [] },
      actionItems: { listByMeeting: () => [] },
      settings: { getAll: () => ({}), get: () => '', set: () => {} },
      lmStudio: { listModels: async () => [] },
      audioHijack: { startSession: async () => {}, stopSession: async () => {}, sessionState: async () => 'stopped' },
      roster: { confirmSpeaker: () => 'id', confirmSpeakerFor: () => {} },
      pipeline: { enqueue: () => {} },
      exporters: {},
      libraryRoot: '/tmp',
    };
    registerIpcHandlers(fakeIpc, services);
    // Every channel gets a handler
    const channels = handle.mock.calls.map((c) => c[0]);
    expect(channels).toContain('meetings:list');
    expect(channels).toContain('meetings:get');
    expect(channels).toContain('export:run');
    expect(channels).toContain('models:list');
  });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npm test -- ipc/handlers`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/handlers.ts
import type { IpcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC_CHANNELS } from './contracts';
import type { MeetingsRepo } from '../storage/meetings-repo';
import type { SpeakersRepo } from '../storage/speakers-repo';
import type { ActionItemsRepo } from '../storage/action-items-repo';
import type { SettingsRepo, Settings } from '../storage/settings-repo';
import type { LMStudioClient } from '../lm-studio/client';
import type { AudioHijackBridge } from '../audio-hijack/bridge';
import type { RosterService } from '../speakers/roster-service';
import type { Pipeline } from '../pipeline/pipeline';
import type { Exporter } from '../exporters/interface';
import { meetingFolderPath } from '../storage/meeting-folder';

export interface IpcServices {
  meetings: MeetingsRepo;
  speakers: SpeakersRepo;
  actionItems: ActionItemsRepo;
  settings: SettingsRepo;
  lmStudio: LMStudioClient;
  audioHijack: AudioHijackBridge;
  roster: RosterService;
  pipeline: Pipeline;
  exporters: Record<string, Exporter>;
  libraryRoot: string;
}

export function registerIpcHandlers(ipc: IpcMain, s: IpcServices): void {
  ipc.handle(IPC_CHANNELS.meetingsList, () => {
    return s.meetings.listAll().map((m) => ({
      id: m.id, slug: m.slug, title: m.title,
      startedAt: m.startedAt, durationS: m.durationS,
      pipelineStage: m.pipelineStage, status: m.status,
      unidentifiedCount: 0, // filled by join in real impl
      actionItemsCount: s.actionItems.listByMeeting(m.id).length,
      speakers: [], // populated by meetingsGet
    }));
  });

  ipc.handle(IPC_CHANNELS.meetingsGet, (_e, id: string) => {
    const m = s.meetings.findById(id);
    if (!m) return null;
    const folder = meetingFolderPath(s.libraryRoot, m.slug);
    const read = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    return {
      ...m, slug: m.slug,
      unidentifiedCount: 0,
      actionItemsCount: s.actionItems.listByMeeting(id).length,
      speakers: [],
      transcriptMd: read(path.join(folder, 'transcript.md')),
      summaryMd: read(path.join(folder, 'summary.md')),
      audioPath: m.audioPath,
      actionItems: s.actionItems.listByMeeting(id).map((ai) => ({
        id: ai.id, text: ai.text, ownerName: null,
        dueDate: ai.dueDate, status: ai.status, exportedTo: ai.exportedTo,
      })),
      models: {},
    };
  });

  ipc.handle(IPC_CHANNELS.meetingsRename, (_e, id: string, title: string) => s.meetings.updateTitle(id, title));

  ipc.handle(IPC_CHANNELS.meetingsRerun, (_e, id: string, fromStage: string) => {
    s.meetings.updateStage(id, fromStage);
    s.pipeline.enqueue(id);
  });

  ipc.handle(IPC_CHANNELS.recordStart, async (_e, sessionName: string) => s.audioHijack.startSession(sessionName));
  ipc.handle(IPC_CHANNELS.recordStop, async (_e, sessionName: string) => s.audioHijack.stopSession(sessionName));
  ipc.handle(IPC_CHANNELS.recordState, async (_e, sessionName: string) => s.audioHijack.sessionState(sessionName));

  ipc.handle(IPC_CHANNELS.speakersList, () => s.speakers.list());
  ipc.handle(IPC_CHANNELS.speakersConfirm, (_e, input: { meetingId: string; localLabel: string; displayName: string; embedding: number[] }) => {
    const id = s.roster.confirmSpeaker({ displayName: input.displayName, embedding: input.embedding });
    s.speakers.linkToMeeting(input.meetingId, input.localLabel, id, 1.0);
    return id;
  });
  ipc.handle(IPC_CHANNELS.speakersRename, (_e, id: string, name: string) => s.speakers.rename(id, name));

  ipc.handle(IPC_CHANNELS.actionItemsSetStatus, (_e, id: string, status: string) => s.actionItems.setStatus(id, status));

  ipc.handle(IPC_CHANNELS.exportRun, async (_e, input: { exporter: string; meetingId: string }) => {
    const meeting = s.meetings.findById(input.meetingId);
    if (!meeting) throw new Error('meeting not found');
    const folder = meetingFolderPath(s.libraryRoot, meeting.slug);
    const items = s.actionItems.listByMeeting(input.meetingId).map((ai) => ({
      id: ai.id, text: ai.text, ownerName: null, dueDate: ai.dueDate, status: ai.status,
    }));
    const exporter = s.exporters[input.exporter];
    if (!exporter) throw new Error(`unknown exporter: ${input.exporter}`);
    const result = await exporter.export({ items, meetingTitle: meeting.title, meetingFolder: folder });
    for (const it of items) s.actionItems.markExported(it.id, input.exporter);
    return result;
  });

  ipc.handle(IPC_CHANNELS.settingsGet, () => s.settings.getAll());
  ipc.handle(IPC_CHANNELS.settingsSet, <K extends keyof Settings>(_e: unknown, key: K, value: Settings[K]) => s.settings.set(key, value));

  ipc.handle(IPC_CHANNELS.modelsList, async () => {
    try { return await s.lmStudio.listModels(); }
    catch { return []; }
  });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npm test -- ipc/handlers`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/handlers.ts electron/main/ipc/handlers.test.ts
git commit -m "ipc: main-side handlers for all channels"
```

---

### Task 49: Preload bridge + renderer client

**Files:**
- Modify: `electron/preload/index.ts`
- Create: `electron/renderer/src/ipc/client.ts`

- [ ] **Step 1: Implement preload**

```ts
// electron/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc/contracts';

const api = {
  meetings: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.meetingsList),
    get: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsGet, id),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsRename, id, title),
    rerun: (id: string, fromStage: string) => ipcRenderer.invoke(IPC_CHANNELS.meetingsRerun, id, fromStage),
  },
  record: {
    start: (sessionName: string) => ipcRenderer.invoke(IPC_CHANNELS.recordStart, sessionName),
    stop: (sessionName: string) => ipcRenderer.invoke(IPC_CHANNELS.recordStop, sessionName),
    state: (sessionName: string) => ipcRenderer.invoke(IPC_CHANNELS.recordState, sessionName),
  },
  speakers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.speakersList),
    confirm: (input: { meetingId: string; localLabel: string; displayName: string; embedding: number[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS.speakersConfirm, input),
    rename: (id: string, name: string) => ipcRenderer.invoke(IPC_CHANNELS.speakersRename, id, name),
  },
  actionItems: {
    setStatus: (id: string, status: string) => ipcRenderer.invoke(IPC_CHANNELS.actionItemsSetStatus, id, status),
  },
  export: {
    run: (exporter: string, meetingId: string) => ipcRenderer.invoke(IPC_CHANNELS.exportRun, { exporter, meetingId }),
  },
  settings: {
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (key: string, value: unknown) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, key, value),
  },
  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList),
  },
  on: (channel: string, handler: (...args: unknown[]) => void) => {
    const wrapped = (_e: unknown, ...args: unknown[]) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);
export type MeetingNotesApi = typeof api;
```

- [ ] **Step 2: Implement renderer-side typed wrapper**

```ts
// electron/renderer/src/ipc/client.ts
import type { MeetingNotesApi } from '../../../preload';

declare global {
  interface Window { api: MeetingNotesApi; }
}

export const api: MeetingNotesApi = window.api;
```

- [ ] **Step 3: Commit**

```bash
git add electron/preload/index.ts electron/renderer/src/ipc/client.ts
git commit -m "ipc: preload bridge + renderer typed client"
```

---

## PHASE 11: Renderer UI

(Clean Studio theme. All components consume `window.api` via `@renderer/ipc/client`. Use `mockups/index.html` as the visual reference.)

### Task 50: Zustand meetings store

**Files:**
- Create: `electron/renderer/src/store/meetings.ts`

- [ ] **Step 1: Implement**

```ts
// electron/renderer/src/store/meetings.ts
import { create } from 'zustand';
import { api } from '../ipc/client';

interface MeetingSummary {
  id: string; slug: string; title: string;
  startedAt: string | null; durationS: number | null;
  pipelineStage: string; status: string;
  unidentifiedCount: number; actionItemsCount: number;
  speakers: { localLabel: string; rosterId: string | null; displayName: string | null; confidence: number | null }[];
}

interface MeetingsState {
  meetings: MeetingSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useMeetingsStore = create<MeetingsState>((set) => ({
  meetings: [],
  loading: false,
  refresh: async () => {
    set({ loading: true });
    const list = (await api.meetings.list()) as MeetingSummary[];
    set({ meetings: list, loading: false });
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add electron/renderer/src/store/meetings.ts
git commit -m "renderer: zustand meetings store"
```

---

### Task 51: Library view

**Files:**
- Create: `electron/renderer/src/views/LibraryView.tsx`, `electron/renderer/src/components/MeetingCard.tsx`, `electron/renderer/src/components/RecordButton.tsx`

- [ ] **Step 1: Implement RecordButton**

```tsx
// electron/renderer/src/components/RecordButton.tsx
import { useState } from 'react';
import { api } from '../ipc/client';

export function RecordButton({ sessionName }: { sessionName: string }): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    try {
      if (recording) { await api.record.stop(sessionName); setRecording(false); }
      else { await api.record.start(sessionName); setRecording(true); }
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <>
      <button
        onClick={toggle}
        className={`rounded-xl px-5 py-2 text-sm font-semibold text-white shadow-card
          ${recording ? 'bg-red-500 animate-pulse' : 'bg-gradient-to-br from-brand-indigo to-brand-violet'}`}
      >
        {recording ? '■ Stop' : '⏺ Record'}
      </button>
      {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
    </>
  );
}
```

- [ ] **Step 2: Implement MeetingCard**

```tsx
// electron/renderer/src/components/MeetingCard.tsx
import { colorForSpeakerIndex } from '../theme/tokens';

interface Props {
  meeting: {
    id: string; title: string; startedAt: string | null; durationS: number | null;
    pipelineStage: string; unidentifiedCount: number; actionItemsCount: number;
    speakers: { localLabel: string; displayName: string | null }[];
  };
  onOpen: (id: string) => void;
}

function fmtDur(s: number | null): string {
  if (s === null) return '';
  const m = Math.floor(s / 60); const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}m ${sec}s`;
}

export function MeetingCard({ meeting, onOpen }: Props): JSX.Element {
  const processing = meeting.pipelineStage !== 'done';
  return (
    <div
      onClick={() => onOpen(meeting.id)}
      className="bg-surface border border-surface-border rounded-xl p-4 flex items-center gap-4 cursor-pointer hover:-translate-y-px hover:border-brand-indigo hover:shadow-pop transition"
    >
      <div className="flex">
        {meeting.speakers.slice(0, 4).map((sp, i) => (
          <div key={i} style={{ background: colorForSpeakerIndex(i), marginLeft: i === 0 ? 0 : -6 }}
               className="w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center border-2 border-surface">
            {(sp.displayName?.[0] ?? '?').toUpperCase()}
          </div>
        ))}
      </div>
      <div className="flex-1">
        <div className="font-semibold text-sm">{meeting.title}</div>
        <div className="text-xs text-ink-muted">
          {meeting.startedAt?.slice(0, 10) ?? ''} · {fmtDur(meeting.durationS)}
          {meeting.unidentifiedCount > 0 && (
            <span className="ml-1 text-status-warnText">· {meeting.unidentifiedCount} to identify</span>
          )}
        </div>
      </div>
      {meeting.actionItemsCount > 0 && (
        <div className="bg-brand-indigo text-white text-xs font-semibold px-2 py-0.5 rounded-xl">
          {meeting.actionItemsCount} actions
        </div>
      )}
      <span className={`text-xs font-semibold px-2 py-0.5 rounded-xl
        ${processing ? 'bg-status-processingBg text-status-processing' : 'bg-status-okBg text-status-ok'}`}>
        {processing ? meeting.pipelineStage.toUpperCase() : 'DONE'}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Implement LibraryView**

```tsx
// electron/renderer/src/views/LibraryView.tsx
import { useEffect, useState } from 'react';
import { useMeetingsStore } from '../store/meetings';
import { MeetingCard } from '../components/MeetingCard';
import { RecordButton } from '../components/RecordButton';

interface Props { onOpen: (id: string) => void; onSettings: () => void; }

export function LibraryView({ onOpen, onSettings }: Props): JSX.Element {
  const { meetings, refresh } = useMeetingsStore();
  const [query, setQuery] = useState('');

  useEffect(() => { void refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [refresh]);

  const visible = meetings.filter((m) => m.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="max-w-5xl mx-auto p-8">
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-lg font-semibold flex-1">MeetingNotes</h1>
        <RecordButton sessionName="Meeting" />
        <button onClick={onSettings} className="text-ink-muted hover:text-ink px-2">⚙</button>
      </div>
      <input placeholder="Search meetings, speakers, topics…"
             value={query} onChange={(e) => setQuery(e.target.value)}
             className="w-full p-3 border border-surface-border rounded-xl mb-4 text-sm" />
      {visible.length === 0 && <div className="text-ink-muted text-sm py-8 text-center">Hit Record or drop an MP3 in ~/Music/Audio Hijack.</div>}
      <div className="space-y-2">
        {visible.map((m) => <MeetingCard key={m.id} meeting={m} onOpen={onOpen} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/src/views/LibraryView.tsx electron/renderer/src/components/MeetingCard.tsx electron/renderer/src/components/RecordButton.tsx
git commit -m "renderer: library view + meeting cards + record button"
```

---

### Task 52: Meeting detail view — layout + tabs

**Files:**
- Create: `electron/renderer/src/views/MeetingDetailView.tsx`

- [ ] **Step 1: Implement**

```tsx
// electron/renderer/src/views/MeetingDetailView.tsx
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

type Tab = 'summary' | 'transcript' | 'audio';

interface MeetingDetail {
  id: string; title: string; startedAt: string | null; durationS: number | null;
  pipelineStage: string; transcriptMd: string | null; summaryMd: string | null;
  audioPath: string; speakers: { localLabel: string; rosterId: string | null; displayName: string | null }[];
  actionItems: { id: string; text: string; ownerName: string | null; dueDate: string | null; status: string; exportedTo: string[] }[];
  models: { stt?: string; llm?: string };
}

export function MeetingDetailView({ id, onBack }: { id: string; onBack: () => void }): JSX.Element {
  const [m, setM] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<Tab>('summary');

  useEffect(() => {
    let alive = true;
    async function load(): Promise<void> {
      const d = (await api.meetings.get(id)) as MeetingDetail;
      if (alive) setM(d);
    }
    void load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  if (!m) return <div className="p-8 text-ink-muted">Loading…</div>;

  return (
    <div className="max-w-6xl mx-auto my-6 bg-surface rounded-xl shadow-pop border border-surface-border overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-surface-border">
        <button onClick={onBack} className="text-ink-muted hover:text-ink text-sm">← Library</button>
        <div className="flex-1 text-center font-semibold">{m.title}</div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-xl
          ${m.pipelineStage === 'done' ? 'bg-status-okBg text-status-ok' : 'bg-status-processingBg text-status-processing'}`}>
          {m.pipelineStage.toUpperCase()}
        </span>
      </div>

      <div className="grid grid-cols-[220px_1fr_240px] min-h-[560px]">
        <LeftRail meeting={m} />
        <CenterPane meeting={m} tab={tab} onTab={setTab} />
        <RightRail meeting={m} />
      </div>
    </div>
  );
}

function LeftRail({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  return (
    <div className="border-r border-surface-border p-4 space-y-3">
      <div>
        <div className="text-xs font-bold text-ink-muted uppercase">Title</div>
        <div className="font-semibold">{meeting.title}</div>
      </div>
      <div>
        <div className="text-xs font-bold text-ink-muted uppercase">Date</div>
        <div className="text-sm">{meeting.startedAt?.slice(0, 10) ?? '—'}</div>
      </div>
      <div>
        <div className="text-xs font-bold text-ink-muted uppercase">Models</div>
        {meeting.models.stt && <div className="text-xs">STT: {meeting.models.stt}</div>}
        {meeting.models.llm && <div className="text-xs">LLM: {meeting.models.llm}</div>}
      </div>
      <div className="pt-3 border-t border-surface-border space-y-1">
        <div className="text-xs font-bold text-ink-muted uppercase mb-1">Re-run</div>
        {(['transcribing', 'diarizing', 'summarizing'] as const).map((stage) => (
          <button key={stage} onClick={() => api.meetings.rerun(meeting.id, stage)}
                  className="w-full text-left bg-surface-sunken border border-surface-border rounded-lg py-1 px-2 text-xs hover:border-brand-indigo hover:text-brand-indigo">
            ↻ {stage}
          </button>
        ))}
      </div>
    </div>
  );
}

function CenterPane({ meeting, tab, onTab }: { meeting: MeetingDetail; tab: Tab; onTab: (t: Tab) => void }): JSX.Element {
  return (
    <div>
      <div className="flex border-b border-surface-border px-4">
        {(['summary', 'transcript', 'audio'] as const).map((t) => (
          <button key={t} onClick={() => onTab(t)}
                  className={`px-3 py-3 text-sm ${tab === t ? 'text-brand-indigo border-b-2 border-brand-indigo font-semibold' : 'text-ink-muted'}`}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="p-5">
        {tab === 'summary' && (
          <div className="prose prose-sm max-w-none whitespace-pre-wrap">{meeting.summaryMd ?? 'No summary yet.'}</div>
        )}
        {tab === 'transcript' && (
          <pre className="text-sm whitespace-pre-wrap leading-relaxed">{meeting.transcriptMd ?? 'No transcript yet.'}</pre>
        )}
        {tab === 'audio' && (
          <audio controls src={`file://${meeting.audioPath}`} className="w-full" />
        )}
      </div>
    </div>
  );
}

function RightRail({ meeting }: { meeting: MeetingDetail }): JSX.Element {
  async function runExport(which: string): Promise<void> {
    try { await api.export.run(which, meeting.id); } catch (e) { alert((e as Error).message); }
  }
  return (
    <div className="border-l border-surface-border p-4 space-y-3">
      <div className="text-xs font-bold text-ink-muted uppercase">Speakers</div>
      {meeting.speakers.map((sp) => (
        <div key={sp.localLabel} className={`rounded-lg p-2 ${sp.rosterId ? 'bg-surface-sunken' : 'bg-status-warnBg border border-dashed border-status-warn'}`}>
          <div className="text-sm font-semibold">{sp.displayName ?? sp.localLabel}</div>
        </div>
      ))}
      <div className="pt-3 border-t border-surface-border space-y-2">
        <div className="text-xs font-bold text-ink-muted uppercase">Export</div>
        <button onClick={() => runExport('reminders')} className="w-full bg-brand-indigo text-white text-xs font-semibold rounded-lg py-2">→ Apple Reminders</button>
        <button onClick={() => runExport('markdown')} className="w-full bg-surface border border-surface-border text-xs font-semibold rounded-lg py-2">↓ Markdown</button>
        <button disabled className="w-full bg-surface-sunken text-ink-muted text-xs font-semibold rounded-lg py-2 cursor-not-allowed">→ Google Tasks (soon)</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add electron/renderer/src/views/MeetingDetailView.tsx
git commit -m "renderer: meeting detail view with three-pane layout"
```

---

### Task 53: App shell (navigation between Library / Detail / Settings)

**Files:**
- Modify: `electron/renderer/src/App.tsx`
- Create: `electron/renderer/src/views/SettingsView.tsx`

- [ ] **Step 1: Implement App.tsx**

```tsx
// electron/renderer/src/App.tsx
import { useState } from 'react';
import { LibraryView } from './views/LibraryView';
import { MeetingDetailView } from './views/MeetingDetailView';
import { SettingsView } from './views/SettingsView';

type View = { kind: 'library' } | { kind: 'detail'; id: string } | { kind: 'settings' };

export function App(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'library' });
  if (view.kind === 'library')
    return <LibraryView onOpen={(id) => setView({ kind: 'detail', id })} onSettings={() => setView({ kind: 'settings' })} />;
  if (view.kind === 'detail')
    return <MeetingDetailView id={view.id} onBack={() => setView({ kind: 'library' })} />;
  return <SettingsView onBack={() => setView({ kind: 'library' })} />;
}
```

- [ ] **Step 2: Implement SettingsView**

```tsx
// electron/renderer/src/views/SettingsView.tsx
import { useEffect, useState } from 'react';
import { api } from '../ipc/client';

interface Settings {
  lmStudioUrl: string; sttModel: string; llmModel: string;
  audioHijackSessionName: string; libraryPath: string; audioWatchPath: string;
  sttLanguage: string; exporterApple: boolean; exporterMarkdown: boolean;
}

export function SettingsView({ onBack }: { onBack: () => void }): JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      setS((await api.settings.getAll()) as Settings);
      setModels((await api.models.list()) as string[]);
    })();
  }, []);

  if (!s) return <div className="p-8">Loading…</div>;

  async function update<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    setS((prev) => prev ? { ...prev, [key]: value } : prev);
    await api.settings.set(key, value);
  }

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-ink-muted text-sm">← Back</button>
        <h1 className="font-semibold">Settings</h1>
      </div>

      <Field label="LM Studio URL"><input value={s.lmStudioUrl} onChange={(e) => update('lmStudioUrl', e.target.value)} className="input" /></Field>
      <Field label="STT Model">
        <select value={s.sttModel} onChange={(e) => update('sttModel', e.target.value)} className="input">
          <option value="">(choose)</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="LLM Model">
        <select value={s.llmModel} onChange={(e) => update('llmModel', e.target.value)} className="input">
          <option value="">(choose)</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Audio Hijack Session Name">
        <input value={s.audioHijackSessionName} onChange={(e) => update('audioHijackSessionName', e.target.value)} className="input" />
      </Field>
      <Field label="Library Path"><input value={s.libraryPath} onChange={(e) => update('libraryPath', e.target.value)} className="input" /></Field>
      <Field label="Audio Watch Path"><input value={s.audioWatchPath} onChange={(e) => update('audioWatchPath', e.target.value)} className="input" /></Field>
      <Field label="STT Language"><input value={s.sttLanguage} onChange={(e) => update('sttLanguage', e.target.value)} className="input" /></Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <div className="text-xs font-bold text-ink-muted uppercase mb-1">{label}</div>
      {children}
    </label>
  );
}
```

Add to `index.css`:

```css
.input { @apply w-full p-2 border border-surface-border rounded-lg text-sm bg-surface; }
```

- [ ] **Step 3: Commit**

```bash
git add electron/renderer/src/App.tsx electron/renderer/src/views/SettingsView.tsx electron/renderer/src/index.css
git commit -m "renderer: app shell + settings view"
```

---

### Task 54: Wire up main process to instantiate all services + register IPC

**Files:**
- Modify: `electron/main/index.ts`

- [ ] **Step 1: Replace `electron/main/index.ts`**

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDb } from './storage/db';
import { MeetingsRepo } from './storage/meetings-repo';
import { SpeakersRepo } from './storage/speakers-repo';
import { ActionItemsRepo } from './storage/action-items-repo';
import { SettingsRepo } from './storage/settings-repo';
import { LMStudioClient } from './lm-studio/client';
import { DiarizationClient } from './diarization/client';
import { DiarizationSupervisor } from './diarization/supervisor';
import { AudioHijackBridge } from './audio-hijack/bridge';
import { LibraryWatcher } from './library/watcher';
import { RosterService } from './speakers/roster-service';
import { Pipeline } from './pipeline/pipeline';
import { recoverPendingMeetings } from './pipeline/recovery';
import { runTranscribing } from './pipeline/stages/transcribing';
import { runDiarizing } from './pipeline/stages/diarizing';
import { runMerging } from './pipeline/stages/merging';
import { runIdentifying } from './pipeline/stages/identifying';
import { runSummarizing } from './pipeline/stages/summarizing';
import { runExtracting } from './pipeline/stages/extracting';
import { registerIpcHandlers } from './ipc/handlers';
import { buildExporterRegistry } from './exporters/registry';
import { Logger } from './logging/logger';
import { createMeetingFolder } from './storage/meeting-folder';
import { parseAudioHijackFilename } from './lib/title-from-filename';
import { makeSlug, shortId } from './lib/slug';
import { probeAudio } from './library/ffprobe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1200, height: 800, titleBarStyle: 'hiddenInset', backgroundColor: '#fafaf9',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (isDev) await win.loadURL('http://localhost:5173');
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

app.whenReady().then(async () => {
  const settingsDb = openDb(path.join(os.homedir(), 'Documents', 'MeetingNotes', 'db.sqlite'));
  const settings = new SettingsRepo(settingsDb);
  const s = settings.getAll();

  const libraryRoot = s.libraryPath;
  const db = openDb(path.join(libraryRoot, 'db.sqlite'));
  const meetings = new MeetingsRepo(db);
  const speakers = new SpeakersRepo(db);
  const actionItems = new ActionItemsRepo(db);
  const logger = new Logger(path.join(os.homedir(), 'Library', 'Logs', 'MeetingNotes', 'app.log'));

  const lmStudio = new LMStudioClient(s.lmStudioUrl);
  const diarization = new DiarizationClient('http://127.0.0.1:8765');
  const supervisor = new DiarizationSupervisor({ sidecarDir: path.join(app.getAppPath(), 'sidecar'), onLog: (l) => logger.info('sidecar', { line: l }) });
  supervisor.start();

  const audioHijack = new AudioHijackBridge();
  const roster = new RosterService(speakers, libraryRoot);

  const ctx = { libraryRoot, lmStudio, diarization, meetings, speakers, actionItems, settings, roster, logger };
  const pipeline = new Pipeline({
    ctx,
    stages: {
      transcribing: runTranscribing, diarizing: runDiarizing, merging: runMerging,
      identifying: runIdentifying, summarizing: runSummarizing, extracting: runExtracting,
    },
  });

  const watcher = new LibraryWatcher({ path: s.audioWatchPath });
  watcher.onStableFile(async (audioPath) => {
    try {
      const info = await probeAudio(audioPath);
      const parsed = parseAudioHijackFilename(audioPath);
      const id = shortId();
      const dateIso = parsed.startedAtIso?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
      const slug = makeSlug(dateIso, parsed.autoTitle, id);
      createMeetingFolder(libraryRoot, slug, audioPath);
      meetings.insert({
        id, slug, title: parsed.autoTitle, startedAt: parsed.startedAtIso,
        durationS: info.durationS, audioPath, status: 'processing', pipelineStage: 'discovered',
      });
      logger.info('library:discovered', { id, slug, audioPath });
      pipeline.enqueue(id);
    } catch (e) { logger.error('library:discover-fail', { audioPath, err: String(e) }); }
  });
  await watcher.start();

  recoverPendingMeetings({ meetings, enqueue: (id) => pipeline.enqueue(id), logger } as never);

  const exporters = buildExporterRegistry();
  registerIpcHandlers(ipcMain, { meetings, speakers, actionItems, settings, lmStudio, audioHijack, roster, pipeline, exporters, libraryRoot });

  await createWindow();

  app.on('before-quit', () => { supervisor.stop(); void watcher.stop(); logger.close(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
```

- [ ] **Step 2: Verify compile**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add electron/main/index.ts
git commit -m "main: wire up services, pipeline, watcher, IPC, recovery"
```

---

## PHASE 12: Integration + Polish

### Task 55: Dev smoke-run

**Files:** none

- [ ] **Step 1: Start LM Studio manually (user step)**

User loads LM Studio, starts its server, loads a Whisper model and a chat LLM.

- [ ] **Step 2: Install sidecar venv**

```bash
cd sidecar && ./scripts/install.sh
export HF_TOKEN=<your-token>
```

- [ ] **Step 3: `npm run dev`**

Expected: Electron window opens with MeetingNotes UI, Library empty-state.

- [ ] **Step 4: Drop an MP3 into `~/Music/Audio Hijack/` and verify it appears in the library and advances through stages. Note any issues in `docs/testing.md`.**

No commit for this task — observational only.

---

### Task 56: Manual smoke-test checklist

**Files:**
- Create: `docs/testing.md`

- [ ] **Step 1: Write checklist**

```markdown
# MeetingNotes Manual Smoke Test

Run before every release.

## Preflight
- [ ] LM Studio running at configured URL
- [ ] LM Studio has a Whisper model and a chat LLM loaded
- [ ] Sidecar venv installed (`sidecar/.venv/bin/python` exists)
- [ ] `HF_TOKEN` env var set for pyannote
- [ ] Audio Hijack installed with a "Meeting" session

## Test flow
1. [ ] Launch app — Library view appears, no crashes
2. [ ] Open Settings, verify LM Studio models populate the dropdowns
3. [ ] Click Record — recording overlay shows, Audio Hijack starts
4. [ ] Click Stop — overlay closes, new meeting appears in Library with "TRANSCRIBING" pill
5. [ ] Watch meeting advance: transcribing → diarizing → merging → identifying → summarizing → extracting → DONE
6. [ ] Open meeting; verify Summary, Transcript, Audio tabs all render
7. [ ] Identify one unknown speaker via right-rail input; verify roster updates and re-running identification matches them
8. [ ] Click "→ Apple Reminders" — verify reminders appear in the "MeetingNotes" list
9. [ ] Click "↓ Markdown" — verify `<meeting-folder>/exports/action-items.md` is created
10. [ ] Re-run summary — verify `summary.md` is regenerated
11. [ ] Quit the app mid-processing; relaunch; verify the meeting resumes from the last completed stage
12. [ ] Check `~/Library/Logs/MeetingNotes/app.log` has JSON-lines entries
```

- [ ] **Step 2: Commit**

```bash
git add docs/testing.md
git commit -m "docs: manual smoke-test checklist"
```

---

### Task 57: First-run setup helper

**Files:**
- Create: `scripts/setup.sh`

- [ ] **Step 1: Implement**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "MeetingNotes first-run setup"
echo "==="

# 1. Check prerequisites
command -v node >/dev/null || { echo "ERROR: Node.js not installed"; exit 1; }
command -v python3 >/dev/null || { echo "ERROR: Python 3 not installed"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ERROR: ffmpeg not installed (brew install ffmpeg)"; exit 1; }
command -v ffprobe >/dev/null || { echo "ERROR: ffprobe not installed"; exit 1; }

# 2. npm install
echo "Installing Node deps..."
npm install

# 3. Python sidecar venv
echo "Setting up Python sidecar..."
pushd sidecar >/dev/null
./scripts/install.sh
popd >/dev/null

# 4. Library directory
LIB="${HOME}/Documents/MeetingNotes"
mkdir -p "$LIB"/meetings "$LIB"/speakers/embeddings

echo "Setup complete."
echo "Before first use:"
echo "  export HF_TOKEN=<your-huggingface-token>"
echo "  Start LM Studio and load a Whisper model and a chat LLM"
echo "Then run: npm run dev"
```

```bash
chmod +x scripts/setup.sh
```

- [ ] **Step 2: Commit**

```bash
git add scripts/setup.sh
git commit -m "scripts: first-run setup helper"
```

---

### Task 58: electron-builder packaging config

**Files:**
- Create: `electron-builder.yml`

- [ ] **Step 1: Create config**

```yaml
appId: com.dbbaskette.meetingnotes
productName: MeetingNotes
directories:
  output: release
files:
  - dist/**
  - package.json
extraResources:
  - from: sidecar
    to: sidecar
    filter:
      - "**/*"
      - "!**/__pycache__"
      - "!.venv"
mac:
  target:
    - dmg
    - zip
  category: public.app-category.productivity
  hardenedRuntime: true
```

- [ ] **Step 2: Add `dist` script to package.json scripts:**

```json
"dist": "npm run build && electron-builder --mac"
```

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml package.json
git commit -m "build: electron-builder config for macOS"
```

---

## Self-Review

After all tasks complete, verify:

- [ ] Every spec section in `docs/superpowers/specs/2026-04-17-meeting-notes-design.md` has an implementing task
- [ ] `npm test` runs all Vitest tests and they pass
- [ ] `cd sidecar && pytest` runs the Python tests and they pass
- [ ] `npm run lint` exits 0
- [ ] `npm run build` produces `dist/` without errors
- [ ] Manual smoke-test checklist (`docs/testing.md`) passes end-to-end
- [ ] No TODO/FIXME comments left in source files
- [ ] All commits follow the commit-message style established in earlier tasks

