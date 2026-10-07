import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RecordingManager, StartInput, RecordingLevelSource } from './manager.js';
import { probeAudio } from '../library/ffprobe.js';

/** Explicit test capture only. Shares the production recording reservation,
 * but writes outside watched folders, never persists a session/meeting, and
 * never enqueues or exports the result. Temporary audio is removed AFTER a
 * confirmed stop; if exit is uncertain, preserve it and the manager slot. */
export async function testCapture(manager: RecordingManager, input: StartInput, deps: {
  probe?: typeof probeAudio; wait?: () => Promise<void>;
} = {}): Promise<{ durationS: number | null; streams: Record<string, { peakDb: number | null; playable: boolean }>; message: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meetingnotes-capture-test-'));
  const peaks: Partial<Record<RecordingLevelSource, number>> = {};
  let sessionId: string | undefined;
  let safeToRemove = true;
  const off = manager.on('level', (id, source, value) => {
    if (id === sessionId && Number.isFinite(value)) peaks[source] = Math.max(peaks[source] ?? -120, value);
  });
  try {
    safeToRemove = false;
    let result;
    try { result = await manager.start(input, { outputDir: dir, disposable: true }); }
    catch (error) {
      safeToRemove = !manager.active().some(entry => entry.outputPath.startsWith(dir + path.sep));
      throw error;
    }
    sessionId = result.sessionId;
    try { await (deps.wait?.() ?? new Promise(resolve => setTimeout(resolve, 8000))); }
    finally { await manager.stop(sessionId); }
    safeToRemove = true;
    const streams: Record<string, { peakDb: number | null; playable: boolean }> = {};
    let durationS: number | null = null;
    for (const [label, suffix, source] of [['Mic', '.voice', 'mic'], ['App', '.system', 'system'], ['File', '', 'mixed']] as const) {
      let playable = false;
      try {
        const info = await (deps.probe ?? probeAudio)(result.outputPath.replace(/\.m4a$/, `${suffix}.m4a`));
        playable = info.durationS > 0;
        if (source === 'mixed') durationS = info.durationS;
      } catch { /* missing/empty stem is a source result, not a test crash */ }
      streams[label] = { playable, peakDb: peaks[source] ?? null };
    }
    return { durationS, streams, message: durationS ? 'Finalized audio container is playable. Check the source results below; quiet app audio is expected during a mic-only test. Test audio was discarded.' : 'No playable primary audio was produced. Check the selected source and permissions. No Library meeting was created.' };
  } finally {
    off();
    // An unsuccessful start can retain a stopping helper. Do not delete audio
    // it may still own. The temporary path never enters normal recovery.
    if (sessionId && manager.state(sessionId) === 'idle') safeToRemove = true;
    if (safeToRemove) fs.rmSync(dir, { recursive: true, force: true });
    else {
      const owned = manager.active().find(entry => entry.outputPath.startsWith(dir + path.sep));
      if (owned) {
        const unsubscribe = manager.on('state-change', (id, state) => {
          if (id !== owned.sessionId || state !== 'idle') return;
          unsubscribe();
          fs.rmSync(dir, { recursive: true, force: true });
        });
      }
    }
  }
}
