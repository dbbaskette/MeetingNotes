// Export the approved PNG artwork to every macOS icon resolution. No inference,
// application launch, icon-cache reset, or installed-app changes are performed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('macOS sips and iconutil are required.');
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'build/icon-1024.png');
const metadata = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', source], { encoding: 'utf8' });
if (!/pixelWidth: 1024\b/.test(metadata) || !/pixelHeight: 1024\b/.test(metadata) || !/hasAlpha: yes/.test(metadata))
  throw new Error('Icon source must be a square 1024px PNG with an alpha channel.');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-icon-export-'));
try {
  const iconset = path.join(temporary, 'MeetingNotes.iconset');
  fs.mkdirSync(iconset);
  for (const logical of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = logical * scale;
      const target = path.join(iconset, `icon_${logical}x${logical}${scale === 2 ? '@2x' : ''}.png`);
      execFileSync('sips', ['--resampleHeightWidth', String(pixels), String(pixels), source, '--out', target], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['--convert', 'icns', iconset, '--output', path.join(root, 'build/icon.icns')]);
  // Headers display this at 36px; keep a crisp small derivative instead of
  // loading the full 1024px master into the renderer.
  execFileSync('sips', ['--resampleHeightWidth', '256', '256', source, '--out',
    path.join(root, 'electron/renderer/src/assets/logo.png')], { stdio: 'ignore' });
  console.log('Exported macOS 16–1024px icon family and matching in-app logo.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
