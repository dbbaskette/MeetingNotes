import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
type RGB = [number, number, number];
function palette(selector: string): Record<string, RGB> {
  const block = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
  if (!block) throw Error(`Missing palette ${selector}`);
  return Object.fromEntries([...block.matchAll(/--([\w-]+): (\d+) (\d+) (\d+);/g)]
    .map(([, name, ...channels]) => [name, channels.map(Number) as RGB]));
}
function luminance(channels: RGB): number {
  const [r, g, b] = channels.map(value => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: RGB, b: RGB): number {
  const first = luminance(a), second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
describe('Golden Gate appearance tokens', () => {
  for (const theme of [':root', '.dark']) {
    const colors = palette(theme);
    const color = (name: string): RGB => {
      const value = colors[name];
      if (!value) throw Error(`Missing color ${name} in ${theme}`);
      return value;
    };
    for (const text of ['ink', 'ink-soft', 'ink-muted', 'brand-indigo']) {
      for (const plane of ['surface', 'surface-sunken', 'content', 'chrome', 'selection']) {
        it(`${theme}: ${text} is readable on ${plane}`, () => {
          expect(contrast(color(text), color(plane))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${theme}: filled accent keeps white labels readable`, () => {
      expect(contrast([255, 255, 255], color('brand-solid'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast([255, 255, 255], [112, 66, 190])).toBeGreaterThanOrEqual(4.5);
    });
  }
});
