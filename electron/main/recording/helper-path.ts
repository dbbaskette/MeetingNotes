import path from 'node:path';

/**
 * Locates the bundled `meeting-notes-tap` binary. In dev (`npm run dev`)
 * we run from the repo root and the binary is at audio-tap/build/. In the
 * packaged .app, electron-builder placed it at Resources/bin/.
 */
export interface HelperPathInput {
  isPackaged: boolean;
  appPath?: string;          // process.cwd() in dev
  resourcesPath?: string;    // process.resourcesPath in packaged
}

export function resolveHelperPath(input: HelperPathInput): string {
  if (input.isPackaged) {
    if (!input.resourcesPath) throw new Error('resourcesPath required when packaged');
    return path.join(input.resourcesPath, 'bin', 'meeting-notes-tap');
  }
  if (!input.appPath) throw new Error('appPath required in dev');
  return path.join(input.appPath, 'audio-tap', 'build', 'meeting-notes-tap');
}
