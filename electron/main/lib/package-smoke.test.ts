import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageSmokeRoot } from './package-smoke.js';

it('requires explicit intent and a marked disposable root; never uses normal user data', () => {
  expect(packageSmokeRoot([], '/user/library')).toBeNull();
  expect(() => packageSmokeRoot(['--meetingnotes-package-smoke'], '/user/library')).toThrow();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-package-smoke-'));
  try {
    expect(() => packageSmokeRoot(['--meetingnotes-package-smoke'], root)).toThrow();
    fs.writeFileSync(path.join(root, 'fixture-marker'), 'synthetic-meetingnotes-package-smoke-v1');
    expect(packageSmokeRoot(['--meetingnotes-package-smoke'], root)).toBe(fs.realpathSync(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
