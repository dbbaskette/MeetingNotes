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

export function shortId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return out;
}
