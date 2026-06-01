// electron/main/search/ripgrep-search.ts
//
// Thin wrapper around the bundled ripgrep binary (@vscode/ripgrep) used
// by the Cmd+K palette (#45). Replaces the previous folder-walk that
// read every summary.md / transcript.md on every keystroke — rg's
// parallel walker + SIMD matching is dramatically faster on large
// libraries and (importantly) returns structured JSON so we don't need
// to re-tokenize anything in JS.
//
// Output shape is deliberately small: the handler in ipc/handlers.ts
// does the slug→meeting join, snippet trimming, and seconds-parse for
// transcript hits. That keeps this module dialect-free.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { rgPath as rgPathRaw } from '@vscode/ripgrep';

// In production the app is packaged into app.asar, but native binaries
// can't be exec'd from inside an asar archive. electron-builder.yml
// unpacks @vscode/ripgrep into app.asar.unpacked; we rewrite the path
// so spawn() points at the real binary. No-op in dev (no "app.asar"
// segment in the path).
const rgPath = rgPathRaw.replace(
  /[\\/]app\.asar[\\/]/,
  (m: string) => m.replace('app.asar', 'app.asar.unpacked'),
);

export interface RgMatch {
  /** Absolute path of the file the match was found in. */
  file: string;
  /** 1-based line number. */
  lineNumber: number;
  /** Full text of the matched line, trailing newline trimmed. */
  lineText: string;
}

export interface RipgrepOptions {
  /** Max matches per file. ripgrep stops scanning a file once hit. */
  maxCountPerFile?: number;
  /** Globs (rg -g) to restrict which files are searched. */
  globs?: string[];
  /** Hard timeout in ms to kill a runaway rg process. */
  timeoutMs?: number;
}

/** Run ripgrep over `searchRoot` for `query` (treated as a literal
 *  string, not a regex). Returns one entry per match line. Throws only
 *  on spawn failure; an empty result set is returned for "no matches",
 *  rg-internal errors, or a timeout (the palette should degrade
 *  gracefully — a search that errors isn't worth surfacing to the
 *  user mid-keystroke). */
export async function ripgrepSearch(
  searchRoot: string,
  query: string,
  opts: RipgrepOptions = {},
): Promise<RgMatch[]> {
  if (!query) return [];

  const args = [
    '--json',
    // Ignore the user's ~/.ripgreprc so behavior is identical across
    // machines. Surprises here would silently break search results.
    '--no-config',
    // The library root isn't a git repo, but rg still consults
    // .gitignore / .ignore if it finds one. Off for predictability.
    '--no-ignore',
    '--no-messages',
    // Fixed-string match — user-typed queries aren't regex, and any
    // accidental special chars (parentheses, periods) shouldn't blow
    // up or change result counts.
    '-F',
    '-i',
  ];
  if (opts.maxCountPerFile && opts.maxCountPerFile > 0) {
    args.push('--max-count', String(opts.maxCountPerFile));
  }
  for (const g of opts.globs ?? []) {
    args.push('-g', g);
  }
  args.push(query, searchRoot);

  return new Promise<RgMatch[]>((resolve) => {
    const matches: RgMatch[] = [];
    let stdoutBuf = '';
    let settled = false;
    const child = spawn(rgPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

    const finish = (result: RgMatch[]): void => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already dead */ }
      resolve(result);
    };

    const timer = setTimeout(
      () => finish(matches),
      opts.timeoutMs ?? 3000,
    );

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      // rg emits one JSON object per line. Buffer partial reads so a
      // chunk boundary mid-line doesn't drop a match.
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as RgEvent;
          if (evt.type === 'match') {
            const text = evt.data.lines.text ?? '';
            matches.push({
              file: evt.data.path.text,
              lineNumber: evt.data.line_number,
              lineText: text.replace(/\r?\n$/, ''),
            });
          }
        } catch { /* skip malformed events — defensive only */ }
      }
    });

    child.on('error', () => {
      clearTimeout(timer);
      finish(matches);
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(matches);
    });
  });
}

interface RgEvent {
  type: 'begin' | 'match' | 'end' | 'summary' | 'context';
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
  };
}
