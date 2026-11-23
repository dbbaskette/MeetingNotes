/** How many names and terms are offered to the speech engine. Both engines
 *  bias toward this list, and a long one dilutes the effect. */
export const VOCABULARY_LIMIT = 100;
const MAX_TERM_LENGTH = 80;

/**
 * The words the user expects to hear in this meeting, most specific first:
 * dictionary replacements (the spellings they asked for), then the people in
 * their roster. WhisperKit takes them as a glossary prompt, which measurably
 * changes its spelling of names. Apple Speech takes them as contextual strings;
 * on macOS 27.0 that had no visible effect in our tests (#306). Trimmed and
 * de-duplicated without regard to case.
 */
export function speechVocabulary(sources: { terms?: readonly string[]; speakers?: readonly string[]; userName?: string | null }): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of [...(sources.terms ?? []), sources.userName ?? '', ...(sources.speakers ?? [])]) {
    const term = raw.trim();
    // A generated label such as "Speaker 3" is not something anyone says.
    if (!term || term.length > MAX_TERM_LENGTH || /[\r\n]/.test(term) || /^(speaker[ _]?\d+|unknown|you)$/i.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(term);
    if (out.length === VOCABULARY_LIMIT) break;
  }
  return out;
}
