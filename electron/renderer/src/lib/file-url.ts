/** Convert a local filesystem path into a properly encoded `file://` URL so
 *  characters like `#`, `?`, `%`, and spaces load reliably in `<audio>`. */
export function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = normalized.split('/').map(encodeURIComponent).join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}
