import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const trim = createRequire(import.meta.url)('../../../build/trim-electron-framework.cjs');
it('retains graphics fallback resources and notices while pruning unused locales', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-package-trim-'));
  try {
    const framework = path.join(dir, 'MeetingNotes.app/Contents/Frameworks/Electron Framework.framework/Versions/A');
    fs.mkdirSync(path.join(framework, 'Libraries'), { recursive: true });
    const libs = ['libvk_swiftshader.dylib', 'libGLESv2.dylib', 'libvulkan.1.dylib', 'vk_swiftshader_icd.json', 'LICENSE', 'NOTICE'];
    for (const lib of libs) fs.writeFileSync(path.join(framework, 'Libraries', lib), 'fixture');
    for (const name of ['en.lproj', 'en_GB.lproj', 'fr.lproj']) {
      fs.mkdirSync(path.join(framework, 'Resources', name), { recursive: true });
      fs.writeFileSync(path.join(framework, 'Resources', name, 'strings'), 'fixture');
    }
    await trim({ appOutDir: dir, packager: { appInfo: { productFilename: 'MeetingNotes' } } });
    expect(fs.readdirSync(path.join(framework, 'Libraries')).sort()).toEqual(libs.sort());
    expect(fs.readdirSync(path.join(framework, 'Resources')).sort()).toEqual(['en.lproj', 'en_GB.lproj']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
