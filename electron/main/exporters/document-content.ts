/** Generated summaries may contain an Action Items section. Document
 * exporters use the selected database rows as the sole source of truth. */
export function notesWithoutActionItems(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let skippedLevel = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading) {
      const level = heading[1]!.length;
      if (skippedLevel && level <= skippedLevel) skippedLevel = 0;
      if (!skippedLevel && /^action items\b/i.test(heading[2]!)) {
        skippedLevel = level;
        continue;
      }
    }
    if (!skippedLevel) kept.push(line);
  }
  return kept.join('\n').trim();
}
