import { randomBytes } from 'node:crypto';

const MAX_SLUG_LEN = 80;

export function makeSlug(dateIso: string, title: string, id: string): string {
  const kebab = title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `${dateIso}-${kebab}`;
  const room = MAX_SLUG_LEN - id.length - 1;
  const trimmed = base.length > room ? base.slice(0, room).replace(/-+$/, '') : base;
  return `${trimmed}-${id}`;
}

// 8 base32-ish chars from 5 random bytes → ~40 bits, ~1.1T-space.
// Crypto-random so collisions on UNIQUE(slug) are vanishingly rare.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function shortId(): string {
  const bytes = randomBytes(5);
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buf >> bits) & 0x1f];
    }
  }
  return out;
}
