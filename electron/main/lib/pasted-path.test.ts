import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { existingFolder } from './pasted-path.js';
let temp: string;
beforeEach(() => {temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-path-'));});
afterEach(() => fs.rmSync(temp, {recursive: true, force: true}));
it('validates quoted and Terminal-escaped paths without executing shell syntax', () => {
  const folder = path.join(temp, 'Mobile Documents'); fs.mkdirSync(folder);
  expect(existingFolder(`"${folder}"`)).toBe(fs.realpathSync(folder));
  expect(existingFolder(folder.replace(' ', '\\ '))).toBe(fs.realpathSync(folder));
  expect(() => existingFolder('$(touch /tmp/never-run)')).toThrow('Folder not found');
});
it('prefers a literal backslash filename when both versions exist', () => {
  const literal = path.join(temp, 'Mobile\\ Documents'); fs.mkdirSync(literal);
  fs.mkdirSync(path.join(temp, 'Mobile Documents'));
  expect(existingFolder(literal)).toBe(fs.realpathSync(literal));
});
it('rejects missing folders and regular files with an actionable error', () => {
  const file = path.join(temp, 'file'); fs.writeFileSync(file, 'text');
  expect(() => existingFolder(file)).toThrow('Choose folder');
  expect(() => existingFolder(path.join(temp, 'missing'))).toThrow('Choose folder');
});
