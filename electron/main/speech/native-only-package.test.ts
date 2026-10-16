import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8');
it('packages only capture/native speech helpers and no Python sidecar', () => {
  const config = parse(read('electron-builder.yml'));
  expect(config.mac.minimumSystemVersion).toBe('26.0.0');
  const resources = JSON.stringify(config.extraResources);
  expect(resources).toContain('meeting-notes-speech');
  expect(resources).toContain('meeting-notes-tap');
  expect(resources).not.toMatch(/sidecar|python|whisper-server|libtorch/i);
  const scripts = JSON.parse(read('package.json')).scripts;
  expect(scripts).not.toHaveProperty('sidecar:bundle');
  expect(scripts.build).toMatch(/^node scripts\/clean-build.mjs/);
  for (const file of ['scripts/setup.sh', 'scripts/start.sh', 'scripts/rebuild.sh', 'scripts/doctor.sh']) {
    expect(read(file)).not.toMatch(/whisper-cpp|whisper-server|HF_TOKEN|huggingface\/token|pip install|sidecar:bundle/);
  }
});
it('has no legacy download, HF-token or remote STT bridge', () => {
  for (const file of ['electron/preload/index.ts', 'electron/main/ipc/contracts.ts', 'electron/main/ipc/settings-handlers.ts'])
    expect(read(file)).not.toMatch(/onboardingWhisper|onboardingHfToken|sttProbe|downloadWhisperModel/);
  for (const file of ['electron/renderer/src/views/OnboardingView.tsx', 'electron/renderer/src/views/SettingsView.tsx'])
    expect(read(file)).not.toMatch(/WhisperStep|HfTokenStep|speechProvider|sttModel|sttUrl|installWhisperModel/);
});
