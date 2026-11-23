import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPEAKER_COLOR_COUNT, speakerFill, speakerText } from './tokens';

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
    const WHITE: RGB = [255, 255, 255];
    const PLANES = ['surface', 'surface-sunken', 'content', 'chrome', 'selection'];
    // Every filled control in the app sits under a white label (#296): the
    // primary button gradient, the speaker-ID "Continue" call to action, and
    // destructive confirms.
    for (const fill of ['brand-solid', 'brand-solid-end', 'status-warn-solid', 'danger-solid']) {
      it(`${theme}: white labels are readable on ${fill}`, () => {
        expect(contrast(WHITE, color(fill))).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${theme}: the "running long" label is readable on the active stage chip`, () => {
      expect(contrast(color('status-warn-on-solid'), color('brand-solid'))).toBeGreaterThanOrEqual(4.5);
    });
    for (let n = 1; n <= SPEAKER_COLOR_COUNT; n++) {
      it(`${theme}: speaker ${n} avatar keeps white initials readable`, () => {
        expect(contrast(WHITE, color(`speaker-${n}`))).toBeGreaterThanOrEqual(4.5);
      });
      for (const plane of PLANES) {
        it(`${theme}: speaker ${n} name is readable on ${plane}`, () => {
          expect(contrast(color(`speaker-${n}-text`), color(plane))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe('renderer source colors', () => {
  it('speaker helpers resolve to the checked CSS tokens and wrap around', () => {
    expect(speakerFill(0)).toBe('rgb(var(--speaker-1))');
    expect(speakerText(SPEAKER_COLOR_COUNT)).toBe('rgb(var(--speaker-1-text))');
    expect(speakerFill(SPEAKER_COLOR_COUNT + 2)).toBe('rgb(var(--speaker-3))');
  });

  // Tokens only help if components use them. These patterns are the ones
  // that produced unreadable controls: pastel dark-mode text tokens used as
  // a button fill under white, the light amber indicator under white, and
  // raw palette colors that ignore the appearance.
  const sources = Object.entries(import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    .filter(([file]) => !file.includes('/beta/'));
  const banned: [RegExp, string][] = [
    [/from-brand-indigo|to-brand-violet/, 'gradient built from text tokens; use btn-primary / brand-fill'],
    [/bg-status-warn\b(?![A-Za-z/-])[^'"`]*text-white|text-white[^'"`]*bg-status-warn\b(?![A-Za-z/-])/, 'white on the amber indicator; use bg-status-warnSolid'],
    [/\b(?:bg|text|border)-(?:gray|emerald|amber|red|green|blue|slate|zinc|stone|yellow|orange|sky)-\d{2,3}\b/, 'raw Tailwind palette color; use a theme token'],
    [/linear-gradient\(|#[0-9a-fA-F]{6}\b/, 'hardcoded color; use a theme token'],
    [/\b(bg-[a-z-]+-solid)\b[^'"`]*hover:\1(?![\w/-])/, 'hover state identical to the resting state'],
  ];
  it('finds component sources to check', () => { expect(sources.length).toBeGreaterThan(40); });
  for (const [pattern, why] of banned) {
    it(`no component uses ${why}`, () => {
      const offenders = sources.filter(([, text]) => pattern.test(text)).map(([file]) => file);
      expect(offenders).toEqual([]);
    });
  }
});
