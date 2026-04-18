import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from './logger.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('Logger', () => {
  it('writes newline-delimited JSON with level, msg, ts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-log-')); dirs.push(dir);
    const log = new Logger(path.join(dir, 'app.log'));
    log.info('hello', { k: 1 });
    log.error('bad', { e: 'boom' });
    await new Promise<void>((resolve) => log.close(resolve));
    const lines = fs.readFileSync(path.join(dir, 'app.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]!);
    expect(a.level).toBe('info');
    expect(a.msg).toBe('hello');
    expect(a.k).toBe(1);
    expect(typeof a.ts).toBe('string');
  });
});
