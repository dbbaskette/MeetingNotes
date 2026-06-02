import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLogLines, tailLogFile } from './log-tail.js';

describe('parseLogLines', () => {
  it('parses well-formed JSON lines into structured entries', () => {
    const text =
      '{"ts":"2026-06-02T16:00:00.000Z","level":"error","msg":"pipeline:failure","id":"x","err":"boom"}\n';
    const [e] = parseLogLines(text, 100);
    expect(e).toEqual({
      ts: '2026-06-02T16:00:00.000Z',
      level: 'error',
      msg: 'pipeline:failure',
      data: { id: 'x', err: 'boom' },
    });
  });

  it('surfaces non-JSON lines as plain info instead of dropping them', () => {
    const [e] = parseLogLines('whisper: exited code=0\n', 100);
    expect(e).toEqual({ ts: null, level: 'info', msg: 'whisper: exited code=0' });
  });

  it('skips blank lines', () => {
    expect(parseLogLines('\n\n', 100)).toEqual([]);
  });

  it('keeps only the newest maxEntries, oldest-first', () => {
    const text = ['a', 'b', 'c', 'd'].map((m) => JSON.stringify({ msg: m })).join('\n');
    expect(parseLogLines(text, 2).map((e) => e.msg)).toEqual(['c', 'd']);
  });

  it('drops the (partial) first line when reading mid-file', () => {
    const text = 'ts":"...partial line\n{"msg":"real"}\n';
    expect(parseLogLines(text, 100, true).map((e) => e.msg)).toEqual(['real']);
  });
});

describe('tailLogFile', () => {
  it('returns [] when the file does not exist', () => {
    expect(tailLogFile('/no/such/file.log')).toEqual([]);
  });

  it('reads only the trailing maxBytes and parses whole lines from there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-log-'));
    const file = path.join(dir, 'app.log');
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ ts: `t${i}`, level: 'info', msg: `line-${i}` }),
    );
    fs.writeFileSync(file, lines.join('\n') + '\n');
    // Tiny budget forces a mid-file read; the partial first line is dropped.
    const got = tailLogFile(file, { maxBytes: 200, maxEntries: 100 });
    expect(got.length).toBeGreaterThan(0);
    expect(got.at(-1)?.msg).toBe('line-49');
    // Every returned entry parsed cleanly (no fragment leaked through).
    expect(got.every((e) => /^line-\d+$/.test(e.msg))).toBe(true);
  });
});
