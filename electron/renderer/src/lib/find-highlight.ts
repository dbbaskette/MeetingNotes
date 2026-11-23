// electron/renderer/src/lib/find-highlight.ts
//
// Split text around case-insensitive occurrences of a search needle, so the
// transcript's Find can mark the matched substrings inside each line instead
// of only scrolling to the line (#298).
export interface HighlightPart { text: string; match: boolean }

export function splitHighlight(text: string, needle: string): HighlightPart[] {
  const query = needle.trim();
  if (!query || !text) return text ? [{ text, match: false }] : [];
  const haystack = text.toLowerCase(), find = query.toLowerCase();
  // Case folding can change a string's length for a few characters; when it
  // does, positions no longer line up, so leave that text unmarked.
  if (haystack.length !== text.length || find.length !== query.length) return [{ text, match: false }];
  const parts: HighlightPart[] = [];
  let from = 0;
  for (let at = haystack.indexOf(find); at !== -1; at = haystack.indexOf(find, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + find.length), match: true });
    from = at + find.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
