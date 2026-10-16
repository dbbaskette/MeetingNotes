import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
function palette(selector: string): Record<string, number[]> {
  const block = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
  return Object.fromEntries([...block.matchAll(/--([\w-]+): (\d+) (\d+) (\d+);/g)]
    .map(([, name, ...channels]) => [name, channels.map(Number)]));
}
function luminance(channels: number[]): number {
  const [r, g, b] = channels.map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: number[], b: number[]): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
describe('Golden Gate appearance tokens', () => {
  for (const theme of [':root', '.dark']) {
    const colors = palette(theme);
    for (const text of ['ink', 'ink-soft', 'ink-muted', 'brand-indigo']) {
      for (const plane of ['surface', 'surface-sunken', 'content', 'chrome', 'selection']) {
        it(`${theme}: ${text} is readable on ${plane}`, () => {
          expect(contrast(colors[text], colors[plane])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${theme}: filled accent keeps white labels readable`, () => {
      expect(contrast([255, 255, 255], colors['brand-solid'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast([255, 255, 255], [112, 66, 190])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
